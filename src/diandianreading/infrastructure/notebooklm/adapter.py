"""NotebookLM implementation of the provider-neutral Knowledge Ports."""

from __future__ import annotations

import asyncio
import inspect
import os
import shutil
import stat
import tempfile
from collections.abc import Awaitable, Callable, Sequence
from contextlib import AbstractAsyncContextManager, suppress
from dataclasses import dataclass, replace
from pathlib import Path
from types import TracebackType
from typing import TypeVar
from uuid import NAMESPACE_URL, uuid5

from diandianreading.application.ports import (
    GeneratedContent,
    GenerationHandle,
    KnowledgeAnswer,
    KnowledgeGenerationPort,
    KnowledgeHealthPort,
    KnowledgeIngestionPort,
    KnowledgeMappingRepository,
    KnowledgeQueryPort,
    KnowledgeReconciliationPort,
    KnowledgeReference,
    ProgressSink,
    ReconciliationResult,
    ReconciliationStatus,
    download_input_hash,
    generation_input_hash,
    normalize_content_type,
    source_input_hash,
    workspace_input_hash,
)
from diandianreading.domain import (
    Book,
    CredentialRef,
    DiandianError,
    DocumentAsset,
    DocumentPart,
    ErrorCode,
    KnowledgeSourceRef,
    KnowledgeStatus,
    ProgressEvent,
    RemoteOperation,
    RemoteOperationKind,
    RemoteOperationRef,
    RemoteProbeStrategy,
    SourceOrigin,
    StorageKey,
    UnsafePathError,
    WorkspaceRef,
)
from diandianreading.infrastructure.notebooklm.client import NotebookLMClientFactory
from diandianreading.infrastructure.notebooklm.credentials import CredentialPathResolver
from diandianreading.infrastructure.notebooklm.errors import (
    NotebookLMOperation,
    map_notebooklm_error,
)
from diandianreading.infrastructure.notebooklm.protocols import (
    NotebookLMClientFactoryProtocol,
    NotebookLMClientProtocol,
    NotebookLMFileStore,
    SDKGenerationStatus,
    SDKSource,
)

_T = TypeVar("_T")


@dataclass(frozen=True, slots=True)
class NotebookLMAdapterConfig:
    source_wait_timeout: float = 300.0
    generation_wait_timeout: float = 600.0

    def __post_init__(self) -> None:
        if self.source_wait_timeout <= 0 or self.generation_wait_timeout <= 0:
            raise ValueError("NotebookLM adapter timeouts must be positive")


@dataclass(frozen=True, slots=True)
class NotebookLMProfileHealth:
    provider: str
    profile: str
    healthy: bool
    notebook_count: int


@dataclass(frozen=True, slots=True)
class _ContentSpec:
    title: str
    suffix: str
    mime_type: str


_CONTENT_SPECS = {
    "audio": _ContentSpec("Audio Overview", ".mp3", "audio/mpeg"),
    "video": _ContentSpec("Video Overview", ".mp4", "video/mp4"),
    "report": _ContentSpec("Briefing Report", ".md", "text/markdown"),
    "study_guide": _ContentSpec("Study Guide", ".md", "text/markdown"),
    "quiz": _ContentSpec("Quiz", ".json", "application/json"),
    "flashcards": _ContentSpec("Flashcards", ".json", "application/json"),
    "infographic": _ContentSpec("Infographic", ".png", "image/png"),
    "slide_deck": _ContentSpec("Slide Deck", ".pdf", "application/pdf"),
    "data_table": _ContentSpec("Data Table", ".csv", "text/csv"),
}


