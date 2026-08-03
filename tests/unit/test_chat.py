from __future__ import annotations

from dataclasses import FrozenInstanceError, replace
from datetime import datetime, timedelta
from typing import cast

import pytest

from diandianreading.domain.chat import (
    MAX_QUESTION_CHARS,
    MAX_SAFE_ERROR_CHARS,
    ChatError,
    ChatErrorCode,
    ChatErrorDetail,
    ChatLeaseToken,
    ChatMessage,
    ChatMessagePair,
    ChatMessageRole,
    ChatProviderAttempt,
    ChatReference,
    ChatReferenceLocation,
    ChatReferenceLocationType,
    ChatRun,
    ChatRunEvent,
    ChatRunEventType,
    ChatRunPhase,
    ChatRunStatus,
    Conversation,
    ConversationStatus,
    EffectiveBookScope,
    ProviderAttemptStatus,
    ProviderBindingHealth,
    ProviderConversationBinding,
    QueryScope,
    QueryScopeType,
    chat_request_fingerprint,
    normalize_chat_question,
    utc_now,
)
from diandianreading.domain.errors import InvalidStateTransition
from tests.support import FIXED_NOW

_LEASE = timedelta(minutes=5)
_QUESTION = "What is the book's central argument?"


def make_scope() -> EffectiveBookScope:
    return EffectiveBookScope(
        type=QueryScopeType.BOOK,
        book_id="book-1",
        document_part_ids=("part-1", "part-2"),
        chapter_refs=("chapter-1", "chapter-2"),
        source_labels=("Part 1", "Part 2"),
    )


def make_run(*, scope: QueryScope | None = None) -> ChatRun:
    query_scope = scope or QueryScope.book()
    fingerprint = chat_request_fingerprint(
        "conversation-1",
        "client-message-1",
        _QUESTION,
        query_scope,
    )
    return ChatRun.create(
        run_id="run-1",
        conversation_id="conversation-1",
        client_message_id="client-message-1",
        user_message_id="message-user-1",
        assistant_message_id="message-assistant-1",
        query_scope=query_scope,
        question=_QUESTION,
        request_fingerprint=fingerprint,
        now=FIXED_NOW,
    )


def claim_run(run: ChatRun | None = None, *, owner: str = "worker-a") -> ChatRun:
    return (run or make_run()).claim(
        owner,
        lease_expires_at=FIXED_NOW + _LEASE,
        now=FIXED_NOW,
    )


def dispatch_run() -> ChatRun:
    running = claim_run()
    scoped = running.record_effective_scope(make_scope(), running.lease_token, now=FIXED_NOW)
    return scoped.begin_provider_wait(scoped.lease_token, now=FIXED_NOW)


def make_messages() -> tuple[ChatMessage, ChatMessage]:
    user = ChatMessage.user(
        message_id="message-user-1",
        conversation_id="conversation-1",
        chat_run_id="run-1",
        client_message_id="client-message-1",
        content="A question?",
        now=FIXED_NOW,
    )
    assistant = ChatMessage.assistant_placeholder(
        message_id="message-assistant-1",
        conversation_id="conversation-1",
        chat_run_id="run-1",
        now=FIXED_NOW,
    )
    return user, assistant


def make_provider_attempt() -> ChatProviderAttempt:
    return ChatProviderAttempt.prepare(
        intent_id="provider-attempt-1",
        chat_run_id="run-1",
        run_attempt=1,
        provider="notebooklm",
        request_fingerprint=make_run().request_fingerprint,
        now=FIXED_NOW,
    )


def complete_run() -> ChatRun:
    waiting = dispatch_run()
    finalizing = waiting.begin_finalizing(waiting.lease_token, now=FIXED_NOW)
    return finalizing.complete(finalizing.lease_token, now=FIXED_NOW)


def test_utc_now_returns_an_aware_utc_timestamp() -> None:
    timestamp = utc_now()

    assert timestamp.tzinfo is not None
    assert timestamp.utcoffset() == timedelta(0)


def test_question_validation_and_canonical_request_fingerprint() -> None:
    assert normalize_chat_question("  cafe\u0301\r\nquestion  ") == "café\nquestion"
    assert normalize_chat_question("a" * MAX_QUESTION_CHARS) == "a" * MAX_QUESTION_CHARS

    for invalid in ("", "   ", "bad\x00question", "bad\x7fquestion", "a" * 8_001):
        with pytest.raises(ValueError):
            _ = normalize_chat_question(invalid)

    first = chat_request_fingerprint(
        "conversation-1",
        "message-1",
        "  cafe\u0301\r\nquestion ",
        QueryScope.book(),
    )
    equivalent = chat_request_fingerprint(
        "conversation-1",
        "message-1",
        "café\nquestion",
        QueryScope.book(),
    )
    different = chat_request_fingerprint(
        "conversation-1",
        "message-1",
        "different",
        QueryScope.book(),
    )
    assert first == equivalent
    assert first != different
    assert len(first) == 64


