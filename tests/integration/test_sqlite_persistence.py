from __future__ import annotations

import hashlib
import os
import stat
from dataclasses import replace
from datetime import timedelta
from importlib.resources import files

import pytest

from diandianreading.domain import (
    Book,
    BookStatus,
    ErrorCode,
    ExternalSource,
    ExternalWorkspace,
    InvalidStateTransition,
    Job,
    JobPayload,
    JobStatus,
    JobStep,
    JobStepRecord,
    KnowledgeStatus,
    PreparationManifest,
    RemoteOperation,
    RemoteOperationKind,
    RemoteOperationStatus,
    RemoteProbeStrategy,
    RepositoryConflict,
    StorageKey,
    UnsafePathError,
)
from diandianreading.infrastructure.persistence import (
    SQLiteCatalogRepository,
    SQLiteDatabase,
    SQLiteJobPayloadRepository,
    SQLiteJobRepository,
    SQLiteJobStepRepository,
    SQLiteKnowledgeMappingRepository,
    SQLiteRemoteOperationRepository,
    SQLiteUnitOfWorkFactory,
)
from tests.support import FIXED_NOW, make_import_command


def make_database(tmp_path) -> SQLiteDatabase:
    database = SQLiteDatabase(tmp_path / "state" / "app.sqlite3")
    database.migrate()
    return database


def make_operation(job_id: str) -> RemoteOperation:
    return RemoteOperation(
        id="operation-1",
        job_id=job_id,
        step=JobStep.CREATING_WORKSPACE,
        provider="fake",
        credential_profile="test",
        kind=RemoteOperationKind.ENSURE_WORKSPACE,
        idempotency_key="workspace-key",
        local_resource_id="book-1",
        input_hash="workspace-hash",
        probe_strategy=RemoteProbeStrategy.AUTHORITATIVE_OPERATION_KEY,
        baseline_snapshot_redacted="{}",
        request_summary_redacted='{"kind":"ensure_workspace"}',
        status=RemoteOperationStatus.PREPARED,
        dispatch_attempt=0,
        external_id=None,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
        dispatched_at=None,
        resolved_at=None,
        version=0,
    )


