"""Read-only application service for the local book catalog."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import final

from diandianreading.application.ports.repositories import UnitOfWorkFactory
from diandianreading.domain import Book, BookStatus, DiandianError, ErrorCode

_MAX_BOOK_PAGE = 100


@dataclass(frozen=True, slots=True)
class BookCursor:
    created_at: datetime
    id: str

    def __post_init__(self) -> None:
        if not self.id.strip():
            raise ValueError("Book cursor ID cannot be empty")


@dataclass(frozen=True, slots=True)
class BookQuery:
    limit: int = 50
    before: BookCursor | None = None

    def __post_init__(self) -> None:
        if self.limit < 1 or self.limit > _MAX_BOOK_PAGE:
            raise ValueError(f"Book page limit must be between 1 and {_MAX_BOOK_PAGE}")


@dataclass(frozen=True, slots=True)
class BookView:
    id: str
    title: str
    author: str | None
    status: BookStatus
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_book(cls, book: Book) -> BookView:
        return cls(
            id=book.id,
            title=book.title,
            author=book.author,
            status=book.status,
            created_at=book.created_at,
            updated_at=book.updated_at,
        )


@dataclass(frozen=True, slots=True)
class BookPage:
    items: tuple[BookView, ...]
    next_cursor: BookCursor | None

    @property
    def books(self) -> tuple[BookView, ...]:
        return self.items


class BookNotFoundError(DiandianError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.VALIDATION, "Book was not found", retryable=False)


@final
class CatalogService:
    def __init__(self, *, unit_of_work: UnitOfWorkFactory) -> None:
        self._unit_of_work = unit_of_work

    def list(self, query: BookQuery | None = None) -> BookPage:
        effective = query or BookQuery()
        before_created_at = effective.before.created_at if effective.before else None
        before_id = effective.before.id if effective.before else None
        with self._unit_of_work() as unit_of_work:
            books = tuple(
                unit_of_work.catalog.list_books(
                    effective.limit,
                    before_created_at,
                    before_id,
                )
            )
            unit_of_work.commit()

        next_cursor: BookCursor | None = None
        if len(books) == effective.limit:
            last = books[-1]
            with self._unit_of_work() as unit_of_work:
                following = unit_of_work.catalog.list_books(1, last.created_at, last.id)
                unit_of_work.commit()
            if following:
                next_cursor = BookCursor(last.created_at, last.id)
        return BookPage(
            items=tuple(BookView.from_book(book) for book in books),
            next_cursor=next_cursor,
        )

    def get(self, book_id: str) -> BookView:
        if not book_id.strip():
            raise BookNotFoundError()
        with self._unit_of_work() as unit_of_work:
            book = unit_of_work.catalog.get_book(book_id)
            unit_of_work.commit()
        if book is None:
            raise BookNotFoundError()
        return BookView.from_book(book)
