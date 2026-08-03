"""Provider-neutral durable chat domain models.

The public chat model contains local identifiers only. Provider conversation identifiers live
exclusively in :class:`ProviderConversationBinding`, which is a server-side persistence record.
"""

from __future__ import annotations

import hashlib
import json
import unicodedata
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from enum import StrEnum

from diandianreading.domain.errors import InvalidStateTransition

MAX_QUESTION_CHARS = 8_000
MAX_SAFE_ERROR_CHARS = 500


class QueryScopeType(StrEnum):
    """Known product scope discriminators.

    Phase 5 core intentionally supports only ``book``. Keeping the other discriminators in the
    domain makes unsupported requests explicit instead of silently widening them to a whole book.
    """

    BOOK = "book"
    CHAPTERS = "chapters"
    NOTES = "notes"
    SELECTION = "selection"


class ConversationStatus(StrEnum):
    ACTIVE = "active"
    ARCHIVED = "archived"


class ProviderBindingHealth(StrEnum):
    UNKNOWN = "unknown"
    ACTIVE = "active"
    MISSING = "missing"
    RESETTING = "resetting"
    ERROR = "error"


class ChatMessageRole(StrEnum):
    USER = "user"
    ASSISTANT = "assistant"


class ChatRunStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ChatRunPhase(StrEnum):
    RESOLVING_SCOPE = "resolving_scope"
    WAITING_FOR_PROVIDER = "waiting_for_provider"
    RECONCILING = "reconciling"
    FINALIZING = "finalizing"


class ChatErrorCode(StrEnum):
    VALIDATION = "VALIDATION"
    PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE"
    NOT_FOUND = "NOT_FOUND"
    SOURCE_NOT_READY = "SOURCE_NOT_READY"
    AUTH_REQUIRED = "AUTH_REQUIRED"
    REMOTE_RATE_LIMITED = "REMOTE_RATE_LIMITED"
    REMOTE_UNAVAILABLE = "REMOTE_UNAVAILABLE"
    REMOTE_PROTOCOL_DRIFT = "REMOTE_PROTOCOL_DRIFT"
    SOURCE_PROCESSING_FAILED = "SOURCE_PROCESSING_FAILED"
    CONVERSATION_BUSY = "CONVERSATION_BUSY"
    IDEMPOTENCY_CONFLICT = "IDEMPOTENCY_CONFLICT"
    AMBIGUOUS_PROVIDER_OUTCOME = "AMBIGUOUS_PROVIDER_OUTCOME"
    UNEXPECTED = "UNEXPECTED"


class ChatRunEventType(StrEnum):
    UPDATED = "chat_run.updated"
    COMPLETED = "chat_run.completed"
    FAILED = "chat_run.failed"
    CANCELLED = "chat_run.cancelled"
    SNAPSHOT = "chat_run.snapshot"


class ProviderAttemptStatus(StrEnum):
    PREPARED = "prepared"
    DISPATCHED = "dispatched"
    SUCCEEDED = "succeeded"
    AMBIGUOUS = "ambiguous"
    FAILED_TERMINAL = "failed_terminal"


class ChatReferenceLocationType(StrEnum):
    EPUB_CFI = "epub_cfi"
    PDF_PAGE = "pdf_page"
    MARKDOWN_OFFSET = "markdown_offset"


_TERMINAL_RUN_STATUSES = frozenset(
    {ChatRunStatus.COMPLETED, ChatRunStatus.FAILED, ChatRunStatus.CANCELLED}
)
_TERMINAL_ATTEMPT_STATUSES = frozenset(
    {
        ProviderAttemptStatus.SUCCEEDED,
        ProviderAttemptStatus.AMBIGUOUS,
        ProviderAttemptStatus.FAILED_TERMINAL,
    }
)
_DEFAULT_RETRYABILITY: dict[ChatErrorCode, bool] = {
    ChatErrorCode.VALIDATION: False,
    ChatErrorCode.PAYLOAD_TOO_LARGE: False,
    ChatErrorCode.NOT_FOUND: False,
    ChatErrorCode.SOURCE_NOT_READY: True,
    ChatErrorCode.AUTH_REQUIRED: True,
    ChatErrorCode.REMOTE_RATE_LIMITED: True,
    ChatErrorCode.REMOTE_UNAVAILABLE: True,
    ChatErrorCode.REMOTE_PROTOCOL_DRIFT: False,
    ChatErrorCode.SOURCE_PROCESSING_FAILED: False,
    ChatErrorCode.CONVERSATION_BUSY: True,
    ChatErrorCode.IDEMPOTENCY_CONFLICT: False,
    ChatErrorCode.AMBIGUOUS_PROVIDER_OUTCOME: False,
    ChatErrorCode.UNEXPECTED: False,
}


def utc_now() -> datetime:
    """Return an aware UTC timestamp."""

    return datetime.now(UTC)


def normalize_chat_question(question: object) -> str:
    """Canonicalize and validate a user question without silently truncating it."""

    if not isinstance(question, str):
        raise TypeError("Chat question must be text")
    normalized = unicodedata.normalize("NFC", question.replace("\r\n", "\n").replace("\r", "\n"))
    _validate_text_controls(normalized, field_name="Chat question")
    normalized = normalized.strip()
    if not normalized:
        raise ValueError("Chat question cannot be empty")
    if len(normalized) > MAX_QUESTION_CHARS:
        raise ValueError(f"Chat question cannot exceed {MAX_QUESTION_CHARS} Unicode characters")
    return normalized


