"""SQLite persistence for knowledge notes (C1, ADR-0008)."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from datetime import datetime, timedelta

from diandianreading.application.ports.content import (
    ContentAssetRepository,
    ExportRecord,
    KnowledgeNoteRepository,
    ObsidianExportStateRepository,
    VaultConfig,
    VaultRepository,
)
from diandianreading.domain.content import (
    ContentAsset,
    ContentFailureCode,
    ContentLeaseToken,
    ContentLength,
    ContentRevision,
    ContentSource,
    ContentSourceKind,
    ContentStatus,
    ContentTone,
    ContentType,
    ExportTargetKind,
    GenerationRequest,
    KnowledgeNote,
    KnowledgeNoteSource,
    RevisionAuthor,
)
from diandianreading.domain.errors import RepositoryConflict
from diandianreading.infrastructure.persistence.sqlite import SQLiteDatabase


def _row_to_note(row: sqlite3.Row) -> KnowledgeNote:
    return KnowledgeNote(
        id=str(row["id"]),
        book_id=str(row["book_id"]),
        source_kind=KnowledgeNoteSource(str(row["source_kind"])),
        source_id=None if row["source_id"] is None else str(row["source_id"]),
        title=str(row["title"]),
        body=str(row["body"]),
        created_at=datetime.fromisoformat(str(row["created_at"])),
        updated_at=datetime.fromisoformat(str(row["updated_at"])),
        version=int(row["version"]),
    )


class SQLiteKnowledgeNoteRepository(KnowledgeNoteRepository):
    """Persist knowledge notes; source identity is enforced by the database."""

    def __init__(self, target: SQLiteDatabase | sqlite3.Connection) -> None:
        self._target = target

    @contextmanager
    def _connect(self, *, write: bool = False) -> Iterator[sqlite3.Connection]:
        if isinstance(self._target, sqlite3.Connection):
            yield self._target
            return
        with self._target.connect(immediate=write) as connection:
            yield connection

    def add_for_source(self, note: KnowledgeNote) -> KnowledgeNote:
        """Insert the note, or return the row already bound to the same source.

        The read is performed after the failed insert, inside the same immediate
        transaction, so a concurrent writer cannot make two callers each believe
        they created the note.
        """

        with self._connect(write=True) as connection:
            book = connection.execute(
                "SELECT 1 FROM books WHERE id = ?", (note.book_id,)
            ).fetchone()
            if book is None:
                raise KeyError(f"Unknown Book: {note.book_id}")
            try:
                connection.execute(
                    """
                    INSERT INTO notes(
                        id, book_id, source_kind, source_id, title, body,
                        created_at, updated_at, version
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        note.id,
                        note.book_id,
                        note.source_kind.value,
                        note.source_id,
                        note.title,
                        note.body,
                        note.created_at.isoformat(),
                        note.updated_at.isoformat(),
                        note.version,
                    ),
                )
            except sqlite3.IntegrityError:
                if note.source_id is None:
                    raise
                existing = connection.execute(
                    "SELECT * FROM notes WHERE source_kind = ? AND source_id = ?",
                    (note.source_kind.value, note.source_id),
                ).fetchone()
                if existing is None:
                    raise
                return _row_to_note(existing)
            return note

    def get(self, note_id: str) -> KnowledgeNote | None:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
        return None if row is None else _row_to_note(row)

    def find_by_source(
        self, source_kind: KnowledgeNoteSource, source_id: str
    ) -> KnowledgeNote | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM notes WHERE source_kind = ? AND source_id = ?",
                (source_kind.value, source_id),
            ).fetchone()
        return None if row is None else _row_to_note(row)

    def list_for_book(
        self,
        book_id: str,
        *,
        limit: int,
        before_created_at: datetime | None = None,
        before_id: str | None = None,
    ) -> Sequence[KnowledgeNote]:
        if limit <= 0:
            raise ValueError("limit must be positive")
        # (created_at, id) keyset paging keeps the order total even when two
        # notes are saved inside the same clock tick.
        clauses = ["book_id = ?"]
        parameters: list[object] = [book_id]
        if before_created_at is not None and before_id is not None:
            clauses.append("(created_at < ? OR (created_at = ? AND id < ?))")
            moment = before_created_at.isoformat()
            parameters.extend([moment, moment, before_id])
        query = (
            f"SELECT * FROM notes WHERE {' AND '.join(clauses)} "
            "ORDER BY created_at DESC, id DESC LIMIT ?"
        )
        parameters.append(limit)
        with self._connect() as connection:
            rows = connection.execute(query, tuple(parameters)).fetchall()
        return tuple(_row_to_note(row) for row in rows)

    def count_for_book(self, book_id: str) -> int:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT count(*) FROM notes WHERE book_id = ?", (book_id,)
            ).fetchone()
        return int(row[0])


