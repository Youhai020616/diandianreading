from __future__ import annotations

import hashlib
from io import BytesIO
from pathlib import Path

import pytest

from diandianreading.application.use_cases.catalog import BookNotFoundError
from diandianreading.application.use_cases.reading import (
    ReadingNotReadyError,
    ReadingService,
    StaleAnchorError,
)
from diandianreading.domain import (
    Book,
    BookStatus,
    DiandianError,
    DocumentAsset,
    ErrorCode,
    RepositoryConflict,
    SourceOrigin,
    StorageKey,
)
from diandianreading.domain.annotations import ContentAnchor, ReadingProgress
from diandianreading.domain.chat import ChatReferenceLocationType
from diandianreading.infrastructure.documents import PolicyReadingDocumentProcessor
from diandianreading.infrastructure.persistence import (
    SQLiteDatabase,
    SQLiteUnitOfWorkFactory,
)
from diandianreading.infrastructure.persistence.reading import (
    SQLiteReadingProgressRepository,
)
from diandianreading.infrastructure.storage import LocalFileStore
from tests.support import FIXED_NOW

MARKDOWN_RAW = b"Preamble first.\r\n\r\n# One   \r\n\r\nBody one.\r\n\r\n# Two\r\n\r\nBody two.\r\n"
PDF_RAW = b"%PDF-1.7 fixture body\n%%EOF\n"


class Env:
    def __init__(self, tmp_path: Path) -> None:
        self.database = SQLiteDatabase(tmp_path / "state" / "app.sqlite3")
        assert self.database.migrate() == 10
        self.unit_of_work = SQLiteUnitOfWorkFactory(self.database)
        self.store = LocalFileStore(tmp_path / "objects")
        self.progress = SQLiteReadingProgressRepository(self.database)
        self.service = ReadingService(
            unit_of_work=self.unit_of_work,
            file_store=self.store,
            processor=PolicyReadingDocumentProcessor(),
            progress=self.progress,
        )

    def add_book(
        self,
        *,
        book_id: str,
        mime_type: str,
        content: bytes,
        status: BookStatus = BookStatus.READY,
        derived_markdown: bytes | None = None,
    ) -> tuple[Book, DocumentAsset]:
        sha256 = hashlib.sha256(content).hexdigest()
        stored = self.store.put(StorageKey(f"originals/{sha256}"), BytesIO(content))
        root = DocumentAsset(
            id=f"{book_id}-root",
            storage_key=stored.key,
            display_filename=f"{book_id}.bin",
            mime_type=mime_type,
            size_bytes=stored.size_bytes,
            sha256=stored.sha256,
            title=None,
            author=None,
            origin=SourceOrigin.LOCAL,
            origin_locator=None,
            rights_provenance_id="rights-local",
        )
        book = Book(
            id=book_id,
            title=f"Book {book_id}",
            author=None,
            source_hash=stored.sha256,
            status=status,
            created_at=FIXED_NOW,
            updated_at=FIXED_NOW,
        )
        with self.unit_of_work() as unit_of_work:
            unit_of_work.catalog.add_book(book)
            unit_of_work.catalog.add_asset(book.id, root)
            if derived_markdown is not None:
                derived_sha = hashlib.sha256(derived_markdown).hexdigest()
                derived_stored = self.store.put(
                    StorageKey(f"derived/{root.id}/{derived_sha}.md"),
                    BytesIO(derived_markdown),
                )
                unit_of_work.catalog.add_asset(
                    book.id,
                    DocumentAsset(
                        id=f"{book_id}-derived",
                        storage_key=derived_stored.key,
                        display_filename=f"{book_id}.md",
                        mime_type="text/markdown",
                        size_bytes=derived_stored.size_bytes,
                        sha256=derived_stored.sha256,
                        title=None,
                        author=None,
                        origin=SourceOrigin.LOCAL,
                        origin_locator=None,
                        rights_provenance_id="rights-local",
                        derived_from_asset_id=root.id,
                    ),
                )
            unit_of_work.commit()
        return book, root

    def asset_count(self, book_id: str) -> int:
        with self.unit_of_work() as unit_of_work:
            count = len(tuple(unit_of_work.catalog.list_assets(book_id)))
            unit_of_work.commit()
        return count


def markdown_anchor(sha256: str, *, start: int = 0) -> ContentAnchor:
    return ContentAnchor(
        type=ChatReferenceLocationType.MARKDOWN_OFFSET,
        anchor_sha256=sha256,
        start=start,
        end=start,
    )


