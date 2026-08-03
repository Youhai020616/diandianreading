"""SQLite database, migrations, repositories, and transactional Unit of Work."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import stat
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, replace
from datetime import datetime
from importlib.resources import files
from pathlib import Path
from typing import Self

from diandianreading.application.ports import (
    CatalogRepository,
    JobPayloadRepository,
    JobRepository,
    JobStepRepository,
    KnowledgeMappingRepository,
    RemoteOperationRepository,
    UnitOfWork,
)
from diandianreading.domain import (
    BlockedReason,
    Book,
    BookStatus,
    DocumentAsset,
    DocumentPart,
    ErrorCode,
    ExternalSource,
    ExternalWorkspace,
    InvalidStateTransition,
    Job,
    JobEvent,
    JobPayload,
    JobStatus,
    JobStep,
    JobStepRecord,
    JobStepStatus,
    KnowledgeStatus,
    LeaseToken,
    PreparationManifest,
    RemoteOperation,
    RemoteOperationKind,
    RemoteOperationStatus,
    RemoteProbeStrategy,
    RepositoryConflict,
    SourceOrigin,
    StorageKey,
    UnsafePathError,
    utc_now,
)

_MIGRATION_NAME = re.compile(r"^(?P<version>\d{4})_[a-z0-9_]+\.sql$")
_ALLOWED_KNOWLEDGE_TRANSITIONS: dict[KnowledgeStatus, frozenset[KnowledgeStatus]] = {
    KnowledgeStatus.CREATING: frozenset(
        {
            KnowledgeStatus.CREATING,
            KnowledgeStatus.PROCESSING,
            KnowledgeStatus.READY,
            KnowledgeStatus.FAILED,
        }
    ),
    KnowledgeStatus.PROCESSING: frozenset(
        {KnowledgeStatus.PROCESSING, KnowledgeStatus.READY, KnowledgeStatus.FAILED}
    ),
    KnowledgeStatus.READY: frozenset({KnowledgeStatus.READY}),
    KnowledgeStatus.FAILED: frozenset({KnowledgeStatus.FAILED}),
}


@dataclass(frozen=True, slots=True)
class _Migration:
    version: int
    name: str
    checksum: str
    sql: str


class SQLiteDatabase:
    """Own secure connection creation and verified package migrations."""

    def __init__(self, path: Path, *, require_new: bool = False) -> None:
        self.path = Path(os.path.abspath(path.expanduser()))
        self._prepare_parent()
        if require_new:
            self._create_private_file(exclusive=True)
        elif self.path.exists() or self.path.is_symlink():
            self._validate_private_file()
        else:
            self._create_private_file(exclusive=True)

    @classmethod
    def create_new(cls, path: Path) -> SQLiteDatabase:
        """Atomically reserve a database path and reject any existing entry."""

        return cls(path, require_new=True)

    def _prepare_parent(self) -> None:
        parent = self.path.parent
        if parent.is_symlink():
            raise UnsafePathError(f"Database parent cannot be a symlink: {parent}")
        if not parent.exists():
            parent.mkdir(parents=True, mode=0o700)
            if os.name != "nt":
                parent.chmod(0o700)
        if not parent.is_dir():
            raise UnsafePathError(f"Database parent is not a directory: {parent}")
        if os.name != "nt":
            metadata = parent.stat()
            if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
                raise UnsafePathError(f"Database parent is not owned by the current user: {parent}")
            if stat.S_IMODE(metadata.st_mode) & 0o077:
                raise UnsafePathError(
                    f"Database parent permissions must be private (0700): {parent}"
                )

    def _create_private_file(self, *, exclusive: bool) -> None:
        flags = os.O_CREAT | os.O_WRONLY
        if exclusive:
            flags |= os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(self.path, flags, 0o600)
        except FileExistsError as exc:
            raise FileExistsError(f"Database already exists: {self.path}") from exc
        try:
            if hasattr(os, "fchmod"):
                os.fchmod(descriptor, 0o600)
        finally:
            os.close(descriptor)

    def _validate_private_file(self) -> None:
        metadata = self.path.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise UnsafePathError(f"Database must be a regular non-symlink file: {self.path}")
        if os.name != "nt":
            if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
                raise UnsafePathError(f"Database is not owned by the current user: {self.path}")
            if stat.S_IMODE(metadata.st_mode) & 0o077:
                raise UnsafePathError(f"Database permissions must be private (0600): {self.path}")

    def open_connection(self) -> sqlite3.Connection:
        self._validate_private_file()
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        return connection

    @contextmanager
    def connect(self, *, immediate: bool = False) -> Iterator[sqlite3.Connection]:
        connection = self.open_connection()
        try:
            if immediate:
                connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def migrate(self) -> int:
        migrations = _load_migrations()
        known_by_version = {migration.version: migration for migration in migrations}
        with self.connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    checksum TEXT NOT NULL,
                    applied_at TEXT NOT NULL
                )
                """
            )
            connection.commit()
            applied_rows = connection.execute(
                "SELECT version, name, checksum FROM schema_migrations ORDER BY version"
            ).fetchall()
            for row in applied_rows:
                version = int(row["version"])
                migration = known_by_version.get(version)
                if migration is None:
                    raise RuntimeError(
                        f"Database schema version {version} is newer or unknown to this binary"
                    )
                if row["name"] != migration.name or row["checksum"] != migration.checksum:
                    raise RuntimeError(
                        f"Applied migration {version:04d} does not match package data"
                    )

            for migration in migrations:
                connection.execute("BEGIN IMMEDIATE")
                applied = connection.execute(
                    "SELECT name, checksum FROM schema_migrations WHERE version = ?",
                    (migration.version,),
                ).fetchone()
                if applied is not None:
                    if (
                        applied["name"] != migration.name
                        or applied["checksum"] != migration.checksum
                    ):
                        raise RuntimeError(
                            f"Applied migration {migration.version:04d} changed after installation"
                        )
                    connection.commit()
                    continue
                _execute_sql_script(connection, migration.sql)
                connection.execute(
                    """
                    INSERT INTO schema_migrations(version, name, checksum, applied_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (
                        migration.version,
                        migration.name,
                        migration.checksum,
                        utc_now().isoformat(),
                    ),
                )
                connection.commit()
        return self.schema_version()

    def schema_version(self) -> int:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations"
            ).fetchone()
        return int(row["version"]) if row is not None else 0

    def integrity_check(self) -> bool:
        with self.connect() as connection:
            row = connection.execute("PRAGMA integrity_check").fetchone()
        return row is not None and str(row[0]) == "ok"


class _SQLiteRepository:
    def __init__(self, target: SQLiteDatabase | sqlite3.Connection) -> None:
        self._target = target

    @contextmanager
    def _connect(self, *, write: bool = False) -> Iterator[sqlite3.Connection]:
        if isinstance(self._target, sqlite3.Connection):
            yield self._target
            return
        with self._target.connect(immediate=write) as connection:
            yield connection


class SQLiteCatalogRepository(_SQLiteRepository, CatalogRepository):
    def add_book(self, book: Book) -> None:
        with self._connect(write=True) as connection:
            connection.execute(
                """
                INSERT INTO books(id, title, author, source_hash, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    book.id,
                    book.title,
                    book.author,
                    book.source_hash,
                    book.status.value,
                    book.created_at.isoformat(),
                    book.updated_at.isoformat(),
                ),
            )

    def update_book(self, book: Book) -> None:
        with self._connect(write=True) as connection:
            cursor = connection.execute(
                """
                UPDATE books
                SET title = ?, author = ?, source_hash = ?, status = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    book.title,
                    book.author,
                    book.source_hash,
                    book.status.value,
                    book.updated_at.isoformat(),
                    book.id,
                ),
            )
            if cursor.rowcount != 1:
                raise KeyError(f"Unknown book: {book.id}")

    def get_book(self, book_id: str) -> Book | None:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
        return _book_from_row(row) if row is not None else None

    def add_asset(self, book_id: str, asset: DocumentAsset) -> None:
        with self._connect(write=True) as connection:
            if asset.derived_from_asset_id is not None:
                parent = connection.execute(
                    "SELECT book_id FROM document_assets WHERE id = ?",
                    (asset.derived_from_asset_id,),
                ).fetchone()
                if parent is None or str(parent["book_id"]) != book_id:
                    raise RepositoryConflict(
                        "Derived DocumentAsset parent is not owned by the Book"
                    )
            connection.execute(
                """
                INSERT INTO document_assets(
                    id, book_id, storage_key, display_filename, mime_type, size_bytes,
                    sha256, title, author, origin, origin_locator, rights_provenance_id,
                    derived_from_asset_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    asset.id,
                    book_id,
                    asset.storage_key.value,
                    asset.display_filename,
                    asset.mime_type,
                    asset.size_bytes,
                    asset.sha256,
                    asset.title,
                    asset.author,
                    asset.origin.value,
                    asset.origin_locator,
                    asset.rights_provenance_id,
                    asset.derived_from_asset_id,
                ),
            )

    def list_assets(self, book_id: str) -> Sequence[DocumentAsset]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT * FROM document_assets
                WHERE book_id = ?
                ORDER BY derived_from_asset_id IS NOT NULL, id
                """,
                (book_id,),
            ).fetchall()
        return tuple(_asset_from_row(row) for row in rows)

    def add_part(self, part: DocumentPart) -> None:
        with self._connect(write=True) as connection:
            connection.execute(
                """
                INSERT INTO document_parts(
                    id, asset_id, sequence, storage_key, mime_type, word_count, sha256,
                    chapter_refs_json, size_bytes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    part.id,
                    part.asset_id,
                    part.sequence,
                    part.storage_key.value,
                    part.mime_type,
                    part.word_count,
                    part.sha256,
                    json.dumps(part.chapter_refs, ensure_ascii=False),
                    part.size_bytes,
                ),
            )

    def list_parts(self, book_id: str) -> Sequence[DocumentPart]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT part.*
                FROM document_parts AS part
                JOIN document_assets AS asset ON asset.id = part.asset_id
                WHERE asset.book_id = ?
                ORDER BY part.sequence, part.id
                """,
                (book_id,),
            ).fetchall()
        return tuple(_part_from_row(row) for row in rows)

    def add_manifest(self, book_id: str, manifest: PreparationManifest) -> None:
        with self._connect(write=True) as connection:
            asset = connection.execute(
                "SELECT book_id FROM document_assets WHERE id = ?",
                (manifest.root_asset_id,),
            ).fetchone()
            if asset is None or str(asset["book_id"]) != book_id:
                raise RepositoryConflict("Preparation manifest root asset is not owned by the Book")
            connection.execute(
                """
                INSERT INTO document_manifests(
                    root_asset_id, book_id, storage_key, sha256, created_at
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    manifest.root_asset_id,
                    book_id,
                    manifest.storage_key.value,
                    manifest.sha256,
                    utc_now().isoformat(),
                ),
            )

    def get_manifest(self, root_asset_id: str) -> PreparationManifest | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM document_manifests WHERE root_asset_id = ?",
                (root_asset_id,),
            ).fetchone()
        return _manifest_from_row(row) if row is not None else None