def test_non_book_scopes_are_known_but_explicitly_unsupported() -> None:
    QueryScope.book().require_whole_book()

    for scope_type in (
        QueryScopeType.CHAPTERS,
        QueryScopeType.NOTES,
        QueryScopeType.SELECTION,
    ):
        with pytest.raises(ValueError, match="only whole-book"):
            QueryScope(scope_type).require_whole_book()

    with pytest.raises(ValueError, match="book scope"):
        _ = EffectiveBookScope(
            type=QueryScopeType.CHAPTERS,
            book_id="book-1",
            document_part_ids=("part-1",),
            chapter_refs=(),
            source_labels=("Part 1",),
        )


def test_conversation_and_provider_binding_are_frozen_utc_server_records() -> None:
    conversation = Conversation.create(
        conversation_id="conversation-1",
        book_id="book-1",
        workspace_id="workspace-local-1",
        now=FIXED_NOW,
    )
    assert conversation.status is ConversationStatus.ACTIVE
    assert conversation.version == 0

    archived = conversation.archive(now=FIXED_NOW + timedelta(seconds=1))
    assert archived.status is ConversationStatus.ARCHIVED
    assert archived.version == 1
    assert archived.archive() is archived

    binding = ProviderConversationBinding.create(
        conversation_id=conversation.id,
        provider="notebooklm",
        now=FIXED_NOW,
    )
    assert binding.provider_conversation_id is None
    assert binding.health is ProviderBindingHealth.UNKNOWN

    bound = binding.bind("provider-conversation-secret", now=FIXED_NOW + timedelta(seconds=1))
    assert bound.health is ProviderBindingHealth.ACTIVE
    assert bound.last_verified_at == FIXED_NOW + timedelta(seconds=1)
    assert bound.version == 1
    rebound_at = FIXED_NOW + timedelta(seconds=2)
    rebound = bound.bind("provider-conversation-secret", now=rebound_at)
    assert rebound.provider_conversation_id == bound.provider_conversation_id
    assert rebound.last_verified_at == rebound_at
    assert rebound.version == bound.version + 1
    with pytest.raises(InvalidStateTransition, match="different Conversation ID"):
        _ = bound.bind("another-provider-conversation")

    with pytest.raises(FrozenInstanceError):
        conversation.book_id = "book-2"  # pyright: ignore[reportAttributeAccessIssue]
    with pytest.raises(ValueError, match="aware UTC"):
        _ = replace(conversation, updated_at=datetime(2026, 8, 3, 12, 0))


def test_paired_messages_have_one_user_and_one_assistant_placeholder() -> None:
    user = ChatMessage.user(
        message_id="message-user-1",
        conversation_id="conversation-1",
        chat_run_id="run-1",
        client_message_id="client-message-1",
        content="  A question?  ",
        now=FIXED_NOW,
    )
    assistant = ChatMessage.assistant_placeholder(
        message_id="message-assistant-1",
        conversation_id="conversation-1",
        chat_run_id="run-1",
        now=FIXED_NOW,
    )
    pair = ChatMessagePair(user=user, assistant=assistant)

    assert pair.user.role is ChatMessageRole.USER
    assert pair.user.content == "A question?"
    assert pair.assistant.role is ChatMessageRole.ASSISTANT
    assert pair.assistant.content is None

    completed = assistant.complete("Grounded answer.\n\nMore detail.", now=FIXED_NOW)
    assert completed.content == "Grounded answer.\n\nMore detail."
    assert completed.version == 1
    with pytest.raises(InvalidStateTransition, match="placeholder"):
        _ = completed.complete("Duplicate answer")
    with pytest.raises(ValueError, match="start with a user"):
        _ = ChatMessagePair(user=assistant, assistant=completed)


