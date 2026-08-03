"""SQLite persistence for per-book reading progress."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime

from diandianreading.domain import RepositoryConflict
from diandianreading.domain.annotations import ContentAnchor, ReadingProgress, TextQuote
from diandianreading.domain.chat import ChatReferenceLocationType
from diandianreading.infrastructure.persistence.sqlite import SQLiteDatabase


class SQLiteReadingProgressRepository:
    """Persist one reading position per book (ReadingProgressRepository Port)."""

    def __init__(self, target: SQLiteDatabase | sqlite3.Connection) -> None:
        self._target = target

    @contextmanager
    def _connect(self, *, write: bool = False) -> Iterator[sqlite3.Connection]:
        if isinstance(self._target, sqlite3.Connection):
            yield self._target
            return
        with self._target.connect(immediate=write) as connection:
            yield connection

    def get(self, book_id: str) -> ReadingProgress | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM reading_progress WHERE book_id = ?",
                (book_id,),
            ).fetchone()
        return _progress_from_row(row) if row is not None else None

    def save(self, previous: ReadingProgress | None, current: ReadingProgress) -> None:
        anchor = current.anchor
        with self._connect(write=True) as connection:
            if previous is None:
                try:
                    connection.execute(
                        """
                        INSERT INTO reading_progress (
                            book_id, anchor_type, anchor_sha256, anchor_start,
                            anchor_end, chapter_ref, percent, updated_at, version
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            current.book_id,
                            anchor.type.value,
                            anchor.anchor_sha256,
                            anchor.start,
                            anchor.end,
                            anchor.chapter_ref,
                            current.percent,
                            current.updated_at.isoformat(),
                            current.version,
                        ),
                    )
                except sqlite3.IntegrityError as error:
                    raise RepositoryConflict(
                        "Reading progress already exists for this book"
                    ) from error
                return
            cursor = connection.execute(
                """
                UPDATE reading_progress
                SET anchor_type = ?, anchor_sha256 = ?, anchor_start = ?,
                    anchor_end = ?, chapter_ref = ?, percent = ?,
                    updated_at = ?, version = ?
                WHERE book_id = ? AND version = ?
                """,
                (
                    anchor.type.value,
                    anchor.anchor_sha256,
                    anchor.start,
                    anchor.end,
                    anchor.chapter_ref,
                    current.percent,
                    current.updated_at.isoformat(),
                    current.version,
                    current.book_id,
                    previous.version,
                ),
            )
            if cursor.rowcount != 1:
                raise RepositoryConflict("Reading progress was modified concurrently")


def _progress_from_row(row: sqlite3.Row) -> ReadingProgress:
    quote: TextQuote | None = None
    anchor = ContentAnchor(
        type=ChatReferenceLocationType(row["anchor_type"]),
        anchor_sha256=row["anchor_sha256"],
        start=row["anchor_start"],
        end=row["anchor_end"],
        chapter_ref=row["chapter_ref"],
        quote=quote,
    )
    return ReadingProgress(
        book_id=row["book_id"],
        anchor=anchor,
        percent=row["percent"],
        updated_at=datetime.fromisoformat(row["updated_at"]),
        version=row["version"],
    )
