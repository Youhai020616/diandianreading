"""Recoverable persistent Job, lease, and step state machines."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import UTC, datetime
from enum import StrEnum

from diandianreading.domain.errors import ErrorCode, InvalidStateTransition


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    BLOCKED = "blocked"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class JobStep(StrEnum):
    ACQUIRING = "acquiring"
    STORING = "storing"
    PREPARING = "preparing"
    CREATING_WORKSPACE = "creating_workspace"
    UPLOADING = "uploading"
    PROCESSING = "processing"
    VERIFYING = "verifying"


class BlockedReason(StrEnum):
    AUTH_REQUIRED = "AUTH_REQUIRED"
    REMOTE_OUTCOME_AMBIGUOUS = "REMOTE_OUTCOME_AMBIGUOUS"


class JobStepStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    BLOCKED = "blocked"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    SKIPPED = "skipped"


_NEXT_STEP: dict[JobStep | None, JobStep] = {
    None: JobStep.ACQUIRING,
    JobStep.ACQUIRING: JobStep.STORING,
    JobStep.STORING: JobStep.PREPARING,
    JobStep.PREPARING: JobStep.CREATING_WORKSPACE,
    JobStep.CREATING_WORKSPACE: JobStep.UPLOADING,
    JobStep.UPLOADING: JobStep.PROCESSING,
    JobStep.PROCESSING: JobStep.VERIFYING,
}
_TERMINAL_STATUSES = frozenset({JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED})


def _utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True, slots=True)
class LeaseToken:
    owner: str
    generation: int

    def __post_init__(self) -> None:
        if not self.owner.strip():
            raise ValueError("Lease owner cannot be empty")
        if self.generation <= 0:
            raise ValueError("Lease generation must be positive")


@dataclass(frozen=True, slots=True)
class Job:
    id: str
    job_type: str
    input_hash: str
    status: JobStatus
    current_step: JobStep | None
    attempt: int
    progress_current: int | None
    progress_total: int | None
    last_error_code: ErrorCode | None
    last_error_detail_redacted: str | None
    retriable: bool | None
    blocked_reason: BlockedReason | None
    cancel_requested_at: datetime | None
    lease_owner: str | None
    lease_expires_at: datetime | None
    lease_generation: int
    not_before: datetime | None
    book_id: str | None
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None
    completed_at: datetime | None
    version: int

    def __post_init__(self) -> None:
        if not self.id or not self.job_type or not self.input_hash:
            raise ValueError("Job identity, type, and input hash are required")
        if self.attempt < 1 or self.version < 0 or self.lease_generation < 0:
            raise ValueError("Job counters cannot be negative and attempt starts at one")
        if (self.progress_current is None) != (self.progress_total is None):
            raise ValueError("Job progress current and total must be set together")
        if self.progress_total is not None and (
            self.progress_total <= 0
            or self.progress_current is None
            or self.progress_current < 0
            or self.progress_current > self.progress_total
        ):
            raise ValueError("Job progress must satisfy 0 <= current <= total and total > 0")
        if (self.status is JobStatus.BLOCKED) != (self.blocked_reason is not None):
            raise ValueError("blocked_reason must be present only for a blocked Job")
        has_lease = self.lease_owner is not None or self.lease_expires_at is not None
        if self.status is JobStatus.RUNNING:
            if not self.lease_owner or self.lease_expires_at is None or self.lease_generation <= 0:
                raise ValueError("A running Job requires an owner, expiry, and fencing generation")
        elif has_lease:
            raise ValueError("Only a running Job may hold a Lease")
        if self.status in _TERMINAL_STATUSES:
            if self.completed_at is None:
                raise ValueError("A terminal Job requires completed_at")
        elif self.completed_at is not None:
            raise ValueError("A non-terminal Job cannot have completed_at")
        if self.status is JobStatus.FAILED and self.retriable is None:
            raise ValueError("A failed Job must record whether it is retriable")

    @classmethod
    def create(
        cls,
        *,
        job_id: str,
        job_type: str,
        input_hash: str,
        book_id: str | None = None,
        now: datetime | None = None,
    ) -> Job:
        timestamp = now or _utc_now()
        return cls(
            id=job_id,
            job_type=job_type,
            input_hash=input_hash,
            status=JobStatus.QUEUED,
            current_step=None,
            attempt=1,
            progress_current=None,
            progress_total=None,
            last_error_code=None,
            last_error_detail_redacted=None,
            retriable=None,
            blocked_reason=None,
            cancel_requested_at=None,
            lease_owner=None,
            lease_expires_at=None,
            lease_generation=0,
            not_before=None,
            book_id=book_id,
            created_at=timestamp,
            updated_at=timestamp,
            started_at=None,
            completed_at=None,
            version=0,
        )

    @property
    def is_terminal(self) -> bool:
        return self.status in _TERMINAL_STATUSES

    @property
    def is_cancel_requested(self) -> bool:
        return self.cancel_requested_at is not None

    @property
    def lease_token(self) -> LeaseToken:
        if self.status is not JobStatus.RUNNING or self.lease_owner is None:
            raise InvalidStateTransition("Only a running Job has a Lease token")
        return LeaseToken(self.lease_owner, self.lease_generation)

    def claim(
        self,
        owner: str,
        *,
        lease_expires_at: datetime,
        now: datetime | None = None,
    ) -> Job:
        timestamp = now or _utc_now()
        if self.status is not JobStatus.QUEUED:
            raise InvalidStateTransition("Only a queued Job can be claimed")
        if self.cancel_requested_at is not None:
            raise InvalidStateTransition("A cancellation-requested Job cannot be claimed")
        if self.not_before is not None and self.not_before > timestamp:
            raise InvalidStateTransition("Job retry delay has not elapsed")
        _validate_new_lease(owner, lease_expires_at, timestamp)
        return replace(
            self,
            status=JobStatus.RUNNING,
            lease_owner=owner,
            lease_expires_at=lease_expires_at,
            lease_generation=self.lease_generation + 1,
            not_before=None,
            started_at=self.started_at or timestamp,
            updated_at=timestamp,
            version=self.version + 1,
        )

    def take_over_expired_lease(
        self,
        owner: str,
        *,
        lease_expires_at: datetime,
        now: datetime | None = None,
    ) -> Job:
        timestamp = now or _utc_now()
        if self.status is not JobStatus.RUNNING or self.lease_expires_at is None:
            raise InvalidStateTransition("Only a running Job Lease can be taken over")
        if self.lease_expires_at > timestamp:
            raise InvalidStateTransition("An unexpired Job Lease cannot be taken over")
        _validate_new_lease(owner, lease_expires_at, timestamp)
        return replace(
            self,
            lease_owner=owner,
            lease_expires_at=lease_expires_at,
            lease_generation=self.lease_generation + 1,
            updated_at=timestamp,
            version=self.version + 1,
        )

    def heartbeat(
        self,
        token: LeaseToken,
        *,
        lease_expires_at: datetime,
        now: datetime | None = None,
    ) -> Job:
        timestamp = now or _utc_now()
        self.assert_lease(token)
        _validate_new_lease(token.owner, lease_expires_at, timestamp)
        return replace(
            self,
            lease_expires_at=lease_expires_at,
            updated_at=timestamp,
            version=self.version + 1,
        )

    def begin_step(
        self,
        step: JobStep,
        token: LeaseToken,
        *,
        now: datetime | None = None,
    ) -> Job:
        self.assert_lease(token)
        expected = _NEXT_STEP.get(self.current_step)
        if expected is not step:
            expected_value = expected.value if expected is not None else "none"
            current_value = self.current_step.value if self.current_step is not None else "none"
            raise InvalidStateTransition(
                f"Job must advance from {current_value} to {expected_value}, not {step.value}"
            )
        return replace(
            self,
            current_step=step,
            progress_current=None,
            progress_total=None,
            last_error_code=None,
            last_error_detail_redacted=None,
            retriable=None,
            updated_at=now or _utc_now(),
            version=self.version + 1,
        )

    def attach_book(
        self,
        book_id: str,
        token: LeaseToken,
        *,
        now: datetime | None = None,
    ) -> Job:
        """Attach the Book created by a running durable import exactly once."""

        self.assert_lease(token)
        if self.current_step not in {JobStep.ACQUIRING, JobStep.STORING}:
            raise InvalidStateTransition(
                "A Book can be attached only while an import is acquiring or storing"
            )
        if self.book_id is not None:
            raise InvalidStateTransition("A Job Book binding is immutable once attached")
        if not book_id.strip():
            raise ValueError("Attached Book ID cannot be empty")
        return replace(
            self,
            book_id=book_id,
            updated_at=now or _utc_now(),
            version=self.version + 1,
        )

    def report_progress(
        self,
        current: int,
        total: int,
        token: LeaseToken,
        *,
        now: datetime | None = None,
    ) -> Job:
        self.assert_lease(token)
        if total <= 0 or current < 0 or current > total:
            raise ValueError("Progress must satisfy 0 <= current <= total and total > 0")
        return replace(
            self,
            progress_current=current,
            progress_total=total,
            updated_at=now or _utc_now(),
            version=self.version + 1,
        )

    def request_cancellation(self, *, now: datetime | None = None) -> Job:
        if self.status is JobStatus.CANCELLED:
            return self
        if self.is_terminal:
            raise InvalidStateTransition("Cannot request cancellation for a terminal Job")
        if self.cancel_requested_at is not None:
            return self
        timestamp = now or _utc_now()
        return replace(
            self,
            cancel_requested_at=timestamp,
            updated_at=timestamp,
            version=self.version + 1,
        )

    def block(
        self,
        reason: BlockedReason,
        code: ErrorCode,
        detail_redacted: str,
        token: LeaseToken,
        *,
        now: datetime | None = None,
    ) -> Job:
        self.assert_lease(token)
        timestamp = now or _utc_now()
        return replace(
            self,
            status=JobStatus.BLOCKED,
            blocked_reason=reason,
            last_error_code=code,
            last_error_detail_redacted=detail_redacted,
            retriable=False,
            lease_owner=None,
            lease_expires_at=None,
            updated_at=timestamp,
            version=self.version + 1,
        )

    def queue_retry(
        self,
        code: ErrorCode,
        detail_redacted: str,
        token: LeaseToken,
        *,
        not_before: datetime,
        now: datetime | None = None,
    ) -> Job:
        self.assert_lease(token)
        timestamp = now or _utc_now()
        if not_before < timestamp:
            raise ValueError("Retry not_before cannot be in the past")
        return replace(
            self,
            status=JobStatus.QUEUED,
            attempt=self.attempt + 1,
            last_error_code=code,
            last_error_detail_redacted=detail_redacted,
            retriable=True,
            blocked_reason=None,
            lease_owner=None,
            lease_expires_at=None,
            not_before=not_before,
            updated_at=timestamp,
            version=self.version + 1,
        )

    def fail(
        self,
        code: ErrorCode,
        detail_redacted: str,
        token: LeaseToken,
        *,
        retriable: bool,
        now: datetime | None = None,
    ) -> Job:
        self.assert_lease(token)
        timestamp = now or _utc_now()
        return replace(
            self,
            status=JobStatus.FAILED,
            last_error_code=code,
            last_error_detail_redacted=detail_redacted,
            retriable=retriable,
            blocked_reason=None,
            lease_owner=None,
            lease_expires_at=None,
            completed_at=timestamp,
            updated_at=timestamp,
            version=self.version + 1,
        )

    def resume(self, reason: BlockedReason, *, now: datetime | None = None) -> Job:
        if self.status is not JobStatus.BLOCKED or self.blocked_reason is not reason:
            raise InvalidStateTransition("Only a matching blocked Job can resume")
        return replace(
            self,
            status=JobStatus.QUEUED,
            attempt=self.attempt + 1,
            blocked_reason=None,
            last_error_code=None,
            last_error_detail_redacted=None,
            retriable=None,
            updated_at=now or _utc_now(),
            version=self.version + 1,
        )

    def retry(self, *, now: datetime | None = None) -> Job:
        if self.status is not JobStatus.FAILED:
            raise InvalidStateTransition("Only a failed Job can be explicitly retried")
        return replace(
            self,
            status=JobStatus.QUEUED,
            attempt=self.attempt + 1,
            last_error_code=None,
            last_error_detail_redacted=None,
            retriable=None,
            completed_at=None,
            updated_at=now or _utc_now(),
            version=self.version + 1,
        )

    def cancel(self, *, token: LeaseToken | None = None, now: datetime | None = None) -> Job:
        if self.is_terminal:
            raise InvalidStateTransition("Cannot cancel a terminal Job")
        if self.cancel_requested_at is None:
            raise InvalidStateTransition("Job cancellation must be requested first")
        if self.status is JobStatus.RUNNING:
            if token is None:
                raise InvalidStateTransition("Cancelling a running Job requires its Lease")
            self.assert_lease(token)
        timestamp = now or _utc_now()
        return replace(
            self,
            status=JobStatus.CANCELLED,
            last_error_code=ErrorCode.CANCELLED,
            last_error_detail_redacted="Job cancelled",
            retriable=False,
            blocked_reason=None,
            lease_owner=None,
            lease_expires_at=None,
            completed_at=timestamp,
            updated_at=timestamp,
            version=self.version + 1,
        )

    def complete(self, token: LeaseToken, *, now: datetime | None = None) -> Job:
        self.assert_lease(token)
        if self.current_step is not JobStep.VERIFYING:
            raise InvalidStateTransition("A Job can complete only after verifying")
        if self.cancel_requested_at is not None:
            raise InvalidStateTransition("A cancellation-requested Job cannot complete")
        timestamp = now or _utc_now()
        return replace(
            self,
            status=JobStatus.COMPLETED,
            progress_current=None,
            progress_total=None,
            last_error_code=None,
            last_error_detail_redacted=None,
            retriable=None,
            lease_owner=None,
            lease_expires_at=None,
            completed_at=timestamp,
            updated_at=timestamp,
            version=self.version + 1,
        )

    def assert_lease(self, token: LeaseToken) -> None:
        if (
            self.status is not JobStatus.RUNNING
            or self.lease_owner != token.owner
            or self.lease_generation != token.generation
        ):
            raise InvalidStateTransition("Job Lease owner or generation is stale")


@dataclass(frozen=True, slots=True)
class JobEvent:
    job_id: str
    from_status: JobStatus | None
    to_status: JobStatus
    current_step: JobStep | None
    attempt: int
    progress_current: int | None
    progress_total: int | None
    blocked_reason: BlockedReason | None
    cancel_requested_at: datetime | None
    lease_owner: str | None
    lease_expires_at: datetime | None
    lease_generation: int
    error_code: ErrorCode | None
    error_detail_redacted: str | None
    retriable: bool | None
    version: int
    created_at: datetime


@dataclass(frozen=True, slots=True)
class JobStepRecord:
    job_id: str
    step: JobStep
    attempt: int
    status: JobStepStatus
    input_hash: str
    output_ref: str | None
    progress_current: int | None
    progress_total: int | None
    error_code: ErrorCode | None
    error_detail_redacted: str | None
    started_at: datetime | None
    completed_at: datetime | None
    version: int

    def __post_init__(self) -> None:
        if not self.job_id or not self.input_hash or self.attempt < 1 or self.version < 0:
            raise ValueError("Job Step identity, input hash, and counters are invalid")
        if (self.progress_current is None) != (self.progress_total is None):
            raise ValueError("Job Step progress current and total must be set together")
        if self.status is JobStepStatus.RUNNING and self.started_at is None:
            raise ValueError("A running Job Step requires started_at")
        if (
            self.status
            in {
                JobStepStatus.COMPLETED,
                JobStepStatus.FAILED,
                JobStepStatus.CANCELLED,
                JobStepStatus.SKIPPED,
            }
            and self.completed_at is None
        ):
            raise ValueError("A terminal Job Step requires completed_at")

    @classmethod
    def start(
        cls,
        *,
        job_id: str,
        step: JobStep,
        attempt: int,
        input_hash: str,
        now: datetime | None = None,
    ) -> JobStepRecord:
        timestamp = now or _utc_now()
        return cls(
            job_id=job_id,
            step=step,
            attempt=attempt,
            status=JobStepStatus.RUNNING,
            input_hash=input_hash,
            output_ref=None,
            progress_current=None,
            progress_total=None,
            error_code=None,
            error_detail_redacted=None,
            started_at=timestamp,
            completed_at=None,
            version=0,
        )

    def complete(self, output_ref: str, *, now: datetime | None = None) -> JobStepRecord:
        if self.status is not JobStepStatus.RUNNING:
            raise InvalidStateTransition("Only a running Job Step can complete")
        if not output_ref:
            raise ValueError("A completed Job Step requires an output reference")
        return replace(
            self,
            status=JobStepStatus.COMPLETED,
            output_ref=output_ref,
            completed_at=now or _utc_now(),
            version=self.version + 1,
        )

    def report_progress(self, current: int, total: int) -> JobStepRecord:
        if self.status is not JobStepStatus.RUNNING:
            raise InvalidStateTransition("Only a running Job Step can report progress")
        if total <= 0 or current < 0 or current > total:
            raise ValueError("Step progress must satisfy 0 <= current <= total and total > 0")
        return replace(
            self,
            progress_current=current,
            progress_total=total,
            version=self.version + 1,
        )

    def block(
        self,
        code: ErrorCode,
        detail_redacted: str,
        *,
        now: datetime | None = None,
    ) -> JobStepRecord:
        if self.status is not JobStepStatus.RUNNING:
            raise InvalidStateTransition("Only a running Job Step can block")
        return replace(
            self,
            status=JobStepStatus.BLOCKED,
            error_code=code,
            error_detail_redacted=detail_redacted,
            version=self.version + 1,
        )

    def cancel(self, *, now: datetime | None = None) -> JobStepRecord:
        if self.status not in {JobStepStatus.RUNNING, JobStepStatus.BLOCKED}:
            raise InvalidStateTransition("Only an active Job Step can be cancelled")
        timestamp = now or _utc_now()
        return replace(
            self,
            status=JobStepStatus.CANCELLED,
            error_code=ErrorCode.CANCELLED,
            error_detail_redacted="Job cancelled",
            completed_at=timestamp,
            version=self.version + 1,
        )

    def fail(
        self,
        code: ErrorCode,
        detail_redacted: str,
        *,
        now: datetime | None = None,
    ) -> JobStepRecord:
        if self.status not in {JobStepStatus.RUNNING, JobStepStatus.BLOCKED}:
            raise InvalidStateTransition("Only an active Job Step can fail")
        timestamp = now or _utc_now()
        return replace(
            self,
            status=JobStepStatus.FAILED,
            error_code=code,
            error_detail_redacted=detail_redacted,
            completed_at=timestamp,
            version=self.version + 1,
        )


@dataclass(frozen=True, slots=True)
class JobPayload:
    job_id: str
    payload_type: str
    payload_json: str
    input_hash: str
    created_at: datetime

    def __post_init__(self) -> None:
        if not self.job_id or not self.payload_type or not self.payload_json or not self.input_hash:
            raise ValueError("Job payload fields are required")


def _validate_new_lease(owner: str, expires_at: datetime, now: datetime) -> None:
    if not owner.strip():
        raise ValueError("Lease owner cannot be empty")
    if expires_at <= now:
        raise ValueError("Lease expiry must be in the future")