def test_chat_run_initial_state_and_persisted_invariants_follow_job_conventions() -> None:
    run = make_run()

    assert run.status is ChatRunStatus.QUEUED
    assert run.phase is None
    assert run.attempt == 1
    assert run.version == 0
    assert run.lease_generation == 0
    assert run.error is None
    assert not run.is_terminal

    with pytest.raises(InvalidStateTransition, match="running Chat Run"):
        _ = run.lease_token
    with pytest.raises(ValueError, match="requires a phase"):
        _ = replace(
            run,
            status=ChatRunStatus.RUNNING,
            lease_owner="worker-a",
            lease_expires_at=FIXED_NOW + _LEASE,
            lease_generation=1,
            started_at=FIXED_NOW,
        )
    with pytest.raises(ValueError, match="Only a failed"):
        _ = replace(
            run,
            error=ChatError.safe(ChatErrorCode.UNEXPECTED, "Safe", request_id=run.id),
        )
    with pytest.raises(ValueError, match="completed_at"):
        _ = replace(run, status=ChatRunStatus.CANCELLED)
    with pytest.raises(ValueError, match="attempt starts at one"):
        _ = replace(run, attempt=0)


def test_chat_run_claim_scope_wait_finalize_and_complete_are_explicit_and_fenced() -> None:
    running = claim_run()
    token = running.lease_token
    assert token == ChatLeaseToken("worker-a", 1)
    assert running.phase is ChatRunPhase.RESOLVING_SCOPE
    assert running.started_at == FIXED_NOW

    with pytest.raises(InvalidStateTransition, match="after resolving"):
        _ = running.begin_provider_wait(token)

    scoped = running.record_effective_scope(make_scope(), token, now=FIXED_NOW)
    waiting = scoped.begin_provider_wait(token, now=FIXED_NOW + timedelta(seconds=1))
    finalizing = waiting.begin_finalizing(token, now=FIXED_NOW + timedelta(seconds=2))
    completed = finalizing.complete(token, now=FIXED_NOW + timedelta(seconds=3))

    assert completed.status is ChatRunStatus.COMPLETED
    assert completed.phase is None
    assert completed.effective_scope == make_scope()
    assert completed.completed_at == FIXED_NOW + timedelta(seconds=3)
    assert completed.error is None
    assert completed.lease_owner is None
    assert completed.version == 5

    with pytest.raises(InvalidStateTransition, match="stale"):
        _ = make_run().record_effective_scope(make_scope(), token)


def test_lease_takeover_and_heartbeat_increment_fencing_generation() -> None:
    first_expiry = FIXED_NOW + timedelta(seconds=5)
    first = make_run().claim(
        "worker-a",
        lease_expires_at=first_expiry,
        now=FIXED_NOW,
    )
    stale = first.lease_token

    with pytest.raises(InvalidStateTransition, match="unexpired"):
        _ = first.take_over_expired_lease(
            "worker-b",
            lease_expires_at=FIXED_NOW + _LEASE,
            now=first_expiry - timedelta(microseconds=1),
        )

    taken_over = first.take_over_expired_lease(
        "worker-b",
        lease_expires_at=FIXED_NOW + _LEASE,
        now=first_expiry,
    )
    assert taken_over.lease_token == ChatLeaseToken("worker-b", 2)
    assert taken_over.started_at == first.started_at

    renewed = taken_over.heartbeat(
        taken_over.lease_token,
        lease_expires_at=FIXED_NOW + timedelta(minutes=10),
        now=first_expiry,
    )
    assert renewed.lease_generation == 2
    assert renewed.version == taken_over.version + 1
    with pytest.raises(InvalidStateTransition, match="stale"):
        _ = renewed.heartbeat(
            stale,
            lease_expires_at=FIXED_NOW + timedelta(minutes=11),
            now=first_expiry,
        )


def test_failed_run_retries_only_when_safe_and_ambiguous_is_never_retriable() -> None:
    running = claim_run()
    retriable = ChatError.safe(
        ChatErrorCode.REMOTE_UNAVAILABLE,
        "Provider temporarily unavailable",
        request_id=running.id,
    )
    failed = running.fail(retriable, running.lease_token, now=FIXED_NOW)
    assert failed.status is ChatRunStatus.FAILED
    assert failed.error == retriable
    assert failed.is_terminal

    retried = failed.retry(now=FIXED_NOW + timedelta(seconds=1))
    assert retried.status is ChatRunStatus.QUEUED
    assert retried.attempt == 2
    assert retried.version == failed.version + 1
    assert retried.error is None
    assert retried.completed_at is None

    ambiguous = ChatError.safe(
        ChatErrorCode.AMBIGUOUS_PROVIDER_OUTCOME,
        "Provider outcome is unknown",
        request_id=running.id,
    )
    ambiguous_run = running.fail(ambiguous, running.lease_token, now=FIXED_NOW)
    assert ambiguous_run.error is not None
    assert not ambiguous_run.error.retriable
    with pytest.raises(InvalidStateTransition, match="not retriable"):
        _ = ambiguous_run.retry()
    with pytest.raises(ValueError, match="cannot be retriable"):
        _ = ChatError.safe(
            ChatErrorCode.AMBIGUOUS_PROVIDER_OUTCOME,
            "Unsafe retry",
            request_id="run-1",
            retriable=True,
        )


