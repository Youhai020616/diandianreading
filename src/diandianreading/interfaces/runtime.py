"""Production composition root for the local-first application."""

from __future__ import annotations

import os
import stat
from dataclasses import dataclass, field
from pathlib import Path

from diandianreading.application.use_cases.annotations import AnnotationService
from diandianreading.application.use_cases.catalog import CatalogService
from diandianreading.application.use_cases.chat import ChatUseCase
from diandianreading.application.use_cases.content import KnowledgeNoteService
from diandianreading.application.use_cases.content_generation import ContentGenerationUseCase
from diandianreading.application.use_cases.import_book import ImportBookUseCase
from diandianreading.application.use_cases.import_source import (
    DurableImportSourceMaterializer,
    ImportSubmissionUseCase,
)
from diandianreading.application.use_cases.jobs import JobService
from diandianreading.application.use_cases.obsidian_export import ObsidianExportService
from diandianreading.application.use_cases.reading import ReadingService
from diandianreading.domain import CredentialRef, TargetCapabilities
from diandianreading.infrastructure.acquisition.local import LocalFileAcquirer
from diandianreading.infrastructure.acquisition.zlibrary import (
    BoundedZLibraryDownloader,
    PlaywrightZLibraryBrowser,
    ZLibraryAcquirer,
    ZLibraryAdapterConfig,
    ZLibraryCredentialResolver,
    ZLibraryNetworkPolicy,
    ZLibrarySessionManager,
)
from diandianreading.infrastructure.browser_runtime import BrowserRuntimeManager
from diandianreading.infrastructure.documents import (
    LocalDocumentPreparationAdapter,
    PolicyReadingDocumentProcessor,
)
from diandianreading.infrastructure.documents.reading_bridge import ReadingChatBridge
from diandianreading.infrastructure.local_api import (
    INSTALL_TOKEN_FILENAME,
    InstallTokenStore,
    LocalApiSecurityService,
)
from diandianreading.infrastructure.notebooklm import (
    CredentialPathResolver,
    NotebookLMAdapter,
    NotebookLMSessionManager,
)
from diandianreading.infrastructure.persistence import (
    SQLiteDatabase,
    SQLiteKnowledgeMappingRepository,
    SQLiteUnitOfWorkFactory,
)
from diandianreading.infrastructure.persistence.annotations import (
    SQLiteAnnotationRepository,
)
from diandianreading.infrastructure.persistence.chat import SQLiteChatRepository
from diandianreading.infrastructure.persistence.content import (
    SQLiteContentAssetRepository,
    SQLiteKnowledgeNoteRepository,
    SQLiteObsidianExportStateRepository,
    SQLiteVaultRepository,
)
from diandianreading.infrastructure.persistence.reading import (
    SQLiteReadingProgressRepository,
)
from diandianreading.infrastructure.storage import LocalFileStore
from diandianreading.worker.runner import WorkerRunner

DEFAULT_PROFILE = "default"
DEFAULT_MAX_DOCUMENT_BYTES = 100 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class ApplicationPaths:
    """Absolute private locations owned by one diandianreading installation."""

    home: Path
    database: Path = field(init=False)
    object_root: Path = field(init=False)
    credentials_root: Path = field(init=False)
    staging_root: Path = field(init=False)
    upload_root: Path = field(init=False)
    browser_root: Path = field(init=False)

    def __post_init__(self) -> None:
        home = Path(os.path.abspath(self.home.expanduser()))
        object.__setattr__(self, "home", home)
        object.__setattr__(self, "database", home / "state" / "app.sqlite3")
        object.__setattr__(self, "object_root", home / "objects")
        object.__setattr__(self, "credentials_root", home / "credentials")
        object.__setattr__(self, "staging_root", home / "staging")
        object.__setattr__(self, "upload_root", home / "uploads")
        object.__setattr__(self, "browser_root", home / "browsers")

    @classmethod
    def default(cls) -> ApplicationPaths:
        configured = os.environ.get("DIANDIAN_HOME")
        return cls(Path(configured) if configured else Path.home() / ".diandianreading")


