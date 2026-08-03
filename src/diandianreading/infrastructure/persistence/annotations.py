"""SQLite persistence adapter for reader annotations (ADR-0007).

Implements the W0-frozen ``AnnotationRepository`` port on the ``annotations``
table from migration ``0007``. Mutations follow the repository-wide optimistic
pattern: ``save(previous, current)`` succeeds only when the stored row still
matches ``previous.version`` and rejects stale writers with
``RepositoryConflict``. Annotation content is high-sensitivity personal data
and must never leak into logs or diagnostics; error messages therefore carry
identifiers only.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from datetime import datetime

from diandianreading.application.ports.annotations import AnnotationRepository
from diandianreading.domain.annotations import (
    Annotation,
    AnnotationColor,
    AnnotationKind,
    AnnotationStatus,
    ContentAnchor,
    TextQuote,
)
from diandianreading.domain.chat import ChatReferenceLocationType
from diandianreading.domain.errors import RepositoryConflict
from diandianreading.infrastructure.persistence.sqlite import SQLiteDatabase

_MAX_LIST_PAGE = 100


class SQLiteAnnotationRepository(AnnotationRepository):
    """Persist Annotation aggregates with optimistic, version-fenced saves."""

    def __init__(self, target: SQLiteDatabase | sqlite3.Connection) -> None:
        self._target = target

    @contextmanager
    def _connect(self, *, write: bool = False) -> Iterator[sqlite3.Connection]:
        if isinstance(self._target, sqlite3.Connection):
            yield self._target
            return
        with self._target.connect(immediate=write) as connection:
            yield connection

    def add(self, annotation: Annotation) -> None:
        with self._connect(write=True) as connection:
            book = connection.execute(
                "SELECT 1 FROM books WHERE id = ?",
                (annotation.book_id,),
            ).fetchone()
            if book is None:
                raise KeyError(f"Unknown Book: {annotation.book_id}")
            try:
                connection.execute(
                    """
                    INSERT INTO annotations(
                        id, book_id, kind, created_at,
                        status, anchor_type, anchor_sha256, anchor_start, anchor_end,
                        chapter_ref, quote_exact, quote_prefix, quote_suffix,
                        selected_text, body, color, updated_at, version
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    _annotation_values(annotation),
                )
            except sqlite3.IntegrityError as error:
                raise RepositoryConflict(
                    f"Annotation identity already exists: {annotation.id}"
                ) from error

    def save(self, previous: Annotation, current: Annotation) -> None:
        if (
            previous.id != current.id
            or previous.book_id != current.book_id
            or previous.kind is not current.kind
            or previous.created_at != current.created_at
            or current.version != previous.version + 1
        ):
            raise RepositoryConflict(
                "Annotation transition must increment one matching aggregate version"
            )
        with self._connect(write=True) as connection:
            try:
                cursor = connection.execute(
                    """
                    UPDATE annotations
                    SET status = ?, anchor_type = ?, anchor_sha256 = ?,
                        anchor_start = ?, anchor_end = ?, chapter_ref = ?,
                        quote_exact = ?, quote_prefix = ?, quote_suffix = ?,
                        selected_text = ?, body = ?, color = ?, updated_at = ?,
                        version = ?
                    WHERE id = ? AND book_id = ? AND kind = ? AND version = ?
                    """,
                    (
                        *_mutable_values(current),
                        current.id,
                        current.book_id,
                        current.kind.value,
                        previous.version,
                    ),
                )
            except sqlite3.IntegrityError as error:
                raise RepositoryConflict(
                    "Annotation transition violated a durable state constraint"
                ) from error
            if cursor.rowcount != 1:
                raise RepositoryConflict(
                    f"Annotation {current.id} was changed or removed at version {previous.version}"
                )

    def get(self, annotation_id: str) -> Annotation | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM annotations WHERE id = ?",
                (annotation_id,),
            ).fetchone()
        return _annotation_from_row(row) if row is not None else None

    def list_for_book(
        self,
        book_id: str,
        *,
        statuses: Sequence[AnnotationStatus] | None = None,
        limit: int,
        before_created_at: datetime | None = None,
        before_id: str | None = None,
    ) -> Sequence[Annotation]:
        if limit < 1 or limit > _MAX_LIST_PAGE:
            raise ValueError(f"Annotation page limit must be between 1 and {_MAX_LIST_PAGE}")
        if (before_created_at is None) != (before_id is None):
            raise ValueError("Annotation cursor requires both before_created_at and before_id")
        status_clause, status_parameters = _status_filter(statuses)
        parameters: list[object] = [book_id, *status_parameters]
        cursor_clause = ""
        if before_created_at is not None and before_id is not None:
            cursor_timestamp = before_created_at.isoformat()
            cursor_clause = """
                AND (
                    created_at < ?
                    OR (created_at = ? AND id < ?)
                )
            """
            parameters.extend((cursor_timestamp, cursor_timestamp, before_id))
        parameters.append(limit)
        with self._connect() as connection:
            rows = connection.execute(
                f"""
                SELECT * FROM annotations
                WHERE book_id = ?{status_clause}
                {cursor_clause}
                ORDER BY created_at DESC, id DESC
                LIMIT ?
                """,
                tuple(parameters),
            ).fetchall()
        return tuple(_annotation_from_row(row) for row in rows)

    def list_for_anchor_document(
        self,
        anchor_sha256: str,
        *,
        statuses: Sequence[AnnotationStatus] | None = None,
    ) -> Sequence[Annotation]:
        status_clause, status_parameters = _status_filter(statuses)
        with self._connect() as connection:
            rows = connection.execute(
                f"""
                SELECT * FROM annotations
                WHERE anchor_sha256 = ?{status_clause}
                ORDER BY created_at, id
                """,
                (anchor_sha256, *status_parameters),
            ).fetchall()
        return tuple(_annotation_from_row(row) for row in rows)

    def count_for_book(self, book_id: str) -> int:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT COUNT(*) AS total FROM annotations WHERE book_id = ?",
                (book_id,),
            ).fetchone()
        return int(row["total"])