def test_cancellation_is_error_free_and_only_safe_before_provider_dispatch() -> None:
    queued = make_run().request_cancellation(now=FIXED_NOW)
    cancelled = queued.cancel(now=FIXED_NOW + timedelta(seconds=1))
    assert cancelled.status is ChatRunStatus.CANCELLED
    assert cancelled.error is None
    assert cancelled.completed_at == FIXED_NOW + timedelta(seconds=1)

    running = claim_run().request_cancellation(now=FIXED_NOW)
    with pytest.raises(InvalidStateTransition, match="requires its Lease"):
        _ = running.cancel(now=FIXED_NOW)
    safely_cancelled = running.cancel(token=running.lease_token, now=FIXED_NOW)
    assert safely_cancelled.status is ChatRunStatus.CANCELLED
    assert safely_cancelled.error is None

    dispatched = dispatch_run().request_cancellation(now=FIXED_NOW)
    with pytest.raises(InvalidStateTransition, match="dispatched"):
        _ = dispatched.cancel(token=dispatched.lease_token, now=FIXED_NOW)


def test_provider_attempt_intent_records_prepared_dispatched_and_terminal_outcomes() -> None:
    attempt = ChatProviderAttempt.prepare(
        intent_id="provider-attempt-1",
        chat_run_id="run-1",
        run_attempt=1,
        provider="notebooklm",
        request_fingerprint=make_run().request_fingerprint,
        now=FIXED_NOW,
    )
    assert attempt.status is ProviderAttemptStatus.PREPARED
    assert attempt.version == 0
    assert attempt.dispatched_at is None

    dispatched = attempt.dispatch(now=FIXED_NOW + timedelta(seconds=1))
    assert dispatched.status is ProviderAttemptStatus.DISPATCHED
    assert dispatched.dispatched_at == FIXED_NOW + timedelta(seconds=1)
    assert dispatched.version == 1

    succeeded = dispatched.succeed(now=FIXED_NOW + timedelta(seconds=2))
    assert succeeded.status is ProviderAttemptStatus.SUCCEEDED
    assert succeeded.resolved_at == FIXED_NOW + timedelta(seconds=2)
    assert succeeded.is_terminal

    ambiguous = dispatched.mark_ambiguous(now=FIXED_NOW + timedelta(seconds=2))
    assert ambiguous.status is ProviderAttemptStatus.AMBIGUOUS
    assert ambiguous.is_terminal

    failed_before_dispatch = attempt.fail_terminal(now=FIXED_NOW + timedelta(seconds=1))
    assert failed_before_dispatch.status is ProviderAttemptStatus.FAILED_TERMINAL
    assert failed_before_dispatch.dispatched_at is None
    assert failed_before_dispatch.resolved_at == FIXED_NOW + timedelta(seconds=1)

    with pytest.raises(InvalidStateTransition, match="prepared"):
        _ = dispatched.dispatch()
    with pytest.raises(InvalidStateTransition, match="cannot become"):
        _ = succeeded.mark_ambiguous()


def test_local_reference_preserves_citation_and_events_are_append_only_safe_snapshots() -> None:
    reference = ChatReference(
        id="reference-1",
        message_id="message-assistant-1",
        citation_number=7,
        book_id="book-1",
        document_part_id="part-1",
        chapter_refs=("chapter-1",),
        label="Part 1",
        passage="Cited local passage",
        location=None,
        created_at=FIXED_NOW,
    )
    assert reference.citation_number == 7
    assert not hasattr(reference, "external_source_id")

    waiting = dispatch_run()
    completed = waiting.begin_finalizing(waiting.lease_token, now=FIXED_NOW).complete(
        waiting.lease_token,
        now=FIXED_NOW,
    )
    event = ChatRunEvent.from_run(
        event_id=42,
        run=completed,
        event_type=ChatRunEventType.COMPLETED,
        now=FIXED_NOW,
    )
    assert event.id == 42
    assert event.status is ChatRunStatus.COMPLETED
    assert event.phase is None
    assert event.error is None

    with pytest.raises(FrozenInstanceError):
        event.run_version = 99  # pyright: ignore[reportAttributeAccessIssue]
    with pytest.raises(ValueError, match="type does not match"):
        _ = replace(event, event_type=ChatRunEventType.UPDATED)
    with pytest.raises(ValueError, match="positive"):
        _ = replace(reference, citation_number=0)