def chat_question_hash(question: str) -> str:
    """Hash a validated canonical question for recovery correlation."""

    return hashlib.sha256(normalize_chat_question(question).encode("utf-8")).hexdigest()


def chat_request_fingerprint(
    conversation_id: str,
    client_message_id: str,
    question: str,
    query_scope: QueryScope,
) -> str:
    """Build the stable fingerprint used by idempotent submission and recovery."""

    _require_identifier(conversation_id, "Conversation ID")
    _require_identifier(client_message_id, "Client message ID")
    payload = {
        "client_message_id": client_message_id,
        "conversation_id": conversation_id,
        "question": normalize_chat_question(question),
        "query_scope": {"type": query_scope.type.value},
        "schema": "whole_book_chat.v1",
    }
    canonical = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class QueryScope:
    type: QueryScopeType

    @classmethod
    def book(cls) -> QueryScope:
        return cls(QueryScopeType.BOOK)

    def require_whole_book(self) -> None:
        if self.type is not QueryScopeType.BOOK:
            raise ValueError(
                "Phase 5 chat supports only whole-book scope; chapters, notes, and selection "
                + "are not supported"
            )


@dataclass(frozen=True, slots=True)
class EffectiveBookScope:
    """The safe, local-only scope actually used for a provider query."""

    type: QueryScopeType
    book_id: str
    document_part_ids: tuple[str, ...]
    chapter_refs: tuple[str, ...]
    source_labels: tuple[str, ...]

    def __post_init__(self) -> None:
        if self.type is not QueryScopeType.BOOK:
            raise ValueError("EffectiveBookScope must have book scope")
        _require_identifier(self.book_id, "Book ID")
        _require_nonempty_unique(self.document_part_ids, "Document part IDs")
        if len(self.source_labels) != len(self.document_part_ids):
            raise ValueError("Effective scope labels must match document parts")
        for label in self.source_labels:
            _require_safe_display_text(label, "Effective scope source label")
        if len(set(self.chapter_refs)) != len(self.chapter_refs):
            raise ValueError("Effective scope chapter references must be unique")
        for chapter_ref in self.chapter_refs:
            _require_identifier(chapter_ref, "Chapter reference")


@dataclass(frozen=True, slots=True)
class Conversation:
    """The single local conversation shell for one Book."""

    id: str
    book_id: str
    workspace_id: str
    status: ConversationStatus
    created_at: datetime
    updated_at: datetime
    version: int
    title: str | None = None

    def __post_init__(self) -> None:
        _require_identifier(self.id, "Conversation ID")
        _require_identifier(self.book_id, "Conversation Book ID")
        _require_identifier(self.workspace_id, "Conversation Workspace ID")
        _require_utc(self.created_at, "Conversation created_at")
        _require_utc(self.updated_at, "Conversation updated_at")
        if self.updated_at < self.created_at:
            raise ValueError("Conversation updated_at cannot precede created_at")
        if self.version < 0:
            raise ValueError("Conversation version cannot be negative")
        if self.title is not None:
            _require_safe_display_text(self.title, "Conversation title")

    @classmethod
    def create(
        cls,
        *,
        conversation_id: str,
        book_id: str,
        workspace_id: str,
        title: str | None = None,
        now: datetime | None = None,
    ) -> Conversation:
        timestamp = now or utc_now()
        return cls(
            id=conversation_id,
            book_id=book_id,
            workspace_id=workspace_id,
            status=ConversationStatus.ACTIVE,
            created_at=timestamp,
            updated_at=timestamp,
            version=0,
            title=title,
        )

    def archive(self, *, now: datetime | None = None) -> Conversation:
        if self.status is ConversationStatus.ARCHIVED:
            return self
        return replace(
            self,
            status=ConversationStatus.ARCHIVED,
            updated_at=now or utc_now(),
            version=self.version + 1,
        )


