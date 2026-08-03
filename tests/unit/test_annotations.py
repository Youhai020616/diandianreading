from __future__ import annotations

from datetime import timedelta

import pytest

from diandianreading.domain import InvalidStateTransition
from diandianreading.domain.annotations import (
    NOTE_BODY_MAX_CODEPOINTS,
    QUOTE_CONTEXT_MAX_CODEPOINTS,
    SELECTED_TEXT_MAX_CODEPOINTS,
    Annotation,
    AnnotationColor,
    AnnotationKind,
    AnnotationStatus,
    ContentAnchor,
    ReadingProgress,
    TextQuote,
)
from diandianreading.domain.chat import ChatReferenceLocationType
from tests.support import FIXED_NOW

DOC_SHA = "deadbeef" * 8
OTHER_SHA = "cafef00d" * 8


def make_quote(exact: str = "selected passage") -> TextQuote:
    return TextQuote(exact=exact, prefix="before ", suffix=" after")


def make_markdown_anchor(
    *,
    sha256: str = DOC_SHA,
    start: int = 100,
    end: int = 116,
    quote: TextQuote | None = None,
    chapter_ref: str | None = "markdown-heading-0001",
) -> ContentAnchor:
    return ContentAnchor(
        type=ChatReferenceLocationType.MARKDOWN_OFFSET,
        anchor_sha256=sha256,
        start=start,
        end=end,
        chapter_ref=chapter_ref,
        quote=quote,
    )


def make_highlight(
    *,
    status: AnnotationStatus = AnnotationStatus.ACTIVE,
    selected_text: str = "selected passage",
    body: str | None = None,
    version: int = 0,
) -> Annotation:
    return Annotation(
        id="ann-1",
        book_id="book-1",
        kind=AnnotationKind.HIGHLIGHT,
        status=status,
        anchor=make_markdown_anchor(quote=make_quote(selected_text)),
        selected_text=selected_text,
        body=body,
        color=AnnotationColor.YELLOW,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
        version=version,
    )


def make_note(
    *,
    status: AnnotationStatus = AnnotationStatus.ACTIVE,
    anchor: ContentAnchor | None = None,
    body: str = "my thought",
) -> Annotation:
    return Annotation(
        id="ann-2",
        book_id="book-1",
        kind=AnnotationKind.NOTE,
        status=status,
        anchor=anchor,
        selected_text=None,
        body=body,
        color=None,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
        version=0,
    )


class TestTextQuote:
    def test_accepts_bounded_context(self) -> None:
        quote = make_quote()
        assert quote.exact == "selected passage"

    def test_rejects_empty_exact(self) -> None:
        with pytest.raises(ValueError, match="exact cannot be empty"):
            TextQuote(exact="")

    def test_rejects_oversized_exact(self) -> None:
        with pytest.raises(ValueError, match="exact cannot exceed"):
            TextQuote(exact="x" * (SELECTED_TEXT_MAX_CODEPOINTS + 1))

    def test_rejects_oversized_context(self) -> None:
        with pytest.raises(ValueError, match="prefix cannot exceed"):
            TextQuote(exact="ok", prefix="p" * (QUOTE_CONTEXT_MAX_CODEPOINTS + 1))

    def test_rejects_nul_bytes(self) -> None:
        with pytest.raises(ValueError, match="cannot contain NUL"):
            TextQuote(exact="bad\x00text")
        with pytest.raises(ValueError, match="suffix cannot contain NUL"):
            TextQuote(exact="ok", suffix="\x00")


class TestContentAnchor:
    def test_markdown_range_is_range(self) -> None:
        anchor = make_markdown_anchor()
        assert anchor.is_range

    def test_markdown_caret_allowed_but_not_range(self) -> None:
        caret = make_markdown_anchor(start=42, end=42)
        assert not caret.is_range

    def test_markdown_requires_offsets(self) -> None:
        with pytest.raises(ValueError, match="require start and end"):
            ContentAnchor(
                type=ChatReferenceLocationType.MARKDOWN_OFFSET,
                anchor_sha256=DOC_SHA,
            )

    def test_markdown_rejects_inverted_interval(self) -> None:
        with pytest.raises(ValueError, match="0 <= start <= end"):
            make_markdown_anchor(start=10, end=9)
        with pytest.raises(ValueError, match="0 <= start <= end"):
            make_markdown_anchor(start=-1, end=5)

    def test_rejects_malformed_sha256(self) -> None:
        with pytest.raises(ValueError, match="sha256 hex digest"):
            make_markdown_anchor(sha256="abc")
        with pytest.raises(ValueError, match="sha256 hex digest"):
            make_markdown_anchor(sha256="DEADBEEF" * 8)

    def test_rejects_blank_chapter_ref(self) -> None:
        with pytest.raises(ValueError, match="chapter_ref cannot be blank"):
            make_markdown_anchor(chapter_ref="   ")

    def test_pdf_page_anchor(self) -> None:
        anchor = ContentAnchor(
            type=ChatReferenceLocationType.PDF_PAGE,
            anchor_sha256=DOC_SHA,
            start=3,
        )
        assert not anchor.is_range

    def test_pdf_rejects_zero_page_and_end(self) -> None:
        with pytest.raises(ValueError, match="1-based page"):
            ContentAnchor(
                type=ChatReferenceLocationType.PDF_PAGE,
                anchor_sha256=DOC_SHA,
                start=0,
            )
        with pytest.raises(ValueError, match="leave end unset"):
            ContentAnchor(
                type=ChatReferenceLocationType.PDF_PAGE,
                anchor_sha256=DOC_SHA,
                start=1,
                end=2,
            )

    def test_epub_cfi_is_reserved(self) -> None:
        with pytest.raises(ValueError, match="reserved"):
            ContentAnchor(
                type=ChatReferenceLocationType.EPUB_CFI,
                anchor_sha256=DOC_SHA,
            )