@dataclass(frozen=True, slots=True)
class RuntimeConfig:
    zlibrary_enabled: bool = False
    max_document_bytes: int = DEFAULT_MAX_DOCUMENT_BYTES
    target_capabilities: TargetCapabilities = field(
        default_factory=lambda: TargetCapabilities(
            max_source_words=350_000,
            max_source_bytes=DEFAULT_MAX_DOCUMENT_BYTES,
            max_sources_per_workspace=50,
            accepted_mime_types=frozenset({"application/pdf", "text/markdown"}),
        )
    )

    def __post_init__(self) -> None:
        if self.max_document_bytes <= 0:
            raise ValueError("Runtime document byte limit must be positive")
        if self.target_capabilities.max_source_bytes > self.max_document_bytes:
            raise ValueError("Target source byte limit cannot exceed the local document limit")

    @classmethod
    def from_environment(cls, *, zlibrary_enabled: bool | None = None) -> RuntimeConfig:
        enabled = (
            _environment_flag("DIANDIAN_ZLIBRARY_ENABLED")
            if zlibrary_enabled is None
            else zlibrary_enabled
        )
        return cls(zlibrary_enabled=enabled)


@dataclass(slots=True)
class ApplicationRuntime:
    """Long-lived services shared by CLI, HTTP, and the in-process worker."""

    paths: ApplicationPaths
    config: RuntimeConfig
    database: SQLiteDatabase
    schema_version: int
    unit_of_work: SQLiteUnitOfWorkFactory
    file_store: LocalFileStore
    notebooklm_adapter: NotebookLMAdapter
    notebooklm_session: NotebookLMSessionManager
    zlibrary_session: ZLibrarySessionManager
    import_submission: ImportSubmissionUseCase
    imports: ImportBookUseCase
    jobs: JobService
    catalog: CatalogService
    reading: ReadingService
    annotations: AnnotationService
    notes: KnowledgeNoteService
    content_generation: ContentGenerationUseCase
    obsidian_export: ObsidianExportService
    chat: ChatUseCase
    security: LocalApiSecurityService
    install_tokens: InstallTokenStore
    browser_runtime: BrowserRuntimeManager
    worker: WorkerRunner

    async def aclose(self) -> None:
        await self.notebooklm_adapter.aclose()

    @property
    def target_capabilities(self) -> TargetCapabilities:
        return self.config.target_capabilities

    @property
    def zlibrary_enabled(self) -> bool:
        return self.config.zlibrary_enabled


