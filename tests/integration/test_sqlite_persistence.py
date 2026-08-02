from __future__ import annotations

import os
import stat
from dataclasses import replace

import pytest

from diandianreading.domain import (
    Book,
    BookStatus,
    ErrorCode,
    ExternalSource,
    ExternalWorkspace,
    InvalidStateTransition,
    Job,
    JobStep,
    KnowledgeStatus,
    RemoteOperation,
    RemoteOperationKind,
    RemoteOperationStatus,
    RepositoryConflict,
    UnsafePathError,
)
from diandianreading.infrastructure.persistence import (
    SQLiteCatalogRepository,
    SQLiteDatabase,
    SQLiteJobRepository,
    SQLiteKnowledgeMappingRepository,
    SQLiteRemoteOperationRepository,
    SQLiteUnitOfWorkFactory,
)
from tests.support import FIXED_NOW, make_import_command


def make_database(tmp_path) -> SQLiteDatabase:
    database = SQLiteDatabase(tmp_path / "state" / "app.sqlite3")
    database.migrate()
    return database


def test_migrations_are_idempotent_verified_and_database_is_private(tmp_path) -> None:
    database = make_database(tmp_path)
    assert database.migrate() == 1
    assert database.schema_version() == 1
    assert database.integrity_check()
    if os.name != "nt":
        assert stat.S_IMODE(database.path.stat().st_mode) == 0o600
        assert stat.S_IMODE(database.path.parent.stat().st_mode) == 0o700

    with database.connect(immediate=True) as connection:
        connection.execute("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1")
    with pytest.raises(RuntimeError, match="does not match"):
        database.migrate()


def test_migrator_rejects_unknown_newer_schema(tmp_path) -> None:
    database = make_database(tmp_path)
    with database.connect(immediate=True) as connection:
        connection.execute(
            """
            INSERT INTO schema_migrations(version, name, checksum, applied_at)
            VALUES (9999, '9999_future.sql', 'future', ?)
            """,
            (FIXED_NOW.isoformat(),),
        )
    with pytest.raises(RuntimeError, match="newer or unknown"):
        database.migrate()


def test_database_rejects_symlink_path(tmp_path) -> None:
    if not hasattr(os, "symlink"):
        pytest.skip("symlinks unavailable")
    private_dir = tmp_path / "private"
    private_dir.mkdir(mode=0o700)
    target = private_dir / "target.sqlite3"
    target.touch(mode=0o600)
    link = private_dir / "link.sqlite3"
    link.symlink_to(target)
    with pytest.raises(UnsafePathError, match="non-symlink"):
        SQLiteDatabase(link)


def test_sqlite_repositories_round_trip_and_prevent_status_regression(tmp_path) -> None:
    database = make_database(tmp_path)
    catalog = SQLiteCatalogRepository(database)
    mappings = SQLiteKnowledgeMappingRepository(database)
    command = make_import_command(tmp_path)
    book = Book(
        id="book-1",
        title=command.title,
        author=command.author,
        source_hash=command.asset.sha256,
        status=BookStatus.IMPORTING,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
    )
    catalog.add_book(book)
    catalog.add_asset(book.id, command.asset)
    for part in command.parts:
        catalog.add_part(part)
    ready_book = replace(book, status=BookStatus.READY)
    catalog.update_book(ready_book)

    assert catalog.get_book(book.id) == ready_book
    assert tuple(catalog.list_parts(book.id)) == command.parts
    assert catalog.get_book("missing") is None

    workspace = ExternalWorkspace(
        id="workspace-1",
        book_id=book.id,
        provider="fake",
        credential_profile="test",
        external_id="external-workspace",
        status=KnowledgeStatus.PROCESSING,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
    )
    mappings.save_workspace(workspace)
    ready_workspace = replace(workspace, status=KnowledgeStatus.READY)
    mappings.save_workspace(ready_workspace)
    assert mappings.get_workspace(workspace.id) == ready_workspace
    assert mappings.get_workspace("missing") is None
    with pytest.raises(InvalidStateTransition, match="cannot move"):
        mappings.save_workspace(workspace)
    with pytest.raises(RepositoryConflict, match="identity collision"):
        mappings.save_workspace(replace(ready_workspace, book_id="another-book"))

    source = ExternalSource(
        id="source-1",
        workspace_id=workspace.id,
        document_part_id=command.parts[0].id,
        external_id="external-source",
        checksum=command.parts[0].sha256,
        status=KnowledgeStatus.PROCESSING,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
    )
    mappings.save_source(source)
    ready_source = replace(source, status=KnowledgeStatus.READY)
    mappings.save_source(ready_source)
    assert tuple(mappings.list_sources(workspace.id)) == (ready_source,)
    with pytest.raises(InvalidStateTransition, match="cannot move"):
        mappings.save_source(source)
    with pytest.raises(RepositoryConflict, match="identity collision"):
        mappings.save_source(replace(ready_source, checksum="different"))


