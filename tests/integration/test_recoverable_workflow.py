from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta

import pytest

from diandianreading.application.ports import ProgressSink
from diandianreading.application.use_cases import ImportBookUseCase
from diandianreading.application.use_cases.import_book import WorkflowCheckpoint
from diandianreading.domain import (
    BlockedReason,
    DiandianError,
    DocumentPart,
    ErrorCode,
    JobStatus,
    JobStep,
    JobStepStatus,
    KnowledgeSourceRef,
    RemoteOperationRef,
    RemoteOperationStatus,
    RepositoryConflict,
    WorkspaceRef,
)
from diandianreading.infrastructure.fakes import FakeKnowledgeAdapter, FakeKnowledgeService
from diandianreading.infrastructure.persistence import (
    SQLiteDatabase,
    SQLiteJobRepository,
    SQLiteJobStepRepository,
    SQLiteKnowledgeMappingRepository,
    SQLiteRemoteOperationRepository,
    SQLiteUnitOfWorkFactory,
)
from tests.support import FIXED_NOW, SequentialIds, make_import_command


class InjectedCrash(BaseException):
    """Model process death: application `except Exception` blocks must not observe it."""


@dataclass(slots=True)
class MutableClock:
    current: datetime = FIXED_NOW

    def __call__(self) -> datetime:
        return self.current

    def advance(self, delta: timedelta) -> None:
        self.current += delta


@dataclass(slots=True)
class CrashOnce:
    target: WorkflowCheckpoint
    occurrence: int = 1
    key: str | None = None
    seen: int = 0
    crashed: bool = False

    def __call__(
        self,
        checkpoint: WorkflowCheckpoint,
        job_id: str,
        key: str | None,
    ) -> None:
        del job_id
        if self.crashed or checkpoint is not self.target:
            return
        if self.key is not None and key != self.key:
            return
        self.seen += 1
        if self.seen == self.occurrence:
            self.crashed = True
            raise InjectedCrash(f"crash at {checkpoint.value}:{key or '-'}")


@dataclass(frozen=True, slots=True)
class CrashCase:
    name: str
    checkpoint: WorkflowCheckpoint
    occurrence: int = 1
    key: str | None = None


class TakeoverOnRecoveredSourceAdapter(FakeKnowledgeAdapter):
    def __init__(
        self,
        service: FakeKnowledgeService,
        jobs: SQLiteJobRepository,
        clock: MutableClock,
        job_id: str,
    ) -> None:
        super().__init__(service)
        self._jobs = jobs
        self._clock = clock
        self._job_id = job_id
        self.taken_over = False

    async def add_part(
        self,
        workspace: WorkspaceRef,
        part: DocumentPart,
        operation: RemoteOperationRef,
        progress: ProgressSink,
    ) -> KnowledgeSourceRef:
        if operation.external_id is not None and not self.taken_over:
            self._clock.advance(timedelta(seconds=6))
            now = self._clock()
            self._jobs.claim(
                self._job_id,
                "worker-taking-over",
                lease_expires_at=now + timedelta(seconds=5),
                now=now,
            )
            self.taken_over = True
        return await super().add_part(workspace, part, operation, progress)


CRASH_CASES = (
    CrashCase("local-step-started", WorkflowCheckpoint.AFTER_STEP_STARTED),
    CrashCase(
        "local-step-checkpointed",
        WorkflowCheckpoint.AFTER_STEP_CHECKPOINT,
        key=JobStep.ACQUIRING.value,
    ),
    CrashCase("workspace-intent-prepared", WorkflowCheckpoint.AFTER_INTENT_PREPARED),
    CrashCase("workspace-dispatched", WorkflowCheckpoint.AFTER_OPERATION_DISPATCHED),
    CrashCase("workspace-provider-committed", WorkflowCheckpoint.AFTER_PROVIDER_COMMIT),
    CrashCase(
        "workspace-step-checkpointed",
        WorkflowCheckpoint.AFTER_STEP_CHECKPOINT,
        key=JobStep.CREATING_WORKSPACE.value,
    ),
    CrashCase(
        "source-intent-prepared",
        WorkflowCheckpoint.AFTER_INTENT_PREPARED,
        occurrence=2,
    ),
    CrashCase(
        "source-dispatched",
        WorkflowCheckpoint.AFTER_OPERATION_DISPATCHED,
        occurrence=2,
    ),
    CrashCase(
        "source-provider-committed",
        WorkflowCheckpoint.AFTER_PROVIDER_COMMIT,
        occurrence=2,
    ),
    CrashCase(
        "partial-sources-checkpointed",
        WorkflowCheckpoint.AFTER_SOURCE_CHECKPOINT,
        occurrence=2,
    ),
    CrashCase("source-wait-in-flight", WorkflowCheckpoint.SOURCE_WAIT_IN_FLIGHT),
)


