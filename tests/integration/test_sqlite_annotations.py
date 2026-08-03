from __future__ import annotations

import sqlite3
from collections.abc import Callable
from dataclasses import replace
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from diandianreading.domain import Book, BookStatus, RepositoryConflict
from diandianreading.domain.annotations import (
    Annotation,
    AnnotationColor,
    AnnotationKind,
    AnnotationStatus,
    ContentAnchor,
    TextQuote,
)
from diandianreading.domain.chat import ChatReferenceLocationType
from diandianreading.infrastructure.persistence.annotations import SQLiteAnnotationRepository
from diandianreading.infrastructure.persistence.sqlite import (
    SQLiteCatalogRepository,
    SQLiteDatabase,
)
from tests.support import FIXED_NOW

DOC_SHA = "deadbeef" * 8
NEW_SHA = "cafef00d" * 8
OTHER_SHA = "0badc0de" * 8


def make_repository(tmp_path: Path) -> tuple[SQLiteDatabase, SQLiteAnnotationRepository]:
    database = SQLiteDatabase(tmp_path / "state" / "app.sqlite3")
    database.migrate()
    catalog = SQLiteCatalogRepository(database)
    catalog.add_book(make_book("book-1"))
    catalog.add_book(make_book("book-2"))
    return database, SQLiteAnnotationRepository(database)


def make_book(book_id: str) -> Book:
    return Book(
        id=book_id,
        title=f"Book {book_id}",
        author=None,
        source_hash=f"source-{book_id}",
        status=BookStatus.READY,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
    )


def make_quote(exact: str = "selected passage") -> TextQuote:
    return TextQuote(exact=exact, prefix="before ", suffix=" after")


def make_markdown_anchor(
    *,
    sha256: str = DOC_SHA,
    start: int = 10,
    exact: str = "selected passage",
) -> ContentAnchor:
    return ContentAnchor(
        type=ChatReferenceLocationType.MARKDOWN_OFFSET,
        anchor_sha256=sha256,
        start=start,
        end=start + len(exact),
        chapter_ref="markdown-heading-0001",
        quote=make_quote(exact),
    )


def make_pdf_anchor(*, sha256: str = DOC_SHA, page: int = 3) -> ContentAnchor:
    return ContentAnchor(
        type=ChatReferenceLocationType.PDF_PAGE,
        anchor_sha256=sha256,
        start=page,
    )


def make_highlight(
    annotation_id: str = "ann-1",
    *,
    book_id: str = "book-1",
    status: AnnotationStatus = AnnotationStatus.ACTIVE,
    created_at: datetime = FIXED_NOW,
    color: AnnotationColor | None = AnnotationColor.YELLOW,
    exact: str = "selected passage",
    sha256: str = DOC_SHA,
) -> Annotation:
    return Annotation(
        id=annotation_id,
        book_id=book_id,
        kind=AnnotationKind.HIGHLIGHT,
        status=status,
        anchor=make_markdown_anchor(sha256=sha256, exact=exact),
        selected_text=exact,
        body=None,
        color=color,
        created_at=created_at,
        updated_at=created_at,
        version=0,
    )


def make_note(
    annotation_id: str = "note-1",
    *,
    book_id: str = "book-1",
    status: AnnotationStatus = AnnotationStatus.ACTIVE,
    anchor: ContentAnchor | None = None,
    body: str = "my private thought",
    created_at: datetime = FIXED_NOW,
) -> Annotation:
    return Annotation(
        id=annotation_id,
        book_id=book_id,
        kind=AnnotationKind.NOTE,
        status=status,
        anchor=anchor,
        selected_text=None,
        body=body,
        color=None,
        created_at=created_at,
        updated_at=created_at,
        version=0,
    )


def test_add_and_get_roundtrip_all_shapes(tmp_path: Path) -> None:
    _, repository = make_repository(tmp_path)
    highlight = make_highlight("ann-hl")
    floating_note = make_note("ann-floating")
    pdf_note = make_note("ann-pdf", anchor=make_pdf_anchor())
    for annotation in (highlight, floating_note, pdf_note):
        repository.add(annotation)
        assert repository.get(annotation.id) == annotation
    assert repository.get("ann-missing") is None


