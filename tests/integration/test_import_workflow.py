from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import replace

import pytest

from diandianreading.application.ports import ProgressSink
from diandianreading.application.use_cases import ImportBookUseCase
from diandianreading.domain import (
    Book,
    BookStatus,
    CredentialRef,
    DiandianError,
    ErrorCode,
    JobStatus,
    KnowledgeSourceRef,
    KnowledgeStatus,
    PreparationManifest,
    ProgressEvent,
    RemoteOperationRef,
    StorageKey,
    WorkspaceRef,
)
from diandianreading.infrastructure.fakes import FakeKnowledgeAdapter
from diandianreading.infrastructure.persistence import (
    SQLiteCatalogRepository,
    SQLiteDatabase,
    SQLiteJobRepository,
    SQLiteKnowledgeMappingRepository,
    SQLiteUnitOfWorkFactory,
)
from tests.support import (
    FIXED_NOW,
    RaisingProgressSink,
    RecordingProgressSink,
    SequentialIds,
    make_import_command,
)


def build_use_case(tmp_path, adapter):
    database = SQLiteDatabase(tmp_path / "state" / "app.sqlite3")
    database.migrate()
    catalog = SQLiteCatalogRepository(database)
    jobs = SQLiteJobRepository(database)
    mappings = SQLiteKnowledgeMappingRepository(database)
    use_case = ImportBookUseCase(
        unit_of_work=SQLiteUnitOfWorkFactory(database),
        knowledge=adapter,
        id_factory=SequentialIds("book-1", "job-1"),
        clock=lambda: FIXED_NOW,
    )
    return use_case, database, catalog, jobs, mappings


def test_import_workflow_persists_complete_fake_import_and_operations(tmp_path) -> None:
    adapter = FakeKnowledgeAdapter()
    use_case, database, catalog, jobs, mappings = build_use_case(tmp_path, adapter)
    base_command = make_import_command(tmp_path)
    derived = replace(
        base_command.asset,
        id="asset-derived",
        storage_key=StorageKey("derived/asset-1/book.md"),
        display_filename="derived.md",
        sha256="derived-hash",
        derived_from_asset_id=base_command.asset.id,
    )
    command = replace(
        base_command,
        derived_assets=(derived,),
        parts=tuple(replace(part, asset_id=derived.id) for part in base_command.parts),
        manifest=PreparationManifest(
            root_asset_id=base_command.asset.id,
            storage_key=StorageKey("manifests/asset-1/manifest.json"),
            sha256="manifest-hash",
        ),
    )
    progress = RecordingProgressSink(events=[])

    result = asyncio.run(use_case.execute(command, progress))

    assert result.job.status is JobStatus.COMPLETED
    assert result.book.status is BookStatus.READY
    assert all(source.status is KnowledgeStatus.READY for source in result.sources)
    assert catalog.get_book(result.book.id) == result.book
    assert set(catalog.list_assets(result.book.id)) == {command.asset, derived}
    assert len(catalog.list_parts(result.book.id)) == 2
    assert catalog.get_manifest(command.asset.id) == command.manifest
    assert mappings.get_workspace(result.workspace.id) is not None
    assert all(
        source.status is KnowledgeStatus.READY
        for source in mappings.list_sources(result.workspace.id)
    )
    assert jobs.get(result.job.id) == result.job
    events = jobs.list_events(result.job.id)
    assert len(events) == 11
    assert [
        (event.progress_current, event.progress_total) for event in events if event.progress_total
    ] == [
        (1, 2),
        (2, 2),
    ]
    assert progress.events
    assert {event.job_id for event in progress.events} == {result.job.id}
    with database.connect() as connection:
        rows = connection.execute(
            "SELECT status, external_id FROM remote_operations ORDER BY kind, local_resource_id"
        ).fetchall()
    assert len(rows) == 3
    assert all(row["status"] == "completed" and row["external_id"] for row in rows)


def test_preparation_manifest_failure_rolls_back_derived_assets_parts_and_transition(
    tmp_path,
) -> None:
    use_case, database, catalog, jobs, _ = build_use_case(tmp_path, FakeKnowledgeAdapter())
    base = make_import_command(tmp_path, part_count=1)
    derived = replace(
        base.asset,
        id="asset-derived",
        storage_key=StorageKey("derived/asset-1/book.md"),
        display_filename="derived.md",
        sha256="derived-hash",
        derived_from_asset_id=base.asset.id,
    )
    manifest = PreparationManifest(
        root_asset_id=base.asset.id,
        storage_key=StorageKey("manifests/asset-1/manifest.json"),
        sha256="manifest-hash",
    )
    command = replace(
        base,
        derived_assets=(derived,),
        parts=(replace(base.parts[0], asset_id=derived.id),),
        manifest=manifest,
    )
    with database.connect(immediate=True) as connection:
        connection.execute(
            """
            CREATE TRIGGER reject_document_manifest
            BEFORE INSERT ON document_manifests
            BEGIN
                SELECT RAISE(ABORT, 'forced manifest failure');
            END
            """
        )

    with pytest.raises(DiandianError) as raised:
        asyncio.run(use_case.execute(command))

    assert raised.value.code is ErrorCode.UNEXPECTED
    assert tuple(catalog.list_assets("book-1")) == (base.asset,)
    assert tuple(catalog.list_parts("book-1")) == ()
    assert catalog.get_manifest(base.asset.id) is None
    persisted_job = jobs.get("job-1")
    assert persisted_job is not None
    assert persisted_job.status is JobStatus.FAILED_TERMINAL
    assert persisted_job.step.value == "storing"
    assert all(event.step.value != "preparing" for event in jobs.list_events("job-1"))