class SQLiteJobRepository(_SQLiteRepository, JobRepository):
    def add(self, job: Job) -> None:
        with self._connect(write=True) as connection:
            _insert_job(connection, job)
            _insert_job_event(connection, previous=None, current=job)

    def save_transition(self, previous: Job, current: Job) -> None:
        if previous.status is not JobStatus.RUNNING and current.status is JobStatus.RUNNING:
            raise RepositoryConflict("A Job must enter running state through atomic claim")
        with self._connect(write=True) as connection:
            _save_job_transition(
                connection,
                previous,
                current,
                require_running_fence=previous.status is JobStatus.RUNNING,
            )

    def claim(
        self,
        job_id: str,
        owner: str,
        *,
        lease_expires_at: datetime,
        now: datetime,
    ) -> Job:
        with self._connect(write=True) as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if row is None:
                raise KeyError(f"Unknown Job: {job_id}")
            previous = _job_from_row(row)
            if previous.status is JobStatus.QUEUED:
                current = previous.claim(owner, lease_expires_at=lease_expires_at, now=now)
            elif previous.status is JobStatus.RUNNING:
                current = previous.take_over_expired_lease(
                    owner,
                    lease_expires_at=lease_expires_at,
                    now=now,
                )
            else:
                raise InvalidStateTransition(
                    f"Job {job_id} cannot be claimed from {previous.status.value}"
                )
            _save_job_transition(
                connection,
                previous,
                current,
                require_running_fence=False,
            )
            return current

    def heartbeat(
        self,
        job_id: str,
        token: LeaseToken,
        *,
        lease_expires_at: datetime,
        now: datetime,
    ) -> Job:
        with self._connect(write=True) as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if row is None:
                raise KeyError(f"Unknown Job: {job_id}")
            previous = _job_from_row(row)
            current = previous.heartbeat(
                token,
                lease_expires_at=lease_expires_at,
                now=now,
            )
            _save_job_transition(
                connection,
                previous,
                current,
                require_running_fence=True,
            )
            return current

    def request_cancel(self, job_id: str, *, now: datetime) -> Job:
        with self._connect(write=True) as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if row is None:
                raise KeyError(f"Unknown Job: {job_id}")
            previous = _job_from_row(row)
            current = previous.request_cancellation(now=now)
            if current is previous:
                return previous
            _save_job_transition(
                connection,
                previous,
                current,
                require_running_fence=False,
            )
            return current

    def assert_lease(self, job_id: str, token: LeaseToken) -> None:
        with self._connect() as connection:
            _require_job_lease(connection, job_id, token)

    def get(self, job_id: str) -> Job | None:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return _job_from_row(row) if row is not None else None

    def list_events(self, job_id: str) -> Sequence[JobEvent]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM job_events WHERE job_id = ? ORDER BY version",
                (job_id,),
            ).fetchall()
        return tuple(_job_event_from_row(row) for row in rows)


