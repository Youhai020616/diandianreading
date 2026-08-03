"""Browser-free Phase 2 E2E composition for the NotebookLM Python adapter."""

from __future__ import annotations

import json
import os
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

from diandianreading.application.ports import (
    AcquisitionRequest,
    ProgressSink,
    download_input_hash,
    generation_input_hash,
)
from diandianreading.application.use_cases import ImportBookCommand, ImportBookUseCase
from diandianreading.domain import (
    BookStatus,
    CredentialRef,
    JobStatus,
    JobStep,
    KnowledgeStatus,
    ProgressEvent,
    RemoteOperation,
    RemoteOperationKind,
    RemoteOperationRef,
    RemoteOperationStatus,
    RemoteProbeStrategy,
    StorageKey,
    TargetCapabilities,
    UnsafePathError,
    utc_now,
)
from diandianreading.infrastructure.acquisition import LocalFileAcquirer
from diandianreading.infrastructure.documents import LocalDocumentPreparationAdapter
from diandianreading.infrastructure.fakes import (
    DeterministicNotebookLMService,
    FakeNotebookLMClientFactory,
)
from diandianreading.infrastructure.notebooklm import CredentialPathResolver, NotebookLMAdapter
from diandianreading.infrastructure.persistence import (
    SQLiteCatalogRepository,
    SQLiteDatabase,
    SQLiteJobRepository,
    SQLiteKnowledgeMappingRepository,
    SQLiteRemoteOperationRepository,
    SQLiteUnitOfWorkFactory,
)
from diandianreading.infrastructure.storage import LocalFileStore


@dataclass(slots=True)
class Phase2ProgressSink(ProgressSink):
    events: list[ProgressEvent]
    scope_id: str = "phase2-notebooklm"

    @property
    def job_id(self) -> str:
        return self.scope_id

    async def emit(self, event: ProgressEvent) -> None:
        self.events.append(event)


