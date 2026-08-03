from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import replace
from datetime import timedelta

import pytest

from diandianreading.application.ports import ProgressSink
from diandianreading.application.use_cases import ImportBookUseCase
from diandianreading.application.use_cases.import_book import WorkflowCheckpoint
from diandianreading.domain import (
    BlockedReason,
    Book,
    BookStatus,
    CredentialRef,
    DiandianError,
    ErrorCode,
    JobStatus,
    JobStep,
    JobStepStatus,
    KnowledgeSourceRef,
    KnowledgeStatus,
    PreparationManifest,
    ProgressEvent,
    RemoteOperationRef,
    RemoteOperationStatus,
    StorageKey,
    WorkspaceRef,
)
from diandianreading.infrastructure.fakes import FakeKnowledgeAdapter, FakeKnowledgeService
from diandianreading.infrastructure.persistence import (
    SQLiteCatalogRepository,
    SQLiteDatabase,
    SQLiteJobRepository,
    SQLiteJobStepRepository,
    SQLiteKnowledgeMappingRepository,
    SQLiteRemoteOperationRepository,
    SQLiteUnitOfWorkFactory,
)
from tests.support import (
    FIXED_NOW,
    RaisingProgressSink,
    RecordingProgressSink,
    SequentialIds,
    make_import_command,
)


def build_use_case(
    tmp_path,
    adapter,
    *,
    checkpoint_hook=None,
    max_attempts: int = 3,
):
    database = SQLiteDatabase(tmp_path / "state" / "app.sqlite3")
    database.migrate()
    catalog = SQLiteCatalogRepository(database)
    jobs = SQLiteJobRepository(database)
    steps = SQLiteJobStepRepository(database)
    mappings = SQLiteKnowledgeMappingRepository(database)
    operations = SQLiteRemoteOperationRepository(database)
    use_case = ImportBookUseCase(
        unit_of_work=SQLiteUnitOfWorkFactory(database),
        knowledge=adapter,
        id_factory=SequentialIds("book-1", "job-1"),
        clock=lambda: FIXED_NOW,
        retry_delay=timedelta(0),
        max_attempts=max_attempts,
        checkpoint_hook=checkpoint_hook,
    )
    return use_case, database, catalog, jobs, steps, mappings, operations


def test_workflow_configuration_rejects_invalid_lease_retry_and_attempt_limits(tmp_path) -> None:
    database = SQLiteDatabase(tmp_path / "state" / "app.sqlite3")
    database.migrate()
    factory = SQLiteUnitOfWorkFactory(database)
    adapter = FakeKnowledgeAdapter()

    with pytest.raises(ValueError, match="Lease and retry"):
        ImportBookUseCase(
            unit_of_work=factory,
            knowledge=adapter,
            lease_duration=timedelta(0),
        )
    with pytest.raises(ValueError, match="Lease and retry"):
        ImportBookUseCase(
            unit_of_work=factory,
            knowledge=adapter,
            retry_delay=timedelta(seconds=-1),
        )
    with pytest.raises(ValueError, match="max_attempts"):
        ImportBookUseCase(unit_of_work=factory, knowledge=adapter, max_attempts=0)


def test_import_workflow_persists_complete_fake_import_and_checkpoints(tmp_path) -> None:
    service = FakeKnowledgeService.create()
    adapter = FakeKnowledgeAdapter(service)
    use_case, database, catalog, jobs, steps, mappings, operations = build_use_case(
        tmp_path, adapter
    )
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
    assert result.job.current_step is JobStep.VERIFYING
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

    step_records = tuple(steps.list(result.job.id))
    assert [record.step for record in step_records] == list(JobStep)
    assert all(record.status is JobStepStatus.COMPLETED for record in step_records)
    assert all(record.input_hash and record.output_ref for record in step_records)

    events = jobs.list_events(result.job.id)
    assert events[0].to_status is JobStatus.QUEUED
    assert events[1].to_status is JobStatus.RUNNING
    assert events[-1].to_status is JobStatus.COMPLETED
    progress_values = [
        event.progress_current
        for event in events
        if event.progress_total == len(command.parts) and event.progress_current is not None
    ]
    assert progress_values == sorted(progress_values)
    assert progress.events
    assert {event.job_id for event in progress.events} == {result.job.id}

    persisted_operations = tuple(operations.list_for_job(result.job.id))
    assert len(persisted_operations) == len(command.parts) + 1
    assert all(
        operation.status is RemoteOperationStatus.SUCCEEDED
        and operation.external_id
        and operation.dispatch_attempt == 1
        for operation in persisted_operations
    )
    assert service.workspace_write_count == 1
    assert service.source_write_count == len(command.parts)
    assert database.integrity_check()