def make_runtime(
    root,
    service: FakeKnowledgeService,
    clock: MutableClock,
    *,
    hook=None,
    knowledge: FakeKnowledgeAdapter | None = None,
    create: bool = False,
) -> tuple[ImportBookUseCase, SQLiteDatabase]:
    database_path = root / "state" / "app.sqlite3"
    database = SQLiteDatabase.create_new(database_path) if create else SQLiteDatabase(database_path)
    database.migrate()
    use_case = ImportBookUseCase(
        unit_of_work=SQLiteUnitOfWorkFactory(database),
        knowledge=knowledge or FakeKnowledgeAdapter(service),
        id_factory=SequentialIds("book-1", "job-1"),
        clock=clock,
        lease_duration=timedelta(seconds=5),
        retry_delay=timedelta(0),
        checkpoint_hook=hook,
    )
    return use_case, database


@pytest.mark.parametrize("case", CRASH_CASES, ids=lambda case: case.name)
def test_every_checkpoint_recovers_after_expired_lease_without_duplicate_writes(
    tmp_path,
    case: CrashCase,
) -> None:
    root = tmp_path / case.name
    root.mkdir()
    clock = MutableClock()
    service = FakeKnowledgeService.create()
    crash = CrashOnce(case.checkpoint, case.occurrence, case.key)
    crashing, database = make_runtime(root, service, clock, hook=crash, create=True)
    command = make_import_command(root, part_count=3)
    submitted = crashing.submit(command)

    with pytest.raises(InjectedCrash):
        asyncio.run(crashing.run(submitted.id, worker_id="worker-before-crash"))

    assert crash.crashed
    stranded = SQLiteJobRepository(database).get(submitted.id)
    assert stranded is not None
    assert stranded.status is JobStatus.RUNNING
    assert stranded.lease_owner == "worker-before-crash"
    assert stranded.lease_generation == 1

    clock.advance(timedelta(seconds=6))
    recovered, reopened = make_runtime(root, service, clock)
    result = asyncio.run(recovered.run(submitted.id, worker_id="worker-after-crash"))

    assert result.job.status is JobStatus.COMPLETED
    assert result.job.lease_generation == 2
    assert result.job.current_step is JobStep.VERIFYING
    assert service.workspace_write_count == 1
    assert service.source_write_count == len(command.parts)

    operations = tuple(SQLiteRemoteOperationRepository(reopened).list_for_job(submitted.id))
    assert len(operations) == len(command.parts) + 1
    assert all(
        operation.status in {RemoteOperationStatus.SUCCEEDED, RemoteOperationStatus.RECONCILED}
        for operation in operations
    )
    assert not any(operation.is_unresolved for operation in operations)

    step_records = tuple(SQLiteJobStepRepository(reopened).list(submitted.id))
    assert len(step_records) == len(JobStep)
    assert all(record.status is JobStepStatus.COMPLETED for record in step_records)
    assert {record.attempt for record in step_records} == {1}

    progress = [
        event.progress_current
        for event in SQLiteJobRepository(reopened).list_events(submitted.id)
        if event.progress_total == len(command.parts) and event.progress_current is not None
    ]
    assert progress == sorted(progress)
    assert reopened.integrity_check()


