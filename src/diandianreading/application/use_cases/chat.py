"""Lease-fenced, crash-conservative whole-book durable chat use case."""

from __future__ import annotations

import unicodedata
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import NoReturn, final
from uuid import uuid4

from diandianreading.application.ports.chat import (
    ChatExecutionContext,
    ChatIdempotencyConflictError,
    ChatMessageCursor,
    ChatMessagePage,
    ChatRepository,
    ChatRepositoryConflictError,
    ChatRetryResult,
    ChatRunResult,
    ChatSubmission,
    ChatSubmissionResult,
    ConversationBusyError,
    ConversationEnsureResult,
)
from diandianreading.application.ports.knowledge import (
    KnowledgeAnswer,
    KnowledgeQueryPort,
    KnowledgeReference,
)
from diandianreading.application.ports.reconciliation import KnowledgeHealthPort
from diandianreading.domain.chat import (
    MAX_QUESTION_CHARS,
    ChatError,
    ChatErrorCode,
    ChatLeaseToken,
    ChatMessage,
    ChatMessagePair,
    ChatProviderAttempt,
    ChatReference,
    ChatRun,
    ChatRunEvent,
    ChatRunPhase,
    ChatRunStatus,
    Conversation,
    ConversationStatus,
    EffectiveBookScope,
    ProviderAttemptStatus,
    QueryScope,
    QueryScopeType,
    chat_question_hash,
    chat_request_fingerprint,
    normalize_chat_question,
    utc_now,
)
from diandianreading.domain.errors import DiandianError, ErrorCode
from diandianreading.domain.models import BookStatus, ExternalSource, KnowledgeStatus

_MAX_MESSAGE_PAGE = 100
_MAX_EVENT_PAGE = 500
_QUERYABLE_BOOK_STATUSES = frozenset({BookStatus.READY, BookStatus.READING, BookStatus.COMPLETED})
_POST_DISPATCH_ATTEMPT_STATUSES = frozenset(
    {
        ProviderAttemptStatus.DISPATCHED,
        ProviderAttemptStatus.AMBIGUOUS,
        ProviderAttemptStatus.SUCCEEDED,
    }
)


@dataclass(frozen=True, slots=True)
class SubmitChatCommand:
    conversation_id: str
    client_message_id: str
    question: str
    query_scope: QueryScope = field(default_factory=QueryScope.book)
    idempotency_key: str | None = None
    request_id: str | None = None


@dataclass(frozen=True, slots=True)
class _ResolvedWholeBookQuery:
    question: str
    provider_source_ids: tuple[str, ...]
    effective_scope: EffectiveBookScope


@final
class ChatUseCaseError(Exception):
    """Typed safe application error for rejected or failed Chat commands."""

    def __init__(
        self,
        error: ChatError,
        *,
        run_id: str | None = None,
        active_run_id: str | None = None,
    ) -> None:
        super().__init__(error.message)
        self.error: ChatError = error
        self.run_id: str | None = run_id
        self.active_run_id: str | None = active_run_id


