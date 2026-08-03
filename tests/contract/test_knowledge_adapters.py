from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from typing import Protocol

import pytest

from diandianreading.application.ports import (
    GeneratedContent,
    KnowledgeGenerationPort,
    KnowledgeHealthPort,
    KnowledgeIngestionPort,
    KnowledgeQueryPort,
    KnowledgeReconciliationPort,
    NullProgressSink,
    ReconciliationResult,
    ReconciliationStatus,
    download_input_hash,
    generation_input_hash,
    source_input_hash,
    workspace_input_hash,
)
from diandianreading.application.use_cases import ImportBookCommand
from diandianreading.domain import (
    Book,
    BookStatus,
    CredentialRef,
    DiandianError,
    ErrorCode,
    JobStep,
    KnowledgeStatus,
    RemoteOperation,
    RemoteOperationKind,
    RemoteOperationRef,
    RemoteOperationStatus,
    RemoteProbeStrategy,
    StorageKey,
    WorkspaceRef,
)
from diandianreading.infrastructure.fakes import (
    DeterministicNotebookLMService,
    FakeKnowledgeAdapter,
    FakeNotebookLMClientFactory,
)
from diandianreading.infrastructure.fakes.notebooklm_sdk import (
    FakeSDKGenerationStatus,
    FakeSDKSource,
)
from diandianreading.infrastructure.notebooklm import CredentialPathResolver, NotebookLMAdapter
from diandianreading.infrastructure.persistence import (
    SQLiteDatabase,
    SQLiteKnowledgeMappingRepository,
)
from diandianreading.infrastructure.storage import LocalFileStore
from tests.support import FIXED_NOW, make_import_command


class FullKnowledgeAdapter(
    KnowledgeIngestionPort,
    KnowledgeQueryPort,
    KnowledgeGenerationPort,
    KnowledgeReconciliationPort,
    KnowledgeHealthPort,
    Protocol,
):
    pass


def test_download_input_hash_binds_every_generated_content_field_and_destination() -> None:
    content = GeneratedContent(
        id="content-1",
        workspace_id="workspace-1",
        content_type="study-guide",
        title="Study Guide",
        text="Grounded content",
        remote_url="https://notebooklm.invalid/artifact/content-1",
    )
    destination = StorageKey("derived/generated/study-guide.md")
    fingerprints = {
        download_input_hash(content, destination),
        download_input_hash(replace(content, id="content-2"), destination),
        download_input_hash(replace(content, workspace_id="workspace-2"), destination),
        download_input_hash(replace(content, content_type="report"), destination),
        download_input_hash(replace(content, title="Revised title"), destination),
        download_input_hash(replace(content, text="Revised content"), destination),
        download_input_hash(
            replace(content, remote_url="https://notebooklm.invalid/artifact/content-2"),
            destination,
        ),
        download_input_hash(content, StorageKey("derived/generated/other.md")),
    }

    assert len(fingerprints) == 8


@dataclass(slots=True)
class AdapterHarness:
    adapter: FullKnowledgeAdapter
    credential: CredentialRef
    command: ImportBookCommand
    service: DeterministicNotebookLMService | None


def operation(
    kind: RemoteOperationKind,
    local_resource_id: str,
    input_hash: str,
    *,
    key: str,
    external_id: str | None = None,
) -> RemoteOperationRef:
    return RemoteOperationRef(
        id=f"operation-{key}",
        idempotency_key=key,
        kind=kind,
        local_resource_id=local_resource_id,
        input_hash=input_hash,
        external_id=external_id,
    )


def persisted_operation(
    reference: RemoteOperationRef,
    *,
    credential: CredentialRef,
    probe_strategy: RemoteProbeStrategy,
) -> RemoteOperation:
    if reference.kind is RemoteOperationKind.ENSURE_WORKSPACE:
        step = JobStep.CREATING_WORKSPACE
    elif reference.kind is RemoteOperationKind.ADD_SOURCE:
        step = JobStep.UPLOADING
    else:
        raise ValueError("Reconciliation contracts only cover ingestion operations")
    return RemoteOperation(
        id=reference.id,
        job_id="contract-job",
        step=step,
        provider=credential.provider,
        credential_profile=credential.profile,
        kind=reference.kind,
        idempotency_key=reference.idempotency_key,
        local_resource_id=reference.local_resource_id,
        input_hash=reference.input_hash,
        probe_strategy=probe_strategy,
        baseline_snapshot_redacted="{}",
        request_summary_redacted="{}",
        status=RemoteOperationStatus.AMBIGUOUS,
        dispatch_attempt=1,
        external_id=reference.external_id,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
        dispatched_at=FIXED_NOW,
        resolved_at=None,
        version=2,
    )


