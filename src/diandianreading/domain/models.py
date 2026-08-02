"""Core provider-neutral domain models."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import UTC, datetime
from enum import StrEnum
from urllib.parse import urlsplit

from diandianreading.domain.errors import InvalidStateTransition


def utc_now() -> datetime:
    """Return an aware UTC timestamp."""

    return datetime.now(UTC)


class BookStatus(StrEnum):
    IMPORTING = "importing"
    READY = "ready"
    READING = "reading"
    COMPLETED = "completed"
    ARCHIVED = "archived"
    FAILED = "failed"


class SourceOrigin(StrEnum):
    LOCAL = "local"
    ZLIBRARY = "zlibrary"


class KnowledgeStatus(StrEnum):
    CREATING = "creating"
    PROCESSING = "processing"
    READY = "ready"
    FAILED = "failed"


class RemoteOperationKind(StrEnum):
    ENSURE_WORKSPACE = "ensure_workspace"
    ADD_SOURCE = "add_source"


class RemoteOperationStatus(StrEnum):
    PENDING = "pending"
    COMPLETED = "completed"
    RECONCILIATION_REQUIRED = "reconciliation_required"


@dataclass(frozen=True, slots=True)
class StorageKey:
    """Opaque application-generated key resolved only by FileStore."""

    value: str

    def __post_init__(self) -> None:
        segments = self.value.split("/")
        if (
            not self.value
            or self.value.startswith("/")
            or "\\" in self.value
            or "://" in self.value
            or any(segment in {"", ".", ".."} for segment in segments)
        ):
            raise ValueError("StorageKey must be a non-empty confined logical key")


@dataclass(frozen=True, slots=True)
class Book:
    id: str
    title: str
    author: str | None
    source_hash: str
    status: BookStatus
    created_at: datetime
    updated_at: datetime

    def __post_init__(self) -> None:
        if not self.title.strip():
            raise ValueError("Book title cannot be empty")
        if not self.source_hash.strip():
            raise ValueError("Book source_hash cannot be empty")


@dataclass(frozen=True, slots=True)
class DocumentAsset:
    id: str
    storage_key: StorageKey
    display_filename: str
    mime_type: str
    size_bytes: int
    sha256: str
    title: str | None
    author: str | None
    origin: SourceOrigin
    origin_locator: str | None
    rights_provenance_id: str

    def __post_init__(self) -> None:
        if self.size_bytes < 0:
            raise ValueError("DocumentAsset size_bytes cannot be negative")
        if not self.sha256:
            raise ValueError("DocumentAsset sha256 cannot be empty")
        if not self.display_filename.strip():
            raise ValueError("DocumentAsset display_filename cannot be empty")
        if not self.rights_provenance_id.strip():
            raise ValueError("DocumentAsset rights_provenance_id cannot be empty")
        if self.origin_locator is not None:
            parsed = urlsplit(self.origin_locator)
            if parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise ValueError(
                    "DocumentAsset origin_locator must be canonical and contain no credentials, "
                    "query, or fragment"
                )


@dataclass(frozen=True, slots=True)
class DocumentPart:
    id: str
    asset_id: str
    sequence: int
    storage_key: StorageKey
    mime_type: str
    word_count: int
    sha256: str
    chapter_refs: tuple[str, ...]

    def __post_init__(self) -> None:
        if self.sequence < 0:
            raise ValueError("DocumentPart sequence cannot be negative")
        if self.word_count < 0:
            raise ValueError("DocumentPart word_count cannot be negative")
        if not self.sha256:
            raise ValueError("DocumentPart sha256 cannot be empty")


@dataclass(frozen=True, slots=True)
class CredentialRef:
    """Opaque provider/profile reference; infrastructure resolves physical storage."""

    provider: str
    profile: str

    def __post_init__(self) -> None:
        if not self.provider or not self.profile:
            raise ValueError("CredentialRef provider and profile are required")
        if any(character in self.profile for character in ("/", "\\", "..")):
            raise ValueError("CredentialRef profile must be an opaque profile name")


@dataclass(frozen=True, slots=True)
class TargetCapabilities:
    max_source_words: int
    max_source_bytes: int
    max_sources_per_workspace: int
    accepted_mime_types: frozenset[str]

    def __post_init__(self) -> None:
        limits = (
            self.max_source_words,
            self.max_source_bytes,
            self.max_sources_per_workspace,
        )
        if any(limit <= 0 for limit in limits):
            raise ValueError("Target capability limits must be positive")
        if not self.accepted_mime_types:
            raise ValueError("At least one accepted MIME type is required")


@dataclass(frozen=True, slots=True)
class ProgressEvent:
    job_id: str
    step: str
    current: int | None
    total: int | None
    message: str


@dataclass(frozen=True, slots=True)
class WorkspaceRef:
    id: str
    provider: str
    external_id: str
    status: KnowledgeStatus


@dataclass(frozen=True, slots=True)
class KnowledgeSourceRef:
    id: str
    workspace_id: str
    document_part_id: str
    external_id: str
    checksum: str
    status: KnowledgeStatus


@dataclass(frozen=True, slots=True)
class ExternalWorkspace:
    id: str
    book_id: str
    provider: str
    credential_profile: str
    external_id: str
    status: KnowledgeStatus
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class ExternalSource:
    id: str
    workspace_id: str
    document_part_id: str
    external_id: str
    checksum: str
    status: KnowledgeStatus
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class RemoteOperation:
    id: str
    job_id: str
    kind: RemoteOperationKind
    idempotency_key: str
    local_resource_id: str
    input_hash: str
    status: RemoteOperationStatus
    external_id: str | None
    created_at: datetime
    updated_at: datetime
    version: int

    def complete(self, external_id: str, *, now: datetime | None = None) -> RemoteOperation:
        if self.status is not RemoteOperationStatus.PENDING:
            raise InvalidStateTransition(
                f"Remote operation {self.id} cannot complete from {self.status.value}"
            )
        if not external_id:
            raise ValueError("Remote operation external_id cannot be empty")
        return replace(
            self,
            status=RemoteOperationStatus.COMPLETED,
            external_id=external_id,
            updated_at=now or utc_now(),
            version=self.version + 1,
        )


@dataclass(frozen=True, slots=True)
class RemoteOperationRef:
    id: str
    idempotency_key: str
    kind: RemoteOperationKind
    local_resource_id: str
    input_hash: str
    external_id: str | None
