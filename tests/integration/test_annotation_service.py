from __future__ import annotations

import pytest

from diandianreading.application.use_cases.annotations import (
    AnnotationNotFoundError,
    AnnotationService,
)
from diandianreading.application.use_cases.catalog import BookNotFoundError
from diandianreading.application.use_cases.reading import StaleAnchorError
from diandianreading.domain import DiandianError, ErrorCode
from diandianreading.domain.annotations import (
    AnnotationColor,
    AnnotationStatus,
    ContentAnchor,
    TextQuote,
)
from diandianreading.domain.chat import ChatReferenceLocationType
from diandianreading.infrastructure.persistence.annotations import (
    SQLiteAnnotationRepository,
)
from tests.integration.test_reading_service import MARKDOWN_RAW, PDF_RAW, Env


class AnnotationEnv(Env):
    def __init__(self, tmp_path) -> None:
        super().__init__(tmp_path)
        self.annotations = AnnotationService(
            repository=SQLiteAnnotationRepository(self.database),
            reading=self.service,
        )

    def selection_anchor(self, book_id: str) -> tuple[ContentAnchor, str]:
        content = self.service.get_content(book_id)
        text = content.payload.decode("utf-8")
        selection = "Body one."
        start = text.index(selection)
        anchor = ContentAnchor(
            type=ChatReferenceLocationType.MARKDOWN_OFFSET,
            anchor_sha256=content.document.anchor_sha256,
            start=start,
            end=start + len(selection),
            chapter_ref="markdown-heading-0001",
            quote=TextQuote(exact=selection, prefix="", suffix=""),
        )
        return anchor, selection


class TestCreateAnnotations:
    def test_highlight_verifies_selection_slice(self, tmp_path) -> None:
        env = AnnotationEnv(tmp_path)
        env.add_book(book_id="b1", mime_type="text/markdown", content=MARKDOWN_RAW)
        anchor, selection = env.selection_anchor("b1")

        created = env.annotations.create_highlight(
            "b1",
            anchor=anchor,
            selected_text=selection,
            body=None,
            color=AnnotationColor.YELLOW,
        )
        assert created.status is AnnotationStatus.ACTIVE
        assert env.annotations.list_for_book("b1").items == (created,)

    def test_highlight_rejects_slice_mismatch(self, tmp_path) -> None:
        env = AnnotationEnv(tmp_path)
        env.add_book(book_id="b2", mime_type="text/markdown", content=MARKDOWN_RAW)
        anchor, _ = env.selection_anchor("b2")
        mismatched = ContentAnchor(
            type=anchor.type,
            anchor_sha256=anchor.anchor_sha256,
            start=0,
            end=9,
            quote=TextQuote(exact="Body one."),
        )
        with pytest.raises(StaleAnchorError):
            env.annotations.create_highlight(
                "b2",
                anchor=mismatched,
                selected_text="Body one.",
                body=None,
                color=AnnotationColor.YELLOW,
            )

    def test_highlight_rejects_foreign_document_hash(self, tmp_path) -> None:
        env = AnnotationEnv(tmp_path)
        env.add_book(book_id="b3", mime_type="text/markdown", content=MARKDOWN_RAW)
        anchor, selection = env.selection_anchor("b3")
        foreign = ContentAnchor(
            type=anchor.type,
            anchor_sha256="0" * 64,
            start=anchor.start,
            end=anchor.end,
            quote=anchor.quote,
        )
        with pytest.raises(StaleAnchorError):
            env.annotations.create_highlight(
                "b3",
                anchor=foreign,
                selected_text=selection,
                body=None,
                color=AnnotationColor.YELLOW,
            )

    def test_pdf_highlight_skips_text_verification(self, tmp_path) -> None:
        env = AnnotationEnv(tmp_path)
        _, root = env.add_book(book_id="pdf", mime_type="application/pdf", content=PDF_RAW)
        anchor = ContentAnchor(
            type=ChatReferenceLocationType.PDF_PAGE,
            anchor_sha256=root.sha256,
            start=2,
            quote=TextQuote(exact="quoted from the pdf text layer"),
        )
        created = env.annotations.create_highlight(
            "pdf",
            anchor=anchor,
            selected_text="quoted from the pdf text layer",
            body=None,
            color=AnnotationColor.BLUE,
        )
        assert created.anchor is not None and created.anchor.start == 2

    def test_note_with_and_without_anchor(self, tmp_path) -> None:
        env = AnnotationEnv(tmp_path)
        env.add_book(book_id="b4", mime_type="text/markdown", content=MARKDOWN_RAW)
        plain = env.annotations.create_note("b4", body="thought", anchor=None)
        assert plain.anchor is None

        content = env.service.get_content("b4")
        caret = ContentAnchor(
            type=ChatReferenceLocationType.MARKDOWN_OFFSET,
            anchor_sha256=content.document.anchor_sha256,
            start=3,
            end=3,
        )
        anchored = env.annotations.create_note("b4", body="anchored", anchor=caret)
        assert anchored.anchor is not None

        with pytest.raises(StaleAnchorError):
            env.annotations.create_note(
                "b4",
                body="stale",
                anchor=ContentAnchor(
                    type=ChatReferenceLocationType.MARKDOWN_OFFSET,
                    anchor_sha256="0" * 64,
                    start=0,
                    end=0,
                ),
            )

    def test_unknown_book_is_not_found(self, tmp_path) -> None:
        env = AnnotationEnv(tmp_path)
        with pytest.raises(BookNotFoundError):
            env.annotations.create_note("missing", body="x", anchor=None)
        with pytest.raises(BookNotFoundError):
            env.annotations.list_for_book("missing")