def test_add_rejects_unknown_book(tmp_path: Path) -> None:
    _, repository = make_repository(tmp_path)
    with pytest.raises(KeyError, match="Unknown Book"):
        repository.add(make_highlight("ann-1", book_id="book-missing"))


def test_add_rejects_duplicate_identity(tmp_path: Path) -> None:
    _, repository = make_repository(tmp_path)
    repository.add(make_highlight("ann-1"))
    with pytest.raises(RepositoryConflict, match="already exists"):
        repository.add(make_highlight("ann-1"))


def test_save_persists_full_lifecycle_with_optimistic_versions(tmp_path: Path) -> None:
    _, repository = make_repository(tmp_path)
    highlight = make_highlight("ann-1")
    repository.add(highlight)

    recolored = highlight.change_color(AnnotationColor.GREEN, now=FIXED_NOW + timedelta(minutes=1))
    repository.save(highlight, recolored)
    orphaned = recolored.mark_orphaned(now=FIXED_NOW + timedelta(minutes=2))
    repository.save(recolored, orphaned)
    reanchored = orphaned.reanchor(
        make_markdown_anchor(sha256=NEW_SHA, start=42),
        now=FIXED_NOW + timedelta(minutes=3),
    )
    repository.save(orphaned, reanchored)
    assert repository.get("ann-1") == reanchored

    deleted = reanchored.soft_delete(now=FIXED_NOW + timedelta(minutes=4))
    repository.save(reanchored, deleted)
    fetched = repository.get("ann-1")
    assert fetched == deleted
    assert fetched is not None and fetched.version == 4

    note = make_note("note-1")
    repository.add(note)
    edited = note.edit_body("revised thought", now=FIXED_NOW + timedelta(minutes=1))
    repository.save(note, edited)
    assert repository.get("note-1") == edited


def test_save_rejects_stale_version(tmp_path: Path) -> None:
    _, repository = make_repository(tmp_path)
    highlight = make_highlight("ann-1")
    repository.add(highlight)
    recolored = highlight.change_color(AnnotationColor.BLUE, now=FIXED_NOW + timedelta(minutes=1))
    repository.save(highlight, recolored)
    with pytest.raises(RepositoryConflict, match="changed or removed"):
        repository.save(highlight, recolored)


def test_save_rejects_unknown_annotation(tmp_path: Path) -> None:
    _, repository = make_repository(tmp_path)
    highlight = make_highlight("ann-ghost")
    with pytest.raises(RepositoryConflict, match="changed or removed"):
        repository.save(highlight, highlight.soft_delete(now=FIXED_NOW))


def test_save_rejects_identity_or_version_drift(tmp_path: Path) -> None:
    _, repository = make_repository(tmp_path)
    highlight = make_highlight("ann-1")
    repository.add(highlight)
    deleted = highlight.soft_delete(now=FIXED_NOW + timedelta(minutes=1))

    with pytest.raises(RepositoryConflict, match="must increment"):
        repository.save(highlight, replace(deleted, id="ann-2"))
    with pytest.raises(RepositoryConflict, match="must increment"):
        repository.save(highlight, replace(deleted, book_id="book-2"))
    with pytest.raises(RepositoryConflict, match="must increment"):
        repository.save(highlight, replace(deleted, version=highlight.version + 2))
    with pytest.raises(RepositoryConflict, match="must increment"):
        repository.save(
            highlight,
            replace(deleted, created_at=FIXED_NOW + timedelta(minutes=1)),
        )
    assert repository.get("ann-1") == highlight


