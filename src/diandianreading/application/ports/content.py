"""Persistence Ports for knowledge notes and content assets.

Frozen in C0 (ADR-0008). ``KnowledgeNote`` is deliberately *not* the annotation
note from ADR-0007: ``query_scope.note_ids`` in ai-chat.md refers to annotation
identifiers, while these rows are standalone knowledge items.

The idempotency contract is unusual and intentional: ``add_for_source`` returns
the existing row instead of raising when one already exists for the same
``(source_kind, source_id)``. ai-chat.md requires that repeating
``save-as-note`` for one message yields the same note, and the database unique
index is what guarantees it rather than a read-then-write check that could race.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from diandianreading.domain.content import (
    ContentAsset,
    ContentFailureCode,
    ContentLeaseToken,
    ContentRevision,
    ExportTargetKind,
    KnowledgeNote,
    KnowledgeNoteSource,
)


class KnowledgeNoteRepository(Protocol):
    def add_for_source(self, note: KnowledgeNote) -> KnowledgeNote:
        """Insert ``note``, or return the row already bound to its source.

        Manual notes have no source identity and are always inserted.
        """
        ...

    def get(self, note_id: str) -> KnowledgeNote | None: ...

    def find_by_source(
        self, source_kind: KnowledgeNoteSource, source_id: str
    ) -> KnowledgeNote | None: ...

    def list_for_book(
        self,
        book_id: str,
        *,
        limit: int,
        before_created_at: datetime | None = None,
        before_id: str | None = None,
    ) -> Sequence[KnowledgeNote]: ...

    def count_for_book(self, book_id: str) -> int: ...


class ContentAssetRepository(Protocol):
    """Persistence for content assets treated as recoverable task units.

    ADR-0008 section 2b: the same row is both the draft and the durable task, so
    the lease and provider-operation columns live here rather than in a separate
    jobs table whose step vocabulary belongs to document import.
    """

    def create(self, asset: ContentAsset) -> None: ...

    def get(self, content_id: str) -> ContentAsset | None: ...

    def claim_next(
        self, *, worker_id: str, now: datetime, lease_seconds: int
    ) -> tuple[ContentAsset, ContentLeaseToken] | None:
        """Take one claimable asset, fencing out any stale owner."""
        ...

    def cancel_requested(self, content_id: str) -> bool: ...

    def request_cancel(self, content_id: str, *, now: datetime) -> bool: ...

    def bind_provider_operation(
        self, content_id: str, token: ContentLeaseToken, *, operation_id: str, now: datetime
    ) -> None:
        """Record the dispatched remote operation before awaiting its result."""
        ...

    def complete_with_revision(
        self, content_id: str, token: ContentLeaseToken, revision: ContentRevision, *, now: datetime
    ) -> ContentAsset: ...

    def fail(
        self,
        content_id: str,
        token: ContentLeaseToken,
        *,
        code: ContentFailureCode,
        now: datetime,
    ) -> ContentAsset: ...

    def append_human_revision(
        self, content_id: str, revision: ContentRevision, *, now: datetime
    ) -> ContentAsset: ...

    def list_revisions(self, content_id: str) -> Sequence[ContentRevision]: ...

    def list_for_book(self, book_id: str, *, limit: int) -> Sequence[ContentAsset]: ...


@dataclass(frozen=True, slots=True)
class VaultConfig:
    """The single active Obsidian vault."""

    id: str
    name: str
    root_path: str
    version: int


@dataclass(frozen=True, slots=True)
class ExportRecord:
    """What the exporter last wrote for one target."""

    id: str
    vault_id: str
    target_kind: ExportTargetKind
    target_id: str
    vault_relpath: str
    exported_sha256: str
    exported_at: datetime
    version: int


class VaultRepository(Protocol):
    def set_active(self, *, vault_id: str, name: str, root_path: str, now: datetime) -> VaultConfig:
        """Configure the active vault, replacing any previous one."""
        ...

    def get_active(self) -> VaultConfig | None: ...


class ObsidianExportStateRepository(Protocol):
    def get(
        self, *, vault_id: str, target_kind: ExportTargetKind, target_id: str
    ) -> ExportRecord | None: ...

    def upsert(self, record: ExportRecord) -> None: ...

    def list_for_vault(self, vault_id: str) -> Sequence[ExportRecord]: ...