@pytest.mark.parametrize("question", (None, 42), ids=("none", "integer"))
def test_question_validation_rejects_non_text_input(question: object) -> None:
    with pytest.raises(TypeError, match="must be text"):
        _ = normalize_chat_question(question)


@pytest.mark.parametrize(
    ("document_part_ids", "chapter_refs", "source_labels", "error_match"),
    (
        (("part-1", "part-2"), (), ("Part 1",), "labels must match"),
        (
            ("part-1", "part-2"),
            ("chapter-1", "chapter-1"),
            ("Part 1", "Part 2"),
            "chapter references must be unique",
        ),
    ),
)
def test_effective_scope_rejects_misaligned_or_duplicate_local_projection(
    document_part_ids: tuple[str, ...],
    chapter_refs: tuple[str, ...],
    source_labels: tuple[str, ...],
    error_match: str,
) -> None:
    with pytest.raises(ValueError, match=error_match):
        _ = EffectiveBookScope(
            type=QueryScopeType.BOOK,
            book_id="book-1",
            document_part_ids=document_part_ids,
            chapter_refs=chapter_refs,
            source_labels=source_labels,
        )


@pytest.mark.parametrize(
    ("changes", "error_match"),
    (
        ({"updated_at": FIXED_NOW - timedelta(microseconds=1)}, "cannot precede"),
        ({"version": -1}, "version cannot be negative"),
    ),
)
def test_conversation_rehydration_rejects_invalid_history(
    changes: dict[str, object],
    error_match: str,
) -> None:
    conversation = Conversation.create(
        conversation_id="conversation-1",
        book_id="book-1",
        workspace_id="workspace-local-1",
        now=FIXED_NOW,
    )

    with pytest.raises(ValueError, match=error_match):
        _ = replace(conversation, **changes)


@pytest.mark.parametrize(
    ("changes", "error_match"),
    (
        ({"context_generation": -1}, "counters cannot be negative"),
        ({"version": -1}, "counters cannot be negative"),
        ({"updated_at": FIXED_NOW - timedelta(microseconds=1)}, "cannot precede"),
        ({"health": ProviderBindingHealth.ACTIVE}, "requires a Provider Conversation ID"),
    ),
)
def test_provider_binding_rehydration_rejects_invalid_state(
    changes: dict[str, object],
    error_match: str,
) -> None:
    binding = ProviderConversationBinding.create(
        conversation_id="conversation-1",
        provider="notebooklm",
        now=FIXED_NOW,
    )

    with pytest.raises(ValueError, match=error_match):
        _ = replace(binding, **changes)


@pytest.mark.parametrize(
    ("identifier", "error_match"),
    (("", "cannot be empty"), ("x" * 513, "is too long")),
)
def test_record_identifiers_enforce_storage_safe_boundaries(
    identifier: str,
    error_match: str,
) -> None:
    with pytest.raises(ValueError, match=error_match):
        _ = Conversation.create(
            conversation_id=identifier,
            book_id="book-1",
            workspace_id="workspace-local-1",
            now=FIXED_NOW,
        )


@pytest.mark.parametrize(
    ("title", "error_type", "error_match"),
    (
        (cast(str, cast(object, 7)), TypeError, "must be text"),
        ("   ", ValueError, "cannot be empty"),
        ("two  spaces", ValueError, "must already be normalized"),
    ),
)
def test_record_display_text_must_be_text_nonempty_and_canonical(
    title: str,
    error_type: type[Exception],
    error_match: str,
) -> None:
    with pytest.raises(error_type, match=error_match):
        _ = Conversation.create(
            conversation_id="conversation-1",
            book_id="book-1",
            workspace_id="workspace-local-1",
            title=title,
            now=FIXED_NOW,
        )


@pytest.mark.parametrize(
    ("record_name", "changes", "error_match"),
    (
        ("user", {"updated_at": FIXED_NOW - timedelta(microseconds=1)}, "cannot precede"),
        ("user", {"version": -1}, "version cannot be negative"),
        ("user", {"content": None}, "requires content"),
        ("user", {"content": " A question? "}, "must be canonical"),
        ("user", {"client_message_id": None}, "requires a client_message_id"),
        ("assistant", {"client_message_id": "client-message-1"}, "cannot have"),
    ),
)
def test_chat_message_rehydration_rejects_role_and_history_violations(
    record_name: str,
    changes: dict[str, object],
    error_match: str,
) -> None:
    user, assistant = make_messages()
    record = user if record_name == "user" else assistant

    with pytest.raises(ValueError, match=error_match):
        _ = replace(record, **changes)