def test_list_for_book_orders_newest_first_and_paginates(tmp_path: Path) -> None:
    _, repository = make_repository(tmp_path)
    for index in range(1, 6):
        repository.add(
            make_highlight(f"ann-{index}", created_at=FIXED_NOW + timedelta(minutes=index))
        )

    first = repository.list_for_book("book-1", limit=2)
    assert [annotation.id for annotation in first] == ["ann-5", "ann-4"]

    second = repository.list_for_book(
        "book-1",
        limit=2,
        before_created_at=first[-1].created_at,
        before_id=first[-1].id,
    )
    assert [annotation.id for annotation in second] == ["ann-3", "ann-2"]

    third = repository.list_for_book(
        "book-1",
        limit=2,
        before_created_at=second[-1].created_at,
        before_id=second[-1].id,
    )
    assert [annotation.id for annotation in third] == ["ann-1"]

    exhausted = repository.list_for_book(
        "book-1",
        limit=2,
        before_created_at=third[-1].created_at,
        before_id=third[-1].id,
    )
    assert list(exhausted) == []


def test_list_for_book_breaks_created_at_ties_by_id(tmp_path: Path) -> None:
    _, repository = make_repository(tmp_path)
    repository.add(make_note("tie-a"))
    repository.add(make_note("tie-b"))

    page = repository.list_for_book("book-1", limit=10)
    assert [annotation.id for annotation in page] == ["tie-b", "tie-a"]

    rest = repository.list_for_book(
        "book-1",
        limit=10,
        before_created_at=page[0].created_at,
        before_id=page[0].id,
    )
    assert [annotation.id for annotation in rest] == ["tie-a"]


def test_list_for_book_filters_by_status_and_isolates_books(tmp_path: Path) -> None:
    _, repository = make_repository(tmp_path)
    active = make_highlight("ann-active", created_at=FIXED_NOW + timedelta(minutes=3))
    orphaned = make_highlight(
        "ann-orphaned",
        status=AnnotationStatus.ORPHANED,
        created_at=FIXED_NOW + timedelta(minutes=2),
    )
    deleted = make_note(
        "ann-deleted",
        status=AnnotationStatus.DELETED,
        created_at=FIXED_NOW + timedelta(minutes=1),
    )
    other_book = make_highlight("ann-other", book_id="book-2")
    for annotation in (active, orphaned, deleted, other_book):
        repository.add(annotation)

    everything = repository.list_for_book("book-1", limit=10)
    assert [annotation.id for annotation in everything] == [
        "ann-active",
        "ann-orphaned",
        "ann-deleted",
    ]
    only_active = repository.list_for_book("book-1", statuses=[AnnotationStatus.ACTIVE], limit=10)
    assert [annotation.id for annotation in only_active] == ["ann-active"]
    visible = repository.list_for_book(
        "book-1",
        statuses=[AnnotationStatus.ACTIVE, AnnotationStatus.ORPHANED],
        limit=10,
    )
    assert [annotation.id for annotation in visible] == ["ann-active", "ann-orphaned"]


def test_list_for_book_validates_arguments(tmp_path: Path) -> None:
    _, repository = make_repository(tmp_path)
    with pytest.raises(ValueError, match="between 1 and 100"):
        repository.list_for_book("book-1", limit=0)
    with pytest.raises(ValueError, match="between 1 and 100"):
        repository.list_for_book("book-1", limit=101)
    with pytest.raises(ValueError, match="both before_created_at and before_id"):
        repository.list_for_book("book-1", limit=10, before_created_at=FIXED_NOW)
    with pytest.raises(ValueError, match="both before_created_at and before_id"):
        repository.list_for_book("book-1", limit=10, before_id="ann-1")
    with pytest.raises(ValueError, match="status filter cannot be empty"):
        repository.list_for_book("book-1", statuses=[], limit=10)


