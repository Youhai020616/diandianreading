"""Lease-fenced, crash-conservative whole-book durable chat use case."""

from __future__ import annotations

import unicodedata
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import NoReturn, final
from uuid import uuid4

from diandianreading.application.ports.annotations import AnnotationRepository
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
    DocumentTextReader,
    SelectionVerifier,
)
from diandianreading.application.ports.knowledge import (
    KnowledgeAnswer,
    KnowledgeQueryPort,
    KnowledgeReference,
)
from diandianreading.application.ports.reconciliation import KnowledgeHealthPort
from diandianreading.application.services.citation_locator import locate_excerpt
from diandianreading.domain.annotations import Annotation, AnnotationStatus
from diandianreading.domain.chat import (
    MAX_NOTES_CONTEXT_CHARS,
    MAX_QUESTION_CHARS,
    MAX_SELECTED_TEXT_CHARS,
    ChatContextItem,
    ChatContextItemKind,
    ChatError,
    ChatErrorCode,
    ChatLeaseToken,
    ChatMessage,
    ChatMessagePair,
    ChatProviderAttempt,
    ChatReference,
    ChatReferenceLocation,
    ChatReferenceLocationType,
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
    SupplementalContextKind,
    build_bounded_question,
    chat_context_hash,
    chat_question_hash,
    chat_request_fingerprint,
    normalize_chat_question,
    normalize_supplemental_text,
    supplemental_text_hash,
    utc_now,
)
from diandianreading.domain.errors import DiandianError, ErrorCode
from diandianreading.domain.models import BookStatus, DocumentPart, ExternalSource, KnowledgeStatus

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
    """One idempotent local chat command.

    ``selection_text`` carries the raw selection body separately from the scope: the
    persisted canonical ``query_scope`` never embeds supplemental bodies (§4.5), so the
    scope holds only the SHA-256 digest while the body goes to the context snapshot.
    """

    conversation_id: str
    client_message_id: str
    question: str
    query_scope: QueryScope = field(default_factory=QueryScope.book)
    selection_text: str | None = None
    idempotency_key: str | None = None
    request_id: str | None = None


