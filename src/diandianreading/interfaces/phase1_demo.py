"""Browser-free Phase 1 composition for real local document preparation."""

from __future__ import annotations

import hashlib
import io
import json
import os
import zipfile
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from diandianreading.application.ports import AcquisitionRequest, PreparedDocument, ProgressSink
from diandianreading.application.use_cases import (
    ImportBookCommand,
    ImportBookResult,
    ImportBookUseCase,
)
from diandianreading.domain import (
    BookStatus,
    CredentialRef,
    JobStatus,
    KnowledgeStatus,
    ProgressEvent,
    TargetCapabilities,
    UnsafePathError,
)
from diandianreading.infrastructure.acquisition import LocalFileAcquirer
from diandianreading.infrastructure.documents import LocalDocumentPreparationAdapter
from diandianreading.infrastructure.fakes import FakeKnowledgeAdapter
from diandianreading.infrastructure.persistence import (
    SQLiteCatalogRepository,
    SQLiteDatabase,
    SQLiteJobRepository,
    SQLiteKnowledgeMappingRepository,
    SQLiteUnitOfWorkFactory,
)
from diandianreading.infrastructure.storage import LocalFileStore


@dataclass(slots=True)
class Phase1ProgressSink(ProgressSink):
    events: list[ProgressEvent]
    scope_id: str = "phase1-preparation"

    @property
    def job_id(self) -> str:
        return self.scope_id

    async def emit(self, event: ProgressEvent) -> None:
        self.events.append(event)


async def run_phase1_demo(
    database_path: Path,
    object_root: Path,
    workspace_path: Path,
) -> dict[str, object]:
    """Import Markdown, EPUB, and PDF through real preparation and fake knowledge."""

    database_path = _absolute_path(database_path)
    object_root = _absolute_path(object_root)
    workspace_path = _absolute_path(workspace_path)
    _require_disjoint_new_paths(database_path, object_root, workspace_path)

    database = SQLiteDatabase.create_new(database_path)
    schema_version = database.migrate()
    workspace_path.mkdir(mode=0o700, parents=True, exist_ok=False)
    if os.name != "nt":
        workspace_path.chmod(0o700)
    store = LocalFileStore(object_root)

    fixtures = (
        ("phase1-markdown.md", _markdown_fixture()),
        ("phase1-book.epub", _epub_fixture()),
        ("phase1-paper.pdf", _pdf_fixture()),
    )
    fixture_paths: list[Path] = []
    for filename, content in fixtures:
        path = workspace_path / filename
        _write_private_bytes(path, content)
        fixture_paths.append(path)

    capabilities = TargetCapabilities(
        max_source_words=8,
        max_source_bytes=120,
        max_sources_per_workspace=50,
        accepted_mime_types=frozenset({"text/markdown", "application/pdf"}),
    )
    progress = Phase1ProgressSink(events=[])
    acquirer = LocalFileAcquirer(store)
    preparation = LocalDocumentPreparationAdapter(store)
    knowledge = FakeKnowledgeAdapter()
    use_case = ImportBookUseCase(
        unit_of_work=SQLiteUnitOfWorkFactory(database),
        knowledge=knowledge,
    )

    results: list[ImportBookResult] = []
    prepared_documents: list[PreparedDocument] = []
    for path in fixture_paths:
        acquired = await acquirer.acquire(
            AcquisitionRequest(
                provider="local",
                location=str(path),
                rights_confirmed=True,
                options={"rights_provenance_id": f"rights-phase1-{path.suffix[1:]}"},
            ),
            progress,
        )
        prepared = await preparation.prepare(acquired.asset, capabilities, progress)
        metadata_asset = prepared.derived_assets[-1] if prepared.derived_assets else acquired.asset
        result = await use_case.execute(
            ImportBookCommand(
                title=metadata_asset.title or "Phase 1 Document",
                author=metadata_asset.author,
                asset=acquired.asset,
                parts=prepared.parts,
                credential=CredentialRef(provider="fake", profile="phase1-e2e"),
                derived_assets=prepared.derived_assets,
                manifest=prepared.manifest,
            ),
            progress,
        )
        results.append(result)
        prepared_documents.append(prepared)

    reopened = SQLiteDatabase(database_path)
    if reopened.schema_version() != schema_version:
        raise RuntimeError("Phase 1 E2E failed: schema version changed after reopening SQLite")
    catalog = SQLiteCatalogRepository(reopened)
    jobs = SQLiteJobRepository(reopened)
    mappings = SQLiteKnowledgeMappingRepository(reopened)
    part_count = 0
    asset_count = 0
    source_count = 0
    manifest_count = 0
    for result, prepared in zip(results, prepared_documents, strict=True):
        book = catalog.get_book(result.book.id)
        job = jobs.get(result.job.id)
        assets = catalog.list_assets(result.book.id)
        parts = catalog.list_parts(result.book.id)
        manifest = catalog.get_manifest(prepared.manifest.root_asset_id)
        sources = mappings.list_sources(result.workspace.id)
        if book is None or book.status is not BookStatus.READY:
            raise RuntimeError("Phase 1 E2E failed: ready Book was not persisted")
        if job is None or job.status is not JobStatus.COMPLETED:
            raise RuntimeError("Phase 1 E2E failed: completed Job was not persisted")
        if len(assets) != 1 + len(prepared.derived_assets):
            raise RuntimeError("Phase 1 E2E failed: derived DocumentAssets were not persisted")
        if tuple(parts) != prepared.parts:
            raise RuntimeError(
                "Phase 1 E2E failed: prepared DocumentParts changed after persistence"
            )
        if manifest is None or manifest != prepared.manifest:
            raise RuntimeError("Phase 1 E2E failed: preparation manifest was not persisted")
        if len(sources) != len(parts) or any(
            source.status is not KnowledgeStatus.READY for source in sources
        ):
            raise RuntimeError("Phase 1 E2E failed: source mappings were not ready")
        for stored_asset in assets:
            stored = store.stat(stored_asset.storage_key)
            if stored.size_bytes != stored_asset.size_bytes or stored.sha256 != stored_asset.sha256:
                raise RuntimeError("Phase 1 E2E failed: DocumentAsset object verification failed")
        for part in parts:
            stored = store.stat(part.storage_key)
            if stored.size_bytes != part.size_bytes or stored.sha256 != part.sha256:
                raise RuntimeError("Phase 1 E2E failed: DocumentPart object verification failed")
        with store.open(manifest.storage_key) as manifest_file:
            manifest_bytes = manifest_file.read()
        if not manifest_bytes or hashlib.sha256(manifest_bytes).hexdigest() != manifest.sha256:
            raise RuntimeError("Phase 1 E2E failed: manifest object verification failed")
        if _manifest_root_id(manifest_bytes) != prepared.manifest.root_asset_id:
            raise RuntimeError("Phase 1 E2E failed: manifest root identity changed")
        asset_count += len(assets)
        part_count += len(parts)
        source_count += len(sources)
        manifest_count += 1

    with reopened.connect() as connection:
        operation_row = connection.execute("SELECT COUNT(*) FROM remote_operations").fetchone()
    if operation_row is None:
        raise RuntimeError("Phase 1 E2E failed: remote operations could not be counted")
    operation_count = int(operation_row[0])
    if operation_count != source_count + len(results):
        raise RuntimeError("Phase 1 E2E failed: remote operation intents were incomplete")
    if not reopened.integrity_check():
        raise RuntimeError("Phase 1 E2E failed: SQLite integrity check failed")

    return {
        "status": "ok",
        "schema_version": schema_version,
        "format_count": len(results),
        "book_count": len(results),
        "asset_count": asset_count,
        "manifest_count": manifest_count,
        "part_count": part_count,
        "source_count": source_count,
        "remote_operation_count": operation_count,
        "progress_event_count": len(progress.events),
        "database": str(database_path),
    }