def test_list_for_anchor_document_returns_sweep_candidates(tmp_path: Path) -> None:
    _, repository = make_repository(tmp_path)
    first = make_highlight("ann-1", created_at=FIXED_NOW + timedelta(minutes=1))
    cross_book = make_highlight(
        "ann-2",
        book_id="book-2",
        status=AnnotationStatus.ORPHANED,
        created_at=FIXED_NOW + timedelta(minutes=2),
    )
    other_document = make_highlight("ann-3", sha256=OTHER_SHA)
    floating_note = make_note("ann-4")
    for annotation in (first, cross_book, other_document, floating_note):
        repository.add(annotation)

    swept = repository.list_for_anchor_document(DOC_SHA)
    assert [annotation.id for annotation in swept] == ["ann-1", "ann-2"]
    active_only = repository.list_for_anchor_document(DOC_SHA, statuses=[AnnotationStatus.ACTIVE])
    assert [annotation.id for annotation in active_only] == ["ann-1"]
    with pytest.raises(ValueError, match="status filter cannot be empty"):
        repository.list_for_anchor_document(DOC_SHA, statuses=[])
    assert list(repository.list_for_anchor_document(NEW_SHA)) == []


def test_count_for_book_counts_all_statuses(tmp_path: Path) -> None:
    _, repository = make_repository(tmp_path)
    repository.add(make_highlight("ann-1"))
    repository.add(make_highlight("ann-2", status=AnnotationStatus.ORPHANED))
    repository.add(make_note("ann-3", status=AnnotationStatus.DELETED))
    repository.add(make_note("ann-4", book_id="book-2"))
    assert repository.count_for_book("book-1") == 3
    assert repository.count_for_book("book-2") == 1
    assert repository.count_for_book("book-empty") == 0


def test_book_deletion_cascades_annotations(tmp_path: Path) -> None:
    database, repository = make_repository(tmp_path)
    repository.add(make_highlight("ann-1"))
    repository.add(make_note("ann-2", book_id="book-2"))

    with database.connect(immediate=True) as connection:
        connection.execute("DELETE FROM books WHERE id = ?", ("book-1",))

    assert repository.get("ann-1") is None
    assert repository.count_for_book("book-1") == 0
    assert repository.get("ann-2") is not None


def test_repository_reuses_an_injected_connection(tmp_path: Path) -> None:
    database, _ = make_repository(tmp_path)
    with database.connect(immediate=True) as connection:
        scoped = SQLiteAnnotationRepository(connection)
        scoped.add(make_highlight("ann-tx"))
        assert scoped.get("ann-tx") is not None
        assert scoped.count_for_book("book-1") == 1
    assert SQLiteAnnotationRepository(database).get("ann-tx") is not None


def _base_highlight_row(annotation_id: str = "raw-violation") -> dict[str, object]:
    return {
        "id": annotation_id,
        "book_id": "book-1",
        "kind": "highlight",
        "status": "active",
        "anchor_type": "markdown_offset",
        "anchor_sha256": DOC_SHA,
        "anchor_start": 10,
        "anchor_end": 26,
        "chapter_ref": "markdown-heading-0001",
        "quote_exact": "selected passage",
        "quote_prefix": "before ",
        "quote_suffix": " after",
        "selected_text": "selected passage",
        "body": None,
        "color": "yellow",
        "created_at": FIXED_NOW.isoformat(),
        "updated_at": FIXED_NOW.isoformat(),
        "version": 0,
    }


def _base_note_row(annotation_id: str = "raw-violation") -> dict[str, object]:
    return {
        "id": annotation_id,
        "book_id": "book-1",
        "kind": "note",
        "status": "active",
        "anchor_type": None,
        "anchor_sha256": None,
        "anchor_start": None,
        "anchor_end": None,
        "chapter_ref": None,
        "quote_exact": None,
        "quote_prefix": None,
        "quote_suffix": None,
        "selected_text": None,
        "body": "my private thought",
        "color": None,
        "created_at": FIXED_NOW.isoformat(),
        "updated_at": FIXED_NOW.isoformat(),
        "version": 0,
    }


def _insert_raw(connection: sqlite3.Connection, row: dict[str, object]) -> None:
    columns = ", ".join(row)
    placeholders = ", ".join("?" for _ in row)
    connection.execute(
        f"INSERT INTO annotations({columns}) VALUES ({placeholders})",
        tuple(row.values()),
    )


