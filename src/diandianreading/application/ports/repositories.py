"""Persistence Ports owned by the application layer."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import Protocol, Self

from diandianreading.domain import (
    Book,
    DocumentAsset,
    DocumentPart,
    ExternalSource,
    ExternalWorkspace,
    Job,
    JobEvent,
    JobPayload,
    JobStatus,
    JobStep,
    JobStepRecord,
    LeaseToken,
    PreparationManifest,
    RemoteOperation,
    RightsProvenance,
    RightsProvenanceEvent,
)


class CatalogRepository(Protocol):
    def add_book(self, book: Book) -> None: ...

    def update_book(self, book: Book) -> None: ...

    def get_book(self, book_id: str) -> Book | None: ...

    def get_book_by_source_hash(self, source_hash: str) -> Book | None: ...

    def list_books(
        self,
        limit: int,
        before_created_at: datetime | None = None,
        before_id: str | None = None,
    ) -> Sequence[Book]: ...

    def add_asset(self, book_id: str, asset: DocumentAsset) -> None: ...

    def list_assets(self, book_id: str) -> Sequence[DocumentAsset]: ...

    def add_part(self, part: DocumentPart) -> None: ...

    def list_parts(self, book_id: str) -> Sequence[DocumentPart]: ...

    def add_manifest(self, book_id: str, manifest: PreparationManifest) -> None: ...

    def get_manifest(self, root_asset_id: str) -> PreparationManifest | None: ...


class JobRepository(Protocol):
    def add(self, job: Job) -> None: ...

    def save_transition(self, previous: Job, current: Job) -> None: ...

    def claim(
        self,
        job_id: str,
        owner: str,
        *,
        lease_expires_at: datetime,
        now: datetime,
    ) -> Job: ...

    def claim_next(
        self,
        owner: str,
        *,
        lease_expires_at: datetime,
        now: datetime,
    ) -> Job | None: ...

    def heartbeat(
        self,
        job_id: str,
        token: LeaseToken,
        *,
        lease_expires_at: datetime,
        now: datetime,
    ) -> Job: ...

    def request_cancel(self, job_id: str, *, now: datetime) -> Job: ...

    def assert_lease(self, job_id: str, token: LeaseToken) -> None: ...

    def get(self, job_id: str) -> Job | None: ...

    def list_recent(
        self,
        status: JobStatus | None,
        limit: int,
        before_created_at: datetime | None = None,
        before_id: str | None = None,
    ) -> Sequence[Job]: ...

    def list_events(self, job_id: str) -> Sequence[JobEvent]: ...


class JobStepRepository(Protocol):
    def add(self, step: JobStepRecord, token: LeaseToken) -> None: ...

    def save(self, previous: JobStepRecord, current: JobStepRecord, token: LeaseToken) -> None: ...

    def get(self, job_id: str, step: JobStep, attempt: int) -> JobStepRecord | None: ...

    def latest(self, job_id: str, step: JobStep) -> JobStepRecord | None: ...

    def list(self, job_id: str) -> Sequence[JobStepRecord]: ...


class JobPayloadRepository(Protocol):
    def add(self, payload: JobPayload) -> None: ...

    def get(self, job_id: str) -> JobPayload | None: ...


class KnowledgeMappingRepository(Protocol):
    def save_workspace(self, workspace: ExternalWorkspace) -> None: ...

    def get_workspace(self, workspace_id: str) -> ExternalWorkspace | None: ...

    def get_workspace_for_book(self, book_id: str) -> ExternalWorkspace | None: ...

    def save_source(self, source: ExternalSource) -> None: ...

    def list_sources(self, workspace_id: str) -> Sequence[ExternalSource]: ...


class RightsProvenanceRepository(Protocol):
    def add(self, provenance: RightsProvenance) -> None: ...

    def save(self, previous: RightsProvenance, current: RightsProvenance) -> None: ...

    def get(self, provenance_id: str) -> RightsProvenance | None: ...

    def list_events(self, provenance_id: str) -> Sequence[RightsProvenanceEvent]: ...


class RemoteOperationRepository(Protocol):
    def add(self, operation: RemoteOperation, token: LeaseToken | None = None) -> None: ...

    def save(
        self,
        previous: RemoteOperation,
        current: RemoteOperation,
        token: LeaseToken | None = None,
    ) -> None: ...

    def get_by_idempotency_key(self, idempotency_key: str) -> RemoteOperation | None: ...

    def list_for_job(self, job_id: str) -> Sequence[RemoteOperation]: ...


class UnitOfWork(Protocol):
    catalog: CatalogRepository
    jobs: JobRepository
    job_steps: JobStepRepository
    job_payloads: JobPayloadRepository
    mappings: KnowledgeMappingRepository
    rights: RightsProvenanceRepository
    operations: RemoteOperationRepository

    def __enter__(self) -> Self: ...

    def commit(self) -> None: ...

    def rollback(self) -> None: ...

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> None: ...


class UnitOfWorkFactory(Protocol):
    def __call__(self) -> UnitOfWork: ...
