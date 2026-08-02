from __future__ import annotations

from datetime import timedelta

import pytest

from diandianreading.domain import (
    ErrorCode,
    InvalidStateTransition,
    Job,
    JobStatus,
    JobStep,
    is_retryable_error,
)
from tests.support import FIXED_NOW


def make_job() -> Job:
    return Job.create(
        job_id="job-1",
        job_type="import_book",
        input_hash="hash",
        book_id="book-1",
        now=FIXED_NOW,
    )


def complete_job() -> Job:
    job = make_job()
    for step in (
        JobStep.ACQUIRING,
        JobStep.STORING,
        JobStep.PREPARING,
        JobStep.CREATING_WORKSPACE,
        JobStep.UPLOADING,
        JobStep.PROCESSING,
        JobStep.VERIFYING,
        JobStep.COMPLETED,
    ):
        job = job.advance(step)
    return job


def test_job_advances_through_complete_state_machine() -> None:
    job = make_job()
    assert job.status is JobStatus.QUEUED
    assert not job.is_terminal

    steps = [
        JobStep.ACQUIRING,
        JobStep.STORING,
        JobStep.PREPARING,
        JobStep.CREATING_WORKSPACE,
        JobStep.UPLOADING,
        JobStep.PROCESSING,
        JobStep.VERIFYING,
        JobStep.COMPLETED,
    ]
    for offset, step in enumerate(steps, start=1):
        job = job.advance(step, now=FIXED_NOW + timedelta(seconds=offset))

    assert job.status is JobStatus.COMPLETED
    assert job.is_terminal
    assert job.started_at == FIXED_NOW + timedelta(seconds=1)
    assert job.completed_at == FIXED_NOW + timedelta(seconds=8)
    assert job.version == len(steps)


def test_job_rejects_out_of_order_and_terminal_transitions() -> None:
    with pytest.raises(InvalidStateTransition, match="must advance"):
        make_job().advance(JobStep.STORING)

    completed = complete_job()
    with pytest.raises(InvalidStateTransition, match="status completed"):
        completed.advance(JobStep.COMPLETED)
    with pytest.raises(InvalidStateTransition, match="terminal"):
        completed.fail(ErrorCode.UNEXPECTED, "late")
    with pytest.raises(InvalidStateTransition, match="terminal"):
        completed.cancel()
    with pytest.raises(InvalidStateTransition, match="terminal"):
        completed.request_cancellation()


def test_running_job_reports_valid_progress() -> None:
    job = make_job().advance(JobStep.ACQUIRING)
    progressed = job.report_progress(1, 2, now=FIXED_NOW)
    assert progressed.progress_current == 1
    assert progressed.progress_total == 2
    assert progressed.version == job.version + 1

    for current, total in ((-1, 2), (3, 2), (0, 0)):
        with pytest.raises(ValueError, match="Progress"):
            job.report_progress(current, total)

    with pytest.raises(InvalidStateTransition, match="running"):
        make_job().report_progress(0, 1)


def test_retryable_failure_can_restart_from_queue() -> None:
    running = make_job().advance(JobStep.ACQUIRING)
    failed = running.fail(ErrorCode.REMOTE_UNAVAILABLE, "offline", now=FIXED_NOW)
    assert failed.status is JobStatus.FAILED_RETRYABLE
    assert failed.error_code is ErrorCode.REMOTE_UNAVAILABLE
    assert not failed.is_terminal

    retried = failed.retry(now=FIXED_NOW)
    assert retried.status is JobStatus.QUEUED
    assert retried.step is JobStep.QUEUED
    assert retried.attempt == 2
    assert retried.error_code is None


def test_authentication_failure_blocks_until_explicit_resume() -> None:
    running = make_job().advance(JobStep.ACQUIRING)
    blocked = running.fail(ErrorCode.AUTH_REQUIRED, "login required", now=FIXED_NOW)
    assert blocked.status is JobStatus.BLOCKED
    assert not blocked.is_terminal
    with pytest.raises(InvalidStateTransition, match="status blocked"):
        blocked.advance(JobStep.STORING)
    with pytest.raises(InvalidStateTransition, match="retryable"):
        blocked.retry()

    resumed = blocked.resume_after_auth(now=FIXED_NOW)
    assert resumed.status is JobStatus.QUEUED
    assert resumed.attempt == 2
    with pytest.raises(InvalidStateTransition, match="authentication-blocked"):
        running.resume_after_auth()


def test_terminal_failure_and_cancellation_states() -> None:
    job = make_job().advance(JobStep.ACQUIRING)
    failed = job.fail(ErrorCode.REMOTE_PROTOCOL_DRIFT, "drift", now=FIXED_NOW)
    assert failed.status is JobStatus.FAILED_TERMINAL
    assert failed.completed_at == FIXED_NOW
    with pytest.raises(InvalidStateTransition, match="retryable"):
        failed.retry()

    requested = job.request_cancellation(now=FIXED_NOW)
    assert requested.status is JobStatus.CANCELLATION_REQUESTED
    with pytest.raises(InvalidStateTransition, match="cancellation_requested"):
        requested.advance(JobStep.STORING)
    cancelled = requested.cancel(now=FIXED_NOW)
    assert cancelled.status is JobStatus.CANCELLED
    assert cancelled.error_code is ErrorCode.CANCELLED
    assert cancelled.is_terminal


def test_retry_policy_is_stable_per_error_code() -> None:
    assert not is_retryable_error(ErrorCode.AUTH_REQUIRED)
    assert is_retryable_error(ErrorCode.REMOTE_RATE_LIMITED)
    assert is_retryable_error(ErrorCode.REPOSITORY_CONFLICT)
    assert not is_retryable_error(ErrorCode.FORMAT_UNSUPPORTED)
