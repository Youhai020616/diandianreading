"""SQLite persistence adapter for durable, lease-fenced whole-book chat."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from typing import cast

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
    ChatSubmissionDisposition,
    ChatSubmissionResult,
    ConversationBusyError,
    ConversationEnsureResult,
)
from diandianreading.domain.chat import (
    ChatContextItem,
    ChatContextItemKind,
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
    SelectionLocator,
    SupplementalContextKind,
    chat_context_hash,
    query_scope_payload,
)
from diandianreading.domain.models import CredentialRef, KnowledgeStatus, WorkspaceRef
from diandianreading.infrastructure.persistence.sqlite import (
    SQLiteCatalogRepository,
    SQLiteDatabase,
    SQLiteKnowledgeMappingRepository,
)

_MAX_MESSAGE_PAGE = 100
_MAX_EVENT_PAGE = 500


class SQLiteChatRepository(ChatRepository):
    """Persist local Chat aggregates while keeping Provider identifiers server-only."""

    def __init__(self, target: SQLiteDatabase | sqlite3.Connection) -> None:
        self._target = target

    @contextmanager
    def _connect(self, *, write: bool = False) -> Iterator[sqlite3.Connection]:
        if isinstance(self._target, sqlite3.Connection):
            yield self._target
            return
        with self._target.connect(immediate=write) as connection:
            yield connection

    def ensure_conversation(
        self,
        *,
        book_id: str,
        conversation_id: str,
        now: datetime,
        title: str | None = None,
    ) -> ConversationEnsureResult:
        try:
            with self._connect(write=True) as connection:
                catalog = SQLiteCatalogRepository(connection)
                mappings = SQLiteKnowledgeMappingRepository(connection)
                if catalog.get_book(book_id) is None:
                    raise KeyError(f"Unknown Book: {book_id}")
                workspace = mappings.get_workspace_for_book(book_id)
                if workspace is None:
                    raise KeyError(f"Book has no ExternalWorkspace: {book_id}")
                if workspace.status is not KnowledgeStatus.READY:
                    raise ChatRepositoryConflictError("Book ExternalWorkspace is not ready")

                row = connection.execute(
                    "SELECT * FROM conversations WHERE book_id = ?",
                    (book_id,),
                ).fetchone()
                if row is not None:
                    conversation = _conversation_from_row(row)
                    _validate_existing_conversation(
                        connection,
                        conversation,
                        workspace.id,
                        workspace.provider,
                    )
                    return ConversationEnsureResult(conversation=conversation, created=False)

                conversation = Conversation.create(
                    conversation_id=conversation_id,
                    book_id=book_id,
                    workspace_id=workspace.id,
                    title=title,
                    now=now,
                )
                binding = ProviderConversationBinding.create(
                    conversation_id=conversation.id,
                    provider=workspace.provider,
                    now=now,
                )
                connection.execute(
                    """
                    INSERT INTO conversations(
                        id, book_id, workspace_id, title, status, created_at, updated_at, version
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    _conversation_values(conversation),
                )
                connection.execute(
                    """
                    INSERT INTO provider_conversation_bindings(
                        conversation_id, provider, provider_conversation_id,
                        context_generation, health, last_verified_at,
                        created_at, updated_at, version
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    _binding_values(binding),
                )
                return ConversationEnsureResult(conversation=conversation, created=True)
        except sqlite3.IntegrityError as error:
            raise ChatRepositoryConflictError(
                "Conversation identity changed while it was being ensured"
            ) from error

    def get_conversation(self, conversation_id: str) -> Conversation | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM conversations WHERE id = ?",
                (conversation_id,),
            ).fetchone()
        return _conversation_from_row(row) if row is not None else None

    def get_conversation_for_book(self, book_id: str) -> Conversation | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM conversations WHERE book_id = ?",
                (book_id,),
            ).fetchone()
        return _conversation_from_row(row) if row is not None else None

    def get_active_run(self, conversation_id: str) -> ChatRun | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT * FROM chat_runs
                WHERE conversation_id = ? AND status IN ('queued', 'running')
                ORDER BY created_at DESC, id DESC
                LIMIT 1
                """,
                (conversation_id,),
            ).fetchone()
        return _run_from_row(row) if row is not None else None

    def get_execution_context(self, run_id: str) -> ChatExecutionContext | None:
        with self._connect() as connection:
            run_row = connection.execute(
                "SELECT * FROM chat_runs WHERE id = ?",
                (run_id,),
            ).fetchone()
            if run_row is None:
                return None
            run = _run_from_row(run_row)
            conversation = _require_conversation(connection, run.conversation_id)
            binding = _require_binding(connection, conversation.id)
            messages = _require_message_pair(connection, run)

            catalog = SQLiteCatalogRepository(connection)
            mappings = SQLiteKnowledgeMappingRepository(connection)
            book = catalog.get_book(conversation.book_id)
            if book is None:
                raise ValueError("Chat execution context references a missing Book")
            workspace = mappings.get_workspace(conversation.workspace_id)
            if workspace is None:
                raise ValueError("Chat execution context references a missing ExternalWorkspace")
            sources = tuple(mappings.list_sources(workspace.id))
            parts = tuple(catalog.list_parts(book.id))
            attempt = _get_provider_attempt(connection, run.id, run.attempt)
            context_items = _load_context_items(connection, run)

            return ChatExecutionContext(
                conversation=conversation,
                binding=binding,
                run=run,
                messages=messages,
                book=book,
                workspace=WorkspaceRef(
                    id=workspace.id,
                    provider=workspace.provider,
                    external_id=workspace.external_id,
                    status=workspace.status,
                ),
                sources=sources,
                parts=parts,
                credential=CredentialRef(
                    provider=workspace.provider,
                    profile=workspace.credential_profile,
                ),
                provider_attempt=attempt,
                context_items=context_items,
            )

    def submit(self, submission: ChatSubmission) -> ChatSubmissionResult:
        run = submission.run
        _validate_new_submission(submission)
        try:
            with self._connect(write=True) as connection:
                existing_row = connection.execute(
                    """
                    SELECT * FROM chat_runs
                    WHERE conversation_id = ? AND client_message_id = ?
                    """,
                    (run.conversation_id, run.client_message_id),
                ).fetchone()
                if existing_row is not None:
                    existing = _run_from_row(existing_row)
                    if existing.request_fingerprint != run.request_fingerprint:
                        raise ChatIdempotencyConflictError(
                            "client_message_id is bound to a different request fingerprint"
                        )
                    return ChatSubmissionResult(
                        messages=_require_message_pair(connection, existing),
                        run=existing,
                        disposition=ChatSubmissionDisposition.REPLAYED,
                    )

                conversation = _require_conversation(connection, run.conversation_id)
                if conversation.status is not ConversationStatus.ACTIVE:
                    raise ChatRepositoryConflictError(
                        "Archived Conversation cannot accept a Chat submission"
                    )
                active_row = _find_active_run(connection, run.conversation_id)
                if active_row is not None:
                    raise ConversationBusyError(str(active_row["id"]))

                connection.execute(
                    """
                    INSERT INTO chat_runs(
                        id, conversation_id, client_message_id,
                        user_message_id, assistant_message_id, query_scope_type,
                        query_scope_json, context_hash,
                        question_hash, request_fingerprint, status, phase,
                        effective_scope_json, attempt, error_json, cancel_requested_at,
                        lease_owner, lease_expires_at, lease_generation,
                        provider_request_started_at, created_at, updated_at,
                        started_at, completed_at, version
                    ) VALUES (
                        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                    )
                    """,
                    _run_values(run),
                )
                if submission.context:
                    _insert_context_snapshot(connection, run, submission.context)
                for message in (submission.messages.user, submission.messages.assistant):
                    connection.execute(
                        """
                        INSERT INTO chat_messages(
                            id, conversation_id, chat_run_id, role, content,
                            client_message_id, created_at, updated_at, version
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        _message_values(message),
                    )
                _insert_run_event(connection, run, ChatRunEventType.UPDATED)
                return ChatSubmissionResult(
                    messages=submission.messages,
                    run=run,
                    disposition=ChatSubmissionDisposition.CREATED,
                )
        except sqlite3.IntegrityError as error:
            raise ChatRepositoryConflictError(
                "Chat submission collided with an existing local record"
            ) from error

    def get_message(self, message_id: str) -> ChatMessage | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM chat_messages WHERE id = ?", (message_id,)
            ).fetchone()
        return None if row is None else _message_from_row(row)

    def list_messages(
        self,
        conversation_id: str,
        *,
        before: ChatMessageCursor | None,
        limit: int,
    ) -> ChatMessagePage:
        if limit < 1 or limit > _MAX_MESSAGE_PAGE:
            raise ValueError(f"Chat Message page limit must be between 1 and {_MAX_MESSAGE_PAGE}")
        parameters: list[object] = [conversation_id]
        cursor_clause = ""
        if before is not None:
            cursor_timestamp = before.created_at.isoformat()
            cursor_clause = """
                AND (
                    created_at < ?
                    OR (created_at = ? AND id < ?)
                )
            """
            parameters.extend((cursor_timestamp, cursor_timestamp, before.message_id))
        parameters.append(limit + 1)
        with self._connect() as connection:
            rows = connection.execute(
                f"""
                SELECT * FROM chat_messages
                WHERE conversation_id = ?
                {cursor_clause}
                ORDER BY created_at DESC, id DESC
                LIMIT ?
                """,
                tuple(parameters),
            ).fetchall()

        has_more = len(rows) > limit
        selected = rows[:limit]
        messages = tuple(_message_from_row(row) for row in reversed(selected))
        next_cursor = None
        if has_more and messages:
            oldest = messages[0]
            next_cursor = ChatMessageCursor(
                created_at=oldest.created_at,
                message_id=oldest.id,
            )
        return ChatMessagePage(messages=messages, next_cursor=next_cursor)

    def get_run(self, run_id: str) -> ChatRun | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM chat_runs WHERE id = ?",
                (run_id,),
            ).fetchone()
        return _run_from_row(row) if row is not None else None

    def get_result(self, run_id: str) -> ChatRunResult | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM chat_runs WHERE id = ?",
                (run_id,),
            ).fetchone()
            if row is None:
                return None
            run = _run_from_row(row)
            messages = _require_message_pair(connection, run)
            references = _list_references(connection, messages.assistant.id)
            return ChatRunResult(
                run=run,
                assistant_message=messages.assistant,
                references=references,
            )

    def claim(
        self,
        run_id: str,
        owner: str,
        *,
        lease_expires_at: datetime,
        now: datetime,
    ) -> ChatRun:
        with self._connect(write=True) as connection:
            previous = _require_run(connection, run_id)
            if previous.status is ChatRunStatus.QUEUED:
                current = previous.claim(owner, lease_expires_at=lease_expires_at, now=now)
            elif previous.status is ChatRunStatus.RUNNING:
                current = previous.take_over_expired_lease(
                    owner,
                    lease_expires_at=lease_expires_at,
                    now=now,
                )
            else:
                raise ChatRepositoryConflictError(
                    f"Chat Run cannot be claimed from {previous.status.value}"
                )
            _save_run_transition(connection, previous, current, ChatRunEventType.UPDATED)
            return current

    def claim_next(
        self,
        owner: str,
        *,
        lease_expires_at: datetime,
        now: datetime,
    ) -> ChatRun | None:
        with self._connect(write=True) as connection:
            row = connection.execute(
                """
                SELECT * FROM chat_runs
                WHERE
                    (status = 'queued' AND cancel_requested_at IS NULL)
                    OR (status = 'running' AND lease_expires_at <= ?)
                ORDER BY created_at, id
                LIMIT 1
                """,
                (now.isoformat(),),
            ).fetchone()
            if row is None:
                return None
            previous = _run_from_row(row)
            if previous.status is ChatRunStatus.QUEUED:
                current = previous.claim(owner, lease_expires_at=lease_expires_at, now=now)
            else:
                current = previous.take_over_expired_lease(
                    owner,
                    lease_expires_at=lease_expires_at,
                    now=now,
                )
            _save_run_transition(connection, previous, current, ChatRunEventType.UPDATED)
            return current

    def takeover(
        self,
        run_id: str,
        owner: str,
        *,
        lease_expires_at: datetime,
        now: datetime,
    ) -> ChatRun:
        with self._connect(write=True) as connection:
            previous = _require_run(connection, run_id)
            current = previous.take_over_expired_lease(
                owner,
                lease_expires_at=lease_expires_at,
                now=now,
            )
            _save_run_transition(connection, previous, current, ChatRunEventType.UPDATED)
            return current

    def heartbeat(
        self,
        run_id: str,
        token: ChatLeaseToken,
        *,
        lease_expires_at: datetime,
        now: datetime,
    ) -> ChatRun:
        with self._connect(write=True) as connection:
            previous = _require_fenced_run(connection, run_id, token)
            current = previous.heartbeat(
                token,
                lease_expires_at=lease_expires_at,
                now=now,
            )
            _save_run_transition(
                connection,
                previous,
                current,
                ChatRunEventType.UPDATED,
                token=token,
            )
            return current

    def persist_effective_scope(
        self,
        run_id: str,
        token: ChatLeaseToken,
        scope: EffectiveBookScope,
        *,
        now: datetime,
    ) -> ChatRun:
        with self._connect(write=True) as connection:
            previous = _require_fenced_run(connection, run_id, token)
            current = previous.record_effective_scope(scope, token, now=now)
            _save_run_transition(
                connection,
                previous,
                current,
                ChatRunEventType.UPDATED,
                token=token,
            )
            return current

    def persist_context_snapshot(
        self,
        run_id: str,
        token: ChatLeaseToken,
        items: tuple[ChatContextItem, ...],
        *,
        now: datetime,
    ) -> ChatRun:
        with self._connect(write=True) as connection:
            previous = _require_fenced_run(connection, run_id, token)
            current = previous.record_context_snapshot(chat_context_hash(items), token, now=now)
            if current is previous:
                return previous
            _insert_context_snapshot(connection, current, items)
            _save_run_transition(
                connection,
                previous,
                current,
                ChatRunEventType.UPDATED,
                token=token,
            )
            return current

    def persist_phase(
        self,
        run_id: str,
        token: ChatLeaseToken,
        phase: ChatRunPhase,
        *,
        now: datetime,
    ) -> ChatRun:
        with self._connect(write=True) as connection:
            previous = _require_fenced_run(connection, run_id, token)
            if phase is ChatRunPhase.WAITING_FOR_PROVIDER:
                current = previous.begin_provider_wait(token, now=now)
            elif phase is ChatRunPhase.RECONCILING:
                current = previous.begin_reconciling(token, now=now)
            elif phase is ChatRunPhase.FINALIZING:
                current = previous.begin_finalizing(token, now=now)
            else:
                raise ValueError("Repository cannot move a Chat Run back to resolving_scope")
            if current is previous:
                return previous
            _save_run_transition(
                connection,
                previous,
                current,
                ChatRunEventType.UPDATED,
                token=token,
            )
            return current

    def prepare_provider_attempt(
        self,
        intent: ChatProviderAttempt,
        token: ChatLeaseToken,
    ) -> ChatProviderAttempt:
        _validate_prepared_intent(intent)
        try:
            with self._connect(write=True) as connection:
                run = _require_fenced_run(connection, intent.chat_run_id, token)
                binding = _require_binding(connection, run.conversation_id)
                if (
                    intent.run_attempt != run.attempt
                    or intent.request_fingerprint != run.request_fingerprint
                    or intent.provider != binding.provider
                ):
                    raise ChatRepositoryConflictError(
                        "Provider attempt does not match the fenced Chat Run"
                    )
                existing = _get_provider_attempt(connection, run.id, run.attempt)
                if existing is not None:
                    if (
                        existing.status is not ProviderAttemptStatus.PREPARED
                        or existing.request_fingerprint != intent.request_fingerprint
                        or existing.provider != intent.provider
                    ):
                        raise ChatRepositoryConflictError(
                            "Provider attempt slot contains a different intent"
                        )
                    return existing
                _require_run_fence(connection, run, token)
                connection.execute(
                    """
                    INSERT INTO chat_provider_attempts(
                        id, chat_run_id, run_attempt, provider, request_fingerprint,
                        status, created_at, updated_at, dispatched_at, resolved_at, version
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    _attempt_values(intent),
                )
                return intent
        except sqlite3.IntegrityError as error:
            raise ChatRepositoryConflictError(
                "Provider attempt collided with another durable intent"
            ) from error

    def dispatch_provider_attempt(
        self,
        run_id: str,
        intent_id: str,
        token: ChatLeaseToken,
        *,
        now: datetime,
    ) -> tuple[ChatRun, ChatProviderAttempt]:
        try:
            with self._connect(write=True) as connection:
                previous_run = _require_fenced_run(connection, run_id, token)
                previous_attempt = _require_current_attempt(connection, previous_run)
                if previous_attempt.id != intent_id:
                    raise ChatRepositoryConflictError("Provider attempt ID changed")
                current_attempt = previous_attempt.dispatch(now=now)
                current_run = previous_run.begin_provider_wait(token, now=now)
                _save_attempt_transition(connection, previous_attempt, current_attempt)
                _save_run_transition(
                    connection,
                    previous_run,
                    current_run,
                    ChatRunEventType.UPDATED,
                    token=token,
                )
                return current_run, current_attempt
        except sqlite3.IntegrityError as error:
            raise ChatRepositoryConflictError(
                "Provider dispatch violated durable Chat state"
            ) from error

    def terminate_provider_attempt(
        self,
        run_id: str,
        intent_id: str,
        token: ChatLeaseToken,
        status: ProviderAttemptStatus,
        *,
        now: datetime,
    ) -> ChatProviderAttempt:
        with self._connect(write=True) as connection:
            run = _require_fenced_run(connection, run_id, token)
            previous = _require_current_attempt(connection, run)
            if previous.id != intent_id:
                raise ChatRepositoryConflictError("Provider attempt ID changed")
            if status is ProviderAttemptStatus.AMBIGUOUS:
                current = previous.mark_ambiguous(now=now)
            elif status is ProviderAttemptStatus.FAILED_TERMINAL:
                current = previous.fail_terminal(now=now)
            else:
                raise ValueError("Unsupported Provider attempt terminal status")
            _require_run_fence(connection, run, token)
            _save_attempt_transition(connection, previous, current)
            return current

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
        try:
            with self._connect(write=True) as connection:
                previous_run = _require_fenced_run(connection, run_id, token)
                previous_attempt = _require_current_attempt(connection, previous_run)
                if previous_attempt.id != intent_id:
                    raise ChatRepositoryConflictError("Provider attempt ID changed")
                messages = _require_message_pair(connection, previous_run)
                previous_binding = _require_binding(connection, previous_run.conversation_id)
                conversation = _require_conversation(connection, previous_run.conversation_id)

                assistant = messages.assistant.complete(assistant_content, now=now)
                binding = previous_binding.bind(provider_conversation_id, now=now)
                completed = previous_run.complete(token, now=now)
                succeeded = previous_attempt.succeed(now=now)
                _validate_final_references(
                    connection,
                    previous_run,
                    conversation.book_id,
                    assistant.id,
                    references,
                )

                _save_attempt_transition(connection, previous_attempt, succeeded)
                _save_message_transition(
                    connection,
                    messages.assistant,
                    assistant,
                    previous_run,
                    token,
                )
                _save_binding_transition(connection, previous_binding, binding)
                for reference in references:
                    connection.execute(
                        """
                        INSERT INTO chat_references(
                            id, message_id, citation_number, book_id, document_part_id,
                            chapter_refs_json, label, passage, location_type,
                            location_value, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        _reference_values(reference),
                    )
                _save_run_transition(
                    connection,
                    previous_run,
                    completed,
                    ChatRunEventType.COMPLETED,
                    token=token,
                )
                return ChatRunResult(
                    run=completed,
                    assistant_message=assistant,
                    references=references,
                )
        except sqlite3.IntegrityError as error:
            raise ChatRepositoryConflictError(
                "Provider finalization collided with existing durable Chat state"
            ) from error

    def fail(
        self,
        run_id: str,
        token: ChatLeaseToken,
        error: ChatError,
        *,
        now: datetime,
    ) -> ChatRun:
        try:
            with self._connect(write=True) as connection:
                previous = _require_fenced_run(connection, run_id, token)
                current = previous.fail(error, token, now=now)
                _save_run_transition(
                    connection,
                    previous,
                    current,
                    ChatRunEventType.FAILED,
                    token=token,
                )
                return current
        except sqlite3.IntegrityError as integrity_error:
            raise ChatRepositoryConflictError(
                "Failed Chat Run could not be persisted safely"
            ) from integrity_error

    def request_cancel(self, run_id: str, *, now: datetime) -> ChatRun:
        with self._connect(write=True) as connection:
            previous = _require_run(connection, run_id)
            current = previous.request_cancellation(now=now)
            if current is previous:
                return previous
            _save_run_transition(connection, previous, current, ChatRunEventType.UPDATED)
            return current

    def cancel(
        self,
        run_id: str,
        token: ChatLeaseToken | None,
        *,
        now: datetime,
    ) -> ChatRun:
        try:
            with self._connect(write=True) as connection:
                previous = (
                    _require_fenced_run(connection, run_id, token)
                    if token is not None
                    else _require_run(connection, run_id)
                )
                attempt = _get_provider_attempt(connection, previous.id, previous.attempt)
                terminal_attempt: ChatProviderAttempt | None = None
                if attempt is not None and attempt.status is ProviderAttemptStatus.PREPARED:
                    terminal_attempt = attempt.fail_terminal(now=now)
                current = previous.cancel(token=token, now=now)
                if terminal_attempt is not None and attempt is not None:
                    if token is None:
                        raise ChatRepositoryConflictError(
                            "A prepared Provider attempt requires a running Chat Run Lease"
                        )
                    _require_run_fence(connection, previous, token)
                    _save_attempt_transition(connection, attempt, terminal_attempt)
                _save_run_transition(
                    connection,
                    previous,
                    current,
                    ChatRunEventType.CANCELLED,
                    token=token,
                )
                return current
        except sqlite3.IntegrityError as error:
            raise ChatRepositoryConflictError(
                "Cancelled Chat Run could not be persisted safely"
            ) from error

    def retry(
        self,
        run_id: str,
        client_retry_id: str,
        *,
        now: datetime,
    ) -> ChatRetryResult:
        try:
            with self._connect(write=True) as connection:
                retry_row = connection.execute(
                    """
                    SELECT run_attempt FROM chat_run_retries
                    WHERE chat_run_id = ? AND client_retry_id = ?
                    """,
                    (run_id, client_retry_id),
                ).fetchone()
                if retry_row is not None:
                    return ChatRetryResult(
                        run=_require_run(connection, run_id),
                        client_retry_id=client_retry_id,
                        replayed=True,
                    )

                previous = _require_run(connection, run_id)
                active_row = _find_active_run(connection, previous.conversation_id)
                if active_row is not None and str(active_row["id"]) != previous.id:
                    raise ConversationBusyError(str(active_row["id"]))
                current = previous.retry(now=now)
                connection.execute(
                    """
                    INSERT INTO chat_run_retries(
                        chat_run_id, client_retry_id, run_attempt, created_at
                    ) VALUES (?, ?, ?, ?)
                    """,
                    (run_id, client_retry_id, current.attempt, now.isoformat()),
                )
                _save_run_transition(connection, previous, current, ChatRunEventType.UPDATED)
                return ChatRetryResult(
                    run=current,
                    client_retry_id=client_retry_id,
                    replayed=False,
                )
        except sqlite3.IntegrityError as error:
            raise ChatRepositoryConflictError(
                "Chat retry collided with another durable retry"
            ) from error

    def list_events_after(
        self,
        run_id: str,
        *,
        after_event_id: int | None,
        limit: int,
    ) -> tuple[ChatRunEvent, ...]:
        if after_event_id is not None and after_event_id < 0:
            raise ValueError("Chat Run Event cursor cannot be negative")
        if limit < 1 or limit > _MAX_EVENT_PAGE:
            raise ValueError(f"Chat Run Event page limit must be between 1 and {_MAX_EVENT_PAGE}")
        cursor = after_event_id or 0
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT * FROM chat_run_events
                WHERE chat_run_id = ? AND id > ?
                ORDER BY id
                LIMIT ?
                """,
                (run_id, cursor, limit),
            ).fetchall()
        return tuple(_event_from_row(row) for row in rows)


def _validate_existing_conversation(
    connection: sqlite3.Connection,
    conversation: Conversation,
    workspace_id: str,
    provider: str,
) -> None:
    if conversation.workspace_id != workspace_id:
        raise ChatRepositoryConflictError(
            "Book Conversation points at a different ExternalWorkspace"
        )
    binding = _require_binding(connection, conversation.id)
    if binding.provider != provider:
        raise ChatRepositoryConflictError(
            "Book Conversation binding points at a different Provider"
        )


def _validate_new_submission(submission: ChatSubmission) -> None:
    run = submission.run
    if (
        run.status is not ChatRunStatus.QUEUED
        or run.phase is not None
        or run.version != 0
        or run.attempt != 1
        or run.effective_scope is not None
        or run.error is not None
        or run.lease_generation != 0
        or run.provider_request_started_at is not None
    ):
        raise ValueError("A submitted Chat Run must be a new queued aggregate")
    if (
        submission.messages.user.version != 0
        or submission.messages.assistant.version != 0
        or submission.messages.assistant.content is not None
    ):
        raise ValueError("A submitted Chat Message pair must be new with an empty assistant")


def _validate_prepared_intent(intent: ChatProviderAttempt) -> None:
    if (
        intent.status is not ProviderAttemptStatus.PREPARED
        or intent.version != 0
        or intent.dispatched_at is not None
        or intent.resolved_at is not None
    ):
        raise ValueError("A new Provider attempt intent must be prepared and undispatched")


def _validate_final_references(
    connection: sqlite3.Connection,
    run: ChatRun,
    book_id: str,
    assistant_message_id: str,
    references: tuple[ChatReference, ...],
) -> None:
    if run.effective_scope is None:
        raise ChatRepositoryConflictError("Final Chat Run has no effective scope")
    if len({reference.id for reference in references}) != len(references):
        raise ChatRepositoryConflictError("Chat References contain duplicate local IDs")
    if len({reference.citation_number for reference in references}) != len(references):
        raise ChatRepositoryConflictError("Chat References contain duplicate citation numbers")
    allowed_part_ids = set(run.effective_scope.document_part_ids)
    for reference in references:
        if (
            reference.message_id != assistant_message_id
            or reference.book_id != book_id
            or reference.document_part_id not in allowed_part_ids
        ):
            raise ChatRepositoryConflictError(
                "Chat Reference is outside the finalized local Book scope"
            )
    placeholders = ",".join("?" for _ in allowed_part_ids)
    rows = connection.execute(
        f"""
        SELECT part.id
        FROM document_parts AS part
        JOIN document_assets AS asset ON asset.id = part.asset_id
        WHERE asset.book_id = ? AND part.id IN ({placeholders})
        """,
        (book_id, *sorted(allowed_part_ids)),
    ).fetchall()
    persisted_part_ids = {str(row["id"]) for row in rows}
    if persisted_part_ids != allowed_part_ids:
        raise ChatRepositoryConflictError(
            "Effective Chat scope contains a missing or cross-Book Document Part"
        )


def _find_active_run(
    connection: sqlite3.Connection,
    conversation_id: str,
) -> sqlite3.Row | None:
    row = connection.execute(
        """
        SELECT id FROM chat_runs
        WHERE conversation_id = ? AND status IN ('queued', 'running')
        LIMIT 1
        """,
        (conversation_id,),
    ).fetchone()
    return cast(sqlite3.Row | None, row)


def _require_conversation(
    connection: sqlite3.Connection,
    conversation_id: str,
) -> Conversation:
    row = connection.execute(
        "SELECT * FROM conversations WHERE id = ?",
        (conversation_id,),
    ).fetchone()
    if row is None:
        raise KeyError(f"Unknown Conversation: {conversation_id}")
    return _conversation_from_row(row)


def _require_binding(
    connection: sqlite3.Connection,
    conversation_id: str,
) -> ProviderConversationBinding:
    row = connection.execute(
        "SELECT * FROM provider_conversation_bindings WHERE conversation_id = ?",
        (conversation_id,),
    ).fetchone()
    if row is None:
        raise ChatRepositoryConflictError("Conversation Provider binding is unavailable")
    return _binding_from_row(row)


def _require_run(connection: sqlite3.Connection, run_id: str) -> ChatRun:
    row = connection.execute(
        "SELECT * FROM chat_runs WHERE id = ?",
        (run_id,),
    ).fetchone()
    if row is None:
        raise KeyError(f"Unknown Chat Run: {run_id}")
    return _run_from_row(row)


def _require_fenced_run(
    connection: sqlite3.Connection,
    run_id: str,
    token: ChatLeaseToken,
) -> ChatRun:
    run = _require_run(connection, run_id)
    _require_run_fence(connection, run, token)
    return run


def _require_run_fence(
    connection: sqlite3.Connection,
    run: ChatRun,
    token: ChatLeaseToken,
) -> None:
    row = connection.execute(
        """
        SELECT 1 FROM chat_runs
        WHERE id = ? AND version = ? AND status = 'running'
            AND lease_owner = ? AND lease_generation = ?
        """,
        (run.id, run.version, token.owner, token.generation),
    ).fetchone()
    if row is None:
        raise ChatRepositoryConflictError(
            "Chat Run Lease owner, generation, or aggregate version is stale"
        )


def _require_message_pair(
    connection: sqlite3.Connection,
    run: ChatRun,
) -> ChatMessagePair:
    rows = connection.execute(
        """
        SELECT * FROM chat_messages
        WHERE chat_run_id = ?
        ORDER BY CASE role WHEN 'user' THEN 0 ELSE 1 END
        """,
        (run.id,),
    ).fetchall()
    if len(rows) != 2:
        raise ValueError("Chat Run does not have exactly one local Message pair")
    user = _message_from_row(rows[0])
    assistant = _message_from_row(rows[1])
    pair = ChatMessagePair(user=user, assistant=assistant)
    if user.id != run.user_message_id or assistant.id != run.assistant_message_id:
        raise ValueError("Chat Run Message identifiers do not match the persisted pair")
    return pair


def _get_provider_attempt(
    connection: sqlite3.Connection,
    run_id: str,
    run_attempt: int,
) -> ChatProviderAttempt | None:
    row = connection.execute(
        """
        SELECT * FROM chat_provider_attempts
        WHERE chat_run_id = ? AND run_attempt = ?
        """,
        (run_id, run_attempt),
    ).fetchone()
    return _attempt_from_row(row) if row is not None else None


def _require_current_attempt(
    connection: sqlite3.Connection,
    run: ChatRun,
) -> ChatProviderAttempt:
    attempt = _get_provider_attempt(connection, run.id, run.attempt)
    if attempt is None:
        raise ChatRepositoryConflictError("Current Provider attempt is unavailable")
    if attempt.request_fingerprint != run.request_fingerprint:
        raise ChatRepositoryConflictError("Current Provider attempt fingerprint changed")
    return attempt


def _list_references(
    connection: sqlite3.Connection,
    assistant_message_id: str,
) -> tuple[ChatReference, ...]:
    rows = connection.execute(
        """
        SELECT * FROM chat_references
        WHERE message_id = ?
        ORDER BY citation_number, id
        """,
        (assistant_message_id,),
    ).fetchall()
    return tuple(_reference_from_row(row) for row in rows)


def _save_run_transition(
    connection: sqlite3.Connection,
    previous: ChatRun,
    current: ChatRun,
    event_type: ChatRunEventType,
    *,
    token: ChatLeaseToken | None = None,
) -> None:
    if (
        previous.id != current.id
        or current.version != previous.version + 1
        or previous.conversation_id != current.conversation_id
        or previous.client_message_id != current.client_message_id
        or previous.user_message_id != current.user_message_id
        or previous.assistant_message_id != current.assistant_message_id
        or previous.query_scope != current.query_scope
        or previous.question_hash != current.question_hash
        or previous.request_fingerprint != current.request_fingerprint
        or current.lease_generation < previous.lease_generation
    ):
        raise ChatRepositoryConflictError(
            "Chat Run transition must increment one matching aggregate version"
        )

    where = "id = ? AND version = ?"
    parameters: list[object] = [
        current.status.value,
        current.phase.value if current.phase is not None else None,
        current.context_hash,
        _serialize_effective_scope(current.effective_scope),
        current.attempt,
        _serialize_error(current.error),
        _optional_datetime(current.cancel_requested_at),
        current.lease_owner,
        _optional_datetime(current.lease_expires_at),
        current.lease_generation,
        _optional_datetime(current.provider_request_started_at),
        current.updated_at.isoformat(),
        _optional_datetime(current.started_at),
        _optional_datetime(current.completed_at),
        current.version,
        current.id,
        previous.version,
    ]
    if token is not None:
        where += " AND status = 'running' AND lease_owner = ? AND lease_generation = ?"
        parameters.extend((token.owner, token.generation))
    try:
        cursor = connection.execute(
            f"""
            UPDATE chat_runs
            SET status = ?, phase = ?, context_hash = ?, effective_scope_json = ?, attempt = ?,
                error_json = ?, cancel_requested_at = ?, lease_owner = ?,
                lease_expires_at = ?, lease_generation = ?,
                provider_request_started_at = ?, updated_at = ?, started_at = ?,
                completed_at = ?, version = ?
            WHERE {where}
            """,
            tuple(parameters),
        )
    except sqlite3.IntegrityError as error:
        raise ChatRepositoryConflictError(
            "Chat Run transition violated a durable state constraint"
        ) from error
    if cursor.rowcount != 1:
        raise ChatRepositoryConflictError(
            f"Chat Run {current.id} was changed or fenced at version {previous.version}"
        )
    _insert_run_event(connection, current, event_type)


def _save_attempt_transition(
    connection: sqlite3.Connection,
    previous: ChatProviderAttempt,
    current: ChatProviderAttempt,
) -> None:
    if (
        previous.id != current.id
        or previous.chat_run_id != current.chat_run_id
        or previous.run_attempt != current.run_attempt
        or previous.provider != current.provider
        or previous.request_fingerprint != current.request_fingerprint
        or current.version != previous.version + 1
    ):
        raise ChatRepositoryConflictError(
            "Provider attempt transition must increment one matching version"
        )
    try:
        cursor = connection.execute(
            """
            UPDATE chat_provider_attempts
            SET status = ?, updated_at = ?, dispatched_at = ?, resolved_at = ?, version = ?
            WHERE id = ? AND chat_run_id = ? AND run_attempt = ? AND version = ?
            """,
            (
                current.status.value,
                current.updated_at.isoformat(),
                _optional_datetime(current.dispatched_at),
                _optional_datetime(current.resolved_at),
                current.version,
                current.id,
                current.chat_run_id,
                current.run_attempt,
                previous.version,
            ),
        )
    except sqlite3.IntegrityError as error:
        raise ChatRepositoryConflictError(
            "Provider attempt transition violated a durable state constraint"
        ) from error
    if cursor.rowcount != 1:
        raise ChatRepositoryConflictError("Provider attempt was changed by another worker")


def _save_message_transition(
    connection: sqlite3.Connection,
    previous: ChatMessage,
    current: ChatMessage,
    run: ChatRun,
    token: ChatLeaseToken,
) -> None:
    if (
        previous.id != current.id
        or previous.conversation_id != current.conversation_id
        or previous.chat_run_id != current.chat_run_id
        or previous.role is not current.role
        or previous.client_message_id != current.client_message_id
        or current.version != previous.version + 1
    ):
        raise ChatRepositoryConflictError(
            "Chat Message transition must increment one matching version"
        )
    try:
        cursor = connection.execute(
            """
            UPDATE chat_messages
            SET content = ?, updated_at = ?, version = ?
            WHERE id = ? AND chat_run_id = ? AND role = 'assistant'
                AND content IS NULL AND version = ?
                AND EXISTS (
                    SELECT 1 FROM chat_runs
                    WHERE id = ? AND version = ? AND status = 'running'
                        AND lease_owner = ? AND lease_generation = ?
                )
            """,
            (
                current.content,
                current.updated_at.isoformat(),
                current.version,
                current.id,
                current.chat_run_id,
                previous.version,
                run.id,
                run.version,
                token.owner,
                token.generation,
            ),
        )
    except sqlite3.IntegrityError as error:
        raise ChatRepositoryConflictError(
            "Assistant Message transition violated a durable state constraint"
        ) from error
    if cursor.rowcount != 1:
        raise ChatRepositoryConflictError("Assistant Message was changed or fenced")


def _save_binding_transition(
    connection: sqlite3.Connection,
    previous: ProviderConversationBinding,
    current: ProviderConversationBinding,
) -> None:
    if (
        previous.conversation_id != current.conversation_id
        or previous.provider != current.provider
        or current.context_generation != previous.context_generation
        or current.version != previous.version + 1
    ):
        raise ChatRepositoryConflictError(
            "Provider binding transition must increment one matching version"
        )
    try:
        cursor = connection.execute(
            """
            UPDATE provider_conversation_bindings
            SET provider_conversation_id = ?, context_generation = ?, health = ?,
                last_verified_at = ?, updated_at = ?, version = ?
            WHERE conversation_id = ? AND provider = ? AND version = ?
            """,
            (
                current.provider_conversation_id,
                current.context_generation,
                current.health.value,
                _optional_datetime(current.last_verified_at),
                current.updated_at.isoformat(),
                current.version,
                current.conversation_id,
                previous.provider,
                previous.version,
            ),
        )
    except sqlite3.IntegrityError as error:
        raise ChatRepositoryConflictError(
            "Provider binding transition violated a durable state constraint"
        ) from error
    if cursor.rowcount != 1:
        raise ChatRepositoryConflictError("Provider Conversation binding changed concurrently")


def _insert_run_event(
    connection: sqlite3.Connection,
    run: ChatRun,
    event_type: ChatRunEventType,
) -> None:
    try:
        connection.execute(
            """
            INSERT INTO chat_run_events(
                chat_run_id, run_version, event_type, status, phase, error_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run.id,
                run.version,
                event_type.value,
                run.status.value,
                run.phase.value if run.phase is not None else None,
                _serialize_error(run.error),
                run.updated_at.isoformat(),
            ),
        )
    except sqlite3.IntegrityError as error:
        raise ChatRepositoryConflictError(
            "Chat Run event collided with an existing aggregate version"
        ) from error


def _conversation_values(conversation: Conversation) -> tuple[object, ...]:
    return (
        conversation.id,
        conversation.book_id,
        conversation.workspace_id,
        conversation.title,
        conversation.status.value,
        conversation.created_at.isoformat(),
        conversation.updated_at.isoformat(),
        conversation.version,
    )


def _binding_values(binding: ProviderConversationBinding) -> tuple[object, ...]:
    return (
        binding.conversation_id,
        binding.provider,
        binding.provider_conversation_id,
        binding.context_generation,
        binding.health.value,
        _optional_datetime(binding.last_verified_at),
        binding.created_at.isoformat(),
        binding.updated_at.isoformat(),
        binding.version,
    )


def _run_values(run: ChatRun) -> tuple[object, ...]:
    return (
        run.id,
        run.conversation_id,
        run.client_message_id,
        run.user_message_id,
        run.assistant_message_id,
        run.query_scope.type.value,
        _serialize_query_scope(run.query_scope),
        run.context_hash,
        run.question_hash,
        run.request_fingerprint,
        run.status.value,
        run.phase.value if run.phase is not None else None,
        _serialize_effective_scope(run.effective_scope),
        run.attempt,
        _serialize_error(run.error),
        _optional_datetime(run.cancel_requested_at),
        run.lease_owner,
        _optional_datetime(run.lease_expires_at),
        run.lease_generation,
        _optional_datetime(run.provider_request_started_at),
        run.created_at.isoformat(),
        run.updated_at.isoformat(),
        _optional_datetime(run.started_at),
        _optional_datetime(run.completed_at),
        run.version,
    )


def _message_values(message: ChatMessage) -> tuple[object, ...]:
    return (
        message.id,
        message.conversation_id,
        message.chat_run_id,
        message.role.value,
        message.content,
        message.client_message_id,
        message.created_at.isoformat(),
        message.updated_at.isoformat(),
        message.version,
    )


def _attempt_values(attempt: ChatProviderAttempt) -> tuple[object, ...]:
    return (
        attempt.id,
        attempt.chat_run_id,
        attempt.run_attempt,
        attempt.provider,
        attempt.request_fingerprint,
        attempt.status.value,
        attempt.created_at.isoformat(),
        attempt.updated_at.isoformat(),
        _optional_datetime(attempt.dispatched_at),
        _optional_datetime(attempt.resolved_at),
        attempt.version,
    )


def _reference_values(reference: ChatReference) -> tuple[object, ...]:
    return (
        reference.id,
        reference.message_id,
        reference.citation_number,
        reference.book_id,
        reference.document_part_id,
        _canonical_json(list(reference.chapter_refs)),
        reference.label,
        reference.passage,
        reference.location.type.value if reference.location is not None else None,
        reference.location.value if reference.location is not None else None,
        reference.created_at.isoformat(),
    )


def _conversation_from_row(row: sqlite3.Row) -> Conversation:
    return Conversation(
        id=str(row["id"]),
        book_id=str(row["book_id"]),
        workspace_id=str(row["workspace_id"]),
        title=str(row["title"]) if row["title"] is not None else None,
        status=ConversationStatus(str(row["status"])),
        created_at=_datetime(row["created_at"]),
        updated_at=_datetime(row["updated_at"]),
        version=int(row["version"]),
    )


def _binding_from_row(row: sqlite3.Row) -> ProviderConversationBinding:
    return ProviderConversationBinding(
        conversation_id=str(row["conversation_id"]),
        provider=str(row["provider"]),
        provider_conversation_id=(
            str(row["provider_conversation_id"])
            if row["provider_conversation_id"] is not None
            else None
        ),
        context_generation=int(row["context_generation"]),
        health=ProviderBindingHealth(str(row["health"])),
        last_verified_at=_optional_datetime_from_db(row["last_verified_at"]),
        created_at=_datetime(row["created_at"]),
        updated_at=_datetime(row["updated_at"]),
        version=int(row["version"]),
    )


def _run_from_row(row: sqlite3.Row) -> ChatRun:
    return ChatRun(
        id=str(row["id"]),
        conversation_id=str(row["conversation_id"]),
        client_message_id=str(row["client_message_id"]),
        user_message_id=str(row["user_message_id"]),
        assistant_message_id=str(row["assistant_message_id"]),
        query_scope=_parse_query_scope(row["query_scope_json"], str(row["query_scope_type"])),
        question_hash=str(row["question_hash"]),
        request_fingerprint=str(row["request_fingerprint"]),
        context_hash=str(row["context_hash"]) if row["context_hash"] is not None else None,
        status=ChatRunStatus(str(row["status"])),
        phase=ChatRunPhase(str(row["phase"])) if row["phase"] is not None else None,
        effective_scope=_parse_effective_scope(row["effective_scope_json"]),
        attempt=int(row["attempt"]),
        error=_parse_error(row["error_json"]),
        cancel_requested_at=_optional_datetime_from_db(row["cancel_requested_at"]),
        lease_owner=str(row["lease_owner"]) if row["lease_owner"] is not None else None,
        lease_expires_at=_optional_datetime_from_db(row["lease_expires_at"]),
        lease_generation=int(row["lease_generation"]),
        provider_request_started_at=_optional_datetime_from_db(row["provider_request_started_at"]),
        created_at=_datetime(row["created_at"]),
        updated_at=_datetime(row["updated_at"]),
        started_at=_optional_datetime_from_db(row["started_at"]),
        completed_at=_optional_datetime_from_db(row["completed_at"]),
        version=int(row["version"]),
    )


def _message_from_row(row: sqlite3.Row) -> ChatMessage:
    return ChatMessage(
        id=str(row["id"]),
        conversation_id=str(row["conversation_id"]),
        chat_run_id=str(row["chat_run_id"]),
        role=ChatMessageRole(str(row["role"])),
        content=str(row["content"]) if row["content"] is not None else None,
        client_message_id=(
            str(row["client_message_id"]) if row["client_message_id"] is not None else None
        ),
        created_at=_datetime(row["created_at"]),
        updated_at=_datetime(row["updated_at"]),
        version=int(row["version"]),
    )


def _attempt_from_row(row: sqlite3.Row) -> ChatProviderAttempt:
    return ChatProviderAttempt(
        id=str(row["id"]),
        chat_run_id=str(row["chat_run_id"]),
        run_attempt=int(row["run_attempt"]),
        provider=str(row["provider"]),
        request_fingerprint=str(row["request_fingerprint"]),
        status=ProviderAttemptStatus(str(row["status"])),
        created_at=_datetime(row["created_at"]),
        updated_at=_datetime(row["updated_at"]),
        dispatched_at=_optional_datetime_from_db(row["dispatched_at"]),
        resolved_at=_optional_datetime_from_db(row["resolved_at"]),
        version=int(row["version"]),
    )


def _reference_from_row(row: sqlite3.Row) -> ChatReference:
    location_type = row["location_type"]
    location_value = row["location_value"]
    location = None
    if location_type is not None and location_value is not None:
        location = ChatReferenceLocation(
            type=ChatReferenceLocationType(str(location_type)),
            value=str(location_value),
        )
    elif location_type is not None or location_value is not None:
        raise ValueError("Chat Reference location columns are inconsistent")
    return ChatReference(
        id=str(row["id"]),
        message_id=str(row["message_id"]),
        citation_number=int(row["citation_number"]),
        book_id=str(row["book_id"]),
        document_part_id=str(row["document_part_id"]),
        chapter_refs=_parse_string_array(row["chapter_refs_json"], "chapter_refs_json"),
        label=str(row["label"]),
        passage=str(row["passage"]) if row["passage"] is not None else None,
        location=location,
        created_at=_datetime(row["created_at"]),
    )


def _event_from_row(row: sqlite3.Row) -> ChatRunEvent:
    return ChatRunEvent(
        id=int(row["id"]),
        chat_run_id=str(row["chat_run_id"]),
        run_version=int(row["run_version"]),
        event_type=ChatRunEventType(str(row["event_type"])),
        status=ChatRunStatus(str(row["status"])),
        phase=ChatRunPhase(str(row["phase"])) if row["phase"] is not None else None,
        error=_parse_error(row["error_json"]),
        created_at=_datetime(row["created_at"]),
    )


def _serialize_query_scope(scope: QueryScope) -> str:
    return _canonical_json(query_scope_payload(scope))


def _parse_query_scope(value: object, scope_type_column: str) -> QueryScope:
    payload = _load_canonical_json(str(value), "query_scope_json")
    if not isinstance(payload, dict):
        raise ValueError("query_scope_json must be an object")
    data = cast(dict[str, object], payload)
    scope_type = QueryScopeType(_require_string(data.get("type"), "query scope type"))
    if scope_type.value != scope_type_column:
        raise ValueError("query_scope_json type does not match its denormalized column")
    if scope_type is QueryScopeType.SELECTION:
        if set(data) != {"document_part_id", "locator", "selected_text_sha256", "type"}:
            raise ValueError("query_scope_json has an unexpected selection schema")
        locator_payload = data["locator"]
        if not isinstance(locator_payload, dict):
            raise ValueError("query_scope_json locator must be an object")
        locator_data = cast(dict[str, object], locator_payload)
        if set(locator_data) != {"type", "value"}:
            raise ValueError("query_scope_json locator has an unexpected schema")
        return QueryScope(
            type=scope_type,
            document_part_id=_require_string(
                data["document_part_id"], "query scope document_part_id"
            ),
            locator=SelectionLocator(
                type=ChatReferenceLocationType(
                    _require_string(locator_data["type"], "query scope locator type")
                ),
                value=_require_string(locator_data["value"], "query scope locator value"),
            ),
            selected_text_sha256=_require_string(
                data["selected_text_sha256"], "query scope selected_text_sha256"
            ),
        )
    if scope_type is QueryScopeType.NOTES:
        if set(data) != {"note_ids", "type"}:
            raise ValueError("query_scope_json has an unexpected notes schema")
        return QueryScope(
            type=scope_type,
            note_ids=_string_array(data["note_ids"], "query scope note_ids"),
        )
    if set(data) != {"type"}:
        raise ValueError("query_scope_json has an unexpected schema")
    return QueryScope(type=scope_type)


def _insert_context_snapshot(
    connection: sqlite3.Connection,
    run: ChatRun,
    items: tuple[ChatContextItem, ...],
) -> None:
    if run.context_hash is None or chat_context_hash(items) != run.context_hash:
        raise ChatRepositoryConflictError(
            "Context snapshot does not match the Chat Run context hash"
        )
    payload = _canonical_json(
        [
            {"kind": item.kind.value, "reference_id": item.reference_id, "text": item.text}
            for item in items
        ]
    )
    try:
        connection.execute(
            """
            INSERT INTO chat_run_contexts(
                chat_run_id, context_hash, payload_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(chat_run_id) DO UPDATE SET
                context_hash = excluded.context_hash,
                payload_json = excluded.payload_json,
                updated_at = excluded.updated_at
            """,
            (
                run.id,
                run.context_hash,
                payload,
                run.updated_at.isoformat(),
                run.updated_at.isoformat(),
            ),
        )
    except sqlite3.IntegrityError as error:
        raise ChatRepositoryConflictError(
            "Context snapshot collided with existing durable Chat state"
        ) from error


def _load_context_items(
    connection: sqlite3.Connection,
    run: ChatRun,
) -> tuple[ChatContextItem, ...]:
    row = connection.execute(
        "SELECT * FROM chat_run_contexts WHERE chat_run_id = ?",
        (run.id,),
    ).fetchone()
    if row is None:
        return ()
    payload = _load_canonical_json(str(row["payload_json"]), "chat_run_contexts payload_json")
    if not isinstance(payload, list):
        raise ValueError("chat_run_contexts payload_json must be an array")
    items: list[ChatContextItem] = []
    for entry in payload:
        if not isinstance(entry, dict):
            raise ValueError("chat_run_contexts payload item must be an object")
        data = cast(dict[str, object], entry)
        if set(data) != {"kind", "reference_id", "text"}:
            raise ValueError("chat_run_contexts payload item has an unexpected schema")
        items.append(
            ChatContextItem(
                kind=ChatContextItemKind(_require_string(data["kind"], "context item kind")),
                reference_id=_require_string(data["reference_id"], "context item reference"),
                text=_require_string(data["text"], "context item text"),
            )
        )
    snapshot = tuple(items)
    if chat_context_hash(snapshot) != str(row["context_hash"]):
        raise ValueError("chat_run_contexts payload does not match its recorded hash")
    if run.context_hash is not None and run.context_hash != str(row["context_hash"]):
        # A notes retry cleared the run hash; a stale snapshot row is replaced on the
        # next resolution, so only a conflicting non-null pairing is corruption.
        raise ValueError("chat_run_contexts snapshot does not match its Chat Run")
    return snapshot


def _serialize_effective_scope(scope: EffectiveBookScope | None) -> str | None:
    if scope is None:
        return None
    return _canonical_json(
        {
            "book_id": scope.book_id,
            "chapter_refs": list(scope.chapter_refs),
            "document_part_ids": list(scope.document_part_ids),
            "note_ids": list(scope.note_ids),
            "source_labels": list(scope.source_labels),
            "supplemental": [marker.value for marker in scope.supplemental],
            "type": scope.type.value,
        }
    )


_EFFECTIVE_SCOPE_KEYS_V1 = frozenset(
    {"book_id", "chapter_refs", "document_part_ids", "source_labels", "type"}
)
_EFFECTIVE_SCOPE_KEYS_V2 = _EFFECTIVE_SCOPE_KEYS_V1 | {"note_ids", "supplemental"}


def _parse_effective_scope(value: object) -> EffectiveBookScope | None:
    if value is None:
        return None
    payload = _load_canonical_json(str(value), "effective_scope_json")
    if not isinstance(payload, dict):
        raise ValueError("effective_scope_json must be an object")
    data = cast(dict[str, object], payload)
    keys = set(data)
    if keys != _EFFECTIVE_SCOPE_KEYS_V2 and keys != _EFFECTIVE_SCOPE_KEYS_V1:
        raise ValueError("effective_scope_json has an unexpected schema")
    note_ids = _string_array(data["note_ids"], "note_ids") if "note_ids" in data else ()
    supplemental = (
        tuple(
            SupplementalContextKind(marker)
            for marker in _string_array(data["supplemental"], "supplemental")
        )
        if "supplemental" in data
        else ()
    )
    return EffectiveBookScope(
        type=QueryScopeType(_require_string(data["type"], "effective scope type")),
        book_id=_require_string(data["book_id"], "effective scope Book ID"),
        document_part_ids=_string_array(data["document_part_ids"], "document_part_ids"),
        chapter_refs=_string_array(data["chapter_refs"], "chapter_refs"),
        source_labels=_string_array(data["source_labels"], "source_labels"),
        note_ids=note_ids,
        supplemental=supplemental,
    )


def _serialize_error(error: ChatError | None) -> str | None:
    if error is None:
        return None
    return _canonical_json(
        {
            "code": error.code.value,
            "details": [
                {"key": detail.key, "values": list(detail.values)} for detail in error.details
            ],
            "message": error.message,
            "request_id": error.request_id,
            "retriable": error.retriable,
            "retry_after_ms": error.retry_after_ms,
        }
    )


def _parse_error(value: object) -> ChatError | None:
    if value is None:
        return None
    payload = _load_canonical_json(str(value), "error_json")
    if not isinstance(payload, dict):
        raise ValueError("error_json must be an object")
    data = cast(dict[str, object], payload)
    expected = {"code", "details", "message", "request_id", "retriable", "retry_after_ms"}
    if set(data) != expected:
        raise ValueError("error_json has an unexpected schema")
    retriable = data["retriable"]
    if not isinstance(retriable, bool):
        raise ValueError("error_json retriable must be a boolean")
    retry_after = data["retry_after_ms"]
    if retry_after is not None and (
        not isinstance(retry_after, int) or isinstance(retry_after, bool)
    ):
        raise ValueError("error_json retry_after_ms must be an integer or null")
    details_payload = data["details"]
    if not isinstance(details_payload, list):
        raise ValueError("error_json details must be an array")
    details: list[ChatErrorDetail] = []
    for item in details_payload:
        if not isinstance(item, dict):
            raise ValueError("error_json detail must be an object")
        detail = cast(dict[str, object], item)
        if set(detail) != {"key", "values"}:
            raise ValueError("error_json detail has an unexpected schema")
        details.append(
            ChatErrorDetail(
                key=_require_string(detail["key"], "error detail key"),
                values=_string_array(detail["values"], "error detail values"),
            )
        )
    return ChatError(
        code=ChatErrorCode(_require_string(data["code"], "error code")),
        message=_require_string(data["message"], "error message"),
        retriable=retriable,
        request_id=_require_string(data["request_id"], "error request ID"),
        retry_after_ms=retry_after,
        details=tuple(details),
    )


def _parse_string_array(value: object, field_name: str) -> tuple[str, ...]:
    payload = _load_canonical_json(str(value), field_name)
    return _string_array(payload, field_name)


def _string_array(value: object, field_name: str) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise ValueError(f"{field_name} must be an array")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise ValueError(f"{field_name} must contain only strings")
        result.append(item)
    return tuple(result)


def _require_string(value: object, field_name: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field_name} must be text")
    return value


def _load_canonical_json(value: str, field_name: str) -> object:
    try:
        payload: object = json.loads(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"Invalid {field_name} in database") from error
    if _canonical_json(payload) != value:
        raise ValueError(f"Non-canonical {field_name} in database")
    return payload


def _canonical_json(value: object) -> str:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    except (TypeError, ValueError) as error:
        raise ValueError("Value cannot be serialized as canonical JSON") from error


def _datetime(value: object) -> datetime:
    return datetime.fromisoformat(str(value))


def _optional_datetime(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _optional_datetime_from_db(value: object) -> datetime | None:
    return _datetime(value) if value is not None else None
