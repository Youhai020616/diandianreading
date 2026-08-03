"""Browser-free Phase 3 E2E for lease-fenced workflow recovery."""

from __future__ import annotations

import hashlib
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from diandianreading.application.use_cases import (
    ImportBookCommand,
    ImportBookUseCase,
    WorkflowCheckpoint,
    WorkflowCheckpointHook,
)
from diandianreading.domain import (
    BlockedReason,
    CredentialRef,
    DiandianError,
    DocumentAsset,
    DocumentPart,
    ErrorCode,
    JobStatus,
    JobStep,
    RemoteOperation,
    RemoteOperationKind,
    RemoteOperationStatus,
    SourceOrigin,
    StorageKey,
    UnsafePathError,
    utc_now,
)
from diandianreading.infrastructure.fakes import FakeKnowledgeAdapter, FakeKnowledgeService
from diandianreading.infrastructure.persistence import (
    SQLiteDatabase,
    SQLiteJobRepository,
    SQLiteRemoteOperationRepository,
    SQLiteUnitOfWorkFactory,
)


class _InjectedCrash(BaseException):
    """Represent process death without entering application exception handlers."""


@dataclass(slots=True)
class _MutableClock:
    current: datetime

    def __call__(self) -> datetime:
        return self.current

    def advance(self, delta: timedelta) -> None:
        self.current += delta


@dataclass(frozen=True, slots=True)
class _CrashCase:
    name: str
    checkpoint: WorkflowCheckpoint
    occurrence: int = 1
    key: str | None = None


@dataclass(slots=True)
class _CrashOnce:
    case: _CrashCase
    seen: int = 0
    crashed: bool = False

    def __call__(
        self,
        checkpoint: WorkflowCheckpoint,
        job_id: str,
        key: str | None,
    ) -> None:
        del job_id
        if self.crashed or checkpoint is not self.case.checkpoint:
            return
        if self.case.key is not None and key != self.case.key:
            return
        self.seen += 1
        if self.seen == self.case.occurrence:
            self.crashed = True
            raise _InjectedCrash(f"Injected crash at {checkpoint.value}:{key or '-'}")


_CRASH_CASES = (
    _CrashCase("local-step-started", WorkflowCheckpoint.AFTER_STEP_STARTED),
    _CrashCase(
        "local-step-checkpointed",
        WorkflowCheckpoint.AFTER_STEP_CHECKPOINT,
        key=JobStep.ACQUIRING.value,
    ),
    _CrashCase("workspace-intent-prepared", WorkflowCheckpoint.AFTER_INTENT_PREPARED),
    _CrashCase("workspace-dispatched", WorkflowCheckpoint.AFTER_OPERATION_DISPATCHED),
    _CrashCase("workspace-provider-committed", WorkflowCheckpoint.AFTER_PROVIDER_COMMIT),
    _CrashCase(
        "workspace-step-checkpointed",
        WorkflowCheckpoint.AFTER_STEP_CHECKPOINT,
        key=JobStep.CREATING_WORKSPACE.value,
    ),
    _CrashCase(
        "source-intent-prepared",
        WorkflowCheckpoint.AFTER_INTENT_PREPARED,
        occurrence=2,
    ),
    _CrashCase(
        "source-dispatched",
        WorkflowCheckpoint.AFTER_OPERATION_DISPATCHED,
        occurrence=2,
    ),
    _CrashCase(
        "source-provider-committed",
        WorkflowCheckpoint.AFTER_PROVIDER_COMMIT,
        occurrence=2,
    ),
    _CrashCase(
        "partial-sources-checkpointed",
        WorkflowCheckpoint.AFTER_SOURCE_CHECKPOINT,
        occurrence=2,
    ),
    _CrashCase("source-wait-in-flight", WorkflowCheckpoint.SOURCE_WAIT_IN_FLIGHT),
)


