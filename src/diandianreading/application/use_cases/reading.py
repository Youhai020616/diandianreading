"""Read-side application service for the reader: detail, content, and progress.

The reading surface per book is a single canonical document (ADR-0007):
the derived whole-book markdown for EPUB and Markdown sources, or the
original bytes for PDF. Markdown books imported before the reader existed
have no stored derived asset yet, so this service materializes it lazily;
the operation is idempotent because keys and identifiers are content-addressed.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from io import BytesIO
from pathlib import PurePosixPath
from typing import final
from uuid import NAMESPACE_URL, uuid5

from diandianreading.application.ports.annotations import ReadingProgressRepository
from diandianreading.application.ports.reading import (
    ChapterSpanView,
    ReadingDocumentProcessor,
)
from diandianreading.application.ports.repositories import UnitOfWorkFactory
from diandianreading.application.ports.storage import FileStore
from diandianreading.application.use_cases.catalog import BookNotFoundError, BookView
from diandianreading.domain import (
    Book,
    BookStatus,
    DiandianError,
    DocumentAsset,
    ErrorCode,
    StorageKey,
    utc_now,
)
from diandianreading.domain.annotations import ContentAnchor, ReadingProgress
from diandianreading.domain.chat import ChatReferenceLocationType

_MARKDOWN_MIME = "text/markdown"
_PDF_MIME = "application/pdf"
_READ_CHUNK = 1024 * 1024
_READABLE_STATUSES = frozenset({BookStatus.READY, BookStatus.READING, BookStatus.COMPLETED})


class ReadingNotReadyError(DiandianError):
    def __init__(self) -> None:
        super().__init__(
            ErrorCode.VALIDATION,
            "Book content is not ready for reading",
            retryable=False,
        )


class StaleAnchorError(DiandianError):
    def __init__(self) -> None:
        super().__init__(
            ErrorCode.REPOSITORY_CONFLICT,
            "Anchor does not reference the current reading document",
            retryable=False,
        )


@dataclass(frozen=True, slots=True)
class ReadingDocumentView:
    book_id: str
    anchor_sha256: str
    mime_type: str
    size_bytes: int


@dataclass(frozen=True, slots=True)
class ReadingContent:
    document: ReadingDocumentView
    payload: bytes


@dataclass(frozen=True, slots=True)
class BookDetailView:
    book: BookView
    document: ReadingDocumentView
    chapters: tuple[ChapterSpanView, ...]
    progress: ReadingProgress | None


@final
class ReadingService:
    def __init__(
        self,
        *,
        unit_of_work: UnitOfWorkFactory,
        file_store: FileStore,
        processor: ReadingDocumentProcessor,
        progress: ReadingProgressRepository,
    ) -> None:
        self._unit_of_work = unit_of_work
        self._file_store = file_store
        self._processor = processor
        self._progress = progress

    def get_detail(self, book_id: str) -> BookDetailView:
        book, asset, payload = self._resolve(book_id)
        chapters: tuple[ChapterSpanView, ...] = ()
        if asset.mime_type == _MARKDOWN_MIME:
            chapters = self._processor.chapter_spans(payload.decode("utf-8"))
        return BookDetailView(
            book=BookView.from_book(book),
            document=_document_view(book.id, asset),
            chapters=chapters,
            progress=self._progress.get(book.id),
        )

    def get_content(self, book_id: str) -> ReadingContent:
        book, asset, payload = self._resolve(book_id)
        return ReadingContent(document=_document_view(book.id, asset), payload=payload)

    def get_document(self, book_id: str) -> ReadingDocumentView:
        book, asset, _ = self._resolve(book_id)
        return _document_view(book.id, asset)

    def save_progress(
        self,
        book_id: str,
        anchor: ContentAnchor,
        percent: float,
    ) -> ReadingProgress:
        book, asset, _ = self._resolve(book_id)
        expected_type = (
            ChatReferenceLocationType.PDF_PAGE
            if asset.mime_type == _PDF_MIME
            else ChatReferenceLocationType.MARKDOWN_OFFSET
        )
        if anchor.type is not expected_type or anchor.anchor_sha256 != asset.sha256:
            raise StaleAnchorError()
        previous = self._progress.get(book.id)
        current = (
            previous.advance(anchor, percent)
            if previous is not None
            else ReadingProgress(
                book_id=book.id,
                anchor=anchor,
                percent=percent,
                updated_at=utc_now(),
                version=0,
            )
        )
        self._progress.save(previous, current)
        return current

    def _resolve(self, book_id: str) -> tuple[Book, DocumentAsset, bytes]:
        if not book_id.strip():
            raise BookNotFoundError()
        with self._unit_of_work() as unit_of_work:
            book = unit_of_work.catalog.get_book(book_id)
            assets = tuple(unit_of_work.catalog.list_assets(book_id)) if book is not None else ()
            unit_of_work.commit()
        if book is None:
            raise BookNotFoundError()
        if book.status not in _READABLE_STATUSES:
            raise ReadingNotReadyError()

        roots = tuple(asset for asset in assets if asset.derived_from_asset_id is None)
        if len(roots) != 1:
            raise DiandianError(
                ErrorCode.UNEXPECTED,
                "Book does not have exactly one root document",
                retryable=False,
            )
        root = roots[0]
        if root.mime_type == _PDF_MIME:
            return book, root, self._read_verified(root)

        derived = _derived_markdown(assets, root)
        if derived is not None:
            return book, derived, self._read_verified(derived)
        if root.mime_type != _MARKDOWN_MIME:
            raise DiandianError(
                ErrorCode.SOURCE_UNAVAILABLE,
                "Book is missing its derived reading document",
                retryable=False,
            )
        return self._materialize_markdown(book, root)

    def _materialize_markdown(
        self,
        book: Book,
        root: DocumentAsset,
    ) -> tuple[Book, DocumentAsset, bytes]:
        raw = self._read_verified(root)
        normalized = self._processor.normalize(raw)
        content = normalized.encode("utf-8")
        sha256 = hashlib.sha256(content).hexdigest()
        if sha256 == root.sha256:
            # The original is already in canonical form; the root itself is the
            # reading document and no derived asset is needed.
            return book, root, content
        key = StorageKey(f"derived/{root.id}/{sha256}.md")
        stored = self._file_store.put(key, BytesIO(content))
        stem = PurePosixPath(root.display_filename).stem or "book"
        derived = DocumentAsset(
            id=str(uuid5(NAMESPACE_URL, f"derived-markdown:{root.id}:{sha256}")),
            storage_key=stored.key,
            display_filename=f"{stem}.md",
            mime_type=_MARKDOWN_MIME,
            size_bytes=stored.size_bytes,
            sha256=stored.sha256,
            title=root.title,
            author=root.author,
            origin=root.origin,
            origin_locator=root.origin_locator,
            rights_provenance_id=root.rights_provenance_id,
            derived_from_asset_id=root.id,
        )
        with self._unit_of_work() as unit_of_work:
            existing = _derived_markdown(tuple(unit_of_work.catalog.list_assets(book.id)), root)
            if existing is None:
                unit_of_work.catalog.add_asset(book.id, derived)
            unit_of_work.commit()
        if existing is not None:
            return book, existing, self._read_verified(existing)
        return book, derived, content

    def _read_verified(self, asset: DocumentAsset) -> bytes:
        digest = hashlib.sha256()
        payload = bytearray()
        with self._file_store.open(asset.storage_key) as source:
            while True:
                chunk = source.read(_READ_CHUNK)
                if not chunk:
                    break
                payload.extend(chunk)
                digest.update(chunk)
        if len(payload) != asset.size_bytes or digest.hexdigest() != asset.sha256:
            raise DiandianError(
                ErrorCode.SOURCE_UNAVAILABLE,
                "Stored document no longer matches its recorded checksum",
                retryable=False,
            )
        return bytes(payload)


def _document_view(book_id: str, asset: DocumentAsset) -> ReadingDocumentView:
    return ReadingDocumentView(
        book_id=book_id,
        anchor_sha256=asset.sha256,
        mime_type=asset.mime_type,
        size_bytes=asset.size_bytes,
    )


def _derived_markdown(
    assets: tuple[DocumentAsset, ...],
    root: DocumentAsset,
) -> DocumentAsset | None:
    candidates = tuple(
        asset
        for asset in assets
        if asset.derived_from_asset_id == root.id and asset.mime_type == _MARKDOWN_MIME
    )
    if len(candidates) > 1:
        raise DiandianError(
            ErrorCode.UNEXPECTED,
            "Book has more than one derived reading document",
            retryable=False,
        )
    return candidates[0] if candidates else None