class SQLiteJobStepRepository(_SQLiteRepository, JobStepRepository):
    def add(self, step: JobStepRecord, token: LeaseToken) -> None:
        with self._connect(write=True) as connection:
            _require_job_lease(connection, step.job_id, token)
            connection.execute(
                """
                INSERT INTO job_steps(
                    job_id, step, attempt, status, input_hash, output_ref,
                    progress_current, progress_total, error_code, error_detail_redacted,
                    started_at, completed_at, version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                _step_values(step),
            )

    def save(
        self,
        previous: JobStepRecord,
        current: JobStepRecord,
        token: LeaseToken,
    ) -> None:
        if (
            previous.job_id != current.job_id
            or previous.step is not current.step
            or previous.attempt != current.attempt
            or current.version != previous.version + 1
        ):
            raise RepositoryConflict("Job Step transition must increment one matching version")
        with self._connect(write=True) as connection:
            _require_job_lease(connection, current.job_id, token)
            cursor = connection.execute(
                """
                UPDATE job_steps
                SET status = ?, input_hash = ?, output_ref = ?, progress_current = ?,
                    progress_total = ?, error_code = ?, error_detail_redacted = ?,
                    started_at = ?, completed_at = ?, version = ?
                WHERE job_id = ? AND step = ? AND attempt = ? AND version = ?
                """,
                (
                    current.status.value,
                    current.input_hash,
                    current.output_ref,
                    current.progress_current,
                    current.progress_total,
                    current.error_code.value if current.error_code else None,
                    current.error_detail_redacted,
                    _optional_datetime(current.started_at),
                    _optional_datetime(current.completed_at),
                    current.version,
                    current.job_id,
                    current.step.value,
                    current.attempt,
                    previous.version,
                ),
            )
            if cursor.rowcount != 1:
                raise RepositoryConflict("Job Step was changed by another worker")

    def get(self, job_id: str, step: JobStep, attempt: int) -> JobStepRecord | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM job_steps WHERE job_id = ? AND step = ? AND attempt = ?",
                (job_id, step.value, attempt),
            ).fetchone()
        return _step_from_row(row) if row is not None else None

    def latest(self, job_id: str, step: JobStep) -> JobStepRecord | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT * FROM job_steps
                WHERE job_id = ? AND step = ?
                ORDER BY attempt DESC LIMIT 1
                """,
                (job_id, step.value),
            ).fetchone()
        return _step_from_row(row) if row is not None else None

    def list(self, job_id: str) -> Sequence[JobStepRecord]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM job_steps WHERE job_id = ? ORDER BY attempt, rowid",
                (job_id,),
            ).fetchall()
        return tuple(_step_from_row(row) for row in rows)


