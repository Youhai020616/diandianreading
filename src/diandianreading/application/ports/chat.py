"""High-level persistence Port for durable whole-book chat.

Repository operations are deliberately transaction-shaped. A SQLite adapter can implement each
mutation with lease-generation fencing and one transaction without exposing table-level details to
the application use case.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Protocol

from diandianreading.domain.chat import (
    ChatContextItem,
    ChatContextItemKind,
    ChatError,
    ChatLeaseToken,
    ChatMessage,
    ChatMessagePair,
    ChatProviderAttempt,
    ChatReference,
    ChatRun,
    ChatRunEvent,
    ChatRunPhase,
    Conversation,
    EffectiveBookScope,
    ProviderAttemptStatus,
    ProviderConversationBinding,
    QueryScopeType,
    SelectionLocator,
    chat_context_hash,
    supplemental_text_hash,
)
from diandianreading.domain.models import (
    Book,
    CredentialRef,
    DocumentPart,
    ExternalSource,
    WorkspaceRef,
)


class ChatSubmissionDisposition(StrEnum):
    CREATED = "created"
    REPLAYED = "replayed"


@dataclass(frozen=True, slots=True)
class ConversationEnsureResult:
    """Session-safe result; ``Conversation.workspace_id`` is a local ID."""

    conversation: Conversation
    created: bool


class SelectionVerifier(Protocol):
    """Server-side check that a selection really addresses the local source text.

    Implementations read the local reading document (ReadingService-style) without the
    chat use case importing the reading use case. Return ``True`` only for a positive
    match; return ``False`` when the text cannot be read or does not match, in which
    case the selection is kept as user-provided supplemental context (ai-chat.md §4.1).
    """

    def verify_selection(
        self,
        *,
        book_id: str,
        document_part_id: str,
        locator: SelectionLocator,
        selected_text: str,
    ) -> bool: ...


@dataclass(frozen=True, slots=True)
class ChatSubmission:
    """All local records that must be inserted by one idempotent transaction."""

    messages: ChatMessagePair
    run: ChatRun
    context: tuple[ChatContextItem, ...] = ()

    def __post_init__(self) -> None:
        if self.messages.user.chat_run_id != self.run.id:
            raise ValueError("Submitted Chat Messages must reference the submitted Chat Run")
        if self.messages.user.conversation_id != self.run.conversation_id:
            raise ValueError("Submitted Chat Messages and Run must share a Conversation")
        if self.messages.user.id != self.run.user_message_id:
            raise ValueError("Submitted user Message does not match Chat Run user_message_id")
        if self.messages.assistant.id != self.run.assistant_message_id:
            raise ValueError(
                "Submitted assistant Message does not match Chat Run assistant_message_id"
            )
        if self.messages.user.client_message_id != self.run.client_message_id:
            raise ValueError("Submitted client_message_id values do not match")
        if self.run.query_scope.type is QueryScopeType.SELECTION:
            if (
                len(self.context) != 1
                or self.context[0].kind is not ChatContextItemKind.SELECTION
                or self.context[0].reference_id != self.run.query_scope.document_part_id
                or chat_context_hash(self.context) != self.run.context_hash
                or supplemental_text_hash(self.context[0].text)
                != self.run.query_scope.selected_text_sha256
            ):
                raise ValueError(
                    "Selection submission requires one matching selection context snapshot"
                )
        elif self.context:
            raise ValueError("Only a selection submission carries client context")


@dataclass(frozen=True, slots=True)
class ChatSubmissionResult:
    """Session-safe idempotent submission result with explicit replay metadata."""

    messages: ChatMessagePair
    run: ChatRun
    disposition: ChatSubmissionDisposition

    @property
    def replayed(self) -> bool:
        return self.disposition is ChatSubmissionDisposition.REPLAYED

    @property
    def terminal_replay(self) -> bool:
        return self.replayed and self.run.is_terminal


@dataclass(frozen=True, slots=True)
class ChatMessageCursor:
    created_at: datetime
    message_id: str


@dataclass(frozen=True, slots=True)
class ChatMessagePage:
    """Bounded session-safe local Message page."""

    messages: tuple[ChatMessage, ...]
    next_cursor: ChatMessageCursor | None


@dataclass(frozen=True, slots=True)
class ChatRunResult:
    """Session-safe run snapshot. No field can contain a Provider identifier."""

    run: ChatRun
    assistant_message: ChatMessage
    references: tuple[ChatReference, ...]

    def __post_init__(self) -> None:
        if self.assistant_message.id != self.run.assistant_message_id:
            raise ValueError("Chat Run result contains the wrong assistant Message")
        if any(reference.message_id != self.assistant_message.id for reference in self.references):
            raise ValueError("Chat Run result contains a Reference for another Message")


@dataclass(frozen=True, slots=True)
class ChatRetryResult:
    run: ChatRun
    client_retry_id: str
    replayed: bool


@dataclass(frozen=True, slots=True)
class ChatExecutionContext:
    """Server-only worker DTO.

    This type intentionally contains Provider IDs through ``workspace``, ``sources``, ``binding``
    and the opaque credential reference. It must never be placed in an API/session result.
    """

    conversation: Conversation
    binding: ProviderConversationBinding
    run: ChatRun
    messages: ChatMessagePair
    book: Book
    workspace: WorkspaceRef
    sources: tuple[ExternalSource, ...]
    parts: tuple[DocumentPart, ...]
    credential: CredentialRef
    provider_attempt: ChatProviderAttempt | None
    context_items: tuple[ChatContextItem, ...] = ()


class ChatRepositoryError(Exception):
    """Base class for atomic repository rejections safe to map at the application boundary."""


class ChatIdempotencyConflictError(ChatRepositoryError):
    """The same local idempotency key was reused for a different request fingerprint."""


class ConversationBusyError(ChatRepositoryError):
    """A second non-terminal Turn was rejected for the same Conversation."""

    def __init__(self, active_run_id: str) -> None:
        super().__init__("Conversation already has an active Chat Run")
        self.active_run_id: str = active_run_id


class ChatRepositoryConflictError(ChatRepositoryError):
    """An optimistic version or lease-generation check rejected a stale worker."""


class ChatRepository(Protocol):
    """Provider-neutral durable Chat repository with high-level atomic operations."""

    def ensure_conversation(
        self,
        *,
        book_id: str,
        conversation_id: str,
        now: datetime,
        title: str | None = None,
    ) -> ConversationEnsureResult:
        """Create the Book's unique Conversation or return the existing one atomically."""
        ...

    def get_conversation(self, conversation_id: str) -> Conversation | None: ...

    def get_conversation_for_book(self, book_id: str) -> Conversation | None: ...

    def get_active_run(self, conversation_id: str) -> ChatRun | None: ...

    def get_execution_context(self, run_id: str) -> ChatExecutionContext | None:
        """Load all server-only local context required to execute or recover one Run."""
        ...

    def submit(self, submission: ChatSubmission) -> ChatSubmissionResult:
        """Atomically insert the pair and Run, replay, or reject conflict/busy."""
        ...

    def list_messages(
        self,
        conversation_id: str,
        *,
        before: ChatMessageCursor | None,
        limit: int,
    ) -> ChatMessagePage: ...

    def get_run(self, run_id: str) -> ChatRun | None: ...

    def get_result(self, run_id: str) -> ChatRunResult | None: ...

    def claim(
        self,
        run_id: str,
        owner: str,
        *,
        lease_expires_at: datetime,
        now: datetime,
    ) -> ChatRun: ...

    def claim_next(
        self,
        owner: str,
        *,
        lease_expires_at: datetime,
        now: datetime,
    ) -> ChatRun | None: ...

    def takeover(
        self,
        run_id: str,
        owner: str,
        *,
        lease_expires_at: datetime,
        now: datetime,
    ) -> ChatRun: ...

    def heartbeat(
        self,
        run_id: str,
        token: ChatLeaseToken,
        *,
        lease_expires_at: datetime,
        now: datetime,
    ) -> ChatRun: ...

    def persist_effective_scope(
        self,
        run_id: str,
        token: ChatLeaseToken,
        scope: EffectiveBookScope,
        *,
        now: datetime,
    ) -> ChatRun:
        """Fence and persist the local effective scope before any Provider call."""
        ...

    def persist_context_snapshot(
        self,
        run_id: str,
        token: ChatLeaseToken,
        items: tuple[ChatContextItem, ...],
        *,
        now: datetime,
    ) -> ChatRun:
        """Fence and persist the notes supplemental snapshot before any Provider call."""
        ...

    def persist_phase(
        self,
        run_id: str,
        token: ChatLeaseToken,
        phase: ChatRunPhase,
        *,
        now: datetime,
    ) -> ChatRun: ...

    def prepare_provider_attempt(
        self,
        intent: ChatProviderAttempt,
        token: ChatLeaseToken,
    ) -> ChatProviderAttempt:
        """Insert or replay the matching prepared intent before dispatch."""
        ...

    def dispatch_provider_attempt(
        self,
        run_id: str,
        intent_id: str,
        token: ChatLeaseToken,
        *,
        now: datetime,
    ) -> tuple[ChatRun, ChatProviderAttempt]:
        """Atomically mark intent dispatched and Run waiting before ``ask`` is invoked."""
        ...

    def terminate_provider_attempt(
        self,
        run_id: str,
        intent_id: str,
        token: ChatLeaseToken,
        status: ProviderAttemptStatus,
        *,
        now: datetime,
    ) -> ChatProviderAttempt:
        """Persist an ``ambiguous`` or ``failed_terminal`` attempt outcome."""
        ...

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
        """Atomically complete all durable effects of a successful Provider Turn.

        The transaction marks the intent succeeded, fills the assistant Message, updates the
        server-only binding, inserts local References, completes the Run, and appends its event.
        """
        ...

    def fail(
        self,
        run_id: str,
        token: ChatLeaseToken,
        error: ChatError,
        *,
        now: datetime,
    ) -> ChatRun:
        """Atomically fail the Run and append a safe terminal event."""
        ...

    def request_cancel(self, run_id: str, *, now: datetime) -> ChatRun: ...

    def cancel(
        self,
        run_id: str,
        token: ChatLeaseToken | None,
        *,
        now: datetime,
    ) -> ChatRun:
        """Atomically cancel at a proven pre-dispatch safe point and append an event."""
        ...

    def retry(
        self,
        run_id: str,
        client_retry_id: str,
        *,
        now: datetime,
    ) -> ChatRetryResult:
        """Idempotently requeue a safely retriable failed Run without duplicating Messages."""
        ...

    def list_events_after(
        self,
        run_id: str,
        *,
        after_event_id: int | None,
        limit: int,
    ) -> tuple[ChatRunEvent, ...]: ...