@dataclass(frozen=True, slots=True)
class ProviderConversationBinding:
    """Server-only binding. Never place this record in a session/public result DTO."""

    conversation_id: str
    provider: str
    provider_conversation_id: str | None
    context_generation: int
    health: ProviderBindingHealth
    last_verified_at: datetime | None
    created_at: datetime
    updated_at: datetime
    version: int

    def __post_init__(self) -> None:
        _require_identifier(self.conversation_id, "Binding Conversation ID")
        _require_identifier(self.provider, "Binding provider")
        if self.provider_conversation_id is not None:
            _require_identifier(self.provider_conversation_id, "Provider Conversation ID")
        if self.context_generation < 0 or self.version < 0:
            raise ValueError("Provider binding counters cannot be negative")
        _require_utc(self.created_at, "Provider binding created_at")
        _require_utc(self.updated_at, "Provider binding updated_at")
        if self.last_verified_at is not None:
            _require_utc(self.last_verified_at, "Provider binding last_verified_at")
        if self.updated_at < self.created_at:
            raise ValueError("Provider binding updated_at cannot precede created_at")
        if self.health is ProviderBindingHealth.ACTIVE and self.provider_conversation_id is None:
            raise ValueError("An active provider binding requires a Provider Conversation ID")

    @classmethod
    def create(
        cls,
        *,
        conversation_id: str,
        provider: str,
        now: datetime | None = None,
    ) -> ProviderConversationBinding:
        timestamp = now or utc_now()
        return cls(
            conversation_id=conversation_id,
            provider=provider,
            provider_conversation_id=None,
            context_generation=0,
            health=ProviderBindingHealth.UNKNOWN,
            last_verified_at=None,
            created_at=timestamp,
            updated_at=timestamp,
            version=0,
        )

    def bind(
        self,
        provider_conversation_id: str,
        *,
        now: datetime | None = None,
    ) -> ProviderConversationBinding:
        _require_identifier(provider_conversation_id, "Provider Conversation ID")
        if (
            self.provider_conversation_id is not None
            and self.provider_conversation_id != provider_conversation_id
        ):
            raise InvalidStateTransition(
                "Provider returned a different Conversation ID for the active local Conversation"
            )
        timestamp = now or utc_now()
        return replace(
            self,
            provider_conversation_id=provider_conversation_id,
            health=ProviderBindingHealth.ACTIVE,
            last_verified_at=timestamp,
            updated_at=timestamp,
            version=self.version + 1,
        )


@dataclass(frozen=True, slots=True)
class ChatMessage:
    id: str
    conversation_id: str
    chat_run_id: str
    role: ChatMessageRole
    content: str | None
    client_message_id: str | None
    created_at: datetime
    updated_at: datetime
    version: int

    def __post_init__(self) -> None:
        _require_identifier(self.id, "Chat Message ID")
        _require_identifier(self.conversation_id, "Chat Message Conversation ID")
        _require_identifier(self.chat_run_id, "Chat Message Run ID")
        _require_utc(self.created_at, "Chat Message created_at")
        _require_utc(self.updated_at, "Chat Message updated_at")
        if self.updated_at < self.created_at:
            raise ValueError("Chat Message updated_at cannot precede created_at")
        if self.version < 0:
            raise ValueError("Chat Message version cannot be negative")
        if self.role is ChatMessageRole.USER:
            if self.content is None:
                raise ValueError("A user Chat Message requires content")
            if normalize_chat_question(self.content) != self.content:
                raise ValueError("User Chat Message content must be canonical")
            if self.client_message_id is None:
                raise ValueError("A user Chat Message requires a client_message_id")
            _require_identifier(self.client_message_id, "Client message ID")
        else:
            if self.client_message_id is not None:
                raise ValueError("An assistant Chat Message cannot have a client_message_id")
            if self.content is not None:
                _require_safe_content(self.content, "Assistant Chat Message content")

    @classmethod
    def user(
        cls,
        *,
        message_id: str,
        conversation_id: str,
        chat_run_id: str,
        client_message_id: str,
        content: str,
        now: datetime | None = None,
    ) -> ChatMessage:
        timestamp = now or utc_now()
        return cls(
            id=message_id,
            conversation_id=conversation_id,
            chat_run_id=chat_run_id,
            role=ChatMessageRole.USER,
            content=normalize_chat_question(content),
            client_message_id=client_message_id,
            created_at=timestamp,
            updated_at=timestamp,
            version=0,
        )

    @classmethod
    def assistant_placeholder(
        cls,
        *,
        message_id: str,
        conversation_id: str,
        chat_run_id: str,
        now: datetime | None = None,
    ) -> ChatMessage:
        timestamp = now or utc_now()
        return cls(
            id=message_id,
            conversation_id=conversation_id,
            chat_run_id=chat_run_id,
            role=ChatMessageRole.ASSISTANT,
            content=None,
            client_message_id=None,
            created_at=timestamp,
            updated_at=timestamp,
            version=0,
        )

    def complete(self, content: str, *, now: datetime | None = None) -> ChatMessage:
        if self.role is not ChatMessageRole.ASSISTANT or self.content is not None:
            raise InvalidStateTransition("Only an empty assistant placeholder can be completed")
        _require_safe_content(content, "Assistant Chat Message content")
        return replace(
            self,
            content=content,
            updated_at=now or utc_now(),
            version=self.version + 1,
        )


@dataclass(frozen=True, slots=True)
class ChatMessagePair:
    user: ChatMessage
    assistant: ChatMessage

    def __post_init__(self) -> None:
        if self.user.role is not ChatMessageRole.USER:
            raise ValueError("Chat Message pair must start with a user Message")
        if self.assistant.role is not ChatMessageRole.ASSISTANT:
            raise ValueError("Chat Message pair must end with an assistant Message")
        if self.user.id == self.assistant.id:
            raise ValueError("Paired Chat Messages require distinct IDs")
        if (
            self.user.conversation_id != self.assistant.conversation_id
            or self.user.chat_run_id != self.assistant.chat_run_id
        ):
            raise ValueError("Paired Chat Messages must belong to the same Conversation and Run")


@dataclass(frozen=True, slots=True)
class ChatErrorDetail:
    """A schema-like safe detail containing local labels/identifiers only."""

    key: str
    values: tuple[str, ...]

    def __post_init__(self) -> None:
        _require_identifier(self.key, "Chat Error detail key")
        for value in self.values:
            _require_safe_display_text(value, "Chat Error detail value")


