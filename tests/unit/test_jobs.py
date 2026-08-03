from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta

import pytest

from diandianreading.domain import (
    BlockedReason,
    ErrorCode,
    InvalidStateTransition,
    Job,
    JobStatus,
    JobStep,
    JobStepRecord,
    JobStepStatus,
    LeaseToken,
    is_retryable_error,
)
from tests.support import FIXED_NOW

_LEASE_DURATION = timedelta(minutes=5)
_ORDERED_STEPS = (
    JobStep.ACQUIRING,
    JobStep.STORING,
    JobStep.PREPARING,
    JobStep.CREATING_WORKSPACE,
    JobStep.UPLOADING,
    JobStep.PROCESSING,
    JobStep.VERIFYING,
)


def make_job() -> Job:
    return Job.create(
        job_id="job-1",
        job_type="import_book",
        input_hash="hash",
        book_id="book-1",
        now=FIXED_NOW,
    )


def claim_job(
    job: Job | None = None,
    *,
    owner: str = "worker-a",
    now: datetime = FIXED_NOW,
) -> Job:
    return (job or make_job()).claim(
        owner,
        lease_expires_at=now + _LEASE_DURATION,
        now=now,
    )


def complete_job() -> Job:
    job = claim_job(now=FIXED_NOW + timedelta(seconds=1))
    token = job.lease_token
    for offset, step in enumerate(_ORDERED_STEPS, start=2):
        job = job.begin_step(step, token, now=FIXED_NOW + timedelta(seconds=offset))
    return job.complete(token, now=FIXED_NOW + timedelta(seconds=9))


def make_step_record() -> JobStepRecord:
    return JobStepRecord.start(
        job_id="job-1",
        step=JobStep.ACQUIRING,
        attempt=1,
        input_hash="step-hash",
        now=FIXED_NOW,
    )


def test_job_create_initializes_recoverable_state_and_validates_persisted_invariants() -> None:
    job = make_job()

    assert job.status is JobStatus.QUEUED
    assert job.current_step is None
    assert job.attempt == 1
    assert job.lease_generation == 0
    assert job.version == 0
    assert not job.is_terminal
    assert not job.is_cancel_requested

    with pytest.raises(InvalidStateTransition, match="running Job"):
        _ = job.lease_token
    with pytest.raises(ValueError, match="set together"):
        replace(job, progress_current=0)
    with pytest.raises(ValueError, match="blocked_reason"):
        replace(job, blocked_reason=BlockedReason.AUTH_REQUIRED)
    with pytest.raises(ValueError, match="running Job"):
        replace(job, status=JobStatus.RUNNING)
    with pytest.raises(ValueError, match="terminal Job"):
        replace(job, status=JobStatus.COMPLETED)
    with pytest.raises(ValueError, match="attempt starts at one"):
        replace(job, attempt=0)


def test_job_claim_and_heartbeat_establish_a_fenced_lease() -> None:
    job = make_job()
    expires_at = FIXED_NOW + _LEASE_DURATION

    claimed = job.claim("worker-a", lease_expires_at=expires_at, now=FIXED_NOW)

    assert claimed.status is JobStatus.RUNNING
    assert claimed.lease_token == LeaseToken(owner="worker-a", generation=1)
    assert claimed.lease_expires_at == expires_at
    assert claimed.started_at == FIXED_NOW
    assert claimed.version == 1

    renewed_at = FIXED_NOW + timedelta(seconds=1)
    renewed_expiry = FIXED_NOW + timedelta(minutes=10)
    renewed = claimed.heartbeat(
        claimed.lease_token,
        lease_expires_at=renewed_expiry,
        now=renewed_at,
    )
    assert renewed.lease_expires_at == renewed_expiry
    assert renewed.updated_at == renewed_at
    assert renewed.version == claimed.version + 1

    with pytest.raises(InvalidStateTransition, match="queued Job"):
        claimed.claim("worker-b", lease_expires_at=renewed_expiry, now=renewed_at)


