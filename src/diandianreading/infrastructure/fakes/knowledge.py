"""Deterministic in-memory knowledge ingestion adapter for tests and local demos."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace
from uuid import NAMESPACE_URL, uuid5

from diandianreading.application.ports import KnowledgeIngestionPort, ProgressSink
from diandianreading.domain import (
    Book,
    CredentialRef,
    DocumentPart,
    KnowledgeSourceRef,
    KnowledgeStatus,
    ProgressEvent,
    RemoteOperationKind,
    RemoteOperationRef,
    WorkspaceRef,
)


class FakeKnowledgeAdapter(KnowledgeIngestionPort):
    """A deterministic, idempotent adapter with create/upload/wait semantics."""

    provider = "fake"

    def __init__(self) -> None:
        self.workspaces: dict[str, WorkspaceRef] = {}
        self.sources: dict[str, KnowledgeSourceRef] = {}
        self._workspace_operations: dict[str, WorkspaceRef] = {}
        self._source_operations: dict[str, KnowledgeSourceRef] = {}

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