class TestAnnotationInvariants:
    def test_valid_highlight(self) -> None:
        highlight = make_highlight(body="a thought about it")
        assert highlight.status is AnnotationStatus.ACTIVE

    def test_valid_standalone_note(self) -> None:
        note = make_note()
        assert note.anchor is None

    def test_requires_identity(self) -> None:
        with pytest.raises(ValueError, match="id and book_id"):
            Annotation(
                id="",
                book_id="book-1",
                kind=AnnotationKind.NOTE,
                status=AnnotationStatus.ACTIVE,
                anchor=None,
                selected_text=None,
                body="x",
                color=None,
                created_at=FIXED_NOW,
                updated_at=FIXED_NOW,
                version=0,
            )

    def test_rejects_negative_version(self) -> None:
        with pytest.raises(ValueError, match="version cannot be negative"):
            make_highlight(version=-1)

    def test_highlight_requires_anchor_with_quote(self) -> None:
        base = make_highlight()
        with pytest.raises(ValueError, match="anchor with a re-anchoring quote"):
            Annotation(
                id=base.id,
                book_id=base.book_id,
                kind=AnnotationKind.HIGHLIGHT,
                status=AnnotationStatus.ACTIVE,
                anchor=make_markdown_anchor(quote=None),
                selected_text="selected passage",
                body=None,
                color=AnnotationColor.YELLOW,
                created_at=FIXED_NOW,
                updated_at=FIXED_NOW,
                version=0,
            )

    def test_highlight_requires_non_empty_range(self) -> None:
        caret_anchor = ContentAnchor(
            type=ChatReferenceLocationType.MARKDOWN_OFFSET,
            anchor_sha256=DOC_SHA,
            start=7,
            end=7,
            quote=make_quote(),
        )
        with pytest.raises(ValueError, match="non-empty anchored range"):
            Annotation(
                id="ann-1",
                book_id="book-1",
                kind=AnnotationKind.HIGHLIGHT,
                status=AnnotationStatus.ACTIVE,
                anchor=caret_anchor,
                selected_text="selected passage",
                body=None,
                color=AnnotationColor.YELLOW,
                created_at=FIXED_NOW,
                updated_at=FIXED_NOW,
                version=0,
            )

    def test_highlight_quote_must_match_selected_text(self) -> None:
        with pytest.raises(ValueError, match="quote must match selected_text"):
            Annotation(
                id="ann-1",
                book_id="book-1",
                kind=AnnotationKind.HIGHLIGHT,
                status=AnnotationStatus.ACTIVE,
                anchor=make_markdown_anchor(quote=make_quote("different text")),
                selected_text="selected passage",
                body=None,
                color=AnnotationColor.YELLOW,
                created_at=FIXED_NOW,
                updated_at=FIXED_NOW,
                version=0,
            )

    def test_highlight_requires_color(self) -> None:
        with pytest.raises(ValueError, match="require a color"):
            Annotation(
                id="ann-1",
                book_id="book-1",
                kind=AnnotationKind.HIGHLIGHT,
                status=AnnotationStatus.ACTIVE,
                anchor=make_markdown_anchor(quote=make_quote()),
                selected_text="selected passage",
                body=None,
                color=None,
                created_at=FIXED_NOW,
                updated_at=FIXED_NOW,
                version=0,
            )

    def test_note_requires_body_and_forbids_selection(self) -> None:
        with pytest.raises(ValueError, match="body cannot be empty"):
            make_note(body="")
        with pytest.raises(ValueError, match="Notes require a body"):
            Annotation(
                id="ann-2",
                book_id="book-1",
                kind=AnnotationKind.NOTE,
                status=AnnotationStatus.ACTIVE,
                anchor=None,
                selected_text=None,
                body=None,
                color=None,
                created_at=FIXED_NOW,
                updated_at=FIXED_NOW,
                version=0,
            )
        with pytest.raises(ValueError, match="quotes belong to highlights"):
            Annotation(
                id="ann-2",
                book_id="book-1",
                kind=AnnotationKind.NOTE,
                status=AnnotationStatus.ACTIVE,
                anchor=None,
                selected_text="stray quote",
                body="thought",
                color=None,
                created_at=FIXED_NOW,
                updated_at=FIXED_NOW,
                version=0,
            )

    def test_body_length_limit(self) -> None:
        with pytest.raises(ValueError, match="body cannot exceed"):
            make_note(body="x" * (NOTE_BODY_MAX_CODEPOINTS + 1))

    def test_orphaned_requires_anchor(self) -> None:
        with pytest.raises(ValueError, match="anchored annotations can be orphaned"):
            make_note(status=AnnotationStatus.ORPHANED)