def test_recovered_source_mapping_write_is_fenced_after_lease_takeover(tmp_path) -> None:
    root = tmp_path / "recovered-source-fencing"
    root.mkdir()
    clock = MutableClock()
    service = FakeKnowledgeService.create()
    crash = CrashOnce(WorkflowCheckpoint.AFTER_PROVIDER_COMMIT, occurrence=2)
    crashing, database = make_runtime(root, service, clock, hook=crash, create=True)
    command = make_import_command(root, part_count=1)
    submitted = crashing.submit(command)

    with pytest.raises(InjectedCrash):
        asyncio.run(crashing.run(submitted.id, worker_id="worker-before-crash"))

    clock.advance(timedelta(seconds=6))
    jobs = SQLiteJobRepository(database)
    stealing_adapter = TakeoverOnRecoveredSourceAdapter(service, jobs, clock, submitted.id)
    recovering, _ = make_runtime(root, service, clock, knowledge=stealing_adapter)

    with pytest.raises(RepositoryConflict, match="stale"):
        asyncio.run(recovering.run(submitted.id, worker_id="worker-being-fenced"))

    assert stealing_adapter.taken_over
    workspace = SQLiteKnowledgeMappingRepository(database).get_workspace_for_book("book-1")
    assert workspace is not None
    assert SQLiteKnowledgeMappingRepository(database).list_sources(workspace.id) == ()
    assert service.source_write_count == 1
    fenced_job = jobs.get(submitted.id)
    assert fenced_job is not None
    assert fenced_job.status is JobStatus.RUNNING
    assert fenced_job.lease_owner == "worker-taking-over"
    assert fenced_job.lease_generation == 3

    clock.advance(timedelta(seconds=6))
    final_worker, _ = make_runtime(root, service, clock)
    result = asyncio.run(final_worker.run(submitted.id, worker_id="worker-after-fencing"))

    assert result.job.status is JobStatus.COMPLETED
    assert result.job.lease_generation == 4
    assert service.source_write_count == 1
    assert len(SQLiteKnowledgeMappingRepository(database).list_sources(workspace.id)) == 1


def test_cancellation_of_stranded_dispatched_operation_waits_for_resolution(tmp_path) -> None:
    root = tmp_path / "cancel-stranded-dispatch"
    root.mkdir()
    clock = MutableClock()
    service = FakeKnowledgeService.create()
    crashing: ImportBookUseCase
    requested = False

    def request_cancel_then_crash(
        checkpoint: WorkflowCheckpoint,
        job_id: str,
        key: str | None,
    ) -> None:
        nonlocal requested
        del key
        if checkpoint is WorkflowCheckpoint.AFTER_OPERATION_DISPATCHED and not requested:
            requested = True
            crashing.request_cancel(job_id)
            raise InjectedCrash("cancel after dispatched checkpoint")

    crashing, database = make_runtime(
        root,
        service,
        clock,
        hook=request_cancel_then_crash,
        create=True,
    )
    submitted = crashing.submit(make_import_command(root, part_count=1))
    with pytest.raises(InjectedCrash):
        asyncio.run(crashing.run(submitted.id, worker_id="worker-before-crash"))
    assert service.workspace_write_count == 0

    operation = next(iter(SQLiteRemoteOperationRepository(database).list_for_job(submitted.id)))
    assert operation.status is RemoteOperationStatus.DISPATCHED
    clock.advance(timedelta(seconds=6))
    recovering, _ = make_runtime(root, service, clock)
    with pytest.raises(DiandianError) as raised:
        asyncio.run(recovering.run(submitted.id, worker_id="worker-cancellation-recovery"))
    assert raised.value.code is ErrorCode.REMOTE_OUTCOME_AMBIGUOUS
    blocked = SQLiteJobRepository(database).get(submitted.id)
    assert blocked is not None
    assert blocked.status is JobStatus.BLOCKED
    assert blocked.cancel_requested_at is not None
    record = SQLiteJobStepRepository(database).latest(
        submitted.id,
        JobStep.CREATING_WORKSPACE,
    )
    assert record is not None and record.status is JobStepStatus.BLOCKED

    cancelled = recovering.resolve_ambiguous_operation(
        submitted.id,
        operation.idempotency_key,
        confirmed_absent=True,
    )
    assert cancelled.status is JobStatus.CANCELLED
    resolved = SQLiteRemoteOperationRepository(database).get_by_idempotency_key(
        operation.idempotency_key
    )
    assert resolved is not None
    assert resolved.status is RemoteOperationStatus.CANCELLED_BEFORE_DISPATCH
    assert service.workspace_write_count == 0