@asynccontextmanager
async def build_harness(kind: str, tmp_path) -> AsyncIterator[AdapterHarness]:
    command = make_import_command(tmp_path, part_count=2)
    if kind == "fake":
        yield AdapterHarness(
            adapter=FakeKnowledgeAdapter(),
            credential=command.credential,
            command=command,
            service=None,
        )
        return

    store = LocalFileStore(tmp_path / "objects")
    for part in command.parts:
        with (tmp_path / f"part-{part.sequence}.md").open("rb") as source:
            store.put(part.storage_key, source)
    credential = CredentialRef("notebooklm", "contract")
    resolver = CredentialPathResolver(tmp_path / "credentials")
    storage_state = resolver.prepare_profile_directory(credential) / "storage_state.json"
    storage_state.write_text(json.dumps({"cookies": [], "origins": []}), encoding="utf-8")
    if os.name != "nt":
        storage_state.chmod(0o600)
    database = SQLiteDatabase(tmp_path / "state" / "app.sqlite3")
    database.migrate()
    service = DeterministicNotebookLMService()
    adapter = NotebookLMAdapter(
        credential_resolver=resolver,
        file_store=store,
        mappings=SQLiteKnowledgeMappingRepository(database),
        staging_root=tmp_path / "staging",
        client_factory=FakeNotebookLMClientFactory(service),
    )
    async with adapter:
        yield AdapterHarness(adapter, credential, command, service)