class TestListEditLifecycle:
    def test_pagination_and_status_filter(self, tmp_path) -> None:
        env = AnnotationEnv(tmp_path)
        env.add_book(book_id="b5", mime_type="text/markdown", content=MARKDOWN_RAW)
        notes = [
            env.annotations.create_note("b5", body=f"note {index}", anchor=None)
            for index in range(3)
        ]
        deleted = env.annotations.soft_delete(notes[0].id)
        assert deleted.status is AnnotationStatus.DELETED

        visible = env.annotations.list_for_book("b5")
        assert {item.id for item in visible.items} == {notes[1].id, notes[2].id}

        everything = env.annotations.list_for_book(
            "b5",
            statuses=(
                AnnotationStatus.ACTIVE,
                AnnotationStatus.ORPHANED,
                AnnotationStatus.DELETED,
            ),
        )
        assert len(everything.items) == 3

        all_statuses = (
            AnnotationStatus.ACTIVE,
            AnnotationStatus.ORPHANED,
            AnnotationStatus.DELETED,
        )
        first_page = env.annotations.list_for_book("b5", statuses=all_statuses, limit=2)
        assert len(first_page.items) == 2
        assert first_page.next_cursor is not None
        second_page = env.annotations.list_for_book(
            "b5", statuses=all_statuses, limit=2, before=first_page.next_cursor
        )
        assert len(second_page.items) == 1
        assert second_page.next_cursor is None

        exact_fit = env.annotations.list_for_book("b5", limit=2)
        assert len(exact_fit.items) == 2
        assert exact_fit.next_cursor is None

    def test_edit_delete_restore_and_conflicts(self, tmp_path) -> None:
        env = AnnotationEnv(tmp_path)
        env.add_book(book_id="b6", mime_type="text/markdown", content=MARKDOWN_RAW)
        anchor, selection = env.selection_anchor("b6")
        highlight = env.annotations.create_highlight(
            "b6",
            anchor=anchor,
            selected_text=selection,
            body="draft",
            color=AnnotationColor.YELLOW,
        )

        edited = env.annotations.edit(
            highlight.id,
            body_change=("sharper",),
            color=AnnotationColor.GREEN,
        )
        assert edited.body == "sharper"
        assert edited.color is AnnotationColor.GREEN
        assert edited.version == highlight.version + 2

        cleared = env.annotations.edit(highlight.id, body_change=(None,))
        assert cleared.body is None

        deleted = env.annotations.soft_delete(highlight.id)
        with pytest.raises(DiandianError) as conflict:
            env.annotations.edit(highlight.id, body_change=("late",))
        assert conflict.value.code is ErrorCode.REPOSITORY_CONFLICT

        restored = env.annotations.restore(deleted.id)
        assert restored.status is AnnotationStatus.ACTIVE
        with pytest.raises(DiandianError) as double:
            env.annotations.restore(deleted.id)
        assert double.value.code is ErrorCode.REPOSITORY_CONFLICT

    def test_unknown_annotation_is_not_found(self, tmp_path) -> None:
        env = AnnotationEnv(tmp_path)
        with pytest.raises(AnnotationNotFoundError):
            env.annotations.edit("missing", body_change=("x",))
        with pytest.raises(AnnotationNotFoundError):
            env.annotations.soft_delete(" ")