def test_normal_checkpoint_exception_blocks_unknown_remote_outcome(tmp_path) -> None:
    root = tmp_path / "checkpoint-exception"
    root.mkdir()
    clock = MutableClock()
    service = FakeKnowledgeService.create()

    def fail_checkpoint(
        checkpoint: WorkflowCheckpoint,
        job_id: str,
        key: str | None,
    ) -> None:
        del job_id, key
        if checkpoint is WorkflowCheckpoint.AFTER_OPERATION_DISPATCHED:
            raise RuntimeError("checkpoint observer failed")

    use_case, database = make_runtime(
        root,
        service,
        clock,
        hook=fail_checkpoint,
        create=True,
    )
    submitted = use_case.submit(make_import_command(root, part_count=1))

    with pytest.raises(DiandianError) as raised:
        asyncio.run(use_case.run(submitted.id, worker_id="worker-checkpoint-error"))

    assert raised.value.code is ErrorCode.UNEXPECTED
    blocked = SQLiteJobRepository(database).get(submitted.id)
    assert blocked is not None
    assert blocked.status is JobStatus.BLOCKED
    assert blocked.blocked_reason is BlockedReason.REMOTE_OUTCOME_AMBIGUOUS
    operation = next(iter(SQLiteRemoteOperationRepository(database).list_for_job(submitted.id)))
    assert operation.status is RemoteOperationStatus.DISPATCHED
    record = SQLiteJobStepRepository(database).latest(
        submitted.id,
        JobStep.CREATING_WORKSPACE,
    )
    assert record is not None and record.status is JobStepStatus.BLOCKED
    assert service.workspace_write_count == 0


def test_probe_ambiguity_blocks_then_manual_external_id_recovers_without_duplicate_write(
    tmp_path,
) -> None:
    root = tmp_path / "manual-external-id"
    root.mkdir()
    clock = MutableClock()
    service = FakeKnowledgeService.create()
    crash = CrashOnce(WorkflowCheckpoint.AFTER_PROVIDER_COMMIT)
    crashing, database = make_runtime(root, service, clock, hook=crash, create=True)
    submitted = crashing.submit(make_import_command(root, part_count=2))

    with pytest.raises(InjectedCrash):
        asyncio.run(crashing.run(submitted.id, worker_id="worker-before-crash"))

    operation = next(iter(SQLiteRemoteOperationRepository(database).list_for_job(submitted.id)))
    remote_workspace = service.workspace_operations[operation.idempotency_key]
    service.ambiguous_operations.add(operation.idempotency_key)
    clock.advance(timedelta(seconds=6))
    recovering, _ = make_runtime(root, service, clock)

    with pytest.raises(DiandianError) as raised:
        asyncio.run(recovering.run(submitted.id, worker_id="worker-probing"))
    assert raised.value.code is ErrorCode.REMOTE_OUTCOME_AMBIGUOUS
    blocked = SQLiteJobRepository(database).get(submitted.id)
    assert blocked is not None
    assert blocked.status is JobStatus.BLOCKED
    assert blocked.blocked_reason is BlockedReason.REMOTE_OUTCOME_AMBIGUOUS

    recovering.resolve_ambiguous_operation(
        submitted.id,
        operation.idempotency_key,
        external_id=remote_workspace.external_id,
    )
    result = asyncio.run(recovering.run(submitted.id, worker_id="worker-after-resolution"))

    assert result.job.status is JobStatus.COMPLETED
    assert result.workspace.external_id == remote_workspace.external_id
    assert service.workspace_write_count == 1
    assert service.source_write_count == 2
    resolved = SQLiteRemoteOperationRepository(database).get_by_idempotency_key(
        operation.idempotency_key
    )
    assert resolved is not None and resolved.status is RemoteOperationStatus.RECONCILED


