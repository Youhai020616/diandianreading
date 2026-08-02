"""Local Phase 0 end-to-end composition using only fake external services."""

from __future__ import annotations

import hashlib
import os
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from diandianreading.application.ports import ProgressSink
from diandianreading.application.use_cases import ImportBookCommand, ImportBookUseCase
from diandianreading.domain import (
    BookStatus,
    CredentialRef,
    DocumentAsset,
    DocumentPart,
    JobStatus,
    KnowledgeStatus,
    ProgressEvent,
    SourceOrigin,
    StorageKey,
    TargetCapabilities,
    UnsafePathError,
)
from diandianreading.infrastructure.fakes import (
    FakeDocumentPreparationAdapter,
    FakeKnowledgeAdapter,
)
from diandianreading.infrastructure.persistence import (
    SQLiteCatalogRepository,
    SQLiteDatabase,
    SQLiteJobRepository,
    SQLiteKnowledgeMappingRepository,
    SQLiteUnitOfWorkFactory,
)


@dataclass(slots=True)
class CollectingProgressSink(ProgressSink):
    events: list[ProgressEvent]
    scope_id: str = ""

    @property
    def job_id(self) -> str:
        return self.scope_id

    async def emit(self, event: ProgressEvent) -> None:
        self.events.append(event)


