"""Persistence Ports owned by the application layer."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol, Self

from diandianreading.domain import (
    Book,
    DocumentAsset,
    DocumentPart,
    ExternalSource,
    ExternalWorkspace,
    Job,
    JobEvent,
    RemoteOperation,
)


class CatalogRepository(Protocol):
    def add_book(self, book: Book) -> None: ...

    def update_book(self, book: Book) -> None: ...

    def get_book(self, book_id: str) -> Book | None: ...

    def add_asset(self, book_id: str, asset: DocumentAsset) -> None: ...

    def add_part(self, part: DocumentPart) -> None: ...

    def list_parts(self, book_id: str) -> Sequence[DocumentPart]: ...


class JobRepository(Protocol):
    def add(self, job: Job) -> None: ...

    def save_transition(self, previous: Job, current: Job) -> None: ...

    def get(self, job_id: str) -> Job | None: ...

    def list_events(self, job_id: str) -> Sequence[JobEvent]: ...


class KnowledgeMappingRepository(Protocol):
    def save_workspace(self, workspace: ExternalWorkspace) -> None: ...

    def get_workspace(self, workspace_id: str) -> ExternalWorkspace | None: ...

    def save_source(self, source: ExternalSource) -> None: ...

    def list_sources(self, workspace_id: str) -> Sequence[ExternalSource]: ...


class RemoteOperationRepository(Protocol):
    def add(self, operation: RemoteOperation) -> None: ...

    def save(self, previous: RemoteOperation, current: RemoteOperation) -> None: ...

    def get_by_idempotency_key(self, idempotency_key: str) -> RemoteOperation | None: ...


class UnitOfWork(Protocol):
    catalog: CatalogRepository
    jobs: JobRepository
    mappings: KnowledgeMappingRepository
    operations: RemoteOperationRepository

    def __enter__(self) -> Self: ...

    def commit(self) -> None: ...

    def rollback(self) -> None: ...

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> None: ...


class UnitOfWorkFactory(Protocol):
    def __call__(self) -> UnitOfWork: ...