class TestAnnotationTransitions:
    def test_mark_orphaned_bumps_version(self) -> None:
        later = FIXED_NOW + timedelta(minutes=5)
        highlight = make_highlight()
        orphaned = highlight.mark_orphaned(now=later)
        assert orphaned.status is AnnotationStatus.ORPHANED
        assert orphaned.version == highlight.version + 1
        assert orphaned.updated_at == later

    def test_mark_orphaned_guards(self) -> None:
        with pytest.raises(InvalidStateTransition, match="cannot orphan"):
            make_highlight(status=AnnotationStatus.DELETED).mark_orphaned()
        with pytest.raises(InvalidStateTransition, match="has no anchor"):
            make_note().mark_orphaned()

    def test_reanchor_restores_active(self) -> None:
        orphaned = make_highlight().mark_orphaned()
        moved = orphaned.reanchor(
            make_markdown_anchor(sha256=OTHER_SHA, start=5, end=21, quote=make_quote())
        )
        assert moved.status is AnnotationStatus.ACTIVE
        assert moved.anchor is not None and moved.anchor.anchor_sha256 == OTHER_SHA
        assert moved.version == orphaned.version + 1

    def test_reanchor_rejects_quote_drift(self) -> None:
        highlight = make_highlight()
        with pytest.raises(ValueError, match="quote must match selected_text"):
            highlight.reanchor(
                make_markdown_anchor(sha256=OTHER_SHA, quote=make_quote("other words"))
            )

    def test_reanchor_rejected_once_deleted(self) -> None:
        deleted = make_highlight().soft_delete()
        with pytest.raises(InvalidStateTransition, match="cannot reanchor"):
            deleted.reanchor(make_markdown_anchor(quote=make_quote()))

    def test_soft_delete_and_restore(self) -> None:
        deleted = make_highlight().soft_delete()
        assert deleted.status is AnnotationStatus.DELETED
        with pytest.raises(InvalidStateTransition, match="already deleted"):
            deleted.soft_delete()
        restored = deleted.restore()
        assert restored.status is AnnotationStatus.ACTIVE
        with pytest.raises(InvalidStateTransition, match="is not deleted"):
            restored.restore()

    def test_edit_body(self) -> None:
        highlight = make_highlight(body="draft")
        cleared = highlight.edit_body(None)
        assert cleared.body is None
        note = make_note()
        edited = note.edit_body("sharper thought")
        assert edited.body == "sharper thought"
        with pytest.raises(ValueError, match="Notes require a body"):
            note.edit_body(None)
        with pytest.raises(InvalidStateTransition, match="cannot be edited once deleted"):
            highlight.soft_delete().edit_body("late edit")

    def test_change_color(self) -> None:
        recolored = make_highlight().change_color(AnnotationColor.GREEN)
        assert recolored.color is AnnotationColor.GREEN
        with pytest.raises(InvalidStateTransition, match="Only highlights"):
            make_note().change_color(AnnotationColor.BLUE)
        with pytest.raises(InvalidStateTransition, match="cannot be edited once deleted"):
            make_highlight().soft_delete().change_color(AnnotationColor.PINK)


class TestReadingProgress:
    def make_progress(self, *, percent: float = 0.25) -> ReadingProgress:
        return ReadingProgress(
            book_id="book-1",
            anchor=make_markdown_anchor(start=42, end=42),
            percent=percent,
            updated_at=FIXED_NOW,
            version=0,
        )

    def test_accepts_caret_anchor(self) -> None:
        progress = self.make_progress()
        assert progress.percent == 0.25

    def test_percent_bounds(self) -> None:
        with pytest.raises(ValueError, match="within \\[0, 1\\]"):
            self.make_progress(percent=1.01)
        with pytest.raises(ValueError, match="within \\[0, 1\\]"):
            self.make_progress(percent=-0.01)

    def test_requires_identity(self) -> None:
        with pytest.raises(ValueError, match="book_id is required"):
            ReadingProgress(
                book_id="",
                anchor=make_markdown_anchor(),
                percent=0.5,
                updated_at=FIXED_NOW,
                version=0,
            )

    def test_rejects_negative_version(self) -> None:
        with pytest.raises(ValueError, match="version cannot be negative"):
            ReadingProgress(
                book_id="book-1",
                anchor=make_markdown_anchor(),
                percent=0.5,
                updated_at=FIXED_NOW,
                version=-1,
            )

    def test_advance_bumps_version(self) -> None:
        later = FIXED_NOW + timedelta(minutes=10)
        progress = self.make_progress()
        advanced = progress.advance(make_markdown_anchor(start=90, end=90), 0.5, now=later)
        assert advanced.percent == 0.5
        assert advanced.version == 1
        assert advanced.updated_at == later
        with pytest.raises(ValueError, match="within \\[0, 1\\]"):
            progress.advance(make_markdown_anchor(), 1.5)
