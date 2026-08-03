from __future__ import annotations

import asyncio
from dataclasses import replace

import pytest

from diandianreading.application.ports import (
    NullProgressSink,
    source_input_hash,
    workspace_input_hash,
)
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
            workspace_input_hash(book, command.credential),
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
                source_input_hash(workspace, part),
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
    unknown_source_operation = operation(
        RemoteOperationKind.ADD_SOURCE,
        part.id,
        source_input_hash(unknown, part),
        key="unknown-source-key",
    )

    async def scenario() -> None:
        assert await adapter.credential_is_healthy(command.credential)
        other_credential = CredentialRef(provider="other", profile="test")
        assert not await adapter.credential_is_healthy(other_credential)
        adapter.service.healthy = False
        assert not await adapter.credential_is_healthy(command.credential)
        adapter.service.healthy = True

        with pytest.raises(ValueError, match="Unknown fake workspace"):
            await adapter.add_part(unknown, part, unknown_source_operation, sink)
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
        other_workspace_operation = operation(
            RemoteOperationKind.ENSURE_WORKSPACE,
            book.id,
            workspace_input_hash(book, other_credential),
            key="other-workspace-key",
        )
        with pytest.raises(ValueError, match="cannot use provider"):
            await adapter.ensure_workspace(
                book,
                other_credential,
                other_workspace_operation,
                sink,
            )

        workspace_operation = operation(
            RemoteOperationKind.ENSURE_WORKSPACE,
            book.id,
            workspace_input_hash(book, command.credential),
            key="workspace-key",
        )
        workspace = await adapter.ensure_workspace(
            book, command.credential, workspace_operation, sink
        )
        source_operation = operation(
            RemoteOperationKind.ADD_SOURCE,
            part.id,
            source_input_hash(workspace, part),
            key="source-key",
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