def test_preparation_failure_rolls_back_mutation_and_fails_active_step(tmp_path) -> None:
    use_case, database, catalog, jobs, steps, _, _ = build_use_case(
        tmp_path, FakeKnowledgeAdapter()
    )
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
    persisted_book = catalog.get_book("book-1")
    assert persisted_job is not None
    assert persisted_job.status is JobStatus.FAILED
    assert persisted_job.current_step is JobStep.PREPARING
    assert persisted_job.last_error_code is ErrorCode.UNEXPECTED
    assert persisted_job.retriable is False
    assert persisted_book is not None and persisted_book.status is BookStatus.FAILED
    preparing = steps.latest("job-1", JobStep.PREPARING)
    assert preparing is not None and preparing.status is JobStepStatus.FAILED

    with pytest.raises(KeyError, match="Unknown Job"):
        use_case.retry("missing-job")
    with database.connect(immediate=True) as connection:
        connection.execute("DROP TRIGGER reject_document_manifest")
    retried = use_case.retry("job-1")
    assert retried.status is JobStatus.QUEUED
    assert retried.attempt == 2
    recovered = asyncio.run(use_case.run("job-1", worker_id="worker-explicit-retry"))
    assert recovered.job.status is JobStatus.COMPLETED
    assert recovered.book.status is BookStatus.READY


def test_progress_observer_failure_cannot_fail_or_strand_import(tmp_path) -> None:
    use_case, _, _, jobs, _, _, _ = build_use_case(tmp_path, FakeKnowledgeAdapter())
    command = make_import_command(tmp_path, part_count=1)

    result = asyncio.run(use_case.execute(command, RaisingProgressSink()))

    assert result.job.status is JobStatus.COMPLETED
    assert jobs.get(result.job.id) == result.job


class RateLimitedOnceAdapter(FakeKnowledgeAdapter):
    def __init__(self) -> None:
        super().__init__()
        self._limited_once = True

    async def ensure_workspace(
        self,
        book: Book,
        credential: CredentialRef,
        operation: RemoteOperationRef,
        progress: ProgressSink,
    ) -> WorkspaceRef:
        if self._limited_once:
            self._limited_once = False
            raise DiandianError(ErrorCode.REMOTE_RATE_LIMITED, "provider rate limited")
        return await super().ensure_workspace(book, credential, operation, progress)


class ProtocolDriftAdapter(FakeKnowledgeAdapter):
    async def ensure_workspace(
        self,
        book: Book,
        credential: CredentialRef,
        operation: RemoteOperationRef,
        progress: ProgressSink,
    ) -> WorkspaceRef:
        del book, credential, operation, progress
        raise DiandianError(
            ErrorCode.REMOTE_PROTOCOL_DRIFT,
            "provider protocol changed",
            retryable=False,
        )


class WaitAuthOnceAdapter(FakeKnowledgeAdapter):
    def __init__(self) -> None:
        super().__init__()
        self._auth_once = True

    async def wait_sources(
        self,
        workspace: WorkspaceRef,
        sources: Sequence[KnowledgeSourceRef],
        progress: ProgressSink,
    ) -> Sequence[KnowledgeSourceRef]:
        if self._auth_once:
            self._auth_once = False
            raise DiandianError(ErrorCode.AUTH_REQUIRED, "login expired", retryable=False)
        return await super().wait_sources(workspace, sources, progress)