async def run_phase2_demo(
    database_path: Path,
    object_root: Path,
    credentials_root: Path,
    workspace_path: Path,
) -> dict[str, object]:
    """Exercise import, citation recovery, generation, and download without a browser."""

    database_path = _absolute_path(database_path)
    object_root = _absolute_path(object_root)
    credentials_root = _absolute_path(credentials_root)
    workspace_path = _absolute_path(workspace_path)
    _require_disjoint_new_paths(
        database_path,
        object_root,
        credentials_root,
        workspace_path,
    )

    database = SQLiteDatabase.create_new(database_path)
    schema_version = database.migrate()
    workspace_path.mkdir(mode=0o700, parents=True, exist_ok=False)
    if os.name != "nt":
        workspace_path.chmod(0o700)
    store = LocalFileStore(object_root)
    source_path = workspace_path / "phase2-source.md"
    _write_private_text(
        source_path,
        "# Durable Reading\n\n"
        "A recoverable workflow records intent before every remote write.\n\n"
        "## Citations\n\n"
        "A citation must map from the provider source back to a local document part.\n",
    )

    credential = CredentialRef("notebooklm", "phase2-e2e")
    credential_resolver = CredentialPathResolver(credentials_root)
    storage_state = credential_resolver.prepare_profile_directory(credential) / "storage_state.json"
    _write_private_text(storage_state, json.dumps({"cookies": [], "origins": []}))

    progress = Phase2ProgressSink(events=[])
    acquired = await LocalFileAcquirer(store).acquire(
        AcquisitionRequest(
            provider="local",
            location=str(source_path),
            rights_confirmed=True,
            options={"rights_provenance_id": "rights-phase2-local-fixture"},
        ),
        progress,
    )
    capabilities = TargetCapabilities(
        max_source_words=20,
        max_source_bytes=300,
        max_sources_per_workspace=50,
        accepted_mime_types=frozenset({"text/markdown"}),
    )
    prepared = await LocalDocumentPreparationAdapter(store).prepare(
        acquired.asset,
        capabilities,
        progress,
    )

    service = DeterministicNotebookLMService()
    observed_write_intents: list[str] = []
    expected_kinds = {
        "notebooks.create": RemoteOperationKind.ENSURE_WORKSPACE,
        "sources.add_file": RemoteOperationKind.ADD_SOURCE,
        "artifacts.generate_report": RemoteOperationKind.GENERATE_CONTENT,
        "artifacts.download_report": RemoteOperationKind.DOWNLOAD_CONTENT,
    }

    def verify_pre_call_intent(method: str) -> None:
        kind = expected_kinds.get(method)
        if kind is None:
            return
        with database.connect() as connection:
            row = connection.execute(
                """
                SELECT COUNT(*) FROM remote_operations
                WHERE kind = ? AND status = 'dispatched'
                """,
                (kind.value,),
            ).fetchone()
        if row is None or int(row[0]) < 1:
            raise RuntimeError(f"Phase 2 E2E failed: missing pre-call intent for {kind.value}")
        observed_write_intents.append(kind.value)

    service.before_call_observer = verify_pre_call_intent
    factory = FakeNotebookLMClientFactory(service)
    mappings = SQLiteKnowledgeMappingRepository(database)
    staging_root = workspace_path / "staging"
    first_adapter = NotebookLMAdapter(
        credential_resolver=credential_resolver,
        file_store=store,
        mappings=mappings,
        staging_root=staging_root,
        client_factory=factory,
    )
    async with first_adapter:
        initial_health = await first_adapter.health_check(credential)
        if not initial_health.healthy or initial_health.notebook_count != 0:
            raise RuntimeError("Phase 2 E2E failed: initial profile health was not valid")
        metadata_asset = prepared.derived_assets[-1] if prepared.derived_assets else acquired.asset
        result = await ImportBookUseCase(
            unit_of_work=SQLiteUnitOfWorkFactory(database),
            knowledge=first_adapter,
        ).execute(
            ImportBookCommand(
                title=metadata_asset.title or "Phase 2 NotebookLM Adapter",
                author=metadata_asset.author,
                asset=acquired.asset,
                parts=prepared.parts,
                credential=credential,
                derived_assets=prepared.derived_assets,
                manifest=prepared.manifest,
            ),
            progress,
        )

    reopened = SQLiteDatabase(database_path)
    if reopened.schema_version() != schema_version:
        raise RuntimeError("Phase 2 E2E failed: schema version changed after reopening SQLite")
    persisted_book = SQLiteCatalogRepository(reopened).get_book(result.book.id)
    persisted_job = SQLiteJobRepository(reopened).get(result.job.id)
    persisted_sources = SQLiteKnowledgeMappingRepository(reopened).list_sources(result.workspace.id)
    if persisted_book is None or persisted_book.status is not BookStatus.READY:
        raise RuntimeError("Phase 2 E2E failed: ready Book was not persisted")
    if persisted_job is None or persisted_job.status is not JobStatus.COMPLETED:
        raise RuntimeError("Phase 2 E2E failed: completed import Job was not persisted")
    if len(persisted_sources) != len(prepared.parts) or any(
        source.status is not KnowledgeStatus.READY for source in persisted_sources
    ):
        raise RuntimeError("Phase 2 E2E failed: ready source mappings were not persisted")

    operations = SQLiteRemoteOperationRepository(reopened)
    second_adapter = NotebookLMAdapter(
        credential_resolver=credential_resolver,
        file_store=store,
        mappings=SQLiteKnowledgeMappingRepository(reopened),
        staging_root=staging_root,
        client_factory=factory,
    )
    async with second_adapter:
        recovered_health = await second_adapter.health_check(credential)
        if not recovered_health.healthy or recovered_health.notebook_count != 1:
            raise RuntimeError("Phase 2 E2E failed: reopened profile health was not valid")
        answer = await second_adapter.ask(
            result.workspace,
            "Why must remote intent be durable?",
            [source.external_id for source in result.sources],
            None,
        )
        expected_part_ids = {part.id for part in prepared.parts}
        if {reference.document_part_id for reference in answer.references} != expected_part_ids:
            raise RuntimeError("Phase 2 E2E failed: citations did not recover local part mappings")

        instructions = "Summarize the durable intent and citation invariants"
        generation_operation = _persist_operation(
            operations,
            job_id=result.job.id,
            kind=RemoteOperationKind.GENERATE_CONTENT,
            local_resource_id=result.workspace.id,
            input_hash=generation_input_hash("report", instructions),
        )
        dispatched_generation = generation_operation.dispatch()
        operations.save(generation_operation, dispatched_generation)
        handle = await second_adapter.generate(
            result.workspace,
            "report",
            instructions,
            _operation_ref(dispatched_generation),
        )
        operations.save(
            dispatched_generation,
            dispatched_generation.succeed(handle.id),
        )
        content = await second_adapter.wait(handle)

        destination = StorageKey(f"derived/generated/{content.id}.md")
        download_operation = _persist_operation(
            operations,
            job_id=result.job.id,
            kind=RemoteOperationKind.DOWNLOAD_CONTENT,
            local_resource_id=content.id,
            input_hash=download_input_hash(content, destination),
        )
        dispatched_download = download_operation.dispatch()
        operations.save(download_operation, dispatched_download)
        generated_asset = await second_adapter.download(
            content,
            destination,
            _operation_ref(dispatched_download),
        )
        operations.save(
            dispatched_download,
            dispatched_download.succeed(content.id),
        )

    generated_object = store.stat(generated_asset.storage_key)
    if (
        generated_object.sha256 != generated_asset.sha256
        or generated_object.size_bytes != generated_asset.size_bytes
    ):
        raise RuntimeError("Phase 2 E2E failed: downloaded content object was not verified")
    if any(staging_root.iterdir()):
        raise RuntimeError("Phase 2 E2E failed: artifact staging was not cleaned")

    with reopened.connect() as connection:
        operation_rows = connection.execute(
            "SELECT kind, status FROM remote_operations ORDER BY created_at, kind"
        ).fetchall()
        workspace_columns = {
            str(row[1]) for row in connection.execute("PRAGMA table_info(external_workspaces)")
        }
    expected_operation_count = len(prepared.parts) + 3
    if len(operation_rows) != expected_operation_count or any(
        str(row["status"]) != RemoteOperationStatus.SUCCEEDED.value for row in operation_rows
    ):
        raise RuntimeError("Phase 2 E2E failed: remote operation intents were incomplete")
    expected_observed_writes = len(prepared.parts) + 3
    if len(observed_write_intents) != expected_observed_writes:
        raise RuntimeError("Phase 2 E2E failed: provider writes bypassed intent observation")
    if "storage_path" in workspace_columns:
        raise RuntimeError("Phase 2 E2E failed: credential path entered the business schema")
    if service.opened_storage_paths != [storage_state, storage_state]:
        raise RuntimeError("Phase 2 E2E failed: SDK did not receive the explicit credential path")
    expected_upload_paths = [store.resolve_for_read(part.storage_key) for part in prepared.parts]
    if service.uploaded_paths != expected_upload_paths:
        raise RuntimeError("Phase 2 E2E failed: SDK did not receive verified part paths")
    if service.open_count != 2 or service.close_count != 2:
        raise RuntimeError("Phase 2 E2E failed: per-adapter client lifecycle was not closed")
    if not reopened.integrity_check():
        raise RuntimeError("Phase 2 E2E failed: SQLite integrity check failed")

    return {
        "status": "ok",
        "schema_version": schema_version,
        "book_count": 1,
        "part_count": len(prepared.parts),
        "source_count": len(persisted_sources),
        "citation_count": len(answer.references),
        "generated_content_count": 1,
        "downloaded_asset_count": 1,
        "remote_operation_count": len(operation_rows),
        "provider_write_intent_count": len(observed_write_intents),
        "client_open_count": service.open_count,
        "client_close_count": service.close_count,
        "progress_event_count": len(progress.events),
        "database": str(database_path),
    }


