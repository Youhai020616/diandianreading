from __future__ import annotations

from dataclasses import asdict
from datetime import timedelta
from typing import cast

import pytest

from diandianreading.application.ports.repositories import UnitOfWorkFactory
from diandianreading.application.use_cases.catalog import (
    BookCursor,
    BookNotFoundError,
    BookQuery,
    CatalogService,
)
from diandianreading.domain import Book, BookStatus, ErrorCode, TargetCapabilities
from diandianreading.interfaces.runtime import (
    ApplicationPaths,
    RuntimeConfig,
    notebooklm_credential,
    zlibrary_credential,
)
from tests.support import FIXED_NOW


class FakeCatalogRepository:
    def __init__(self, *books: Book) -> None:
        self.values = {book.id: book for book in books}
        self.list_calls: list[tuple[int, object, object]] = []

    def get_book(self, book_id: str) -> Book | None:
        return self.values.get(book_id)

    def list_books(
        self,
        limit: int,
        before_created_at=None,
        before_id=None,
    ) -> tuple[Book, ...]:
        self.list_calls.append((limit, before_created_at, before_id))
        values = sorted(
            self.values.values(),
            key=lambda book: (book.created_at, book.id),
            reverse=True,
        )
        if before_created_at is not None and before_id is not None:
            values = [
                book
                for book in values
                if (book.created_at, book.id) < (before_created_at, before_id)
            ]
        return tuple(values[:limit])


class FakeCatalogUnitOfWork:
    def __init__(self, factory: FakeCatalogFactory) -> None:
        self.catalog = factory.repository
        self._factory = factory

    def __enter__(self):
        self._factory.open_count += 1
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        del exc_type, exc_value, traceback

    def commit(self) -> None:
        self._factory.commit_count += 1


class FakeCatalogFactory:
    def __init__(self, repository: FakeCatalogRepository) -> None:
        self.repository = repository
        self.open_count = 0
        self.commit_count = 0

    def __call__(self) -> FakeCatalogUnitOfWork:
        return FakeCatalogUnitOfWork(self)


def make_book(book_id: str, *, seconds: int = 0) -> Book:
    timestamp = FIXED_NOW + timedelta(seconds=seconds)
    return Book(
        id=book_id,
        title=f"Title {book_id}",
        author=f"Author {book_id}",
        source_hash=f"secret-source-{book_id}",
        status=BookStatus.READY,
        created_at=timestamp,
        updated_at=timestamp,
    )


def test_application_paths_default_uses_configured_home_and_derives_locations(
    tmp_path,
    monkeypatch,
) -> None:
    configured_home = tmp_path / "configured-home"
    monkeypatch.setenv("DIANDIAN_HOME", str(configured_home))

    paths = ApplicationPaths.default()

    assert paths.home == configured_home
    assert paths.database == configured_home / "state" / "app.sqlite3"
    assert paths.object_root == configured_home / "objects"
    assert paths.credentials_root == configured_home / "credentials"
    assert paths.staging_root == configured_home / "staging"
    assert paths.upload_root == configured_home / "uploads"
    assert notebooklm_credential("reader").provider == "notebooklm"
    assert zlibrary_credential("reader").provider == "zlibrary"


@pytest.mark.parametrize("value", ("1", " true ", "YES", "On"))
def test_runtime_config_accepts_true_environment_flags(value: str, monkeypatch) -> None:
    monkeypatch.setenv("DIANDIAN_ZLIBRARY_ENABLED", value)
    assert RuntimeConfig.from_environment().zlibrary_enabled is True


@pytest.mark.parametrize("value", ("", "   ", "0", "false", "NO", "off"))
def test_runtime_config_accepts_false_or_blank_environment_flags(
    value: str,
    monkeypatch,
) -> None:
    monkeypatch.setenv("DIANDIAN_ZLIBRARY_ENABLED", value)
    assert RuntimeConfig.from_environment().zlibrary_enabled is False


