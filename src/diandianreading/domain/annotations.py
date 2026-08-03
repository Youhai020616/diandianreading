"""Reader annotation and reading-progress domain models.

The anchor contract here is the single locator shared by annotations, reading
progress, and chat references (ADR-0007). Anchors bind to derived-document
content hashes, never to ``DocumentPart`` boundaries, because part chunking
follows provider capacity limits and is not a stable coordinate system.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from enum import StrEnum
from types import EllipsisType

from diandianreading.domain.chat import ChatReferenceLocationType
from diandianreading.domain.errors import InvalidStateTransition
from diandianreading.domain.models import utc_now

SELECTED_TEXT_MAX_CODEPOINTS = 2_000
NOTE_BODY_MAX_CODEPOINTS = 10_000
QUOTE_CONTEXT_MAX_CODEPOINTS = 64

_SHA256_HEX_LENGTH = 64
_SHA256_ALPHABET = frozenset("0123456789abcdef")


class AnnotationKind(StrEnum):
    HIGHLIGHT = "highlight"
    NOTE = "note"


class AnnotationStatus(StrEnum):
    ACTIVE = "active"
    ORPHANED = "orphaned"
    DELETED = "deleted"


class AnnotationColor(StrEnum):
    YELLOW = "yellow"
    GREEN = "green"
    BLUE = "blue"
    PINK = "pink"
    PURPLE = "purple"


def _require_bounded_text(value: str, field: str, max_codepoints: int) -> None:
    if not value:
        raise ValueError(f"{field} cannot be empty")
    if len(value) > max_codepoints:
        raise ValueError(f"{field} cannot exceed {max_codepoints} codepoints")
    if "\x00" in value:
        raise ValueError(f"{field} cannot contain NUL")


def _require_sha256(value: str, field: str) -> None:
    if len(value) != _SHA256_HEX_LENGTH or not set(value) <= _SHA256_ALPHABET:
        raise ValueError(f"{field} must be a lowercase sha256 hex digest")


@dataclass(frozen=True, slots=True)
class TextQuote:
    """Re-anchoring fingerprint: exact selected text plus bounded context."""

    exact: str
    prefix: str = ""
    suffix: str = ""

    def __post_init__(self) -> None:
        _require_bounded_text(self.exact, "TextQuote exact", SELECTED_TEXT_MAX_CODEPOINTS)
        for field, value in (("prefix", self.prefix), ("suffix", self.suffix)):
            if len(value) > QUOTE_CONTEXT_MAX_CODEPOINTS:
                raise ValueError(
                    f"TextQuote {field} cannot exceed {QUOTE_CONTEXT_MAX_CODEPOINTS} codepoints"
                )
            if "\x00" in value:
                raise ValueError(f"TextQuote {field} cannot contain NUL")


@dataclass(frozen=True, slots=True)
class ContentAnchor:
    """Position inside an anchored document identified by its content hash.

    ``markdown_offset`` anchors address the normalized derived markdown as a
    ``[start, end)`` codepoint interval; ``end == start`` is a caret position.
    ``pdf_page`` anchors address a 1-based page via ``start`` with ``end`` unset.
    ``epub_cfi`` is a reserved location type with no v1 producer and is
    rejected here so it cannot be fabricated (ADR-0007).
    """

    type: ChatReferenceLocationType
    anchor_sha256: str
    start: int | None = None
    end: int | None = None
    chapter_ref: str | None = None
    quote: TextQuote | None = None

    def __post_init__(self) -> None:
        _require_sha256(self.anchor_sha256, "ContentAnchor anchor_sha256")
        if self.chapter_ref is not None and not self.chapter_ref.strip():
            raise ValueError("ContentAnchor chapter_ref cannot be blank")
        if self.type is ChatReferenceLocationType.MARKDOWN_OFFSET:
            if self.start is None or self.end is None:
                raise ValueError("markdown_offset anchors require start and end")
            if self.start < 0 or self.end < self.start:
                raise ValueError("markdown_offset anchors require 0 <= start <= end")
        elif self.type is ChatReferenceLocationType.PDF_PAGE:
            if self.start is None or self.start < 1:
                raise ValueError("pdf_page anchors require a 1-based page in start")
            if self.end is not None:
                raise ValueError("pdf_page anchors must leave end unset")
        else:
            raise ValueError("epub_cfi anchors are reserved and have no v1 producer")

    @property
    def is_range(self) -> bool:
        return (
            self.type is ChatReferenceLocationType.MARKDOWN_OFFSET
            and self.start is not None
            and self.end is not None
            and self.end > self.start
        )


@dataclass(frozen=True, slots=True)
class Annotation:
    """A user highlight or note; local-first, never uploaded implicitly."""

    id: str
    book_id: str
    kind: AnnotationKind
    status: AnnotationStatus
    anchor: ContentAnchor | None
    selected_text: str | None
    body: str | None
    color: AnnotationColor | None
    created_at: datetime
    updated_at: datetime
    version: int

    def __post_init__(self) -> None:
        if not self.id or not self.book_id:
            raise ValueError("Annotation id and book_id are required")
        if self.version < 0:
            raise ValueError("Annotation version cannot be negative")
        if self.selected_text is not None:
            _require_bounded_text(
                self.selected_text, "Annotation selected_text", SELECTED_TEXT_MAX_CODEPOINTS
            )
        if self.body is not None:
            _require_bounded_text(self.body, "Annotation body", NOTE_BODY_MAX_CODEPOINTS)
        if self.kind is AnnotationKind.HIGHLIGHT:
            if self.anchor is None or self.anchor.quote is None:
                raise ValueError("Highlights require an anchor with a re-anchoring quote")
            if not self.anchor.is_range:
                raise ValueError("Highlights require a non-empty anchored range")
            if self.selected_text is None:
                raise ValueError("Highlights require selected_text")
            if self.anchor.quote.exact != self.selected_text:
                raise ValueError("Highlight quote must match selected_text exactly")
            if self.color is None:
                raise ValueError("Highlights require a color")
        else:
            if self.body is None:
                raise ValueError("Notes require a body")
            if self.selected_text is not None:
                raise ValueError("Notes cannot carry selected_text; quotes belong to highlights")
        if self.status is AnnotationStatus.ORPHANED and self.anchor is None:
            raise ValueError("Only anchored annotations can be orphaned")

    def mark_orphaned(self, *, now: datetime | None = None) -> Annotation:
        if self.status is not AnnotationStatus.ACTIVE:
            raise InvalidStateTransition(
                f"Annotation {self.id} cannot orphan from {self.status.value}"
            )
        if self.anchor is None:
            raise InvalidStateTransition(f"Annotation {self.id} has no anchor to orphan")
        return self._advance(status=AnnotationStatus.ORPHANED, now=now)

    def reanchor(self, anchor: ContentAnchor, *, now: datetime | None = None) -> Annotation:
        if self.status is AnnotationStatus.DELETED:
            raise InvalidStateTransition(f"Annotation {self.id} cannot reanchor once deleted")
        return self._advance(status=AnnotationStatus.ACTIVE, anchor=anchor, now=now)

    def soft_delete(self, *, now: datetime | None = None) -> Annotation:
        if self.status is AnnotationStatus.DELETED:
            raise InvalidStateTransition(f"Annotation {self.id} is already deleted")
        return self._advance(status=AnnotationStatus.DELETED, now=now)

    def restore(self, *, now: datetime | None = None) -> Annotation:
        if self.status is not AnnotationStatus.DELETED:
            raise InvalidStateTransition(f"Annotation {self.id} is not deleted")
        return self._advance(status=AnnotationStatus.ACTIVE, now=now)

    def edit_body(self, body: str | None, *, now: datetime | None = None) -> Annotation:
        if self.status is AnnotationStatus.DELETED:
            raise InvalidStateTransition(f"Annotation {self.id} cannot be edited once deleted")
        return self._advance(body=body, now=now)

    def change_color(self, color: AnnotationColor, *, now: datetime | None = None) -> Annotation:
        if self.kind is not AnnotationKind.HIGHLIGHT:
            raise InvalidStateTransition("Only highlights carry a color")
        if self.status is AnnotationStatus.DELETED:
            raise InvalidStateTransition(f"Annotation {self.id} cannot be edited once deleted")
        return self._advance(color=color, now=now)

    def _advance(
        self,
        *,
        now: datetime | None,
        status: AnnotationStatus | None = None,
        anchor: ContentAnchor | None = None,
        body: str | None | EllipsisType = ...,
        color: AnnotationColor | None = None,
    ) -> Annotation:
        timestamp = now or utc_now()
        return replace(
            self,
            status=status if status is not None else self.status,
            anchor=anchor if anchor is not None else self.anchor,
            body=self.body if body is ... else body,
            color=color if color is not None else self.color,
            updated_at=timestamp,
            version=self.version + 1,
        )


@dataclass(frozen=True, slots=True)
class ReadingProgress:
    """Last reading position per book; last-write-wins with optimistic version."""

    book_id: str
    anchor: ContentAnchor
    percent: float
    updated_at: datetime
    version: int

    def __post_init__(self) -> None:
        if not self.book_id:
            raise ValueError("ReadingProgress book_id is required")
        if not 0.0 <= self.percent <= 1.0:
            raise ValueError("ReadingProgress percent must be within [0, 1]")
        if self.version < 0:
            raise ValueError("ReadingProgress version cannot be negative")

    def advance(
        self,
        anchor: ContentAnchor,
        percent: float,
        *,
        now: datetime | None = None,
    ) -> ReadingProgress:
        return replace(
            self,
            anchor=anchor,
            percent=percent,
            updated_at=now or utc_now(),
            version=self.version + 1,
        )