def _status_filter(
    statuses: Sequence[AnnotationStatus] | None,
) -> tuple[str, list[object]]:
    if statuses is None:
        return "", []
    if not statuses:
        raise ValueError("Annotation status filter cannot be empty")
    placeholders = ", ".join("?" for _ in statuses)
    return f" AND status IN ({placeholders})", [status.value for status in statuses]


def _annotation_values(annotation: Annotation) -> tuple[object, ...]:
    return (
        annotation.id,
        annotation.book_id,
        annotation.kind.value,
        annotation.created_at.isoformat(),
        *_mutable_values(annotation),
    )


def _mutable_values(annotation: Annotation) -> tuple[object, ...]:
    anchor = annotation.anchor
    quote = anchor.quote if anchor is not None else None
    return (
        annotation.status.value,
        anchor.type.value if anchor is not None else None,
        anchor.anchor_sha256 if anchor is not None else None,
        anchor.start if anchor is not None else None,
        anchor.end if anchor is not None else None,
        anchor.chapter_ref if anchor is not None else None,
        quote.exact if quote is not None else None,
        quote.prefix if quote is not None else None,
        quote.suffix if quote is not None else None,
        annotation.selected_text,
        annotation.body,
        annotation.color.value if annotation.color is not None else None,
        annotation.updated_at.isoformat(),
        annotation.version,
    )


def _annotation_from_row(row: sqlite3.Row) -> Annotation:
    return Annotation(
        id=str(row["id"]),
        book_id=str(row["book_id"]),
        kind=AnnotationKind(str(row["kind"])),
        status=AnnotationStatus(str(row["status"])),
        anchor=_anchor_from_row(row),
        selected_text=str(row["selected_text"]) if row["selected_text"] is not None else None,
        body=str(row["body"]) if row["body"] is not None else None,
        color=AnnotationColor(str(row["color"])) if row["color"] is not None else None,
        created_at=_datetime(row["created_at"]),
        updated_at=_datetime(row["updated_at"]),
        version=int(row["version"]),
    )


def _anchor_from_row(row: sqlite3.Row) -> ContentAnchor | None:
    anchor_type = row["anchor_type"]
    if anchor_type is None:
        return None
    quote: TextQuote | None = None
    if row["quote_exact"] is not None:
        if row["quote_prefix"] is None or row["quote_suffix"] is None:
            raise ValueError("Annotation quote columns are inconsistent")
        quote = TextQuote(
            exact=str(row["quote_exact"]),
            prefix=str(row["quote_prefix"]),
            suffix=str(row["quote_suffix"]),
        )
    return ContentAnchor(
        type=ChatReferenceLocationType(str(anchor_type)),
        anchor_sha256=str(row["anchor_sha256"]),
        start=int(row["anchor_start"]) if row["anchor_start"] is not None else None,
        end=int(row["anchor_end"]) if row["anchor_end"] is not None else None,
        chapter_ref=str(row["chapter_ref"]) if row["chapter_ref"] is not None else None,
        quote=quote,
    )


def _datetime(value: object) -> datetime:
    return datetime.fromisoformat(str(value))