async def run_phase3_demo(database_path: Path, workspace_path: Path) -> dict[str, object]:
    """Prove crash recovery, ambiguity, auth resume, cancellation, and fencing locally."""

    database_path = _absolute_path(database_path)
    workspace_path = _absolute_path(workspace_path)
    _require_disjoint_new_paths(database_path, workspace_path)
    database = SQLiteDatabase.create_new(database_path)
    schema_version = database.migrate()
    workspace_path.mkdir(mode=0o700, parents=True, exist_ok=False)
    if os.name != "nt":
        workspace_path.chmod(0o700)

    clock = _MutableClock(utc_now())
    service = FakeKnowledgeService.create()
    completed_jobs: list[str] = []

    for index, case in enumerate(_CRASH_CASES, start=1):
        crash = _CrashOnce(case)
        crashing = _use_case(
            database,
            service,
            clock,
            ids=(f"book-crash-{index}", f"job-crash-{index}"),
            hook=crash,
        )
        command = _make_command(f"crash-{index}", part_count=3)
        submitted = crashing.submit(command)
        try:
            await crashing.run(submitted.id, worker_id=f"worker-before-crash-{index}")
        except _InjectedCrash:
            pass
        else:
            raise RuntimeError(f"Phase 3 E2E failed: {case.name} did not inject a crash")
        stranded = SQLiteJobRepository(database).get(submitted.id)
        if (
            not crash.crashed
            or stranded is None
            or stranded.status is not JobStatus.RUNNING
            or stranded.lease_generation != 1
        ):
            raise RuntimeError(f"Phase 3 E2E failed: {case.name} did not preserve the Lease")

        clock.advance(timedelta(seconds=6))
        reopened = SQLiteDatabase(database.path)
        recovered = _use_case(reopened, service, clock)
        result = await recovered.run(
            submitted.id,
            worker_id=f"worker-after-crash-{index}",
        )
        if result.job.status is not JobStatus.COMPLETED or result.job.lease_generation != 2:
            raise RuntimeError(f"Phase 3 E2E failed: {case.name} did not recover by takeover")
        completed_jobs.append(result.job.id)

    service.healthy = False
    auth_use_case = _use_case(
        database,
        service,
        clock,
        ids=("book-auth", "job-auth"),
    )
    auth_job = auth_use_case.submit(_make_command("auth", part_count=1))
    await _expect_error(
        auth_use_case.run(auth_job.id, worker_id="worker-auth-blocked"),
        ErrorCode.AUTH_REQUIRED,
        "authentication block",
    )
    blocked_auth = SQLiteJobRepository(database).get(auth_job.id)
    if (
        blocked_auth is None
        or blocked_auth.status is not JobStatus.BLOCKED
        or blocked_auth.blocked_reason is not BlockedReason.AUTH_REQUIRED
    ):
        raise RuntimeError("Phase 3 E2E failed: authentication did not block the Job")
    service.healthy = True
    await auth_use_case.resume_after_auth(auth_job.id)
    auth_result = await auth_use_case.run(auth_job.id, worker_id="worker-auth-resumed")
    if auth_result.job.status is not JobStatus.COMPLETED or auth_result.job.attempt != 2:
        raise RuntimeError("Phase 3 E2E failed: authentication resume did not complete")
    completed_jobs.append(auth_result.job.id)

    ambiguous_case = _CrashCase(
        "manual-ambiguous",
        WorkflowCheckpoint.AFTER_PROVIDER_COMMIT,
    )
    ambiguous_crash = _CrashOnce(ambiguous_case)
    ambiguous_use_case = _use_case(
        database,
        service,
        clock,
        ids=("book-ambiguous", "job-ambiguous"),
        hook=ambiguous_crash,
    )
    ambiguous_job = ambiguous_use_case.submit(_make_command("ambiguous", part_count=1))
    try:
        await ambiguous_use_case.run(
            ambiguous_job.id,
            worker_id="worker-ambiguous-crash",
        )
    except _InjectedCrash:
        pass
    else:
        raise RuntimeError("Phase 3 E2E failed: ambiguous provider commit did not crash")
    workspace_operation = _workspace_operation(database, ambiguous_job.id)
    remote_workspace = service.workspace_operations[workspace_operation.idempotency_key]
    service.ambiguous_operations.add(workspace_operation.idempotency_key)
    clock.advance(timedelta(seconds=6))
    ambiguity_recovery = _use_case(SQLiteDatabase(database.path), service, clock)
    await _expect_error(
        ambiguity_recovery.run(
            ambiguous_job.id,
            worker_id="worker-ambiguous-probe",
        ),
        ErrorCode.REMOTE_OUTCOME_AMBIGUOUS,
        "ambiguous reconciliation",
    )
    blocked_ambiguous = SQLiteJobRepository(database).get(ambiguous_job.id)
    if (
        blocked_ambiguous is None
        or blocked_ambiguous.status is not JobStatus.BLOCKED
        or blocked_ambiguous.blocked_reason is not BlockedReason.REMOTE_OUTCOME_AMBIGUOUS
    ):
        raise RuntimeError("Phase 3 E2E failed: ambiguous outcome did not block the Job")
    ambiguity_recovery.resolve_ambiguous_operation(
        ambiguous_job.id,
        workspace_operation.idempotency_key,
        external_id=remote_workspace.external_id,
    )
    ambiguous_result = await ambiguity_recovery.run(
        ambiguous_job.id,
        worker_id="worker-ambiguous-resolved",
    )
    if ambiguous_result.job.status is not JobStatus.COMPLETED:
        raise RuntimeError("Phase 3 E2E failed: manual ambiguity resolution did not complete")
    completed_jobs.append(ambiguous_result.job.id)

    cancelling_use_case: ImportBookUseCase | None = None
    cancellation_requested = False

    def cancel_after_intent(
        checkpoint: WorkflowCheckpoint,
        job_id: str,
        key: str | None,
    ) -> None:
        nonlocal cancellation_requested
        del key
        if checkpoint is WorkflowCheckpoint.AFTER_INTENT_PREPARED and not cancellation_requested:
            cancellation_requested = True
            if cancelling_use_case is None:
                raise RuntimeError("Phase 3 E2E cancellation Use Case was not initialized")
            cancelling_use_case.request_cancel(job_id)

    cancelling_use_case = _use_case(
        database,
        service,
        clock,
        ids=("book-cancelled", "job-cancelled"),
        hook=cancel_after_intent,
    )
    cancelled_job = cancelling_use_case.submit(_make_command("cancelled", part_count=1))
    await _expect_error(
        cancelling_use_case.run(cancelled_job.id, worker_id="worker-cancelled"),
        ErrorCode.CANCELLED,
        "safe cancellation",
    )
    persisted_cancelled = SQLiteJobRepository(database).get(cancelled_job.id)
    if persisted_cancelled is None or persisted_cancelled.status is not JobStatus.CANCELLED:
        raise RuntimeError("Phase 3 E2E failed: prepared operation cancellation was not terminal")

    operations = SQLiteRemoteOperationRepository(database).list_for_job(cancelled_job.id)
    if len(operations) != 1 or operations[0].status is not (
        RemoteOperationStatus.CANCELLED_BEFORE_DISPATCH
    ):
        raise RuntimeError("Phase 3 E2E failed: cancelled intent was not resolved safely")

    with database.connect() as connection:
        job_rows = connection.execute(
            "SELECT status, lease_generation FROM jobs ORDER BY id"
        ).fetchall()
        operation_rows = connection.execute(
            "SELECT status, dispatch_attempt FROM remote_operations ORDER BY id"
        ).fetchall()
        event_count_row = connection.execute("SELECT COUNT(*) FROM job_events").fetchone()
        step_count_row = connection.execute("SELECT COUNT(*) FROM job_steps").fetchone()
        source_count_row = connection.execute("SELECT COUNT(*) FROM external_sources").fetchone()
        book_count_row = connection.execute("SELECT COUNT(*) FROM books").fetchone()

    expected_completed = len(_CRASH_CASES) + 2
    expected_workspace_writes = expected_completed
    expected_source_writes = len(_CRASH_CASES) * 3 + 2
    expected_operation_count = (
        len(_CRASH_CASES) * 4
        + 2  # auth workspace + source
        + 2  # ambiguous workspace + source
        + 1  # cancelled prepared workspace
    )
    completed_count = sum(str(row["status"]) == JobStatus.COMPLETED.value for row in job_rows)
    cancelled_count = sum(str(row["status"]) == JobStatus.CANCELLED.value for row in job_rows)
    unresolved_count = sum(
        str(row["status"])
        in {
            RemoteOperationStatus.PREPARED.value,
            RemoteOperationStatus.DISPATCHED.value,
            RemoteOperationStatus.AMBIGUOUS.value,
        }
        for row in operation_rows
    )
    reconciled_count = sum(
        str(row["status"]) == RemoteOperationStatus.RECONCILED.value for row in operation_rows
    )
    lease_generation_two_or_more = sum(int(row["lease_generation"]) >= 2 for row in job_rows)

    if completed_count != expected_completed or cancelled_count != 1:
        raise RuntimeError("Phase 3 E2E failed: final Job lifecycle counts are inconsistent")
    if len(completed_jobs) != expected_completed or unresolved_count != 0:
        raise RuntimeError("Phase 3 E2E failed: recovered Jobs left unresolved operations")
    if len(operation_rows) != expected_operation_count:
        raise RuntimeError("Phase 3 E2E failed: remote operation count is inconsistent")
    if (
        service.workspace_write_count != expected_workspace_writes
        or service.source_write_count != expected_source_writes
    ):
        raise RuntimeError("Phase 3 E2E failed: provider writes were duplicated or omitted")
    if source_count_row is None or int(source_count_row[0]) != expected_source_writes:
        raise RuntimeError("Phase 3 E2E failed: source checkpoints are incomplete")
    if not database.integrity_check():
        raise RuntimeError("Phase 3 E2E failed: SQLite integrity check failed")

    return {
        "status": "ok",
        "schema_version": schema_version,
        "crash_boundary_count": len(_CRASH_CASES),
        "completed_job_count": completed_count,
        "cancelled_job_count": cancelled_count,
        "auth_resume_count": 1,
        "manual_ambiguity_resolution_count": 1,
        "lease_generation_two_or_more_count": lease_generation_two_or_more,
        "book_count": int(book_count_row[0]) if book_count_row is not None else 0,
        "source_count": int(source_count_row[0]),
        "remote_operation_count": len(operation_rows),
        "reconciled_operation_count": reconciled_count,
        "unresolved_operation_count": unresolved_count,
        "provider_workspace_write_count": service.workspace_write_count,
        "provider_source_write_count": service.source_write_count,
        "job_event_count": int(event_count_row[0]) if event_count_row is not None else 0,
        "job_step_count": int(step_count_row[0]) if step_count_row is not None else 0,
        "database": str(database.path),
    }