@pytest.mark.parametrize(
    ("adapter_kind", "probe_strategy", "missing_reconciliation_status"),
    [
        (
            "fake",
            RemoteProbeStrategy.AUTHORITATIVE_OPERATION_KEY,
            ReconciliationStatus.PROVEN_ABSENT,
        ),
        (
            "notebooklm",
            RemoteProbeStrategy.UNSUPPORTED,
            ReconciliationStatus.AMBIGUOUS,
        ),
    ],
)
def test_adapters_share_idempotent_ingestion_query_generation_contract(
    adapter_kind,
    probe_strategy,
    missing_reconciliation_status,
    tmp_path,
) -> None:
    async def scenario() -> DeterministicNotebookLMService | None:
        async with build_harness(adapter_kind, tmp_path) as harness:
            command = harness.command
            adapter = harness.adapter
            sink = NullProgressSink("contract-job")
            assert adapter.probe_strategy is probe_strategy
            assert await adapter.credential_is_healthy(harness.credential)
            book = Book(
                id="book-1",
                title=command.title,
                author=command.author,
                source_hash=command.asset.sha256,
                status=BookStatus.IMPORTING,
                created_at=FIXED_NOW,
                updated_at=FIXED_NOW,
            )
            workspace_operation = operation(
                RemoteOperationKind.ENSURE_WORKSPACE,
                book.id,
                workspace_input_hash(book, harness.credential),
                key="workspace",
            )
            workspace = await adapter.ensure_workspace(
                book, harness.credential, workspace_operation, sink
            )
            assert (
                await adapter.ensure_workspace(book, harness.credential, workspace_operation, sink)
                == workspace
            )
            assert workspace.provider == harness.credential.provider
            assert workspace.status is KnowledgeStatus.READY
            workspace_reconciliation = await adapter.reconcile_workspace(
                book,
                harness.credential,
                persisted_operation(
                    replace(workspace_operation, external_id=workspace.external_id),
                    credential=harness.credential,
                    probe_strategy=adapter.probe_strategy,
                ),
            )
            assert workspace_reconciliation == ReconciliationResult(
                ReconciliationStatus.RECOVERED,
                workspace.external_id,
            )
            missing_workspace_operation = operation(
                RemoteOperationKind.ENSURE_WORKSPACE,
                book.id,
                workspace_input_hash(book, harness.credential),
                key="workspace-missing-reconciliation",
            )
            assert await adapter.reconcile_workspace(
                book,
                harness.credential,
                persisted_operation(
                    missing_workspace_operation,
                    credential=harness.credential,
                    probe_strategy=adapter.probe_strategy,
                ),
            ) == ReconciliationResult(missing_reconciliation_status)

            other_book = replace(book, id="book-2", title="Other book")
            with pytest.raises(ValueError, match="Idempotency key"):
                await adapter.ensure_workspace(
                    other_book,
                    harness.credential,
                    operation(
                        RemoteOperationKind.ENSURE_WORKSPACE,
                        other_book.id,
                        workspace_input_hash(other_book, harness.credential),
                        key="workspace",
                    ),
                    sink,
                )

            uploaded = []
            for part in command.parts:
                source_operation = operation(
                    RemoteOperationKind.ADD_SOURCE,
                    part.id,
                    source_input_hash(workspace, part),
                    key=f"source-{part.id}",
                )
                source = await adapter.add_part(workspace, part, source_operation, sink)
                assert await adapter.add_part(workspace, part, source_operation, sink) == source
                source_reconciliation = await adapter.reconcile_source(
                    workspace,
                    part,
                    persisted_operation(
                        replace(source_operation, external_id=source.external_id),
                        credential=harness.credential,
                        probe_strategy=adapter.probe_strategy,
                    ),
                )
                assert source_reconciliation == ReconciliationResult(
                    ReconciliationStatus.RECOVERED,
                    source.external_id,
                )
                uploaded.append(source)
            missing_part = command.parts[0]
            missing_source_operation = operation(
                RemoteOperationKind.ADD_SOURCE,
                missing_part.id,
                source_input_hash(workspace, missing_part),
                key="source-missing-reconciliation",
            )
            assert await adapter.reconcile_source(
                workspace,
                missing_part,
                persisted_operation(
                    missing_source_operation,
                    credential=harness.credential,
                    probe_strategy=adapter.probe_strategy,
                ),
            ) == ReconciliationResult(missing_reconciliation_status)

            ready = tuple(await adapter.wait_sources(workspace, uploaded, sink))
            assert all(source.status is KnowledgeStatus.READY for source in ready)

            answer = await adapter.ask(
                workspace,
                "What are the key ideas?",
                [source.external_id for source in ready],
                None,
            )
            assert answer.answer
            assert answer.conversation_id
            assert {reference.document_part_id for reference in answer.references} == {
                part.id for part in command.parts
            }
            follow_up = await adapter.ask(
                workspace,
                "Explain further",
                [ready[0].external_id],
                answer.conversation_id,
            )
            assert follow_up.conversation_id == answer.conversation_id
            with pytest.raises(ValueError, match="source"):
                await adapter.ask(workspace, "Use an unknown source", ["unknown-source"], None)

            instructions = "Focus on durable workflows"
            generation_operation = operation(
                RemoteOperationKind.GENERATE_CONTENT,
                workspace.id,
                generation_input_hash("report", instructions),
                key="generation",
            )
            handle = await adapter.generate(
                workspace,
                "report",
                instructions,
                generation_operation,
            )
            assert (
                await adapter.generate(
                    workspace,
                    "report",
                    instructions,
                    generation_operation,
                )
                == handle
            )
            assert (
                await adapter.generate(
                    workspace,
                    "report",
                    instructions,
                    replace(generation_operation, external_id=handle.id),
                )
                == handle
            )
            with pytest.raises(ValueError, match="Idempotency key"):
                changed_instructions = "Use different instructions"
                await adapter.generate(
                    workspace,
                    "report",
                    changed_instructions,
                    operation(
                        RemoteOperationKind.GENERATE_CONTENT,
                        workspace.id,
                        generation_input_hash("report", changed_instructions),
                        key="generation",
                    ),
                )
            content = await adapter.wait(handle)
            assert content.workspace_id == workspace.id
            assert content.content_type == "report"
            assert content.title

            destination = StorageKey("derived/generated/report.md")
            download_operation = operation(
                RemoteOperationKind.DOWNLOAD_CONTENT,
                content.id,
                download_input_hash(content, destination),
                key="download",
            )
            asset = await adapter.download(content, destination, download_operation)
            assert await adapter.download(content, destination, download_operation) == asset
            with pytest.raises(ValueError, match="Idempotency key"):
                changed_content = replace(content, title="Changed generated title")
                await adapter.download(
                    changed_content,
                    destination,
                    operation(
                        RemoteOperationKind.DOWNLOAD_CONTENT,
                        changed_content.id,
                        download_input_hash(changed_content, destination),
                        key="download",
                    ),
                )
            assert asset.storage_key == destination
            assert asset.size_bytes > 0
            assert asset.sha256
            return harness.service

    service = asyncio.run(scenario())
    if service is not None:
        assert service.calls.count("notebooks.list") == 1
        assert service.calls.count("notebooks.create") == 1
        assert service.calls.count("sources.add_file") == 2
        assert service.calls.count("artifacts.generate_report") == 1
        assert service.calls.count("artifacts.download_report") == 1
        assert service.open_count == 1
        assert service.close_count == 1