@dataclass(frozen=True, slots=True)
class ChatError:
    code: ChatErrorCode
    message: str
    retriable: bool
    request_id: str
    retry_after_ms: int | None = None
    details: tuple[ChatErrorDetail, ...] = ()

    def __post_init__(self) -> None:
        _require_safe_display_text(self.message, "Chat Error message")
        if len(self.message) > MAX_SAFE_ERROR_CHARS:
            raise ValueError("Chat Error message is too long")
        _require_identifier(self.request_id, "Chat Error request ID")
        if self.retry_after_ms is not None and self.retry_after_ms < 0:
            raise ValueError("Chat Error retry_after_ms cannot be negative")
        if len({detail.key for detail in self.details}) != len(self.details):
            raise ValueError("Chat Error detail keys must be unique")
        if self.code is ChatErrorCode.AMBIGUOUS_PROVIDER_OUTCOME and self.retriable:
            raise ValueError("An ambiguous provider outcome cannot be retriable")

    @classmethod
    def safe(
        cls,
        code: ChatErrorCode,
        message: str,
        *,
        request_id: str,
        retriable: bool | None = None,
        retry_after_ms: int | None = None,
        details: tuple[ChatErrorDetail, ...] = (),
    ) -> ChatError:
        normalized = _normalize_safe_display_text(message)
        return cls(
            code=code,
            message=normalized,
            retriable=_DEFAULT_RETRYABILITY[code] if retriable is None else retriable,
            request_id=request_id,
            retry_after_ms=retry_after_ms,
            details=details,
        )


@dataclass(frozen=True, slots=True)
class ChatLeaseToken:
    owner: str
    generation: int

    def __post_init__(self) -> None:
        _require_identifier(self.owner, "Chat Run Lease owner")
        if self.generation <= 0:
            raise ValueError("Chat Run Lease generation must be positive")