def _use_case(
    database: SQLiteDatabase,
    service: FakeKnowledgeService,
    clock: _MutableClock,
    *,
    ids: tuple[str, str] | None = None,
    hook: WorkflowCheckpointHook | None = None,
) -> ImportBookUseCase:
    id_factory = _id_factory(ids) if ids is not None else None
    return ImportBookUseCase(
        unit_of_work=SQLiteUnitOfWorkFactory(database),
        knowledge=FakeKnowledgeAdapter(service),
        id_factory=id_factory,
        clock=clock,
        lease_duration=timedelta(seconds=5),
        retry_delay=timedelta(0),
        checkpoint_hook=hook,
    )


def _id_factory(values: tuple[str, str]) -> Callable[[], str]:
    iterator = iter(values)

    def next_id() -> str:
        return next(iterator)

    return next_id


def _make_command(scope: str, *, part_count: int) -> ImportBookCommand:
    asset_id = f"asset-{scope}"
    asset_payload = f"Phase 3 asset {scope}".encode()
    asset = DocumentAsset(
        id=asset_id,
        storage_key=StorageKey(f"originals/{asset_id}"),
        display_filename=f"{scope}.md",
        mime_type="text/markdown",
        size_bytes=len(asset_payload),
        sha256=hashlib.sha256(asset_payload).hexdigest(),
        title=f"Phase 3 {scope}",
        author="diandianreading",
        origin=SourceOrigin.LOCAL,
        origin_locator=None,
        rights_provenance_id=f"rights-{scope}",
    )
    parts = tuple(_make_part(scope, asset_id, sequence) for sequence in range(part_count))
    return ImportBookCommand(
        title=asset.title or scope,
        author=asset.author,
        asset=asset,
        parts=parts,
        credential=CredentialRef("fake", "phase3-e2e"),
    )