def test_manual_confirmed_absence_allows_redispatch_but_not_blind_recreation(tmp_path) -> None:
    root = tmp_path / "manual-absence"
    root.mkdir()
    clock = MutableClock()
    service = FakeKnowledgeService.create()
    crash = CrashOnce(WorkflowCheckpoint.AFTER_OPERATION_DISPATCHED)
    crashing, database = make_runtime(root, service, clock, hook=crash, create=True)
    submitted = crashing.submit(make_import_command(root, part_count=1))

    with pytest.raises(InjectedCrash):
        asyncio.run(crashing.run(submitted.id, worker_id="worker-before-crash"))

    operation = next(iter(SQLiteRemoteOperationRepository(database).list_for_job(submitted.id)))
    service.ambiguous_operations.add(operation.idempotency_key)
    clock.advance(timedelta(seconds=6))
    recovering, _ = make_runtime(root, service, clock)
    with pytest.raises(DiandianError) as raised:
        asyncio.run(recovering.run(submitted.id, worker_id="worker-probing"))
    assert raised.value.code is ErrorCode.REMOTE_OUTCOME_AMBIGUOUS
    assert service.workspace_write_count == 0

    service.ambiguous_operations.remove(operation.idempotency_key)
    recovering.resolve_ambiguous_operation(
        submitted.id,
        operation.idempotency_key,
        confirmed_absent=True,
    )
    result = asyncio.run(recovering.run(submitted.id, worker_id="worker-after-resolution"))

    assert result.job.status is JobStatus.COMPLETED
    assert service.workspace_write_count == 1
    resolved = SQLiteRemoteOperationRepository(database).get_by_idempotency_key(
        operation.idempotency_key
    )
    assert resolved is not None
    assert resolved.status is RemoteOperationStatus.SUCCEEDED
    assert resolved.dispatch_attempt == 2


def test_cancellation_waits_for_ambiguous_outcome_then_finishes_after_resolution(tmp_path) -> None:
    root = tmp_path / "cancel-ambiguous"
    root.mkdir()
    clock = MutableClock()
    service = FakeKnowledgeService.create()
    crash = CrashOnce(WorkflowCheckpoint.AFTER_PROVIDER_COMMIT)
    crashing, database = make_runtime(root, service, clock, hook=crash, create=True)
    submitted = crashing.submit(make_import_command(root, part_count=1))

    with pytest.raises(InjectedCrash):
        asyncio.run(crashing.run(submitted.id, worker_id="worker-before-crash"))

    operation = next(iter(SQLiteRemoteOperationRepository(database).list_for_job(submitted.id)))
    remote_workspace = service.workspace_operations[operation.idempotency_key]
    service.ambiguous_operations.add(operation.idempotency_key)
    clock.advance(timedelta(seconds=6))
    recovering, _ = make_runtime(root, service, clock)
    with pytest.raises(DiandianError):
        asyncio.run(recovering.run(submitted.id, worker_id="worker-probing"))

    cancellation_requested = recovering.request_cancel(submitted.id)
    assert cancellation_requested.status is JobStatus.BLOCKED
    assert cancellation_requested.cancel_requested_at is not None

    cancelled = recovering.resolve_ambiguous_operation(
        submitted.id,
        operation.idempotency_key,
        external_id=remote_workspace.external_id,
    )

    assert cancelled.status is JobStatus.CANCELLED
    assert cancelled.cancel_requested_at is not None
    assert service.workspace_write_count == 1
    resolved = SQLiteRemoteOperationRepository(database).get_by_idempotency_key(
        operation.idempotency_key
    )
    assert resolved is not None and resolved.status is RemoteOperationStatus.RECONCILED
    with pytest.raises(DiandianError):
        asyncio.run(recovering.run(submitted.id, worker_id="worker-must-not-run"))