@pytest.mark.parametrize(
    ("owner", "lease_expires_at", "message"),
    (
        (" ", FIXED_NOW + timedelta(seconds=1), "owner"),
        ("worker-a", FIXED_NOW, "future"),
        ("worker-a", FIXED_NOW - timedelta(microseconds=1), "future"),
    ),
)
def test_job_claim_rejects_invalid_lease_boundaries(
    owner: str,
    lease_expires_at: datetime,
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        make_job().claim(owner, lease_expires_at=lease_expires_at, now=FIXED_NOW)

    with pytest.raises(ValueError, match="owner"):
        LeaseToken(" ", 1)
    with pytest.raises(ValueError, match="positive"):
        LeaseToken("worker-a", 0)


def test_expired_lease_takeover_increments_generation_and_fences_stale_workers() -> None:
    first_expiry = FIXED_NOW + timedelta(seconds=5)
    first = make_job().claim(
        "worker-a",
        lease_expires_at=first_expiry,
        now=FIXED_NOW,
    )
    first_token = first.lease_token

    with pytest.raises(InvalidStateTransition, match="unexpired"):
        first.take_over_expired_lease(
            "worker-b",
            lease_expires_at=FIXED_NOW + timedelta(minutes=1),
            now=first_expiry - timedelta(microseconds=1),
        )

    taken_over = first.take_over_expired_lease(
        "worker-b",
        lease_expires_at=FIXED_NOW + timedelta(minutes=1),
        now=first_expiry,
    )
    assert taken_over.lease_token == LeaseToken(owner="worker-b", generation=2)
    assert taken_over.started_at == first.started_at
    assert taken_over.version == first.version + 1

    with pytest.raises(InvalidStateTransition, match="stale"):
        taken_over.begin_step(JobStep.ACQUIRING, first_token)
    with pytest.raises(InvalidStateTransition, match="stale"):
        taken_over.heartbeat(
            LeaseToken("worker-c", 2),
            lease_expires_at=FIXED_NOW + timedelta(minutes=2),
            now=first_expiry,
        )
    with pytest.raises(ValueError, match="future"):
        taken_over.heartbeat(
            taken_over.lease_token,
            lease_expires_at=first_expiry,
            now=first_expiry,
        )

    begun = taken_over.begin_step(JobStep.ACQUIRING, taken_over.lease_token)
    assert begun.current_step is JobStep.ACQUIRING


def test_job_begins_steps_in_order_and_completes_after_verifying() -> None:
    completed = complete_job()

    assert completed.status is JobStatus.COMPLETED
    assert completed.current_step is JobStep.VERIFYING
    assert completed.is_terminal
    assert completed.started_at == FIXED_NOW + timedelta(seconds=1)
    assert completed.completed_at == FIXED_NOW + timedelta(seconds=9)
    assert completed.lease_owner is None
    assert completed.lease_expires_at is None
    assert completed.version == 9

    with pytest.raises(InvalidStateTransition, match="terminal"):
        completed.request_cancellation()
    with pytest.raises(InvalidStateTransition, match="running Job"):
        _ = completed.lease_token


def test_job_rejects_out_of_order_steps_and_unsafe_completion() -> None:
    running = claim_job()
    token = running.lease_token

    with pytest.raises(InvalidStateTransition, match="must advance"):
        running.begin_step(JobStep.STORING, token)

    acquiring = running.begin_step(JobStep.ACQUIRING, token)
    with pytest.raises(InvalidStateTransition, match="after verifying"):
        acquiring.complete(token)
    with pytest.raises(InvalidStateTransition, match="must advance"):
        acquiring.begin_step(JobStep.ACQUIRING, token)

    verifying = acquiring
    for step in _ORDERED_STEPS[1:]:
        verifying = verifying.begin_step(step, token)
    cancellation_requested = verifying.request_cancellation(now=FIXED_NOW)
    with pytest.raises(InvalidStateTransition, match="cancellation-requested"):
        cancellation_requested.complete(token)

    cancelled = cancellation_requested.cancel(token=token, now=FIXED_NOW)
    assert cancelled.status is JobStatus.CANCELLED


def test_running_job_attaches_one_immutable_book_only_during_acquisition_or_storage() -> None:
    queued = Job.create(
        job_id="job-source",
        job_type="import_book",
        input_hash="source-hash",
        now=FIXED_NOW,
    )
    running = claim_job(queued)
    token = running.lease_token

    with pytest.raises(InvalidStateTransition, match="acquiring or storing"):
        running.attach_book("book-source", token, now=FIXED_NOW)

    acquiring = running.begin_step(JobStep.ACQUIRING, token, now=FIXED_NOW)
    attached = acquiring.attach_book("book-source", token, now=FIXED_NOW)
    assert attached.book_id == "book-source"
    assert attached.version == acquiring.version + 1

    with pytest.raises(InvalidStateTransition, match="immutable"):
        attached.attach_book("book-other", token, now=FIXED_NOW)
    with pytest.raises(InvalidStateTransition, match="immutable"):
        attached.attach_book("book-source", token, now=FIXED_NOW)
    with pytest.raises(InvalidStateTransition, match="stale"):
        acquiring.attach_book("book-source", LeaseToken("worker-b", token.generation))


def test_running_job_reports_progress_at_valid_boundaries() -> None:
    running = claim_job()
    token = running.lease_token
    running = running.begin_step(JobStep.ACQUIRING, token)

    started = running.report_progress(0, 2, token, now=FIXED_NOW)
    finished = started.report_progress(2, 2, token, now=FIXED_NOW)
    assert finished.progress_current == 2
    assert finished.progress_total == 2
    assert finished.version == running.version + 2

    for current, total in ((-1, 2), (3, 2), (0, 0)):
        with pytest.raises(ValueError, match="Progress"):
            running.report_progress(current, total, token)

    with pytest.raises(InvalidStateTransition, match="stale"):
        make_job().report_progress(0, 1, token)


def test_blocked_job_releases_lease_and_resumes_only_for_matching_reason() -> None:
    running = claim_job()
    token = running.lease_token
    running = running.begin_step(JobStep.ACQUIRING, token)

    blocked = running.block(
        BlockedReason.AUTH_REQUIRED,
        ErrorCode.AUTH_REQUIRED,
        "login required",
        token,
        now=FIXED_NOW,
    )
    assert blocked.status is JobStatus.BLOCKED
    assert blocked.blocked_reason is BlockedReason.AUTH_REQUIRED
    assert blocked.last_error_code is ErrorCode.AUTH_REQUIRED
    assert blocked.last_error_detail_redacted == "login required"
    assert blocked.retriable is False
    assert blocked.lease_owner is None
    assert not blocked.is_terminal

    with pytest.raises(InvalidStateTransition, match="stale"):
        blocked.begin_step(JobStep.STORING, token)
    with pytest.raises(InvalidStateTransition, match="matching blocked Job"):
        blocked.resume(BlockedReason.REMOTE_OUTCOME_AMBIGUOUS)

    resumed = blocked.resume(BlockedReason.AUTH_REQUIRED, now=FIXED_NOW + timedelta(seconds=1))
    assert resumed.status is JobStatus.QUEUED
    assert resumed.current_step is JobStep.ACQUIRING
    assert resumed.attempt == 2
    assert resumed.blocked_reason is None
    assert resumed.last_error_code is None
    assert resumed.retriable is None

    reclaimed = claim_job(resumed, owner="worker-b", now=FIXED_NOW + timedelta(seconds=2))
    continued = reclaimed.begin_step(JobStep.STORING, reclaimed.lease_token)
    assert continued.current_step is JobStep.STORING


def test_queue_retry_honors_not_before_boundary_and_continues_current_step() -> None:
    running = claim_job()
    token = running.lease_token
    running = running.begin_step(JobStep.ACQUIRING, token)

    with pytest.raises(ValueError, match="past"):
        running.queue_retry(
            ErrorCode.REMOTE_UNAVAILABLE,
            "offline",
            token,
            not_before=FIXED_NOW - timedelta(microseconds=1),
            now=FIXED_NOW,
        )

    retry_at = FIXED_NOW + timedelta(seconds=30)
    queued = running.queue_retry(
        ErrorCode.REMOTE_UNAVAILABLE,
        "offline",
        token,
        not_before=retry_at,
        now=FIXED_NOW,
    )
    assert queued.status is JobStatus.QUEUED
    assert queued.current_step is JobStep.ACQUIRING
    assert queued.attempt == 2
    assert queued.last_error_code is ErrorCode.REMOTE_UNAVAILABLE
    assert queued.retriable is True
    assert queued.not_before == retry_at
    assert queued.lease_owner is None

    with pytest.raises(InvalidStateTransition, match="delay"):
        queued.claim(
            "worker-b",
            lease_expires_at=retry_at + _LEASE_DURATION,
            now=retry_at - timedelta(microseconds=1),
        )

    reclaimed = queued.claim(
        "worker-b",
        lease_expires_at=retry_at + _LEASE_DURATION,
        now=retry_at,
    )
    assert reclaimed.lease_generation == 2
    assert reclaimed.not_before is None
    continued = reclaimed.begin_step(JobStep.STORING, reclaimed.lease_token)
    assert continued.current_step is JobStep.STORING


def test_failed_job_records_retryability_and_allows_explicit_retry() -> None:
    running = claim_job()
    token = running.lease_token
    running = running.begin_step(JobStep.ACQUIRING, token)

    failed = running.fail(
        ErrorCode.REMOTE_PROTOCOL_DRIFT,
        "protocol drift",
        token,
        retriable=False,
        now=FIXED_NOW,
    )
    assert failed.status is JobStatus.FAILED
    assert failed.is_terminal
    assert failed.retriable is False
    assert failed.last_error_code is ErrorCode.REMOTE_PROTOCOL_DRIFT
    assert failed.completed_at == FIXED_NOW
    assert failed.lease_owner is None

    retried = failed.retry(now=FIXED_NOW + timedelta(seconds=1))
    assert retried.status is JobStatus.QUEUED
    assert retried.current_step is JobStep.ACQUIRING
    assert retried.attempt == 2
    assert retried.last_error_code is None
    assert retried.retriable is None
    assert retried.completed_at is None
    assert not retried.is_terminal

    with pytest.raises(InvalidStateTransition, match="failed Job"):
        running.retry()


def test_queued_cancellation_is_idempotently_requested_and_prevents_claim() -> None:
    job = make_job()
    with pytest.raises(InvalidStateTransition, match="requested first"):
        job.cancel()

    requested = job.request_cancellation(now=FIXED_NOW)
    assert requested.status is JobStatus.QUEUED
    assert requested.cancel_requested_at == FIXED_NOW
    assert requested.is_cancel_requested
    assert requested.request_cancellation(now=FIXED_NOW + timedelta(seconds=1)) is requested

    with pytest.raises(InvalidStateTransition, match="cancellation-requested"):
        requested.claim(
            "worker-a",
            lease_expires_at=FIXED_NOW + _LEASE_DURATION,
            now=FIXED_NOW,
        )

    cancelled = requested.cancel(now=FIXED_NOW + timedelta(seconds=1))
    assert cancelled.status is JobStatus.CANCELLED
    assert cancelled.last_error_code is ErrorCode.CANCELLED
    assert cancelled.last_error_detail_redacted == "Job cancelled"
    assert cancelled.retriable is False
    assert cancelled.completed_at == FIXED_NOW + timedelta(seconds=1)
    assert cancelled.is_terminal

    assert cancelled.request_cancellation() is cancelled
    with pytest.raises(InvalidStateTransition, match="terminal"):
        cancelled.cancel()


def test_running_cancellation_requires_the_current_lease_token() -> None:
    running = claim_job()
    token = running.lease_token
    requested = running.request_cancellation(now=FIXED_NOW)

    with pytest.raises(InvalidStateTransition, match="requires its Lease"):
        requested.cancel(now=FIXED_NOW)
    with pytest.raises(InvalidStateTransition, match="stale"):
        requested.cancel(token=LeaseToken("worker-b", token.generation), now=FIXED_NOW)

    cancelled = requested.cancel(token=token, now=FIXED_NOW)
    assert cancelled.status is JobStatus.CANCELLED
    assert cancelled.lease_owner is None
    assert cancelled.lease_expires_at is None


def test_job_step_record_tracks_progress_blocking_and_failure() -> None:
    record = make_step_record()
    assert record.status is JobStepStatus.RUNNING
    assert record.started_at == FIXED_NOW
    assert record.version == 0

    started = record.report_progress(0, 3)
    progressed = started.report_progress(3, 3)
    assert progressed.progress_current == 3
    assert progressed.progress_total == 3
    assert progressed.version == 2

    blocked = progressed.block(
        ErrorCode.AUTH_REQUIRED,
        "login required",
        now=FIXED_NOW + timedelta(seconds=1),
    )
    assert blocked.status is JobStepStatus.BLOCKED
    assert blocked.error_code is ErrorCode.AUTH_REQUIRED
    assert blocked.error_detail_redacted == "login required"
    assert blocked.completed_at is None

    with pytest.raises(InvalidStateTransition, match="running Job Step"):
        blocked.report_progress(1, 3)

    failed = blocked.fail(
        ErrorCode.AUTH_REQUIRED,
        "credentials unavailable",
        now=FIXED_NOW + timedelta(seconds=2),
    )
    assert failed.status is JobStepStatus.FAILED
    assert failed.completed_at == FIXED_NOW + timedelta(seconds=2)
    assert failed.version == blocked.version + 1

    with pytest.raises(InvalidStateTransition, match="active Job Step"):
        failed.fail(ErrorCode.UNEXPECTED, "late failure")


def test_job_step_record_completes_once_with_nonempty_output_reference() -> None:
    record = make_step_record()
    with pytest.raises(ValueError, match="output reference"):
        record.complete("")

    progressed = record.report_progress(1, 1)
    completed = progressed.complete("asset://prepared/book", now=FIXED_NOW + timedelta(seconds=1))
    assert completed.status is JobStepStatus.COMPLETED
    assert completed.output_ref == "asset://prepared/book"
    assert completed.completed_at == FIXED_NOW + timedelta(seconds=1)
    assert completed.version == progressed.version + 1

    with pytest.raises(InvalidStateTransition, match="running Job Step"):
        completed.complete("asset://prepared/again")
    with pytest.raises(InvalidStateTransition, match="running Job Step"):
        completed.report_progress(1, 1)
    with pytest.raises(InvalidStateTransition, match="running Job Step"):
        completed.block(ErrorCode.AUTH_REQUIRED, "late block")


def test_job_step_record_rejects_invalid_progress_and_persisted_state() -> None:
    record = make_step_record()

    for current, total in ((-1, 1), (2, 1), (0, 0)):
        with pytest.raises(ValueError, match="Step progress"):
            record.report_progress(current, total)

    with pytest.raises(ValueError, match="set together"):
        replace(record, progress_current=0)
    with pytest.raises(ValueError, match="started_at"):
        replace(record, started_at=None)
    with pytest.raises(ValueError, match="terminal Job Step"):
        replace(record, status=JobStepStatus.COMPLETED, completed_at=None)
    with pytest.raises(ValueError, match="counters"):
        replace(record, version=-1)


def test_retry_policy_is_stable_per_error_code() -> None:
    assert not is_retryable_error(ErrorCode.AUTH_REQUIRED)
    assert is_retryable_error(ErrorCode.REMOTE_RATE_LIMITED)
    assert is_retryable_error(ErrorCode.REPOSITORY_CONFLICT)
    assert not is_retryable_error(ErrorCode.FORMAT_UNSUPPORTED)