@pytest.mark.parametrize(
    ("content_type", "suffix", "mime_type", "sdk_generate", "sdk_download"),
    [
        ("audio", ".mp3", "audio/mpeg", "generate_audio", "download_audio"),
        ("video", ".mp4", "video/mp4", "generate_video", "download_video"),
        ("report", ".md", "text/markdown", "generate_report", "download_report"),
        (
            "study-guide",
            ".md",
            "text/markdown",
            "generate_study_guide",
            "download_report",
        ),
        ("quiz", ".json", "application/json", "generate_quiz", "download_quiz"),
        (
            "flashcards",
            ".json",
            "application/json",
            "generate_flashcards",
            "download_flashcards",
        ),
        (
            "infographic",
            ".png",
            "image/png",
            "generate_infographic",
            "download_infographic",
        ),
        (
            "slide_deck",
            ".pdf",
            "application/pdf",
            "generate_slide_deck",
            "download_slide_deck",
        ),
        (
            "data_table",
            ".csv",
            "text/csv",
            "generate_data_table",
            "download_data_table",
        ),
    ],
)
def test_notebooklm_adapter_supports_declared_generation_and_download_formats(
    content_type,
    suffix,
    mime_type,
    sdk_generate,
    sdk_download,
    tmp_path,
) -> None:
    async def scenario() -> DeterministicNotebookLMService:
        async with build_harness("notebooklm", tmp_path) as harness:
            command = harness.command
            adapter = harness.adapter
            sink = NullProgressSink("format-job")
            book = Book(
                "book-format",
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
                workspace_input_hash(book, harness.credential),
                key=f"workspace-{content_type}",
            )
            workspace = await adapter.ensure_workspace(
                book, harness.credential, workspace_operation, sink
            )
            instructions = f"Generate {content_type}"
            input_hash = generation_input_hash(content_type, instructions)
            generation_operation = operation(
                RemoteOperationKind.GENERATE_CONTENT,
                workspace.id,
                input_hash,
                key=f"generation-{content_type}",
            )
            handle = await adapter.generate(
                workspace,
                content_type,
                instructions,
                generation_operation,
            )
            reconciled = await adapter.generate(
                workspace,
                content_type,
                instructions,
                operation(
                    RemoteOperationKind.GENERATE_CONTENT,
                    workspace.id,
                    input_hash,
                    key=f"generation-reconciled-{content_type}",
                    external_id=handle.id,
                ),
            )
            assert reconciled.id == handle.id
            content = await adapter.wait(handle)
            destination = StorageKey(f"derived/formats/{content.content_type}{suffix}")
            download_hash = download_input_hash(content, destination)
            download_operation = operation(
                RemoteOperationKind.DOWNLOAD_CONTENT,
                content.id,
                download_hash,
                key=f"download-{content_type}",
            )
            asset = await adapter.download(content, destination, download_operation)
            reconciled_asset = await adapter.download(
                content,
                destination,
                operation(
                    RemoteOperationKind.DOWNLOAD_CONTENT,
                    content.id,
                    download_hash,
                    key=f"download-reconciled-{content_type}",
                    external_id=content.id,
                ),
            )
            assert reconciled_asset == asset
            assert asset.mime_type == mime_type
            assert asset.display_filename.endswith(suffix)
            assert harness.service is not None
            return harness.service

    service = asyncio.run(scenario())
    assert service.calls.count(f"artifacts.{sdk_generate}") == 1
    assert service.calls.count(f"artifacts.{sdk_download}") == 1