def _make_part(scope: str, asset_id: str, sequence: int) -> DocumentPart:
    payload = f"Phase 3 {scope} part {sequence}".encode()
    return DocumentPart(
        id=f"part-{scope}-{sequence}",
        asset_id=asset_id,
        sequence=sequence,
        storage_key=StorageKey(f"parts/{asset_id}/{sequence:04d}"),
        mime_type="text/markdown",
        word_count=5,
        sha256=hashlib.sha256(payload).hexdigest(),
        chapter_refs=(f"chapter-{sequence + 1}",),
        size_bytes=len(payload),
    )


async def _expect_error(
    awaitable: Awaitable[object],
    code: ErrorCode,
    context: str,
) -> None:
    try:
        await awaitable
    except DiandianError as error:
        if error.code is not code:
            raise RuntimeError(
                f"Phase 3 E2E failed: {context} returned {error.code.value}, expected {code.value}"
            ) from error
        return
    raise RuntimeError(f"Phase 3 E2E failed: {context} did not return {code.value}")


def _workspace_operation(database: SQLiteDatabase, job_id: str) -> RemoteOperation:
    for operation in SQLiteRemoteOperationRepository(database).list_for_job(job_id):
        if operation.kind is RemoteOperationKind.ENSURE_WORKSPACE:
            return operation
    raise RuntimeError("Phase 3 E2E failed: workspace operation is missing")


def _absolute_path(path: Path) -> Path:
    return Path(os.path.abspath(path.expanduser()))


def _require_disjoint_new_paths(database: Path, workspace: Path) -> None:
    if database.exists() or database.is_symlink():
        raise FileExistsError(f"Database already exists: {database}")
    if workspace.exists() or workspace.is_symlink():
        raise FileExistsError(f"Refusing to overwrite existing Phase 3 workspace: {workspace}")
    if database == workspace or database in workspace.parents or workspace in database.parents:
        raise UnsafePathError("Phase 3 database and workspace must be disjoint")