class WaitProtocolDriftAdapter(FakeKnowledgeAdapter):
    async def wait_sources(
        self,
        workspace: WorkspaceRef,
        sources: Sequence[KnowledgeSourceRef],
        progress: ProgressSink,
    ) -> Sequence[KnowledgeSourceRef]:
        del workspace, sources, progress
        raise DiandianError(
            ErrorCode.REMOTE_PROTOCOL_DRIFT,
            "source polling protocol changed",
            retryable=False,
        )


class RemoteUnavailableAdapter(FakeKnowledgeAdapter):
    async def ensure_workspace(
        self,
        book: Book,
        credential: CredentialRef,
        operation: RemoteOperationRef,
        progress: ProgressSink,
    ) -> WorkspaceRef:
        del book, credential, operation, progress
        raise DiandianError(ErrorCode.REMOTE_UNAVAILABLE, "provider unavailable")


class CommitThenDisconnectAdapter(FakeKnowledgeAdapter):
    def __init__(self, service: FakeKnowledgeService) -> None:
        super().__init__(service)
        self._disconnect_once = True

    async def ensure_workspace(
        self,
        book: Book,
        credential: CredentialRef,
        operation: RemoteOperationRef,
        progress: ProgressSink,
    ) -> WorkspaceRef:
        workspace = await super().ensure_workspace(book, credential, operation, progress)
        if self._disconnect_once:
            self._disconnect_once = False
            raise RuntimeError("connection closed after provider commit")
        return workspace


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


def test_rate_limited_remote_write_queues_then_redispatches_same_intent(tmp_path) -> None:
    adapter = RateLimitedOnceAdapter()
    use_case, _, _, jobs, steps, _, operations = build_use_case(tmp_path, adapter)
    submitted = use_case.submit(make_import_command(tmp_path, part_count=1))

    with pytest.raises(DiandianError) as raised:
        asyncio.run(use_case.run(submitted.id, worker_id="worker-rate-limited"))
    assert raised.value.code is ErrorCode.REMOTE_RATE_LIMITED
    queued = jobs.get(submitted.id)
    assert queued is not None
    assert queued.status is JobStatus.QUEUED
    assert queued.attempt == 2
    assert queued.retriable is True
    operation = next(iter(operations.list_for_job(submitted.id)))
    assert operation.status is RemoteOperationStatus.PREPARED
    assert operation.dispatch_attempt == 1

    result = asyncio.run(use_case.run(submitted.id, worker_id="worker-after-rate-limit"))
    assert result.job.status is JobStatus.COMPLETED
    workspace_operation = next(
        candidate
        for candidate in operations.list_for_job(submitted.id)
        if candidate.step is JobStep.CREATING_WORKSPACE
    )
    assert workspace_operation.status is RemoteOperationStatus.SUCCEEDED
    assert workspace_operation.dispatch_attempt == 2
    first = steps.get(submitted.id, JobStep.CREATING_WORKSPACE, 1)
    second = steps.get(submitted.id, JobStep.CREATING_WORKSPACE, 2)
    assert first is not None and first.status is JobStepStatus.FAILED
    assert second is not None and second.status is JobStepStatus.COMPLETED


def test_terminal_remote_write_failure_resolves_intent_and_fails_book(tmp_path) -> None:
    use_case, _, catalog, jobs, steps, _, operations = build_use_case(
        tmp_path,
        ProtocolDriftAdapter(),
    )

    with pytest.raises(DiandianError) as raised:
        asyncio.run(use_case.execute(make_import_command(tmp_path, part_count=1)))

    assert raised.value.code is ErrorCode.REMOTE_PROTOCOL_DRIFT
    failed = jobs.get("job-1")
    book = catalog.get_book("book-1")
    operation = next(iter(operations.list_for_job("job-1")))
    record = steps.latest("job-1", JobStep.CREATING_WORKSPACE)
    assert failed is not None and failed.status is JobStatus.FAILED
    assert failed.retriable is False
    assert book is not None and book.status is BookStatus.FAILED
    assert operation.status is RemoteOperationStatus.FAILED_TERMINAL
    assert record is not None and record.status is JobStepStatus.FAILED