def test_notebooklm_adapter_reconciles_completed_workspace_and_source_operations(tmp_path) -> None:
    async def scenario() -> DeterministicNotebookLMService:
        async with build_harness("notebooklm", tmp_path) as harness:
            command = harness.command
            adapter = harness.adapter
            service = harness.service
            assert service is not None
            sink = NullProgressSink("reconciliation-job")
            book = Book(
                "book-reconciliation",
                command.title,
                command.author,
                command.asset.sha256,
                BookStatus.IMPORTING,
                FIXED_NOW,
                FIXED_NOW,
            )
            initial_operation = operation(
                RemoteOperationKind.ENSURE_WORKSPACE,
                book.id,
                workspace_input_hash(book, harness.credential),
                key="workspace-initial",
            )
            initial_workspace = await adapter.ensure_workspace(
                book, harness.credential, initial_operation, sink
            )
            reconciled_workspace = await adapter.ensure_workspace(
                book,
                harness.credential,
                operation(
                    RemoteOperationKind.ENSURE_WORKSPACE,
                    book.id,
                    workspace_input_hash(book, harness.credential),
                    key="workspace-reconciled",
                    external_id=initial_workspace.external_id,
                ),
                sink,
            )
            assert reconciled_workspace.external_id == initial_workspace.external_id

            part = command.parts[0]
            source = await adapter.add_part(
                initial_workspace,
                part,
                operation(
                    RemoteOperationKind.ADD_SOURCE,
                    part.id,
                    source_input_hash(initial_workspace, part),
                    key="source-initial",
                ),
                sink,
            )
            service.sources[source.external_id] = replace(
                service.sources[source.external_id], status="ready"
            )
            reconciled_source = await adapter.add_part(
                initial_workspace,
                part,
                operation(
                    RemoteOperationKind.ADD_SOURCE,
                    part.id,
                    source_input_hash(initial_workspace, part),
                    key="source-reconciled",
                    external_id=source.external_id,
                ),
                sink,
            )
            assert reconciled_source.external_id == source.external_id
            assert reconciled_source.status is KnowledgeStatus.READY

            with pytest.raises(ValueError, match="different external"):
                await adapter.add_part(
                    initial_workspace,
                    part,
                    operation(
                        RemoteOperationKind.ADD_SOURCE,
                        part.id,
                        source_input_hash(initial_workspace, part),
                        key="source-initial",
                        external_id="different-source",
                    ),
                    sink,
                )
            with pytest.raises(ValueError, match="Idempotency key"):
                other_part = command.parts[1]
                await adapter.add_part(
                    initial_workspace,
                    other_part,
                    operation(
                        RemoteOperationKind.ADD_SOURCE,
                        other_part.id,
                        source_input_hash(initial_workspace, other_part),
                        key="source-initial",
                    ),
                    sink,
                )

            with pytest.raises(DiandianError) as missing_workspace:
                await adapter.ensure_workspace(
                    book,
                    harness.credential,
                    operation(
                        RemoteOperationKind.ENSURE_WORKSPACE,
                        book.id,
                        workspace_input_hash(book, harness.credential),
                        key="workspace-missing",
                        external_id="missing-workspace",
                    ),
                    sink,
                )
            assert missing_workspace.value.code is ErrorCode.REMOTE_UNAVAILABLE

            with pytest.raises(DiandianError) as missing_source:
                await adapter.add_part(
                    initial_workspace,
                    command.parts[1],
                    operation(
                        RemoteOperationKind.ADD_SOURCE,
                        command.parts[1].id,
                        source_input_hash(initial_workspace, command.parts[1]),
                        key="source-missing",
                        external_id="missing-source",
                    ),
                    sink,
                )
            assert missing_source.value.code is ErrorCode.SOURCE_PROCESSING_FAILED
            return service

    service = asyncio.run(scenario())
    assert service.calls.count("notebooks.create") == 1
    assert service.calls.count("notebooks.get_or_none") == 2
    assert service.calls.count("sources.add_file") == 1
    assert service.calls.count("sources.get_or_none") == 2


