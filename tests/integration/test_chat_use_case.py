from __future__ import annotations

import asyncio
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import cast, final

import pytest

from diandianreading.application.ports.chat import (
    ChatExecutionContext,
    ChatIdempotencyConflictError,
    ChatMessageCursor,
    ChatMessagePage,
    ChatRepositoryConflictError,
    ChatRetryResult,
    ChatRunResult,
    ChatSubmission,
    ChatSubmissionDisposition,
    ChatSubmissionResult,
    ConversationBusyError,
    ConversationEnsureResult,
)
from diandianreading.application.ports.knowledge import KnowledgeAnswer, KnowledgeReference
from diandianreading.application.use_cases.chat import (
    ChatUseCase,
    ChatUseCaseError,
    SubmitChatCommand,
)
from diandianreading.domain.chat import (
    ChatContextItem,
    ChatError,
    ChatErrorCode,
    ChatLeaseToken,
    ChatMessagePair,
    ChatProviderAttempt,
    ChatReference,
    ChatRun,
    ChatRunEvent,
    ChatRunEventType,
    ChatRunPhase,
    ChatRunStatus,
    Conversation,
    EffectiveBookScope,
    ProviderAttemptStatus,
    ProviderConversationBinding,
    QueryScope,
    QueryScopeType,
    chat_context_hash,
)
from diandianreading.domain.errors import DiandianError, ErrorCode, InvalidStateTransition
from diandianreading.domain.models import (
    Book,
    BookStatus,
    CredentialRef,
    DocumentPart,
    ExternalSource,
    KnowledgeStatus,
    StorageKey,
    WorkspaceRef,
)
from tests.support import FIXED_NOW


class InjectedCrash(BaseException):
    """Simulate process death, which application ``except Exception`` must not catch."""


@dataclass(slots=True)
class MutableClock:
    current: datetime = FIXED_NOW

    def __call__(self) -> datetime:
        return self.current

    def advance(self, delta: timedelta) -> None:
        self.current += delta


@final
class SequentialIds:
    def __init__(self) -> None:
        self._value = 0

    def __call__(self) -> str:
        self._value += 1
        return f"chat-local-{self._value}"


@dataclass(frozen=True, slots=True)
class AskCall:
    workspace_id: str
    question: str
    external_source_ids: tuple[str, ...] | None
    provider_conversation_id: str | None


@final
class FakeKnowledge:
    def __init__(self) -> None:
        self.healthy = True
        self.failure: BaseException | None = None
        self.health_failure: Exception | None = None
        self.health_callback: Callable[[], None] | None = None
        self.ask_callback: Callable[[], None] | None = None
        self.calls: list[AskCall] = []
        self.answer = KnowledgeAnswer(
            answer="A grounded whole-book answer [1].",
            conversation_id="provider-conversation-secret",
            references=(
                KnowledgeReference(
                    external_source_id="provider-source-secret-1",
                    document_part_id="part-1",
                    excerpt="A cited passage from the first Part.",
                ),
            ),
        )

    async def credential_is_healthy(self, credential: CredentialRef) -> bool:
        assert credential.provider == "notebooklm"
        if self.health_callback is not None:
            self.health_callback()
        if self.health_failure is not None:
            raise self.health_failure
        return self.healthy

    async def ask(
        self,
        workspace: WorkspaceRef,
        question: str,
        external_source_ids: Sequence[str] | None,
        provider_conversation_id: str | None,
    ) -> KnowledgeAnswer:
        self.calls.append(
            AskCall(
                workspace_id=workspace.id,
                question=question,
                external_source_ids=(
                    None if external_source_ids is None else tuple(external_source_ids)
                ),
                provider_conversation_id=provider_conversation_id,
            )
        )
        if self.ask_callback is not None:
            self.ask_callback()
        if self.failure is not None:
            raise self.failure
        return self.answer


@dataclass(frozen=True, slots=True)
class FutureKnowledgeReference:
    external_source_id: str
    document_part_id: str | None
    excerpt: str | None
    citation_number: int


