from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timedelta
from importlib.resources import files
from pathlib import Path
from typing import cast

import pytest

from diandianreading.application.ports.chat import (
    ChatIdempotencyConflictError,
    ChatRepositoryConflictError,
    ChatSubmission,
    ChatSubmissionDisposition,
    ConversationBusyError,
)
from diandianreading.domain.chat import (
    ChatError,
    ChatErrorCode,
    ChatMessage,
    ChatMessagePair,
    ChatProviderAttempt,
    ChatReference,
    ChatReferenceLocation,
    ChatReferenceLocationType,
    ChatRun,
    ChatRunEventType,
    ChatRunPhase,
    ChatRunStatus,
    EffectiveBookScope,
    ProviderAttemptStatus,
    QueryScope,
    QueryScopeType,
    chat_request_fingerprint,
)
from diandianreading.domain.errors import InvalidStateTransition
from diandianreading.domain.models import (
    Book,
    BookStatus,
    DocumentPart,
    ExternalSource,
    ExternalWorkspace,
    KnowledgeStatus,
)
from diandianreading.infrastructure.persistence.chat import SQLiteChatRepository
from diandianreading.infrastructure.persistence.sqlite import (
    SQLiteCatalogRepository,
    SQLiteDatabase,
    SQLiteKnowledgeMappingRepository,
)
from tests.support import FIXED_NOW, make_import_command

_PROVIDER_WORKSPACE_ID = "provider-workspace-secret"
_PROVIDER_CONVERSATION_ID = "provider-conversation-secret"


@dataclass(frozen=True, slots=True)
class Runtime:
    database: SQLiteDatabase
    repository: SQLiteChatRepository
    conversation_id: str
    book: Book
    workspace: ExternalWorkspace
    parts: tuple[DocumentPart, ...]
    sources: tuple[ExternalSource, ...]
    now: datetime


def make_runtime(tmp_path: Path) -> Runtime:
    database = SQLiteDatabase(tmp_path / "state" / "app.sqlite3")
    assert database.migrate() == 6
    catalog = SQLiteCatalogRepository(database)
    mappings = SQLiteKnowledgeMappingRepository(database)
    command = make_import_command(tmp_path, part_count=2)
    book = Book(
        id="book-1",
        title="Durable Chat",
        author="Test Author",
        source_hash=command.asset.sha256,
        status=BookStatus.READY,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
    )
    catalog.add_book(book)
    catalog.add_asset(book.id, command.asset)
    for part in command.parts:
        catalog.add_part(part)
    workspace = ExternalWorkspace(
        id="workspace-local-1",
        book_id=book.id,
        provider="fake-provider",
        credential_profile="local-profile",
        external_id=_PROVIDER_WORKSPACE_ID,
        status=KnowledgeStatus.READY,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
    )
    mappings.save_workspace(workspace)
    sources = tuple(
        ExternalSource(
            id=f"source-local-{index}",
            workspace_id=workspace.id,
            document_part_id=part.id,
            external_id=f"provider-source-secret-{index}",
            checksum=part.sha256,
            status=KnowledgeStatus.READY,
            created_at=FIXED_NOW,
            updated_at=FIXED_NOW,
        )
        for index, part in enumerate(command.parts, start=1)
    )
    for source in sources:
        mappings.save_source(source)
    repository = SQLiteChatRepository(database)
    ensured = repository.ensure_conversation(
        book_id=book.id,
        conversation_id="conversation-local-1",
        now=FIXED_NOW,
    )
    assert ensured.created
    return Runtime(
        database=database,
        repository=repository,
        conversation_id=ensured.conversation.id,
        book=book,
        workspace=workspace,
        parts=tuple(command.parts),
        sources=sources,
        now=FIXED_NOW,
    )


def make_submission(
    runtime: Runtime,
    *,
    client_message_id: str,
    suffix: str,
    question: str = "What is the main argument?",
    now: datetime | None = None,
) -> ChatSubmission:
    timestamp = now or runtime.now
    scope = QueryScope.book()
    fingerprint = chat_request_fingerprint(
        runtime.conversation_id,
        client_message_id,
        question,
        scope,
    )
    run = ChatRun.create(
        run_id=f"run-{suffix}",
        conversation_id=runtime.conversation_id,
        client_message_id=client_message_id,
        user_message_id=f"message-user-{suffix}",
        assistant_message_id=f"message-assistant-{suffix}",
        query_scope=scope,
        question=question,
        request_fingerprint=fingerprint,
        now=timestamp,
    )
    messages = ChatMessagePair(
        user=ChatMessage.user(
            message_id=run.user_message_id,
            conversation_id=run.conversation_id,
            chat_run_id=run.id,
            client_message_id=client_message_id,
            content=question,
            now=timestamp,
        ),
        assistant=ChatMessage.assistant_placeholder(
            message_id=run.assistant_message_id,
            conversation_id=run.conversation_id,
            chat_run_id=run.id,
            now=timestamp,
        ),
    )
    return ChatSubmission(messages=messages, run=run)


def whole_book_scope(runtime: Runtime) -> EffectiveBookScope:
    return EffectiveBookScope(
        type=QueryScopeType.BOOK,
        book_id=runtime.book.id,
        document_part_ids=tuple(part.id for part in runtime.parts),
        chapter_refs=tuple(
            chapter_ref for part in runtime.parts for chapter_ref in part.chapter_refs
        ),
        source_labels=tuple(f"Part {index}" for index in range(1, len(runtime.parts) + 1)),
    )


def prepare_attempt(runtime: Runtime, run: ChatRun, *, suffix: str) -> ChatProviderAttempt:
    intent = ChatProviderAttempt.prepare(
        intent_id=f"provider-attempt-{suffix}",
        chat_run_id=run.id,
        run_attempt=run.attempt,
        provider=runtime.workspace.provider,
        request_fingerprint=run.request_fingerprint,
        now=run.updated_at,
    )
    return runtime.repository.prepare_provider_attempt(intent, run.lease_token)


def claim_and_scope(
    runtime: Runtime,
    submission: ChatSubmission,
    *,
    owner: str = "worker-a",
    now: datetime | None = None,
) -> ChatRun:
    timestamp = now or runtime.now
    _ = runtime.repository.submit(submission)
    claimed = runtime.repository.claim(
        submission.run.id,
        owner,
        lease_expires_at=timestamp + timedelta(seconds=5),
        now=timestamp,
    )
    return runtime.repository.persist_effective_scope(
        claimed.id,
        claimed.lease_token,
        whole_book_scope(runtime),
        now=timestamp,
    )


def fail_retriable_submission(runtime: Runtime, *, suffix: str) -> ChatRun:
    submission = make_submission(
        runtime,
        client_message_id=f"client-{suffix}",
        suffix=suffix,
    )
    _ = runtime.repository.submit(submission)
    claimed = runtime.repository.claim(
        submission.run.id,
        f"worker-{suffix}",
        lease_expires_at=runtime.now + timedelta(seconds=5),
        now=runtime.now,
    )
    return runtime.repository.fail(
        claimed.id,
        claimed.lease_token,
        ChatError.safe(
            ChatErrorCode.AUTH_REQUIRED,
            "Knowledge Provider authentication is required",
            request_id=claimed.id,
        ),
        now=runtime.now + timedelta(seconds=1),
    )


