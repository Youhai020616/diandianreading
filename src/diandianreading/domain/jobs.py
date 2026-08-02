"""Persistent Job state machine."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from enum import StrEnum

from diandianreading.domain.errors import ErrorCode, InvalidStateTransition, is_retryable_error
from diandianreading.domain.models import utc_now


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    BLOCKED = "blocked"
    CANCELLATION_REQUESTED = "cancellation_requested"
    COMPLETED = "completed"
    FAILED_RETRYABLE = "failed_retryable"
    FAILED_TERMINAL = "failed_terminal"
    CANCELLED = "cancelled"


class JobStep(StrEnum):
    QUEUED = "queued"
    ACQUIRING = "acquiring"
    STORING = "storing"
    PREPARING = "preparing"
    CREATING_WORKSPACE = "creating_workspace"
    UPLOADING = "uploading"
    PROCESSING = "processing"
    VERIFYING = "verifying"
    COMPLETED = "completed"


_NEXT_STEP: dict[JobStep, JobStep] = {
    JobStep.QUEUED: JobStep.ACQUIRING,
    JobStep.ACQUIRING: JobStep.STORING,
    JobStep.STORING: JobStep.PREPARING,
    JobStep.PREPARING: JobStep.CREATING_WORKSPACE,
    JobStep.CREATING_WORKSPACE: JobStep.UPLOADING,
    JobStep.UPLOADING: JobStep.PROCESSING,
    JobStep.PROCESSING: JobStep.VERIFYING,
    JobStep.VERIFYING: JobStep.COMPLETED,
}

_TERMINAL_STATUSES = frozenset(
    {JobStatus.COMPLETED, JobStatus.FAILED_TERMINAL, JobStatus.CANCELLED}
)


@dataclass(frozen=True, slots=True)
class Job:
    id: str
    job_type: str
    input_hash: str
    status: JobStatus
    step: JobStep
    attempt: int
    progress_current: int | None
    progress_total: int | None
    error_code: ErrorCode | None
    error_message: str | None
    book_id: str | None
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None
    completed_at: datetime | None
    version: int

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
        timestamp = now or utc_now()
        return cls(
            id=job_id,
            job_type=job_type,
            input_hash=input_hash,
            status=JobStatus.QUEUED,
            step=JobStep.QUEUED,
            attempt=1,
            progress_current=None,
            progress_total=None,
            error_code=None,
            error_message=None,
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

    def advance(self, step: JobStep, *, now: datetime | None = None) -> Job:
        if self.is_terminal or self.status in {
            JobStatus.BLOCKED,
            JobStatus.CANCELLATION_REQUESTED,
            JobStatus.FAILED_RETRYABLE,
        }:
            raise InvalidStateTransition(
                f"Cannot advance job {self.id} from status {self.status.value}"
            )
        expected = _NEXT_STEP.get(self.step)
        if expected is not step:
            expected_value = expected.value if expected is not None else "none"
            raise InvalidStateTransition(
                f"Job {self.id} must advance from {self.step.value} to {expected_value}, "
                f"not {step.value}"
            )

        timestamp = now or utc_now()
        completed = step is JobStep.COMPLETED
        return replace(
            self,
            status=JobStatus.COMPLETED if completed else JobStatus.RUNNING,
            step=step,
            progress_current=None,
            progress_total=None,
            error_code=None,
            error_message=None,
            updated_at=timestamp,
            started_at=self.started_at or timestamp,
            completed_at=timestamp if completed else None,
            version=self.version + 1,
        )

    def report_progress(
        self,
        current: int,
        total: int,
        *,
        now: datetime | None = None,
    ) -> Job:
        if self.status is not JobStatus.RUNNING:
            raise InvalidStateTransition("Progress can only be reported for a running job")
        if total <= 0 or current < 0 or current > total:
            raise ValueError("Progress must satisfy 0 <= current <= total and total > 0")
        return replace(
            self,
            progress_current=current,
            progress_total=total,
            updated_at=now or utc_now(),
            version=self.version + 1,
        )

    def fail(
        self,
        code: ErrorCode,
        message: str,
        *,
        retryable: bool | None = None,
        now: datetime | None = None,
    ) -> Job:
        if self.is_terminal:
            raise InvalidStateTransition(f"Cannot fail terminal job {self.id}")
        timestamp = now or utc_now()
        if code is ErrorCode.AUTH_REQUIRED:
            status = JobStatus.BLOCKED
        else:
            can_retry = is_retryable_error(code) if retryable is None else retryable
            status = JobStatus.FAILED_RETRYABLE if can_retry else JobStatus.FAILED_TERMINAL
        return replace(
            self,
            status=status,
            error_code=code,
            error_message=message,
            updated_at=timestamp,
            completed_at=timestamp if status is JobStatus.FAILED_TERMINAL else None,
            version=self.version + 1,
        )

    def retry(self, *, now: datetime | None = None) -> Job:
        if self.status is not JobStatus.FAILED_RETRYABLE:
            raise InvalidStateTransition("Only retryable failed jobs can be retried")
        return self._restart(now=now)

    def resume_after_auth(self, *, now: datetime | None = None) -> Job:
        if self.status is not JobStatus.BLOCKED or self.error_code is not ErrorCode.AUTH_REQUIRED:
            raise InvalidStateTransition("Only authentication-blocked jobs can resume")
        return self._restart(now=now)

    def request_cancellation(self, *, now: datetime | None = None) -> Job:
        if self.is_terminal:
            raise InvalidStateTransition(f"Cannot request cancellation for terminal job {self.id}")
        return replace(
            self,
            status=JobStatus.CANCELLATION_REQUESTED,
            updated_at=now or utc_now(),
            version=self.version + 1,
        )

    def cancel(self, *, now: datetime | None = None) -> Job:
        if self.is_terminal:
            raise InvalidStateTransition(f"Cannot cancel terminal job {self.id}")
        timestamp = now or utc_now()
        return replace(
            self,
            status=JobStatus.CANCELLED,
            error_code=ErrorCode.CANCELLED,
            error_message="Job cancelled",
            updated_at=timestamp,
            completed_at=timestamp,
            version=self.version + 1,
        )

    def _restart(self, *, now: datetime | None) -> Job:
        return replace(
            self,
            status=JobStatus.QUEUED,
            step=JobStep.QUEUED,
            attempt=self.attempt + 1,
            progress_current=None,
            progress_total=None,
            error_code=None,
            error_message=None,
            updated_at=now or utc_now(),
            started_at=None,
            completed_at=None,
            version=self.version + 1,
        )


@dataclass(frozen=True, slots=True)
class JobEvent:
    job_id: str
    from_status: JobStatus | None
    to_status: JobStatus
    step: JobStep
    attempt: int
    progress_current: int | None
    progress_total: int | None
    error_code: ErrorCode | None
    error_message: str | None
    version: int
    created_at: datetime