@final
class FakeChatRepository:
    """Transaction-shaped in-memory fake used only to exercise the application contract."""

    def __init__(self) -> None:
        self.book = Book(
            id="book-1",
            title="Durable Reading",
            author="Test Author",
            source_hash="book-source-hash",
            status=BookStatus.READY,
            created_at=FIXED_NOW,
            updated_at=FIXED_NOW,
        )
        self.workspace = WorkspaceRef(
            id="workspace-local-1",
            provider="notebooklm",
            external_id="provider-workspace-secret",
            status=KnowledgeStatus.READY,
        )
        self.credential = CredentialRef(provider="notebooklm", profile="default")
        self.parts = (
            DocumentPart(
                id="part-1",
                asset_id="asset-1",
                sequence=0,
                storage_key=StorageKey("parts/asset-1/0000"),
                mime_type="text/markdown",
                word_count=100,
                sha256="part-hash-1",
                chapter_refs=("chapter-1",),
                size_bytes=1_000,
            ),
            DocumentPart(
                id="part-2",
                asset_id="asset-1",
                sequence=1,
                storage_key=StorageKey("parts/asset-1/0001"),
                mime_type="text/markdown",
                word_count=120,
                sha256="part-hash-2",
                chapter_refs=("chapter-2",),
                size_bytes=1_200,
            ),
        )
        self.sources: tuple[ExternalSource, ...] = (
            ExternalSource(
                id="source-local-1",
                workspace_id=self.workspace.id,
                document_part_id="part-1",
                external_id="provider-source-secret-1",
                checksum="part-hash-1",
                status=KnowledgeStatus.READY,
                created_at=FIXED_NOW,
                updated_at=FIXED_NOW,
            ),
            ExternalSource(
                id="source-local-2",
                workspace_id=self.workspace.id,
                document_part_id="part-2",
                external_id="provider-source-secret-2",
                checksum="part-hash-2",
                status=KnowledgeStatus.READY,
                created_at=FIXED_NOW,
                updated_at=FIXED_NOW,
            ),
        )
        self.conversations: dict[str, Conversation] = {}
        self.conversation_by_book: dict[str, str] = {}
        self.bindings: dict[str, ProviderConversationBinding] = {}
        self.runs: dict[str, ChatRun] = {}
        self.messages_by_run: dict[str, ChatMessagePair] = {}
        self.run_by_client_key: dict[tuple[str, str], str] = {}
        self.attempts: dict[tuple[str, int], ChatProviderAttempt] = {}
        self.references: dict[str, tuple[ChatReference, ...]] = {}
        self.contexts: dict[str, tuple[ChatContextItem, ...]] = {}
        self.events: list[ChatRunEvent] = []
        self.retry_keys: dict[tuple[str, str], int] = {}
        self.prepare_callback: Callable[[], None] | None = None
        self._next_event_id = 1

    def ensure_conversation(
        self,
        *,
        book_id: str,
        conversation_id: str,
        now: datetime,
        title: str | None = None,
    ) -> ConversationEnsureResult:
        if book_id != self.book.id:
            raise KeyError(book_id)
        if self.workspace.status is not KnowledgeStatus.READY:
            raise ChatRepositoryConflictError("Book ExternalWorkspace is not ready")
        existing_id = self.conversation_by_book.get(book_id)
        if existing_id is not None:
            return ConversationEnsureResult(self.conversations[existing_id], created=False)
        conversation = Conversation.create(
            conversation_id=conversation_id,
            book_id=book_id,
            workspace_id=self.workspace.id,
            title=title,
            now=now,
        )
        binding = ProviderConversationBinding.create(
            conversation_id=conversation.id,
            provider=self.credential.provider,
            now=now,
        )
        self.conversations[conversation.id] = conversation
        self.conversation_by_book[book_id] = conversation.id
        self.bindings[conversation.id] = binding
        return ConversationEnsureResult(conversation, created=True)

    def get_conversation(self, conversation_id: str) -> Conversation | None:
        return self.conversations.get(conversation_id)

    def get_conversation_for_book(self, book_id: str) -> Conversation | None:
        conversation_id = self.conversation_by_book.get(book_id)
        return self.conversations.get(conversation_id) if conversation_id is not None else None

    def get_active_run(self, conversation_id: str) -> ChatRun | None:
        return next(
            (
                run
                for run in self.runs.values()
                if run.conversation_id == conversation_id and not run.is_terminal
            ),
            None,
        )

    def get_execution_context(self, run_id: str) -> ChatExecutionContext | None:
        run = self.runs.get(run_id)
        pair = self.messages_by_run.get(run_id)
        if run is None or pair is None:
            return None
        conversation = self.conversations[run.conversation_id]
        return ChatExecutionContext(
            conversation=conversation,
            binding=self.bindings[conversation.id],
            run=run,
            messages=pair,
            book=self.book,
            workspace=self.workspace,
            sources=self.sources,
            parts=self.parts,
            credential=self.credential,
            provider_attempt=self.attempts.get((run.id, run.attempt)),
            context_items=self.contexts.get(run.id, ()),
        )

    def submit(self, submission: ChatSubmission) -> ChatSubmissionResult:
        run = submission.run
        key = (run.conversation_id, run.client_message_id)
        existing_id = self.run_by_client_key.get(key)
        if existing_id is not None:
            existing = self.runs[existing_id]
            if existing.request_fingerprint != run.request_fingerprint:
                raise ChatIdempotencyConflictError
            return ChatSubmissionResult(
                messages=self.messages_by_run[existing.id],
                run=existing,
                disposition=ChatSubmissionDisposition.REPLAYED,
            )
        active = next(
            (
                candidate
                for candidate in self.runs.values()
                if candidate.conversation_id == run.conversation_id and not candidate.is_terminal
            ),
            None,
        )
        if active is not None:
            raise ConversationBusyError(active.id)
        self.runs[run.id] = run
        self.messages_by_run[run.id] = submission.messages
        self.run_by_client_key[key] = run.id
        self.references[run.id] = ()
        if submission.context:
            self.contexts[run.id] = submission.context
        self._append_event(run, ChatRunEventType.UPDATED)
        return ChatSubmissionResult(
            messages=submission.messages,
            run=run,
            disposition=ChatSubmissionDisposition.CREATED,
        )

    def list_messages(
        self,
        conversation_id: str,
        *,
        before: ChatMessageCursor | None,
        limit: int,
    ) -> ChatMessagePage:
        messages = sorted(
            (
                message
                for pair in self.messages_by_run.values()
                for message in (pair.user, pair.assistant)
                if message.conversation_id == conversation_id
            ),
            key=lambda message: (message.created_at, message.id),
            reverse=True,
        )
        if before is not None:
            messages = [
                message
                for message in messages
                if (message.created_at, message.id) < (before.created_at, before.message_id)
            ]
        selected = messages[:limit]
        page = tuple(reversed(selected))
        next_cursor = (
            ChatMessageCursor(page[0].created_at, page[0].id)
            if len(messages) > limit and page
            else None
        )
        return ChatMessagePage(page, next_cursor)

    def get_run(self, run_id: str) -> ChatRun | None:
        return self.runs.get(run_id)

    def get_result(self, run_id: str) -> ChatRunResult | None:
        run = self.runs.get(run_id)
        pair = self.messages_by_run.get(run_id)
        if run is None or pair is None:
            return None
        return ChatRunResult(run, pair.assistant, self.references.get(run_id, ()))

    def claim(
        self,
        run_id: str,
        owner: str,
        *,
        lease_expires_at: datetime,
        now: datetime,
    ) -> ChatRun:
        current = self._require_run(run_id)
        claimed = current.claim(owner, lease_expires_at=lease_expires_at, now=now)
        self._save_run(claimed)
        return claimed

    def claim_next(
        self,
        owner: str,
        *,
        lease_expires_at: datetime,
        now: datetime,
    ) -> ChatRun | None:
        queued = sorted(
            (run for run in self.runs.values() if run.status is ChatRunStatus.QUEUED),
            key=lambda run: (run.created_at, run.id),
        )
        if not queued:
            return None
        return self.claim(
            queued[0].id,
            owner,
            lease_expires_at=lease_expires_at,
            now=now,
        )

    def takeover(
        self,
        run_id: str,
        owner: str,
        *,
        lease_expires_at: datetime,
        now: datetime,
    ) -> ChatRun:
        current = self._require_run(run_id)
        taken_over = current.take_over_expired_lease(
            owner,
            lease_expires_at=lease_expires_at,
            now=now,
        )
        self._save_run(taken_over)
        return taken_over

    def heartbeat(
        self,
        run_id: str,
        token: ChatLeaseToken,
        *,
        lease_expires_at: datetime,
        now: datetime,
    ) -> ChatRun:
        current = self._require_run(run_id)
        renewed = current.heartbeat(token, lease_expires_at=lease_expires_at, now=now)
        self._save_run(renewed)
        return renewed

    def persist_effective_scope(
        self,
        run_id: str,
        token: ChatLeaseToken,
        scope: EffectiveBookScope,
        *,
        now: datetime,
    ) -> ChatRun:
        current = self._require_run(run_id)
        updated = current.record_effective_scope(scope, token, now=now)
        self._save_run(updated)
        return updated

    def persist_context_snapshot(
        self,
        run_id: str,
        token: ChatLeaseToken,
        items: tuple[ChatContextItem, ...],
        *,
        now: datetime,
    ) -> ChatRun:
        current = self._require_run(run_id)
        updated = current.record_context_snapshot(chat_context_hash(items), token, now=now)
        if updated is not current:
            self.contexts[run_id] = items
            self._save_run(updated)
        return updated

    def persist_phase(
        self,
        run_id: str,
        token: ChatLeaseToken,
        phase: ChatRunPhase,
        *,
        now: datetime,
    ) -> ChatRun:
        current = self._require_run(run_id)
        if phase is ChatRunPhase.WAITING_FOR_PROVIDER:
            updated = current.begin_provider_wait(token, now=now)
        elif phase is ChatRunPhase.RECONCILING:
            updated = current.begin_reconciling(token, now=now)
        elif phase is ChatRunPhase.FINALIZING:
            updated = current.begin_finalizing(token, now=now)
        else:
            raise ValueError("Repository cannot move a running Run back to resolving_scope")
        if updated is not current:
            self._save_run(updated)
        return updated

    def prepare_provider_attempt(
        self,
        intent: ChatProviderAttempt,
        token: ChatLeaseToken,
    ) -> ChatProviderAttempt:
        run = self._require_run(intent.chat_run_id)
        run.assert_lease(token)
        key = (run.id, run.attempt)
        existing = self.attempts.get(key)
        if existing is not None:
            if (
                existing.request_fingerprint != intent.request_fingerprint
                or existing.provider != intent.provider
            ):
                raise ChatRepositoryConflictError("Provider attempt fingerprint changed")
            return existing
        self.attempts[key] = intent
        if self.prepare_callback is not None:
            self.prepare_callback()
        return intent

    def dispatch_provider_attempt(
        self,
        run_id: str,
        intent_id: str,
        token: ChatLeaseToken,
        *,
        now: datetime,
    ) -> tuple[ChatRun, ChatProviderAttempt]:
        run = self._require_run(run_id)
        run.assert_lease(token)
        attempt = self._require_attempt(run)
        if attempt.id != intent_id:
            raise ChatRepositoryConflictError("Provider attempt ID changed")
        dispatched_attempt = attempt.dispatch(now=now)
        waiting = run.begin_provider_wait(token, now=now)
        self.attempts[(run.id, run.attempt)] = dispatched_attempt
        self._save_run(waiting)
        return waiting, dispatched_attempt

    def terminate_provider_attempt(
        self,
        run_id: str,
        intent_id: str,
        token: ChatLeaseToken,
        status: ProviderAttemptStatus,
        *,
        now: datetime,
    ) -> ChatProviderAttempt:
        run = self._require_run(run_id)
        run.assert_lease(token)
        attempt = self._require_attempt(run)
        if attempt.id != intent_id:
            raise ChatRepositoryConflictError("Provider attempt ID changed")
        if status is ProviderAttemptStatus.AMBIGUOUS:
            terminal = attempt.mark_ambiguous(now=now)
        elif status is ProviderAttemptStatus.FAILED_TERMINAL:
            terminal = attempt.fail_terminal(now=now)
        else:
            raise ValueError("Unsupported Provider attempt terminal status")
        self.attempts[(run.id, run.attempt)] = terminal
        return terminal

    def finalize_provider_attempt(
        self,
        run_id: str,
        intent_id: str,
        token: ChatLeaseToken,
        *,
        assistant_content: str,
        provider_conversation_id: str,
        references: tuple[ChatReference, ...],
        now: datetime,
    ) -> ChatRunResult:
        run = self._require_run(run_id)
        run.assert_lease(token)
        attempt = self._require_attempt(run)
        if attempt.id != intent_id:
            raise ChatRepositoryConflictError("Provider attempt ID changed")
        pair = self.messages_by_run[run.id]
        assistant = pair.assistant.complete(assistant_content, now=now)
        binding = self.bindings[run.conversation_id].bind(provider_conversation_id, now=now)
        for reference in references:
            if reference.message_id != assistant.id:
                raise ChatRepositoryConflictError("Reference is bound to another Message")
        completed = run.complete(token, now=now)
        succeeded = attempt.succeed(now=now)

        self.messages_by_run[run.id] = ChatMessagePair(pair.user, assistant)
        self.bindings[run.conversation_id] = binding
        self.references[run.id] = references
        self.attempts[(run.id, run.attempt)] = succeeded
        self._save_run(completed, ChatRunEventType.COMPLETED)
        return ChatRunResult(completed, assistant, references)

    def fail(
        self,
        run_id: str,
        token: ChatLeaseToken,
        error: ChatError,
        *,
        now: datetime,
    ) -> ChatRun:
        current = self._require_run(run_id)
        failed = current.fail(error, token, now=now)
        self._save_run(failed, ChatRunEventType.FAILED)
        return failed

    def request_cancel(self, run_id: str, *, now: datetime) -> ChatRun:
        current = self._require_run(run_id)
        requested = current.request_cancellation(now=now)
        if requested is not current:
            self._save_run(requested)
        return requested

    def cancel(
        self,
        run_id: str,
        token: ChatLeaseToken | None,
        *,
        now: datetime,
    ) -> ChatRun:
        current = self._require_run(run_id)
        attempt = self.attempts.get((current.id, current.attempt))
        if attempt is not None and attempt.status is ProviderAttemptStatus.PREPARED:
            self.attempts[(current.id, current.attempt)] = attempt.fail_terminal(now=now)
        cancelled = current.cancel(token=token, now=now)
        self._save_run(cancelled, ChatRunEventType.CANCELLED)
        return cancelled

    def retry(
        self,
        run_id: str,
        client_retry_id: str,
        *,
        now: datetime,
    ) -> ChatRetryResult:
        key = (run_id, client_retry_id)
        if key in self.retry_keys:
            return ChatRetryResult(self._require_run(run_id), client_retry_id, replayed=True)
        current = self._require_run(run_id)
        retried = current.retry(now=now)
        self.retry_keys[key] = retried.attempt
        self._save_run(retried)
        return ChatRetryResult(retried, client_retry_id, replayed=False)

    def list_events_after(
        self,
        run_id: str,
        *,
        after_event_id: int | None,
        limit: int,
    ) -> tuple[ChatRunEvent, ...]:
        cursor = after_event_id or 0
        return tuple(
            event for event in self.events if event.chat_run_id == run_id and event.id > cursor
        )[:limit]

    def _require_run(self, run_id: str) -> ChatRun:
        try:
            return self.runs[run_id]
        except KeyError as error:
            raise KeyError(run_id) from error

    def _require_attempt(self, run: ChatRun) -> ChatProviderAttempt:
        try:
            return self.attempts[(run.id, run.attempt)]
        except KeyError as error:
            raise ChatRepositoryConflictError("Provider attempt is unavailable") from error

    def _save_run(
        self,
        run: ChatRun,
        event_type: ChatRunEventType = ChatRunEventType.UPDATED,
    ) -> None:
        self.runs[run.id] = run
        self._append_event(run, event_type)

    def _append_event(self, run: ChatRun, event_type: ChatRunEventType) -> None:
        event = ChatRunEvent.from_run(
            event_id=self._next_event_id,
            run=run,
            event_type=event_type,
            now=run.updated_at,
        )
        self._next_event_id += 1
        self.events.append(event)