@final
class ChatUseCase:
    """Submit and execute one durable, whole-book Provider Turn at a time."""

    def __init__(
        self,
        *,
        repository: ChatRepository,
        knowledge_query: KnowledgeQueryPort,
        knowledge_health: KnowledgeHealthPort,
        id_factory: Callable[[], str] | None = None,
        clock: Callable[[], datetime] = utc_now,
        lease_duration: timedelta | None = None,
    ) -> None:
        duration = timedelta(seconds=30) if lease_duration is None else lease_duration
        if duration <= timedelta(0):
            raise ValueError("Chat Run Lease duration must be positive")
        self._repository = repository
        self._knowledge_query = knowledge_query
        self._knowledge_health = knowledge_health
        self._id_factory = id_factory or (lambda: str(uuid4()))
        self._clock = clock
        self._lease_duration = duration

    def ensure_conversation(
        self,
        book_id: str,
        *,
        title: str | None = None,
    ) -> ConversationEnsureResult:
        _require_local_id(book_id, "Book ID")
        normalized_title = title.strip() if title is not None else None
        if normalized_title == "":
            raise ValueError("Conversation title cannot be blank")
        try:
            if normalized_title is None:
                return self._repository.ensure_conversation(
                    book_id=book_id,
                    conversation_id=self._id_factory(),
                    now=self._clock(),
                )
            return self._repository.ensure_conversation(
                book_id=book_id,
                conversation_id=self._id_factory(),
                now=self._clock(),
                title=normalized_title,
            )
        except KeyError as error:
            raise ChatUseCaseError(
                ChatError.safe(
                    ChatErrorCode.NOT_FOUND,
                    "Book or its knowledge workspace was not found",
                    request_id=book_id,
                )
            ) from error
        except ChatRepositoryConflictError as error:
            raise ChatUseCaseError(
                ChatError.safe(
                    ChatErrorCode.SOURCE_NOT_READY,
                    "Book knowledge sources are not ready for chat",
                    request_id=book_id,
                )
            ) from error

    def get_conversation(self, conversation_id: str) -> Conversation | None:
        _require_local_id(conversation_id, "Conversation ID")
        return self._repository.get_conversation(conversation_id)

    def get_conversation_for_book(self, book_id: str) -> Conversation | None:
        _require_local_id(book_id, "Book ID")
        return self._repository.get_conversation_for_book(book_id)

    def get_active_run(self, conversation_id: str) -> ChatRun | None:
        _require_local_id(conversation_id, "Conversation ID")
        return self._repository.get_active_run(conversation_id)

    def get_result(self, run_id: str) -> ChatRunResult | None:
        _require_local_id(run_id, "Chat Run ID")
        return self._repository.get_result(run_id)

    def submit(self, command: SubmitChatCommand) -> ChatSubmissionResult:
        request_id = _safe_request_id(command.request_id, command.client_message_id)
        _require_local_id_or_raise(
            command.conversation_id,
            "Conversation ID",
            request_id=request_id,
        )
        _require_local_id_or_raise(
            command.client_message_id,
            "Client message ID",
            request_id=request_id,
        )
        idempotency_key = command.idempotency_key or command.client_message_id
        if idempotency_key != command.client_message_id:
            self._reject(
                ChatErrorCode.VALIDATION,
                "Idempotency key must match client_message_id",
                request_id=request_id,
            )
        try:
            command.query_scope.require_whole_book()
        except ValueError:
            self._reject(
                ChatErrorCode.VALIDATION,
                "Phase 5 chat supports only whole-book scope; chapters, notes, and selection "
                + "are rejected",
                request_id=request_id,
            )
        try:
            question = normalize_chat_question(command.question)
        except (TypeError, ValueError) as error:
            code = (
                ChatErrorCode.PAYLOAD_TOO_LARGE
                if _question_exceeds_limit(command.question)
                else ChatErrorCode.VALIDATION
            )
            message = (
                f"Question cannot exceed {MAX_QUESTION_CHARS} Unicode characters"
                if code is ChatErrorCode.PAYLOAD_TOO_LARGE
                else "Question is empty or contains unsupported control characters"
            )
            raise ChatUseCaseError(ChatError.safe(code, message, request_id=request_id)) from error

        conversation = self._repository.get_conversation(command.conversation_id)
        if conversation is None:
            self._reject(
                ChatErrorCode.NOT_FOUND,
                "Conversation was not found",
                request_id=request_id,
            )
        if conversation.status is not ConversationStatus.ACTIVE:
            self._reject(
                ChatErrorCode.VALIDATION,
                "Archived Conversation cannot accept a new question",
                request_id=request_id,
            )

        fingerprint = chat_request_fingerprint(
            command.conversation_id,
            command.client_message_id,
            question,
            command.query_scope,
        )
        timestamp = self._clock()
        run_id = self._id_factory()
        user_message_id = self._id_factory()
        assistant_message_id = self._id_factory()
        run = ChatRun.create(
            run_id=run_id,
            conversation_id=conversation.id,
            client_message_id=command.client_message_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            query_scope=command.query_scope,
            question=question,
            request_fingerprint=fingerprint,
            now=timestamp,
        )
        messages = ChatMessagePair(
            user=ChatMessage.user(
                message_id=user_message_id,
                conversation_id=conversation.id,
                chat_run_id=run.id,
                client_message_id=command.client_message_id,
                content=question,
                now=timestamp,
            ),
            assistant=ChatMessage.assistant_placeholder(
                message_id=assistant_message_id,
                conversation_id=conversation.id,
                chat_run_id=run.id,
                now=timestamp,
            ),
        )
        try:
            return self._repository.submit(ChatSubmission(messages=messages, run=run))
        except ChatIdempotencyConflictError as error:
            raise ChatUseCaseError(
                ChatError.safe(
                    ChatErrorCode.IDEMPOTENCY_CONFLICT,
                    "client_message_id is already bound to a different request",
                    request_id=request_id,
                )
            ) from error
        except ConversationBusyError as error:
            raise ChatUseCaseError(
                ChatError.safe(
                    ChatErrorCode.CONVERSATION_BUSY,
                    "Conversation already has an active question",
                    request_id=request_id,
                ),
                active_run_id=error.active_run_id,
            ) from error

    async def execute(
        self,
        command: SubmitChatCommand,
        *,
        worker_id: str | None = None,
    ) -> ChatRunResult:
        submitted = self.submit(command)
        if submitted.run.is_terminal:
            return self._terminal_result(submitted.run)
        return await self.run(
            submitted.run.id,
            worker_id=worker_id or f"inline-{submitted.run.id}",
        )

    async def run(self, run_id: str, *, worker_id: str) -> ChatRunResult:
        _require_local_id(run_id, "Chat Run ID")
        _require_local_id(worker_id, "Chat worker ID")
        current = self._repository.get_run(run_id)
        if current is None:
            self._reject(
                ChatErrorCode.NOT_FOUND,
                "Chat Run was not found",
                request_id=run_id,
            )
        if current.is_terminal:
            return self._terminal_result(current)

        now = self._clock()
        try:
            if current.status is ChatRunStatus.QUEUED:
                claimed = self._repository.claim(
                    current.id,
                    worker_id,
                    lease_expires_at=now + self._lease_duration,
                    now=now,
                )
            elif current.lease_expires_at is not None and current.lease_expires_at <= now:
                claimed = self._repository.takeover(
                    current.id,
                    worker_id,
                    lease_expires_at=now + self._lease_duration,
                    now=now,
                )
            else:
                raise ChatUseCaseError(
                    ChatError.safe(
                        ChatErrorCode.CONVERSATION_BUSY,
                        "Chat Run is already owned by an active worker",
                        request_id=run_id,
                    ),
                    run_id=run_id,
                    active_run_id=run_id,
                )
        except ChatRepositoryConflictError as error:
            raise ChatUseCaseError(
                ChatError.safe(
                    ChatErrorCode.CONVERSATION_BUSY,
                    "Chat Run ownership changed concurrently",
                    request_id=run_id,
                ),
                run_id=run_id,
                active_run_id=run_id,
            ) from error
        return await self._execute_claimed(claimed)

    async def run_next(self, *, worker_id: str) -> ChatRunResult | None:
        _require_local_id(worker_id, "Chat worker ID")
        now = self._clock()
        claimed = self._repository.claim_next(
            worker_id,
            lease_expires_at=now + self._lease_duration,
            now=now,
        )
        if claimed is None:
            return None
        return await self._execute_claimed(claimed)

    def heartbeat(self, run_id: str, token: ChatLeaseToken) -> ChatRun:
        now = self._clock()
        return self._repository.heartbeat(
            run_id,
            token,
            lease_expires_at=now + self._lease_duration,
            now=now,
        )

    def request_cancel(self, run_id: str) -> ChatRun:
        now = self._clock()
        requested = self._repository.request_cancel(run_id, now=now)
        if requested.status is ChatRunStatus.QUEUED:
            return self._repository.cancel(run_id, None, now=now)
        return requested

    def retry(self, run_id: str, client_retry_id: str) -> ChatRetryResult:
        _require_local_id(run_id, "Chat Run ID")
        _require_local_id(client_retry_id, "Client retry ID")
        return self._repository.retry(run_id, client_retry_id, now=self._clock())

    def list_messages(
        self,
        conversation_id: str,
        *,
        before: ChatMessageCursor | None = None,
        limit: int = 50,
    ) -> ChatMessagePage:
        if limit < 1 or limit > _MAX_MESSAGE_PAGE:
            raise ValueError(f"Chat Message page limit must be between 1 and {_MAX_MESSAGE_PAGE}")
        return self._repository.list_messages(
            conversation_id,
            before=before,
            limit=limit,
        )

    def list_events(
        self,
        run_id: str,
        *,
        after_event_id: int | None = None,
        limit: int = 100,
    ) -> tuple[ChatRunEvent, ...]:
        if after_event_id is not None and after_event_id < 0:
            raise ValueError("Chat Run Event cursor cannot be negative")
        if limit < 1 or limit > _MAX_EVENT_PAGE:
            raise ValueError(f"Chat Run Event page limit must be between 1 and {_MAX_EVENT_PAGE}")
        return self._repository.list_events_after(
            run_id,
            after_event_id=after_event_id,
            limit=limit,
        )

    async def _execute_claimed(self, claimed: ChatRun) -> ChatRunResult:
        token = claimed.lease_token
        context = self._repository.get_execution_context(claimed.id)
        if context is None:
            self._fail_and_raise(
                claimed,
                token,
                ChatError.safe(
                    ChatErrorCode.UNEXPECTED,
                    "Chat execution context is unavailable",
                    request_id=claimed.id,
                ),
            )
        if context.run.id != claimed.id or context.run.version != claimed.version:
            self._fail_and_raise(
                claimed,
                token,
                ChatError.safe(
                    ChatErrorCode.UNEXPECTED,
                    "Chat execution context is inconsistent",
                    request_id=claimed.id,
                ),
            )
        self._validate_persisted_command(context, claimed, token)

        provider_attempt = context.provider_attempt
        if provider_attempt is not None:
            self._validate_provider_attempt(context, provider_attempt, claimed, token)
            if provider_attempt.status in _POST_DISPATCH_ATTEMPT_STATUSES:
                self._fail_ambiguous(claimed, token, provider_attempt)
            if provider_attempt.status is ProviderAttemptStatus.FAILED_TERMINAL:
                self._fail_and_raise(
                    claimed,
                    token,
                    ChatError.safe(
                        ChatErrorCode.UNEXPECTED,
                        "Chat Provider attempt is already terminal",
                        request_id=claimed.id,
                    ),
                )
        elif (
            claimed.provider_request_started_at is not None
            or claimed.phase is not ChatRunPhase.RESOLVING_SCOPE
        ):
            self._fail_ambiguous(claimed, token, None)

        try:
            resolved = self._resolve_whole_book(context)
        except ChatUseCaseError as error:
            self._fail_and_raise(claimed, token, error.error)
        except Exception as error:
            self._fail_and_raise(
                claimed,
                token,
                ChatError.safe(
                    ChatErrorCode.UNEXPECTED,
                    "Unexpected local Chat scope resolution failure",
                    request_id=claimed.id,
                ),
                cause=error,
            )

        if claimed.effective_scope is None:
            claimed = self._repository.persist_effective_scope(
                claimed.id,
                token,
                resolved.effective_scope,
                now=self._clock(),
            )
        elif claimed.effective_scope != resolved.effective_scope:
            self._fail_and_raise(
                claimed,
                token,
                ChatError.safe(
                    ChatErrorCode.SOURCE_NOT_READY,
                    "Whole-book source mapping changed during Chat recovery",
                    request_id=claimed.id,
                ),
            )

        cancelled = self._cancel_at_safe_point(claimed, token)
        if cancelled is not None:
            return cancelled
        try:
            healthy = await self._knowledge_health.credential_is_healthy(context.credential)
        except Exception as error:
            self._fail_and_raise(
                claimed,
                token,
                _map_pre_dispatch_error(error, request_id=claimed.id),
                cause=error,
            )
        if not healthy:
            self._fail_and_raise(
                claimed,
                token,
                ChatError.safe(
                    ChatErrorCode.AUTH_REQUIRED,
                    "Knowledge Provider authentication is required",
                    request_id=claimed.id,
                ),
            )

        cancelled = self._cancel_at_safe_point(claimed, token)
        if cancelled is not None:
            return cancelled
        if provider_attempt is None:
            provider_attempt = ChatProviderAttempt.prepare(
                intent_id=self._id_factory(),
                chat_run_id=claimed.id,
                run_attempt=claimed.attempt,
                provider=context.credential.provider,
                request_fingerprint=claimed.request_fingerprint,
                now=self._clock(),
            )
            provider_attempt = self._repository.prepare_provider_attempt(provider_attempt, token)
        cancelled = self._cancel_at_safe_point(claimed, token)
        if cancelled is not None:
            return cancelled

        claimed, provider_attempt = self._repository.dispatch_provider_attempt(
            claimed.id,
            provider_attempt.id,
            token,
            now=self._clock(),
        )
        try:
            answer = await self._knowledge_query.ask(
                context.workspace,
                resolved.question,
                resolved.provider_source_ids,
                context.binding.provider_conversation_id,
            )
            provider_conversation_id = _resolve_provider_conversation_id(context, answer)
            references = self._map_references(context, answer, now=self._clock())
            _ = context.messages.assistant.complete(answer.answer, now=self._clock())
            claimed = self._repository.persist_phase(
                claimed.id,
                token,
                ChatRunPhase.FINALIZING,
                now=self._clock(),
            )
            return self._repository.finalize_provider_attempt(
                claimed.id,
                provider_attempt.id,
                token,
                assistant_content=answer.answer,
                provider_conversation_id=provider_conversation_id,
                references=references,
                now=self._clock(),
            )
        except Exception as error:
            self._fail_ambiguous(claimed, token, provider_attempt, cause=error)

    def _validate_persisted_command(
        self,
        context: ChatExecutionContext,
        run: ChatRun,
        token: ChatLeaseToken,
    ) -> None:
        try:
            run.assert_lease(token)
            context.run.query_scope.require_whole_book()
            question = context.messages.user.content
            if question is None:
                raise ValueError("Persisted user question is missing")
            expected_fingerprint = chat_request_fingerprint(
                run.conversation_id,
                run.client_message_id,
                question,
                run.query_scope,
            )
            if (
                context.messages.user.chat_run_id != run.id
                or context.messages.assistant.chat_run_id != run.id
                or context.messages.user.id != run.user_message_id
                or context.messages.assistant.id != run.assistant_message_id
                or context.messages.user.client_message_id != run.client_message_id
                or chat_question_hash(question) != run.question_hash
                or expected_fingerprint != run.request_fingerprint
            ):
                raise ValueError("Persisted Chat command fingerprint or Message pair changed")
        except Exception as error:
            self._fail_and_raise(
                run,
                token,
                ChatError.safe(
                    ChatErrorCode.IDEMPOTENCY_CONFLICT,
                    "Persisted Chat request does not match its canonical fingerprint",
                    request_id=run.id,
                ),
                cause=error,
            )

    def _validate_provider_attempt(
        self,
        context: ChatExecutionContext,
        provider_attempt: ChatProviderAttempt,
        run: ChatRun,
        token: ChatLeaseToken,
    ) -> None:
        if (
            provider_attempt.chat_run_id != run.id
            or provider_attempt.run_attempt != run.attempt
            or provider_attempt.request_fingerprint != run.request_fingerprint
            or provider_attempt.provider != context.credential.provider
        ):
            self._fail_and_raise(
                run,
                token,
                ChatError.safe(
                    ChatErrorCode.IDEMPOTENCY_CONFLICT,
                    "Provider attempt does not match the persisted Chat request",
                    request_id=run.id,
                ),
            )

    def _resolve_whole_book(self, context: ChatExecutionContext) -> _ResolvedWholeBookQuery:
        run = context.run
        request_id = run.id
        if run.query_scope.type is not QueryScopeType.BOOK:
            self._reject(
                ChatErrorCode.VALIDATION,
                "Only whole-book Chat scope is supported",
                request_id=request_id,
                run_id=run.id,
            )
        if context.conversation.status is not ConversationStatus.ACTIVE:
            self._reject(
                ChatErrorCode.VALIDATION,
                "Conversation is not active",
                request_id=request_id,
                run_id=run.id,
            )
        if (
            context.conversation.id != run.conversation_id
            or context.conversation.book_id != context.book.id
            or context.conversation.workspace_id != context.workspace.id
            or context.binding.conversation_id != context.conversation.id
        ):
            self._reject(
                ChatErrorCode.SOURCE_NOT_READY,
                "Conversation, Book, and Workspace mappings do not match",
                request_id=request_id,
                run_id=run.id,
            )
        if (
            context.workspace.provider != context.credential.provider
            or context.binding.provider != context.credential.provider
        ):
            self._reject(
                ChatErrorCode.AUTH_REQUIRED,
                "Knowledge Provider credential does not match the Book Workspace",
                request_id=request_id,
                run_id=run.id,
            )
        if (
            context.book.status not in _QUERYABLE_BOOK_STATUSES
            or context.workspace.status is not KnowledgeStatus.READY
        ):
            self._reject(
                ChatErrorCode.SOURCE_NOT_READY,
                "Book knowledge sources are not ready",
                request_id=request_id,
                run_id=run.id,
            )
        if not context.parts or not context.sources:
            self._reject(
                ChatErrorCode.SOURCE_NOT_READY,
                "Whole-book Chat requires ready local Parts and mapped sources",
                request_id=request_id,
                run_id=run.id,
            )

        parts_by_id = {part.id: part for part in context.parts}
        if len(parts_by_id) != len(context.parts):
            self._reject(
                ChatErrorCode.SOURCE_NOT_READY,
                "Whole-book Parts contain duplicate local IDs",
                request_id=request_id,
                run_id=run.id,
            )
        sources_by_part: dict[str, ExternalSource] = {}
        source_ids: set[str] = set()
        external_ids: set[str] = set()
        for source in context.sources:
            part = parts_by_id.get(source.document_part_id)
            if (
                part is None
                or source.workspace_id != context.workspace.id
                or source.status is not KnowledgeStatus.READY
                or source.checksum != part.sha256
                or source.document_part_id in sources_by_part
                or not source.id
                or source.id in source_ids
                or not source.external_id
                or source.external_id in external_ids
            ):
                self._reject(
                    ChatErrorCode.SOURCE_NOT_READY,
                    "Whole-book source mapping is missing, not ready, or inconsistent",
                    request_id=request_id,
                    run_id=run.id,
                )
            sources_by_part[source.document_part_id] = source
            source_ids.add(source.id)
            external_ids.add(source.external_id)
        if set(sources_by_part) != set(parts_by_id):
            self._reject(
                ChatErrorCode.SOURCE_NOT_READY,
                "Whole-book source inventory does not cover every local Part",
                request_id=request_id,
                run_id=run.id,
            )

        ordered_parts = tuple(sorted(context.parts, key=lambda part: (part.sequence, part.id)))
        chapter_refs = tuple(
            dict.fromkeys(
                chapter_ref for part in ordered_parts for chapter_ref in part.chapter_refs
            )
        )
        effective_scope = EffectiveBookScope(
            type=QueryScopeType.BOOK,
            book_id=context.book.id,
            document_part_ids=tuple(part.id for part in ordered_parts),
            chapter_refs=chapter_refs,
            source_labels=tuple(f"Part {part.sequence + 1}" for part in ordered_parts),
        )
        question = context.messages.user.content
        if question is None:
            raise ValueError("Persisted user question is unavailable")
        return _ResolvedWholeBookQuery(
            question=question,
            provider_source_ids=tuple(
                sources_by_part[part.id].external_id for part in ordered_parts
            ),
            effective_scope=effective_scope,
        )

    def _map_references(
        self,
        context: ChatExecutionContext,
        answer: KnowledgeAnswer,
        *,
        now: datetime,
    ) -> tuple[ChatReference, ...]:
        sources_by_external_id = {source.external_id: source for source in context.sources}
        if len(sources_by_external_id) != len(context.sources):
            raise ValueError("Provider source mappings are not unique")
        parts_by_id = {part.id: part for part in context.parts}
        mapped: list[ChatReference] = []
        for index, reference in enumerate(answer.references, start=1):
            source = sources_by_external_id.get(reference.external_source_id)
            if source is None:
                raise ValueError("Provider returned a Reference outside the Book source inventory")
            if (
                reference.document_part_id is not None
                and reference.document_part_id != source.document_part_id
            ):
                raise ValueError("Provider Reference conflicts with its local source mapping")
            part = parts_by_id.get(source.document_part_id)
            if part is None:
                raise ValueError("Provider Reference has no local Document Part")
            citation_number = _citation_number(reference, fallback=index)
            passage = reference.excerpt
            if passage is not None and not passage.strip():
                passage = None
            mapped.append(
                ChatReference(
                    id=self._id_factory(),
                    message_id=context.run.assistant_message_id,
                    citation_number=citation_number,
                    book_id=context.book.id,
                    document_part_id=part.id,
                    chapter_refs=part.chapter_refs,
                    label=f"Part {part.sequence + 1}",
                    passage=passage,
                    location=None,
                    created_at=now,
                )
            )
        return tuple(mapped)

    def _cancel_at_safe_point(
        self,
        run: ChatRun,
        token: ChatLeaseToken,
    ) -> ChatRunResult | None:
        current = self._repository.get_run(run.id)
        if current is None:
            self._fail_and_raise(
                run,
                token,
                ChatError.safe(
                    ChatErrorCode.UNEXPECTED,
                    "Chat Run disappeared during execution",
                    request_id=run.id,
                ),
            )
        current.assert_lease(token)
        if not current.is_cancel_requested:
            return None
        cancelled = self._repository.cancel(run.id, token, now=self._clock())
        return self._terminal_result(cancelled)

    def _fail_ambiguous(
        self,
        run: ChatRun,
        token: ChatLeaseToken,
        provider_attempt: ChatProviderAttempt | None,
        *,
        cause: Exception | None = None,
    ) -> NoReturn:
        current = self._repository.get_run(run.id) or run
        current.assert_lease(token)
        if current.phase is not ChatRunPhase.RECONCILING:
            current = self._repository.persist_phase(
                current.id,
                token,
                ChatRunPhase.RECONCILING,
                now=self._clock(),
            )
        if (
            provider_attempt is not None
            and provider_attempt.status is ProviderAttemptStatus.DISPATCHED
        ):
            _ = self._repository.terminate_provider_attempt(
                current.id,
                provider_attempt.id,
                token,
                ProviderAttemptStatus.AMBIGUOUS,
                now=self._clock(),
            )
        error = ChatError.safe(
            ChatErrorCode.AMBIGUOUS_PROVIDER_OUTCOME,
            "Knowledge Provider may have accepted the question; automatic replay is disabled",
            request_id=current.id,
            retriable=False,
        )
        self._fail_and_raise(current, token, error, cause=cause)

    def _fail_and_raise(
        self,
        run: ChatRun,
        token: ChatLeaseToken,
        error: ChatError,
        *,
        cause: Exception | None = None,
    ) -> NoReturn:
        failed = self._repository.fail(run.id, token, error, now=self._clock())
        exception = ChatUseCaseError(error, run_id=failed.id)
        if cause is None:
            raise exception
        raise exception from cause

    def _terminal_result(self, run: ChatRun) -> ChatRunResult:
        result = self._repository.get_result(run.id)
        if result is None:
            self._reject(
                ChatErrorCode.UNEXPECTED,
                "Chat Run result is unavailable",
                request_id=run.id,
                run_id=run.id,
            )
        if run.status is ChatRunStatus.FAILED and run.error is not None:
            raise ChatUseCaseError(run.error, run_id=run.id)
        return result

    @staticmethod
    def _reject(
        code: ChatErrorCode,
        message: str,
        *,
        request_id: str,
        run_id: str | None = None,
    ) -> NoReturn:
        raise ChatUseCaseError(
            ChatError.safe(code, message, request_id=request_id),
            run_id=run_id,
        )