def test_migrations_are_idempotent_verified_and_database_is_private(tmp_path) -> None:
    database = make_database(tmp_path)
    assert database.migrate() == 4
    assert database.schema_version() == 4
    assert database.integrity_check()
    if os.name != "nt":
        assert stat.S_IMODE(database.path.stat().st_mode) == 0o600
        assert stat.S_IMODE(database.path.parent.stat().st_mode) == 0o700

    with database.connect() as connection:
        tables = {
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
    assert {"jobs", "job_events", "job_steps", "job_payloads", "remote_operations"} <= tables

    with database.connect(immediate=True) as connection:
        connection.execute("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1")
    with pytest.raises(RuntimeError, match="does not match"):
        database.migrate()


def test_schema_v3_data_migrates_to_recoverable_v4_states(tmp_path) -> None:
    database = SQLiteDatabase(tmp_path / "state" / "app.sqlite3")
    migration_root = files("diandianreading.infrastructure.persistence.migrations")
    with database.connect() as connection:
        connection.execute(
            """
            CREATE TABLE schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                checksum TEXT NOT NULL,
                applied_at TEXT NOT NULL
            )
            """
        )
        for version, name in (
            (1, "0001_initial.sql"),
            (2, "0002_document_preparation.sql"),
            (3, "0003_notebooklm_operations.sql"),
        ):
            sql = migration_root.joinpath(name).read_text(encoding="utf-8")
            connection.executescript(sql)
            connection.execute(
                """
                INSERT INTO schema_migrations(version, name, checksum, applied_at)
                VALUES (?, ?, ?, ?)
                """,
                (
                    version,
                    name,
                    hashlib.sha256(sql.encode()).hexdigest(),
                    FIXED_NOW.isoformat(),
                ),
            )
        connection.execute(
            """
            INSERT INTO books(id, title, author, source_hash, status, created_at, updated_at)
            VALUES ('book-v3', 'Legacy Book', NULL, 'legacy-hash', 'failed', ?, ?)
            """,
            (FIXED_NOW.isoformat(), FIXED_NOW.isoformat()),
        )
        connection.execute(
            """
            INSERT INTO jobs(
                id, job_type, input_hash, status, step, attempt,
                progress_current, progress_total, error_code, error_message,
                book_id, created_at, updated_at, started_at, completed_at, version
            ) VALUES (
                'job-v3', 'import_book', 'input-hash', 'failed_retryable', 'uploading', 2,
                1, 2, 'REMOTE_UNAVAILABLE', 'legacy offline',
                'book-v3', ?, ?, ?, ?, 3
            )
            """,
            (
                FIXED_NOW.isoformat(),
                FIXED_NOW.isoformat(),
                FIXED_NOW.isoformat(),
                FIXED_NOW.isoformat(),
            ),
        )
        connection.execute(
            """
            INSERT INTO job_events(
                job_id, from_status, to_status, step, attempt,
                progress_current, progress_total, error_code, error_message,
                version, created_at
            ) VALUES (
                'job-v3', 'running', 'failed_retryable', 'uploading', 2,
                1, 2, 'REMOTE_UNAVAILABLE', 'legacy offline', 3, ?
            )
            """,
            (FIXED_NOW.isoformat(),),
        )
        for operation in (
            (
                "operation-pending",
                "add_source",
                "pending-key",
                "part-v3",
                "part-hash",
                "pending",
                None,
                0,
            ),
            (
                "operation-completed",
                "ensure_workspace",
                "completed-key",
                "book-v3",
                "workspace-hash",
                "completed",
                "external-workspace",
                1,
            ),
            (
                "operation-ambiguous",
                "add_source",
                "ambiguous-key",
                "part-other",
                "other-hash",
                "reconciliation_required",
                None,
                2,
            ),
        ):
            connection.execute(
                """
                INSERT INTO remote_operations(
                    id, job_id, kind, idempotency_key, local_resource_id,
                    input_hash, status, external_id, created_at, updated_at, version
                ) VALUES (?, 'job-v3', ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (*operation[:7], FIXED_NOW.isoformat(), FIXED_NOW.isoformat(), operation[7]),
            )

    assert database.schema_version() == 3
    assert database.migrate() == 4
    migrated_job = SQLiteJobRepository(database).get("job-v3")
    assert migrated_job is not None
    assert migrated_job.status is JobStatus.FAILED
    assert migrated_job.current_step is JobStep.UPLOADING
    assert migrated_job.retriable is True
    assert migrated_job.completed_at == FIXED_NOW
    assert migrated_job.lease_generation == 0
    event = SQLiteJobRepository(database).list_events("job-v3")[0]
    assert event.from_status is JobStatus.QUEUED
    assert event.to_status is JobStatus.FAILED
    assert event.retriable is True

    migrated_operations = {
        operation.id: operation
        for operation in SQLiteRemoteOperationRepository(database).list_for_job("job-v3")
    }
    assert migrated_operations["operation-pending"].status is RemoteOperationStatus.PREPARED
    assert migrated_operations["operation-pending"].step is JobStep.UPLOADING
    assert migrated_operations["operation-completed"].status is RemoteOperationStatus.SUCCEEDED
    assert migrated_operations["operation-completed"].external_id == "external-workspace"
    assert migrated_operations["operation-ambiguous"].status is RemoteOperationStatus.AMBIGUOUS
    assert (
        migrated_operations["operation-completed"].probe_strategy is RemoteProbeStrategy.EXTERNAL_ID
    )
    assert (
        migrated_operations["operation-pending"].probe_strategy is RemoteProbeStrategy.UNSUPPORTED
    )
    assert (
        migrated_operations["operation-ambiguous"].probe_strategy is RemoteProbeStrategy.UNSUPPORTED
    )
    assert database.integrity_check()


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


def test_catalog_and_mapping_repositories_round_trip_and_prevent_status_regression(
    tmp_path,
) -> None:
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
    derived = replace(
        command.asset,
        id="asset-derived",
        storage_key=StorageKey("derived/asset-1/derived.md"),
        display_filename="derived.md",
        sha256="derived-hash",
        derived_from_asset_id=command.asset.id,
    )
    catalog.add_asset(book.id, derived)
    for part in command.parts:
        catalog.add_part(part)
    manifest = PreparationManifest(
        root_asset_id=command.asset.id,
        storage_key=StorageKey("manifests/asset-1/manifest.json"),
        sha256="manifest-hash",
    )
    catalog.add_manifest(book.id, manifest)
    ready_book = replace(book, status=BookStatus.READY)
    catalog.update_book(ready_book)

    assert catalog.get_book(book.id) == ready_book
    assert set(catalog.list_assets(book.id)) == {command.asset, derived}
    assert tuple(catalog.list_parts(book.id)) == command.parts
    assert catalog.get_manifest(command.asset.id) == manifest
    assert catalog.get_manifest("missing") is None
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
    assert mappings.get_workspace_for_book(book.id) == ready_workspace
    assert mappings.get_workspace("missing") is None
    assert mappings.get_workspace_for_book("missing") is None
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


def test_asset_and_manifest_repositories_reject_missing_or_cross_book_roots(tmp_path) -> None:
    database = make_database(tmp_path)
    catalog = SQLiteCatalogRepository(database)
    command = make_import_command(tmp_path, part_count=1)
    first_book = Book(
        id="book-1",
        title=command.title,
        author=command.author,
        source_hash=command.asset.sha256,
        status=BookStatus.IMPORTING,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
    )
    second_book = replace(first_book, id="book-2", source_hash="second-book-hash")
    catalog.add_book(first_book)
    catalog.add_book(second_book)
    catalog.add_asset(first_book.id, command.asset)

    derived = replace(
        command.asset,
        id="derived-asset",
        storage_key=StorageKey("derived/asset-1/derived.md"),
        sha256="derived-hash",
        derived_from_asset_id=command.asset.id,
    )
    with pytest.raises(RepositoryConflict, match="parent is not owned"):
        catalog.add_asset(second_book.id, derived)
    with pytest.raises(RepositoryConflict, match="parent is not owned"):
        catalog.add_asset(
            first_book.id,
            replace(derived, id="missing-parent-derived", derived_from_asset_id="missing-asset"),
        )

    manifest = PreparationManifest(
        root_asset_id=command.asset.id,
        storage_key=StorageKey("manifests/asset-1/manifest.json"),
        sha256="manifest-hash",
    )
    with pytest.raises(RepositoryConflict, match="not owned"):
        catalog.add_manifest(second_book.id, manifest)
    with pytest.raises(RepositoryConflict, match="not owned"):
        catalog.add_manifest(
            first_book.id,
            replace(manifest, root_asset_id="missing-asset"),
        )

    assert catalog.list_assets(second_book.id) == ()
    assert catalog.get_manifest(command.asset.id) is None


def test_job_step_payload_and_operation_repositories_preserve_history(tmp_path) -> None:
    database = make_database(tmp_path)
    jobs = SQLiteJobRepository(database)
    steps = SQLiteJobStepRepository(database)
    payloads = SQLiteJobPayloadRepository(database)
    operations = SQLiteRemoteOperationRepository(database)
    job = Job.create(
        job_id="job-1",
        job_type="import_book",
        input_hash="payload-hash",
        now=FIXED_NOW,
    )
    jobs.add(job)
    payload = JobPayload(
        job_id=job.id,
        payload_type="import_book.v1",
        payload_json='{"title":"Book"}',
        input_hash=job.input_hash,
        created_at=FIXED_NOW,
    )
    payloads.add(payload)
    payloads.add(payload)
    assert payloads.get(job.id) == payload
    assert payloads.get("missing") is None
    with pytest.raises(RepositoryConflict, match="payload collision"):
        payloads.add(replace(payload, payload_json='{"title":"Other"}'))

    claimed = jobs.claim(
        job.id,
        "worker-a",
        lease_expires_at=FIXED_NOW + timedelta(minutes=5),
        now=FIXED_NOW,
    )
    acquiring = claimed.begin_step(JobStep.ACQUIRING, claimed.lease_token, now=FIXED_NOW)
    jobs.save_transition(claimed, acquiring)
    record = JobStepRecord.start(
        job_id=job.id,
        step=JobStep.ACQUIRING,
        attempt=1,
        input_hash="asset-hash",
        now=FIXED_NOW,
    )
    steps.add(record, acquiring.lease_token)
    completed_record = record.complete("asset://asset-1", now=FIXED_NOW)
    steps.save(record, completed_record, acquiring.lease_token)
    assert steps.get(job.id, JobStep.ACQUIRING, 1) == completed_record
    assert steps.latest(job.id, JobStep.ACQUIRING) == completed_record
    assert tuple(steps.list(job.id)) == (completed_record,)

    operation = make_operation(job.id)
    with pytest.raises(RepositoryConflict, match="requires a Lease"):
        operations.add(operation)
    operations.add(operation, acquiring.lease_token)
    operations.add(operation, acquiring.lease_token)
    dispatched = operation.dispatch(now=FIXED_NOW + timedelta(seconds=1))
    operations.save(operation, dispatched, acquiring.lease_token)
    succeeded = dispatched.succeed("external-workspace", now=FIXED_NOW + timedelta(seconds=2))
    operations.save(dispatched, succeeded, acquiring.lease_token)
    assert operations.get_by_idempotency_key("workspace-key") == succeeded
    assert tuple(operations.list_for_job(job.id)) == (succeeded,)
    assert operations.get_by_idempotency_key("missing") is None
    with pytest.raises(RepositoryConflict, match="key collision"):
        operations.add(replace(operation, id="different"), acquiring.lease_token)
    with pytest.raises(RepositoryConflict, match="matching version"):
        operations.save(dispatched, replace(succeeded, version=5), acquiring.lease_token)

    failed = acquiring.fail(
        ErrorCode.REMOTE_PROTOCOL_DRIFT,
        "protocol drift",
        acquiring.lease_token,
        retriable=False,
        now=FIXED_NOW + timedelta(seconds=3),
    )
    jobs.save_transition(acquiring, failed)
    retried = failed.retry(now=FIXED_NOW + timedelta(seconds=4))
    jobs.save_transition(failed, retried)

    assert jobs.get(job.id) == retried
    events = jobs.list_events(job.id)
    assert [event.version for event in events] == [0, 1, 2, 3, 4]
    assert events[3].error_detail_redacted == "protocol drift"
    assert events[3].attempt == 1
    assert events[4].to_status is JobStatus.QUEUED

    with pytest.raises(RepositoryConflict, match="atomic claim"):
        jobs.save_transition(job, replace(claimed, version=3))
    with pytest.raises(RepositoryConflict, match="changed or fenced"):
        jobs.save_transition(acquiring, failed)
    assert jobs.get("missing") is None


def test_expired_lease_takeover_fences_old_job_step_and_operation_writes(tmp_path) -> None:
    database = make_database(tmp_path)
    jobs = SQLiteJobRepository(database)
    steps = SQLiteJobStepRepository(database)
    operations = SQLiteRemoteOperationRepository(database)
    job = Job.create(
        job_id="job-fenced",
        job_type="import_book",
        input_hash="hash",
        now=FIXED_NOW,
    )
    jobs.add(job)
    first_expiry = FIXED_NOW + timedelta(seconds=5)
    first = jobs.claim(
        job.id,
        "worker-a",
        lease_expires_at=first_expiry,
        now=FIXED_NOW,
    )
    begun = first.begin_step(JobStep.ACQUIRING, first.lease_token, now=FIXED_NOW)
    jobs.save_transition(first, begun)
    record = JobStepRecord.start(
        job_id=job.id,
        step=JobStep.ACQUIRING,
        attempt=1,
        input_hash="hash",
        now=FIXED_NOW,
    )
    steps.add(record, begun.lease_token)
    operation = make_operation(job.id)
    operations.add(operation, begun.lease_token)

    with pytest.raises(InvalidStateTransition, match="unexpired"):
        jobs.claim(
            job.id,
            "worker-b",
            lease_expires_at=first_expiry + timedelta(minutes=1),
            now=first_expiry - timedelta(microseconds=1),
        )

    taken_over = jobs.claim(
        job.id,
        "worker-b",
        lease_expires_at=first_expiry + timedelta(minutes=1),
        now=first_expiry,
    )
    assert taken_over.lease_generation == begun.lease_generation + 1
    assert taken_over.lease_owner == "worker-b"

    with pytest.raises(RepositoryConflict, match="stale"):
        jobs.assert_lease(job.id, begun.lease_token)
    jobs.assert_lease(job.id, taken_over.lease_token)

    with pytest.raises(InvalidStateTransition, match="stale"):
        jobs.heartbeat(
            job.id,
            begun.lease_token,
            lease_expires_at=first_expiry + timedelta(minutes=2),
            now=first_expiry,
        )
    with pytest.raises(RepositoryConflict, match="stale"):
        steps.save(record, record.complete("asset://done"), begun.lease_token)
    with pytest.raises(RepositoryConflict, match="stale"):
        operations.save(operation, operation.dispatch(), begun.lease_token)

    renewed = jobs.heartbeat(
        job.id,
        taken_over.lease_token,
        lease_expires_at=first_expiry + timedelta(minutes=2),
        now=first_expiry,
    )
    completed_record = record.complete("asset://done", now=first_expiry)
    steps.save(record, completed_record, renewed.lease_token)
    dispatched = operation.dispatch(now=first_expiry)
    operations.save(operation, dispatched, renewed.lease_token)
    assert steps.latest(job.id, JobStep.ACQUIRING) == completed_record
    assert operations.get_by_idempotency_key(operation.idempotency_key) == dispatched


def test_unit_of_work_rolls_back_related_book_job_and_claim_changes(tmp_path) -> None:
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
        claimed = unit_of_work.jobs.claim(
            job.id,
            "worker-a",
            lease_expires_at=FIXED_NOW + timedelta(minutes=5),
            now=FIXED_NOW,
        )
        begun = claimed.begin_step(JobStep.ACQUIRING, claimed.lease_token, now=FIXED_NOW)
        unit_of_work.jobs.save_transition(claimed, replace(begun, version=5))
        unit_of_work.commit()

    assert SQLiteCatalogRepository(database).get_book(book.id) == book
    assert SQLiteJobRepository(database).get(job.id) == job