def apply_schema_through_v5(database: SQLiteDatabase) -> None:
    migration_root = files("diandianreading.infrastructure.persistence.migrations")
    with database.connect() as connection:
        connection.execute(
            """
            CREATE TABLE schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                checksum TEXT NOT NULL,
                applied_at TEXT NOT NULL
            )
            """
        )
        for version in range(1, 6):
            name = (
                f"{version:04d}_"
                + {
                    1: "initial.sql",
                    2: "document_preparation.sql",
                    3: "notebooklm_operations.sql",
                    4: "recoverable_workflow.sql",
                    5: "zlibrary_acquisition.sql",
                }[version]
            )
            sql = migration_root.joinpath(name).read_text(encoding="utf-8")
            connection.executescript(sql)
            connection.execute(
                """
                INSERT INTO schema_migrations(version, name, checksum, applied_at)
                VALUES (?, ?, ?, ?)
                """,
                (
                    version,
                    name,
                    hashlib.sha256(sql.encode("utf-8")).hexdigest(),
                    FIXED_NOW.isoformat(),
                ),
            )


def test_schema_v5_migrates_to_v6_with_security_and_local_chat_invariants(
    tmp_path: Path,
) -> None:
    database = SQLiteDatabase(tmp_path / "migration" / "app.sqlite3")
    apply_schema_through_v5(database)
    assert database.schema_version() == 5
    assert database.migrate() == 6
    assert database.integrity_check()

    with database.connect() as connection:
        tables = {
            str(row["name"])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
        indexes = {
            str(row["name"])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'index'"
            ).fetchall()
        }
        reference_columns = {
            str(row["name"])
            for row in connection.execute("PRAGMA table_info(chat_references)").fetchall()
        }
    assert {
        "browser_sessions",
        "browser_bootstrap_nonces",
        "conversations",
        "provider_conversation_bindings",
        "chat_runs",
        "chat_messages",
        "chat_references",
        "chat_run_events",
        "chat_provider_attempts",
        "chat_run_retries",
    } <= tables
    assert {
        "idx_jobs_created_at_id",
        "idx_jobs_status_created_at_id",
        "idx_browser_sessions_active",
        "idx_browser_sessions_cleanup",
        "idx_browser_bootstrap_nonces_active",
        "idx_browser_bootstrap_nonces_cleanup",
        "idx_chat_runs_one_active_per_conversation",
    } <= indexes
    assert "provider_source_id" not in reference_columns
    assert "provider_conversation_id" not in reference_columns
    assert "physical_path" not in reference_columns

    with database.connect(immediate=True) as connection:
        connection.execute(
            """
            INSERT INTO browser_sessions(
                id, session_token_digest, csrf_token_digest, install_token_generation,
                created_at, last_seen_at, idle_expires_at, absolute_expires_at,
                revoked_at, revoked_reason, version
            ) VALUES ('session-1', ?, ?, 1, ?, ?, ?, ?, NULL, NULL, 0)
            """,
            (
                "a" * 64,
                "b" * 64,
                FIXED_NOW.isoformat(),
                FIXED_NOW.isoformat(),
                (FIXED_NOW + timedelta(minutes=30)).isoformat(),
                (FIXED_NOW + timedelta(hours=8)).isoformat(),
            ),
        )
    with (
        pytest.raises(sqlite3.IntegrityError),
        database.connect(immediate=True) as connection,
    ):
        connection.execute(
            """
            INSERT INTO browser_bootstrap_nonces(
                id, nonce_digest, install_token_generation,
                created_at, expires_at, consumed_at, version
            ) VALUES ('nonce-bad', ?, 1, ?, ?, NULL, 0)
            """,
            (
                "A" * 64,
                FIXED_NOW.isoformat(),
                (FIXED_NOW + timedelta(minutes=5)).isoformat(),
            ),
        )
    with (
        pytest.raises(sqlite3.IntegrityError),
        database.connect(immediate=True) as connection,
    ):
        connection.execute(
            """
            UPDATE browser_sessions
            SET revoked_at = ?, revoked_reason = NULL
            WHERE id = 'session-1'
            """,
            (FIXED_NOW.isoformat(),),
        )


def test_ensure_conversation_and_execution_context_use_ready_local_mappings(
    tmp_path: Path,
) -> None:
    runtime = make_runtime(tmp_path)
    replay = runtime.repository.ensure_conversation(
        book_id=runtime.book.id,
        conversation_id="ignored-concurrent-proposal",
        now=runtime.now + timedelta(seconds=1),
    )
    assert not replay.created
    assert replay.conversation.id == runtime.conversation_id
    assert replay.conversation.workspace_id == runtime.workspace.id
    with pytest.raises(KeyError, match="Unknown Book"):
        runtime.repository.ensure_conversation(
            book_id="missing-book",
            conversation_id="conversation-missing",
            now=runtime.now,
        )

    submitted = runtime.repository.submit(
        make_submission(runtime, client_message_id="client-context", suffix="context")
    )
    context = runtime.repository.get_execution_context(submitted.run.id)
    assert context is not None
    assert context.book == runtime.book
    assert context.workspace.id == runtime.workspace.id
    assert context.workspace.external_id == _PROVIDER_WORKSPACE_ID
    assert context.credential.provider == runtime.workspace.provider
    assert context.credential.profile == runtime.workspace.credential_profile
    assert context.parts == runtime.parts
    assert context.sources == runtime.sources
    assert context.binding.provider_conversation_id is None
    assert context.provider_attempt is None

    public_conversation = runtime.repository.get_conversation(runtime.conversation_id)
    assert public_conversation == replay.conversation
    assert _PROVIDER_WORKSPACE_ID not in repr(public_conversation)
    assert "provider-source-secret" not in repr(public_conversation)


def test_submit_replays_before_busy_and_maps_conflict_and_active_run(
    tmp_path: Path,
) -> None:
    runtime = make_runtime(tmp_path)
    first_submission = make_submission(
        runtime,
        client_message_id="client-submit",
        suffix="first",
        question="café",
    )
    first = runtime.repository.submit(first_submission)
    assert first.disposition is ChatSubmissionDisposition.CREATED

    replay_submission = make_submission(
        runtime,
        client_message_id="client-submit",
        suffix="replayed-proposal",
        question="café",
    )
    replay = runtime.repository.submit(replay_submission)
    assert replay.disposition is ChatSubmissionDisposition.REPLAYED
    assert replay.run.id == first.run.id
    assert replay.messages == first.messages

    with pytest.raises(ChatIdempotencyConflictError):
        runtime.repository.submit(
            make_submission(
                runtime,
                client_message_id="client-submit",
                suffix="conflicting-proposal",
                question="A different canonical request",
            )
        )
    with pytest.raises(ConversationBusyError) as busy:
        runtime.repository.submit(
            make_submission(
                runtime,
                client_message_id="client-other",
                suffix="busy",
            )
        )
    assert busy.value.active_run_id == first.run.id

    with runtime.database.connect() as connection:
        counts = connection.execute(
            """
            SELECT
                (SELECT count(*) FROM chat_runs) AS runs,
                (SELECT count(*) FROM chat_messages) AS messages,
                (SELECT count(*) FROM chat_run_events) AS events
            """
        ).fetchone()
    assert counts is not None
    assert (counts["runs"], counts["messages"], counts["events"]) == (1, 2, 1)


