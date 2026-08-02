from __future__ import annotations

import asyncio
from dataclasses import replace

import pytest

from diandianreading.application.ports import NullProgressSink
from diandianreading.domain import (
    Book,
    BookStatus,
    CredentialRef,
    KnowledgeStatus,
    RemoteOperationKind,
    RemoteOperationRef,
    WorkspaceRef,
)
from diandianreading.infrastructure.fakes import FakeKnowledgeAdapter
from tests.support import FIXED_NOW, make_import_command


def operation(
    kind: RemoteOperationKind,
    local_resource_id: str,
    input_hash: str,
    *,
    key: str,
) -> RemoteOperationRef:
    return RemoteOperationRef(
        id=f"operation-{key}",
        idempotency_key=key,
        kind=kind,
        local_resource_id=local_resource_id,
        input_hash=input_hash,
        external_id=None,
    )


def test_fake_adapter_satisfies_idempotent_ingestion_contract(tmp_path) -> None:
    command = make_import_command(tmp_path)
    adapter = FakeKnowledgeAdapter()
    sink = NullProgressSink("job-1")
    book = Book(
        id="book-1",
        title=command.title,
        author=command.author,
        source_hash=command.asset.sha256,
        status=BookStatus.IMPORTING,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
    )

    async def scenario() -> None:
        workspace_operation = operation(
            RemoteOperationKind.ENSURE_WORKSPACE,
            book.id,
            book.source_hash,
            key="workspace-key",
        )
        workspace = await adapter.ensure_workspace(
            book, command.credential, workspace_operation, sink
        )
        repeated_workspace = await adapter.ensure_workspace(
            book, command.credential, workspace_operation, sink
        )
        assert repeated_workspace == workspace
        assert workspace.status is KnowledgeStatus.READY

        uploaded = []
        for part in command.parts:
            source_operation = operation(
                RemoteOperationKind.ADD_SOURCE,
                part.id,
                part.sha256,
                key=f"source-{part.id}",
            )
            source = await adapter.add_part(workspace, part, source_operation, sink)
            repeated = await adapter.add_part(workspace, part, source_operation, sink)
            assert repeated == source
            uploaded.append(source)

        assert all(source.status is KnowledgeStatus.PROCESSING for source in uploaded)
        ready = await adapter.wait_sources(workspace, uploaded, sink)
        assert all(source.status is KnowledgeStatus.READY for source in ready)
        assert {source.document_part_id for source in ready} == {part.id for part in command.parts}

    asyncio.run(scenario())


def test_fake_adapter_rejects_invalid_provider_workspace_and_sources(tmp_path) -> None:
    command = make_import_command(tmp_path, part_count=1)
    adapter = FakeKnowledgeAdapter()
    unknown = WorkspaceRef("missing", "fake", "missing", KnowledgeStatus.READY)
    sink = NullProgressSink("job-1")
    part = command.parts[0]
    source_operation = operation(
        RemoteOperationKind.ADD_SOURCE,
        part.id,
        part.sha256,
        key="source-key",
    )

    async def scenario() -> None:
        with pytest.raises(ValueError, match="Unknown fake workspace"):
            await adapter.add_part(unknown, part, source_operation, sink)
        with pytest.raises(ValueError, match="Unknown fake workspace"):
            await adapter.wait_sources(unknown, (), sink)

        book = Book(
            "book-1",
            command.title,
            command.author,
            command.asset.sha256,
            BookStatus.IMPORTING,
            FIXED_NOW,
            FIXED_NOW,
        )
        workspace_operation = operation(
            RemoteOperationKind.ENSURE_WORKSPACE,
            book.id,
            book.source_hash,
            key="workspace-key",
        )
        with pytest.raises(ValueError, match="cannot use provider"):
            await adapter.ensure_workspace(
                book,
                CredentialRef(provider="other", profile="test"),
                workspace_operation,
                sink,
            )

        workspace = await adapter.ensure_workspace(
            book, command.credential, workspace_operation, sink
        )
        source = await adapter.add_part(workspace, part, source_operation, sink)
        with pytest.raises(ValueError, match="Duplicate"):
            await adapter.wait_sources(workspace, (source, source), sink)
        with pytest.raises(ValueError, match="Unknown fake source"):
            await adapter.wait_sources(
                workspace,
                (replace(source, id="missing"),),
                sink,
            )

    asyncio.run(scenario())