@dataclass(frozen=True, slots=True)
class Runtime:
    use_case: ChatUseCase
    repository: FakeChatRepository
    knowledge: FakeKnowledge
    clock: MutableClock
    conversation: Conversation


def make_runtime() -> Runtime:
    repository = FakeChatRepository()
    knowledge = FakeKnowledge()
    clock = MutableClock()
    use_case = ChatUseCase(
        repository=repository,
        knowledge_query=knowledge,
        knowledge_health=knowledge,
        id_factory=SequentialIds(),
        clock=clock,
        lease_duration=timedelta(seconds=5),
    )
    ensured = use_case.ensure_conversation("book-1")
    return Runtime(use_case, repository, knowledge, clock, ensured.conversation)


def submit(runtime: Runtime, *, client_id: str = "client-message-1", question: str = "Why?"):
    return runtime.use_case.submit(
        SubmitChatCommand(
            conversation_id=runtime.conversation.id,
            client_message_id=client_id,
            idempotency_key=client_id,
            question=question,
            query_scope=QueryScope.book(),
        )
    )


def expected_scope() -> EffectiveBookScope:
    return EffectiveBookScope(
        type=QueryScopeType.BOOK,
        book_id="book-1",
        document_part_ids=("part-1", "part-2"),
        chapter_refs=("chapter-1", "chapter-2"),
        source_labels=("Part 1", "Part 2"),
    )


def test_whole_book_turn_persists_ordered_intent_scope_answer_binding_and_local_citation() -> None:
    runtime = make_runtime()
    submitted = submit(runtime, question="  What is the main argument?  ")
    assert submitted.disposition is ChatSubmissionDisposition.CREATED
    assert submitted.run.status is ChatRunStatus.QUEUED
    assert submitted.run.attempt == 1
    assert submitted.run.version == 0
    assert runtime.knowledge.calls == []

    def assert_dispatch_was_durable_before_ask() -> None:
        run = runtime.repository.get_run(submitted.run.id)
        assert run is not None
        assert run.phase is ChatRunPhase.WAITING_FOR_PROVIDER
        assert run.effective_scope == expected_scope()
        attempt = runtime.repository.attempts[(run.id, run.attempt)]
        assert attempt.status is ProviderAttemptStatus.DISPATCHED

    runtime.knowledge.ask_callback = assert_dispatch_was_durable_before_ask
    result = asyncio.run(runtime.use_case.run(submitted.run.id, worker_id="worker-a"))

    assert result.run.status is ChatRunStatus.COMPLETED
    assert result.run.phase is None
    assert result.run.effective_scope == expected_scope()
    assert result.assistant_message.content == "A grounded whole-book answer [1]."
    assert result.references[0].citation_number == 1
    assert result.references[0].book_id == "book-1"
    assert result.references[0].document_part_id == "part-1"
    assert not hasattr(result.references[0], "external_source_id")
    assert runtime.repository.bindings[runtime.conversation.id].provider_conversation_id == (
        "provider-conversation-secret"
    )
    attempt = runtime.repository.attempts[(result.run.id, 1)]
    assert attempt.status is ProviderAttemptStatus.SUCCEEDED

    assert runtime.knowledge.calls == [
        AskCall(
            workspace_id="workspace-local-1",
            question="What is the main argument?",
            external_source_ids=("provider-source-secret-1", "provider-source-secret-2"),
            provider_conversation_id=None,
        )
    ]
    public_snapshot = repr(result)
    assert "provider-conversation-secret" not in public_snapshot
    assert "provider-source-secret" not in public_snapshot
    assert "provider-workspace-secret" not in public_snapshot

    events = runtime.use_case.list_events(result.run.id)
    assert [(event.status, event.phase) for event in events] == [
        (ChatRunStatus.QUEUED, None),
        (ChatRunStatus.RUNNING, ChatRunPhase.RESOLVING_SCOPE),
        (ChatRunStatus.RUNNING, ChatRunPhase.RESOLVING_SCOPE),
        (ChatRunStatus.RUNNING, ChatRunPhase.WAITING_FOR_PROVIDER),
        (ChatRunStatus.RUNNING, ChatRunPhase.FINALIZING),
        (ChatRunStatus.COMPLETED, None),
    ]
    assert [event.id for event in events] == sorted(event.id for event in events)


