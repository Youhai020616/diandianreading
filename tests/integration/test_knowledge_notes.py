"""Knowledge note repository and service behaviour (C1).

The idempotency assertions matter most: ai-chat.md promises that repeating
save-as-note for one message returns the same note, and ADR-0008 delegates that
promise to a database unique index rather than an application-level lookup.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from diandianreading.application.use_cases.content import (
    DEFAULT_NOTE_TITLE,
    EmptyNoteBodyError,
    KnowledgeNoteService,
    derive_title,
)
from diandianreading.domain.content import (
    KNOWLEDGE_NOTE_BODY_MAX_CODEPOINTS,
    KNOWLEDGE_NOTE_TITLE_MAX_CODEPOINTS,
    KnowledgeNoteSource,
)
from diandianreading.infrastructure.persistence.content import SQLiteKnowledgeNoteRepository
from diandianreading.infrastructure.persistence.sqlite import SQLiteDatabase
from tests.support import FIXED_NOW

NOW = FIXED_NOW.isoformat()


@pytest.fixture
def service(tmp_path) -> KnowledgeNoteService:
    database = SQLiteDatabase(tmp_path / "state" / "app.sqlite3")
    database.migrate()
    with database.connect(immediate=True) as connection:
        connection.execute(
            """
            INSERT INTO books(id, title, author, source_hash, status, created_at, updated_at)
            VALUES ('book-1', '设计心理学', 'Norman', 'hash-1', 'ready', ?, ?)
            """,
            (NOW, NOW),
        )
    return KnowledgeNoteService(SQLiteKnowledgeNoteRepository(database))


class TestDeriveTitle:
    def test_uses_the_first_non_empty_line(self) -> None:
        assert derive_title("\n\n  可见性原则  \n更多正文") == "可见性原则"

    def test_strips_markdown_heading_markers(self) -> None:
        assert derive_title("## 可见性原则\n正文") == "可见性原则"

    def test_collapses_internal_whitespace(self) -> None:
        assert derive_title("可见性    与\t反馈") == "可见性 与 反馈"

    def test_truncates_a_long_first_line(self) -> None:
        title = derive_title("a" * (KNOWLEDGE_NOTE_TITLE_MAX_CODEPOINTS + 50))
        assert len(title) == KNOWLEDGE_NOTE_TITLE_MAX_CODEPOINTS

    def test_falls_back_when_there_is_no_usable_line(self) -> None:
        assert derive_title("   \n\t\n") == DEFAULT_NOTE_TITLE


class TestSaveFromSource:
    def save(self, service: KnowledgeNoteService, *, note_id: str, source_id: str | None, **kw):
        return service.save_from_source(
            note_id=note_id,
            book_id="book-1",
            source_kind=kw.pop("source_kind", KnowledgeNoteSource.CHAT_MESSAGE),
            source_id=source_id,
            body=kw.pop("body", "可见性原则\n作者认为可见性决定心智模型。"),
            now=FIXED_NOW,
            **kw,
        )

    def test_creates_a_note_and_derives_its_title(self, service) -> None:
        saved = self.save(service, note_id="note-1", source_id="message-1")
        assert saved.created is True
        assert saved.note.title == "可见性原则"
        assert saved.note.source_kind is KnowledgeNoteSource.CHAT_MESSAGE

    def test_repeating_one_message_returns_the_same_note(self, service) -> None:
        first = self.save(service, note_id="note-1", source_id="message-1")
        second = self.save(service, note_id="note-2", source_id="message-1")
        assert second.created is False
        assert second.note.id == first.note.id
        assert service.count_for_book("book-1") == 1

    def test_a_repeat_does_not_overwrite_the_stored_body(self, service) -> None:
        self.save(service, note_id="note-1", source_id="message-1")
        second = self.save(service, note_id="note-2", source_id="message-1", body="改写后的正文")
        assert second.note.body.startswith("可见性原则")

    def test_different_messages_create_different_notes(self, service) -> None:
        self.save(service, note_id="note-1", source_id="message-1")
        self.save(service, note_id="note-2", source_id="message-2")
        assert service.count_for_book("book-1") == 2

    def test_manual_notes_are_never_deduplicated(self, service) -> None:
        for index in (1, 2):
            service.save_from_source(
                note_id=f"note-{index}",
                book_id="book-1",
                source_kind=KnowledgeNoteSource.MANUAL,
                source_id=None,
                body="手写想法",
                now=FIXED_NOW,
            )
        assert service.count_for_book("book-1") == 2

    def test_an_explicit_title_wins_over_derivation(self, service) -> None:
        saved = self.save(service, note_id="note-1", source_id="message-1", title="  我的标题 ")
        assert saved.note.title == "我的标题"

    @pytest.mark.parametrize("body", [None, "", "   \n\t "])
    def test_empty_content_is_refused(self, service, body) -> None:
        with pytest.raises(EmptyNoteBodyError):
            self.save(service, note_id="note-1", source_id="message-1", body=body)

    def test_an_oversized_body_is_truncated_rather_than_rejected(self, service) -> None:
        saved = self.save(
            service,
            note_id="note-1",
            source_id="message-1",
            body="标题\n" + "a" * (KNOWLEDGE_NOTE_BODY_MAX_CODEPOINTS + 100),
        )
        assert len(saved.note.body) == KNOWLEDGE_NOTE_BODY_MAX_CODEPOINTS

    def test_an_unknown_book_is_refused(self, service) -> None:
        with pytest.raises(KeyError, match="Unknown Book"):
            service.save_from_source(
                note_id="note-1",
                book_id="missing-book",
                source_kind=KnowledgeNoteSource.CHAT_MESSAGE,
                source_id="message-1",
                body="正文",
                now=FIXED_NOW,
            )


class TestListing:
    def test_lists_newest_first_and_pages_deterministically(self, service) -> None:
        for index in range(5):
            service.save_from_source(
                note_id=f"note-{index}",
                book_id="book-1",
                source_kind=KnowledgeNoteSource.CHAT_MESSAGE,
                source_id=f"message-{index}",
                body=f"第 {index} 条",
                now=FIXED_NOW + timedelta(minutes=index),
            )
        first_page = service.list_for_book("book-1", limit=2)
        assert [note.id for note in first_page] == ["note-4", "note-3"]
        cursor = first_page[-1]
        second_page = service.list_for_book(
            "book-1",
            limit=2,
            before_created_at=cursor.created_at,
            before_id=cursor.id,
        )
        assert [note.id for note in second_page] == ["note-2", "note-1"]

    def test_get_returns_none_for_an_unknown_note(self, service) -> None:
        assert service.get("missing") is None

    def test_rejects_a_non_positive_limit(self, service) -> None:
        with pytest.raises(ValueError, match="limit must be positive"):
            service.list_for_book("book-1", limit=0)