class SQLiteJobPayloadRepository(_SQLiteRepository, JobPayloadRepository):
    def add(self, payload: JobPayload) -> None:
        with self._connect(write=True) as connection:
            row = connection.execute(
                "SELECT * FROM job_payloads WHERE job_id = ?",
                (payload.job_id,),
            ).fetchone()
            if row is not None:
                if _payload_from_row(row) != payload:
                    raise RepositoryConflict(f"Job payload collision: {payload.job_id}")
                return
            connection.execute(
                """
                INSERT INTO job_payloads(job_id, payload_type, payload_json, input_hash, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    payload.job_id,
                    payload.payload_type,
                    payload.payload_json,
                    payload.input_hash,
                    payload.created_at.isoformat(),
                ),
            )

    def get(self, job_id: str) -> JobPayload | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM job_payloads WHERE job_id = ?",
                (job_id,),
            ).fetchone()
        return _payload_from_row(row) if row is not None else None


class SQLiteKnowledgeMappingRepository(_SQLiteRepository, KnowledgeMappingRepository):
    def save_workspace(self, workspace: ExternalWorkspace) -> None:
        with self._connect(write=True) as connection:
            row = connection.execute(
                "SELECT * FROM external_workspaces WHERE id = ?", (workspace.id,)
            ).fetchone()
            if row is None:
                connection.execute(
                    """
                    INSERT INTO external_workspaces(
                        id, book_id, provider, credential_profile, external_id,
                        status, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        workspace.id,
                        workspace.book_id,
                        workspace.provider,
                        workspace.credential_profile,
                        workspace.external_id,
                        workspace.status.value,
                        workspace.created_at.isoformat(),
                        workspace.updated_at.isoformat(),
                    ),
                )
                return
            existing = _workspace_from_row(row)
            if (
                existing.book_id,
                existing.provider,
                existing.credential_profile,
                existing.external_id,
            ) != (
                workspace.book_id,
                workspace.provider,
                workspace.credential_profile,
                workspace.external_id,
            ):
                raise RepositoryConflict(f"Workspace identity collision: {workspace.id}")
            _validate_knowledge_transition(existing.status, workspace.status)
            connection.execute(
                "UPDATE external_workspaces SET status = ?, updated_at = ? WHERE id = ?",
                (workspace.status.value, workspace.updated_at.isoformat(), workspace.id),
            )

    def get_workspace(self, workspace_id: str) -> ExternalWorkspace | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM external_workspaces WHERE id = ?", (workspace_id,)
            ).fetchone()
        return _workspace_from_row(row) if row is not None else None

    def get_workspace_for_book(self, book_id: str) -> ExternalWorkspace | None:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM external_workspaces WHERE book_id = ? ORDER BY created_at",
                (book_id,),
            ).fetchall()
        if len(rows) > 1:
            raise RepositoryConflict("Import Job has multiple external workspace mappings")
        return _workspace_from_row(rows[0]) if rows else None

    def save_source(self, source: ExternalSource) -> None:
        with self._connect(write=True) as connection:
            row = connection.execute(
                "SELECT * FROM external_sources WHERE id = ?", (source.id,)
            ).fetchone()
            if row is None:
                connection.execute(
                    """
                    INSERT INTO external_sources(
                        id, workspace_id, document_part_id, external_id, checksum,
                        status, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        source.id,
                        source.workspace_id,
                        source.document_part_id,
                        source.external_id,
                        source.checksum,
                        source.status.value,
                        source.created_at.isoformat(),
                        source.updated_at.isoformat(),
                    ),
                )
                return
            existing = _source_from_row(row)
            if (
                existing.workspace_id,
                existing.document_part_id,
                existing.external_id,
                existing.checksum,
            ) != (
                source.workspace_id,
                source.document_part_id,
                source.external_id,
                source.checksum,
            ):
                raise RepositoryConflict(f"Source identity collision: {source.id}")
            _validate_knowledge_transition(existing.status, source.status)
            connection.execute(
                "UPDATE external_sources SET status = ?, updated_at = ? WHERE id = ?",
                (source.status.value, source.updated_at.isoformat(), source.id),
            )

    def list_sources(self, workspace_id: str) -> Sequence[ExternalSource]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT source.*
                FROM external_sources AS source
                JOIN document_parts AS part ON part.id = source.document_part_id
                WHERE source.workspace_id = ?
                ORDER BY part.sequence, source.id
                """,
                (workspace_id,),
            ).fetchall()
        return tuple(_source_from_row(row) for row in rows)


