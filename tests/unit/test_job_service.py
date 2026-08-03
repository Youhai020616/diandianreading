from __future__ import annotations

from dataclasses import asdict
from datetime import timedelta

import pytest

from diandianreading.application.use_cases.jobs import (
    JobCursor,
    JobNotFoundError,
    JobQuery,
    JobService,
    JobServiceError,
)
from diandianreading.domain import ErrorCode, Job, JobStatus, JobStep
from tests.support import FIXED_NOW


class FakeJobRepository:
    def __init__(self, *jobs: Job) -> None:
        self.values = {job.id: job for job in jobs}

    def get(self, job_id: str) -> Job | None:
        return self.values.get(job_id)

    def list_recent(
        self,
        status: JobStatus | None,
        limit: int,
        before_created_at=None,
        before_id=None,
    ):
        values = sorted(
            self.values.values(),
            key=lambda job: (job.created_at, job.id),
            reverse=True,
        )
        if status is not None:
            values = [job for job in values if job.status is status]
        if before_created_at is not None and before_id is not None:
            values = [
                job for job in values if (job.created_at, job.id) < (before_created_at, before_id)
            ]
        return tuple(values[:limit])

    def save_transition(self, previous: Job, current: Job) -> None:
        assert self.values[previous.id] == previous
        self.values[current.id] = current


class FakeUnitOfWork:
    def __init__(self, jobs: FakeJobRepository) -> None:
        self.jobs = jobs

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        del exc_type, exc_value, traceback

    def commit(self) -> None:
        pass


class FakeFactory:
    def __init__(self, jobs: FakeJobRepository) -> None:
        self.jobs = jobs

    def __call__(self):
        return FakeUnitOfWork(self.jobs)


def make_job(job_id: str, *, seconds: int = 0) -> Job:
    return Job.create(
        job_id=job_id,
        job_type="import_book",
        input_hash=f"secret-input-{job_id}",
        now=FIXED_NOW + timedelta(seconds=seconds),
    )


def make_failed_job() -> Job:
    claimed = make_job("job-failed").claim(
        "secret-worker",
        lease_expires_at=FIXED_NOW + timedelta(minutes=1),
        now=FIXED_NOW,
    )
    acquiring = claimed.begin_step(JobStep.ACQUIRING, claimed.lease_token, now=FIXED_NOW)
    return acquiring.fail(
        ErrorCode.FORMAT_UNSUPPORTED,
        "safe failure",
        acquiring.lease_token,
        retriable=False,
        now=FIXED_NOW,
    )


def test_job_service_lists_with_safe_keyset_dto_and_no_sensitive_fields() -> None:
    repository = FakeJobRepository(
        make_job("job-a"),
        make_job("job-b", seconds=1),
        make_job("job-c", seconds=2),
    )
    service = JobService(
        unit_of_work=FakeFactory(repository),  # type: ignore[arg-type]
        clock=lambda: FIXED_NOW,
    )

    first = service.list(JobQuery(limit=2))
    assert [item.id for item in first.items] == ["job-c", "job-b"]
    assert first.next_cursor == JobCursor(FIXED_NOW + timedelta(seconds=1), "job-b")
    second = service.list(JobQuery(limit=2, before=first.next_cursor))
    assert [item.id for item in second.jobs] == ["job-a"]
    assert second.next_cursor is None

    serialized = asdict(first.items[0])
    forbidden = {
        "payload",
        "payload_json",
        "input_hash",
        "lease_owner",
        "lease_expires_at",
        "lease_generation",
        "provider",
        "profile",
        "path",
    }
    assert forbidden.isdisjoint(serialized)


def test_job_service_get_and_retry_map_unknown_or_invalid_state_to_safe_typed_errors() -> None:
    failed = make_failed_job()
    queued = make_job("job-queued")
    repository = FakeJobRepository(failed, queued)
    service = JobService(
        unit_of_work=FakeFactory(repository),  # type: ignore[arg-type]
        clock=lambda: FIXED_NOW + timedelta(seconds=1),
    )

    with pytest.raises(JobNotFoundError, match="not found"):
        service.get("missing")
    with pytest.raises(JobNotFoundError, match="not found"):
        service.retry("missing")
    with pytest.raises(JobServiceError, match="not in a retryable state") as invalid:
        service.retry(queued.id)
    assert invalid.value.code is ErrorCode.VALIDATION

    retried = service.retry(failed.id)
    assert retried.status is JobStatus.QUEUED
    assert retried.attempt == 2
    assert retried.last_error_code is None