class NotebookLMAdapter(
    KnowledgeIngestionPort,
    KnowledgeQueryPort,
    KnowledgeGenerationPort,
    KnowledgeReconciliationPort,
    KnowledgeHealthPort,
):
    """Translate product models into the SDK's explicit notebook-scoped calls."""

    provider = "notebooklm"
    probe_strategy = RemoteProbeStrategy.UNSUPPORTED

    def __init__(
        self,
        *,
        credential_resolver: CredentialPathResolver,
        file_store: NotebookLMFileStore,
        mappings: KnowledgeMappingRepository,
        staging_root: Path,
        client_factory: NotebookLMClientFactoryProtocol | None = None,
        config: NotebookLMAdapterConfig | None = None,
    ) -> None:
        self._credential_resolver = credential_resolver
        self._file_store = file_store
        self._mappings = mappings
        self._staging_root = Path(os.path.abspath(staging_root.expanduser()))
        self._prepare_staging_root()
        self._client_factory = client_factory or NotebookLMClientFactory()
        self._config = config or NotebookLMAdapterConfig()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._client_lock: asyncio.Lock | None = None
        self._clients: dict[str, NotebookLMClientProtocol] = {}
        self._client_contexts: dict[str, AbstractAsyncContextManager[NotebookLMClientProtocol]] = {}
        self._workspace_credentials: dict[str, CredentialRef] = {}
        self._workspace_operations: dict[str, WorkspaceRef] = {}
        self._source_operations: dict[str, KnowledgeSourceRef] = {}
        self._operation_bindings: dict[str, tuple[RemoteOperationKind, str, str]] = {}
        self._source_parts: dict[str, dict[str, str]] = {}
        self._generation_operations: dict[str, GenerationHandle] = {}
        self._download_operations: dict[str, DocumentAsset] = {}

    async def __aenter__(self) -> NotebookLMAdapter:
        self._bind_loop()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        del exc_type, traceback
        try:
            await self.aclose()
        except BaseException:
            if exc_value is None:
                raise

    async def aclose(self) -> None:
        """Close all clients owned by this adapter's event loop."""

        if self._loop is None:
            return
        self._bind_loop()
        failure: DiandianError | None = None
        for profile, context in reversed(tuple(self._client_contexts.items())):
            try:
                await context.__aexit__(None, None, None)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                failure = map_notebooklm_error(error, NotebookLMOperation.CLOSE)
            finally:
                self._clients.pop(profile, None)
                self._client_contexts.pop(profile, None)
        if failure is not None:
            raise failure

    async def health_check(self, credential: CredentialRef) -> NotebookLMProfileHealth:
        client = await self._client_for(credential, NotebookLMOperation.HEALTH)
        notebooks = await self._sdk_call(
            NotebookLMOperation.HEALTH,
            client.notebooks.list,
        )
        return NotebookLMProfileHealth(
            provider=self.provider,
            profile=credential.profile,
            healthy=True,
            notebook_count=len(notebooks),
        )

    async def credential_is_healthy(self, credential: CredentialRef) -> bool:
        health = await self.health_check(credential)
        return health.healthy

    async def reconcile_workspace(
        self,
        book: Book,
        credential: CredentialRef,
        operation: RemoteOperation,
    ) -> ReconciliationResult:
        del book, credential
        if operation.external_id:
            return ReconciliationResult(
                ReconciliationStatus.RECOVERED,
                operation.external_id,
            )
        return ReconciliationResult(ReconciliationStatus.AMBIGUOUS)

    async def reconcile_source(
        self,
        workspace: WorkspaceRef,
        part: DocumentPart,
        operation: RemoteOperation,
    ) -> ReconciliationResult:
        del workspace, part
        if operation.external_id:
            return ReconciliationResult(
                ReconciliationStatus.RECOVERED,
                operation.external_id,
            )
        return ReconciliationResult(ReconciliationStatus.AMBIGUOUS)

    async def ensure_workspace(
        self,
        book: Book,
        credential: CredentialRef,
        operation: RemoteOperationRef,
        progress: ProgressSink,
    ) -> WorkspaceRef:
        self._validate_provider_credential(credential)
        self._validate_operation(
            operation,
            expected_kind=RemoteOperationKind.ENSURE_WORKSPACE,
            local_resource_id=book.id,
            input_hash=workspace_input_hash(book, credential),
        )
        self._validate_operation_binding(operation)
        cached = self._workspace_operations.get(operation.idempotency_key)
        if cached is not None:
            self._validate_cached_external_id(operation, cached.external_id)
            return cached

        client = await self._client_for(credential, NotebookLMOperation.CREATE_WORKSPACE)
        if operation.external_id is not None:
            external_id = operation.external_id
            notebook = await self._sdk_call(
                NotebookLMOperation.CREATE_WORKSPACE,
                lambda: client.notebooks.get_or_none(external_id),
            )
            if notebook is None:
                raise DiandianError(
                    ErrorCode.REMOTE_UNAVAILABLE,
                    "The previously created NotebookLM workspace is no longer available",
                    retryable=False,
                )
        else:
            notebook = await self._sdk_call(
                NotebookLMOperation.CREATE_WORKSPACE,
                lambda: client.notebooks.create(book.title.strip()),
            )
        if not notebook.id:
            raise _protocol_drift("NotebookLM returned a workspace without an identifier")

        workspace = WorkspaceRef(
            id=_local_id("workspace", operation.idempotency_key),
            provider=self.provider,
            external_id=notebook.id,
            status=KnowledgeStatus.READY,
        )
        self._workspace_credentials[workspace.id] = credential
        self._workspace_operations[operation.idempotency_key] = workspace
        await self._emit_progress(
            progress,
            step="creating_workspace",
            current=1,
            total=1,
            message="NotebookLM workspace is ready",
        )
        return workspace

    async def add_part(
        self,
        workspace: WorkspaceRef,
        part: DocumentPart,
        operation: RemoteOperationRef,
        progress: ProgressSink,
    ) -> KnowledgeSourceRef:
        self._validate_workspace(workspace)
        self._validate_operation(
            operation,
            expected_kind=RemoteOperationKind.ADD_SOURCE,
            local_resource_id=part.id,
            input_hash=source_input_hash(workspace, part),
        )
        self._validate_operation_binding(operation)
        cached = self._source_operations.get(operation.idempotency_key)
        if cached is not None:
            self._validate_cached_external_id(operation, cached.external_id)
            self._validate_source_binding(cached, workspace, part)
            return cached

        stored = self._file_store.stat(part.storage_key)
        if stored.sha256 != part.sha256 or stored.size_bytes != part.size_bytes:
            raise DiandianError(
                ErrorCode.VALIDATION,
                "Document part does not match its verified local object",
                retryable=False,
            )
        source_path = self._file_store.resolve_for_read(part.storage_key)
        credential = self._credential_for_workspace(workspace)
        client = await self._client_for(credential, NotebookLMOperation.UPLOAD_SOURCE)

        if operation.external_id is not None:
            external_id = operation.external_id
            sdk_source = await self._sdk_call(
                NotebookLMOperation.UPLOAD_SOURCE,
                lambda: client.sources.get_or_none(workspace.external_id, external_id),
            )
            if sdk_source is None:
                raise DiandianError(
                    ErrorCode.SOURCE_PROCESSING_FAILED,
                    "The previously uploaded NotebookLM source is no longer available",
                    retryable=False,
                )
        else:

            async def on_progress(sent: int, total: int) -> None:
                await self._emit_progress(
                    progress,
                    step="uploading",
                    current=sent,
                    total=total,
                    message=f"Uploading document part {part.sequence + 1}",
                )

            sdk_source = await self._sdk_call(
                NotebookLMOperation.UPLOAD_SOURCE,
                lambda: client.sources.add_file(
                    workspace.external_id,
                    source_path,
                    part.mime_type,
                    wait=False,
                    title=_part_title(part),
                    on_progress=on_progress,
                ),
            )
        if not sdk_source.id:
            raise _protocol_drift("NotebookLM returned a source without an identifier")

        source = KnowledgeSourceRef(
            id=_local_id("source", operation.idempotency_key),
            workspace_id=workspace.id,
            document_part_id=part.id,
            external_id=sdk_source.id,
            checksum=part.sha256,
            status=_source_status(sdk_source),
        )
        if source.status is KnowledgeStatus.FAILED:
            raise DiandianError(
                ErrorCode.SOURCE_PROCESSING_FAILED,
                "NotebookLM rejected the uploaded source during processing",
                retryable=True,
            )
        self._source_parts.setdefault(workspace.id, {})[source.external_id] = part.id
        self._source_operations[operation.idempotency_key] = source
        return source

    async def wait_sources(
        self,
        workspace: WorkspaceRef,
        sources: Sequence[KnowledgeSourceRef],
        progress: ProgressSink,
    ) -> tuple[KnowledgeSourceRef, ...]:
        self._validate_workspace(workspace)
        if len({source.id for source in sources}) != len(sources):
            raise ValueError("Duplicate NotebookLM source references are not allowed")
        for source in sources:
            if source.workspace_id != workspace.id:
                raise ValueError("NotebookLM source belongs to another workspace")
        if not sources:
            await self._emit_progress(
                progress,
                step="processing",
                current=0,
                total=0,
                message="No NotebookLM sources require processing",
            )
            return ()

        credential = self._credential_for_workspace(workspace)
        client = await self._client_for(credential, NotebookLMOperation.WAIT_SOURCE)
        ready_sdk_sources = await self._sdk_call(
            NotebookLMOperation.WAIT_SOURCE,
            lambda: client.sources.wait_for_sources(
                workspace.external_id,
                [source.external_id for source in sources],
                timeout=self._config.source_wait_timeout,
            ),
        )
        ready_by_id = {source.id: source for source in ready_sdk_sources}
        if len(ready_by_id) != len(sources) or set(ready_by_id) != {
            source.external_id for source in sources
        }:
            raise DiandianError(
                ErrorCode.SOURCE_PROCESSING_FAILED,
                "NotebookLM returned a different source set while waiting",
                retryable=True,
            )

        ready: list[KnowledgeSourceRef] = []
        for source in sources:
            sdk_source = ready_by_id[source.external_id]
            if not sdk_source.is_ready:
                raise DiandianError(
                    ErrorCode.SOURCE_PROCESSING_FAILED,
                    "NotebookLM source processing did not reach ready state",
                    retryable=True,
                )
            current = replace(source, status=KnowledgeStatus.READY)
            ready.append(current)
            self._source_parts.setdefault(workspace.id, {})[current.external_id] = (
                current.document_part_id
            )
        await self._emit_progress(
            progress,
            step="processing",
            current=len(ready),
            total=len(ready),
            message="NotebookLM sources are ready",
        )
        return tuple(ready)

    async def ask(
        self,
        workspace: WorkspaceRef,
        question: str,
        external_source_ids: Sequence[str] | None,
        provider_conversation_id: str | None,
    ) -> KnowledgeAnswer:
        self._validate_workspace(workspace)
        normalized_question = question.strip()
        if not normalized_question:
            raise ValueError("Knowledge question cannot be empty")
        if external_source_ids is not None and len(set(external_source_ids)) != len(
            external_source_ids
        ):
            raise ValueError("Duplicate NotebookLM source identifiers are not allowed")

        source_parts = self._persisted_source_parts(workspace.id)
        if external_source_ids is not None and any(
            source_id not in source_parts for source_id in external_source_ids
        ):
            raise ValueError("NotebookLM source does not belong to the requested workspace")

        credential = self._credential_for_workspace(workspace)
        client = await self._client_for(credential, NotebookLMOperation.QUERY)
        result = await self._sdk_call(
            NotebookLMOperation.QUERY,
            lambda: client.chat.ask(
                workspace.external_id,
                normalized_question,
                source_ids=list(external_source_ids) if external_source_ids is not None else None,
                conversation_id=provider_conversation_id,
            ),
        )
        references = tuple(
            KnowledgeReference(
                external_source_id=reference.source_id,
                document_part_id=source_parts.get(reference.source_id),
                excerpt=reference.cited_text,
            )
            for reference in result.references
        )
        return KnowledgeAnswer(
            answer=result.answer,
            conversation_id=result.conversation_id or None,
            references=references,
        )

    async def generate(
        self,
        workspace: WorkspaceRef,
        content_type: str,
        instructions: str | None,
        operation: RemoteOperationRef,
    ) -> GenerationHandle:
        self._validate_workspace(workspace)
        normalized_type = _require_content_type(content_type)
        self._validate_operation(
            operation,
            expected_kind=RemoteOperationKind.GENERATE_CONTENT,
            local_resource_id=workspace.id,
            input_hash=generation_input_hash(normalized_type, instructions),
        )
        self._validate_operation_binding(operation)
        cached = self._generation_operations.get(operation.idempotency_key)
        if cached is not None:
            self._validate_cached_external_id(operation, cached.id)
            return cached
        if operation.external_id is not None:
            handle = GenerationHandle(operation.external_id, workspace.id, normalized_type)
            self._generation_operations[operation.idempotency_key] = handle
            return handle

        credential = self._credential_for_workspace(workspace)
        client = await self._client_for(credential, NotebookLMOperation.GENERATE)
        status = await self._start_generation(
            client,
            workspace.external_id,
            normalized_type,
            instructions.strip() if instructions else None,
        )
        self._validate_generation_status(status)
        handle = GenerationHandle(status.task_id, workspace.id, normalized_type)
        self._generation_operations[operation.idempotency_key] = handle
        return handle

    async def wait(self, handle: GenerationHandle) -> GeneratedContent:
        normalized_type = _require_content_type(handle.content_type)
        workspace = self._workspace_from_local_id(handle.workspace_id)
        credential = self._credential_for_workspace(workspace)
        client = await self._client_for(credential, NotebookLMOperation.WAIT_GENERATION)
        status = await self._sdk_call(
            NotebookLMOperation.WAIT_GENERATION,
            lambda: client.artifacts.wait_for_completion(
                workspace.external_id,
                handle.id,
                timeout=self._config.generation_wait_timeout,
            ),
        )
        self._validate_generation_status(status, require_complete=True)
        spec = _CONTENT_SPECS[normalized_type]
        return GeneratedContent(
            id=handle.id,
            workspace_id=handle.workspace_id,
            content_type=normalized_type,
            title=spec.title,
            text=None,
            remote_url=status.url,
        )

    async def download(
        self,
        content: GeneratedContent,
        destination: StorageKey,
        operation: RemoteOperationRef,
    ) -> DocumentAsset:
        normalized_type = _require_content_type(content.content_type)
        self._validate_operation(
            operation,
            expected_kind=RemoteOperationKind.DOWNLOAD_CONTENT,
            local_resource_id=content.id,
            input_hash=download_input_hash(content, destination),
        )
        self._validate_operation_binding(operation)
        if operation.external_id is not None and operation.external_id != content.id:
            raise ValueError("Download operation external identifier does not match content")
        cached = self._download_operations.get(operation.idempotency_key)
        if cached is not None:
            self._validate_cached_external_id(operation, content.id)
            return cached

        if operation.external_id == content.id:
            with suppress(FileNotFoundError):
                asset = self._asset_from_stored_content(content, destination)
                self._download_operations[operation.idempotency_key] = asset
                return asset

        workspace = self._workspace_from_local_id(content.workspace_id)
        credential = self._credential_for_workspace(workspace)
        client = await self._client_for(credential, NotebookLMOperation.DOWNLOAD)
        spec = _CONTENT_SPECS[normalized_type]
        temporary_directory = Path(tempfile.mkdtemp(prefix="artifact-", dir=self._staging_root))
        output_path = temporary_directory / f"content{spec.suffix}"
        try:
            returned_path = await self._download_artifact(
                client,
                workspace.external_id,
                content,
                output_path,
            )
            if Path(os.path.abspath(returned_path)) != output_path:
                raise UnsafePathError("NotebookLM download escaped its private staging path")
            self._validate_download(output_path)
            flags = os.O_RDONLY
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            descriptor = os.open(output_path, flags)
            try:
                with os.fdopen(descriptor, "rb") as downloaded:
                    self._file_store.put(destination, downloaded)
            except BaseException:
                with suppress(OSError):
                    os.close(descriptor)
                raise
        finally:
            self._cleanup_staging_directory(temporary_directory)

        asset = self._asset_from_stored_content(content, destination)
        self._download_operations[operation.idempotency_key] = asset
        return asset

    async def _start_generation(
        self,
        client: NotebookLMClientProtocol,
        notebook_id: str,
        content_type: str,
        instructions: str | None,
    ) -> SDKGenerationStatus:
        artifacts = client.artifacts
        if content_type == "audio":
            return await self._sdk_call(
                NotebookLMOperation.GENERATE,
                lambda: artifacts.generate_audio(notebook_id, instructions=instructions),
            )
        if content_type == "video":
            return await self._sdk_call(
                NotebookLMOperation.GENERATE,
                lambda: artifacts.generate_video(notebook_id, instructions=instructions),
            )
        if content_type == "report":
            return await self._sdk_call(
                NotebookLMOperation.GENERATE,
                lambda: artifacts.generate_report(notebook_id, extra_instructions=instructions),
            )
        if content_type == "study_guide":
            return await self._sdk_call(
                NotebookLMOperation.GENERATE,
                lambda: artifacts.generate_study_guide(
                    notebook_id, extra_instructions=instructions
                ),
            )
        if content_type == "quiz":
            return await self._sdk_call(
                NotebookLMOperation.GENERATE,
                lambda: artifacts.generate_quiz(notebook_id, instructions=instructions),
            )
        if content_type == "flashcards":
            return await self._sdk_call(
                NotebookLMOperation.GENERATE,
                lambda: artifacts.generate_flashcards(notebook_id, instructions=instructions),
            )
        if content_type == "infographic":
            return await self._sdk_call(
                NotebookLMOperation.GENERATE,
                lambda: artifacts.generate_infographic(notebook_id, instructions=instructions),
            )
        if content_type == "slide_deck":
            return await self._sdk_call(
                NotebookLMOperation.GENERATE,
                lambda: artifacts.generate_slide_deck(notebook_id, instructions=instructions),
            )
        return await self._sdk_call(
            NotebookLMOperation.GENERATE,
            lambda: artifacts.generate_data_table(notebook_id, instructions=instructions),
        )

    async def _download_artifact(
        self,
        client: NotebookLMClientProtocol,
        notebook_id: str,
        content: GeneratedContent,
        output_path: Path,
    ) -> str:
        artifacts = client.artifacts
        output = str(output_path)
        content_type = normalize_content_type(content.content_type)
        if content_type == "audio":
            return await self._sdk_call(
                NotebookLMOperation.DOWNLOAD,
                lambda: artifacts.download_audio(notebook_id, output, content.id),
            )
        if content_type == "video":
            return await self._sdk_call(
                NotebookLMOperation.DOWNLOAD,
                lambda: artifacts.download_video(notebook_id, output, content.id),
            )
        if content_type in {"report", "study_guide"}:
            return await self._sdk_call(
                NotebookLMOperation.DOWNLOAD,
                lambda: artifacts.download_report(notebook_id, output, content.id),
            )
        if content_type == "quiz":
            return await self._sdk_call(
                NotebookLMOperation.DOWNLOAD,
                lambda: artifacts.download_quiz(
                    notebook_id, output, content.id, output_format="json"
                ),
            )
        if content_type == "flashcards":
            return await self._sdk_call(
                NotebookLMOperation.DOWNLOAD,
                lambda: artifacts.download_flashcards(
                    notebook_id, output, content.id, output_format="json"
                ),
            )
        if content_type == "infographic":
            return await self._sdk_call(
                NotebookLMOperation.DOWNLOAD,
                lambda: artifacts.download_infographic(notebook_id, output, content.id),
            )
        if content_type == "slide_deck":
            return await self._sdk_call(
                NotebookLMOperation.DOWNLOAD,
                lambda: artifacts.download_slide_deck(
                    notebook_id, output, content.id, output_format="pdf"
                ),
            )
        return await self._sdk_call(
            NotebookLMOperation.DOWNLOAD,
            lambda: artifacts.download_data_table(notebook_id, output, content.id),
        )

    async def _client_for(
        self,
        credential: CredentialRef,
        operation: NotebookLMOperation,
    ) -> NotebookLMClientProtocol:
        self._bind_loop()
        self._validate_provider_credential(credential)
        storage_path = self._credential_resolver.resolve_storage_state(credential)
        existing = self._clients.get(credential.profile)
        if existing is not None:
            return existing
        assert self._client_lock is not None
        async with self._client_lock:
            existing = self._clients.get(credential.profile)
            if existing is not None:
                return existing
            context = self._client_factory.open(storage_path)
            try:
                client = await context.__aenter__()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                raise map_notebooklm_error(error, operation) from error
            self._client_contexts[credential.profile] = context
            self._clients[credential.profile] = client
            return client

    def _bind_loop(self) -> None:
        loop = asyncio.get_running_loop()
        if self._loop is None:
            self._loop = loop
            self._client_lock = asyncio.Lock()
        elif self._loop is not loop:
            raise DiandianError(
                ErrorCode.VALIDATION,
                "NotebookLM adapter cannot be shared across event loops",
                retryable=False,
            )

    def _credential_for_workspace(self, workspace: WorkspaceRef) -> CredentialRef:
        cached = self._workspace_credentials.get(workspace.id)
        if cached is not None:
            return cached
        persisted = self._mappings.get_workspace(workspace.id)
        if (
            persisted is None
            or persisted.provider != self.provider
            or persisted.external_id != workspace.external_id
        ):
            raise DiandianError(
                ErrorCode.VALIDATION,
                "NotebookLM workspace credential mapping is unavailable",
                retryable=False,
            )
        credential = CredentialRef(self.provider, persisted.credential_profile)
        self._workspace_credentials[workspace.id] = credential
        return credential

    def _workspace_from_local_id(self, workspace_id: str) -> WorkspaceRef:
        for workspace in self._workspace_operations.values():
            if workspace.id == workspace_id:
                return workspace
        persisted = self._mappings.get_workspace(workspace_id)
        if persisted is None or persisted.provider != self.provider:
            raise DiandianError(
                ErrorCode.VALIDATION,
                "NotebookLM workspace mapping is unavailable",
                retryable=False,
            )
        return WorkspaceRef(
            id=persisted.id,
            provider=persisted.provider,
            external_id=persisted.external_id,
            status=persisted.status,
        )

    def _persisted_source_parts(self, workspace_id: str) -> dict[str, str]:
        mapping = dict(self._source_parts.get(workspace_id, {}))
        for source in self._mappings.list_sources(workspace_id):
            mapping[source.external_id] = source.document_part_id
        return mapping

    def _asset_from_stored_content(
        self,
        content: GeneratedContent,
        destination: StorageKey,
    ) -> DocumentAsset:
        stored = self._file_store.stat(destination)
        normalized_type = normalize_content_type(content.content_type)
        spec = _CONTENT_SPECS[normalized_type]
        local_id = _local_id("generated-asset", f"{content.id}:{destination.value}")
        rights_id = _local_id("generated-rights", content.id)
        return DocumentAsset(
            id=local_id,
            storage_key=destination,
            display_filename=f"{normalized_type}-{local_id[:8]}{spec.suffix}",
            mime_type=spec.mime_type,
            size_bytes=stored.size_bytes,
            sha256=stored.sha256,
            title=content.title,
            author=None,
            origin=SourceOrigin.LOCAL,
            origin_locator=None,
            rights_provenance_id=rights_id,
        )

    @staticmethod
    async def _sdk_call(
        operation: NotebookLMOperation,
        call: Callable[[], Awaitable[_T]],
    ) -> _T:
        try:
            return await call()
        except asyncio.CancelledError:
            raise
        except Exception as error:
            raise map_notebooklm_error(error, operation) from error

    @staticmethod
    async def _emit_progress(
        progress: ProgressSink,
        *,
        step: str,
        current: int | None,
        total: int | None,
        message: str,
    ) -> None:
        try:
            result = progress.emit(
                ProgressEvent(
                    job_id=progress.job_id,
                    step=step,
                    current=current,
                    total=total,
                    message=message,
                )
            )
            if inspect.isawaitable(result):
                await result
        except Exception:
            return

    @staticmethod
    def _validate_operation(
        operation: RemoteOperationRef,
        *,
        expected_kind: RemoteOperationKind,
        local_resource_id: str,
        input_hash: str,
    ) -> None:
        if operation.kind is not expected_kind:
            raise ValueError(f"Operation must have kind {expected_kind.value}")
        if operation.local_resource_id != local_resource_id or operation.input_hash != input_hash:
            raise ValueError("Remote operation does not match its local inputs")
        if not operation.id or not operation.idempotency_key:
            raise ValueError("Remote operation identity is required")

    def _validate_operation_binding(self, operation: RemoteOperationRef) -> None:
        binding = (operation.kind, operation.local_resource_id, operation.input_hash)
        existing = self._operation_bindings.setdefault(operation.idempotency_key, binding)
        if existing != binding:
            raise ValueError("Idempotency key is already bound to different remote inputs")

    @staticmethod
    def _validate_cached_external_id(
        operation: RemoteOperationRef,
        external_id: str,
    ) -> None:
        if operation.external_id is not None and operation.external_id != external_id:
            raise ValueError("Remote operation is bound to a different external identifier")

    @classmethod
    def _validate_workspace(cls, workspace: WorkspaceRef) -> None:
        if workspace.provider != cls.provider or not workspace.external_id:
            raise ValueError("Workspace is not a valid NotebookLM workspace")

    @classmethod
    def _validate_provider_credential(cls, credential: CredentialRef) -> None:
        if credential.provider != cls.provider:
            raise ValueError(f"NotebookLM adapter cannot use provider {credential.provider}")

    @staticmethod
    def _validate_source_binding(
        source: KnowledgeSourceRef,
        workspace: WorkspaceRef,
        part: DocumentPart,
    ) -> None:
        if (
            source.workspace_id != workspace.id
            or source.document_part_id != part.id
            or source.checksum != part.sha256
        ):
            raise ValueError("Idempotency key is already bound to another source")

    @staticmethod
    def _validate_generation_status(
        status: SDKGenerationStatus,
        *,
        require_complete: bool = False,
    ) -> None:
        if status.is_rate_limited:
            raise DiandianError(
                ErrorCode.REMOTE_RATE_LIMITED,
                "NotebookLM rate limit or account quota was reached",
                retryable=True,
            )
        if status.is_failed or status.is_removed:
            raise DiandianError(
                ErrorCode.CONVERSION_FAILED,
                "NotebookLM content generation failed",
                retryable=False,
            )
        if not status.task_id:
            raise _protocol_drift("NotebookLM generation returned no task identifier")
        if require_complete and not status.is_complete:
            raise _protocol_drift("NotebookLM generation wait returned a non-terminal state")

    def _prepare_staging_root(self) -> None:
        current = Path(self._staging_root.anchor)
        for segment in self._staging_root.parts[1:]:
            current /= segment
            if current.is_symlink():
                raise UnsafePathError("NotebookLM staging path cannot contain symlinks")
        if not self._staging_root.exists():
            self._staging_root.mkdir(parents=True, mode=0o700)
            if os.name != "nt":
                self._staging_root.chmod(0o700)
        metadata = self._staging_root.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise UnsafePathError("NotebookLM staging root must be a private directory")
        if os.name != "nt":
            if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
                raise UnsafePathError("NotebookLM staging root is not owned by the current user")
            if stat.S_IMODE(metadata.st_mode) & 0o077:
                raise UnsafePathError("NotebookLM staging root permissions must be private (0700)")

    def _cleanup_staging_directory(self, directory: Path) -> None:
        if directory.parent != self._staging_root:
            raise UnsafePathError("NotebookLM staging cleanup escaped its private root")
        try:
            shutil.rmtree(directory)
        except OSError as error:
            raise DiandianError(
                ErrorCode.UNEXPECTED,
                "NotebookLM generated content staging cleanup failed",
                retryable=False,
            ) from error

    @staticmethod
    def _validate_download(path: Path) -> None:
        try:
            metadata = path.lstat()
        except FileNotFoundError as error:
            raise DiandianError(
                ErrorCode.CONVERSION_FAILED,
                "NotebookLM did not produce the requested generated content",
                retryable=False,
            ) from error
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise UnsafePathError("NotebookLM download must be a regular non-symlink file")
        if metadata.st_size <= 0:
            raise DiandianError(
                ErrorCode.CONVERSION_FAILED,
                "NotebookLM produced an empty generated content file",
                retryable=False,
            )
        if os.name != "nt":
            if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
                raise UnsafePathError("NotebookLM download is not owned by the current user")
            path.chmod(0o600)


def _require_content_type(content_type: str) -> str:
    normalized = normalize_content_type(content_type)
    if normalized not in _CONTENT_SPECS:
        raise DiandianError(
            ErrorCode.FORMAT_UNSUPPORTED,
            f"Unsupported generated content type: {normalized}",
            retryable=False,
        )
    return normalized


def _source_status(source: SDKSource) -> KnowledgeStatus:
    if source.is_ready:
        return KnowledgeStatus.READY
    if source.is_error:
        return KnowledgeStatus.FAILED
    return KnowledgeStatus.PROCESSING


def _part_title(part: DocumentPart) -> str:
    chapter = part.chapter_refs[0].strip() if part.chapter_refs else ""
    return chapter or f"Document part {part.sequence + 1}"


def _local_id(kind: str, identity: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"diandianreading:notebooklm:{kind}:{identity}"))


def _protocol_drift(message: str) -> DiandianError:
    return DiandianError(ErrorCode.REMOTE_PROTOCOL_DRIFT, message, retryable=False)