@dataclass(frozen=True, slots=True)
class ChatRun:
    id: str
    conversation_id: str
    client_message_id: str
    user_message_id: str
    assistant_message_id: str
    query_scope: QueryScope
    question_hash: str
    request_fingerprint: str
    status: ChatRunStatus
    phase: ChatRunPhase | None
    effective_scope: EffectiveBookScope | None
    attempt: int
    error: ChatError | None
    cancel_requested_at: datetime | None
    lease_owner: str | None
    lease_expires_at: datetime | None
    lease_generation: int
    provider_request_started_at: datetime | None
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None
    completed_at: datetime | None
    version: int

    def __post_init__(self) -> None:
        for identifier, field_name in (
            (self.id, "Chat Run ID"),
            (self.conversation_id, "Chat Run Conversation ID"),
            (self.client_message_id, "Chat Run client_message_id"),
            (self.user_message_id, "Chat Run user_message_id"),
            (self.assistant_message_id, "Chat Run assistant_message_id"),
        ):
            _require_identifier(identifier, field_name)
        if self.user_message_id == self.assistant_message_id:
            raise ValueError("Chat Run user and assistant Message IDs must differ")
        _require_sha256(self.question_hash, "Chat Run question_hash")
        _require_sha256(self.request_fingerprint, "Chat Run request_fingerprint")
        if self.attempt < 1 or self.version < 0 or self.lease_generation < 0:
            raise ValueError("Chat Run counters are invalid and attempt starts at one")
        for timestamp, field_name in (
            (self.created_at, "Chat Run created_at"),
            (self.updated_at, "Chat Run updated_at"),
        ):
            _require_utc(timestamp, field_name)
        for optional_timestamp, field_name in (
            (self.cancel_requested_at, "Chat Run cancel_requested_at"),
            (self.lease_expires_at, "Chat Run lease_expires_at"),
            (self.provider_request_started_at, "Chat Run provider_request_started_at"),
            (self.started_at, "Chat Run started_at"),
            (self.completed_at, "Chat Run completed_at"),
        ):
            if optional_timestamp is not None:
                _require_utc(optional_timestamp, field_name)
        if self.updated_at < self.created_at:
            raise ValueError("Chat Run updated_at cannot precede created_at")
        has_lease = self.lease_owner is not None or self.lease_expires_at is not None
        if self.status is ChatRunStatus.RUNNING:
            if self.phase is None:
                raise ValueError("A running Chat Run requires a phase")
            if not self.lease_owner or self.lease_expires_at is None or self.lease_generation <= 0:
                raise ValueError(
                    "A running Chat Run requires an owner, expiry, and fencing generation"
                )
            if self.started_at is None:
                raise ValueError("A running Chat Run requires started_at")
        else:
            if self.phase is not None:
                raise ValueError("Only a running Chat Run may have a phase")
            if has_lease:
                raise ValueError("Only a running Chat Run may hold a Lease")
        terminal = self.status in _TERMINAL_RUN_STATUSES
        if terminal != (self.completed_at is not None):
            raise ValueError("Only terminal Chat Runs have completed_at")
        if (self.status is ChatRunStatus.FAILED) != (self.error is not None):
            raise ValueError("Only a failed Chat Run has an error")
        if self.status is ChatRunStatus.CANCELLED and self.error is not None:
            raise ValueError("A cancelled Chat Run cannot have an error")
        if self.status is ChatRunStatus.COMPLETED and self.effective_scope is None:
            raise ValueError("A completed Chat Run requires effective_scope")
        if self.provider_request_started_at is not None and (
            self.status is ChatRunStatus.QUEUED
            or (self.status is ChatRunStatus.RUNNING and self.phase is ChatRunPhase.RESOLVING_SCOPE)
        ):
            raise ValueError("An undispatched Chat Run cannot have provider_request_started_at")

    @classmethod
    def create(
        cls,
        *,
        run_id: str,
        conversation_id: str,
        client_message_id: str,
        user_message_id: str,
        assistant_message_id: str,
        query_scope: QueryScope,
        question: str,
        request_fingerprint: str,
        now: datetime | None = None,
    ) -> ChatRun:
        timestamp = now or utc_now()
        return cls(
            id=run_id,
            conversation_id=conversation_id,
            client_message_id=client_message_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            query_scope=query_scope,
            question_hash=chat_question_hash(question),
            request_fingerprint=request_fingerprint,
            status=ChatRunStatus.QUEUED,
            phase=None,
            effective_scope=None,
            attempt=1,
            error=None,
            cancel_requested_at=None,
            lease_owner=None,
            lease_expires_at=None,
            lease_generation=0,
            provider_request_started_at=None,
            created_at=timestamp,
            updated_at=timestamp,
            started_at=None,
            completed_at=None,
            version=0,
        )

    @property
    def is_terminal(self) -> bool:
        return self.status in _TERMINAL_RUN_STATUSES

    @property
    def is_cancel_requested(self) -> bool:
        return self.cancel_requested_at is not None

    @property
    def lease_token(self) -> ChatLeaseToken:
        if self.status is not ChatRunStatus.RUNNING or self.lease_owner is None:
            raise InvalidStateTransition("Only a running Chat Run has a Lease token")
        return ChatLeaseToken(self.lease_owner, self.lease_generation)

    def claim(
        self,
        owner: str,
        *,
        lease_expires_at: datetime,
        now: datetime | None = None,
    ) -> ChatRun:
        timestamp = now or utc_now()
        if self.status is not ChatRunStatus.QUEUED:
            raise InvalidStateTransition("Only a queued Chat Run can be claimed")
        if self.cancel_requested_at is not None:
            raise InvalidStateTransition("A cancellation-requested Chat Run cannot be claimed")
        _validate_new_lease(owner, lease_expires_at, timestamp)
        return replace(
            self,
            status=ChatRunStatus.RUNNING,
            phase=ChatRunPhase.RESOLVING_SCOPE,
            lease_owner=owner,
            lease_expires_at=lease_expires_at,
            lease_generation=self.lease_generation + 1,
            started_at=self.started_at or timestamp,
            updated_at=timestamp,
            version=self.version + 1,
        )

    def take_over_expired_lease(
        self,
        owner: str,
        *,
        lease_expires_at: datetime,
        now: datetime | None = None,
    ) -> ChatRun:
        timestamp = now or utc_now()
        if self.status is not ChatRunStatus.RUNNING or self.lease_expires_at is None:
            raise InvalidStateTransition("Only a running Chat Run Lease can be taken over")
        if self.lease_expires_at > timestamp:
            raise InvalidStateTransition("An unexpired Chat Run Lease cannot be taken over")
        _validate_new_lease(owner, lease_expires_at, timestamp)
        return replace(
            self,
            lease_owner=owner,
            lease_expires_at=lease_expires_at,
            lease_generation=self.lease_generation + 1,
            updated_at=timestamp,
            version=self.version + 1,
        )

    def heartbeat(
        self,
        token: ChatLeaseToken,
        *,
        lease_expires_at: datetime,
        now: datetime | None = None,
    ) -> ChatRun:
        timestamp = now or utc_now()
        self.assert_lease(token)
        _validate_new_lease(token.owner, lease_expires_at, timestamp)
        return replace(
            self,
            lease_expires_at=lease_expires_at,
            updated_at=timestamp,
            version=self.version + 1,
        )

    def record_effective_scope(
        self,
        scope: EffectiveBookScope,
        token: ChatLeaseToken,
        *,
        now: datetime | None = None,
    ) -> ChatRun:
        self.assert_lease(token)
        if self.phase is not ChatRunPhase.RESOLVING_SCOPE:
            raise InvalidStateTransition(
                "Effective scope can be recorded only while resolving scope"
            )
        return replace(
            self,
            effective_scope=scope,
            updated_at=now or utc_now(),
            version=self.version + 1,
        )

    def begin_provider_wait(
        self,
        token: ChatLeaseToken,
        *,
        now: datetime | None = None,
    ) -> ChatRun:
        self.assert_lease(token)
        if self.phase is not ChatRunPhase.RESOLVING_SCOPE or self.effective_scope is None:
            raise InvalidStateTransition(
                "Chat Run can wait for the provider only after resolving effective scope"
            )
        timestamp = now or utc_now()
        return replace(
            self,
            phase=ChatRunPhase.WAITING_FOR_PROVIDER,
            provider_request_started_at=timestamp,
            updated_at=timestamp,
            version=self.version + 1,
        )

    def begin_reconciling(
        self,
        token: ChatLeaseToken,
        *,
        now: datetime | None = None,
    ) -> ChatRun:
        self.assert_lease(token)
        if (
            self.phase
            not in {
                ChatRunPhase.WAITING_FOR_PROVIDER,
                ChatRunPhase.RECONCILING,
                ChatRunPhase.FINALIZING,
            }
            or self.provider_request_started_at is None
        ):
            raise InvalidStateTransition("Only a dispatched Chat Run can enter reconciliation")
        if self.phase is ChatRunPhase.RECONCILING:
            return self
        return replace(
            self,
            phase=ChatRunPhase.RECONCILING,
            updated_at=now or utc_now(),
            version=self.version + 1,
        )

    def begin_finalizing(
        self,
        token: ChatLeaseToken,
        *,
        now: datetime | None = None,
    ) -> ChatRun:
        self.assert_lease(token)
        if self.phase not in {
            ChatRunPhase.WAITING_FOR_PROVIDER,
            ChatRunPhase.RECONCILING,
        }:
            raise InvalidStateTransition("Chat Run can finalize only after a provider outcome")
        if self.effective_scope is None or self.provider_request_started_at is None:
            raise InvalidStateTransition(
                "Finalizing requires scope and a dispatched provider request"
            )
        return replace(
            self,
            phase=ChatRunPhase.FINALIZING,
            updated_at=now or utc_now(),
            version=self.version + 1,
        )

    def request_cancellation(self, *, now: datetime | None = None) -> ChatRun:
        if self.status is ChatRunStatus.CANCELLED:
            return self
        if self.is_terminal:
            raise InvalidStateTransition("Cannot request cancellation for a terminal Chat Run")
        if self.cancel_requested_at is not None:
            return self
        timestamp = now or utc_now()
        return replace(
            self,
            cancel_requested_at=timestamp,
            updated_at=timestamp,
            version=self.version + 1,
        )

    def cancel(
        self,
        *,
        token: ChatLeaseToken | None = None,
        now: datetime | None = None,
    ) -> ChatRun:
        if self.is_terminal:
            raise InvalidStateTransition("Cannot cancel a terminal Chat Run")
        if self.cancel_requested_at is None:
            raise InvalidStateTransition("Chat Run cancellation must be requested first")
        if self.provider_request_started_at is not None:
            raise InvalidStateTransition(
                "A dispatched Chat Run cannot be cancelled without provider outcome handling"
            )
        if self.status is ChatRunStatus.RUNNING:
            if token is None:
                raise InvalidStateTransition("Cancelling a running Chat Run requires its Lease")
            self.assert_lease(token)
        timestamp = now or utc_now()
        return replace(
            self,
            status=ChatRunStatus.CANCELLED,
            phase=None,
            error=None,
            lease_owner=None,
            lease_expires_at=None,
            completed_at=timestamp,
            updated_at=timestamp,
            version=self.version + 1,
        )

    def fail(
        self,
        error: ChatError,
        token: ChatLeaseToken,
        *,
        now: datetime | None = None,
    ) -> ChatRun:
        self.assert_lease(token)
        timestamp = now or utc_now()
        return replace(
            self,
            status=ChatRunStatus.FAILED,
            phase=None,
            error=error,
            lease_owner=None,
            lease_expires_at=None,
            completed_at=timestamp,
            updated_at=timestamp,
            version=self.version + 1,
        )

    def retry(self, *, now: datetime | None = None) -> ChatRun:
        if self.status is not ChatRunStatus.FAILED or self.error is None:
            raise InvalidStateTransition("Only a failed Chat Run can be retried")
        if not self.error.retriable:
            raise InvalidStateTransition("This failed Chat Run is not retriable")
        if self.error.code is ChatErrorCode.AMBIGUOUS_PROVIDER_OUTCOME:
            raise InvalidStateTransition("An ambiguous provider outcome cannot be retried")
        return replace(
            self,
            status=ChatRunStatus.QUEUED,
            phase=None,
            effective_scope=None,
            attempt=self.attempt + 1,
            error=None,
            cancel_requested_at=None,
            provider_request_started_at=None,
            completed_at=None,
            updated_at=now or utc_now(),
            version=self.version + 1,
        )

    def complete(self, token: ChatLeaseToken, *, now: datetime | None = None) -> ChatRun:
        self.assert_lease(token)
        if self.phase is not ChatRunPhase.FINALIZING:
            raise InvalidStateTransition("A Chat Run can complete only while finalizing")
        if self.effective_scope is None:
            raise InvalidStateTransition("A completed Chat Run requires effective scope")
        timestamp = now or utc_now()
        return replace(
            self,
            status=ChatRunStatus.COMPLETED,
            phase=None,
            error=None,
            lease_owner=None,
            lease_expires_at=None,
            completed_at=timestamp,
            updated_at=timestamp,
            version=self.version + 1,
        )

    def assert_lease(self, token: ChatLeaseToken) -> None:
        if (
            self.status is not ChatRunStatus.RUNNING
            or self.lease_owner != token.owner
            or self.lease_generation != token.generation
        ):
            raise InvalidStateTransition("Chat Run Lease owner or generation is stale")