def test_notebooklm_adapter_keeps_cached_citation_mappings_workspace_scoped(tmp_path) -> None:
    async def scenario() -> DeterministicNotebookLMService:
        async with build_harness("notebooklm", tmp_path) as harness:
            command = harness.command
            adapter = harness.adapter
            service = harness.service
            assert isinstance(adapter, NotebookLMAdapter)
            assert service is not None
            sink = NullProgressSink("workspace-isolation-job")
            first_book = Book(
                "book-first",
                "First workspace",
                None,
                command.asset.sha256,
                BookStatus.IMPORTING,
                FIXED_NOW,
                FIXED_NOW,
            )
            second_book = replace(first_book, id="book-second", title="Second workspace")
            first_workspace = await adapter.ensure_workspace(
                first_book,
                harness.credential,
                operation(
                    RemoteOperationKind.ENSURE_WORKSPACE,
                    first_book.id,
                    workspace_input_hash(first_book, harness.credential),
                    key="workspace-first",
                ),
                sink,
            )
            second_workspace = await adapter.ensure_workspace(
                second_book,
                harness.credential,
                operation(
                    RemoteOperationKind.ENSURE_WORKSPACE,
                    second_book.id,
                    workspace_input_hash(second_book, harness.credential),
                    key="workspace-second",
                ),
                sink,
            )
            first_part, second_part = command.parts
            first_source = await adapter.add_part(
                first_workspace,
                first_part,
                operation(
                    RemoteOperationKind.ADD_SOURCE,
                    first_part.id,
                    source_input_hash(first_workspace, first_part),
                    key="source-first",
                ),
                sink,
            )
            second_source = await adapter.add_part(
                second_workspace,
                second_part,
                operation(
                    RemoteOperationKind.ADD_SOURCE,
                    second_part.id,
                    source_input_hash(second_workspace, second_part),
                    key="source-second",
                ),
                sink,
            )

            assert adapter._persisted_source_parts(first_workspace.id) == {
                first_source.external_id: first_part.id
            }
            assert adapter._persisted_source_parts(second_workspace.id) == {
                second_source.external_id: second_part.id
            }
            with pytest.raises(ValueError, match="requested workspace"):
                await adapter.ask(
                    first_workspace,
                    "Do not cross workspace boundaries",
                    [second_source.external_id],
                    None,
                )
            return service

    service = asyncio.run(scenario())
    assert "chat.ask" not in service.calls


def test_notebooklm_adapter_rejects_mismatched_inputs_and_invalid_queries(tmp_path) -> None:
    async def scenario() -> None:
        async with build_harness("notebooklm", tmp_path) as harness:
            command = harness.command
            adapter = harness.adapter
            sink = NullProgressSink("invalid-job")
            book = Book(
                "book-invalid",
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
                workspace_input_hash(book, harness.credential),
                key="workspace-invalid",
            )
            workspace = await adapter.ensure_workspace(
                book, harness.credential, workspace_operation, sink
            )

            with pytest.raises(ValueError, match="kind"):
                await adapter.ensure_workspace(
                    book,
                    harness.credential,
                    replace(workspace_operation, kind=RemoteOperationKind.ADD_SOURCE),
                    sink,
                )
            with pytest.raises(ValueError, match="local inputs"):
                await adapter.ensure_workspace(
                    book,
                    harness.credential,
                    replace(workspace_operation, idempotency_key="other", input_hash="wrong"),
                    sink,
                )
            with pytest.raises(ValueError, match="identity"):
                await adapter.ensure_workspace(
                    book,
                    harness.credential,
                    replace(workspace_operation, id="", idempotency_key=""),
                    sink,
                )
            with pytest.raises(ValueError, match="provider"):
                other_credential = CredentialRef("other", "profile")
                await adapter.ensure_workspace(
                    book,
                    other_credential,
                    operation(
                        RemoteOperationKind.ENSURE_WORKSPACE,
                        book.id,
                        workspace_input_hash(book, other_credential),
                        key="workspace-other-provider",
                    ),
                    sink,
                )
            with pytest.raises(ValueError, match="valid NotebookLM"):
                await adapter.ask(
                    WorkspaceRef("wrong", "other", "external", KnowledgeStatus.READY),
                    "question",
                    None,
                    None,
                )
            with pytest.raises(ValueError, match="cannot be empty"):
                await adapter.ask(workspace, "  ", None, None)
            with pytest.raises(ValueError, match="Duplicate"):
                await adapter.ask(workspace, "question", ["same", "same"], None)
            assert await adapter.wait_sources(workspace, (), sink) == ()
            with pytest.raises(ValueError, match="Duplicate"):
                source = await adapter.add_part(
                    workspace,
                    command.parts[0],
                    operation(
                        RemoteOperationKind.ADD_SOURCE,
                        command.parts[0].id,
                        source_input_hash(workspace, command.parts[0]),
                        key="source-valid",
                    ),
                    sink,
                )
                await adapter.wait_sources(workspace, (source, source), sink)
            with pytest.raises(DiandianError) as unsupported:
                await adapter.generate(
                    workspace,
                    "unsupported-format",
                    None,
                    operation(
                        RemoteOperationKind.GENERATE_CONTENT,
                        workspace.id,
                        generation_input_hash("unsupported-format", None),
                        key="unsupported-generation",
                    ),
                )
            assert unsupported.value.code is ErrorCode.FORMAT_UNSUPPORTED

            mismatched_part = replace(command.parts[1], size_bytes=999)
            with pytest.raises(DiandianError) as mismatched:
                await adapter.add_part(
                    workspace,
                    mismatched_part,
                    operation(
                        RemoteOperationKind.ADD_SOURCE,
                        mismatched_part.id,
                        source_input_hash(workspace, mismatched_part),
                        key="source-mismatched",
                    ),
                    sink,
                )
            assert mismatched.value.code is ErrorCode.VALIDATION

    asyncio.run(scenario())