def test_claim_next_recovers_expired_state_and_stale_workers_are_fenced(
    tmp_path: Path,
) -> None:
    runtime = make_runtime(tmp_path)
    submission = make_submission(
        runtime,
        client_message_id="client-lease",
        suffix="lease",
    )
    scoped = claim_and_scope(runtime, submission, owner="worker-before-crash")
    prepared = prepare_attempt(runtime, scoped, suffix="lease")
    old_token = scoped.lease_token

    recovery_time = runtime.now + timedelta(seconds=6)
    recovered = runtime.repository.claim_next(
        "worker-after-crash",
        lease_expires_at=recovery_time + timedelta(seconds=5),
        now=recovery_time,
    )
    assert recovered is not None
    assert recovered.id == scoped.id
    assert recovered.phase is ChatRunPhase.RESOLVING_SCOPE
    assert recovered.effective_scope == scoped.effective_scope
    assert recovered.provider_request_started_at is None
    assert recovered.attempt == scoped.attempt
    assert recovered.lease_generation == old_token.generation + 1
    context = runtime.repository.get_execution_context(recovered.id)
    assert context is not None
    assert context.provider_attempt == prepared

    with pytest.raises(ChatRepositoryConflictError, match="stale"):
        runtime.repository.heartbeat(
            recovered.id,
            old_token,
            lease_expires_at=recovery_time + timedelta(seconds=10),
            now=recovery_time,
        )
    with pytest.raises(ChatRepositoryConflictError, match="stale"):
        runtime.repository.persist_phase(
            recovered.id,
            old_token,
            ChatRunPhase.WAITING_FOR_PROVIDER,
            now=recovery_time,
        )

    heartbeat = runtime.repository.heartbeat(
        recovered.id,
        recovered.lease_token,
        lease_expires_at=recovery_time + timedelta(seconds=10),
        now=recovery_time + timedelta(seconds=1),
    )
    second_recovery_time = recovery_time + timedelta(seconds=11)
    claimed_by_id = runtime.repository.claim(
        heartbeat.id,
        "worker-third",
        lease_expires_at=second_recovery_time + timedelta(seconds=5),
        now=second_recovery_time,
    )
    assert claimed_by_id.phase is heartbeat.phase
    assert claimed_by_id.effective_scope == heartbeat.effective_scope
    assert claimed_by_id.lease_generation == heartbeat.lease_generation + 1
    with pytest.raises(ChatRepositoryConflictError, match="stale"):
        runtime.repository.fail(
            heartbeat.id,
            heartbeat.lease_token,
            ChatError.safe(
                ChatErrorCode.UNEXPECTED,
                "Stale worker must not win",
                request_id=heartbeat.id,
            ),
            now=second_recovery_time,
        )


def test_successful_finalization_is_atomic_and_public_result_has_no_provider_ids(
    tmp_path: Path,
) -> None:
    runtime = make_runtime(tmp_path)
    submission = make_submission(
        runtime,
        client_message_id="client-success",
        suffix="success",
    )
    scoped = claim_and_scope(runtime, submission)
    prepared = prepare_attempt(runtime, scoped, suffix="success")
    waiting, dispatched = runtime.repository.dispatch_provider_attempt(
        scoped.id,
        prepared.id,
        scoped.lease_token,
        now=runtime.now + timedelta(seconds=1),
    )
    assert dispatched.status is ProviderAttemptStatus.DISPATCHED
    finalizing = runtime.repository.persist_phase(
        waiting.id,
        waiting.lease_token,
        ChatRunPhase.FINALIZING,
        now=runtime.now + timedelta(seconds=2),
    )
    reference = ChatReference(
        id="reference-local-1",
        message_id=finalizing.assistant_message_id,
        citation_number=1,
        book_id=runtime.book.id,
        document_part_id=runtime.parts[0].id,
        chapter_refs=runtime.parts[0].chapter_refs,
        label="Part 1",
        passage="A safe local citation passage.",
        location=ChatReferenceLocation(
            type=ChatReferenceLocationType.PDF_PAGE,
            value="12",
        ),
        created_at=runtime.now + timedelta(seconds=3),
    )
    result = runtime.repository.finalize_provider_attempt(
        finalizing.id,
        prepared.id,
        finalizing.lease_token,
        assistant_content="A grounded answer [1].",
        provider_conversation_id=_PROVIDER_CONVERSATION_ID,
        references=(reference,),
        now=runtime.now + timedelta(seconds=3),
    )

    assert result.run.status is ChatRunStatus.COMPLETED
    assert result.run.phase is None
    assert result.assistant_message.content == "A grounded answer [1]."
    assert result.references == (reference,)
    persisted = runtime.repository.get_result(result.run.id)
    assert persisted == result
    context = runtime.repository.get_execution_context(result.run.id)
    assert context is not None
    assert context.binding.provider_conversation_id == _PROVIDER_CONVERSATION_ID
    assert context.provider_attempt is not None
    assert context.provider_attempt.status is ProviderAttemptStatus.SUCCEEDED

    public_repr = repr(result)
    public_json = json.dumps(asdict(result), default=str, ensure_ascii=False, sort_keys=True)
    for provider_id in (
        _PROVIDER_WORKSPACE_ID,
        _PROVIDER_CONVERSATION_ID,
        *(source.external_id for source in runtime.sources),
    ):
        assert provider_id not in public_repr
        assert provider_id not in public_json

    events = runtime.repository.list_events_after(
        result.run.id,
        after_event_id=None,
        limit=100,
    )
    assert events[-1].event_type is ChatRunEventType.COMPLETED
    assert events[-1].run_version == result.run.version
    with runtime.database.connect() as connection:
        reference_row = connection.execute(
            "SELECT * FROM chat_references WHERE id = ?",
            (reference.id,),
        ).fetchone()
    assert reference_row is not None
    serialized_row = json.dumps(dict(reference_row), default=str, sort_keys=True)
    assert "provider-source-secret" not in serialized_row
    assert _PROVIDER_CONVERSATION_ID not in serialized_row


def test_dispatched_crash_takeover_can_be_marked_ambiguous_and_failed_safely(
    tmp_path: Path,
) -> None:
    runtime = make_runtime(tmp_path)
    submission = make_submission(
        runtime,
        client_message_id="client-ambiguous",
        suffix="ambiguous",
    )
    scoped = claim_and_scope(runtime, submission, owner="worker-before-crash")
    prepared = prepare_attempt(runtime, scoped, suffix="ambiguous")
    waiting, _ = runtime.repository.dispatch_provider_attempt(
        scoped.id,
        prepared.id,
        scoped.lease_token,
        now=runtime.now + timedelta(seconds=1),
    )
    provider_started_at = waiting.provider_request_started_at
    recovery_time = runtime.now + timedelta(seconds=6)
    recovered = runtime.repository.takeover(
        waiting.id,
        "worker-after-crash",
        lease_expires_at=recovery_time + timedelta(seconds=5),
        now=recovery_time,
    )
    assert recovered.phase is ChatRunPhase.WAITING_FOR_PROVIDER
    assert recovered.provider_request_started_at == provider_started_at
    assert recovered.effective_scope == waiting.effective_scope

    reconciling = runtime.repository.persist_phase(
        recovered.id,
        recovered.lease_token,
        ChatRunPhase.RECONCILING,
        now=recovery_time,
    )
    ambiguous_attempt = runtime.repository.terminate_provider_attempt(
        reconciling.id,
        prepared.id,
        reconciling.lease_token,
        ProviderAttemptStatus.AMBIGUOUS,
        now=recovery_time + timedelta(seconds=1),
    )
    assert ambiguous_attempt.status is ProviderAttemptStatus.AMBIGUOUS
    safe_error = ChatError.safe(
        ChatErrorCode.AMBIGUOUS_PROVIDER_OUTCOME,
        "Knowledge Provider outcome is ambiguous",
        request_id=reconciling.id,
        retriable=False,
    )
    failed = runtime.repository.fail(
        reconciling.id,
        reconciling.lease_token,
        safe_error,
        now=recovery_time + timedelta(seconds=2),
    )
    assert failed.status is ChatRunStatus.FAILED
    assert failed.error is not None
    assert failed.error == safe_error
    assert not failed.error.retriable
    with pytest.raises(InvalidStateTransition, match="not retriable"):
        runtime.repository.retry(
            failed.id,
            "retry-ambiguous",
            now=recovery_time + timedelta(seconds=3),
        )

    events = runtime.repository.list_events_after(failed.id, after_event_id=None, limit=100)
    assert events[-1].event_type is ChatRunEventType.FAILED
    assert events[-1].error == safe_error
    with runtime.database.connect() as connection:
        row = connection.execute(
            "SELECT error_json FROM chat_runs WHERE id = ?",
            (failed.id,),
        ).fetchone()
    assert row is not None
    error_json = str(row["error_json"])
    assert json.dumps(json.loads(error_json), separators=(",", ":"), sort_keys=True) == error_json
    assert "secret" not in error_json