_NO_ANCHOR_COLUMNS: dict[str, object] = {
    "anchor_type": None,
    "anchor_sha256": None,
    "anchor_start": None,
    "anchor_end": None,
    "chapter_ref": None,
    "quote_exact": None,
    "quote_prefix": None,
    "quote_suffix": None,
}

_CHECK_VIOLATIONS = [
    pytest.param("highlight", {"color": None}, id="highlight-without-color"),
    pytest.param("highlight", {"selected_text": None}, id="highlight-without-selected-text"),
    pytest.param(
        "highlight",
        {"quote_exact": None, "quote_prefix": None, "quote_suffix": None},
        id="highlight-without-quote",
    ),
    pytest.param("highlight", {"quote_exact": "different"}, id="highlight-quote-mismatch"),
    pytest.param("highlight", {"anchor_end": 10}, id="highlight-empty-range"),
    pytest.param("highlight", dict(_NO_ANCHOR_COLUMNS), id="highlight-without-anchor"),
    pytest.param("highlight", {"anchor_sha256": None}, id="anchor-type-sha-mismatch"),
    pytest.param("highlight", {"anchor_sha256": "ABC"}, id="anchor-sha-malformed"),
    pytest.param("highlight", {"anchor_start": None}, id="markdown-anchor-missing-start"),
    pytest.param("highlight", {"anchor_start": -1}, id="markdown-anchor-negative-start"),
    pytest.param("highlight", {"anchor_end": 5}, id="markdown-anchor-end-before-start"),
    pytest.param("highlight", {"quote_prefix": None}, id="quote-columns-inconsistent"),
    pytest.param("highlight", {"quote_prefix": "x" * 65}, id="quote-prefix-too-long"),
    pytest.param("highlight", {"quote_exact": "", "selected_text": ""}, id="empty-selected-text"),
    pytest.param(
        "highlight",
        {"quote_exact": "x" * 2001, "selected_text": "x" * 2001},
        id="selected-text-too-long",
    ),
    pytest.param("highlight", {"version": -1}, id="negative-version"),
    pytest.param("highlight", {"kind": "bookmark"}, id="unknown-kind"),
    pytest.param("highlight", {"status": "archived"}, id="unknown-status"),
    pytest.param("highlight", {"color": "red"}, id="unknown-color"),
    pytest.param("note", {"selected_text": "stray"}, id="note-with-selected-text"),
    pytest.param("note", {"body": None}, id="note-without-body"),
    pytest.param("note", {"body": "x" * 10001}, id="note-body-too-long"),
    pytest.param("note", {"status": "orphaned"}, id="orphan-without-anchor"),
    pytest.param("note", {"chapter_ref": ""}, id="blank-chapter-ref"),
    pytest.param(
        "note",
        {"anchor_type": "pdf_page", "anchor_sha256": DOC_SHA, "anchor_start": 3, "anchor_end": 9},
        id="pdf-anchor-with-end",
    ),
    pytest.param(
        "note",
        {"anchor_type": "pdf_page", "anchor_sha256": DOC_SHA, "anchor_start": 0},
        id="pdf-anchor-zero-page",
    ),
    pytest.param(
        "note",
        {"anchor_type": "epub_cfi", "anchor_sha256": DOC_SHA},
        id="epub-anchor-rejected",
    ),
    pytest.param("note", {"book_id": "missing-book"}, id="unknown-book-fk"),
]


def test_raw_base_rows_satisfy_sql_checks(tmp_path: Path) -> None:
    database, repository = make_repository(tmp_path)
    with database.connect(immediate=True) as connection:
        _insert_raw(connection, _base_highlight_row("raw-hl"))
        _insert_raw(connection, _base_note_row("raw-note"))
    assert repository.get("raw-hl") == make_highlight("raw-hl")
    assert repository.get("raw-note") is not None