@dataclass(frozen=True, slots=True)
class ProviderAttemptIntent:
    id: str
    chat_run_id: str
    run_attempt: int
    provider: str
    request_fingerprint: str
    status: ProviderAttemptStatus
    created_at: datetime
    updated_at: datetime
    dispatched_at: datetime | None
    resolved_at: datetime | None
    version: int

    def __post_init__(self) -> None:
        _require_identifier(self.id, "Provider attempt ID")
        _require_identifier(self.chat_run_id, "Provider attempt Chat Run ID")
        _require_identifier(self.provider, "Provider attempt provider")
        _require_sha256(self.request_fingerprint, "Provider attempt request fingerprint")
        if self.run_attempt < 1 or self.version < 0:
            raise ValueError("Provider attempt counters are invalid and run_attempt starts at one")
        _require_utc(self.created_at, "Provider attempt created_at")
        _require_utc(self.updated_at, "Provider attempt updated_at")
        if self.dispatched_at is not None:
            _require_utc(self.dispatched_at, "Provider attempt dispatched_at")
        if self.resolved_at is not None:
            _require_utc(self.resolved_at, "Provider attempt resolved_at")
        if self.updated_at < self.created_at:
            raise ValueError("Provider attempt updated_at cannot precede created_at")
        requires_dispatch = self.status in {
            ProviderAttemptStatus.DISPATCHED,
            ProviderAttemptStatus.SUCCEEDED,
            ProviderAttemptStatus.AMBIGUOUS,
        }
        if requires_dispatch and self.dispatched_at is None:
            raise ValueError("A dispatched Provider attempt requires dispatched_at")
        if self.status is ProviderAttemptStatus.PREPARED and self.dispatched_at is not None:
            raise ValueError("A prepared Provider attempt cannot have dispatched_at")
        terminal = self.status in _TERMINAL_ATTEMPT_STATUSES
        if terminal != (self.resolved_at is not None):
            raise ValueError("Only terminal Provider attempts have resolved_at")

    @classmethod
    def prepare(
        cls,
        *,
        intent_id: str,
        chat_run_id: str,
        run_attempt: int,
        provider: str,
        request_fingerprint: str,
        now: datetime | None = None,
    ) -> ProviderAttemptIntent:
        timestamp = now or utc_now()
        return cls(
            id=intent_id,
            chat_run_id=chat_run_id,
            run_attempt=run_attempt,
            provider=provider,
            request_fingerprint=request_fingerprint,
            status=ProviderAttemptStatus.PREPARED,
            created_at=timestamp,
            updated_at=timestamp,
            dispatched_at=None,
            resolved_at=None,
            version=0,
        )

    @property
    def is_terminal(self) -> bool:
        return self.status in _TERMINAL_ATTEMPT_STATUSES

    def dispatch(self, *, now: datetime | None = None) -> ProviderAttemptIntent:
        if self.status is not ProviderAttemptStatus.PREPARED:
            raise InvalidStateTransition("Only a prepared Provider attempt can be dispatched")
        timestamp = now or utc_now()
        return replace(
            self,
            status=ProviderAttemptStatus.DISPATCHED,
            dispatched_at=timestamp,
            updated_at=timestamp,
            version=self.version + 1,
        )

    def succeed(self, *, now: datetime | None = None) -> ProviderAttemptIntent:
        return self._resolve(ProviderAttemptStatus.SUCCEEDED, now=now)

    def mark_ambiguous(self, *, now: datetime | None = None) -> ProviderAttemptIntent:
        return self._resolve(ProviderAttemptStatus.AMBIGUOUS, now=now)

    def fail_terminal(self, *, now: datetime | None = None) -> ProviderAttemptIntent:
        if self.status is ProviderAttemptStatus.PREPARED:
            timestamp = now or utc_now()
            return replace(
                self,
                status=ProviderAttemptStatus.FAILED_TERMINAL,
                resolved_at=timestamp,
                updated_at=timestamp,
                version=self.version + 1,
            )
        return self._resolve(ProviderAttemptStatus.FAILED_TERMINAL, now=now)

    def _resolve(
        self,
        status: ProviderAttemptStatus,
        *,
        now: datetime | None,
    ) -> ProviderAttemptIntent:
        if self.status is not ProviderAttemptStatus.DISPATCHED:
            raise InvalidStateTransition(
                f"Provider attempt cannot become {status.value} from {self.status.value}"
            )
        timestamp = now or utc_now()
        return replace(
            self,
            status=status,
            resolved_at=timestamp,
            updated_at=timestamp,
            version=self.version + 1,
        )


