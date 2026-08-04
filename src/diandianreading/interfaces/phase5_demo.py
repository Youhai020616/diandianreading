"""Offline end-to-end proof for the unified CLI/API/Web/worker/chat product."""

from __future__ import annotations

import asyncio
import json
import os
import re
import stat
import warnings
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from diandianreading.application.ports import (
    AcquiredAsset,
    AcquisitionRequest,
    ProgressSink,
)
from diandianreading.application.use_cases.annotations import AnnotationService
from diandianreading.application.use_cases.catalog import CatalogService
from diandianreading.application.use_cases.chat import ChatUseCase
from diandianreading.application.use_cases.content import KnowledgeNoteService
from diandianreading.application.use_cases.import_book import ImportBookUseCase
from diandianreading.application.use_cases.import_source import (
    DurableImportSourceMaterializer,
    ImportSubmissionUseCase,
)
from diandianreading.application.use_cases.jobs import JobService
from diandianreading.application.use_cases.reading import ReadingService
from diandianreading.domain import (
    CredentialRef,
    DiandianError,
    ErrorCode,
    TargetCapabilities,
    utc_now,
)
from diandianreading.infrastructure.acquisition.local import LocalFileAcquirer
from diandianreading.infrastructure.documents import (
    LocalDocumentPreparationAdapter,
    PolicyReadingDocumentProcessor,
)
from diandianreading.infrastructure.documents.reading_bridge import ReadingChatBridge
from diandianreading.infrastructure.fakes import FakeKnowledgeAdapter
from diandianreading.infrastructure.local_api import InstallTokenStore, LocalApiSecurityService
from diandianreading.infrastructure.persistence import SQLiteDatabase, SQLiteUnitOfWorkFactory
from diandianreading.infrastructure.persistence.annotations import (
    SQLiteAnnotationRepository,
)
from diandianreading.infrastructure.persistence.chat import SQLiteChatRepository
from diandianreading.infrastructure.persistence.content import (
    SQLiteKnowledgeNoteRepository,
)
from diandianreading.infrastructure.persistence.reading import (
    SQLiteReadingProgressRepository,
)
from diandianreading.infrastructure.storage import LocalFileStore
from diandianreading.interfaces.runtime import ApplicationPaths
from diandianreading.interfaces.web import LocalHttpConfig, create_web_app
from diandianreading.interfaces.web.app import ProviderSessionPort, ProviderSessionStatus
from diandianreading.worker.runner import WorkerRunner


class _OfflineZLibraryAcquirer:
    provider = "zlibrary"

    def canonicalize_location(self, location: str) -> str:
        if not location.strip():
            raise ValueError("Location cannot be empty")
        return "https://z-library.sk/book/offline-fixture"

    def redact_location(self, location: str) -> str:
        return self.canonicalize_location(location)

    async def acquire(
        self,
        request: AcquisitionRequest,
        progress: ProgressSink,
    ) -> AcquiredAsset:
        del request, progress
        raise DiandianError(
            ErrorCode.SOURCE_UNAVAILABLE,
            "Offline Phase 5 fixture does not acquire remote documents",
            retryable=False,
        )


@dataclass(frozen=True, slots=True)
class _DemoSessionStatus:
    provider: str
    profile: str
    state: str
    checked_at: datetime


class _DemoSessionManager:
    def __init__(self, provider: str) -> None:
        self._provider = provider

    async def status(self, credential: CredentialRef) -> ProviderSessionStatus:
        return _DemoSessionStatus(
            provider=self._provider,
            profile=credential.profile,
            state="connected",
            checked_at=utc_now(),
        )


@dataclass(slots=True)
class Phase5DemoRuntime:
    paths: ApplicationPaths
    database: SQLiteDatabase
    unit_of_work: SQLiteUnitOfWorkFactory
    install_tokens: InstallTokenStore
    knowledge: FakeKnowledgeAdapter
    import_submission: ImportSubmissionUseCase
    imports: ImportBookUseCase
    jobs: JobService
    catalog: CatalogService
    reading: ReadingService
    annotations: AnnotationService
    notes: KnowledgeNoteService
    chat: ChatUseCase
    security: LocalApiSecurityService
    notebooklm_session: ProviderSessionPort
    zlibrary_session: ProviderSessionPort
    worker: WorkerRunner
    target_capabilities: TargetCapabilities
    zlibrary_enabled: bool = False

    async def aclose(self) -> None:
        return None