def test_progress_observer_failure_cannot_fail_or_strand_import(tmp_path) -> None:
    use_case, _, _, jobs, _ = build_use_case(tmp_path, FakeKnowledgeAdapter())
    command = make_import_command(tmp_path, part_count=1)

    result = asyncio.run(use_case.execute(command, RaisingProgressSink()))

    assert result.job.status is JobStatus.COMPLETED
    assert jobs.get(result.job.id) == result.job


class TypedFailingAdapter(FakeKnowledgeAdapter):
    async def ensure_workspace(
        self,
        book: Book,
        credential: CredentialRef,
        operation: RemoteOperationRef,
        progress: ProgressSink,
    ) -> WorkspaceRef:
        del book, credential, operation, progress
        raise DiandianError(ErrorCode.REMOTE_UNAVAILABLE, "provider unavailable")


class AuthFailingAdapter(FakeKnowledgeAdapter):
    async def ensure_workspace(
        self,
        book: Book,
        credential: CredentialRef,
        operation: RemoteOperationRef,
        progress: ProgressSink,
    ) -> WorkspaceRef:
        del book, credential, operation, progress
        raise DiandianError(ErrorCode.AUTH_REQUIRED, "login required")


class UnexpectedFailingAdapter(FakeKnowledgeAdapter):
    async def ensure_workspace(
        self,
        book: Book,
        credential: CredentialRef,
        operation: RemoteOperationRef,
        progress: ProgressSink,
    ) -> WorkspaceRef:
        del book, credential, operation, progress
        raise RuntimeError("secret provider details")


class IncompleteAdapter(FakeKnowledgeAdapter):
    async def wait_sources(
        self,
        workspace: WorkspaceRef,
        sources: Sequence[KnowledgeSourceRef],
        progress: ProgressSink,
    ) -> Sequence[KnowledgeSourceRef]:
        del workspace, sources
        await progress.emit(ProgressEvent(progress.job_id, "processing", 0, 1, "not ready"))
        return ()


class ReplacementSourceAdapter(FakeKnowledgeAdapter):
    async def wait_sources(
        self,
        workspace: WorkspaceRef,
        sources: Sequence[KnowledgeSourceRef],
        progress: ProgressSink,
    ) -> Sequence[KnowledgeSourceRef]:
        ready = await super().wait_sources(workspace, sources, progress)
        return tuple(replace(source, id=f"replacement-{source.id}") for source in ready)


@pytest.mark.parametrize(
    ("adapter", "expected_code", "expected_status", "expected_message", "book_status"),
    [
        (
            TypedFailingAdapter(),
            ErrorCode.REMOTE_UNAVAILABLE,
            JobStatus.FAILED_RETRYABLE,
            "provider unavailable",
            BookStatus.FAILED,
        ),
        (
            AuthFailingAdapter(),
            ErrorCode.AUTH_REQUIRED,
            JobStatus.BLOCKED,
            "login required",
            BookStatus.IMPORTING,
        ),
        (
            UnexpectedFailingAdapter(),
            ErrorCode.UNEXPECTED,
            JobStatus.FAILED_TERMINAL,
            "Unexpected import failure",
            BookStatus.FAILED,
        ),
        (
            IncompleteAdapter(),
            ErrorCode.SOURCE_PROCESSING_FAILED,
            JobStatus.FAILED_RETRYABLE,
            "Knowledge sources did not become ready with their original identities",
            BookStatus.FAILED,
        ),
        (
            ReplacementSourceAdapter(),
            ErrorCode.SOURCE_PROCESSING_FAILED,
            JobStatus.FAILED_RETRYABLE,
            "Knowledge sources did not become ready with their original identities",
            BookStatus.FAILED,
        ),
    ],
)
def test_import_workflow_persists_typed_failures(
    tmp_path,
    adapter,
    expected_code,
    expected_status,
    expected_message,
    book_status,
) -> None:
    use_case, _, catalog, jobs, mappings = build_use_case(tmp_path, adapter)
    command = make_import_command(tmp_path, part_count=1)

    with pytest.raises(DiandianError) as raised:
        asyncio.run(use_case.execute(command))

    assert raised.value.code is expected_code
    assert raised.value.public_message == expected_message
    persisted_job = jobs.get("job-1")
    persisted_book = catalog.get_book("book-1")
    assert persisted_job is not None and persisted_job.status is expected_status
    assert persisted_job.error_message == expected_message
    assert persisted_book is not None and persisted_book.status is book_status
    if isinstance(adapter, ReplacementSourceAdapter):
        assert all(
            source.status is KnowledgeStatus.PROCESSING
            for source in mappings.list_sources(next(iter(adapter.workspaces)))
        )
