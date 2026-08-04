"""SQLite persistence for knowledge notes (C1, ADR-0008)."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from datetime import datetime

from diandianreading.application.ports.content import KnowledgeNoteRepository
from diandianreading.domain.content import KnowledgeNote, KnowledgeNoteSource
from diandianreading.infrastructure.persistence.sqlite import SQLiteDatabase


def _row_to_note(row: sqlite3.Row) -> KnowledgeNote:
    return KnowledgeNote(
        id=str(row["id"]),
        book_id=str(row["book_id"]),
        source_kind=KnowledgeNoteSource(str(row["source_kind"])),
        source_id=None if row["source_id"] is None else str(row["source_id"]),
        title=str(row["title"]),
        body=str(row["body"]),
        created_at=datetime.fromisoformat(str(row["created_at"])),
        updated_at=datetime.fromisoformat(str(row["updated_at"])),
        version=int(row["version"]),
    )


class SQLiteKnowledgeNoteRepository(KnowledgeNoteRepository):
    """Persist knowledge notes; source identity is enforced by the database."""

    def __init__(self, target: SQLiteDatabase | sqlite3.Connection) -> None:
        self._target = target

    @contextmanager
    def _connect(self, *, write: bool = False) -> Iterator[sqlite3.Connection]:
        if isinstance(self._target, sqlite3.Connection):
            yield self._target
            return
        with self._target.connect(immediate=write) as connection:
            yield connection

    def add_for_source(self, note: KnowledgeNote) -> KnowledgeNote:
        """Insert the note, or return the row already bound to the same source.

        The read is performed after the failed insert, inside the same immediate
        transaction, so a concurrent writer cannot make two callers each believe
        they created the note.
        """

        with self._connect(write=True) as connection:
            book = connection.execute(
                "SELECT 1 FROM books WHERE id = ?", (note.book_id,)
            ).fetchone()
            if book is None:
                raise KeyError(f"Unknown Book: {note.book_id}")
            try:
                connection.execute(
                    """
                    INSERT INTO notes(
                        id, book_id, source_kind, source_id, title, body,
                        created_at, updated_at, version
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        note.id,
                        note.book_id,
                        note.source_kind.value,
                        note.source_id,
                        note.title,
                        note.body,
                        note.created_at.isoformat(),
                        note.updated_at.isoformat(),
                        note.version,
                    ),
                )
            except sqlite3.IntegrityError:
                if note.source_id is None:
                    raise
                existing = connection.execute(
                    "SELECT * FROM notes WHERE source_kind = ? AND source_id = ?",
                    (note.source_kind.value, note.source_id),
                ).fetchone()
                if existing is None:
                    raise
                return _row_to_note(existing)
            return note

    def get(self, note_id: str) -> KnowledgeNote | None:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
        return None if row is None else _row_to_note(row)

    def find_by_source(
        self, source_kind: KnowledgeNoteSource, source_id: str
    ) -> KnowledgeNote | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM notes WHERE source_kind = ? AND source_id = ?",
                (source_kind.value, source_id),
            ).fetchone()
        return None if row is None else _row_to_note(row)

    def list_for_book(
        self,
        book_id: str,
        *,
        limit: int,
        before_created_at: datetime | None = None,
        before_id: str | None = None,
    ) -> Sequence[KnowledgeNote]:
        if limit <= 0:
            raise ValueError("limit must be positive")
        # (created_at, id) keyset paging keeps the order total even when two
        # notes are saved inside the same clock tick.
        clauses = ["book_id = ?"]
        parameters: list[object] = [book_id]
        if before_created_at is not None and before_id is not None:
            clauses.append("(created_at < ? OR (created_at = ? AND id < ?))")
            moment = before_created_at.isoformat()
            parameters.extend([moment, moment, before_id])
        query = (
            f"SELECT * FROM notes WHERE {' AND '.join(clauses)} "
            "ORDER BY created_at DESC, id DESC LIMIT ?"
        )
        parameters.append(limit)
        with self._connect() as connection:
            rows = connection.execute(query, tuple(parameters)).fetchall()
        return tuple(_row_to_note(row) for row in rows)

    def count_for_book(self, book_id: str) -> int:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT count(*) FROM notes WHERE book_id = ?", (book_id,)
            ).fetchone()
        return int(row[0])