def test_queued_and_pre_dispatch_cancellation_terminate_without_provider_effects(
    tmp_path: Path,
) -> None:
    runtime = make_runtime(tmp_path)
    queued = runtime.repository.submit(
        make_submission(runtime, client_message_id="client-cancel-queued", suffix="cancel-queued")
    ).run
    requested = runtime.repository.request_cancel(queued.id, now=runtime.now)
    cancelled = runtime.repository.cancel(queued.id, None, now=runtime.now)
    assert requested.cancel_requested_at == runtime.now
    assert cancelled.status is ChatRunStatus.CANCELLED
    assert cancelled.error is None
    queued_result = runtime.repository.get_result(cancelled.id)
    assert queued_result is not None
    assert queued_result.assistant_message.content is None

    running_submission = make_submission(
        runtime,
        client_message_id="client-cancel-running",
        suffix="cancel-running",
        now=runtime.now + timedelta(seconds=1),
    )
    scoped = claim_and_scope(
        runtime,
        running_submission,
        owner="worker-cancel",
        now=runtime.now + timedelta(seconds=1),
    )
    prepared = prepare_attempt(runtime, scoped, suffix="cancel-running")
    requested_running = runtime.repository.request_cancel(
        scoped.id,
        now=runtime.now + timedelta(seconds=2),
    )
    cancelled_running = runtime.repository.cancel(
        scoped.id,
        scoped.lease_token,
        now=runtime.now + timedelta(seconds=2),
    )
    assert requested_running.status is ChatRunStatus.RUNNING
    assert cancelled_running.status is ChatRunStatus.CANCELLED
    context = runtime.repository.get_execution_context(cancelled_running.id)
    assert context is not None
    assert context.provider_attempt is not None
    assert context.provider_attempt.id == prepared.id
    assert context.provider_attempt.status is ProviderAttemptStatus.FAILED_TERMINAL
    assert context.provider_attempt.dispatched_at is None


def test_retriable_failure_requeues_once_per_client_retry_without_new_messages(
    tmp_path: Path,
) -> None:
    runtime = make_runtime(tmp_path)
    submission = make_submission(
        runtime,
        client_message_id="client-retry",
        suffix="retry",
    )
    _ = runtime.repository.submit(submission)
    claimed = runtime.repository.claim(
        submission.run.id,
        "worker-retry",
        lease_expires_at=runtime.now + timedelta(seconds=5),
        now=runtime.now,
    )
    failed = runtime.repository.fail(
        claimed.id,
        claimed.lease_token,
        ChatError.safe(
            ChatErrorCode.AUTH_REQUIRED,
            "Knowledge Provider authentication is required",
            request_id=claimed.id,
        ),
        now=runtime.now + timedelta(seconds=1),
    )
    assert failed.status is ChatRunStatus.FAILED
    original_result = runtime.repository.get_result(failed.id)
    assert original_result is not None

    retried = runtime.repository.retry(
        failed.id,
        "client-retry-1",
        now=runtime.now + timedelta(seconds=2),
    )
    replayed = runtime.repository.retry(
        failed.id,
        "client-retry-1",
        now=runtime.now + timedelta(seconds=3),
    )
    assert not retried.replayed
    assert retried.run.status is ChatRunStatus.QUEUED
    assert retried.run.attempt == 2
    assert replayed.replayed
    assert replayed.run == retried.run
    retried_result = runtime.repository.get_result(failed.id)
    assert retried_result is not None
    assert retried_result.assistant_message.id == original_result.assistant_message.id

    with runtime.database.connect() as connection:
        counts = connection.execute(
            """
            SELECT
                (SELECT count(*) FROM chat_messages WHERE chat_run_id = ?) AS messages,
                (SELECT count(*) FROM chat_run_retries WHERE chat_run_id = ?) AS retries
            """,
            (failed.id, failed.id),
        ).fetchone()
    assert counts is not None
    assert (counts["messages"], counts["retries"]) == (2, 1)


