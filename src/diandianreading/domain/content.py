"""Content asset domain models for the knowledge and creation workbench.

Frozen by ADR-0008. Two invariants carry most of the weight here:

* A :class:`Note` is independent of :class:`~diandianreading.domain.annotations.Annotation`.
  Annotations must always be locatable in the body text; an AI answer has no
  anchor, so reusing that table would have forced the anchor to become optional
  and broken the re-anchoring guarantee from ADR-0007.
* Every :class:`ContentRevision` records who wrote it. Without that, a draft
  months later cannot answer "was this paragraph written by a model or by me",
  which is the AI-content risk the PRD calls out.

``SCHEDULED`` and ``PUBLISHED`` belong to the P6 publishing track. They stay in
the enum so that an out-of-scope request becomes an explicit rejection rather
than silently widening what P5 accepts, mirroring how ``QueryScopeType.CHAPTERS``
is kept and refused.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum

from diandianreading.domain.errors import InvalidStateTransition
from diandianreading.domain.models import utc_now

NOTE_TITLE_MAX_CODEPOINTS = 200
NOTE_BODY_MAX_CODEPOINTS = 20_000
CONTENT_TITLE_MAX_CODEPOINTS = 200
CONTENT_BODY_MAX_CODEPOINTS = 100_000
TOPIC_MAX_CODEPOINTS = 200
TARGET_PLATFORM_MAX_CODEPOINTS = 64
MAX_CONTENT_SOURCES = 50


class NoteSourceKind(StrEnum):
    """Where a note came from; part of its idempotency identity."""

    CHAT_MESSAGE = "chat_message"
    ANNOTATION = "annotation"
    MANUAL = "manual"


class ContentType(StrEnum):
    """The seven content types frozen by PRD 6.5."""

    READING_REPORT = "reading_report"
    READING_CARD = "reading_card"
    SLIDES = "slides"
    PODCAST_SCRIPT = "podcast_script"
    VIDEO_SCRIPT = "video_script"
    SHORT_POST = "short_post"
    QUIZ = "quiz"


class ContentStatus(StrEnum):
    """Content lifecycle from PRD 6.5; the last two are P6 only."""

    QUEUED = "queued"
    GENERATING = "generating"
    DRAFT = "draft"
    EDITING = "editing"
    APPROVED = "approved"
    SCHEDULED = "scheduled"
    PUBLISHED = "published"


class RevisionAuthor(StrEnum):
    """Who produced a revision."""

    AI = "ai"
    HUMAN = "human"


class ContentTone(StrEnum):
    RATIONAL = "rational"
    PERSONAL = "personal"
    NARRATIVE = "narrative"
    CONCISE = "concise"


class ContentLength(StrEnum):
    SHORT = "short"
    MEDIUM = "medium"
    LONG = "long"


class ContentSourceKind(StrEnum):
    """Input selectors a generation request may draw from."""

    BOOK = "book"
    CHAPTER = "chapter"
    NOTE = "note"
    TOPIC = "topic"


class ExportTargetKind(StrEnum):
    """Files the Obsidian exporter owns inside a book folder."""

    BOOK = "book"
    HIGHLIGHTS = "highlights"
    NOTES = "notes"
    SUMMARY = "summary"
    SOCIAL_POSTS = "social_posts"


class ExportOutcome(StrEnum):
    """Result of reconciling one export target against the vault."""

    CREATED = "created"
    UPDATED = "updated"
    UNCHANGED = "unchanged"
    CONFLICT = "conflict"


#: Statuses owned by the P6 publishing track.
PUBLISHING_STATUSES = frozenset({ContentStatus.SCHEDULED, ContentStatus.PUBLISHED})

_ALLOWED_TRANSITIONS: dict[ContentStatus, frozenset[ContentStatus]] = {
    ContentStatus.QUEUED: frozenset({ContentStatus.GENERATING}),
    ContentStatus.GENERATING: frozenset({ContentStatus.DRAFT}),
    # Regeneration re-enters the queue instead of overwriting: the existing
    # revisions stay, and the new attempt appends to them.
    ContentStatus.DRAFT: frozenset(
        {ContentStatus.EDITING, ContentStatus.APPROVED, ContentStatus.QUEUED}
    ),
    ContentStatus.EDITING: frozenset(
        {ContentStatus.DRAFT, ContentStatus.APPROVED, ContentStatus.QUEUED}
    ),
    ContentStatus.APPROVED: frozenset(
        {ContentStatus.EDITING, ContentStatus.QUEUED, ContentStatus.SCHEDULED}
    ),
    ContentStatus.SCHEDULED: frozenset({ContentStatus.PUBLISHED}),
    ContentStatus.PUBLISHED: frozenset(),
}


def _require_bounded_text(value: str, field: str, max_codepoints: int) -> None:
    if not value:
        raise ValueError(f"{field} cannot be empty")
    if len(value) > max_codepoints:
        raise ValueError(f"{field} cannot exceed {max_codepoints} codepoints")
    if "\x00" in value:
        raise ValueError(f"{field} cannot contain NUL")


def ensure_supported_in_p5(status: ContentStatus) -> None:
    """Refuse statuses that belong to the unimplemented publishing track.

    Raises:
        ValueError: when ``status`` is scheduled or published.
    """

    if status in PUBLISHING_STATUSES:
        raise ValueError(f"Content status {status.value} belongs to the P6 publishing track")


@dataclass(frozen=True, slots=True)
class Note:
    """A local knowledge item; never uploaded implicitly."""

    id: str
    book_id: str
    source_kind: NoteSourceKind
    source_id: str | None
    title: str
    body: str
    created_at: datetime
    updated_at: datetime
    version: int

    def __post_init__(self) -> None:
        if not self.id or not self.book_id:
            raise ValueError("Note id and book_id are required")
        if self.version < 0:
            raise ValueError("Note version cannot be negative")
        _require_bounded_text(self.title, "Note title", NOTE_TITLE_MAX_CODEPOINTS)
        _require_bounded_text(self.body, "Note body", NOTE_BODY_MAX_CODEPOINTS)
        if self.source_kind is NoteSourceKind.MANUAL:
            if self.source_id is not None:
                raise ValueError("Manual notes cannot carry a source_id")
        elif not self.source_id:
            raise ValueError(f"{self.source_kind.value} notes require a source_id")


@dataclass(frozen=True, slots=True)
class ContentSource:
    """One selected input for a generation request."""

    kind: ContentSourceKind
    reference: str

    def __post_init__(self) -> None:
        limit = (
            TOPIC_MAX_CODEPOINTS
            if self.kind is ContentSourceKind.TOPIC
            else NOTE_TITLE_MAX_CODEPOINTS
        )
        _require_bounded_text(self.reference, f"{self.kind.value} source reference", limit)


@dataclass(frozen=True, slots=True)
class GenerationRequest:
    """Normalised generation parameters from PRD 6.5."""

    content_type: ContentType
    sources: tuple[ContentSource, ...]
    language: str
    tone: ContentTone
    length: ContentLength
    target_platform: str | None
    require_citations: bool
    first_person: bool

    def __post_init__(self) -> None:
        if not self.sources:
            raise ValueError("A generation request requires at least one source")
        if len(self.sources) > MAX_CONTENT_SOURCES:
            raise ValueError(f"A generation request cannot exceed {MAX_CONTENT_SOURCES} sources")
        _require_bounded_text(self.language, "Generation language", TARGET_PLATFORM_MAX_CODEPOINTS)
        if self.target_platform is not None:
            _require_bounded_text(
                self.target_platform, "Generation target_platform", TARGET_PLATFORM_MAX_CODEPOINTS
            )


@dataclass(frozen=True, slots=True)
class ContentRevision:
    """One immutable draft version with explicit authorship."""

    id: str
    content_id: str
    revision_number: int
    author_kind: RevisionAuthor
    title: str
    body: str
    created_at: datetime

    def __post_init__(self) -> None:
        if not self.id or not self.content_id:
            raise ValueError("ContentRevision id and content_id are required")
        if self.revision_number < 1:
            raise ValueError("ContentRevision numbering starts at 1")
        if self.revision_number == 1 and self.author_kind is not RevisionAuthor.AI:
            raise ValueError("The first revision must record the model as its author")
        _require_bounded_text(self.title, "ContentRevision title", CONTENT_TITLE_MAX_CODEPOINTS)
        _require_bounded_text(self.body, "ContentRevision body", CONTENT_BODY_MAX_CODEPOINTS)


@dataclass(frozen=True, slots=True)
class GeneratedContent:
    """A content asset and its lifecycle position."""

    id: str
    book_id: str
    request: GenerationRequest
    status: ContentStatus
    latest_revision_number: int
    created_at: datetime
    updated_at: datetime
    version: int

    def __post_init__(self) -> None:
        if not self.id or not self.book_id:
            raise ValueError("GeneratedContent id and book_id are required")
        if self.version < 0:
            raise ValueError("GeneratedContent version cannot be negative")
        if self.latest_revision_number < 0:
            raise ValueError("GeneratedContent latest_revision_number cannot be negative")
        if self.status in {ContentStatus.QUEUED, ContentStatus.GENERATING}:
            return
        if self.latest_revision_number < 1:
            raise ValueError(f"{self.status.value} content requires at least one revision")

    def transition(self, to: ContentStatus, *, now: datetime | None = None) -> GeneratedContent:
        """Move to ``to`` when the lifecycle graph allows it.

        Raises:
            InvalidStateTransition: when the edge is not in the frozen graph.
        """

        if to not in _ALLOWED_TRANSITIONS[self.status]:
            raise InvalidStateTransition(
                f"Content cannot move from {self.status.value} to {to.value}"
            )
        moment = now or utc_now()
        return GeneratedContent(
            id=self.id,
            book_id=self.book_id,
            request=self.request,
            status=to,
            latest_revision_number=self.latest_revision_number,
            created_at=self.created_at,
            updated_at=moment,
            version=self.version + 1,
        )