def _require_disjoint_new_paths(database: Path, object_root: Path, workspace: Path) -> None:
    for path, label in ((object_root, "object root"), (workspace, "workspace")):
        if path.exists() or path.is_symlink():
            raise FileExistsError(f"Refusing to overwrite existing Phase 1 {label}: {path}")
    paths = (database, object_root, workspace)
    for index, path in enumerate(paths):
        for other in paths[index + 1 :]:
            if path == other or path in other.parents or other in path.parents:
                raise UnsafePathError(
                    "Phase 1 database, object root, and workspace must be disjoint"
                )


def _manifest_root_id(content: bytes) -> str | None:
    try:
        decoded = cast(object, json.loads(content))
    except (UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(decoded, dict):
        return None
    root = cast(dict[object, object], decoded).get("root_asset")
    if not isinstance(root, dict):
        return None
    root_id = cast(dict[object, object], root).get("id")
    return root_id if isinstance(root_id, str) else None


def _absolute_path(path: Path) -> Path:
    return Path(os.path.abspath(path.expanduser()))


def _write_private_bytes(path: Path, content: bytes) -> None:
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as file:
            _ = file.write(content)
            file.flush()
            os.fsync(file.fileno())
    except BaseException:
        with suppress(OSError):
            os.close(descriptor)
        path.unlink(missing_ok=True)
        raise


def _markdown_fixture() -> bytes:
    return (
        "# Local Markdown\n\n"
        "one two three four five six seven eight nine\n\n"
        "## 第二章\n\n甲乙丙丁戊己庚辛壬癸\n"
    ).encode()


def _pdf_fixture() -> bytes:
    return b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF"


def _epub_fixture() -> bytes:
    container = (
        '<?xml version="1.0"?>'
        '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">'
        '<rootfiles><rootfile full-path="OEBPS/content.opf" '
        'media-type="application/oebps-package+xml"/></rootfiles></container>'
    )
    package = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<package xmlns="http://www.idpf.org/2007/opf" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0">'
        "<metadata><dc:title>Phase 1 EPUB</dc:title>"
        "<dc:creator>diandianreading</dc:creator></metadata>"
        '<manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/>'
        '<item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest>'
        '<spine><itemref idref="one"/><itemref idref="two"/></spine></package>'
    )
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        mimetype = zipfile.ZipInfo("mimetype")
        mimetype.compress_type = zipfile.ZIP_STORED
        archive.writestr(mimetype, "application/epub+zip")
        archive.writestr("META-INF/container.xml", container, compress_type=zipfile.ZIP_DEFLATED)
        archive.writestr("OEBPS/content.opf", package, compress_type=zipfile.ZIP_DEFLATED)
        archive.writestr(
            "OEBPS/one.xhtml",
            "<html><body><h1>One</h1><p>one two three four five</p></body></html>",
            compress_type=zipfile.ZIP_DEFLATED,
        )
        archive.writestr(
            "OEBPS/two.xhtml",
            "<html><body><h1>Two</h1><p>六七八九十</p></body></html>",
            compress_type=zipfile.ZIP_DEFLATED,
        )
    return output.getvalue()