@pytest.mark.parametrize("content", ("", "   "), ids=("empty", "whitespace"))
def test_assistant_completion_rejects_empty_safe_content(content: str) -> None:
    _, assistant = make_messages()

    with pytest.raises(ValueError, match="cannot be empty"):
        _ = assistant.complete(content, now=FIXED_NOW)


def test_message_pair_rejects_a_user_record_in_the_assistant_position() -> None:
    user, _ = make_messages()

    with pytest.raises(ValueError, match="end with an assistant"):
        _ = ChatMessagePair(user=user, assistant=user)


@pytest.mark.parametrize(
    ("changes", "error_match"),
    (
        ({"id": "message-user-1"}, "distinct IDs"),
        ({"conversation_id": "conversation-2"}, "same Conversation and Run"),
        ({"chat_run_id": "run-2"}, "same Conversation and Run"),
    ),
)
def test_message_pair_rejects_identity_or_parent_mismatch(
    changes: dict[str, object],
    error_match: str,
) -> None:
    user, assistant = make_messages()

    with pytest.raises(ValueError, match=error_match):
        _ = ChatMessagePair(user=user, assistant=replace(assistant, **changes))


def test_chat_error_details_validate_keys_and_each_safe_value() -> None:
    empty = ChatErrorDetail(key="sources", values=())
    populated = ChatErrorDetail(key="sources", values=("Part 1", "Part 2"))

    assert empty.values == ()
    assert populated.values == ("Part 1", "Part 2")
    with pytest.raises(ValueError, match="detail key"):
        _ = ChatErrorDetail(key="", values=())
    with pytest.raises(ValueError, match="must already be normalized"):
        _ = ChatErrorDetail(key="sources", values=(" Part 1 ",))


@pytest.mark.parametrize(
    ("case", "error_match"),
    (
        ("long-message", "message is too long"),
        ("negative-retry-delay", "cannot be negative"),
        ("duplicate-detail-keys", "keys must be unique"),
    ),
)
def test_chat_error_rehydration_rejects_unsafe_metadata(case: str, error_match: str) -> None:
    error = ChatError.safe(ChatErrorCode.UNEXPECTED, "Safe error", request_id="run-1")
    changes: dict[str, object]
    if case == "long-message":
        changes = {"message": "x" * (MAX_SAFE_ERROR_CHARS + 1)}
    elif case == "negative-retry-delay":
        changes = {"retry_after_ms": -1}
    else:
        changes = {
            "details": (
                ChatErrorDetail(key="source", values=("Part 1",)),
                ChatErrorDetail(key="source", values=()),
            )
        }

    with pytest.raises(ValueError, match=error_match):
        _ = replace(error, **changes)


@pytest.mark.parametrize("generation", (0, -1), ids=("zero", "negative"))
def test_chat_lease_token_requires_positive_fencing_generation(generation: int) -> None:
    with pytest.raises(ValueError, match="generation must be positive"):
        _ = ChatLeaseToken("worker-a", generation)


@pytest.mark.parametrize(
    ("changes", "error_match"),
    (
        ({"assistant_message_id": "message-user-1"}, "Message IDs must differ"),
        ({"question_hash": "not-a-digest"}, "lowercase SHA-256 digest"),
        ({"updated_at": FIXED_NOW - timedelta(microseconds=1)}, "cannot precede"),
        ({"phase": ChatRunPhase.RESOLVING_SCOPE}, "Only a running Chat Run may have a phase"),
        ({"lease_owner": "worker-a"}, "Only a running Chat Run may hold a Lease"),
        (
            {"status": ChatRunStatus.COMPLETED, "completed_at": FIXED_NOW},
            "requires effective_scope",
        ),
        ({"provider_request_started_at": FIXED_NOW}, "undispatched Chat Run"),
    ),
)
def test_queued_chat_run_rehydration_rejects_inconsistent_state(
    changes: dict[str, object],
    error_match: str,
) -> None:
    with pytest.raises(ValueError, match=error_match):
        _ = replace(make_run(), **changes)


@pytest.mark.parametrize(
    ("changes", "error_match"),
    (
        ({"lease_owner": None}, "requires an owner, expiry, and fencing generation"),
        ({"lease_expires_at": None}, "requires an owner, expiry, and fencing generation"),
        ({"lease_generation": 0}, "requires an owner, expiry, and fencing generation"),
        ({"started_at": None}, "requires started_at"),
        ({"provider_request_started_at": FIXED_NOW}, "undispatched Chat Run"),
    ),
)
def test_running_chat_run_rehydration_rejects_incomplete_lease_or_dispatch_state(
    changes: dict[str, object],
    error_match: str,
) -> None:
    with pytest.raises(ValueError, match=error_match):
        _ = replace(claim_run(), **changes)