@dataclass(frozen=True, slots=True)
class ChatReferenceLocation:
    type: ChatReferenceLocationType
    value: str

    def __post_init__(self) -> None:
        _require_safe_display_text(self.value, "Chat Reference location")


@dataclass(frozen=True, slots=True)
class ChatReference:
    """A local citation projection; it intentionally has no Provider Source ID."""

    id: str
    message_id: str
    citation_number: int
    book_id: str
    document_part_id: str
    chapter_refs: tuple[str, ...]
    label: str
    passage: str | None
    location: ChatReferenceLocation | None
    created_at: datetime

    def __post_init__(self) -> None:
        _require_identifier(self.id, "Chat Reference ID")
        _require_identifier(self.message_id, "Chat Reference Message ID")
        _require_identifier(self.book_id, "Chat Reference Book ID")
        _require_identifier(self.document_part_id, "Chat Reference Document Part ID")
        if self.citation_number <= 0:
            raise ValueError("Chat Reference citation_number must be positive")
        if len(set(self.chapter_refs)) != len(self.chapter_refs):
            raise ValueError("Chat Reference chapter_refs must be unique")
        for chapter_ref in self.chapter_refs:
            _require_identifier(chapter_ref, "Chat Reference chapter reference")
        _require_safe_display_text(self.label, "Chat Reference label")
        if self.passage is not None:
            _require_safe_content(self.passage, "Chat Reference passage")
        _require_utc(self.created_at, "Chat Reference created_at")