def test_remote_write_transport_failure_blocks_without_blind_recreation(tmp_path) -> None:
    use_case, _, catalog, jobs, steps, _, operations = build_use_case(
        tmp_path, RemoteUnavailableAdapter()
    )

    with pytest.raises(DiandianError) as raised:
        asyncio.run(use_case.execute(make_import_command(tmp_path, part_count=1)))

    assert raised.value.code is ErrorCode.REMOTE_UNAVAILABLE
    job = jobs.get("job-1")
    book = catalog.get_book("book-1")
    assert job is not None
    assert job.status is JobStatus.BLOCKED
    assert job.blocked_reason is BlockedReason.REMOTE_OUTCOME_AMBIGUOUS
    assert job.last_error_code is ErrorCode.REMOTE_UNAVAILABLE
    assert book is not None and book.status is BookStatus.IMPORTING
    operation = next(iter(operations.list_for_job(job.id)))
    assert operation.status is RemoteOperationStatus.AMBIGUOUS
    assert operation.dispatch_attempt == 1
    record = steps.latest(job.id, JobStep.CREATING_WORKSPACE)
    assert record is not None and record.status is JobStepStatus.BLOCKED


def test_auth_block_requires_health_check_then_resumes_same_operation(tmp_path) -> None:
    service = FakeKnowledgeService.create()
    service.healthy = False
    use_case, _, _, jobs, steps, _, operations = build_use_case(
        tmp_path, FakeKnowledgeAdapter(service)
    )
    command = make_import_command(tmp_path, part_count=1)

    with pytest.raises(DiandianError) as raised:
        asyncio.run(use_case.execute(command))
    assert raised.value.code is ErrorCode.AUTH_REQUIRED
    blocked = jobs.get("job-1")
    assert blocked is not None
    assert blocked.status is JobStatus.BLOCKED
    assert blocked.blocked_reason is BlockedReason.AUTH_REQUIRED
    operation = next(iter(operations.list_for_job(blocked.id)))
    assert operation.status is RemoteOperationStatus.PREPARED
    assert operation.dispatch_attempt == 1

    with pytest.raises(DiandianError, match="still unavailable"):
        asyncio.run(use_case.resume_after_auth(blocked.id))

    service.healthy = True
    resumed = asyncio.run(use_case.resume_after_auth(blocked.id))
    assert resumed.status is JobStatus.QUEUED
    assert resumed.current_step is JobStep.CREATING_WORKSPACE
    assert resumed.attempt == 2

    result = asyncio.run(use_case.run(blocked.id, worker_id="worker-after-auth"))
    assert result.job.status is JobStatus.COMPLETED
    assert service.workspace_write_count == 1
    operation = next(
        candidate
        for candidate in operations.list_for_job(blocked.id)
        if candidate.step is JobStep.CREATING_WORKSPACE
    )
    assert operation.status is RemoteOperationStatus.SUCCEEDED
    assert operation.dispatch_attempt == 2
    first_attempt = steps.get(blocked.id, JobStep.CREATING_WORKSPACE, 1)
    second_attempt = steps.get(blocked.id, JobStep.CREATING_WORKSPACE, 2)
    assert first_attempt is not None and first_attempt.status is JobStepStatus.BLOCKED
    assert second_attempt is not None and second_attempt.status is JobStepStatus.COMPLETED


def test_read_auth_failure_blocks_then_resumes_processing_step(tmp_path) -> None:
    adapter = WaitAuthOnceAdapter()
    use_case, _, _, jobs, steps, _, _ = build_use_case(tmp_path, adapter)
    submitted = use_case.submit(make_import_command(tmp_path, part_count=1))

    with pytest.raises(DiandianError) as raised:
        asyncio.run(use_case.run(submitted.id, worker_id="worker-read-auth"))
    assert raised.value.code is ErrorCode.AUTH_REQUIRED
    blocked = jobs.get(submitted.id)
    assert blocked is not None
    assert blocked.status is JobStatus.BLOCKED
    assert blocked.blocked_reason is BlockedReason.AUTH_REQUIRED
    assert blocked.current_step is JobStep.PROCESSING

    resumed = asyncio.run(use_case.resume_after_auth(submitted.id))
    assert resumed.status is JobStatus.QUEUED
    result = asyncio.run(use_case.run(submitted.id, worker_id="worker-read-auth-resumed"))
    assert result.job.status is JobStatus.COMPLETED
    first = steps.get(submitted.id, JobStep.PROCESSING, 1)
    second = steps.get(submitted.id, JobStep.PROCESSING, 2)
    assert first is not None and first.status is JobStepStatus.BLOCKED
    assert second is not None and second.status is JobStepStatus.COMPLETED


