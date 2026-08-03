"""Application service for creating, listing, and editing reader annotations.

Highlights must anchor to the current reading document; the service verifies
the anchor's document hash, location type, and — for markdown documents —
that the claimed selection equals the anchored text slice, so a stale or
fabricated anchor can never be stored as a valid highlight (ADR-0007).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import final
from uuid import uuid4

from diandianreading.application.ports.annotations import AnnotationRepository
from diandianreading.application.use_cases.reading import (
    ReadingService,
    StaleAnchorError,
)
from diandianreading.domain import (
    DiandianError,
    ErrorCode,
    InvalidStateTransition,
    utc_now,
)
from diandianreading.domain.annotations import (
    Annotation,
    AnnotationColor,
    AnnotationKind,
    AnnotationStatus,
    ContentAnchor,
)
from diandianreading.domain.chat import ChatReferenceLocationType

_MARKDOWN_MIME = "text/markdown"
_PDF_MIME = "application/pdf"
_MAX_ANNOTATION_PAGE = 100
_DEFAULT_LIST_STATUSES = (AnnotationStatus.ACTIVE, AnnotationStatus.ORPHANED)


class AnnotationNotFoundError(DiandianError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.VALIDATION, "Annotation was not found", retryable=False)


@dataclass(frozen=True, slots=True)
class AnnotationCursor:
    created_at: datetime
    id: str

    def __post_init__(self) -> None:
        if not self.id.strip():
            raise ValueError("Annotation cursor ID cannot be empty")


@dataclass(frozen=True, slots=True)
class AnnotationPage:
    items: tuple[Annotation, ...]
    next_cursor: AnnotationCursor | None


@final
class AnnotationService:
    def __init__(
        self,
        *,
        repository: AnnotationRepository,
        reading: ReadingService,
    ) -> None:
        self._repository = repository
        self._reading = reading

    def create_highlight(
        self,
        book_id: str,
        *,
        anchor: ContentAnchor,
        selected_text: str,
        body: str | None,
        color: AnnotationColor,
    ) -> Annotation:
        content = self._reading.get_content(book_id)
        document = content.document
        expected_type = (
            ChatReferenceLocationType.PDF_PAGE
            if document.mime_type == _PDF_MIME
            else ChatReferenceLocationType.MARKDOWN_OFFSET
        )
        if anchor.type is not expected_type:
            raise StaleAnchorError()
        if anchor.anchor_sha256 != document.anchor_sha256:
            raise StaleAnchorError()
        if document.mime_type == _MARKDOWN_MIME:
            text = content.payload.decode("utf-8")
            if (
                anchor.start is None
                or anchor.end is None
                or text[anchor.start : anchor.end] != selected_text
            ):
                raise StaleAnchorError()
        now = utc_now()
        annotation = Annotation(
            id=str(uuid4()),
            book_id=book_id,
            kind=AnnotationKind.HIGHLIGHT,
            status=AnnotationStatus.ACTIVE,
            anchor=anchor,
            selected_text=selected_text,
            body=body,
            color=color,
            created_at=now,
            updated_at=now,
            version=0,
        )
        self._repository.add(annotation)
        return annotation

    def create_note(
        self,
        book_id: str,
        *,
        body: str,
        anchor: ContentAnchor | None,
    ) -> Annotation:
        document = self._reading.get_content(book_id).document
        if anchor is not None:
            expected_type = (
                ChatReferenceLocationType.PDF_PAGE
                if document.mime_type == _PDF_MIME
                else ChatReferenceLocationType.MARKDOWN_OFFSET
            )
            if anchor.type is not expected_type or anchor.anchor_sha256 != document.anchor_sha256:
                raise StaleAnchorError()
        now = utc_now()
        annotation = Annotation(
            id=str(uuid4()),
            book_id=book_id,
            kind=AnnotationKind.NOTE,
            status=AnnotationStatus.ACTIVE,
            anchor=anchor,
            selected_text=None,
            body=body,
            color=None,
            created_at=now,
            updated_at=now,
            version=0,
        )
        self._repository.add(annotation)
        return annotation

    def list_for_book(
        self,
        book_id: str,
        *,
        statuses: tuple[AnnotationStatus, ...] = _DEFAULT_LIST_STATUSES,
        limit: int = 50,
        before: AnnotationCursor | None = None,
    ) -> AnnotationPage:
        if limit < 1 or limit > _MAX_ANNOTATION_PAGE:
            raise ValueError(f"Annotation page limit must be between 1 and {_MAX_ANNOTATION_PAGE}")
        _ = self._reading.get_document(book_id)
        items = tuple(
            self._repository.list_for_book(
                book_id,
                statuses=statuses,
                limit=limit,
                before_created_at=before.created_at if before else None,
                before_id=before.id if before else None,
            )
        )
        next_cursor: AnnotationCursor | None = None
        if len(items) == limit:
            last = items[-1]
            following = self._repository.list_for_book(
                book_id,
                statuses=statuses,
                limit=1,
                before_created_at=last.created_at,
                before_id=last.id,
            )
            if following:
                next_cursor = AnnotationCursor(last.created_at, last.id)
        return AnnotationPage(items=items, next_cursor=next_cursor)

    def edit(
        self,
        annotation_id: str,
        *,
        body_change: tuple[str | None] | None = None,
        color: AnnotationColor | None = None,
    ) -> Annotation:
        current = self._require(annotation_id)
        if body_change is not None:
            updated = self._transition(lambda: current.edit_body(body_change[0]))
            self._repository.save(current, updated)
            current = updated
        if color is not None:
            selected_color = color
            updated = self._transition(lambda: current.change_color(selected_color))
            self._repository.save(current, updated)
            current = updated
        return current

    def soft_delete(self, annotation_id: str) -> Annotation:
        current = self._require(annotation_id)
        deleted = self._transition(current.soft_delete)
        self._repository.save(current, deleted)
        return deleted

    def restore(self, annotation_id: str) -> Annotation:
        current = self._require(annotation_id)
        restored = self._transition(current.restore)
        self._repository.save(current, restored)
        return restored

    @staticmethod
    def _transition(apply: Callable[[], Annotation]) -> Annotation:
        try:
            return apply()
        except InvalidStateTransition as error:
            raise DiandianError(
                ErrorCode.REPOSITORY_CONFLICT,
                "Annotation state does not allow this operation",
                retryable=False,
            ) from error

    def _require(self, annotation_id: str) -> Annotation:
        if not annotation_id.strip():
            raise AnnotationNotFoundError()
        annotation = self._repository.get(annotation_id)
        if annotation is None:
            raise AnnotationNotFoundError()
        return annotation