def _persist_operation(
    repository: SQLiteRemoteOperationRepository,
    *,
    job_id: str,
    kind: RemoteOperationKind,
    local_resource_id: str,
    input_hash: str,
) -> RemoteOperation:
    idempotency_key = f"{job_id}:{kind.value}:{local_resource_id}:{input_hash}"
    timestamp = utc_now()
    operation = RemoteOperation(
        id=str(uuid5(NAMESPACE_URL, f"phase2-operation:{idempotency_key}")),
        job_id=job_id,
        step=JobStep.VERIFYING,
        provider="notebooklm",
        credential_profile="phase2-e2e",
        kind=kind,
        idempotency_key=idempotency_key,
        local_resource_id=local_resource_id,
        input_hash=input_hash,
        probe_strategy=RemoteProbeStrategy.UNSUPPORTED,
        baseline_snapshot_redacted="{}",
        request_summary_redacted=json.dumps(
            {"kind": kind.value, "local_resource_id": local_resource_id},
            sort_keys=True,
        ),
        status=RemoteOperationStatus.PREPARED,
        dispatch_attempt=0,
        external_id=None,
        created_at=timestamp,
        updated_at=timestamp,
        dispatched_at=None,
        resolved_at=None,
        version=0,
    )
    repository.add(operation)
    return operation


def _operation_ref(operation: RemoteOperation) -> RemoteOperationRef:
    return RemoteOperationRef(
        id=operation.id,
        idempotency_key=operation.idempotency_key,
        kind=operation.kind,
        local_resource_id=operation.local_resource_id,
        input_hash=operation.input_hash,
        external_id=operation.external_id,
    )


def _absolute_path(path: Path) -> Path:
    return Path(os.path.abspath(path.expanduser()))


def _require_disjoint_new_paths(
    database: Path,
    object_root: Path,
    credentials_root: Path,
    workspace: Path,
) -> None:
    labelled_paths = (
        ("object root", object_root),
        ("credentials root", credentials_root),
        ("workspace", workspace),
    )
    for label, path in labelled_paths:
        if path.exists() or path.is_symlink():
            raise FileExistsError(f"Refusing to overwrite existing Phase 2 {label}")
    paths = (database, object_root, credentials_root, workspace)
    for index, path in enumerate(paths):
        for other in paths[index + 1 :]:
            if path == other or path in other.parents or other in path.parents:
                raise UnsafePathError("Phase 2 database and data roots must be disjoint")


def _write_private_text(path: Path, content: str) -> None:
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
    except BaseException:
        with suppress(OSError):
            os.close(descriptor)
        path.unlink(missing_ok=True)
        raise