@pytest.mark.parametrize(("base", "overrides"), _CHECK_VIOLATIONS)
def test_sql_checks_reject_invariant_violations(
    tmp_path: Path, base: str, overrides: dict[str, object]
) -> None:
    database, _ = make_repository(tmp_path)
    row = _base_highlight_row() if base == "highlight" else _base_note_row()
    row.update(overrides)
    with database.connect(immediate=True) as connection, pytest.raises(sqlite3.IntegrityError):
        _insert_raw(connection, row)


_MARKDOWN = ChatReferenceLocationType.MARKDOWN_OFFSET
_PDF = ChatReferenceLocationType.PDF_PAGE
_EPUB = ChatReferenceLocationType.EPUB_CFI

_DOMAIN_VIOLATIONS = [
    pytest.param(lambda: make_highlight(color=None), id="highlight-without-color"),
    pytest.param(
        lambda: replace(make_highlight(), selected_text=None),
        id="highlight-without-selected-text",
    ),
    pytest.param(
        lambda: replace(make_highlight(), anchor=replace(make_markdown_anchor(), quote=None)),
        id="highlight-without-quote",
    ),
    pytest.param(
        lambda: replace(make_highlight(), selected_text="different"),
        id="highlight-quote-mismatch",
    ),
    pytest.param(
        lambda: replace(make_highlight(), anchor=replace(make_markdown_anchor(), end=10)),
        id="highlight-empty-range",
    ),
    pytest.param(lambda: replace(make_highlight(), anchor=None), id="highlight-without-anchor"),
    pytest.param(lambda: make_markdown_anchor(sha256="ABC"), id="anchor-sha-malformed"),
    pytest.param(
        lambda: ContentAnchor(type=_MARKDOWN, anchor_sha256=DOC_SHA),
        id="markdown-anchor-missing-start",
    ),
    pytest.param(
        lambda: ContentAnchor(type=_MARKDOWN, anchor_sha256=DOC_SHA, start=-1, end=5),
        id="markdown-anchor-negative-start",
    ),
    pytest.param(
        lambda: ContentAnchor(type=_MARKDOWN, anchor_sha256=DOC_SHA, start=10, end=5),
        id="markdown-anchor-end-before-start",
    ),
    pytest.param(lambda: TextQuote(exact="x", prefix="x" * 65), id="quote-prefix-too-long"),
    pytest.param(lambda: TextQuote(exact=""), id="empty-selected-text"),
    pytest.param(lambda: TextQuote(exact="x" * 2001), id="selected-text-too-long"),
    pytest.param(lambda: replace(make_note(), version=-1), id="negative-version"),
    pytest.param(lambda: replace(make_note(), selected_text="stray"), id="note-with-selected-text"),
    pytest.param(lambda: replace(make_note(), body=None), id="note-without-body"),
    pytest.param(lambda: replace(make_note(), body="x" * 10001), id="note-body-too-long"),
    pytest.param(
        lambda: replace(make_note(), status=AnnotationStatus.ORPHANED),
        id="orphan-without-anchor",
    ),
    pytest.param(
        lambda: ContentAnchor(
            type=_MARKDOWN, anchor_sha256=DOC_SHA, start=0, end=4, chapter_ref=" "
        ),
        id="blank-chapter-ref",
    ),
    pytest.param(
        lambda: ContentAnchor(type=_PDF, anchor_sha256=DOC_SHA, start=3, end=9),
        id="pdf-anchor-with-end",
    ),
    pytest.param(
        lambda: ContentAnchor(type=_PDF, anchor_sha256=DOC_SHA, start=0),
        id="pdf-anchor-zero-page",
    ),
    pytest.param(
        lambda: ContentAnchor(type=_EPUB, anchor_sha256=DOC_SHA), id="epub-anchor-rejected"
    ),
]


@pytest.mark.parametrize("factory", _DOMAIN_VIOLATIONS)
def test_domain_invariants_match_sql_checks(factory: Callable[[], object]) -> None:
    with pytest.raises(ValueError):
        factory()