def _row_to_asset(row: sqlite3.Row, sources: tuple[ContentSource, ...]) -> ContentAsset:
    return ContentAsset(
        id=str(row["id"]),
        book_id=str(row["book_id"]),
        request=GenerationRequest(
            content_type=ContentType(str(row["content_type"])),
            sources=sources,
            language=str(row["language"]),
            tone=ContentTone(str(row["tone"])),
            length=ContentLength(str(row["length_hint"])),
            target_platform=(
                None if row["target_platform"] is None else str(row["target_platform"])
            ),
            require_citations=bool(row["require_citations"]),
            first_person=bool(row["first_person"]),
        ),
        status=ContentStatus(str(row["status"])),
        latest_revision_number=int(row["latest_revision_number"]),
        created_at=datetime.fromisoformat(str(row["created_at"])),
        updated_at=datetime.fromisoformat(str(row["updated_at"])),
        version=int(row["version"]),
    )


class SQLiteContentAssetRepository(ContentAssetRepository):
    """Persist content assets as recoverable task units (ADR-0008 section 2b)."""

    def __init__(self, target: SQLiteDatabase | sqlite3.Connection) -> None:
        self._target = target

    @contextmanager
    def _connect(self, *, write: bool = False) -> Iterator[sqlite3.Connection]:
        if isinstance(self._target, sqlite3.Connection):
            yield self._target
            return
        with self._target.connect(immediate=write) as connection:
            yield connection

    def _load_sources(
        self, connection: sqlite3.Connection, content_id: str
    ) -> tuple[ContentSource, ...]:
        rows = connection.execute(
            "SELECT kind, reference FROM content_sources WHERE content_id = ? ORDER BY position",
            (content_id,),
        ).fetchall()
        return tuple(
            ContentSource(kind=ContentSourceKind(str(r["kind"])), reference=str(r["reference"]))
            for r in rows
        )

    def create(self, asset: ContentAsset) -> None:
        with self._connect(write=True) as connection:
            book = connection.execute(
                "SELECT 1 FROM books WHERE id = ?", (asset.book_id,)
            ).fetchone()
            if book is None:
                raise KeyError(f"Unknown Book: {asset.book_id}")
            connection.execute(
                """
                INSERT INTO generated_contents(
                    id, book_id, content_type, status, language, tone, length_hint,
                    target_platform, require_citations, first_person,
                    latest_revision_number, created_at, updated_at, version,
                    lease_generation, attempt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
                """,
                (
                    asset.id,
                    asset.book_id,
                    asset.request.content_type.value,
                    asset.status.value,
                    asset.request.language,
                    asset.request.tone.value,
                    asset.request.length.value,
                    asset.request.target_platform,
                    int(asset.request.require_citations),
                    int(asset.request.first_person),
                    asset.latest_revision_number,
                    asset.created_at.isoformat(),
                    asset.updated_at.isoformat(),
                    asset.version,
                ),
            )
            for position, source in enumerate(asset.request.sources):
                connection.execute(
                    """
                    INSERT INTO content_sources(content_id, position, kind, reference)
                    VALUES (?, ?, ?, ?)
                    """,
                    (asset.id, position, source.kind.value, source.reference),
                )

    def get(self, content_id: str) -> ContentAsset | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM generated_contents WHERE id = ?", (content_id,)
            ).fetchone()
            if row is None:
                return None
            return _row_to_asset(row, self._load_sources(connection, content_id))

    def claim_next(
        self, *, worker_id: str, now: datetime, lease_seconds: int
    ) -> tuple[ContentAsset, ContentLeaseToken] | None:
        if lease_seconds <= 0:
            raise ValueError("Lease seconds must be positive")
        moment = now.isoformat()
        expires = (now + timedelta(seconds=lease_seconds)).isoformat()
        with self._connect(write=True) as connection:
            # A queued asset, or a generating one whose owner let the lease lapse.
            row = connection.execute(
                """
                SELECT * FROM generated_contents
                WHERE status = 'queued'
                   OR (status = 'generating' AND (lease_expires_at IS NULL OR lease_expires_at < ?))
                ORDER BY created_at ASC, id ASC
                LIMIT 1
                """,
                (moment,),
            ).fetchone()
            if row is None:
                return None
            content_id = str(row["id"])
            generation = int(row["lease_generation"]) + 1
            connection.execute(
                """
                UPDATE generated_contents
                SET status = 'generating',
                    lease_owner = ?,
                    lease_expires_at = ?,
                    lease_generation = ?,
                    attempt = attempt + 1,
                    updated_at = ?,
                    version = version + 1
                WHERE id = ?
                """,
                (worker_id, expires, generation, moment, content_id),
            )
            refreshed = connection.execute(
                "SELECT * FROM generated_contents WHERE id = ?", (content_id,)
            ).fetchone()
            sources = self._load_sources(connection, content_id)
            return _row_to_asset(refreshed, sources), ContentLeaseToken(worker_id, generation)

    def cancel_requested(self, content_id: str) -> bool:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT cancel_requested_at FROM generated_contents WHERE id = ?", (content_id,)
            ).fetchone()
        return row is not None and row["cancel_requested_at"] is not None

    def request_cancel(self, content_id: str, *, now: datetime) -> bool:
        with self._connect(write=True) as connection:
            cursor = connection.execute(
                """
                UPDATE generated_contents
                SET cancel_requested_at = COALESCE(cancel_requested_at, ?),
                    updated_at = ?,
                    version = version + 1
                WHERE id = ? AND status IN ('queued', 'generating')
                """,
                (now.isoformat(), now.isoformat(), content_id),
            )
            return cursor.rowcount > 0

    def _require_lease(
        self, connection: sqlite3.Connection, content_id: str, token: ContentLeaseToken
    ) -> sqlite3.Row:
        row = connection.execute(
            "SELECT * FROM generated_contents WHERE id = ?", (content_id,)
        ).fetchone()
        if row is None:
            raise KeyError(f"Unknown content asset: {content_id}")
        if str(row["lease_owner"] or "") != token.owner or int(row["lease_generation"]) != (
            token.generation
        ):
            raise RepositoryConflict(f"Content lease is no longer held: {content_id}")
        checked: sqlite3.Row = row
        return checked

    def bind_provider_operation(
        self, content_id: str, token: ContentLeaseToken, *, operation_id: str, now: datetime
    ) -> None:
        with self._connect(write=True) as connection:
            self._require_lease(connection, content_id, token)
            connection.execute(
                """
                UPDATE generated_contents
                SET provider_operation_id = ?,
                    provider_request_started_at = COALESCE(provider_request_started_at, ?),
                    updated_at = ?,
                    version = version + 1
                WHERE id = ?
                """,
                (operation_id, now.isoformat(), now.isoformat(), content_id),
            )

    def complete_with_revision(
        self, content_id: str, token: ContentLeaseToken, revision: ContentRevision, *, now: datetime
    ) -> ContentAsset:
        with self._connect(write=True) as connection:
            self._require_lease(connection, content_id, token)
            connection.execute(
                """
                INSERT INTO content_revisions(
                    id, content_id, revision_number, author_kind, title, body, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    revision.id,
                    content_id,
                    revision.revision_number,
                    revision.author_kind.value,
                    revision.title,
                    revision.body,
                    revision.created_at.isoformat(),
                ),
            )
            connection.execute(
                """
                UPDATE generated_contents
                SET status = 'draft',
                    latest_revision_number = ?,
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    completed_at = ?,
                    updated_at = ?,
                    version = version + 1
                WHERE id = ?
                """,
                (revision.revision_number, now.isoformat(), now.isoformat(), content_id),
            )
            refreshed = connection.execute(
                "SELECT * FROM generated_contents WHERE id = ?", (content_id,)
            ).fetchone()
            return _row_to_asset(refreshed, self._load_sources(connection, content_id))

    def fail(
        self,
        content_id: str,
        token: ContentLeaseToken,
        *,
        code: ContentFailureCode,
        now: datetime,
    ) -> ContentAsset:
        with self._connect(write=True) as connection:
            row = self._require_lease(connection, content_id, token)
            # A failed attempt keeps the asset queued when no draft exists yet:
            # the frozen lifecycle has no failed state, and the row must stay a
            # claimable task rather than become an asset with zero revisions.
            next_status = "draft" if int(row["latest_revision_number"]) >= 1 else "queued"
            connection.execute(
                """
                UPDATE generated_contents
                SET status = ?,
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    failure_code = ?,
                    updated_at = ?,
                    version = version + 1
                WHERE id = ?
                """,
                (next_status, code.value, now.isoformat(), content_id),
            )
            refreshed = connection.execute(
                "SELECT * FROM generated_contents WHERE id = ?", (content_id,)
            ).fetchone()
            return _row_to_asset(refreshed, self._load_sources(connection, content_id))

    def append_human_revision(
        self, content_id: str, revision: ContentRevision, *, now: datetime
    ) -> ContentAsset:
        with self._connect(write=True) as connection:
            row = connection.execute(
                "SELECT * FROM generated_contents WHERE id = ?", (content_id,)
            ).fetchone()
            if row is None:
                raise KeyError(f"Unknown content asset: {content_id}")
            connection.execute(
                """
                INSERT INTO content_revisions(
                    id, content_id, revision_number, author_kind, title, body, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    revision.id,
                    content_id,
                    revision.revision_number,
                    revision.author_kind.value,
                    revision.title,
                    revision.body,
                    revision.created_at.isoformat(),
                ),
            )
            connection.execute(
                """
                UPDATE generated_contents
                SET status = 'editing',
                    latest_revision_number = ?,
                    updated_at = ?,
                    version = version + 1
                WHERE id = ?
                """,
                (revision.revision_number, now.isoformat(), content_id),
            )
            refreshed = connection.execute(
                "SELECT * FROM generated_contents WHERE id = ?", (content_id,)
            ).fetchone()
            return _row_to_asset(refreshed, self._load_sources(connection, content_id))

    def list_revisions(self, content_id: str) -> Sequence[ContentRevision]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM content_revisions WHERE content_id = ? ORDER BY revision_number",
                (content_id,),
            ).fetchall()
        return tuple(
            ContentRevision(
                id=str(row["id"]),
                content_id=str(row["content_id"]),
                revision_number=int(row["revision_number"]),
                author_kind=RevisionAuthor(str(row["author_kind"])),
                title=str(row["title"]),
                body=str(row["body"]),
                created_at=datetime.fromisoformat(str(row["created_at"])),
            )
            for row in rows
        )

    def list_for_book(self, book_id: str, *, limit: int) -> Sequence[ContentAsset]:
        if limit <= 0:
            raise ValueError("limit must be positive")
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT * FROM generated_contents WHERE book_id = ?
                ORDER BY created_at DESC, id DESC LIMIT ?
                """,
                (book_id, limit),
            ).fetchall()
            assets = [
                _row_to_asset(row, self._load_sources(connection, str(row["id"]))) for row in rows
            ]
        return tuple(assets)


class SQLiteVaultRepository(VaultRepository):
    """Persist the single active Obsidian vault."""

    def __init__(self, target: SQLiteDatabase | sqlite3.Connection) -> None:
        self._target = target

    @contextmanager
    def _connect(self, *, write: bool = False) -> Iterator[sqlite3.Connection]:
        if isinstance(self._target, sqlite3.Connection):
            yield self._target
            return
        with self._target.connect(immediate=write) as connection:
            yield connection

    def set_active(self, *, vault_id: str, name: str, root_path: str, now: datetime) -> VaultConfig:
        moment = now.isoformat()
        with self._connect(write=True) as connection:
            # Deactivate first: the partial unique index allows only one active
            # row, so an insert before the demotion would be rejected.
            connection.execute(
                "UPDATE obsidian_vaults SET is_active = 0, updated_at = ? WHERE is_active = 1",
                (moment,),
            )
            connection.execute(
                """
                INSERT INTO obsidian_vaults(
                    id, name, root_path, is_active, created_at, updated_at, version
                ) VALUES (?, ?, ?, 1, ?, ?, 0)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    root_path = excluded.root_path,
                    is_active = 1,
                    updated_at = excluded.updated_at,
                    version = obsidian_vaults.version + 1
                """,
                (vault_id, name, root_path, moment, moment),
            )
            row = connection.execute(
                "SELECT * FROM obsidian_vaults WHERE id = ?", (vault_id,)
            ).fetchone()
        return VaultConfig(
            id=str(row["id"]),
            name=str(row["name"]),
            root_path=str(row["root_path"]),
            version=int(row["version"]),
        )

    def get_active(self) -> VaultConfig | None:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM obsidian_vaults WHERE is_active = 1").fetchone()
        if row is None:
            return None
        return VaultConfig(
            id=str(row["id"]),
            name=str(row["name"]),
            root_path=str(row["root_path"]),
            version=int(row["version"]),
        )


class SQLiteObsidianExportStateRepository(ObsidianExportStateRepository):
    """Track what the exporter last wrote, keyed by content identity."""

    def __init__(self, target: SQLiteDatabase | sqlite3.Connection) -> None:
        self._target = target

    @contextmanager
    def _connect(self, *, write: bool = False) -> Iterator[sqlite3.Connection]:
        if isinstance(self._target, sqlite3.Connection):
            yield self._target
            return
        with self._target.connect(immediate=write) as connection:
            yield connection

    def get(
        self, *, vault_id: str, target_kind: ExportTargetKind, target_id: str
    ) -> ExportRecord | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT * FROM obsidian_export_state
                WHERE vault_id = ? AND target_kind = ? AND target_id = ?
                """,
                (vault_id, target_kind.value, target_id),
            ).fetchone()
        return None if row is None else _row_to_export_record(row)

    def upsert(self, record: ExportRecord) -> None:
        with self._connect(write=True) as connection:
            connection.execute(
                """
                INSERT INTO obsidian_export_state(
                    id, vault_id, target_kind, target_id, vault_relpath,
                    exported_sha256, exported_at, version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(vault_id, target_kind, target_id) DO UPDATE SET
                    vault_relpath = excluded.vault_relpath,
                    exported_sha256 = excluded.exported_sha256,
                    exported_at = excluded.exported_at,
                    version = obsidian_export_state.version + 1
                """,
                (
                    record.id,
                    record.vault_id,
                    record.target_kind.value,
                    record.target_id,
                    record.vault_relpath,
                    record.exported_sha256,
                    record.exported_at.isoformat(),
                    record.version,
                ),
            )

    def list_for_vault(self, vault_id: str) -> Sequence[ExportRecord]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM obsidian_export_state WHERE vault_id = ? ORDER BY target_kind",
                (vault_id,),
            ).fetchall()
        return tuple(_row_to_export_record(row) for row in rows)


def _row_to_export_record(row: sqlite3.Row) -> ExportRecord:
    return ExportRecord(
        id=str(row["id"]),
        vault_id=str(row["vault_id"]),
        target_kind=ExportTargetKind(str(row["target_kind"])),
        target_id=str(row["target_id"]),
        vault_relpath=str(row["vault_relpath"]),
        exported_sha256=str(row["exported_sha256"]),
        exported_at=datetime.fromisoformat(str(row["exported_at"])),
        version=int(row["version"]),
    )