def create_runtime(
    paths: ApplicationPaths | None = None,
    *,
    config: RuntimeConfig | None = None,
) -> ApplicationRuntime:
    """Build the real local application without performing any provider network call."""

    effective_paths = paths or ApplicationPaths.default()
    effective_config = config or RuntimeConfig.from_environment()
    _prepare_app_home(effective_paths.home)

    browser_runtime = BrowserRuntimeManager(effective_paths.browser_root)
    _ = browser_runtime.configure_environment()

    database = SQLiteDatabase(effective_paths.database)
    schema_version = database.migrate()
    unit_of_work = SQLiteUnitOfWorkFactory(database)
    file_store = LocalFileStore(
        effective_paths.object_root,
        max_object_bytes=effective_config.max_document_bytes,
    )

    notebooklm_resolver = CredentialPathResolver(effective_paths.credentials_root)
    mappings = SQLiteKnowledgeMappingRepository(database)
    notebooklm_adapter = NotebookLMAdapter(
        credential_resolver=notebooklm_resolver,
        file_store=file_store,
        mappings=mappings,
        staging_root=effective_paths.staging_root / "notebooklm",
    )

    async def invalidate_notebooklm_cache(credential: CredentialRef) -> None:
        del credential
        await notebooklm_adapter.aclose()

    notebooklm_session = NotebookLMSessionManager(
        resolver=notebooklm_resolver,
        cache_invalidator=invalidate_notebooklm_cache,
    )

    zlibrary_config = ZLibraryAdapterConfig(enabled=effective_config.zlibrary_enabled)
    zlibrary_policy = ZLibraryNetworkPolicy(zlibrary_config.allowed_hosts)
    zlibrary_resolver = ZLibraryCredentialResolver(effective_paths.credentials_root)
    zlibrary_browser = PlaywrightZLibraryBrowser(headless=zlibrary_config.headless)
    zlibrary_session = ZLibrarySessionManager(
        resolver=zlibrary_resolver,
        browser=zlibrary_browser,
        network_policy=zlibrary_policy,
        config=zlibrary_config,
    )
    zlibrary_downloader = BoundedZLibraryDownloader(
        network_policy=zlibrary_policy,
        limits=zlibrary_config.download,
    )
    zlibrary_acquirer = ZLibraryAcquirer(
        store=file_store,
        resolver=zlibrary_resolver,
        session_manager=zlibrary_session,
        browser=zlibrary_browser,
        network_policy=zlibrary_policy,
        downloader=zlibrary_downloader,
        config=zlibrary_config,
        staging_root=effective_paths.staging_root / "zlibrary",
    )

    local_acquirer = LocalFileAcquirer(
        file_store,
        max_input_bytes=effective_config.max_document_bytes,
    )
    preparation = LocalDocumentPreparationAdapter(file_store)
    materializer = DurableImportSourceMaterializer(
        unit_of_work=unit_of_work,
        zlibrary_acquirer=zlibrary_acquirer,
        preparation=preparation,
    )
    import_submission = ImportSubmissionUseCase(
        unit_of_work=unit_of_work,
        local_acquirer=local_acquirer,
        zlibrary_acquirer=zlibrary_acquirer,
    )
    imports = ImportBookUseCase(
        unit_of_work=unit_of_work,
        knowledge=notebooklm_adapter,
        materializer=materializer,
    )
    jobs = JobService(unit_of_work=unit_of_work)
    catalog = CatalogService(unit_of_work=unit_of_work)
    reading = ReadingService(
        unit_of_work=unit_of_work,
        file_store=file_store,
        processor=PolicyReadingDocumentProcessor(),
        progress=SQLiteReadingProgressRepository(database),
    )
    annotations = AnnotationService(
        repository=SQLiteAnnotationRepository(database),
        reading=reading,
    )
    notes = KnowledgeNoteService(SQLiteKnowledgeNoteRepository(database))
    obsidian_export = ObsidianExportService(
        vaults=SQLiteVaultRepository(database),
        state=SQLiteObsidianExportStateRepository(database),
    )
    content_generation = ContentGenerationUseCase(
        assets=SQLiteContentAssetRepository(database),
        knowledge_generation=notebooklm_adapter,
        mappings=mappings,
    )
    reading_bridge = ReadingChatBridge(
        reading=reading,
        unit_of_work=unit_of_work,
        file_store=file_store,
    )
    chat = ChatUseCase(
        repository=SQLiteChatRepository(database),
        knowledge_query=notebooklm_adapter,
        knowledge_health=notebooklm_adapter,
        selection_verifier=reading_bridge,
        annotations=SQLiteAnnotationRepository(database),
        document_text=reading_bridge,
    )

    install_token_root = effective_paths.credentials_root / "local-api"
    install_token_path = install_token_root / INSTALL_TOKEN_FILENAME
    try:
        _ = install_token_path.lstat()
        install_token_was_missing = False
    except FileNotFoundError:
        install_token_was_missing = True
    install_tokens = InstallTokenStore(install_token_root)
    _ = install_tokens.ensure_initial()
    security = LocalApiSecurityService(database, install_tokens)
    if install_token_was_missing:
        security.recover_after_install_token_loss()
    worker = WorkerRunner(
        imports=imports, chat=chat, content=content_generation, worker_id="local-worker"
    )

    return ApplicationRuntime(
        paths=effective_paths,
        config=effective_config,
        database=database,
        schema_version=schema_version,
        unit_of_work=unit_of_work,
        file_store=file_store,
        notebooklm_adapter=notebooklm_adapter,
        notebooklm_session=notebooklm_session,
        zlibrary_session=zlibrary_session,
        import_submission=import_submission,
        imports=imports,
        jobs=jobs,
        catalog=catalog,
        reading=reading,
        annotations=annotations,
        notes=notes,
        content_generation=content_generation,
        obsidian_export=obsidian_export,
        chat=chat,
        security=security,
        install_tokens=install_tokens,
        browser_runtime=browser_runtime,
        worker=worker,
    )


def _prepare_app_home(home: Path) -> None:
    try:
        metadata = home.lstat()
    except FileNotFoundError:
        home.mkdir(parents=True, mode=0o700)
        if os.name != "nt":
            home.chmod(0o700)
        metadata = home.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise ValueError("Application home must be a private directory")
    if os.name != "nt":
        if metadata.st_uid != os.getuid():
            raise ValueError("Application home must be owned by the current user")
        if stat.S_IMODE(metadata.st_mode) & 0o077:
            home.chmod(0o700)
            metadata = home.lstat()
            if stat.S_IMODE(metadata.st_mode) & 0o077:
                raise ValueError("Application home permissions could not be made private")


def notebooklm_credential(profile: str = DEFAULT_PROFILE) -> CredentialRef:
    return CredentialRef("notebooklm", profile)


def zlibrary_credential(profile: str = DEFAULT_PROFILE) -> CredentialRef:
    return CredentialRef("zlibrary", profile)


def _environment_flag(name: str) -> bool:
    value = os.environ.get(name)
    if value is None or not value.strip():
        return False
    normalized = value.strip().casefold()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean flag")