def test_runtime_config_defaults_disabled_and_explicit_override_ignores_environment(
    monkeypatch,
) -> None:
    monkeypatch.delenv("DIANDIAN_ZLIBRARY_ENABLED", raising=False)
    assert RuntimeConfig.from_environment().zlibrary_enabled is False

    monkeypatch.setenv("DIANDIAN_ZLIBRARY_ENABLED", "invalid-but-overridden")
    assert RuntimeConfig.from_environment(zlibrary_enabled=True).zlibrary_enabled is True
    assert RuntimeConfig.from_environment(zlibrary_enabled=False).zlibrary_enabled is False


def test_runtime_config_rejects_invalid_environment_flag(monkeypatch) -> None:
    monkeypatch.setenv("DIANDIAN_ZLIBRARY_ENABLED", "sometimes")
    with pytest.raises(ValueError, match="DIANDIAN_ZLIBRARY_ENABLED must be a boolean flag"):
        RuntimeConfig.from_environment()


@pytest.mark.parametrize("max_document_bytes", (0, -1))
def test_runtime_config_rejects_non_positive_document_limits(max_document_bytes: int) -> None:
    with pytest.raises(ValueError, match="document byte limit must be positive"):
        RuntimeConfig(max_document_bytes=max_document_bytes)


def test_runtime_config_rejects_target_limit_above_local_document_limit() -> None:
    capabilities = TargetCapabilities(
        max_source_words=1,
        max_source_bytes=11,
        max_sources_per_workspace=1,
        accepted_mime_types=frozenset({"text/markdown"}),
    )

    with pytest.raises(ValueError, match="Target source byte limit cannot exceed"):
        RuntimeConfig(max_document_bytes=10, target_capabilities=capabilities)


def test_catalog_lists_with_keyset_pagination_and_lookahead() -> None:
    repository = FakeCatalogRepository(
        make_book("book-a"),
        make_book("book-b", seconds=1),
        make_book("book-c", seconds=2),
    )
    factory = FakeCatalogFactory(repository)
    service = CatalogService(
        unit_of_work=cast(UnitOfWorkFactory, cast(object, factory)),
    )

    first = service.list(BookQuery(limit=2))

    assert [book.id for book in first.books] == ["book-c", "book-b"]
    assert first.next_cursor == BookCursor(FIXED_NOW + timedelta(seconds=1), "book-b")
    assert set(asdict(first.items[0])) == {
        "id",
        "title",
        "author",
        "status",
        "created_at",
        "updated_at",
    }
    assert first.next_cursor is not None

    second = service.list(BookQuery(limit=2, before=first.next_cursor))

    assert [book.id for book in second.items] == ["book-a"]
    assert second.next_cursor is None
    assert repository.list_calls == [
        (2, None, None),
        (1, FIXED_NOW + timedelta(seconds=1), "book-b"),
        (2, FIXED_NOW + timedelta(seconds=1), "book-b"),
    ]
    assert factory.open_count == 3
    assert factory.commit_count == 3


def test_catalog_get_and_validation_use_safe_not_found_errors() -> None:
    repository = FakeCatalogRepository(make_book("book-known"))
    service = CatalogService(
        unit_of_work=cast(
            UnitOfWorkFactory,
            cast(object, FakeCatalogFactory(repository)),
        ),
    )

    assert service.get("book-known").title == "Title book-known"

    for book_id in ("", "   ", "book-missing"):
        with pytest.raises(BookNotFoundError, match="Book was not found") as raised:
            service.get(book_id)
        assert raised.value.code is ErrorCode.VALIDATION
        assert raised.value.retryable is False

    with pytest.raises(ValueError, match="Book cursor ID cannot be empty"):
        BookCursor(FIXED_NOW, " ")
    for invalid_limit in (0, 101):
        with pytest.raises(ValueError, match="Book page limit must be between 1 and 100"):
            BookQuery(limit=invalid_limit)