def test_notebooklm_adapter_maps_source_and_generation_terminal_states(tmp_path) -> None:
    async def scenario() -> None:
        async with build_harness("notebooklm", tmp_path) as harness:
            command = harness.command
            adapter = harness.adapter
            service = harness.service
            assert service is not None
            sink = NullProgressSink("terminal-state-job")
            book = Book(
                "book-terminal",
                command.title,
                command.author,
                command.asset.sha256,
                BookStatus.IMPORTING,
                FIXED_NOW,
                FIXED_NOW,
            )
            workspace = await adapter.ensure_workspace(
                book,
                harness.credential,
                operation(
                    RemoteOperationKind.ENSURE_WORKSPACE,
                    book.id,
                    workspace_input_hash(book, harness.credential),
                    key="workspace-terminal",
                ),
                sink,
            )
            failed_source = FakeSDKSource(
                id="failed-source",
                notebook_id=workspace.external_id,
                title="failed",
                content=b"failed",
                status="error",
            )
            service.sources[failed_source.id] = failed_source
            part = command.parts[0]
            with pytest.raises(DiandianError) as source_failure:
                await adapter.add_part(
                    workspace,
                    part,
                    operation(
                        RemoteOperationKind.ADD_SOURCE,
                        part.id,
                        source_input_hash(workspace, part),
                        key="failed-source-replay",
                        external_id=failed_source.id,
                    ),
                    sink,
                )
            assert source_failure.value.code is ErrorCode.SOURCE_PROCESSING_FAILED

            for status in (
                FakeSDKGenerationStatus("task", "failed"),
                FakeSDKGenerationStatus("task", "removed"),
            ):
                with pytest.raises(DiandianError) as generation_failure:
                    NotebookLMAdapter._validate_generation_status(status)
                assert generation_failure.value.code is ErrorCode.CONVERSION_FAILED
            with pytest.raises(DiandianError) as rate_limited:
                NotebookLMAdapter._validate_generation_status(
                    FakeSDKGenerationStatus(
                        "task",
                        "failed",
                        error_code="USER_DISPLAYABLE_ERROR",
                    )
                )
            assert rate_limited.value.code is ErrorCode.REMOTE_RATE_LIMITED
            with pytest.raises(DiandianError) as missing_task:
                NotebookLMAdapter._validate_generation_status(
                    FakeSDKGenerationStatus("", "in_progress")
                )
            assert missing_task.value.code is ErrorCode.REMOTE_PROTOCOL_DRIFT
            with pytest.raises(DiandianError) as non_terminal:
                NotebookLMAdapter._validate_generation_status(
                    FakeSDKGenerationStatus("task", "in_progress"),
                    require_complete=True,
                )
            assert non_terminal.value.code is ErrorCode.REMOTE_PROTOCOL_DRIFT

    asyncio.run(scenario())