def create_phase5_demo_runtime(home: Path) -> tuple[Phase5DemoRuntime, SQLiteDatabase]:
    paths = ApplicationPaths(home)
    database = SQLiteDatabase(paths.database)
    _ = database.migrate()
    unit_of_work = SQLiteUnitOfWorkFactory(database)
    store = LocalFileStore(paths.object_root)
    local_acquirer = LocalFileAcquirer(store)
    preparation = LocalDocumentPreparationAdapter(store)
    zlibrary = _OfflineZLibraryAcquirer()
    capabilities = TargetCapabilities(
        max_source_words=350_000,
        max_source_bytes=10 * 1024 * 1024,
        max_sources_per_workspace=50,
        accepted_mime_types=frozenset({"application/pdf", "text/markdown"}),
    )
    knowledge = FakeKnowledgeAdapter()
    knowledge.provider = "notebooklm"
    materializer = DurableImportSourceMaterializer(
        unit_of_work=unit_of_work,
        zlibrary_acquirer=zlibrary,
        preparation=preparation,
    )
    imports = ImportBookUseCase(
        unit_of_work=unit_of_work,
        knowledge=knowledge,
        materializer=materializer,
    )
    submission = ImportSubmissionUseCase(
        unit_of_work=unit_of_work,
        local_acquirer=local_acquirer,
        zlibrary_acquirer=zlibrary,
    )
    reading = ReadingService(
        unit_of_work=unit_of_work,
        file_store=store,
        processor=PolicyReadingDocumentProcessor(),
        progress=SQLiteReadingProgressRepository(database),
    )
    notes = KnowledgeNoteService(SQLiteKnowledgeNoteRepository(database))
    reading_bridge = ReadingChatBridge(
        reading=reading,
        unit_of_work=unit_of_work,
        file_store=store,
    )
    chat = ChatUseCase(
        repository=SQLiteChatRepository(database),
        knowledge_query=knowledge,
        knowledge_health=knowledge,
        selection_verifier=reading_bridge,
        annotations=SQLiteAnnotationRepository(database),
        document_text=reading_bridge,
    )
    tokens = InstallTokenStore(paths.credentials_root / "local-api")
    _ = tokens.ensure_initial()
    security = LocalApiSecurityService(database, tokens)
    runtime = Phase5DemoRuntime(
        paths=paths,
        database=database,
        unit_of_work=unit_of_work,
        install_tokens=tokens,
        knowledge=knowledge,
        import_submission=submission,
        imports=imports,
        jobs=JobService(unit_of_work=unit_of_work),
        catalog=CatalogService(unit_of_work=unit_of_work),
        reading=reading,
        annotations=AnnotationService(
            repository=SQLiteAnnotationRepository(database),
            reading=reading,
        ),
        notes=notes,
        chat=chat,
        security=security,
        notebooklm_session=_DemoSessionManager("notebooklm"),
        zlibrary_session=_DemoSessionManager("zlibrary"),
        worker=WorkerRunner(imports=imports, chat=chat, worker_id="phase5-worker"),
        target_capabilities=capabilities,
    )
    return runtime, database