def test_terminal_read_failure_fails_job_without_recreating_sources(tmp_path) -> None:
    adapter = WaitProtocolDriftAdapter()
    use_case, _, catalog, jobs, steps, _, operations = build_use_case(tmp_path, adapter)

    with pytest.raises(DiandianError) as raised:
        asyncio.run(use_case.execute(make_import_command(tmp_path, part_count=1)))

    assert raised.value.code is ErrorCode.REMOTE_PROTOCOL_DRIFT
    failed = jobs.get("job-1")
    book = catalog.get_book("book-1")
    assert failed is not None and failed.status is JobStatus.FAILED
    assert failed.current_step is JobStep.PROCESSING
    assert book is not None and book.status is BookStatus.FAILED
    processing = steps.latest("job-1", JobStep.PROCESSING)
    assert processing is not None and processing.status is JobStepStatus.FAILED
    assert all(
        operation.status is RemoteOperationStatus.SUCCEEDED
        for operation in operations.list_for_job("job-1")
    )
    assert adapter.service.workspace_write_count == 1
    assert adapter.service.source_write_count == 1


def test_manual_ambiguous_resolution_reuses_committed_workspace(tmp_path) -> None:
    service = FakeKnowledgeService.create()
    adapter = CommitThenDisconnectAdapter(service)
    use_case, _, _, jobs, _, mappings, operations = build_use_case(tmp_path, adapter)
    command = make_import_command(tmp_path, part_count=1)

    with pytest.raises(DiandianError) as raised:
        asyncio.run(use_case.execute(command))
    assert raised.value.code is ErrorCode.REMOTE_OUTCOME_AMBIGUOUS
    blocked = jobs.get("job-1")
    assert blocked is not None
    assert blocked.status is JobStatus.BLOCKED
    operation = next(iter(operations.list_for_job(blocked.id)))
    assert operation.status is RemoteOperationStatus.AMBIGUOUS
    remote_workspace = service.workspace_operations[operation.idempotency_key]
    assert mappings.get_workspace_for_book("book-1") is None

    resumed = use_case.resolve_ambiguous_operation(
        blocked.id,
        operation.idempotency_key,
        external_id=remote_workspace.external_id,
    )
    assert resumed.status is JobStatus.QUEUED

    result = asyncio.run(use_case.run(blocked.id, worker_id="worker-after-resolution"))
    assert result.job.status is JobStatus.COMPLETED
    assert result.workspace.external_id == remote_workspace.external_id
    assert service.workspace_write_count == 1
    reconciled = operations.get_by_idempotency_key(operation.idempotency_key)
    assert reconciled is not None and reconciled.status is RemoteOperationStatus.RECONCILED


def test_retryable_processing_failure_exhausts_bounded_attempts(tmp_path) -> None:
    use_case, _, catalog, jobs, steps, _, _ = build_use_case(
        tmp_path,
        IncompleteAdapter(),
        max_attempts=3,
    )
    command = make_import_command(tmp_path, part_count=1)
    submitted = use_case.submit(command)

    for expected_attempt in (2, 3):
        with pytest.raises(DiandianError) as raised:
            asyncio.run(use_case.run(submitted.id, worker_id=f"worker-{expected_attempt}"))
        assert raised.value.code is ErrorCode.SOURCE_PROCESSING_FAILED
        queued = jobs.get(submitted.id)
        assert queued is not None
        assert queued.status is JobStatus.QUEUED
        assert queued.attempt == expected_attempt
        assert queued.retriable is True

    with pytest.raises(DiandianError) as raised:
        asyncio.run(use_case.run(submitted.id, worker_id="worker-final"))
    assert raised.value.code is ErrorCode.SOURCE_PROCESSING_FAILED
    failed = jobs.get(submitted.id)
    book = catalog.get_book("book-1")
    assert failed is not None
    assert failed.status is JobStatus.FAILED
    assert failed.attempt == 3
    assert failed.retriable is True
    assert book is not None and book.status is BookStatus.FAILED
    processing_attempts = [
        record for record in steps.list(submitted.id) if record.step is JobStep.PROCESSING
    ]
    assert len(processing_attempts) == 3
    assert all(record.status is JobStepStatus.FAILED for record in processing_attempts)