def test_subsequent_turn_uses_server_binding_and_book_keeps_one_conversation() -> None:
    runtime = make_runtime()
    first = submit(runtime, client_id="message-1")
    _ = asyncio.run(runtime.use_case.run(first.run.id, worker_id="worker-a"))

    ensured_again = runtime.use_case.ensure_conversation("book-1")
    assert not ensured_again.created
    assert ensured_again.conversation.id == runtime.conversation.id
    assert len(runtime.repository.conversations) == 1

    second = submit(runtime, client_id="message-2", question="Follow up")
    result = asyncio.run(runtime.use_case.run(second.run.id, worker_id="worker-b"))
    assert result.run.status is ChatRunStatus.COMPLETED
    assert runtime.knowledge.calls[0].provider_conversation_id is None
    assert runtime.knowledge.calls[1].provider_conversation_id == "provider-conversation-secret"


def test_submit_is_canonically_idempotent_and_rejects_conflict_busy_and_non_book_scope() -> None:
    runtime = make_runtime()
    first = submit(runtime, question="cafe\u0301")
    replay = submit(runtime, question="café")
    assert replay.replayed
    assert replay.run.id == first.run.id
    assert len(runtime.repository.runs) == 1
    assert len(runtime.repository.messages_by_run) == 1

    with pytest.raises(ChatUseCaseError) as conflict:
        _ = submit(runtime, question="Different request")
    assert conflict.value.error.code is ChatErrorCode.IDEMPOTENCY_CONFLICT

    with pytest.raises(ChatUseCaseError) as busy:
        _ = submit(runtime, client_id="another-message", question="Second active Turn")
    assert busy.value.error.code is ChatErrorCode.CONVERSATION_BUSY
    assert busy.value.active_run_id == first.run.id

    with pytest.raises(ChatUseCaseError) as unsupported:
        _ = runtime.use_case.submit(
            SubmitChatCommand(
                conversation_id=runtime.conversation.id,
                client_message_id="scope-chapters",
                question="Unsupported scope",
                query_scope=QueryScope(QueryScopeType.CHAPTERS),
            )
        )
    assert unsupported.value.error.code is ChatErrorCode.VALIDATION
    assert "chapter-to-Part" in unsupported.value.error.message
    for scope_type in (QueryScopeType.NOTES, QueryScopeType.SELECTION):
        with pytest.raises(ValueError):
            _ = QueryScope(scope_type)
    assert len(runtime.repository.runs) == 1


def test_question_limits_controls_and_idempotency_header_contract_are_enforced() -> None:
    runtime = make_runtime()
    for question, code in (
        ("bad\x00question", ChatErrorCode.VALIDATION),
        (" ", ChatErrorCode.VALIDATION),
        ("a" * 8_001, ChatErrorCode.PAYLOAD_TOO_LARGE),
    ):
        with pytest.raises(ChatUseCaseError) as rejected:
            _ = runtime.use_case.submit(
                SubmitChatCommand(
                    conversation_id=runtime.conversation.id,
                    client_message_id="invalid-question",
                    question=question,
                )
            )
        assert rejected.value.error.code is code

    with pytest.raises(ChatUseCaseError) as mismatched_key:
        _ = runtime.use_case.submit(
            SubmitChatCommand(
                conversation_id=runtime.conversation.id,
                client_message_id="client-message",
                idempotency_key="different-key",
                question="Valid question",
            )
        )
    assert mismatched_key.value.error.code is ChatErrorCode.VALIDATION
    assert runtime.repository.runs == {}


def remove_all_sources(repository: FakeChatRepository) -> None:
    repository.sources = ()


def mark_first_source_processing(repository: FakeChatRepository) -> None:
    repository.sources = (
        replace(repository.sources[0], status=KnowledgeStatus.PROCESSING),
        *repository.sources[1:],
    )


def mismatch_first_source_checksum(repository: FakeChatRepository) -> None:
    repository.sources = (
        replace(repository.sources[0], checksum="wrong-checksum"),
        *repository.sources[1:],
    )


def remove_second_part_source(repository: FakeChatRepository) -> None:
    repository.sources = repository.sources[:1]


_SOURCE_MUTATORS: tuple[Callable[[FakeChatRepository], None], ...] = (
    remove_all_sources,
    mark_first_source_processing,
    mismatch_first_source_checksum,
    remove_second_part_source,
)


@pytest.mark.parametrize(
    "mutate",
    _SOURCE_MUTATORS,
    ids=("no-sources", "not-ready", "checksum-mismatch", "missing-part-source"),
)
def test_no_not_ready_or_mismatched_sources_fail_before_provider_call(
    mutate: Callable[[FakeChatRepository], None],
) -> None:
    runtime = make_runtime()
    submitted = submit(runtime)
    mutate(runtime.repository)

    with pytest.raises(ChatUseCaseError) as failed:
        _ = asyncio.run(runtime.use_case.run(submitted.run.id, worker_id="worker-a"))

    assert failed.value.error.code is ChatErrorCode.SOURCE_NOT_READY
    assert runtime.knowledge.calls == []
    persisted = runtime.repository.get_run(submitted.run.id)
    assert persisted is not None
    assert persisted.status is ChatRunStatus.FAILED
    assert persisted.error == failed.value.error


def test_unhealthy_credential_fails_after_scope_persistence_without_provider_call() -> None:
    runtime = make_runtime()
    runtime.knowledge.healthy = False
    submitted = submit(runtime)

    with pytest.raises(ChatUseCaseError) as failed:
        _ = asyncio.run(runtime.use_case.run(submitted.run.id, worker_id="worker-a"))

    assert failed.value.error.code is ChatErrorCode.AUTH_REQUIRED
    assert failed.value.error.retriable
    assert runtime.knowledge.calls == []
    persisted = runtime.repository.get_run(submitted.run.id)
    assert persisted is not None
    assert persisted.effective_scope == expected_scope()
    assert (persisted.id, persisted.attempt) not in runtime.repository.attempts


def test_provider_exception_after_dispatch_is_terminal_ambiguous_and_never_leaks_detail() -> None:
    runtime = make_runtime()
    runtime.knowledge.failure = RuntimeError(
        "raw cookie=secret provider-conversation-secret provider-source-secret-1"
    )
    submitted = submit(runtime)

    with pytest.raises(ChatUseCaseError) as failed:
        _ = asyncio.run(runtime.use_case.run(submitted.run.id, worker_id="worker-a"))

    assert failed.value.error.code is ChatErrorCode.AMBIGUOUS_PROVIDER_OUTCOME
    assert not failed.value.error.retriable
    assert "secret" not in failed.value.error.message
    persisted = runtime.repository.get_run(submitted.run.id)
    assert persisted is not None
    assert persisted.status is ChatRunStatus.FAILED
    assert persisted.error == failed.value.error
    attempt = runtime.repository.attempts[(persisted.id, persisted.attempt)]
    assert attempt.status is ProviderAttemptStatus.AMBIGUOUS
    assert len(runtime.knowledge.calls) == 1
    assert any(event.phase is ChatRunPhase.RECONCILING for event in runtime.repository.events)

    with pytest.raises(InvalidStateTransition, match="not retriable"):
        _ = runtime.use_case.retry(persisted.id, "retry-unsafe")


def test_process_crash_after_dispatch_recovers_to_ambiguous_without_second_ask() -> None:
    runtime = make_runtime()
    runtime.knowledge.failure = InjectedCrash("provider request in flight")
    submitted = submit(runtime)

    with pytest.raises(InjectedCrash):
        _ = asyncio.run(runtime.use_case.run(submitted.run.id, worker_id="worker-before-crash"))

    stranded = runtime.repository.get_run(submitted.run.id)
    assert stranded is not None
    assert stranded.status is ChatRunStatus.RUNNING
    assert stranded.phase is ChatRunPhase.WAITING_FOR_PROVIDER
    assert stranded.lease_generation == 1
    assert runtime.repository.attempts[(stranded.id, 1)].status is (
        ProviderAttemptStatus.DISPATCHED
    )
    assert len(runtime.knowledge.calls) == 1

    runtime.knowledge.failure = None
    runtime.clock.advance(timedelta(seconds=6))
    with pytest.raises(ChatUseCaseError) as recovered:
        _ = asyncio.run(runtime.use_case.run(submitted.run.id, worker_id="worker-after-crash"))

    assert recovered.value.error.code is ChatErrorCode.AMBIGUOUS_PROVIDER_OUTCOME
    final = runtime.repository.get_run(submitted.run.id)
    assert final is not None
    assert final.status is ChatRunStatus.FAILED
    assert final.lease_generation == 2
    assert len(runtime.knowledge.calls) == 1


