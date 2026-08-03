"""Deterministic in-memory knowledge ingestion adapter for tests and local demos."""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import replace
from uuid import NAMESPACE_URL, uuid5

from diandianreading.application.ports import (
    GeneratedContent,
    GenerationHandle,
    KnowledgeAnswer,
    KnowledgeGenerationPort,
    KnowledgeIngestionPort,
    KnowledgeQueryPort,
    KnowledgeReference,
    ProgressSink,
    download_input_hash,
    generation_input_hash,
    normalize_content_type,
)
from diandianreading.domain import (
    Book,
    CredentialRef,
    DocumentAsset,
    DocumentPart,
    KnowledgeSourceRef,
    KnowledgeStatus,
    ProgressEvent,
    RemoteOperationKind,
    RemoteOperationRef,
    SourceOrigin,
    StorageKey,
    WorkspaceRef,
)


class FakeKnowledgeAdapter(KnowledgeIngestionPort, KnowledgeQueryPort, KnowledgeGenerationPort):
    """A deterministic, idempotent adapter with create/upload/wait semantics."""

    provider = "fake"

    def __init__(self) -> None:
        self.workspaces: dict[str, WorkspaceRef] = {}
        self.sources: dict[str, KnowledgeSourceRef] = {}
        self._workspace_operations: dict[str, WorkspaceRef] = {}
        self._source_operations: dict[str, KnowledgeSourceRef] = {}
        self._operation_bindings: dict[str, tuple[RemoteOperationKind, str, str]] = {}
        self._generation_operations: dict[str, GenerationHandle] = {}
        self._download_operations: dict[str, DocumentAsset] = {}

    async def ensure_workspace(
        self,
        book: Book,
        credential: CredentialRef,
        operation: RemoteOperationRef,
        progress: ProgressSink,
    ) -> WorkspaceRef:
        if credential.provider != self.provider:
            raise ValueError(f"Fake adapter cannot use provider {credential.provider}")
        if operation.kind is not RemoteOperationKind.ENSURE_WORKSPACE:
            raise ValueError("Workspace creation requires an ensure_workspace operation")
        if operation.local_resource_id != book.id or operation.input_hash != book.source_hash:
            raise ValueError("Workspace operation does not match the Book")
        self._validate_operation_binding(operation)

        existing = self._workspace_operations.get(operation.idempotency_key)
        if existing is not None:
            return existing

        local_id = str(uuid5(NAMESPACE_URL, f"fake-workspace:{operation.idempotency_key}"))
        workspace = WorkspaceRef(
            id=local_id,
            provider=self.provider,
            external_id=f"fake-notebook-{local_id}",
            status=KnowledgeStatus.READY,
        )
        self.workspaces[workspace.id] = workspace
        self._workspace_operations[operation.idempotency_key] = workspace
        await progress.emit(
            ProgressEvent(
                job_id=progress.job_id,
                step="creating_workspace",
                current=1,
                total=1,
                message="Created fake knowledge workspace",
            )
        )
        return workspace

    async def add_part(
        self,
        workspace: WorkspaceRef,
        part: DocumentPart,
        operation: RemoteOperationRef,
        progress: ProgressSink,
    ) -> KnowledgeSourceRef:
        if workspace.id not in self.workspaces:
            raise ValueError(f"Unknown fake workspace: {workspace.id}")
        if operation.kind is not RemoteOperationKind.ADD_SOURCE:
            raise ValueError("Source upload requires an add_source operation")
        if operation.local_resource_id != part.id or operation.input_hash != part.sha256:
            raise ValueError("Source operation does not match the DocumentPart")
        self._validate_operation_binding(operation)

        existing = self._source_operations.get(operation.idempotency_key)
        if existing is not None:
            if (
                existing.workspace_id != workspace.id
                or existing.document_part_id != part.id
                or existing.checksum != part.sha256
            ):
                raise ValueError("Idempotency key is already bound to another source")
            return existing

        source_id = str(uuid5(NAMESPACE_URL, f"fake-source:{operation.idempotency_key}"))
        source = KnowledgeSourceRef(
            id=source_id,
            workspace_id=workspace.id,
            document_part_id=part.id,
            external_id=f"fake-source-{source_id}",
            checksum=part.sha256,
            status=KnowledgeStatus.PROCESSING,
        )
        self.sources[source.id] = source
        self._source_operations[operation.idempotency_key] = source
        await progress.emit(
            ProgressEvent(
                job_id=progress.job_id,
                step="uploading",
                current=None,
                total=None,
                message=f"Uploaded fake source {part.sequence + 1}",
            )
        )
        return source

    async def wait_sources(
        self,
        workspace: WorkspaceRef,
        sources: Sequence[KnowledgeSourceRef],
        progress: ProgressSink,
    ) -> Sequence[KnowledgeSourceRef]:
        if workspace.id not in self.workspaces:
            raise ValueError(f"Unknown fake workspace: {workspace.id}")
        if len({source.id for source in sources}) != len(sources):
            raise ValueError("Duplicate fake source references are not allowed")

        ready_sources: list[KnowledgeSourceRef] = []
        for source in sources:
            persisted = self.sources.get(source.id)
            if persisted is None:
                raise ValueError(f"Unknown fake source: {source.id}")
            if persisted != source or source.workspace_id != workspace.id:
                raise ValueError("Fake source does not match its persisted workspace mapping")
            ready = replace(source, status=KnowledgeStatus.READY)
            self.sources[source.id] = ready
            ready_sources.append(ready)
        await progress.emit(
            ProgressEvent(
                job_id=progress.job_id,
                step="processing",
                current=len(ready_sources),
                total=len(ready_sources),
                message="Fake sources are ready",
            )
        )
        return tuple(ready_sources)

    async def ask(
        self,
        workspace: WorkspaceRef,
        question: str,
        external_source_ids: Sequence[str] | None,
        provider_conversation_id: str | None,
    ) -> KnowledgeAnswer:
        if workspace.id not in self.workspaces:
            raise ValueError(f"Unknown fake workspace: {workspace.id}")
        normalized_question = question.strip()
        if not normalized_question:
            raise ValueError("Knowledge question cannot be empty")
        selected_ids = (
            tuple(external_source_ids)
            if external_source_ids is not None
            else tuple(
                source.external_id
                for source in self.sources.values()
                if source.workspace_id == workspace.id
            )
        )
        if len(set(selected_ids)) != len(selected_ids):
            raise ValueError("Duplicate fake source identifiers are not allowed")
        sources_by_external_id = {
            source.external_id: source
            for source in self.sources.values()
            if source.workspace_id == workspace.id
        }
        if any(source_id not in sources_by_external_id for source_id in selected_ids):
            raise ValueError("Unknown fake source identifier")
        conversation_id = provider_conversation_id or str(
            uuid5(NAMESPACE_URL, f"fake-conversation:{workspace.id}")
        )
        return KnowledgeAnswer(
            answer=f"Fake grounded answer: {normalized_question}",
            conversation_id=conversation_id,
            references=tuple(
                KnowledgeReference(
                    external_source_id=source_id,
                    document_part_id=sources_by_external_id[source_id].document_part_id,
                    excerpt="Fake cited passage",
                )
                for source_id in selected_ids
            ),
        )

    async def generate(
        self,
        workspace: WorkspaceRef,
        content_type: str,
        instructions: str | None,
        operation: RemoteOperationRef,
    ) -> GenerationHandle:
        if workspace.id not in self.workspaces:
            raise ValueError(f"Unknown fake workspace: {workspace.id}")
        normalized_type = normalize_content_type(content_type)
        if normalized_type not in _GENERATED_FORMATS:
            raise ValueError(f"Unsupported fake content type: {normalized_type}")
        if operation.kind is not RemoteOperationKind.GENERATE_CONTENT:
            raise ValueError("Content generation requires a generate_content operation")
        if (
            operation.local_resource_id != workspace.id
            or operation.input_hash != generation_input_hash(normalized_type, instructions)
        ):
            raise ValueError("Generation operation does not match its inputs")
        self._validate_operation_binding(operation)
        existing = self._generation_operations.get(operation.idempotency_key)
        if existing is not None:
            if operation.external_id is not None and operation.external_id != existing.id:
                raise ValueError("Idempotency key is already bound to another generation")
            return existing
        external_id = operation.external_id or str(
            uuid5(NAMESPACE_URL, f"fake-generation:{operation.idempotency_key}")
        )
        handle = GenerationHandle(external_id, workspace.id, normalized_type)
        self._generation_operations[operation.idempotency_key] = handle
        return handle

    async def wait(self, handle: GenerationHandle) -> GeneratedContent:
        if handle.workspace_id not in self.workspaces:
            raise ValueError(f"Unknown fake workspace: {handle.workspace_id}")
        normalized_type = normalize_content_type(handle.content_type)
        title, _, _ = _GENERATED_FORMATS[normalized_type]
        return GeneratedContent(
            id=handle.id,
            workspace_id=handle.workspace_id,
            content_type=normalized_type,
            title=title,
            text=f"Generated fake {normalized_type} content",
            remote_url=None,
        )

    async def download(
        self,
        content: GeneratedContent,
        destination: StorageKey,
        operation: RemoteOperationRef,
    ) -> DocumentAsset:
        normalized_type = normalize_content_type(content.content_type)
        if operation.kind is not RemoteOperationKind.DOWNLOAD_CONTENT:
            raise ValueError("Content download requires a download_content operation")
        if operation.local_resource_id != content.id or operation.input_hash != download_input_hash(
            content, destination
        ):
            raise ValueError("Download operation does not match its inputs")
        self._validate_operation_binding(operation)
        if operation.external_id is not None and operation.external_id != content.id:
            raise ValueError("Download operation external identifier does not match content")
        existing = self._download_operations.get(operation.idempotency_key)
        if existing is not None:
            return existing
        title, suffix, mime_type = _GENERATED_FORMATS[normalized_type]
        payload = (content.text or f"Generated fake {normalized_type} content").encode()
        asset_id = str(uuid5(NAMESPACE_URL, f"fake-download:{operation.idempotency_key}"))
        asset = DocumentAsset(
            id=asset_id,
            storage_key=destination,
            display_filename=f"{normalized_type}-{asset_id[:8]}{suffix}",
            mime_type=mime_type,
            size_bytes=len(payload),
            sha256=hashlib.sha256(payload).hexdigest(),
            title=content.title or title,
            author=None,
            origin=SourceOrigin.LOCAL,
            origin_locator=None,
            rights_provenance_id=str(uuid5(NAMESPACE_URL, f"fake-generated-rights:{content.id}")),
        )
        self._download_operations[operation.idempotency_key] = asset
        return asset

    def _validate_operation_binding(self, operation: RemoteOperationRef) -> None:
        binding = (operation.kind, operation.local_resource_id, operation.input_hash)
        existing = self._operation_bindings.setdefault(operation.idempotency_key, binding)
        if existing != binding:
            raise ValueError("Idempotency key is already bound to different remote inputs")


_GENERATED_FORMATS = {
    "audio": ("Audio Overview", ".mp3", "audio/mpeg"),
    "video": ("Video Overview", ".mp4", "video/mp4"),
    "report": ("Briefing Report", ".md", "text/markdown"),
    "study_guide": ("Study Guide", ".md", "text/markdown"),
    "quiz": ("Quiz", ".json", "application/json"),
    "flashcards": ("Flashcards", ".json", "application/json"),
    "infographic": ("Infographic", ".png", "image/png"),
    "slide_deck": ("Slide Deck", ".pdf", "application/pdf"),
    "data_table": ("Data Table", ".csv", "text/csv"),
}