async def run_phase0_demo(database_path: Path, workspace_path: Path) -> dict[str, Any]:
    """Run and verify a complete fake import across process-safe boundaries."""

    database_path = _absolute_path(database_path)
    workspace_path = _absolute_path(workspace_path)
    if workspace_path in database_path.parents:
        raise UnsafePathError("Database must not be created inside the generated workspace")
    if workspace_path.exists() or workspace_path.is_symlink():
        raise FileExistsError(f"Refusing to overwrite existing workspace: {workspace_path}")

    database = SQLiteDatabase.create_new(database_path)
    schema_version = database.migrate()
    workspace_path.mkdir(mode=0o700, exist_ok=False)
    if os.name != "nt":
        workspace_path.chmod(0o700)

    original_path = workspace_path / "phase0-sample.md"
    part_paths = (
        workspace_path / "phase0-sample-part-001.md",
        workspace_path / "phase0-sample-part-002.md",
    )
    part_contents = (
        "# Chapter 1\n\nReading becomes knowledge when its source remains traceable.\n",
        "# Chapter 2\n\nDurable jobs make external side effects recoverable.\n",
    )
    original_content = "\n".join(part_contents)
    _write_private_text(original_path, original_content)
    for path, content in zip(part_paths, part_contents, strict=True):
        _write_private_text(path, content)

    asset_hash = _sha256(original_path)
    asset_id = str(uuid5(NAMESPACE_URL, f"phase0-asset:{asset_hash}"))
    asset = DocumentAsset(
        id=asset_id,
        storage_key=StorageKey(f"originals/{asset_id}"),
        display_filename=original_path.name,
        mime_type="text/markdown",
        size_bytes=original_path.stat().st_size,
        sha256=asset_hash,
        title="Phase 0 Architecture",
        author="diandianreading",
        origin=SourceOrigin.LOCAL,
        origin_locator=None,
        rights_provenance_id="rights-phase0-local-fixture",
    )
    parts = tuple(
        DocumentPart(
            id=str(uuid5(NAMESPACE_URL, f"phase0-part:{asset_hash}:{index}")),
            asset_id=asset.id,
            sequence=index,
            storage_key=StorageKey(f"parts/{asset_id}/{index:04d}"),
            mime_type="text/markdown",
            word_count=len(content.split()),
            sha256=_sha256(path),
            chapter_refs=(f"chapter-{index + 1}",),
            size_bytes=path.stat().st_size,
        )
        for index, (path, content) in enumerate(zip(part_paths, part_contents, strict=True))
    )

    progress = CollectingProgressSink(events=[], scope_id="phase0-preparation")
    capabilities = TargetCapabilities(
        max_source_words=350_000,
        max_source_bytes=10_000_000,
        max_sources_per_workspace=50,
        accepted_mime_types=frozenset({"text/markdown"}),
    )
    prepared = await FakeDocumentPreparationAdapter(parts).prepare(
        asset,
        capabilities,
        progress,
    )
    expected_manifest_key = StorageKey(f"manifests/{asset.id}.json")
    if prepared.manifest_key != expected_manifest_key:
        raise RuntimeError("Phase 0 E2E failed: preparation manifest identity changed")
    if prepared.derived_assets:
        raise RuntimeError("Phase 0 E2E failed: fake preparation returned derived assets")
    if prepared.parts != parts:
        raise RuntimeError("Phase 0 E2E failed: fake preparation changed document parts")
    if len(progress.events) != 1 or progress.events[0].step != "preparing":
        raise RuntimeError("Phase 0 E2E failed: preparation progress was not emitted")

    use_case = ImportBookUseCase(
        unit_of_work=SQLiteUnitOfWorkFactory(database),
        knowledge=FakeKnowledgeAdapter(),
    )
    result = await use_case.execute(
        ImportBookCommand(
            title="Phase 0 Architecture",
            author="diandianreading",
            asset=asset,
            parts=prepared.parts,
            credential=CredentialRef(provider="fake", profile="phase0-e2e"),
        ),
        progress,
    )

    reopened_database = SQLiteDatabase(database_path)
    reopened_catalog = SQLiteCatalogRepository(reopened_database)
    reopened_jobs = SQLiteJobRepository(reopened_database)
    reopened_mappings = SQLiteKnowledgeMappingRepository(reopened_database)
    persisted_job = reopened_jobs.get(result.job.id)
    persisted_book = reopened_catalog.get_book(result.book.id)
    persisted_parts = reopened_catalog.list_parts(result.book.id)
    persisted_workspace = reopened_mappings.get_workspace(result.workspace.id)
    persisted_sources = reopened_mappings.list_sources(result.workspace.id)
    persisted_events = reopened_jobs.list_events(result.job.id)
    with reopened_database.connect() as connection:
        operation_count = int(
            connection.execute(
                "SELECT COUNT(*) FROM remote_operations WHERE job_id = ?",
                (result.job.id,),
            ).fetchone()[0]
        )
        credential_columns = {
            str(row[1]) for row in connection.execute("PRAGMA table_info(external_workspaces)")
        }

    if persisted_job is None or persisted_job.status is not JobStatus.COMPLETED:
        raise RuntimeError("Phase 0 E2E failed: completed Job was not persisted")
    if persisted_book is None or persisted_book.status is not BookStatus.READY:
        raise RuntimeError("Phase 0 E2E failed: ready Book was not persisted")
    if len(persisted_parts) != len(prepared.parts):
        raise RuntimeError("Phase 0 E2E failed: prepared DocumentParts were not persisted")
    if persisted_workspace is None or persisted_workspace.status is not KnowledgeStatus.READY:
        raise RuntimeError("Phase 0 E2E failed: external workspace mapping was not persisted")
    if len(persisted_sources) != len(prepared.parts) or any(
        source.status is not KnowledgeStatus.READY for source in persisted_sources
    ):
        raise RuntimeError("Phase 0 E2E failed: ready source mappings were not persisted")
    if operation_count != len(prepared.parts) + 1:
        raise RuntimeError("Phase 0 E2E failed: remote operation intents were not persisted")
    if "storage_path" in credential_columns:
        raise RuntimeError("Phase 0 E2E failed: credential storage path entered business schema")
    if not reopened_database.integrity_check():
        raise RuntimeError("Phase 0 E2E failed: SQLite integrity check failed")

    return {
        "status": "ok",
        "schema_version": schema_version,
        "book_id": result.book.id,
        "job_id": result.job.id,
        "workspace_id": result.workspace.id,
        "part_count": len(persisted_parts),
        "source_count": len(persisted_sources),
        "preparation_manifest_key": prepared.manifest_key.value,
        "remote_operation_count": operation_count,
        "job_event_count": len(persisted_events),
        "progress_event_count": len(progress.events),
        "database": str(database_path),
    }


def _absolute_path(path: Path) -> Path:
    return Path(os.path.abspath(path.expanduser()))


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


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