def test_recovered_prepared_but_undispatched_attempt_is_safe_to_execute_once() -> None:
    runtime = make_runtime()
    submitted = submit(runtime)
    claimed = runtime.repository.claim(
        submitted.run.id,
        "worker-before-crash",
        lease_expires_at=runtime.clock() + timedelta(seconds=5),
        now=runtime.clock(),
    )
    scoped = runtime.repository.persist_effective_scope(
        claimed.id,
        claimed.lease_token,
        expected_scope(),
        now=runtime.clock(),
    )
    prepared = ChatProviderAttempt.prepare(
        intent_id="prepared-before-crash",
        chat_run_id=scoped.id,
        run_attempt=scoped.attempt,
        provider="notebooklm",
        request_fingerprint=scoped.request_fingerprint,
        now=runtime.clock(),
    )
    _ = runtime.repository.prepare_provider_attempt(prepared, scoped.lease_token)
    assert runtime.knowledge.calls == []

    runtime.clock.advance(timedelta(seconds=6))
    result = asyncio.run(
        runtime.use_case.run(submitted.run.id, worker_id="worker-after-prepared-crash")
    )

    assert result.run.status is ChatRunStatus.COMPLETED
    assert result.run.lease_generation == 2
    assert len(runtime.knowledge.calls) == 1
    assert runtime.repository.attempts[(result.run.id, 1)].status is (
        ProviderAttemptStatus.SUCCEEDED
    )


def test_current_references_fall_back_to_order_and_future_citation_number_is_preserved() -> None:
    runtime = make_runtime()
    future = cast(
        KnowledgeReference,
        cast(
            object,
            FutureKnowledgeReference(
                external_source_id="provider-source-secret-2",
                document_part_id="part-2",
                excerpt="Future cited passage.",
                citation_number=7,
            ),
        ),
    )
    runtime.knowledge.answer = KnowledgeAnswer(
        answer="Two citations [1] [7].",
        conversation_id="provider-conversation-secret",
        references=(
            KnowledgeReference(
                external_source_id="provider-source-secret-1",
                document_part_id="part-1",
                excerpt="Current reference has no citation_number.",
            ),
            future,
        ),
    )
    submitted = submit(runtime)
    result = asyncio.run(runtime.use_case.run(submitted.run.id, worker_id="worker-a"))

    assert [reference.citation_number for reference in result.references] == [1, 7]
    assert [reference.document_part_id for reference in result.references] == [
        "part-1",
        "part-2",
    ]


def test_invalid_provider_reference_after_dispatch_is_conservatively_ambiguous() -> None:
    runtime = make_runtime()
    runtime.knowledge.answer = KnowledgeAnswer(
        answer="Answer with an invalid citation.",
        conversation_id="provider-conversation-secret",
        references=(
            KnowledgeReference(
                external_source_id="provider-source-outside-book",
                document_part_id=None,
                excerpt="Unmapped",
            ),
        ),
    )
    submitted = submit(runtime)

    with pytest.raises(ChatUseCaseError) as failed:
        _ = asyncio.run(runtime.use_case.run(submitted.run.id, worker_id="worker-a"))

    assert failed.value.error.code is ChatErrorCode.AMBIGUOUS_PROVIDER_OUTCOME
    assert runtime.repository.references[submitted.run.id] == ()
    assert runtime.repository.messages_by_run[submitted.run.id].assistant.content is None
    assert len(runtime.knowledge.calls) == 1


def test_cancellation_during_health_check_stops_at_pre_dispatch_safe_point_without_error() -> None:
    runtime = make_runtime()
    submitted = submit(runtime)

    def request_cancel() -> None:
        _ = runtime.repository.request_cancel(submitted.run.id, now=runtime.clock())

    runtime.knowledge.health_callback = request_cancel
    result = asyncio.run(runtime.use_case.run(submitted.run.id, worker_id="worker-a"))

    assert result.run.status is ChatRunStatus.CANCELLED
    assert result.run.error is None
    assert result.assistant_message.content is None
    assert runtime.knowledge.calls == []
    assert (result.run.id, result.run.attempt) not in runtime.repository.attempts


def test_queued_cancel_is_immediate_error_free_and_retry_reuses_message_pair() -> None:
    runtime = make_runtime()
    cancelled_submission = submit(runtime, client_id="cancel-me")
    cancelled = runtime.use_case.request_cancel(cancelled_submission.run.id)
    assert cancelled.status is ChatRunStatus.CANCELLED
    assert cancelled.error is None

    retry_submission = submit(runtime, client_id="retry-me")
    runtime.knowledge.healthy = False
    with pytest.raises(ChatUseCaseError) as auth_failure:
        _ = asyncio.run(runtime.use_case.run(retry_submission.run.id, worker_id="worker-a"))
    assert auth_failure.value.error.code is ChatErrorCode.AUTH_REQUIRED

    original_pair = runtime.repository.messages_by_run[retry_submission.run.id]
    retry = runtime.use_case.retry(retry_submission.run.id, "client-retry-1")
    replayed_retry = runtime.use_case.retry(retry_submission.run.id, "client-retry-1")
    assert retry.run.attempt == 2
    assert not retry.replayed
    assert replayed_retry.replayed
    assert runtime.repository.messages_by_run[retry_submission.run.id] == original_pair

    runtime.knowledge.healthy = True
    completed = asyncio.run(runtime.use_case.run(retry_submission.run.id, worker_id="worker-b"))
    assert completed.run.status is ChatRunStatus.COMPLETED
    assert completed.run.attempt == 2
    assert (
        len(
            [
                message
                for pair in runtime.repository.messages_by_run.values()
                for message in (pair.user, pair.assistant)
                if message.chat_run_id == completed.run.id
            ]
        )
        == 2
    )


def test_message_and_event_reads_are_bounded_and_cursor_based() -> None:
    runtime = make_runtime()
    submitted = submit(runtime)
    _ = asyncio.run(runtime.use_case.run(submitted.run.id, worker_id="worker-a"))

    messages = runtime.use_case.list_messages(runtime.conversation.id, limit=1)
    assert len(messages.messages) == 1
    assert messages.next_cursor is not None
    events = runtime.use_case.list_events(submitted.run.id, after_event_id=2, limit=2)
    assert len(events) == 2
    assert all(event.id > 2 for event in events)

    with pytest.raises(ValueError, match="between 1 and 100"):
        _ = runtime.use_case.list_messages(runtime.conversation.id, limit=101)
    with pytest.raises(ValueError, match="between 1 and 500"):
        _ = runtime.use_case.list_events(submitted.run.id, limit=501)


def test_constructor_and_conversation_ensure_validation_and_error_mapping() -> None:
    runtime = make_runtime()

    with pytest.raises(ValueError, match="Lease duration must be positive"):
        _ = ChatUseCase(
            repository=runtime.repository,
            knowledge_query=runtime.knowledge,
            knowledge_health=runtime.knowledge,
            lease_duration=timedelta(0),
        )
    with pytest.raises(ValueError, match="title cannot be blank"):
        _ = runtime.use_case.ensure_conversation("book-1", title="  ")
    with pytest.raises(ValueError, match="Book ID is invalid"):
        _ = runtime.use_case.ensure_conversation(" ")

    with pytest.raises(ChatUseCaseError) as missing:
        _ = runtime.use_case.ensure_conversation("missing-book")
    assert missing.value.error.code is ChatErrorCode.NOT_FOUND
    assert missing.value.error.request_id == "missing-book"

    runtime.repository.workspace = replace(
        runtime.repository.workspace,
        status=KnowledgeStatus.PROCESSING,
    )
    with pytest.raises(ChatUseCaseError) as not_ready:
        _ = runtime.use_case.ensure_conversation("book-1")
    assert not_ready.value.error.code is ChatErrorCode.SOURCE_NOT_READY
    assert not_ready.value.error.request_id == "book-1"


