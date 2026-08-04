"""Knowledge note use cases (C1, ADR-0008).

``save-as-note`` is the first step of the P5 loop: it turns a chat answer into a
knowledge item the user owns and can edit. ai-chat.md requires the operation to
be idempotent on the message identifier, and that guarantee is delegated to the
database unique index rather than to a read-then-write check here, so two
concurrent requests cannot both believe they created the note.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime

from diandianreading.application.ports.content import KnowledgeNoteRepository
from diandianreading.domain.content import (
    KNOWLEDGE_NOTE_BODY_MAX_CODEPOINTS,
    KNOWLEDGE_NOTE_TITLE_MAX_CODEPOINTS,
    KnowledgeNote,
    KnowledgeNoteSource,
)
from diandianreading.domain.errors import DiandianError, ErrorCode
from diandianreading.domain.models import utc_now

#: Title derived from an answer when the user supplies none.
DEFAULT_NOTE_TITLE = "未命名笔记"

_WHITESPACE = re.compile(r"\s+")


class NoteSourceNotFoundError(DiandianError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.VALIDATION, "The note source was not found", retryable=False)


class EmptyNoteBodyError(DiandianError):
    def __init__(self) -> None:
        super().__init__(
            ErrorCode.VALIDATION, "A note cannot be saved from empty content", retryable=False
        )


@dataclass(frozen=True, slots=True)
class SavedNote:
    """A saved note plus whether this call is the one that created it."""

    note: KnowledgeNote
    created: bool


def derive_title(body: str) -> str:
    """Build a bounded single-line title from the first line of an answer.

    Provider text is untrusted: it may be a single very long paragraph, may open
    with blank lines, and may contain control characters. The title is therefore
    derived rather than copied.
    """

    for line in body.splitlines():
        collapsed = _WHITESPACE.sub(" ", line).strip().lstrip("#").strip()
        if collapsed:
            return collapsed[:KNOWLEDGE_NOTE_TITLE_MAX_CODEPOINTS]
    return DEFAULT_NOTE_TITLE


class KnowledgeNoteService:
    def __init__(self, notes: KnowledgeNoteRepository) -> None:
        self._notes = notes

    def save_from_source(
        self,
        *,
        note_id: str,
        book_id: str,
        source_kind: KnowledgeNoteSource,
        source_id: str | None,
        body: str | None,
        title: str | None = None,
        now: datetime | None = None,
    ) -> SavedNote:
        """Persist a note derived from a chat message, annotation, or the user.

        Raises:
            EmptyNoteBodyError: when the source carries no usable text.
        """

        if body is None or not body.strip():
            raise EmptyNoteBodyError()
        moment = now or utc_now()
        normalized_body = body.strip()[:KNOWLEDGE_NOTE_BODY_MAX_CODEPOINTS]
        normalized_title = (title or "").strip() or derive_title(normalized_body)
        candidate = KnowledgeNote(
            id=note_id,
            book_id=book_id,
            source_kind=source_kind,
            source_id=source_id,
            title=normalized_title[:KNOWLEDGE_NOTE_TITLE_MAX_CODEPOINTS],
            body=normalized_body,
            created_at=moment,
            updated_at=moment,
            version=0,
        )
        stored = self._notes.add_for_source(candidate)
        return SavedNote(note=stored, created=stored.id == candidate.id)

    def get(self, note_id: str) -> KnowledgeNote | None:
        return self._notes.get(note_id)

    def list_for_book(
        self,
        book_id: str,
        *,
        limit: int,
        before_created_at: datetime | None = None,
        before_id: str | None = None,
    ) -> tuple[KnowledgeNote, ...]:
        return tuple(
            self._notes.list_for_book(
                book_id,
                limit=limit,
                before_created_at=before_created_at,
                before_id=before_id,
            )
        )

    def count_for_book(self, book_id: str) -> int:
        return self._notes.count_for_book(book_id)