def test_structured_chat_json_is_canonical_and_noncanonical_rows_fail_closed(
    tmp_path: Path,
) -> None:
    runtime = make_runtime(tmp_path)
    submission = make_submission(
        runtime,
        client_message_id="client-json",
        suffix="json",
    )
    scoped = claim_and_scope(runtime, submission)
    with runtime.database.connect() as connection:
        row = connection.execute(
            "SELECT effective_scope_json FROM chat_runs WHERE id = ?",
            (scoped.id,),
        ).fetchone()
    assert row is not None
    scope_json = str(row["effective_scope_json"])
    assert (
        json.dumps(
            json.loads(scope_json),
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        == scope_json
    )

    with (
        pytest.raises(sqlite3.IntegrityError),
        runtime.database.connect(immediate=True) as connection,
    ):
        connection.execute(
            "UPDATE chat_runs SET effective_scope_json = 'not-json' WHERE id = ?",
            (scoped.id,),
        )

    noncanonical = json.dumps(json.loads(scope_json), ensure_ascii=False, indent=2)
    with runtime.database.connect(immediate=True) as connection:
        connection.execute(
            "UPDATE chat_runs SET effective_scope_json = ? WHERE id = ?",
            (noncanonical, scoped.id),
        )
    with pytest.raises(ValueError, match="Non-canonical effective_scope_json"):
        runtime.repository.get_run(scoped.id)


def test_message_pagination_and_event_cursor_are_bounded_and_deterministic(
    tmp_path: Path,
) -> None:
    runtime = make_runtime(tmp_path)
    run_ids: list[str] = []
    for index in range(3):
        timestamp = runtime.now + timedelta(seconds=index)
        submitted = runtime.repository.submit(
            make_submission(
                runtime,
                client_message_id=f"client-page-{index}",
                suffix=f"page-{index}",
                now=timestamp,
            )
        )
        _ = runtime.repository.request_cancel(
            submitted.run.id,
            now=timestamp + timedelta(milliseconds=100),
        )
        _ = runtime.repository.cancel(
            submitted.run.id,
            None,
            now=timestamp + timedelta(milliseconds=200),
        )
        run_ids.append(submitted.run.id)

    pages = []
    cursor = None
    while True:
        page = runtime.repository.list_messages(
            runtime.conversation_id,
            before=cursor,
            limit=2,
        )
        assert list(page.messages) == sorted(
            page.messages,
            key=lambda message: (message.created_at, message.id),
        )
        pages.append(page.messages)
        if page.next_cursor is None:
            break
        cursor = page.next_cursor
    flattened_oldest_first = tuple(message for page in reversed(pages) for message in page)
    assert len(flattened_oldest_first) == 6
    assert len({message.id for message in flattened_oldest_first}) == 6
    assert list(flattened_oldest_first) == sorted(
        flattened_oldest_first,
        key=lambda message: (message.created_at, message.id),
    )

    all_events = runtime.repository.list_events_after(
        run_ids[-1],
        after_event_id=None,
        limit=100,
    )
    assert [event.run_version for event in all_events] == [0, 1, 2]
    first_page = runtime.repository.list_events_after(
        run_ids[-1],
        after_event_id=None,
        limit=2,
    )
    second_page = runtime.repository.list_events_after(
        run_ids[-1],
        after_event_id=first_page[-1].id,
        limit=2,
    )
    assert first_page == all_events[:2]
    assert second_page == all_events[2:]
    assert all(event.id > first_page[-1].id for event in second_page)

    for limit in (0, 101):
        with pytest.raises(ValueError, match="between 1 and 100"):
            runtime.repository.list_messages(runtime.conversation_id, before=None, limit=limit)
    with pytest.raises(ValueError, match="cursor cannot be negative"):
        runtime.repository.list_events_after(run_ids[-1], after_event_id=-1, limit=100)
    for limit in (0, 501):
        with pytest.raises(ValueError, match="between 1 and 500"):
            runtime.repository.list_events_after(
                run_ids[-1],
                after_event_id=None,
                limit=limit,
            )


def test_active_run_and_missing_reads_are_safe_and_deterministic(tmp_path: Path) -> None:
    runtime = make_runtime(tmp_path)

    assert runtime.repository.get_conversation("missing-conversation") is None
    assert runtime.repository.get_conversation_for_book("missing-book") is None
    assert runtime.repository.get_active_run(runtime.conversation_id) is None
    assert runtime.repository.get_active_run("missing-conversation") is None
    assert runtime.repository.get_run("missing-run") is None
    assert runtime.repository.get_result("missing-run") is None
    assert runtime.repository.get_execution_context("missing-run") is None
    assert (
        runtime.repository.claim_next(
            "worker-empty-queue",
            lease_expires_at=runtime.now + timedelta(seconds=5),
            now=runtime.now,
        )
        is None
    )
    empty_messages = runtime.repository.list_messages(
        "missing-conversation",
        before=None,
        limit=10,
    )
    assert empty_messages.messages == ()
    assert empty_messages.next_cursor is None
    assert (
        runtime.repository.list_events_after(
            "missing-run",
            after_event_id=None,
            limit=10,
        )
        == ()
    )

    with runtime.database.connect() as connection:
        direct_repository = SQLiteChatRepository(connection)
        assert direct_repository.get_run("missing-run") is None

    submitted = runtime.repository.submit(
        make_submission(runtime, client_message_id="client-active", suffix="active")
    )
    assert runtime.repository.get_active_run(runtime.conversation_id) == submitted.run
    claimed = runtime.repository.claim_next(
        "worker-queued-run",
        lease_expires_at=runtime.now + timedelta(seconds=5),
        now=runtime.now,
    )
    assert claimed is not None
    assert claimed.id == submitted.run.id
    first_request = runtime.repository.request_cancel(claimed.id, now=runtime.now)
    replayed_request = runtime.repository.request_cancel(
        claimed.id,
        now=runtime.now + timedelta(seconds=1),
    )
    assert replayed_request == first_request
    cancelled = runtime.repository.cancel(claimed.id, claimed.lease_token, now=runtime.now)
    assert cancelled.status is ChatRunStatus.CANCELLED
    assert runtime.repository.get_active_run(runtime.conversation_id) is None
    with pytest.raises(ChatRepositoryConflictError, match="cannot be claimed"):
        _ = runtime.repository.claim(
            cancelled.id,
            "worker-terminal-run",
            lease_expires_at=runtime.now + timedelta(seconds=5),
            now=runtime.now,
        )

    with pytest.raises(KeyError, match="Unknown Chat Run"):
        _ = runtime.repository.retry(
            "missing-run",
            "retry-missing-run",
            now=runtime.now,
        )
    with pytest.raises(KeyError, match="Unknown Chat Run"):
        _ = runtime.repository.request_cancel("missing-run", now=runtime.now)


def test_ensure_conversation_requires_a_workspace_that_is_ready(tmp_path: Path) -> None:
    runtime = make_runtime(tmp_path)
    catalog = SQLiteCatalogRepository(runtime.database)
    mappings = SQLiteKnowledgeMappingRepository(runtime.database)
    unmapped_book = replace(
        runtime.book,
        id="book-without-workspace",
        title="Book without a workspace",
        source_hash="1" * 64,
    )
    catalog.add_book(unmapped_book)

    with pytest.raises(KeyError, match="has no ExternalWorkspace"):
        _ = runtime.repository.ensure_conversation(
            book_id=unmapped_book.id,
            conversation_id="conversation-unmapped",
            now=runtime.now,
        )

    processing_workspace = ExternalWorkspace(
        id="workspace-processing",
        book_id=unmapped_book.id,
        provider="fake-provider",
        credential_profile="local-profile",
        external_id="provider-workspace-processing",
        status=KnowledgeStatus.PROCESSING,
        created_at=runtime.now,
        updated_at=runtime.now,
    )
    mappings.save_workspace(processing_workspace)
    with pytest.raises(ChatRepositoryConflictError, match="not ready"):
        _ = runtime.repository.ensure_conversation(
            book_id=unmapped_book.id,
            conversation_id="conversation-processing",
            now=runtime.now,
        )

    collision_book = replace(
        runtime.book,
        id="book-conversation-collision",
        title="Conversation collision book",
        source_hash="3" * 64,
    )
    catalog.add_book(collision_book)
    collision_workspace = replace(
        runtime.workspace,
        id="workspace-conversation-collision",
        book_id=collision_book.id,
        external_id="provider-workspace-collision",
    )
    mappings.save_workspace(collision_workspace)
    with runtime.database.connect(immediate=True) as connection:
        _ = connection.execute(
            """
            CREATE TRIGGER reject_conversation_insert
            BEFORE INSERT ON conversations
            WHEN NEW.id = 'conversation-collision'
            BEGIN
                SELECT RAISE(ABORT, 'simulated conversation collision');
            END
            """
        )
    with pytest.raises(ChatRepositoryConflictError, match="identity changed"):
        _ = runtime.repository.ensure_conversation(
            book_id=collision_book.id,
            conversation_id="conversation-collision",
            now=runtime.now,
        )


def test_existing_conversation_mapping_corruption_fails_closed(tmp_path: Path) -> None:
    binding_path = tmp_path / "binding-provider"
    binding_path.mkdir()
    binding_runtime = make_runtime(binding_path)
    with binding_runtime.database.connect(immediate=True) as connection:
        _ = connection.execute(
            "UPDATE provider_conversation_bindings SET provider = ? WHERE conversation_id = ?",
            ("different-provider", binding_runtime.conversation_id),
        )
    with pytest.raises(ChatRepositoryConflictError, match="different Provider"):
        _ = binding_runtime.repository.ensure_conversation(
            book_id=binding_runtime.book.id,
            conversation_id="ignored-binding-proposal",
            now=binding_runtime.now,
        )

    workspace_path = tmp_path / "conversation-workspace"
    workspace_path.mkdir()
    workspace_runtime = make_runtime(workspace_path)
    catalog = SQLiteCatalogRepository(workspace_runtime.database)
    mappings = SQLiteKnowledgeMappingRepository(workspace_runtime.database)
    other_book = replace(
        workspace_runtime.book,
        id="book-other-workspace",
        title="Other workspace book",
        source_hash="2" * 64,
    )
    catalog.add_book(other_book)
    other_workspace = replace(
        workspace_runtime.workspace,
        id="workspace-local-other",
        book_id=other_book.id,
        external_id="provider-workspace-other",
    )
    mappings.save_workspace(other_workspace)
    with workspace_runtime.database.connect(immediate=True) as connection:
        _ = connection.execute(
            "UPDATE conversations SET workspace_id = ? WHERE id = ?",
            (other_workspace.id, workspace_runtime.conversation_id),
        )
    with pytest.raises(ChatRepositoryConflictError, match="different ExternalWorkspace"):
        _ = workspace_runtime.repository.ensure_conversation(
            book_id=workspace_runtime.book.id,
            conversation_id="ignored-workspace-proposal",
            now=workspace_runtime.now,
        )


_CONTEXT_CORRUPTIONS: tuple[
    tuple[str, str, tuple[object, ...], bool, type[Exception], str], ...
] = (
    (
        "missing-conversation",
        "UPDATE chat_runs SET conversation_id = ? WHERE id = ?",
        ("conversation-missing", "run-context-corruption"),
        True,
        KeyError,
        "Unknown Conversation",
    ),
    (
        "missing-binding",
        "DELETE FROM provider_conversation_bindings WHERE conversation_id = ?",
        ("conversation-local-1",),
        False,
        ChatRepositoryConflictError,
        "binding is unavailable",
    ),
    (
        "missing-book",
        "UPDATE conversations SET book_id = ? WHERE id = ?",
        ("book-missing", "conversation-local-1"),
        True,
        ValueError,
        "missing Book",
    ),
    (
        "missing-workspace",
        "UPDATE conversations SET workspace_id = ? WHERE id = ?",
        ("workspace-missing", "conversation-local-1"),
        True,
        ValueError,
        "missing ExternalWorkspace",
    ),
    (
        "missing-message",
        "DELETE FROM chat_messages WHERE id = ?",
        ("message-user-context-corruption",),
        False,
        ValueError,
        "exactly one local Message pair",
    ),
    (
        "mismatched-message-id",
        "UPDATE chat_runs SET user_message_id = ? WHERE id = ?",
        ("message-user-missing", "run-context-corruption"),
        False,
        ValueError,
        "identifiers do not match",
    ),
)


@pytest.mark.parametrize(
    ("case_name", "sql", "parameters", "disable_foreign_keys", "error_type", "message"),
    _CONTEXT_CORRUPTIONS,
)
def test_execution_context_missing_records_fail_closed(
    tmp_path: Path,
    case_name: str,
    sql: str,
    parameters: tuple[object, ...],
    disable_foreign_keys: bool,
    error_type: type[Exception],
    message: str,
) -> None:
    case_path = tmp_path / case_name
    case_path.mkdir()
    runtime = make_runtime(case_path)
    submission = make_submission(
        runtime,
        client_message_id="client-context-corruption",
        suffix="context-corruption",
    )
    _ = runtime.repository.submit(submission)
    with runtime.database.connect() as connection:
        if disable_foreign_keys:
            _ = connection.execute("PRAGMA foreign_keys = OFF")
        _ = connection.execute(sql, parameters)

    with pytest.raises(error_type, match=message):
        _ = runtime.repository.get_execution_context(submission.run.id)


def test_submit_validates_new_aggregates_and_maps_archived_or_database_conflicts(
    tmp_path: Path,
) -> None:
    runtime = make_runtime(tmp_path)
    submission = make_submission(
        runtime,
        client_message_id="client-submit-validation",
        suffix="submit-validation",
    )
    invalid_run = replace(submission.run, version=1)
    with pytest.raises(ValueError, match="new queued aggregate"):
        _ = runtime.repository.submit(ChatSubmission(submission.messages, invalid_run))

    completed_assistant = submission.messages.assistant.complete(
        "Premature answer",
        now=runtime.now,
    )
    invalid_messages = ChatMessagePair(
        user=submission.messages.user,
        assistant=completed_assistant,
    )
    with pytest.raises(ValueError, match="empty assistant"):
        _ = runtime.repository.submit(ChatSubmission(invalid_messages, submission.run))

    with runtime.database.connect(immediate=True) as connection:
        _ = connection.execute(
            "UPDATE conversations SET status = 'archived', version = version + 1 WHERE id = ?",
            (runtime.conversation_id,),
        )
    with pytest.raises(ChatRepositoryConflictError, match="Archived Conversation"):
        _ = runtime.repository.submit(submission)

    collision_path = tmp_path / "database-collision"
    collision_path.mkdir()
    collision_runtime = make_runtime(collision_path)
    collision_submission = make_submission(
        collision_runtime,
        client_message_id="client-submit-collision",
        suffix="submit-collision",
    )
    with collision_runtime.database.connect(immediate=True) as connection:
        _ = connection.execute(
            """
            CREATE TRIGGER reject_chat_run_insert
            BEFORE INSERT ON chat_runs
            BEGIN
                SELECT RAISE(ABORT, 'simulated chat run collision');
            END
            """
        )
    with pytest.raises(ChatRepositoryConflictError, match="collided"):
        _ = collision_runtime.repository.submit(collision_submission)
    assert collision_runtime.repository.get_run(collision_submission.run.id) is None


def test_stale_aggregate_version_is_rejected_without_private_helper_access(
    tmp_path: Path,
) -> None:
    runtime = make_runtime(tmp_path)
    submission = make_submission(
        runtime,
        client_message_id="client-stale-version",
        suffix="stale-version",
    )
    _ = runtime.repository.submit(submission)
    claimed = runtime.repository.claim(
        submission.run.id,
        "worker-stale-version",
        lease_expires_at=runtime.now + timedelta(seconds=5),
        now=runtime.now,
    )
    with runtime.database.connect(immediate=True) as connection:
        _ = connection.execute(
            f"""
            CREATE TRIGGER simulate_stale_chat_run_version
            BEFORE UPDATE ON chat_runs
            WHEN OLD.id = '{claimed.id}'
            BEGIN
                SELECT RAISE(IGNORE);
            END
            """
        )

    with pytest.raises(ChatRepositoryConflictError, match="changed or fenced"):
        _ = runtime.repository.heartbeat(
            claimed.id,
            claimed.lease_token,
            lease_expires_at=runtime.now + timedelta(seconds=10),
            now=runtime.now + timedelta(seconds=1),
        )
    persisted = runtime.repository.get_run(claimed.id)
    assert persisted == claimed


def test_provider_attempt_replay_validation_and_conflict_paths(tmp_path: Path) -> None:
    runtime = make_runtime(tmp_path)
    submission = make_submission(
        runtime,
        client_message_id="client-attempt-conflicts",
        suffix="attempt-conflicts",
    )
    scoped = claim_and_scope(runtime, submission)
    prepared = prepare_attempt(runtime, scoped, suffix="attempt-conflicts")
    replayed = runtime.repository.prepare_provider_attempt(prepared, scoped.lease_token)
    assert replayed == prepared

    mismatched_provider = ChatProviderAttempt.prepare(
        intent_id="provider-attempt-wrong-provider",
        chat_run_id=scoped.id,
        run_attempt=scoped.attempt,
        provider="different-provider",
        request_fingerprint=scoped.request_fingerprint,
        now=runtime.now,
    )
    with pytest.raises(ChatRepositoryConflictError, match="does not match"):
        _ = runtime.repository.prepare_provider_attempt(
            mismatched_provider,
            scoped.lease_token,
        )

    dispatched_shape = prepared.dispatch(now=runtime.now + timedelta(seconds=1))
    with pytest.raises(ValueError, match="prepared and undispatched"):
        _ = runtime.repository.prepare_provider_attempt(dispatched_shape, scoped.lease_token)
    with pytest.raises(ChatRepositoryConflictError, match="ID changed"):
        _ = runtime.repository.dispatch_provider_attempt(
            scoped.id,
            "provider-attempt-wrong-id",
            scoped.lease_token,
            now=runtime.now + timedelta(seconds=1),
        )

    waiting, dispatched = runtime.repository.dispatch_provider_attempt(
        scoped.id,
        prepared.id,
        scoped.lease_token,
        now=runtime.now + timedelta(seconds=1),
    )
    assert dispatched.status is ProviderAttemptStatus.DISPATCHED
    replacement_intent = ChatProviderAttempt.prepare(
        intent_id="provider-attempt-replacement",
        chat_run_id=waiting.id,
        run_attempt=waiting.attempt,
        provider=runtime.workspace.provider,
        request_fingerprint=waiting.request_fingerprint,
        now=runtime.now + timedelta(seconds=2),
    )
    with pytest.raises(ChatRepositoryConflictError, match="different intent"):
        _ = runtime.repository.prepare_provider_attempt(
            replacement_intent,
            waiting.lease_token,
        )
    with pytest.raises(ChatRepositoryConflictError, match="ID changed"):
        _ = runtime.repository.terminate_provider_attempt(
            waiting.id,
            "provider-attempt-wrong-id",
            waiting.lease_token,
            ProviderAttemptStatus.AMBIGUOUS,
            now=runtime.now + timedelta(seconds=2),
        )
    with pytest.raises(ValueError, match="Unsupported"):
        _ = runtime.repository.terminate_provider_attempt(
            waiting.id,
            prepared.id,
            waiting.lease_token,
            ProviderAttemptStatus.SUCCEEDED,
            now=runtime.now + timedelta(seconds=2),
        )
    terminal = runtime.repository.terminate_provider_attempt(
        waiting.id,
        prepared.id,
        waiting.lease_token,
        ProviderAttemptStatus.FAILED_TERMINAL,
        now=runtime.now + timedelta(seconds=2),
    )
    assert terminal.status is ProviderAttemptStatus.FAILED_TERMINAL


def test_dispatch_fails_closed_for_missing_or_changed_attempt_records(tmp_path: Path) -> None:
    missing_path = tmp_path / "missing-attempt"
    missing_path.mkdir()
    missing_runtime = make_runtime(missing_path)
    missing_submission = make_submission(
        missing_runtime,
        client_message_id="client-missing-attempt",
        suffix="missing-attempt",
    )
    missing_scoped = claim_and_scope(missing_runtime, missing_submission)
    with pytest.raises(ChatRepositoryConflictError, match="attempt is unavailable"):
        _ = missing_runtime.repository.dispatch_provider_attempt(
            missing_scoped.id,
            "provider-attempt-missing",
            missing_scoped.lease_token,
            now=missing_runtime.now + timedelta(seconds=1),
        )

    changed_path = tmp_path / "changed-attempt"
    changed_path.mkdir()
    changed_runtime = make_runtime(changed_path)
    changed_submission = make_submission(
        changed_runtime,
        client_message_id="client-changed-attempt",
        suffix="changed-attempt",
    )
    changed_scoped = claim_and_scope(changed_runtime, changed_submission)
    changed_attempt = prepare_attempt(changed_runtime, changed_scoped, suffix="changed-attempt")
    with changed_runtime.database.connect(immediate=True) as connection:
        _ = connection.execute(
            "UPDATE chat_provider_attempts SET request_fingerprint = ? WHERE id = ?",
            ("0" * 64, changed_attempt.id),
        )
    with pytest.raises(ChatRepositoryConflictError, match="fingerprint changed"):
        _ = changed_runtime.repository.dispatch_provider_attempt(
            changed_scoped.id,
            changed_attempt.id,
            changed_scoped.lease_token,
            now=changed_runtime.now + timedelta(seconds=1),
        )


def test_retry_replay_busy_and_transaction_conflict_are_safe(tmp_path: Path) -> None:
    busy_path = tmp_path / "retry-busy"
    busy_path.mkdir()
    busy_runtime = make_runtime(busy_path)
    failed = fail_retriable_submission(busy_runtime, suffix="retry-busy-failed")
    active_submission = make_submission(
        busy_runtime,
        client_message_id="client-retry-busy-active",
        suffix="retry-busy-active",
        now=busy_runtime.now + timedelta(seconds=2),
    )
    active = busy_runtime.repository.submit(active_submission).run
    with pytest.raises(ConversationBusyError) as busy:
        _ = busy_runtime.repository.retry(
            failed.id,
            "retry-while-other-run-active",
            now=busy_runtime.now + timedelta(seconds=3),
        )
    assert busy.value.active_run_id == active.id
    assert busy_runtime.repository.get_run(failed.id) == failed

    conflict_path = tmp_path / "retry-conflict"
    conflict_path.mkdir()
    conflict_runtime = make_runtime(conflict_path)
    conflict_failed = fail_retriable_submission(
        conflict_runtime,
        suffix="retry-conflict",
    )
    with conflict_runtime.database.connect(immediate=True) as connection:
        _ = connection.execute(
            """
            CREATE TRIGGER reject_chat_retry_insert
            BEFORE INSERT ON chat_run_retries
            BEGIN
                SELECT RAISE(ABORT, 'simulated retry collision');
            END
            """
        )
    with pytest.raises(ChatRepositoryConflictError, match="retry collided"):
        _ = conflict_runtime.repository.retry(
            conflict_failed.id,
            "retry-conflict-id",
            now=conflict_runtime.now + timedelta(seconds=2),
        )
    assert conflict_runtime.repository.get_run(conflict_failed.id) == conflict_failed
    with conflict_runtime.database.connect() as connection:
        count = cast(
            sqlite3.Row | None,
            connection.execute(
                "SELECT count(*) AS count FROM chat_run_retries WHERE chat_run_id = ?",
                (conflict_failed.id,),
            ).fetchone(),
        )
    assert count is not None
    assert count["count"] == 0


def test_phase_replay_and_prepared_cancel_require_a_fenced_lease(tmp_path: Path) -> None:
    phase_path = tmp_path / "phase-replay"
    phase_path.mkdir()
    phase_runtime = make_runtime(phase_path)
    phase_submission = make_submission(
        phase_runtime,
        client_message_id="client-phase-replay",
        suffix="phase-replay",
    )
    scoped = claim_and_scope(phase_runtime, phase_submission)
    with pytest.raises(ValueError, match="back to resolving_scope"):
        _ = phase_runtime.repository.persist_phase(
            scoped.id,
            scoped.lease_token,
            ChatRunPhase.RESOLVING_SCOPE,
            now=phase_runtime.now,
        )
    waiting = phase_runtime.repository.persist_phase(
        scoped.id,
        scoped.lease_token,
        ChatRunPhase.WAITING_FOR_PROVIDER,
        now=phase_runtime.now + timedelta(seconds=1),
    )
    reconciling = phase_runtime.repository.persist_phase(
        waiting.id,
        waiting.lease_token,
        ChatRunPhase.RECONCILING,
        now=phase_runtime.now + timedelta(seconds=2),
    )
    replayed = phase_runtime.repository.persist_phase(
        reconciling.id,
        reconciling.lease_token,
        ChatRunPhase.RECONCILING,
        now=phase_runtime.now + timedelta(seconds=3),
    )
    assert replayed == reconciling

    cancel_path = tmp_path / "prepared-cancel"
    cancel_path.mkdir()
    cancel_runtime = make_runtime(cancel_path)
    cancel_submission = make_submission(
        cancel_runtime,
        client_message_id="client-prepared-cancel",
        suffix="prepared-cancel",
    )
    cancel_scoped = claim_and_scope(cancel_runtime, cancel_submission)
    prepared = prepare_attempt(cancel_runtime, cancel_scoped, suffix="prepared-cancel")
    _ = cancel_runtime.repository.request_cancel(
        cancel_scoped.id,
        now=cancel_runtime.now + timedelta(seconds=1),
    )
    with pytest.raises(InvalidStateTransition, match="requires its Lease"):
        _ = cancel_runtime.repository.cancel(
            cancel_scoped.id,
            None,
            now=cancel_runtime.now + timedelta(seconds=1),
        )
    context = cancel_runtime.repository.get_execution_context(cancel_scoped.id)
    assert context is not None
    assert context.run.status is ChatRunStatus.RUNNING
    assert context.provider_attempt == prepared


def _canonical_test_json(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _error_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "code": ChatErrorCode.AUTH_REQUIRED.value,
        "details": [],
        "message": "Knowledge Provider authentication is required",
        "request_id": "run-structured-corruption",
        "retriable": True,
        "retry_after_ms": None,
    }
    payload.update(overrides)
    return payload


_STRUCTURED_CORRUPTIONS: tuple[tuple[str, str, object, bool, str], ...] = (
    ("scope-not-object", "effective_scope_json", [], False, "must be an object"),
    (
        "scope-schema",
        "effective_scope_json",
        {"book_id": "book-1"},
        False,
        "unexpected schema",
    ),
    ("error-not-object", "error_json", [], False, "must be an object"),
    ("error-schema", "error_json", {}, False, "unexpected schema"),
    (
        "error-retriable",
        "error_json",
        _error_payload(retriable="yes"),
        False,
        "retriable must be a boolean",
    ),
    (
        "error-retry-after",
        "error_json",
        _error_payload(retry_after_ms=True),
        False,
        "retry_after_ms must be an integer or null",
    ),
    (
        "error-details-container",
        "error_json",
        _error_payload(details={}),
        False,
        "details must be an array",
    ),
    (
        "error-detail-not-object",
        "error_json",
        _error_payload(details=[1]),
        False,
        "detail must be an object",
    ),
    (
        "error-detail-schema",
        "error_json",
        _error_payload(details=[{"key": "reason"}]),
        False,
        "detail has an unexpected schema",
    ),
    (
        "error-detail-key",
        "error_json",
        _error_payload(details=[{"key": 1, "values": list[object]()}]),
        False,
        "error detail key must be text",
    ),
    ("invalid-json", "error_json", "not-json", True, "Invalid error_json"),
)


@pytest.mark.parametrize(
    ("case_name", "column", "payload", "raw_payload", "message"),
    _STRUCTURED_CORRUPTIONS,
)
def test_structured_persistence_corruption_fails_closed_through_public_reads(
    tmp_path: Path,
    case_name: str,
    column: str,
    payload: object,
    raw_payload: bool,
    message: str,
) -> None:
    case_path = tmp_path / case_name
    case_path.mkdir()
    runtime = make_runtime(case_path)
    if column == "effective_scope_json":
        submission = make_submission(
            runtime,
            client_message_id="client-structured-corruption",
            suffix="structured-corruption",
        )
        run = claim_and_scope(runtime, submission)
    else:
        run = fail_retriable_submission(runtime, suffix="structured-corruption")
    serialized = str(payload) if raw_payload else _canonical_test_json(payload)
    with runtime.database.connect() as connection:
        if raw_payload:
            _ = connection.execute("PRAGMA ignore_check_constraints = ON")
        _ = connection.execute(
            f"UPDATE chat_runs SET {column} = ? WHERE id = ?",
            (serialized, run.id),
        )

    with pytest.raises(ValueError, match=message):
        _ = runtime.repository.get_run(run.id)


def test_error_details_round_trip_and_inconsistent_reference_location_fails_closed(
    tmp_path: Path,
) -> None:
    error_path = tmp_path / "error-details"
    error_path.mkdir()
    error_runtime = make_runtime(error_path)
    failed = fail_retriable_submission(error_runtime, suffix="structured-corruption")
    payload = _error_payload(details=[{"key": "source", "values": ["part-0"]}])
    with error_runtime.database.connect(immediate=True) as connection:
        _ = connection.execute(
            "UPDATE chat_runs SET error_json = ? WHERE id = ?",
            (_canonical_test_json(payload), failed.id),
        )
    round_tripped = error_runtime.repository.get_run(failed.id)
    assert round_tripped is not None
    assert round_tripped.error is not None
    assert round_tripped.error.details[0].key == "source"
    assert round_tripped.error.details[0].values == ("part-0",)

    reference_path = tmp_path / "reference-location"
    reference_path.mkdir()
    reference_runtime = make_runtime(reference_path)
    reference_submission = make_submission(
        reference_runtime,
        client_message_id="client-reference-location",
        suffix="reference-location",
    )
    scoped = claim_and_scope(reference_runtime, reference_submission)
    prepared = prepare_attempt(reference_runtime, scoped, suffix="reference-location")
    waiting, _ = reference_runtime.repository.dispatch_provider_attempt(
        scoped.id,
        prepared.id,
        scoped.lease_token,
        now=reference_runtime.now + timedelta(seconds=1),
    )
    finalizing = reference_runtime.repository.persist_phase(
        waiting.id,
        waiting.lease_token,
        ChatRunPhase.FINALIZING,
        now=reference_runtime.now + timedelta(seconds=2),
    )
    reference = ChatReference(
        id="reference-location-corruption",
        message_id=finalizing.assistant_message_id,
        citation_number=1,
        book_id=reference_runtime.book.id,
        document_part_id=reference_runtime.parts[0].id,
        chapter_refs=reference_runtime.parts[0].chapter_refs,
        label="Part 1",
        passage="A local passage.",
        location=ChatReferenceLocation(
            type=ChatReferenceLocationType.PDF_PAGE,
            value="12",
        ),
        created_at=reference_runtime.now + timedelta(seconds=3),
    )
    _ = reference_runtime.repository.finalize_provider_attempt(
        finalizing.id,
        prepared.id,
        finalizing.lease_token,
        assistant_content="A grounded answer [1].",
        provider_conversation_id=_PROVIDER_CONVERSATION_ID,
        references=(reference,),
        now=reference_runtime.now + timedelta(seconds=3),
    )
    with reference_runtime.database.connect() as connection:
        _ = connection.execute("PRAGMA ignore_check_constraints = ON")
        _ = connection.execute(
            "UPDATE chat_references SET location_value = NULL WHERE id = ?",
            (reference.id,),
        )
    with pytest.raises(ValueError, match="location columns are inconsistent"):
        _ = reference_runtime.repository.get_result(finalizing.id)