class TestMarkdownReading:
    def test_detail_materializes_normalized_derived_asset_lazily(self, tmp_path) -> None:
        env = Env(tmp_path)
        env.add_book(book_id="md-1", mime_type="text/markdown", content=MARKDOWN_RAW)

        detail = env.service.get_detail("md-1")
        assert detail.document.mime_type == "text/markdown"
        assert detail.progress is None
        assert [chapter.reference for chapter in detail.chapters] == [
            "markdown-preamble",
            "markdown-heading-0001",
            "markdown-heading-0002",
        ]
        assert [chapter.title for chapter in detail.chapters] == ["", "One", "Two"]
        assert env.asset_count("md-1") == 2

        repeated = env.service.get_detail("md-1")
        assert repeated.document.anchor_sha256 == detail.document.anchor_sha256
        assert env.asset_count("md-1") == 2

    def test_content_is_normalized_and_checksummed(self, tmp_path) -> None:
        env = Env(tmp_path)
        env.add_book(book_id="md-2", mime_type="text/markdown", content=MARKDOWN_RAW)

        content = env.service.get_content("md-2")
        text = content.payload.decode("utf-8")
        assert "\r" not in text
        assert text.startswith("Preamble first.")
        assert hashlib.sha256(content.payload).hexdigest() == content.document.anchor_sha256
        spans = env.service.get_detail("md-2").chapters
        assert spans[0].start == 0
        assert spans[-1].end == len(text)
        assert text[spans[1].start : spans[1].end].startswith("# One")

    def test_tampered_object_is_rejected(self, tmp_path) -> None:
        env = Env(tmp_path)
        env.add_book(book_id="md-3", mime_type="text/markdown", content=MARKDOWN_RAW)
        content = env.service.get_content("md-3")
        derived_key = StorageKey(f"derived/md-3-root/{content.document.anchor_sha256}.md")
        env.store.resolve_for_read(derived_key).write_bytes(b"# tampered\n")
        with pytest.raises(DiandianError) as excinfo:
            env.service.get_content("md-3")
        assert excinfo.value.code is ErrorCode.SOURCE_UNAVAILABLE


class TestEpubAndPdfReading:
    def test_epub_uses_stored_derived_markdown(self, tmp_path) -> None:
        env = Env(tmp_path)
        derived = b"# Epub Chapter\n\nDerived body.\n"
        env.add_book(
            book_id="epub-1",
            mime_type="application/epub+zip",
            content=b"PK-epub-container-bytes",
            derived_markdown=derived,
        )
        content = env.service.get_content("epub-1")
        assert content.payload == derived
        assert content.document.mime_type == "text/markdown"

    def test_epub_without_derived_is_unavailable(self, tmp_path) -> None:
        env = Env(tmp_path)
        env.add_book(
            book_id="epub-2",
            mime_type="application/epub+zip",
            content=b"PK-epub-container-bytes",
        )
        with pytest.raises(DiandianError) as excinfo:
            env.service.get_detail("epub-2")
        assert excinfo.value.code is ErrorCode.SOURCE_UNAVAILABLE

    def test_pdf_serves_original_bytes_without_chapters(self, tmp_path) -> None:
        env = Env(tmp_path)
        _, root = env.add_book(book_id="pdf-1", mime_type="application/pdf", content=PDF_RAW)
        detail = env.service.get_detail("pdf-1")
        assert detail.chapters == ()
        assert detail.document.anchor_sha256 == root.sha256
        content = env.service.get_content("pdf-1")
        assert content.payload == PDF_RAW
        assert content.document.mime_type == "application/pdf"
        assert env.asset_count("pdf-1") == 1


class TestReadingGuards:
    def test_unknown_book_is_not_found(self, tmp_path) -> None:
        env = Env(tmp_path)
        with pytest.raises(BookNotFoundError):
            env.service.get_detail("missing")

    def test_importing_book_is_not_ready(self, tmp_path) -> None:
        env = Env(tmp_path)
        env.add_book(
            book_id="md-4",
            mime_type="text/markdown",
            content=MARKDOWN_RAW,
            status=BookStatus.IMPORTING,
        )
        with pytest.raises(ReadingNotReadyError):
            env.service.get_content("md-4")


class TestReadingProgress:
    def test_progress_roundtrip_and_advance(self, tmp_path) -> None:
        env = Env(tmp_path)
        env.add_book(book_id="md-5", mime_type="text/markdown", content=MARKDOWN_RAW)
        sha256 = env.service.get_content("md-5").document.anchor_sha256

        first = env.service.save_progress("md-5", markdown_anchor(sha256), 0.25)
        assert first.version == 0
        second = env.service.save_progress("md-5", markdown_anchor(sha256, start=10), 0.5)
        assert second.version == 1
        stored = env.progress.get("md-5")
        assert stored is not None
        assert stored.percent == 0.5
        assert stored.anchor.start == 10

    def test_progress_rejects_stale_or_mismatched_anchor(self, tmp_path) -> None:
        env = Env(tmp_path)
        env.add_book(book_id="md-6", mime_type="text/markdown", content=MARKDOWN_RAW)
        with pytest.raises(StaleAnchorError):
            env.service.save_progress("md-6", markdown_anchor("0" * 64), 0.5)

        _, pdf_root = env.add_book(book_id="pdf-2", mime_type="application/pdf", content=PDF_RAW)
        with pytest.raises(StaleAnchorError):
            env.service.save_progress("pdf-2", markdown_anchor(pdf_root.sha256), 0.5)

    def test_repository_conflicts_on_concurrent_writers(self, tmp_path) -> None:
        env = Env(tmp_path)
        env.add_book(book_id="md-7", mime_type="text/markdown", content=MARKDOWN_RAW)
        sha256 = env.service.get_content("md-7").document.anchor_sha256
        current = env.service.save_progress("md-7", markdown_anchor(sha256), 0.2)

        duplicate = ReadingProgress(
            book_id="md-7",
            anchor=markdown_anchor(sha256),
            percent=0.3,
            updated_at=FIXED_NOW,
            version=0,
        )
        with pytest.raises(RepositoryConflict):
            env.progress.save(None, duplicate)

        stale_previous = current.advance(markdown_anchor(sha256), 0.9)
        with pytest.raises(RepositoryConflict):
            env.progress.save(stale_previous, stale_previous.advance(markdown_anchor(sha256), 0.95))