def run_phase5_demo(home: Path, workspace: Path) -> dict[str, object]:
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message="Using `httpx` with `starlette.testclient` is deprecated.*",
        )
        from fastapi.testclient import TestClient

    home_path = Path(os.path.abspath(home.expanduser()))
    workspace_path = Path(os.path.abspath(workspace.expanduser()))
    _require_new_disjoint_paths(home_path, workspace_path)
    workspace_path.mkdir(parents=True, mode=0o700)
    if os.name != "nt":
        workspace_path.chmod(0o700)

    runtime, database = create_phase5_demo_runtime(home_path)
    app = create_web_app(
        runtime,
        config=LocalHttpConfig(),
        start_worker=False,
        close_runtime=False,
    )
    bootstrap = runtime.security.issue_bootstrap()
    origin = "http://localhost:3000"
    base_headers = {"Origin": origin}

    with TestClient(
        app,
        base_url=origin,
        client=("127.0.0.1", 50_000),
        follow_redirects=False,
    ) as client:
        index = client.get("/")
        assert index.status_code == 200
        assert "diandianreading" in index.text
        asset_paths = re.findall(r'"\./(assets/[^"]+)"', index.text)
        assert asset_paths
        for asset_path in asset_paths:
            assert client.get(f"/{asset_path}").status_code == 200

        response = client.post(
            "/api/session/bootstrap",
            json={"nonce": bootstrap.nonce},
            headers=base_headers,
        )
        response.raise_for_status()
        csrf = client.cookies.get("diandian_csrf")
        assert csrf is not None
        mutation_headers = {"Origin": origin, "X-CSRF-Token": csrf}

        source = b"# Unified Reading\n\nDurable local imports support grounded conversations.\n"
        import_response = client.post(
            "/api/imports",
            content=source,
            headers={
                **mutation_headers,
                "Content-Type": "application/octet-stream",
                "X-Diandian-Provider": "local",
                "X-Diandian-Filename": "phase5.md",
                "X-Diandian-Rights-Basis": "owned_copy",
                "X-Diandian-Rights-Confirmed": "true",
                "X-Diandian-NotebookLM-Profile": "default",
            },
        )
        import_response.raise_for_status()
        import_payload = import_response.json()["data"]["job"]
        job_id = import_payload["id"]

        assert asyncio.run(runtime.worker.run_once()) is True
        job_response = client.get(f"/api/jobs/{job_id}", headers=base_headers)
        job_response.raise_for_status()
        job = job_response.json()["data"]["job"]
        assert job["status"] == "completed"
        book_id = job["book_id"]

        books_response = client.get("/api/books?limit=100", headers=base_headers)
        books_response.raise_for_status()
        books = books_response.json()["data"]["books"]
        assert [book["id"] for book in books] == [book_id]

        conversation_response = client.put(
            f"/api/books/{book_id}/conversation",
            json={
                "title": "Discuss Unified Reading",
                "default_query_scope": {"type": "book"},
            },
            headers=mutation_headers,
        )
        conversation_response.raise_for_status()
        conversation_id = conversation_response.json()["data"]["conversation"]["id"]

        client_message_id = "msg-phase5-e2e"
        question_response = client.post(
            f"/api/conversations/{conversation_id}/messages",
            json={
                "client_message_id": client_message_id,
                "question": "What does this fixture prove?",
                "query_scope": {"type": "book"},
            },
            headers={
                **mutation_headers,
                "Idempotency-Key": client_message_id,
            },
        )
        question_response.raise_for_status()
        run_id = question_response.json()["data"]["chat_run"]["id"]

        assert asyncio.run(runtime.worker.run_once()) is True
        run_response = client.get(f"/api/chat-runs/{run_id}", headers=base_headers)
        run_response.raise_for_status()
        run = run_response.json()["data"]
        assert run["chat_run"]["status"] == "completed"
        assert run["references"]

        job_events = client.get(f"/api/jobs/{job_id}/events", headers=base_headers)
        job_events.raise_for_status()
        chat_events = client.get(f"/api/chat-runs/{run_id}/events", headers=base_headers)
        chat_events.raise_for_status()

        rejected = client.get(
            "/api/jobs",
            headers={"Origin": "https://attacker.invalid"},
        )
        assert rejected.status_code == 403

        session_response = client.get("/api/session", headers=base_headers)
        session_response.raise_for_status()
        auth_response = client.get("/api/auth/status", headers=base_headers)
        auth_response.raise_for_status()

    result = {
        "status": "ok",
        "schema_version": database.schema_version(),
        "job_status": job["status"],
        "book_count": len(books),
        "chat_status": run["chat_run"]["status"],
        "citation_count": len(run["references"]),
        "job_sse_verified": "event: job.completed" in job_events.text,
        "chat_sse_verified": "event: chat_run.completed" in chat_events.text,
        "cross_origin_rejected": rejected.status_code == 403,
        "session_bootstrap_verified": session_response.json()["data"]["authenticated"] is True,
        "provider_status_verified": set(auth_response.json()["data"]["providers"])
        == {"notebooklm", "zlibrary"},
    }
    (workspace_path / "phase5-result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    return result


def _require_new_disjoint_paths(home: Path, workspace: Path) -> None:
    if home == workspace or home in workspace.parents or workspace in home.parents:
        raise ValueError("Phase 5 home and workspace must be disjoint")
    for label, path in (("home", home), ("workspace", workspace)):
        if path.exists() or path.is_symlink():
            raise FileExistsError(f"Refusing to overwrite existing Phase 5 {label}")
        parent = path.parent
        if parent.exists():
            metadata = parent.lstat()
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
                raise ValueError("Phase 5 parent path must be a real directory")
