"""Safe application service for listing, reading, and retrying durable Jobs."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import final

from diandianreading.application.ports.repositories import UnitOfWorkFactory
from diandianreading.domain import (
    BlockedReason,
    DiandianError,
    ErrorCode,
    InvalidStateTransition,
    Job,
    JobEvent,
    JobStatus,
    JobStep,
    utc_now,
)

_MAX_JOB_PAGE = 100


@dataclass(frozen=True, slots=True)
class JobCursor:
    created_at: datetime
    id: str

    def __post_init__(self) -> None:
        if not self.id.strip():
            raise ValueError("Job cursor ID cannot be empty")


@dataclass(frozen=True, slots=True)
class JobQuery:
    status: JobStatus | None = None
    limit: int = 50
    before: JobCursor | None = None

    def __post_init__(self) -> None:
        if self.status is not None and not isinstance(self.status, JobStatus):
            raise ValueError("Job query status is invalid")
        if self.limit < 1 or self.limit > _MAX_JOB_PAGE:
            raise ValueError(f"Job page limit must be between 1 and {_MAX_JOB_PAGE}")


@dataclass(frozen=True, slots=True)
class JobView:
    id: str
    job_type: str
    book_title: str | None
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
    not_before: datetime | None
    book_id: str | None
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None
    completed_at: datetime | None

    @classmethod
    def from_job(cls, job: Job, *, book_title: str | None = None) -> JobView:
        return cls(
            id=job.id,
            job_type=job.job_type,
            book_title=book_title,
            status=job.status,
            current_step=job.current_step,
            attempt=job.attempt,
            progress_current=job.progress_current,
            progress_total=job.progress_total,
            last_error_code=job.last_error_code,
            last_error_detail_redacted=job.last_error_detail_redacted,
            retriable=job.retriable,
            blocked_reason=job.blocked_reason,
            cancel_requested_at=job.cancel_requested_at,
            not_before=job.not_before,
            book_id=job.book_id,
            created_at=job.created_at,
            updated_at=job.updated_at,
            started_at=job.started_at,
            completed_at=job.completed_at,
        )


@dataclass(frozen=True, slots=True)
class JobPage:
    items: tuple[JobView, ...]
    next_cursor: JobCursor | None

    @property
    def jobs(self) -> tuple[JobView, ...]:
        return self.items


class JobServiceError(DiandianError):
    """Typed, redacted failure exposed by JobService."""


@final
class JobNotFoundError(JobServiceError):
    def __init__(self) -> None:
        super().__init__(
            ErrorCode.VALIDATION,
            "Job was not found",
            retryable=False,
        )


@final
class JobService:
    def __init__(
        self,
        *,
        unit_of_work: UnitOfWorkFactory,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self._unit_of_work = unit_of_work
        self._clock = clock

    def list(self, query: JobQuery | None = None) -> JobPage:
        effective = query or JobQuery()
        before_created_at = effective.before.created_at if effective.before else None
        before_id = effective.before.id if effective.before else None
        with self._unit_of_work() as unit_of_work:
            jobs = tuple(
                unit_of_work.jobs.list_recent(
                    effective.status,
                    effective.limit,
                    before_created_at,
                    before_id,
                )
            )
            titles = {
                job.id: (
                    book.title
                    if job.book_id is not None
                    and (book := unit_of_work.catalog.get_book(job.book_id)) is not None
                    else None
                )
                for job in jobs
            }
            unit_of_work.commit()

        next_cursor: JobCursor | None = None
        if len(jobs) == effective.limit:
            last = jobs[-1]
            with self._unit_of_work() as unit_of_work:
                following = unit_of_work.jobs.list_recent(
                    effective.status,
                    1,
                    last.created_at,
                    last.id,
                )
                unit_of_work.commit()
            if following:
                next_cursor = JobCursor(last.created_at, last.id)
        return JobPage(
            items=tuple(JobView.from_job(job, book_title=titles[job.id]) for job in jobs),
            next_cursor=next_cursor,
        )

    def list_jobs(self, query: JobQuery | None = None) -> JobPage:
        return self.list(query)

    def get(self, job_id: str) -> JobView:
        if not job_id.strip():
            raise JobNotFoundError()
        with self._unit_of_work() as unit_of_work:
            job = unit_of_work.jobs.get(job_id)
            book_title = None
            if job is not None and job.book_id is not None:
                book = unit_of_work.catalog.get_book(job.book_id)
                book_title = book.title if book is not None else None
            unit_of_work.commit()
        if job is None:
            raise JobNotFoundError()
        return JobView.from_job(job, book_title=book_title)

    def get_job(self, job_id: str) -> JobView:
        return self.get(job_id)

    def retry(self, job_id: str) -> JobView:
        if not job_id.strip():
            raise JobNotFoundError()
        with self._unit_of_work() as unit_of_work:
            job = unit_of_work.jobs.get(job_id)
            if job is None:
                raise JobNotFoundError()
            try:
                retried = job.retry(now=self._clock())
            except InvalidStateTransition as error:
                raise JobServiceError(
                    ErrorCode.VALIDATION,
                    "Job is not in a retryable state",
                    retryable=False,
                ) from error
            unit_of_work.jobs.save_transition(job, retried)
            unit_of_work.commit()
        return JobView.from_job(retried)

    def list_events(self, job_id: str) -> tuple[JobEvent, ...]:
        if not job_id.strip():
            raise JobNotFoundError()
        with self._unit_of_work() as unit_of_work:
            job = unit_of_work.jobs.get(job_id)
            events = tuple(unit_of_work.jobs.list_events(job_id)) if job is not None else ()
            unit_of_work.commit()
        if job is None:
            raise JobNotFoundError()
        return events