@dataclass(frozen=True, slots=True)
class _ResolvedQuery:
    """Scope resolution outcome; ``provider_source_ids`` keeps §4.3 three-state semantics.

    ``None`` means the provider's whole-book default; a non-empty tuple means an
    explicit restriction; an empty tuple is an illegal invariant that must become
    ``SOURCE_NOT_READY`` before any provider dispatch.
    """

    question: str
    provider_source_ids: tuple[str, ...] | None
    effective_scope: EffectiveBookScope
    context_items: tuple[ChatContextItem, ...] = ()
    context_hash: str | None = None


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
        selection_verifier: SelectionVerifier | None = None,
        annotations: AnnotationRepository | None = None,
        document_text: DocumentTextReader | None = None,
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
        self._selection_verifier = selection_verifier
        self._annotations = annotations
        self._document_text = document_text
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
        if command.query_scope.type is QueryScopeType.CHAPTERS:
            self._reject(
                ChatErrorCode.VALIDATION,
                "Chapters Chat scope is not implemented yet; the chapter-to-Part mapping "
                + "vocabulary is not unified",
                request_id=request_id,
            )
        context_items = self._validate_selection_submission(command, request_id=request_id)
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
            context_hash=chat_context_hash(context_items) if context_items else None,
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
            return self._repository.submit(
                ChatSubmission(messages=messages, run=run, context=context_items)
            )
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

    def _validate_selection_submission(
        self,
        command: SubmitChatCommand,
        *,
        request_id: str,
    ) -> tuple[ChatContextItem, ...]:
        scope = command.query_scope
        if scope.type is not QueryScopeType.SELECTION:
            if command.selection_text is not None:
                self._reject(
                    ChatErrorCode.VALIDATION,
                    "Only a selection scope accepts selection text",
                    request_id=request_id,
                )
            return ()
        selection_text = command.selection_text
        if selection_text is None:
            self._reject(
                ChatErrorCode.VALIDATION,
                "Selection scope requires the selected text body",
                request_id=request_id,
            )
        try:
            normalized = normalize_supplemental_text(
                selection_text,
                field_name="Selection text",
                max_chars=MAX_SELECTED_TEXT_CHARS,
            )
        except (TypeError, ValueError) as error:
            code = (
                ChatErrorCode.PAYLOAD_TOO_LARGE
                if _selection_exceeds_limit(selection_text)
                else ChatErrorCode.VALIDATION
            )
            message = (
                f"Selection text cannot exceed {MAX_SELECTED_TEXT_CHARS} Unicode characters"
                if code is ChatErrorCode.PAYLOAD_TOO_LARGE
                else "Selection text is empty or contains unsupported control characters"
            )
            raise ChatUseCaseError(ChatError.safe(code, message, request_id=request_id)) from error
        if supplemental_text_hash(normalized) != scope.selected_text_sha256:
            self._reject(
                ChatErrorCode.VALIDATION,
                "Selection text does not match the digest declared in its scope",
                request_id=request_id,
            )
        document_part_id = scope.document_part_id
        if document_part_id is None:  # pragma: no cover - guaranteed by scope invariants
            self._reject(
                ChatErrorCode.VALIDATION,
                "Selection scope requires a Document Part",
                request_id=request_id,
            )
        return (
            ChatContextItem(
                kind=ChatContextItemKind.SELECTION,
                reference_id=document_part_id,
                text=normalized,
            ),
        )

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

    def get_message(self, message_id: str) -> ChatMessage | None:
        return self._repository.get_message(message_id)

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
            resolved = self._resolve_scope(context)
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

        if resolved.provider_source_ids is not None and not resolved.provider_source_ids:
            self._fail_and_raise(
                claimed,
                token,
                ChatError.safe(
                    ChatErrorCode.SOURCE_NOT_READY,
                    "Explicit Chat scope resolved to no ready sources",
                    request_id=claimed.id,
                ),
            )
        if resolved.context_hash is not None and claimed.context_hash != resolved.context_hash:
            if claimed.context_hash is None:
                claimed = self._repository.persist_context_snapshot(
                    claimed.id,
                    token,
                    resolved.context_items,
                    now=self._clock(),
                )
            else:
                self._fail_and_raise(
                    claimed,
                    token,
                    ChatError.safe(
                        ChatErrorCode.SOURCE_NOT_READY,
                        "Supplemental Chat context changed during recovery",
                        request_id=claimed.id,
                    ),
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
                    "Local Chat source mapping changed during recovery",
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

    def _resolve_scope(self, context: ChatExecutionContext) -> _ResolvedQuery:
        run = context.run
        self._validate_shared_context(context)
        if run.query_scope.type is QueryScopeType.SELECTION:
            return self._resolve_selection(context)
        if run.query_scope.type is QueryScopeType.NOTES:
            return self._resolve_notes(context)
        if run.query_scope.type is not QueryScopeType.BOOK:
            self._reject(
                ChatErrorCode.VALIDATION,
                "Chapters Chat scope is not implemented yet; the chapter-to-Part mapping "
                + "vocabulary is not unified",
                request_id=run.id,
                run_id=run.id,
            )
        return self._resolve_whole_book(context)

    def _validate_shared_context(self, context: ChatExecutionContext) -> None:
        run = context.run
        request_id = run.id
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

    def _map_body_sources(
        self,
        context: ChatExecutionContext,
    ) -> tuple[tuple[DocumentPart, ...], dict[str, ExternalSource]]:
        """Validate the whole-book source inventory and return ordered parts + mapping."""

        run = context.run
        request_id = run.id
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
        return ordered_parts, sources_by_part

    def _resolve_whole_book(self, context: ChatExecutionContext) -> _ResolvedQuery:
        ordered_parts, sources_by_part = self._map_body_sources(context)
        effective_scope = EffectiveBookScope(
            type=QueryScopeType.BOOK,
            book_id=context.book.id,
            document_part_ids=tuple(part.id for part in ordered_parts),
            chapter_refs=_chapter_refs(ordered_parts),
            source_labels=_part_labels(ordered_parts),
        )
        return _ResolvedQuery(
            question=_persisted_question(context),
            provider_source_ids=tuple(
                sources_by_part[part.id].external_id for part in ordered_parts
            ),
            effective_scope=effective_scope,
        )

    def _resolve_selection(self, context: ChatExecutionContext) -> _ResolvedQuery:
        run = context.run
        scope = run.query_scope
        request_id = run.id
        document_part_id = scope.document_part_id
        locator = scope.locator
        selected_text_sha256 = scope.selected_text_sha256
        if (
            document_part_id is None or locator is None or selected_text_sha256 is None
        ):  # pragma: no cover - guaranteed by scope invariants
            self._reject(
                ChatErrorCode.VALIDATION,
                "Selection scope is missing its Document Part, locator, or digest",
                request_id=request_id,
                run_id=run.id,
            )
        part = next(
            (candidate for candidate in context.parts if candidate.id == document_part_id),
            None,
        )
        if part is None:
            self._reject(
                ChatErrorCode.NOT_FOUND,
                "Selection Document Part does not belong to this Book",
                request_id=request_id,
                run_id=run.id,
            )
        items = context.context_items
        if (
            len(items) != 1
            or items[0].kind is not ChatContextItemKind.SELECTION
            or items[0].reference_id != part.id
            or run.context_hash is None
            or chat_context_hash(items) != run.context_hash
            or supplemental_text_hash(items[0].text) != selected_text_sha256
        ):
            self._reject(
                ChatErrorCode.UNEXPECTED,
                "Selection context snapshot is missing or does not match its Chat Run",
                request_id=request_id,
                run_id=run.id,
            )
        source = next(
            (candidate for candidate in context.sources if candidate.document_part_id == part.id),
            None,
        )
        if (
            source is None
            or source.workspace_id != context.workspace.id
            or source.status is not KnowledgeStatus.READY
            or source.checksum != part.sha256
            or not source.external_id
        ):
            self._reject(
                ChatErrorCode.SOURCE_NOT_READY,
                "Selection Document Part has no ready mapped source",
                request_id=request_id,
                run_id=run.id,
            )
        verified = False
        if self._selection_verifier is not None:
            try:
                verified = bool(
                    self._selection_verifier.verify_selection(
                        book_id=context.book.id,
                        document_part_id=part.id,
                        locator=locator,
                        selected_text=items[0].text,
                    )
                )
            except Exception:
                # A verifier failure must never claim the selection was located in the
                # original text; the selection stays user-provided context (§4.1).
                verified = False
        effective_scope = EffectiveBookScope(
            type=QueryScopeType.SELECTION,
            book_id=context.book.id,
            document_part_ids=(part.id,),
            chapter_refs=part.chapter_refs,
            source_labels=(f"Part {part.sequence + 1}",),
            supplemental=(
                SupplementalContextKind.SELECTION
                if verified
                else SupplementalContextKind.SELECTION_UNVERIFIED,
            ),
        )
        return _ResolvedQuery(
            question=build_bounded_question(
                _persisted_question(context),
                items,
                selection_verified=verified,
            ),
            provider_source_ids=(source.external_id,),
            effective_scope=effective_scope,
            context_items=items,
            context_hash=run.context_hash,
        )

    def _resolve_notes(self, context: ChatExecutionContext) -> _ResolvedQuery:
        run = context.run
        request_id = run.id
        annotations = self._annotations
        if annotations is None:
            self._reject(
                ChatErrorCode.UNEXPECTED,
                "Notes Chat scope requires the local annotation store",
                request_id=request_id,
                run_id=run.id,
            )
        items: list[ChatContextItem] = []
        total_chars = 0
        for note_id in run.query_scope.note_ids:
            annotation = annotations.get(note_id)
            if annotation is None:
                self._reject(
                    ChatErrorCode.NOT_FOUND,
                    "A referenced note was not found",
                    request_id=request_id,
                    run_id=run.id,
                )
            if annotation.status is AnnotationStatus.DELETED:
                self._reject(
                    ChatErrorCode.NOT_FOUND,
                    "A referenced note was deleted",
                    request_id=request_id,
                    run_id=run.id,
                )
            if annotation.book_id != context.book.id:
                self._reject(
                    ChatErrorCode.VALIDATION,
                    "A referenced note does not belong to this Book",
                    request_id=request_id,
                    run_id=run.id,
                )
            text = normalize_supplemental_text(
                _annotation_context_text(annotation),
                field_name="Note context text",
                max_chars=MAX_SELECTED_TEXT_CHARS,
            )
            total_chars += len(text)
            items.append(
                ChatContextItem(
                    kind=ChatContextItemKind.NOTE,
                    reference_id=annotation.id,
                    text=text,
                )
            )
        if total_chars > MAX_NOTES_CONTEXT_CHARS:
            self._reject(
                ChatErrorCode.PAYLOAD_TOO_LARGE,
                f"Notes supplemental context cannot exceed {MAX_NOTES_CONTEXT_CHARS} "
                + "Unicode characters in total",
                request_id=request_id,
                run_id=run.id,
            )
        ordered_parts, sources_by_part = self._map_body_sources(context)
        context_items = tuple(items)
        effective_scope = EffectiveBookScope(
            type=QueryScopeType.NOTES,
            book_id=context.book.id,
            document_part_ids=tuple(part.id for part in ordered_parts),
            chapter_refs=_chapter_refs(ordered_parts),
            source_labels=_part_labels(ordered_parts),
            note_ids=run.query_scope.note_ids,
            supplemental=(SupplementalContextKind.NOTES,),
        )
        return _ResolvedQuery(
            question=build_bounded_question(_persisted_question(context), context_items),
            provider_source_ids=tuple(
                sources_by_part[part.id].external_id for part in ordered_parts
            ),
            effective_scope=effective_scope,
            context_items=context_items,
            context_hash=chat_context_hash(context_items),
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
        document_text: tuple[str, str] | None = None
        if self._document_text is not None:
            try:
                document_text = self._document_text.read_markdown_text(context.book.id)
            except DiandianError:
                document_text = None
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
            location: ChatReferenceLocation | None = None
            if passage is not None and document_text is not None:
                anchor_sha256, reading_text = document_text
                excerpt_location = locate_excerpt(reading_text, passage)
                if excerpt_location is not None:
                    location = ChatReferenceLocation(
                        type=ChatReferenceLocationType.MARKDOWN_OFFSET,
                        value=(f"{anchor_sha256}:{excerpt_location.start}:{excerpt_location.end}"),
                    )
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
                    location=location,
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


def _selection_exceeds_limit(selection_text: object) -> bool:
    return (
        isinstance(selection_text, str)
        and len(unicodedata.normalize("NFC", selection_text)) > MAX_SELECTED_TEXT_CHARS
    )


def _persisted_question(context: ChatExecutionContext) -> str:
    question = context.messages.user.content
    if question is None:
        raise ValueError("Persisted user question is unavailable")
    return question


def _chapter_refs(ordered_parts: tuple[DocumentPart, ...]) -> tuple[str, ...]:
    return tuple(
        dict.fromkeys(chapter_ref for part in ordered_parts for chapter_ref in part.chapter_refs)
    )


def _part_labels(ordered_parts: tuple[DocumentPart, ...]) -> tuple[str, ...]:
    return tuple(f"Part {part.sequence + 1}" for part in ordered_parts)


def _annotation_context_text(annotation: Annotation) -> str:
    """Assemble the untrusted quotable body of a highlight or note."""

    pieces = tuple(
        piece for piece in (annotation.selected_text, annotation.body) if piece is not None
    )
    return "\n\n".join(pieces)


WholeBookChatUseCase = ChatUseCase
