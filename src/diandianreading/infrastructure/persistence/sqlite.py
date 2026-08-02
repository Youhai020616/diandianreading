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
from dataclasses import dataclass
from datetime import datetime
from importlib.resources import files
from pathlib import Path
from typing import Self

from diandianreading.application.ports import (
    CatalogRepository,
    JobRepository,
    KnowledgeMappingRepository,
    RemoteOperationRepository,
    UnitOfWork,
)
from diandianreading.domain import (
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
    JobStatus,
    JobStep,
    KnowledgeStatus,
    RemoteOperation,
    RemoteOperationKind,
    RemoteOperationStatus,
    RepositoryConflict,
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
            connection.execute(
                """
                INSERT INTO document_assets(
                    id, book_id, storage_key, display_filename, mime_type, size_bytes,
                    sha256, title, author, origin, origin_locator, rights_provenance_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                ),
            )

    def add_part(self, part: DocumentPart) -> None:
        with self._connect(write=True) as connection:
            connection.execute(
                """
                INSERT INTO document_parts(
                    id, asset_id, sequence, storage_key, mime_type, word_count, sha256,
                    chapter_refs_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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


class SQLiteJobRepository(_SQLiteRepository, JobRepository):
    def add(self, job: Job) -> None:
        with self._connect(write=True) as connection:
            _insert_job(connection, job)
            _insert_job_event(connection, previous=None, current=job)

    def save_transition(self, previous: Job, current: Job) -> None:
        if previous.id != current.id or current.version != previous.version + 1:
            raise RepositoryConflict("Job transition must increment one matching aggregate version")
        with self._connect(write=True) as connection:
            cursor = connection.execute(
                """
                UPDATE jobs
                SET status = ?, step = ?, attempt = ?, progress_current = ?,
                    progress_total = ?, error_code = ?, error_message = ?, book_id = ?,
                    updated_at = ?, started_at = ?, completed_at = ?, version = ?
                WHERE id = ? AND version = ?
                """,
                (
                    current.status.value,
                    current.step.value,
                    current.attempt,
                    current.progress_current,
                    current.progress_total,
                    current.error_code.value if current.error_code else None,
                    current.error_message,
                    current.book_id,
                    current.updated_at.isoformat(),
                    _optional_datetime(current.started_at),
                    _optional_datetime(current.completed_at),
                    current.version,
                    current.id,
                    previous.version,
                ),
            )
            if cursor.rowcount != 1:
                raise RepositoryConflict(
                    f"Job {current.id} was changed by another writer at version {previous.version}"
                )
            _insert_job_event(connection, previous=previous, current=current)

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
                SELECT * FROM external_sources
                WHERE workspace_id = ?
                ORDER BY document_part_id
                """,
                (workspace_id,),
            ).fetchall()
        return tuple(_source_from_row(row) for row in rows)


class SQLiteRemoteOperationRepository(_SQLiteRepository, RemoteOperationRepository):
    def add(self, operation: RemoteOperation) -> None:
        with self._connect(write=True) as connection:
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
                    id, job_id, kind, idempotency_key, local_resource_id, input_hash,
                    status, external_id, created_at, updated_at, version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    operation.id,
                    operation.job_id,
                    operation.kind.value,
                    operation.idempotency_key,
                    operation.local_resource_id,
                    operation.input_hash,
                    operation.status.value,
                    operation.external_id,
                    operation.created_at.isoformat(),
                    operation.updated_at.isoformat(),
                    operation.version,
                ),
            )

    def save(self, previous: RemoteOperation, current: RemoteOperation) -> None:
        if previous.id != current.id or current.version != previous.version + 1:
            raise RepositoryConflict(
                "Remote operation transition must increment one matching version"
            )
        with self._connect(write=True) as connection:
            cursor = connection.execute(
                """
                UPDATE remote_operations
                SET status = ?, external_id = ?, updated_at = ?, version = ?
                WHERE id = ? AND version = ?
                """,
                (
                    current.status.value,
                    current.external_id,
                    current.updated_at.isoformat(),
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


class SQLiteUnitOfWork(UnitOfWork):
    """One explicit SQLite transaction shared by all import repositories."""

    def __init__(self, database: SQLiteDatabase) -> None:
        self._connection = database.open_connection()
        self._committed = False
        self.catalog = SQLiteCatalogRepository(self._connection)
        self.jobs = SQLiteJobRepository(self._connection)
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


def _insert_job(connection: sqlite3.Connection, job: Job) -> None:
    connection.execute(
        """
        INSERT INTO jobs(
            id, job_type, input_hash, status, step, attempt, progress_current,
            progress_total, error_code, error_message, book_id, created_at,
            updated_at, started_at, completed_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            job.id,
            job.job_type,
            job.input_hash,
            job.status.value,
            job.step.value,
            job.attempt,
            job.progress_current,
            job.progress_total,
            job.error_code.value if job.error_code else None,
            job.error_message,
            job.book_id,
            job.created_at.isoformat(),
            job.updated_at.isoformat(),
            _optional_datetime(job.started_at),
            _optional_datetime(job.completed_at),
            job.version,
        ),
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
            job_id, from_status, to_status, step, attempt, progress_current,
            progress_total, error_code, error_message, version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            current.id,
            previous.status.value if previous else None,
            current.status.value,
            current.step.value,
            current.attempt,
            current.progress_current,
            current.progress_total,
            current.error_code.value if current.error_code else None,
            current.error_message,
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
    )


def _job_from_row(row: sqlite3.Row) -> Job:
    error_code = ErrorCode(str(row["error_code"])) if row["error_code"] else None
    return Job(
        id=str(row["id"]),
        job_type=str(row["job_type"]),
        input_hash=str(row["input_hash"]),
        status=JobStatus(str(row["status"])),
        step=JobStep(str(row["step"])),
        attempt=int(row["attempt"]),
        progress_current=(
            int(row["progress_current"]) if row["progress_current"] is not None else None
        ),
        progress_total=(int(row["progress_total"]) if row["progress_total"] is not None else None),
        error_code=error_code,
        error_message=(str(row["error_message"]) if row["error_message"] is not None else None),
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
        step=JobStep(str(row["step"])),
        attempt=int(row["attempt"]),
        progress_current=(
            int(row["progress_current"]) if row["progress_current"] is not None else None
        ),
        progress_total=(int(row["progress_total"]) if row["progress_total"] is not None else None),
        error_code=ErrorCode(str(row["error_code"])) if row["error_code"] else None,
        error_message=(str(row["error_message"]) if row["error_message"] is not None else None),
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


def _operation_from_row(row: sqlite3.Row) -> RemoteOperation:
    return RemoteOperation(
        id=str(row["id"]),
        job_id=str(row["job_id"]),
        kind=RemoteOperationKind(str(row["kind"])),
        idempotency_key=str(row["idempotency_key"]),
        local_resource_id=str(row["local_resource_id"]),
        input_hash=str(row["input_hash"]),
        status=RemoteOperationStatus(str(row["status"])),
        external_id=str(row["external_id"]) if row["external_id"] is not None else None,
        created_at=datetime.fromisoformat(str(row["created_at"])),
        updated_at=datetime.fromisoformat(str(row["updated_at"])),
        version=int(row["version"]),
    )


def _optional_datetime(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _parse_optional_datetime(value: object) -> datetime | None:
    return datetime.fromisoformat(str(value)) if value is not None else None