def test_job_and_operation_repositories_preserve_history_and_versions(tmp_path) -> None:
    database = make_database(tmp_path)
    jobs = SQLiteJobRepository(database)
    operations = SQLiteRemoteOperationRepository(database)
    job = Job.create(
        job_id="job-1",
        job_type="import_book",
        input_hash="hash",
        now=FIXED_NOW,
    )
    jobs.add(job)
    running = job.advance(JobStep.ACQUIRING, now=FIXED_NOW)
    jobs.save_transition(job, running)
    failed = running.fail(
        code=ErrorCode.REMOTE_UNAVAILABLE,
        message="offline",
        now=FIXED_NOW,
    )
    jobs.save_transition(running, failed)
    retried = failed.retry(now=FIXED_NOW)
    jobs.save_transition(failed, retried)

    assert jobs.get(job.id) == retried
    events = jobs.list_events(job.id)
    assert [event.version for event in events] == [0, 1, 2, 3]
    assert events[2].error_message == "offline"
    assert events[2].attempt == 1

    with pytest.raises(RepositoryConflict, match="matching aggregate"):
        jobs.save_transition(job, replace(running, version=3))
    with pytest.raises(RepositoryConflict, match="another writer"):
        jobs.save_transition(job, running)
    assert jobs.get("missing") is None

    operation = RemoteOperation(
        id="operation-1",
        job_id=job.id,
        kind=RemoteOperationKind.ENSURE_WORKSPACE,
        idempotency_key="workspace-key",
        local_resource_id="book-1",
        input_hash="hash",
        status=RemoteOperationStatus.PENDING,
        external_id=None,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
        version=0,
    )
    operations.add(operation)
    operations.add(operation)
    completed = operation.complete("external-workspace", now=FIXED_NOW)
    operations.save(operation, completed)
    assert operations.get_by_idempotency_key("workspace-key") == completed
    assert operations.get_by_idempotency_key("missing") is None
    with pytest.raises(RepositoryConflict, match="key collision"):
        operations.add(replace(operation, id="different"))
    with pytest.raises(RepositoryConflict, match="matching version"):
        operations.save(operation, replace(completed, version=3))


def test_unit_of_work_rolls_back_related_book_and_job_changes(tmp_path) -> None:
    database = make_database(tmp_path)
    command = make_import_command(tmp_path, part_count=1)
    book = Book(
        "book-1",
        command.title,
        command.author,
        command.asset.sha256,
        BookStatus.IMPORTING,
        FIXED_NOW,
        FIXED_NOW,
    )
    job = Job.create(
        job_id="job-1",
        job_type="import_book",
        input_hash=command.asset.sha256,
        book_id=book.id,
        now=FIXED_NOW,
    )
    factory = SQLiteUnitOfWorkFactory(database)
    with factory() as unit_of_work:
        unit_of_work.catalog.add_book(book)
        unit_of_work.jobs.add(job)
        unit_of_work.commit()

    with pytest.raises(RepositoryConflict), factory() as unit_of_work:
        unit_of_work.catalog.update_book(replace(book, status=BookStatus.READY))
        running = job.advance(JobStep.ACQUIRING, now=FIXED_NOW)
        unit_of_work.jobs.save_transition(job, replace(running, version=3))
        unit_of_work.commit()

    assert SQLiteCatalogRepository(database).get_book(book.id) == book
    assert SQLiteJobRepository(database).get(job.id) == job