class SQLiteRemoteOperationRepository(_SQLiteRepository, RemoteOperationRepository):
    def add(self, operation: RemoteOperation, token: LeaseToken | None = None) -> None:
        with self._connect(write=True) as connection:
            _authorize_operation_write(connection, operation.job_id, token)
            existing_row = connection.execute(
                "SELECT * FROM remote_operations WHERE idempotency_key = ?",
                (operation.idempotency_key,),
            ).fetchone()
            if existing_row is not None:
                existing = _operation_from_row(existing_row)
                if existing != operation:
                    raise RepositoryConflict(
                        f"Remote operation key collision: {operation.idempotency_key}"
                    )
                return
            connection.execute(
                """
                INSERT INTO remote_operations(
                    id, job_id, step, provider, credential_profile, kind,
                    idempotency_key, local_resource_id, input_hash, probe_strategy,
                    baseline_snapshot_redacted, request_summary_redacted, status,
                    dispatch_attempt, external_id, created_at, updated_at,
                    dispatched_at, resolved_at, version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                _operation_values(operation),
            )

    def save(
        self,
        previous: RemoteOperation,
        current: RemoteOperation,
        token: LeaseToken | None = None,
    ) -> None:
        if previous.id != current.id or current.version != previous.version + 1:
            raise RepositoryConflict(
                "Remote operation transition must increment one matching version"
            )
        immutable_previous = replace(
            previous,
            status=current.status,
            dispatch_attempt=current.dispatch_attempt,
            external_id=current.external_id,
            updated_at=current.updated_at,
            dispatched_at=current.dispatched_at,
            resolved_at=current.resolved_at,
            version=current.version,
        )
        if immutable_previous != current:
            raise RepositoryConflict("Remote operation immutable inputs cannot change")
        with self._connect(write=True) as connection:
            _authorize_operation_write(connection, current.job_id, token)
            cursor = connection.execute(
                """
                UPDATE remote_operations
                SET status = ?, dispatch_attempt = ?, external_id = ?, updated_at = ?,
                    dispatched_at = ?, resolved_at = ?, version = ?
                WHERE id = ? AND version = ?
                """,
                (
                    current.status.value,
                    current.dispatch_attempt,
                    current.external_id,
                    current.updated_at.isoformat(),
                    _optional_datetime(current.dispatched_at),
                    _optional_datetime(current.resolved_at),
                    current.version,
                    current.id,
                    previous.version,
                ),
            )
            if cursor.rowcount != 1:
                raise RepositoryConflict(
                    f"Remote operation {current.id} changed at version {previous.version}"
                )

    def get_by_idempotency_key(self, idempotency_key: str) -> RemoteOperation | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM remote_operations WHERE idempotency_key = ?",
                (idempotency_key,),
            ).fetchone()
        return _operation_from_row(row) if row is not None else None

    def list_for_job(self, job_id: str) -> Sequence[RemoteOperation]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM remote_operations WHERE job_id = ? ORDER BY created_at, id",
                (job_id,),
            ).fetchall()
        return tuple(_operation_from_row(row) for row in rows)


class SQLiteUnitOfWork(UnitOfWork):
    """One explicit SQLite transaction shared by all import repositories."""

    def __init__(self, database: SQLiteDatabase) -> None:
        self._connection = database.open_connection()
        self._committed = False
        self.catalog = SQLiteCatalogRepository(self._connection)
        self.jobs = SQLiteJobRepository(self._connection)
        self.job_steps = SQLiteJobStepRepository(self._connection)
        self.job_payloads = SQLiteJobPayloadRepository(self._connection)
        self.mappings = SQLiteKnowledgeMappingRepository(self._connection)
        self.operations = SQLiteRemoteOperationRepository(self._connection)

    def __enter__(self) -> Self:
        self._connection.execute("BEGIN IMMEDIATE")
        return self

    def commit(self) -> None:
        self._connection.commit()
        self._committed = True

    def rollback(self) -> None:
        self._connection.rollback()

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> None:
        try:
            if exc_type is not None or not self._committed:
                self.rollback()
        finally:
            self._connection.close()


class SQLiteUnitOfWorkFactory:
    def __init__(self, database: SQLiteDatabase) -> None:
        self._database = database

    def __call__(self) -> SQLiteUnitOfWork:
        return SQLiteUnitOfWork(self._database)


def _load_migrations() -> tuple[_Migration, ...]:
    migration_root = files("diandianreading.infrastructure.persistence.migrations")
    migrations: list[_Migration] = []
    seen_versions: set[int] = set()
    for entry in sorted(migration_root.iterdir(), key=lambda item: item.name):
        if not entry.name.endswith(".sql"):
            continue
        match = _MIGRATION_NAME.fullmatch(entry.name)
        if match is None:
            raise RuntimeError(f"Invalid migration filename: {entry.name}")
        version = int(match.group("version"))
        if version in seen_versions:
            raise RuntimeError(f"Duplicate migration version: {version:04d}")
        seen_versions.add(version)
        sql = entry.read_text(encoding="utf-8")
        migrations.append(
            _Migration(
                version=version,
                name=entry.name,
                checksum=hashlib.sha256(sql.encode("utf-8")).hexdigest(),
                sql=sql,
            )
        )
    expected = list(range(1, len(migrations) + 1))
    actual = [migration.version for migration in migrations]
    if actual != expected:
        raise RuntimeError(f"Migration versions must be contiguous from 0001: {actual}")
    return tuple(migrations)


def _execute_sql_script(connection: sqlite3.Connection, script: str) -> None:
    statement = ""
    for line in script.splitlines(keepends=True):
        statement += line
        if not sqlite3.complete_statement(statement):
            continue
        if statement.strip():
            connection.execute(statement)
        statement = ""
    if statement.strip():
        raise ValueError("Migration contains an incomplete SQL statement")


def _validate_knowledge_transition(previous: KnowledgeStatus, current: KnowledgeStatus) -> None:
    if current not in _ALLOWED_KNOWLEDGE_TRANSITIONS[previous]:
        raise InvalidStateTransition(
            f"Knowledge status cannot move from {previous.value} to {current.value}"
        )


def _job_values(job: Job) -> tuple[object, ...]:
    return (
        job.id,
        job.job_type,
        job.input_hash,
        job.status.value,
        job.current_step.value if job.current_step else None,
        job.attempt,
        job.progress_current,
        job.progress_total,
        job.last_error_code.value if job.last_error_code else None,
        job.last_error_detail_redacted,
        _optional_bool(job.retriable),
        job.blocked_reason.value if job.blocked_reason else None,
        _optional_datetime(job.cancel_requested_at),
        job.lease_owner,
        _optional_datetime(job.lease_expires_at),
        job.lease_generation,
        _optional_datetime(job.not_before),
        job.book_id,
        job.created_at.isoformat(),
        job.updated_at.isoformat(),
        _optional_datetime(job.started_at),
        _optional_datetime(job.completed_at),
        job.version,
    )


def _save_job_transition(
    connection: sqlite3.Connection,
    previous: Job,
    current: Job,
    *,
    require_running_fence: bool,
) -> None:
    if previous.id != current.id or current.version != previous.version + 1:
        raise RepositoryConflict("Job transition must increment one matching aggregate version")
    where = "id = ? AND version = ?"
    parameters: list[object] = [
        current.status.value,
        current.current_step.value if current.current_step else None,
        current.attempt,
        current.progress_current,
        current.progress_total,
        current.last_error_code.value if current.last_error_code else None,
        current.last_error_detail_redacted,
        _optional_bool(current.retriable),
        current.blocked_reason.value if current.blocked_reason else None,
        _optional_datetime(current.cancel_requested_at),
        current.lease_owner,
        _optional_datetime(current.lease_expires_at),
        current.lease_generation,
        _optional_datetime(current.not_before),
        current.book_id,
        current.updated_at.isoformat(),
        _optional_datetime(current.started_at),
        _optional_datetime(current.completed_at),
        current.version,
        current.id,
        previous.version,
    ]
    if require_running_fence:
        if previous.lease_owner is None or previous.lease_generation <= 0:
            raise RepositoryConflict("Running Job transition requires a valid Lease fence")
        where += " AND status = 'running' AND lease_owner = ? AND lease_generation = ?"
        parameters.extend((previous.lease_owner, previous.lease_generation))
    cursor = connection.execute(
        f"""
        UPDATE jobs
        SET status = ?, current_step = ?, attempt = ?, progress_current = ?,
            progress_total = ?, last_error_code = ?, last_error_detail_redacted = ?,
            retriable = ?, blocked_reason = ?, cancel_requested_at = ?,
            lease_owner = ?, lease_expires_at = ?, lease_generation = ?,
            not_before = ?, book_id = ?, updated_at = ?, started_at = ?,
            completed_at = ?, version = ?
        WHERE {where}
        """,
        tuple(parameters),
    )
    if cursor.rowcount != 1:
        raise RepositoryConflict(
            f"Job {current.id} was changed or fenced at version {previous.version}"
        )
    _insert_job_event(connection, previous=previous, current=current)


def _require_job_lease(
    connection: sqlite3.Connection,
    job_id: str,
    token: LeaseToken,
) -> None:
    row = connection.execute(
        """
        SELECT 1 FROM jobs
        WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_generation = ?
        """,
        (job_id, token.owner, token.generation),
    ).fetchone()
    if row is None:
        raise RepositoryConflict("Job Lease owner or generation is stale")


def _authorize_operation_write(
    connection: sqlite3.Connection,
    job_id: str,
    token: LeaseToken | None,
) -> None:
    row = connection.execute("SELECT status FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if row is None:
        raise KeyError(f"Unknown Job: {job_id}")
    if str(row["status"]) == JobStatus.RUNNING.value:
        if token is None:
            raise RepositoryConflict("Running Job remote operation write requires a Lease")
        _require_job_lease(connection, job_id, token)


def _insert_job(connection: sqlite3.Connection, job: Job) -> None:
    connection.execute(
        """
        INSERT INTO jobs(
            id, job_type, input_hash, status, current_step, attempt,
            progress_current, progress_total, last_error_code,
            last_error_detail_redacted, retriable, blocked_reason,
            cancel_requested_at, lease_owner, lease_expires_at, lease_generation,
            not_before, book_id, created_at, updated_at, started_at, completed_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        _job_values(job),
    )


def _insert_job_event(
    connection: sqlite3.Connection,
    *,
    previous: Job | None,
    current: Job,
) -> None:
    connection.execute(
        """
        INSERT INTO job_events(
            job_id, from_status, to_status, current_step, attempt,
            progress_current, progress_total, blocked_reason, cancel_requested_at,
            lease_owner, lease_expires_at, lease_generation, error_code,
            error_detail_redacted, retriable, version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            current.id,
            previous.status.value if previous else None,
            current.status.value,
            current.current_step.value if current.current_step else None,
            current.attempt,
            current.progress_current,
            current.progress_total,
            current.blocked_reason.value if current.blocked_reason else None,
            _optional_datetime(current.cancel_requested_at),
            current.lease_owner,
            _optional_datetime(current.lease_expires_at),
            current.lease_generation,
            current.last_error_code.value if current.last_error_code else None,
            current.last_error_detail_redacted,
            _optional_bool(current.retriable),
            current.version,
            current.updated_at.isoformat(),
        ),
    )


def _book_from_row(row: sqlite3.Row) -> Book:
    return Book(
        id=str(row["id"]),
        title=str(row["title"]),
        author=str(row["author"]) if row["author"] is not None else None,
        source_hash=str(row["source_hash"]),
        status=BookStatus(str(row["status"])),
        created_at=datetime.fromisoformat(str(row["created_at"])),
        updated_at=datetime.fromisoformat(str(row["updated_at"])),
    )


def _asset_from_row(row: sqlite3.Row) -> DocumentAsset:
    return DocumentAsset(
        id=str(row["id"]),
        storage_key=StorageKey(str(row["storage_key"])),
        display_filename=str(row["display_filename"]),
        mime_type=str(row["mime_type"]),
        size_bytes=int(row["size_bytes"]),
        sha256=str(row["sha256"]),
        title=str(row["title"]) if row["title"] is not None else None,
        author=str(row["author"]) if row["author"] is not None else None,
        origin=SourceOrigin(str(row["origin"])),
        origin_locator=str(row["origin_locator"]) if row["origin_locator"] is not None else None,
        rights_provenance_id=str(row["rights_provenance_id"]),
        derived_from_asset_id=(
            str(row["derived_from_asset_id"]) if row["derived_from_asset_id"] is not None else None
        ),
    )


def _manifest_from_row(row: sqlite3.Row) -> PreparationManifest:
    return PreparationManifest(
        root_asset_id=str(row["root_asset_id"]),
        storage_key=StorageKey(str(row["storage_key"])),
        sha256=str(row["sha256"]),
    )


def _part_from_row(row: sqlite3.Row) -> DocumentPart:
    chapter_refs = json.loads(str(row["chapter_refs_json"]))
    if not isinstance(chapter_refs, list) or not all(
        isinstance(item, str) for item in chapter_refs
    ):
        raise ValueError("Invalid chapter_refs_json in database")
    return DocumentPart(
        id=str(row["id"]),
        asset_id=str(row["asset_id"]),
        sequence=int(row["sequence"]),
        storage_key=StorageKey(str(row["storage_key"])),
        mime_type=str(row["mime_type"]),
        word_count=int(row["word_count"]),
        sha256=str(row["sha256"]),
        chapter_refs=tuple(chapter_refs),
        size_bytes=int(row["size_bytes"]),
    )


def _job_from_row(row: sqlite3.Row) -> Job:
    return Job(
        id=str(row["id"]),
        job_type=str(row["job_type"]),
        input_hash=str(row["input_hash"]),
        status=JobStatus(str(row["status"])),
        current_step=(
            JobStep(str(row["current_step"])) if row["current_step"] is not None else None
        ),
        attempt=int(row["attempt"]),
        progress_current=(
            int(row["progress_current"]) if row["progress_current"] is not None else None
        ),
        progress_total=(int(row["progress_total"]) if row["progress_total"] is not None else None),
        last_error_code=(
            ErrorCode(str(row["last_error_code"])) if row["last_error_code"] else None
        ),
        last_error_detail_redacted=(
            str(row["last_error_detail_redacted"])
            if row["last_error_detail_redacted"] is not None
            else None
        ),
        retriable=_parse_optional_bool(row["retriable"]),
        blocked_reason=(
            BlockedReason(str(row["blocked_reason"])) if row["blocked_reason"] else None
        ),
        cancel_requested_at=_parse_optional_datetime(row["cancel_requested_at"]),
        lease_owner=str(row["lease_owner"]) if row["lease_owner"] is not None else None,
        lease_expires_at=_parse_optional_datetime(row["lease_expires_at"]),
        lease_generation=int(row["lease_generation"]),
        not_before=_parse_optional_datetime(row["not_before"]),
        book_id=str(row["book_id"]) if row["book_id"] is not None else None,
        created_at=datetime.fromisoformat(str(row["created_at"])),
        updated_at=datetime.fromisoformat(str(row["updated_at"])),
        started_at=_parse_optional_datetime(row["started_at"]),
        completed_at=_parse_optional_datetime(row["completed_at"]),
        version=int(row["version"]),
    )


def _job_event_from_row(row: sqlite3.Row) -> JobEvent:
    return JobEvent(
        job_id=str(row["job_id"]),
        from_status=JobStatus(str(row["from_status"])) if row["from_status"] else None,
        to_status=JobStatus(str(row["to_status"])),
        current_step=(
            JobStep(str(row["current_step"])) if row["current_step"] is not None else None
        ),
        attempt=int(row["attempt"]),
        progress_current=(
            int(row["progress_current"]) if row["progress_current"] is not None else None
        ),
        progress_total=(int(row["progress_total"]) if row["progress_total"] is not None else None),
        blocked_reason=(
            BlockedReason(str(row["blocked_reason"])) if row["blocked_reason"] else None
        ),
        cancel_requested_at=_parse_optional_datetime(row["cancel_requested_at"]),
        lease_owner=str(row["lease_owner"]) if row["lease_owner"] is not None else None,
        lease_expires_at=_parse_optional_datetime(row["lease_expires_at"]),
        lease_generation=int(row["lease_generation"]),
        error_code=ErrorCode(str(row["error_code"])) if row["error_code"] else None,
        error_detail_redacted=(
            str(row["error_detail_redacted"]) if row["error_detail_redacted"] is not None else None
        ),
        retriable=_parse_optional_bool(row["retriable"]),
        version=int(row["version"]),
        created_at=datetime.fromisoformat(str(row["created_at"])),
    )


def _workspace_from_row(row: sqlite3.Row) -> ExternalWorkspace:
    return ExternalWorkspace(
        id=str(row["id"]),
        book_id=str(row["book_id"]),
        provider=str(row["provider"]),
        credential_profile=str(row["credential_profile"]),
        external_id=str(row["external_id"]),
        status=KnowledgeStatus(str(row["status"])),
        created_at=datetime.fromisoformat(str(row["created_at"])),
        updated_at=datetime.fromisoformat(str(row["updated_at"])),
    )


def _source_from_row(row: sqlite3.Row) -> ExternalSource:
    return ExternalSource(
        id=str(row["id"]),
        workspace_id=str(row["workspace_id"]),
        document_part_id=str(row["document_part_id"]),
        external_id=str(row["external_id"]),
        checksum=str(row["checksum"]),
        status=KnowledgeStatus(str(row["status"])),
        created_at=datetime.fromisoformat(str(row["created_at"])),
        updated_at=datetime.fromisoformat(str(row["updated_at"])),
    )


def _step_values(step: JobStepRecord) -> tuple[object, ...]:
    return (
        step.job_id,
        step.step.value,
        step.attempt,
        step.status.value,
        step.input_hash,
        step.output_ref,
        step.progress_current,
        step.progress_total,
        step.error_code.value if step.error_code else None,
        step.error_detail_redacted,
        _optional_datetime(step.started_at),
        _optional_datetime(step.completed_at),
        step.version,
    )


def _step_from_row(row: sqlite3.Row) -> JobStepRecord:
    return JobStepRecord(
        job_id=str(row["job_id"]),
        step=JobStep(str(row["step"])),
        attempt=int(row["attempt"]),
        status=JobStepStatus(str(row["status"])),
        input_hash=str(row["input_hash"]),
        output_ref=str(row["output_ref"]) if row["output_ref"] is not None else None,
        progress_current=(
            int(row["progress_current"]) if row["progress_current"] is not None else None
        ),
        progress_total=(int(row["progress_total"]) if row["progress_total"] is not None else None),
        error_code=ErrorCode(str(row["error_code"])) if row["error_code"] else None,
        error_detail_redacted=(
            str(row["error_detail_redacted"]) if row["error_detail_redacted"] is not None else None
        ),
        started_at=_parse_optional_datetime(row["started_at"]),
        completed_at=_parse_optional_datetime(row["completed_at"]),
        version=int(row["version"]),
    )


def _payload_from_row(row: sqlite3.Row) -> JobPayload:
    return JobPayload(
        job_id=str(row["job_id"]),
        payload_type=str(row["payload_type"]),
        payload_json=str(row["payload_json"]),
        input_hash=str(row["input_hash"]),
        created_at=datetime.fromisoformat(str(row["created_at"])),
    )


def _operation_values(operation: RemoteOperation) -> tuple[object, ...]:
    return (
        operation.id,
        operation.job_id,
        operation.step.value,
        operation.provider,
        operation.credential_profile,
        operation.kind.value,
        operation.idempotency_key,
        operation.local_resource_id,
        operation.input_hash,
        operation.probe_strategy.value,
        operation.baseline_snapshot_redacted,
        operation.request_summary_redacted,
        operation.status.value,
        operation.dispatch_attempt,
        operation.external_id,
        operation.created_at.isoformat(),
        operation.updated_at.isoformat(),
        _optional_datetime(operation.dispatched_at),
        _optional_datetime(operation.resolved_at),
        operation.version,
    )


def _operation_from_row(row: sqlite3.Row) -> RemoteOperation:
    return RemoteOperation(
        id=str(row["id"]),
        job_id=str(row["job_id"]),
        step=JobStep(str(row["step"])),
        provider=str(row["provider"]),
        credential_profile=str(row["credential_profile"]),
        kind=RemoteOperationKind(str(row["kind"])),
        idempotency_key=str(row["idempotency_key"]),
        local_resource_id=str(row["local_resource_id"]),
        input_hash=str(row["input_hash"]),
        probe_strategy=RemoteProbeStrategy(str(row["probe_strategy"])),
        baseline_snapshot_redacted=str(row["baseline_snapshot_redacted"]),
        request_summary_redacted=str(row["request_summary_redacted"]),
        status=RemoteOperationStatus(str(row["status"])),
        dispatch_attempt=int(row["dispatch_attempt"]),
        external_id=str(row["external_id"]) if row["external_id"] is not None else None,
        created_at=datetime.fromisoformat(str(row["created_at"])),
        updated_at=datetime.fromisoformat(str(row["updated_at"])),
        dispatched_at=_parse_optional_datetime(row["dispatched_at"]),
        resolved_at=_parse_optional_datetime(row["resolved_at"]),
        version=int(row["version"]),
    )


def _optional_datetime(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _parse_optional_datetime(value: object) -> datetime | None:
    return datetime.fromisoformat(str(value)) if value is not None else None


def _optional_bool(value: bool | None) -> int | None:
    return int(value) if value is not None else None


def _parse_optional_bool(value: object) -> bool | None:
    if value is None:
        return None
    if value not in (0, 1):
        raise ValueError("SQLite boolean value must be 0 or 1")
    return value == 1