@pytest.mark.parametrize(
    "lease_expires_at",
    (FIXED_NOW, FIXED_NOW - timedelta(microseconds=1)),
    ids=("equal-to-now", "past"),
)
def test_chat_run_claim_rejects_nonfuture_lease_expiry(lease_expires_at: datetime) -> None:
    with pytest.raises(ValueError, match="expiry must be in the future"):
        _ = make_run().claim(
            "worker-a",
            lease_expires_at=lease_expires_at,
            now=FIXED_NOW,
        )


def test_chat_run_claim_and_takeover_reject_ineligible_states() -> None:
    running = claim_run()
    cancellation_requested = make_run().request_cancellation(now=FIXED_NOW)

    with pytest.raises(InvalidStateTransition, match="Only a queued"):
        _ = running.claim(
            "worker-b",
            lease_expires_at=FIXED_NOW + _LEASE,
            now=FIXED_NOW,
        )
    with pytest.raises(InvalidStateTransition, match="cancellation-requested"):
        _ = cancellation_requested.claim(
            "worker-a",
            lease_expires_at=FIXED_NOW + _LEASE,
            now=FIXED_NOW,
        )
    with pytest.raises(InvalidStateTransition, match="Only a running"):
        _ = make_run().take_over_expired_lease(
            "worker-b",
            lease_expires_at=FIXED_NOW + _LEASE,
            now=FIXED_NOW,
        )


def test_chat_run_phase_transitions_are_ordered_and_reconciliation_is_idempotent() -> None:
    running = claim_run()
    token = running.lease_token

    with pytest.raises(InvalidStateTransition, match="Only a dispatched"):
        _ = running.begin_reconciling(token, now=FIXED_NOW)
    with pytest.raises(InvalidStateTransition, match="only after a provider outcome"):
        _ = running.begin_finalizing(token, now=FIXED_NOW)

    waiting = dispatch_run()
    with pytest.raises(InvalidStateTransition, match="only while resolving scope"):
        _ = waiting.record_effective_scope(make_scope(), waiting.lease_token, now=FIXED_NOW)

    reconciling = waiting.begin_reconciling(waiting.lease_token, now=FIXED_NOW)
    assert reconciling.phase is ChatRunPhase.RECONCILING
    assert reconciling.begin_reconciling(reconciling.lease_token, now=FIXED_NOW) is reconciling


@pytest.mark.parametrize(
    ("has_scope", "has_dispatch"),
    ((False, True), (True, False)),
    ids=("missing-scope", "missing-dispatch"),
)
def test_chat_run_finalizing_requires_both_scope_and_provider_dispatch(
    has_scope: bool,
    has_dispatch: bool,
) -> None:
    running = claim_run()
    incomplete = replace(
        running,
        phase=ChatRunPhase.WAITING_FOR_PROVIDER,
        effective_scope=make_scope() if has_scope else None,
        provider_request_started_at=FIXED_NOW if has_dispatch else None,
    )

    with pytest.raises(InvalidStateTransition, match="Finalizing requires"):
        _ = incomplete.begin_finalizing(incomplete.lease_token, now=FIXED_NOW)


def test_chat_run_cancellation_requests_are_idempotent_and_terminally_fenced() -> None:
    queued = make_run()
    assert not queued.is_cancel_requested

    requested = queued.request_cancellation(now=FIXED_NOW)
    assert requested.is_cancel_requested
    assert requested.request_cancellation(now=FIXED_NOW + timedelta(seconds=1)) is requested

    cancelled = requested.cancel(now=FIXED_NOW)
    assert cancelled.request_cancellation(now=FIXED_NOW + timedelta(seconds=1)) is cancelled

    with pytest.raises(InvalidStateTransition, match="Cannot cancel a terminal"):
        _ = cancelled.cancel(now=FIXED_NOW)
    with pytest.raises(InvalidStateTransition, match="terminal Chat Run"):
        _ = complete_run().request_cancellation(now=FIXED_NOW)
    with pytest.raises(InvalidStateTransition, match="must be requested first"):
        _ = make_run().cancel(now=FIXED_NOW)