def test_public_reads_and_submit_rejections_are_safe_and_typed() -> None:
    runtime = make_runtime()
    assert runtime.use_case.get_conversation(runtime.conversation.id) == runtime.conversation
    assert runtime.use_case.get_conversation("missing-conversation") is None
    assert runtime.use_case.get_conversation_for_book("missing-book") is None
    assert runtime.use_case.get_active_run(runtime.conversation.id) is None
    assert runtime.use_case.get_result("missing-run") is None

    submitted = submit(runtime)
    assert runtime.use_case.get_active_run(runtime.conversation.id) == submitted.run
    assert runtime.use_case.get_result(submitted.run.id) is not None

    missing_runtime = make_runtime()
    with pytest.raises(ChatUseCaseError) as missing:
        _ = missing_runtime.use_case.submit(
            SubmitChatCommand(
                conversation_id="missing-conversation",
                client_message_id="client-missing-conversation",
                question="Where is it?",
            )
        )
    assert missing.value.error.code is ChatErrorCode.NOT_FOUND

    archived_runtime = make_runtime()
    archived = archived_runtime.conversation.archive(now=archived_runtime.clock())
    archived_runtime.repository.conversations[archived.id] = archived
    with pytest.raises(ChatUseCaseError) as archived_error:
        _ = submit(archived_runtime)
    assert archived_error.value.error.code is ChatErrorCode.VALIDATION

    invalid_runtime = make_runtime()
    with pytest.raises(ChatUseCaseError) as invalid_conversation:
        _ = invalid_runtime.use_case.submit(
            SubmitChatCommand(
                conversation_id="",
                client_message_id="client-valid",
                question="Valid question",
                request_id="bad\x00request",
            )
        )
    assert invalid_conversation.value.error.code is ChatErrorCode.VALIDATION
    assert invalid_conversation.value.error.request_id == "chat-request"

    with pytest.raises(ChatUseCaseError) as invalid_client:
        _ = invalid_runtime.use_case.submit(
            SubmitChatCommand(
                conversation_id=invalid_runtime.conversation.id,
                client_message_id="bad\x00client",
                question="Valid question",
                request_id="request-valid",
            )
        )
    assert invalid_client.value.error.code is ChatErrorCode.VALIDATION
    assert invalid_client.value.error.request_id == "request-valid"


def test_execute_terminal_replay_returns_the_durable_result_without_provider_replay() -> None:
    runtime = make_runtime()
    command = SubmitChatCommand(
        conversation_id=runtime.conversation.id,
        client_message_id="client-execute-replay",
        question="Explain the argument",
    )

    first = asyncio.run(runtime.use_case.execute(command, worker_id="worker-first"))
    replay = asyncio.run(runtime.use_case.execute(command, worker_id="worker-replay"))

    assert replay == first
    assert replay.run.status is ChatRunStatus.COMPLETED
    assert len(runtime.knowledge.calls) == 1
    assert len(runtime.repository.runs) == 1


def test_terminal_run_replays_failure_and_fails_closed_when_result_is_missing() -> None:
    failed_runtime = make_runtime()
    failed_runtime.knowledge.healthy = False
    failed_submission = submit(failed_runtime)
    with pytest.raises(ChatUseCaseError) as first_failure:
        _ = asyncio.run(
            failed_runtime.use_case.run(failed_submission.run.id, worker_id="worker-first")
        )
    with pytest.raises(ChatUseCaseError) as replayed_failure:
        _ = asyncio.run(
            failed_runtime.use_case.run(failed_submission.run.id, worker_id="worker-replay")
        )
    assert replayed_failure.value.error == first_failure.value.error
    assert replayed_failure.value.run_id == failed_submission.run.id
    assert failed_runtime.knowledge.calls == []

    missing_result_runtime = make_runtime()
    completed_submission = submit(missing_result_runtime)
    _ = asyncio.run(
        missing_result_runtime.use_case.run(
            completed_submission.run.id,
            worker_id="worker-complete",
        )
    )
    del missing_result_runtime.repository.messages_by_run[completed_submission.run.id]
    with pytest.raises(ChatUseCaseError) as unavailable:
        _ = asyncio.run(
            missing_result_runtime.use_case.run(
                completed_submission.run.id,
                worker_id="worker-read-terminal",
            )
        )
    assert unavailable.value.error.code is ChatErrorCode.UNEXPECTED
    assert unavailable.value.run_id == completed_submission.run.id