def test_cancellation_after_prepared_intent_prevents_provider_dispatch(tmp_path) -> None:
    service = FakeKnowledgeService.create()
    use_case: ImportBookUseCase
    cancelled_once = False

    def checkpoint(checkpoint: WorkflowCheckpoint, job_id: str, key: str | None) -> None:
        nonlocal cancelled_once
        del key
        if checkpoint is WorkflowCheckpoint.AFTER_INTENT_PREPARED and not cancelled_once:
            cancelled_once = True
            use_case.request_cancel(job_id)

    use_case, _, _, jobs, steps, _, operations = build_use_case(
        tmp_path,
        FakeKnowledgeAdapter(service),
        checkpoint_hook=checkpoint,
    )

    with pytest.raises(DiandianError) as raised:
        asyncio.run(use_case.execute(make_import_command(tmp_path, part_count=1)))

    assert raised.value.code is ErrorCode.CANCELLED
    cancelled = jobs.get("job-1")
    assert cancelled is not None and cancelled.status is JobStatus.CANCELLED
    assert cancelled.cancel_requested_at is not None
    assert use_case.request_cancel(cancelled.id) == cancelled
    operation = next(iter(operations.list_for_job(cancelled.id)))
    assert operation.status is RemoteOperationStatus.CANCELLED_BEFORE_DISPATCH
    assert operation.dispatch_attempt == 0
    record = steps.latest(cancelled.id, JobStep.CREATING_WORKSPACE)
    assert record is not None and record.status is JobStepStatus.CANCELLED
    assert service.workspace_write_count == 0
    assert service.source_write_count == 0


def test_recovery_control_apis_validate_unknown_jobs_and_invalid_resolutions(tmp_path) -> None:
    use_case, _, _, _, _, _, operations = build_use_case(tmp_path, FakeKnowledgeAdapter())

    with pytest.raises(KeyError, match="Unknown Job"):
        asyncio.run(use_case.resume_after_auth("missing-job"))
    with pytest.raises(KeyError, match="Unknown Job"):
        use_case.request_cancel("missing-job")
    with pytest.raises(ValueError, match="exactly one"):
        use_case.resolve_ambiguous_operation("missing-job", "missing-operation")
    with pytest.raises(ValueError, match="exactly one"):
        use_case.resolve_ambiguous_operation(
            "missing-job",
            "missing-operation",
            external_id="external",
            confirmed_absent=True,
        )
    with pytest.raises(KeyError, match="remote operation"):
        use_case.resolve_ambiguous_operation(
            "missing-job",
            "missing-operation",
            confirmed_absent=True,
        )

    result = asyncio.run(use_case.execute(make_import_command(tmp_path, part_count=1)))
    operation = next(iter(operations.list_for_job(result.job.id)))
    with pytest.raises(DiandianError) as raised:
        use_case.resolve_ambiguous_operation(
            result.job.id,
            operation.idempotency_key,
            external_id=operation.external_id,
        )
    assert raised.value.code is ErrorCode.VALIDATION


def test_queued_job_cancellation_is_immediate_and_idempotent(tmp_path) -> None:
    use_case, _, _, jobs, _, _, _ = build_use_case(tmp_path, FakeKnowledgeAdapter())
    submitted = use_case.submit(make_import_command(tmp_path, part_count=1))

    cancelled = use_case.request_cancel(submitted.id)
    repeated = use_case.request_cancel(submitted.id)

    assert cancelled.status is JobStatus.CANCELLED
    assert repeated == cancelled
    assert jobs.get(submitted.id) == cancelled