def test_chat_run_retry_and_completion_reject_wrong_states_or_missing_scope() -> None:
    with pytest.raises(InvalidStateTransition, match="Only a failed"):
        _ = make_run().retry(now=FIXED_NOW)

    waiting = dispatch_run()
    with pytest.raises(InvalidStateTransition, match="only while finalizing"):
        _ = waiting.complete(waiting.lease_token, now=FIXED_NOW)

    incomplete = replace(claim_run(), phase=ChatRunPhase.FINALIZING)
    with pytest.raises(InvalidStateTransition, match="requires effective scope"):
        _ = incomplete.complete(incomplete.lease_token, now=FIXED_NOW)


@pytest.mark.parametrize(
    ("changes", "error_match"),
    (
        ({"run_attempt": 0}, "run_attempt starts at one"),
        ({"version": -1}, "run_attempt starts at one"),
        ({"updated_at": FIXED_NOW - timedelta(microseconds=1)}, "cannot precede"),
        ({"status": ProviderAttemptStatus.DISPATCHED}, "requires dispatched_at"),
        ({"dispatched_at": FIXED_NOW}, "prepared Provider attempt cannot have dispatched_at"),
        ({"status": ProviderAttemptStatus.FAILED_TERMINAL}, "terminal Provider attempts"),
        ({"resolved_at": FIXED_NOW}, "terminal Provider attempts"),
    ),
)
def test_provider_attempt_rehydration_rejects_invalid_dispatch_history(
    changes: dict[str, object],
    error_match: str,
) -> None:
    with pytest.raises(ValueError, match=error_match):
        _ = replace(make_provider_attempt(), **changes)


def test_dispatched_provider_attempt_can_record_a_terminal_failure() -> None:
    dispatched = make_provider_attempt().dispatch(now=FIXED_NOW)
    failed = dispatched.fail_terminal(now=FIXED_NOW + timedelta(seconds=1))

    assert failed.status is ProviderAttemptStatus.FAILED_TERMINAL
    assert failed.dispatched_at == FIXED_NOW
    assert failed.resolved_at == FIXED_NOW + timedelta(seconds=1)
    assert failed.version == dispatched.version + 1


@pytest.mark.parametrize(
    ("value", "error_match"),
    (("", "cannot be empty"), (" page 12 ", "must already be normalized")),
)
def test_reference_location_requires_normalized_safe_display_text(
    value: str,
    error_match: str,
) -> None:
    with pytest.raises(ValueError, match=error_match):
        _ = ChatReferenceLocation(ChatReferenceLocationType.PDF_PAGE, value)


def test_reference_accepts_absent_passage_and_rejects_duplicate_or_empty_content() -> None:
    location = ChatReferenceLocation(ChatReferenceLocationType.PDF_PAGE, "12")
    reference = ChatReference(
        id="reference-1",
        message_id="message-assistant-1",
        citation_number=1,
        book_id="book-1",
        document_part_id="part-1",
        chapter_refs=("chapter-1",),
        label="Part 1",
        passage=None,
        location=location,
        created_at=FIXED_NOW,
    )

    assert reference.passage is None
    assert reference.location == location
    with pytest.raises(ValueError, match="chapter_refs must be unique"):
        _ = replace(reference, chapter_refs=("chapter-1", "chapter-1"))
    with pytest.raises(ValueError, match="passage cannot be empty"):
        _ = replace(reference, passage="")


@pytest.mark.parametrize(
    ("case", "error_match"),
    (
        ("nonpositive-id", "ID must be positive"),
        ("negative-version", "version cannot be negative"),
        ("running-without-phase", "phase is present only for running"),
        ("queued-with-phase", "phase is present only for running"),
        ("failed-without-error", "error is present only for failed"),
        ("queued-with-error", "error is present only for failed"),
    ),
)
def test_chat_run_event_rehydration_rejects_inconsistent_snapshot(
    case: str,
    error_match: str,
) -> None:
    event = ChatRunEvent.from_run(
        event_id=1,
        run=make_run(),
        event_type=ChatRunEventType.UPDATED,
        now=FIXED_NOW,
    )
    changes: dict[str, object]
    if case == "nonpositive-id":
        changes = {"id": 0}
    elif case == "negative-version":
        changes = {"run_version": -1}
    elif case == "running-without-phase":
        changes = {"status": ChatRunStatus.RUNNING}
    elif case == "queued-with-phase":
        changes = {"phase": ChatRunPhase.RESOLVING_SCOPE}
    elif case == "failed-without-error":
        changes = {"status": ChatRunStatus.FAILED}
    else:
        changes = {
            "error": ChatError.safe(
                ChatErrorCode.UNEXPECTED,
                "Safe error",
                request_id="run-1",
            )
        }

    with pytest.raises(ValueError, match=error_match):
        _ = replace(event, **changes)