def test_run_maps_not_found_active_owner_and_repository_claim_conflict(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    missing_runtime = make_runtime()
    with pytest.raises(ChatUseCaseError) as missing:
        _ = asyncio.run(missing_runtime.use_case.run("missing-run", worker_id="worker-a"))
    assert missing.value.error.code is ChatErrorCode.NOT_FOUND

    busy_runtime = make_runtime()
    busy_submission = submit(busy_runtime)
    claimed = busy_runtime.repository.claim(
        busy_submission.run.id,
        "worker-owner",
        lease_expires_at=busy_runtime.clock() + timedelta(seconds=5),
        now=busy_runtime.clock(),
    )
    with pytest.raises(ChatUseCaseError) as busy:
        _ = asyncio.run(busy_runtime.use_case.run(claimed.id, worker_id="worker-contender"))
    assert busy.value.error.code is ChatErrorCode.CONVERSATION_BUSY
    assert busy.value.run_id == claimed.id
    assert busy.value.active_run_id == claimed.id

    busy_runtime.clock.advance(timedelta(seconds=6))
    taken_over = asyncio.run(busy_runtime.use_case.run(claimed.id, worker_id="worker-after-expiry"))
    assert taken_over.run.status is ChatRunStatus.COMPLETED
    assert taken_over.run.lease_generation == claimed.lease_generation + 1

    conflict_runtime = make_runtime()
    conflict_submission = submit(conflict_runtime)

    def reject_claim(*args: object, **kwargs: object) -> ChatRun:
        del args, kwargs
        raise ChatRepositoryConflictError("concurrent claim")

    monkeypatch.setattr(conflict_runtime.repository, "claim", reject_claim)
    with pytest.raises(ChatUseCaseError) as conflict:
        _ = asyncio.run(
            conflict_runtime.use_case.run(conflict_submission.run.id, worker_id="worker-a")
        )
    assert conflict.value.error.code is ChatErrorCode.CONVERSATION_BUSY
    assert conflict.value.active_run_id == conflict_submission.run.id


def test_heartbeat_retry_and_read_cursor_boundaries_are_validated() -> None:
    runtime = make_runtime()
    submitted = submit(runtime)
    claimed = runtime.repository.claim(
        submitted.run.id,
        "worker-heartbeat",
        lease_expires_at=runtime.clock() + timedelta(seconds=5),
        now=runtime.clock(),
    )
    runtime.clock.advance(timedelta(seconds=1))
    heartbeat = runtime.use_case.heartbeat(claimed.id, claimed.lease_token)
    assert heartbeat.lease_expires_at == runtime.clock() + timedelta(seconds=5)
    assert heartbeat.version == claimed.version + 1
    cancellation_requested = runtime.use_case.request_cancel(heartbeat.id)
    assert cancellation_requested.status is ChatRunStatus.RUNNING
    assert cancellation_requested.cancel_requested_at == runtime.clock()

    for run_id, retry_id, message in (
        ("", "retry-valid", "Chat Run ID is invalid"),
        ("run-valid", "bad\x00retry", "Client retry ID contains"),
    ):
        with pytest.raises(ValueError, match=message):
            _ = runtime.use_case.retry(run_id, retry_id)

    page_runtime = make_runtime()
    page_submission = submit(page_runtime)
    _ = asyncio.run(page_runtime.use_case.run(page_submission.run.id, worker_id="worker-page"))
    first_page = page_runtime.use_case.list_messages(page_runtime.conversation.id, limit=1)
    assert first_page.next_cursor is not None
    second_page = page_runtime.use_case.list_messages(
        page_runtime.conversation.id,
        before=first_page.next_cursor,
        limit=1,
    )
    assert len(second_page.messages) == 1
    assert {first_page.messages[0].id, second_page.messages[0].id} == {
        page_submission.messages.user.id,
        page_submission.messages.assistant.id,
    }

    for limit in (0, 101):
        with pytest.raises(ValueError, match="between 1 and 100"):
            _ = page_runtime.use_case.list_messages(page_runtime.conversation.id, limit=limit)
    with pytest.raises(ValueError, match="cursor cannot be negative"):
        _ = page_runtime.use_case.list_events(page_submission.run.id, after_event_id=-1)
    for limit in (0, 501):
        with pytest.raises(ValueError, match="between 1 and 500"):
            _ = page_runtime.use_case.list_events(page_submission.run.id, limit=limit)


_HEALTH_FAILURE_CASES: tuple[tuple[Exception, ChatErrorCode], ...] = (
    (
        ChatUseCaseError(
            ChatError.safe(
                ChatErrorCode.VALIDATION,
                "Safe upstream validation failure",
                request_id="upstream-request",
            )
        ),
        ChatErrorCode.VALIDATION,
    ),
    (DiandianError(ErrorCode.AUTH_REQUIRED, "raw-provider-secret"), ChatErrorCode.AUTH_REQUIRED),
    (
        DiandianError(ErrorCode.REMOTE_RATE_LIMITED, "raw-provider-secret"),
        ChatErrorCode.REMOTE_RATE_LIMITED,
    ),
    (
        DiandianError(ErrorCode.REMOTE_UNAVAILABLE, "raw-provider-secret"),
        ChatErrorCode.REMOTE_UNAVAILABLE,
    ),
    (
        DiandianError(ErrorCode.REMOTE_PROTOCOL_DRIFT, "raw-provider-secret"),
        ChatErrorCode.REMOTE_PROTOCOL_DRIFT,
    ),
    (
        DiandianError(ErrorCode.SOURCE_PROCESSING_FAILED, "raw-provider-secret"),
        ChatErrorCode.SOURCE_PROCESSING_FAILED,
    ),
    (DiandianError(ErrorCode.VALIDATION, "raw-provider-secret"), ChatErrorCode.VALIDATION),
    (DiandianError(ErrorCode.UNEXPECTED, "raw-provider-secret"), ChatErrorCode.UNEXPECTED),
    (RuntimeError("raw-provider-secret"), ChatErrorCode.UNEXPECTED),
)


@pytest.mark.parametrize(("failure", "expected_code"), _HEALTH_FAILURE_CASES)
def test_health_check_failures_are_safely_mapped_before_provider_dispatch(
    failure: Exception,
    expected_code: ChatErrorCode,
) -> None:
    runtime = make_runtime()
    runtime.knowledge.health_failure = failure
    submitted = submit(runtime)

    with pytest.raises(ChatUseCaseError) as failed:
        _ = asyncio.run(runtime.use_case.run(submitted.run.id, worker_id="worker-health"))

    assert failed.value.error.code is expected_code
    if not isinstance(failure, ChatUseCaseError):
        assert "raw-provider-secret" not in failed.value.error.message
    assert runtime.knowledge.calls == []
    assert (submitted.run.id, submitted.run.attempt) not in runtime.repository.attempts
    persisted = runtime.repository.get_run(submitted.run.id)
    assert persisted is not None
    assert persisted.status is ChatRunStatus.FAILED
    assert persisted.error == failed.value.error


def test_cancellation_is_honored_after_scope_resolution_and_after_attempt_preparation() -> None:
    scoped_runtime = make_runtime()
    scoped_submission = submit(scoped_runtime, client_id="cancel-after-scope")
    claimed = scoped_runtime.repository.claim(
        scoped_submission.run.id,
        "worker-before-cancel",
        lease_expires_at=scoped_runtime.clock() + timedelta(seconds=5),
        now=scoped_runtime.clock(),
    )
    _ = scoped_runtime.repository.request_cancel(claimed.id, now=scoped_runtime.clock())
    scoped_runtime.clock.advance(timedelta(seconds=6))

    cancelled_after_scope = asyncio.run(
        scoped_runtime.use_case.run(claimed.id, worker_id="worker-after-cancel")
    )
    assert cancelled_after_scope.run.status is ChatRunStatus.CANCELLED
    assert cancelled_after_scope.run.effective_scope == expected_scope()
    assert scoped_runtime.knowledge.calls == []
    assert (claimed.id, claimed.attempt) not in scoped_runtime.repository.attempts

    prepared_runtime = make_runtime()
    prepared_submission = submit(prepared_runtime, client_id="cancel-after-prepare")

    def cancel_after_prepare() -> None:
        _ = prepared_runtime.repository.request_cancel(
            prepared_submission.run.id,
            now=prepared_runtime.clock(),
        )

    prepared_runtime.repository.prepare_callback = cancel_after_prepare
    cancelled_after_prepare = asyncio.run(
        prepared_runtime.use_case.run(prepared_submission.run.id, worker_id="worker-prepare")
    )
    assert cancelled_after_prepare.run.status is ChatRunStatus.CANCELLED
    attempt = prepared_runtime.repository.attempts[
        (prepared_submission.run.id, prepared_submission.run.attempt)
    ]
    assert attempt.status is ProviderAttemptStatus.FAILED_TERMINAL
    assert attempt.dispatched_at is None
    assert prepared_runtime.knowledge.calls == []


def test_missing_inconsistent_and_tampered_execution_contexts_fail_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    missing_runtime = make_runtime()
    missing_submission = submit(missing_runtime, client_id="missing-context")
    del missing_runtime.repository.messages_by_run[missing_submission.run.id]
    with pytest.raises(ChatUseCaseError) as missing:
        _ = asyncio.run(
            missing_runtime.use_case.run(missing_submission.run.id, worker_id="worker-missing")
        )
    assert missing.value.error.code is ChatErrorCode.UNEXPECTED

    inconsistent_runtime = make_runtime()
    inconsistent_submission = submit(inconsistent_runtime, client_id="inconsistent-context")
    original_get_context = inconsistent_runtime.repository.get_execution_context

    def inconsistent_context(run_id: str) -> ChatExecutionContext | None:
        context = original_get_context(run_id)
        assert context is not None
        return replace(context, run=replace(context.run, version=context.run.version + 1))

    monkeypatch.setattr(
        inconsistent_runtime.repository,
        "get_execution_context",
        inconsistent_context,
    )
    with pytest.raises(ChatUseCaseError) as inconsistent:
        _ = asyncio.run(
            inconsistent_runtime.use_case.run(
                inconsistent_submission.run.id,
                worker_id="worker-inconsistent",
            )
        )
    assert inconsistent.value.error.code is ChatErrorCode.UNEXPECTED

    tampered_runtime = make_runtime()
    tampered_submission = submit(tampered_runtime, client_id="tampered-command")
    pair = tampered_runtime.repository.messages_by_run[tampered_submission.run.id]
    tampered_runtime.repository.messages_by_run[tampered_submission.run.id] = ChatMessagePair(
        user=replace(pair.user, content="A different persisted question"),
        assistant=pair.assistant,
    )
    with pytest.raises(ChatUseCaseError) as tampered:
        _ = asyncio.run(
            tampered_runtime.use_case.run(
                tampered_submission.run.id,
                worker_id="worker-tampered",
            )
        )
    assert tampered.value.error.code is ChatErrorCode.IDEMPOTENCY_CONFLICT
    assert tampered_runtime.knowledge.calls == []


def archive_context_conversation(repository: FakeChatRepository) -> None:
    conversation = next(iter(repository.conversations.values()))
    repository.conversations[conversation.id] = conversation.archive(now=FIXED_NOW)


def mismatch_context_workspace(repository: FakeChatRepository) -> None:
    conversation = next(iter(repository.conversations.values()))
    repository.conversations[conversation.id] = replace(
        conversation,
        workspace_id="workspace-local-other",
    )


def mismatch_context_provider(repository: FakeChatRepository) -> None:
    repository.credential = replace(repository.credential, provider="different-provider")


def mark_context_book_importing(repository: FakeChatRepository) -> None:
    repository.book = replace(repository.book, status=BookStatus.IMPORTING)


def mark_context_workspace_processing(repository: FakeChatRepository) -> None:
    repository.workspace = replace(repository.workspace, status=KnowledgeStatus.PROCESSING)


def duplicate_context_parts(repository: FakeChatRepository) -> None:
    repository.parts = (repository.parts[0], repository.parts[0])


_CONTEXT_FAILURES: tuple[tuple[Callable[[FakeChatRepository], None], ChatErrorCode], ...] = (
    (archive_context_conversation, ChatErrorCode.VALIDATION),
    (mismatch_context_workspace, ChatErrorCode.SOURCE_NOT_READY),
    (mismatch_context_provider, ChatErrorCode.AUTH_REQUIRED),
    (mark_context_book_importing, ChatErrorCode.SOURCE_NOT_READY),
    (mark_context_workspace_processing, ChatErrorCode.SOURCE_NOT_READY),
    (duplicate_context_parts, ChatErrorCode.SOURCE_NOT_READY),
)


@pytest.mark.parametrize(("mutate", "expected_code"), _CONTEXT_FAILURES)
def test_invalid_execution_context_mappings_fail_before_provider_dispatch(
    mutate: Callable[[FakeChatRepository], None],
    expected_code: ChatErrorCode,
) -> None:
    runtime = make_runtime()
    submitted = submit(runtime)
    mutate(runtime.repository)

    with pytest.raises(ChatUseCaseError) as failed:
        _ = asyncio.run(runtime.use_case.run(submitted.run.id, worker_id="worker-context"))

    assert failed.value.error.code is expected_code
    assert runtime.knowledge.calls == []
    persisted = runtime.repository.get_run(submitted.run.id)
    assert persisted is not None
    assert persisted.status is ChatRunStatus.FAILED


def test_scope_and_provider_attempt_recovery_conflicts_fail_closed() -> None:
    scope_runtime = make_runtime()
    scope_submission = submit(scope_runtime, client_id="scope-changed")
    claimed = scope_runtime.repository.claim(
        scope_submission.run.id,
        "worker-scope-before-crash",
        lease_expires_at=scope_runtime.clock() + timedelta(seconds=5),
        now=scope_runtime.clock(),
    )
    _ = scope_runtime.repository.persist_effective_scope(
        claimed.id,
        claimed.lease_token,
        replace(expected_scope(), source_labels=("Changed Part 1", "Part 2")),
        now=scope_runtime.clock(),
    )
    scope_runtime.clock.advance(timedelta(seconds=6))
    with pytest.raises(ChatUseCaseError) as changed_scope:
        _ = asyncio.run(scope_runtime.use_case.run(claimed.id, worker_id="worker-scope-recovery"))
    assert changed_scope.value.error.code is ChatErrorCode.SOURCE_NOT_READY

    attempt_runtime = make_runtime()
    attempt_submission = submit(attempt_runtime, client_id="attempt-changed")
    attempt_claimed = attempt_runtime.repository.claim(
        attempt_submission.run.id,
        "worker-attempt-before-crash",
        lease_expires_at=attempt_runtime.clock() + timedelta(seconds=5),
        now=attempt_runtime.clock(),
    )
    prepared = ChatProviderAttempt.prepare(
        intent_id="prepared-mismatched",
        chat_run_id=attempt_claimed.id,
        run_attempt=attempt_claimed.attempt,
        provider="notebooklm",
        request_fingerprint=attempt_claimed.request_fingerprint,
        now=attempt_runtime.clock(),
    )
    _ = attempt_runtime.repository.prepare_provider_attempt(
        prepared,
        attempt_claimed.lease_token,
    )
    attempt_runtime.repository.attempts[(attempt_claimed.id, attempt_claimed.attempt)] = replace(
        prepared,
        request_fingerprint="0" * 64,
    )
    attempt_runtime.clock.advance(timedelta(seconds=6))
    with pytest.raises(ChatUseCaseError) as changed_attempt:
        _ = asyncio.run(
            attempt_runtime.use_case.run(
                attempt_claimed.id,
                worker_id="worker-attempt-recovery",
            )
        )
    assert changed_attempt.value.error.code is ChatErrorCode.IDEMPOTENCY_CONFLICT
    assert attempt_runtime.knowledge.calls == []


def test_terminal_or_missing_provider_attempt_recovery_is_conservative() -> None:
    terminal_runtime = make_runtime()
    terminal_submission = submit(terminal_runtime, client_id="terminal-attempt")
    terminal_claimed = terminal_runtime.repository.claim(
        terminal_submission.run.id,
        "worker-terminal-before-crash",
        lease_expires_at=terminal_runtime.clock() + timedelta(seconds=5),
        now=terminal_runtime.clock(),
    )
    prepared = ChatProviderAttempt.prepare(
        intent_id="prepared-terminal",
        chat_run_id=terminal_claimed.id,
        run_attempt=terminal_claimed.attempt,
        provider="notebooklm",
        request_fingerprint=terminal_claimed.request_fingerprint,
        now=terminal_runtime.clock(),
    )
    _ = terminal_runtime.repository.prepare_provider_attempt(
        prepared,
        terminal_claimed.lease_token,
    )
    terminal_runtime.repository.attempts[(terminal_claimed.id, terminal_claimed.attempt)] = (
        prepared.fail_terminal(now=terminal_runtime.clock())
    )
    terminal_runtime.clock.advance(timedelta(seconds=6))
    with pytest.raises(ChatUseCaseError) as terminal:
        _ = asyncio.run(
            terminal_runtime.use_case.run(
                terminal_claimed.id,
                worker_id="worker-terminal-recovery",
            )
        )
    assert terminal.value.error.code is ChatErrorCode.UNEXPECTED
    assert terminal_runtime.knowledge.calls == []

    missing_runtime = make_runtime()
    missing_submission = submit(missing_runtime, client_id="missing-attempt")
    missing_claimed = missing_runtime.repository.claim(
        missing_submission.run.id,
        "worker-missing-before-crash",
        lease_expires_at=missing_runtime.clock() + timedelta(seconds=5),
        now=missing_runtime.clock(),
    )
    missing_scoped = missing_runtime.repository.persist_effective_scope(
        missing_claimed.id,
        missing_claimed.lease_token,
        expected_scope(),
        now=missing_runtime.clock(),
    )
    waiting = missing_runtime.repository.persist_phase(
        missing_scoped.id,
        missing_scoped.lease_token,
        ChatRunPhase.WAITING_FOR_PROVIDER,
        now=missing_runtime.clock(),
    )
    missing_runtime.clock.advance(timedelta(seconds=6))
    with pytest.raises(ChatUseCaseError) as ambiguous:
        _ = asyncio.run(
            missing_runtime.use_case.run(
                waiting.id,
                worker_id="worker-missing-recovery",
            )
        )
    assert ambiguous.value.error.code is ChatErrorCode.AMBIGUOUS_PROVIDER_OUTCOME
    assert not ambiguous.value.error.retriable
    assert missing_runtime.knowledge.calls == []


def test_provider_conversation_binding_failures_are_ambiguous_after_dispatch() -> None:
    missing_runtime = make_runtime()
    missing_runtime.knowledge.answer = replace(
        missing_runtime.knowledge.answer,
        conversation_id=None,
    )
    missing_submission = submit(missing_runtime, client_id="missing-provider-conversation")
    with pytest.raises(ChatUseCaseError) as missing:
        _ = asyncio.run(
            missing_runtime.use_case.run(
                missing_submission.run.id,
                worker_id="worker-missing-provider-conversation",
            )
        )
    assert missing.value.error.code is ChatErrorCode.AMBIGUOUS_PROVIDER_OUTCOME

    mismatch_runtime = make_runtime()
    first = submit(mismatch_runtime, client_id="binding-first")
    _ = asyncio.run(mismatch_runtime.use_case.run(first.run.id, worker_id="worker-first"))
    mismatch_runtime.knowledge.answer = replace(
        mismatch_runtime.knowledge.answer,
        conversation_id="provider-conversation-different",
    )
    second = submit(mismatch_runtime, client_id="binding-second")
    with pytest.raises(ChatUseCaseError) as mismatch:
        _ = asyncio.run(mismatch_runtime.use_case.run(second.run.id, worker_id="worker-second"))
    assert mismatch.value.error.code is ChatErrorCode.AMBIGUOUS_PROVIDER_OUTCOME
    assert len(mismatch_runtime.knowledge.calls) == 2


def test_invalid_future_citation_number_falls_back_and_blank_excerpt_is_omitted() -> None:
    runtime = make_runtime()
    invalid_future_reference = cast(
        KnowledgeReference,
        cast(
            object,
            FutureKnowledgeReference(
                external_source_id="provider-source-secret-1",
                document_part_id="part-1",
                excerpt="   ",
                citation_number=0,
            ),
        ),
    )
    runtime.knowledge.answer = KnowledgeAnswer(
        answer="A grounded answer [1].",
        conversation_id="provider-conversation-secret",
        references=(invalid_future_reference,),
    )
    submitted = submit(runtime, client_id="invalid-future-citation")

    result = asyncio.run(runtime.use_case.run(submitted.run.id, worker_id="worker-citation"))

    assert result.references[0].citation_number == 1
    assert result.references[0].passage is None
