"""Persistence Ports for knowledge notes and content assets.

Frozen in C0 (ADR-0008). ``KnowledgeNote`` is deliberately *not* the annotation
note from ADR-0007: ``query_scope.note_ids`` in ai-chat.md refers to annotation
identifiers, while these rows are standalone knowledge items.

The idempotency contract is unusual and intentional: ``add_for_source`` returns
the existing row instead of raising when one already exists for the same
``(source_kind, source_id)``. ai-chat.md requires that repeating
``save-as-note`` for one message yields the same note, and the database unique
index is what guarantees it rather than a read-then-write check that could race.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import Protocol

from diandianreading.domain.content import KnowledgeNote, KnowledgeNoteSource


class KnowledgeNoteRepository(Protocol):
    def add_for_source(self, note: KnowledgeNote) -> KnowledgeNote:
        """Insert ``note``, or return the row already bound to its source.

        Manual notes have no source identity and are always inserted.
        """
        ...

    def get(self, note_id: str) -> KnowledgeNote | None: ...

    def find_by_source(
        self, source_kind: KnowledgeNoteSource, source_id: str
    ) -> KnowledgeNote | None: ...

    def list_for_book(
        self,
        book_id: str,
        *,
        limit: int,
        before_created_at: datetime | None = None,
        before_id: str | None = None,
    ) -> Sequence[KnowledgeNote]: ...

    def count_for_book(self, book_id: str) -> int: ...