@dataclass(frozen=True, slots=True)
class ChatRunEvent:
    """An immutable, append-only, session-safe Chat Run event."""

    id: int
    chat_run_id: str
    run_version: int
    event_type: ChatRunEventType
    status: ChatRunStatus
    phase: ChatRunPhase | None
    error: ChatError | None
    created_at: datetime

    def __post_init__(self) -> None:
        if self.id <= 0:
            raise ValueError("Chat Run Event ID must be positive")
        _require_identifier(self.chat_run_id, "Chat Run Event Run ID")
        if self.run_version < 0:
            raise ValueError("Chat Run Event version cannot be negative")
        _require_utc(self.created_at, "Chat Run Event created_at")
        if (self.status is ChatRunStatus.RUNNING) != (self.phase is not None):
            raise ValueError("Chat Run Event phase is present only for running status")
        if (self.status is ChatRunStatus.FAILED) != (self.error is not None):
            raise ValueError("Chat Run Event error is present only for failed status")
        expected_terminal_type = {
            ChatRunStatus.COMPLETED: ChatRunEventType.COMPLETED,
            ChatRunStatus.FAILED: ChatRunEventType.FAILED,
            ChatRunStatus.CANCELLED: ChatRunEventType.CANCELLED,
        }.get(self.status)
        if expected_terminal_type is not None and self.event_type not in {
            expected_terminal_type,
            ChatRunEventType.SNAPSHOT,
        }:
            raise ValueError("Terminal Chat Run Event type does not match its status")

    @classmethod
    def from_run(
        cls,
        *,
        event_id: int,
        run: ChatRun,
        event_type: ChatRunEventType,
        now: datetime | None = None,
    ) -> ChatRunEvent:
        return cls(
            id=event_id,
            chat_run_id=run.id,
            run_version=run.version,
            event_type=event_type,
            status=run.status,
            phase=run.phase,
            error=run.error,
            created_at=now or utc_now(),
        )


def _validate_new_lease(owner: str, lease_expires_at: datetime, now: datetime) -> None:
    _require_identifier(owner, "Chat Run Lease owner")
    _require_utc(now, "Chat Run Lease current time")
    _require_utc(lease_expires_at, "Chat Run Lease expiry")
    if lease_expires_at <= now:
        raise ValueError("Chat Run Lease expiry must be in the future")


def _require_utc(value: datetime, field_name: str) -> None:
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError(f"{field_name} must be an aware UTC datetime")


def _require_identifier(value: object, field_name: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} cannot be empty")
    if len(value) > 512:
        raise ValueError(f"{field_name} is too long")
    _validate_text_controls(value, field_name=field_name, allow_layout=False)


def _require_nonempty_unique(values: tuple[str, ...], field_name: str) -> None:
    if not values:
        raise ValueError(f"{field_name} cannot be empty")
    if len(set(values)) != len(values):
        raise ValueError(f"{field_name} must be unique")
    for value in values:
        _require_identifier(value, field_name)


def _require_sha256(value: str, field_name: str) -> None:
    if len(value) != 64 or any(character not in "0123456789abcdef" for character in value):
        raise ValueError(f"{field_name} must be a lowercase SHA-256 digest")


def _validate_text_controls(
    value: str,
    *,
    field_name: str,
    allow_layout: bool = True,
) -> None:
    allowed: set[str] = {"\n", "\t"} if allow_layout else set()
    if any(
        (unicodedata.category(character) in {"Cc", "Cs"} and character not in allowed)
        for character in value
    ):
        raise ValueError(f"{field_name} contains unsupported control characters")


def _require_safe_content(value: object, field_name: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} cannot be empty")
    _validate_text_controls(value, field_name=field_name)


def _normalize_safe_display_text(value: object) -> str:
    if not isinstance(value, str):
        raise TypeError("Safe display text must be text")
    normalized = unicodedata.normalize("NFC", value)
    _validate_text_controls(normalized, field_name="Safe display text", allow_layout=False)
    normalized = " ".join(normalized.split())
    if not normalized:
        raise ValueError("Safe display text cannot be empty")
    return normalized


def _require_safe_display_text(value: str, field_name: str) -> None:
    if _normalize_safe_display_text(value) != value:
        raise ValueError(f"{field_name} must already be normalized safe display text")


ChatQueryScope = QueryScope
ChatScopeType = QueryScopeType
EffectiveScope = EffectiveBookScope
ChatProviderAttempt = ProviderAttemptIntent
ChatProviderAttemptStatus = ProviderAttemptStatus
ProviderAttemptIntentStatus = ProviderAttemptStatus
ChatRunLeaseToken = ChatLeaseToken