def _resolve_provider_conversation_id(
    context: ChatExecutionContext,
    answer: KnowledgeAnswer,
) -> str:
    bound_id = context.binding.provider_conversation_id
    returned_id = answer.conversation_id
    if bound_id is None:
        if returned_id is None or not returned_id.strip():
            raise ValueError("First Provider Turn did not return a Conversation ID")
        return returned_id
    if returned_id is not None and returned_id != bound_id:
        raise ValueError("Provider returned a different Conversation ID")
    return bound_id


def _citation_number(reference: KnowledgeReference, *, fallback: int) -> int:
    value: object = getattr(reference, "citation_number", fallback)
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return value
    return fallback


def _map_pre_dispatch_error(error: Exception, *, request_id: str) -> ChatError:
    if isinstance(error, ChatUseCaseError):
        return error.error
    if isinstance(error, DiandianError):
        mapping = {
            ErrorCode.AUTH_REQUIRED: ChatErrorCode.AUTH_REQUIRED,
            ErrorCode.REMOTE_RATE_LIMITED: ChatErrorCode.REMOTE_RATE_LIMITED,
            ErrorCode.REMOTE_UNAVAILABLE: ChatErrorCode.REMOTE_UNAVAILABLE,
            ErrorCode.REMOTE_PROTOCOL_DRIFT: ChatErrorCode.REMOTE_PROTOCOL_DRIFT,
            ErrorCode.SOURCE_PROCESSING_FAILED: ChatErrorCode.SOURCE_PROCESSING_FAILED,
            ErrorCode.VALIDATION: ChatErrorCode.VALIDATION,
        }
        code = mapping.get(error.code, ChatErrorCode.UNEXPECTED)
        messages = {
            ChatErrorCode.AUTH_REQUIRED: "Knowledge Provider authentication is required",
            ChatErrorCode.REMOTE_RATE_LIMITED: "Knowledge Provider rate limit was reached",
            ChatErrorCode.REMOTE_UNAVAILABLE: "Knowledge Provider is temporarily unavailable",
            ChatErrorCode.REMOTE_PROTOCOL_DRIFT: "Knowledge Provider integration needs an update",
            ChatErrorCode.SOURCE_PROCESSING_FAILED: "Book knowledge sources failed processing",
            ChatErrorCode.VALIDATION: "Knowledge Provider health check input was rejected",
            ChatErrorCode.UNEXPECTED: "Unexpected Knowledge Provider health check failure",
        }
        return ChatError.safe(code, messages[code], request_id=request_id)
    return ChatError.safe(
        ChatErrorCode.UNEXPECTED,
        "Unexpected Knowledge Provider health check failure",
        request_id=request_id,
    )


def _safe_request_id(request_id: str | None, fallback: str) -> str:
    candidate = request_id or fallback
    try:
        _require_local_id(candidate, "Request ID")
    except (TypeError, ValueError):
        return "chat-request"
    return candidate


def _require_local_id_or_raise(value: str, field_name: str, *, request_id: str) -> None:
    try:
        _require_local_id(value, field_name)
    except (TypeError, ValueError) as error:
        raise ChatUseCaseError(
            ChatError.safe(
                ChatErrorCode.VALIDATION,
                f"{field_name} is invalid",
                request_id=request_id,
            )
        ) from error


def _require_local_id(value: object, field_name: str) -> None:
    if not isinstance(value, str) or not value.strip() or len(value) > 512:
        raise ValueError(f"{field_name} is invalid")
    if any(unicodedata.category(character) in {"Cc", "Cs"} for character in value):
        raise ValueError(f"{field_name} contains unsupported control characters")


def _question_exceeds_limit(question: object) -> bool:
    return (
        isinstance(question, str)
        and len(unicodedata.normalize("NFC", question)) > MAX_QUESTION_CHARS
    )


WholeBookChatUseCase = ChatUseCase
