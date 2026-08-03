"""Optional governed Z-Library acquisition Adapter."""

from __future__ import annotations

import asyncio
import os
import shutil
import stat
import tempfile
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

from diandianreading.application.ports import (
    AcquiredAsset,
    AcquisitionRequest,
    BestEffortProgressSink,
    FileStore,
    ProgressSink,
    StoredFile,
    ZLibraryAcquisitionPort,
)
from diandianreading.domain import (
    DiandianError,
    DocumentAsset,
    ErrorCode,
    ProgressEvent,
    SourceOrigin,
    StorageKey,
    UnsafePathError,
)
from diandianreading.infrastructure.acquisition.zlibrary.browser import ZLibraryBrowserPort
from diandianreading.infrastructure.acquisition.zlibrary.config import ZLibraryAdapterConfig
from diandianreading.infrastructure.acquisition.zlibrary.credentials import (
    ZLibraryCredentialResolver,
)
from diandianreading.infrastructure.acquisition.zlibrary.downloader import BoundedZLibraryDownloader
from diandianreading.infrastructure.acquisition.zlibrary.network import ZLibraryNetworkPolicy
from diandianreading.infrastructure.acquisition.zlibrary.selectors import (
    ZLIBRARY_SELECTORS_V1,
    ZLibrarySelectorSet,
)
from diandianreading.infrastructure.acquisition.zlibrary.session import ZLibrarySessionManager
from diandianreading.infrastructure.acquisition.zlibrary.validation import (
    ValidatedDocument,
    validate_downloaded_document,
)


class ZLibraryAcquirer(ZLibraryAcquisitionPort):
    provider = "zlibrary"

    def __init__(
        self,
        *,
        store: FileStore,
        resolver: ZLibraryCredentialResolver,
        session_manager: ZLibrarySessionManager,
        browser: ZLibraryBrowserPort,
        network_policy: ZLibraryNetworkPolicy,
        downloader: BoundedZLibraryDownloader,
        config: ZLibraryAdapterConfig,
        staging_root: Path,
        selectors: ZLibrarySelectorSet = ZLIBRARY_SELECTORS_V1,
    ) -> None:
        self._store = store
        self._resolver = resolver
        self._session_manager = session_manager
        self._browser = browser
        self._network_policy = network_policy
        self._downloader = downloader
        self._config = config
        self._staging_root = _prepare_staging_root(staging_root)
        self._selectors = selectors

    def canonicalize_location(self, location: str) -> str:
        return self._network_policy.canonicalize_book_url(location)

    def redact_location(self, location: str) -> str:
        canonical = self.canonicalize_location(location)
        return self._network_policy.redact_url(canonical)

    async def acquire(
        self,
        request: AcquisitionRequest,
        progress: ProgressSink,
    ) -> AcquiredAsset:
        sink = BestEffortProgressSink(progress)
        if not self._config.enabled:
            raise _validation("Z-Library acquisition is disabled")
        if request.provider != self.provider:
            raise _validation("Z-Library Adapter only accepts the zlibrary provider")
        if not request.rights_confirmed:
            raise _validation("Z-Library acquisition requires explicit rights confirmation")
        rights_id = request.options.get("rights_provenance_id", "").strip()
        if not rights_id:
            raise _validation("Z-Library acquisition requires rights provenance")
        if request.credential is None or request.credential.provider != self.provider:
            raise _validation("Z-Library acquisition requires a Z-Library credential profile")

        canonical_location = self.canonicalize_location(request.location)
        redacted_location = self.redact_location(canonical_location)
        if request.options.get("source_locator_redacted") != redacted_location:
            raise _validation("Z-Library rights provenance does not match the requested source")

        await self._session_manager.require_authenticated(request.credential)
        paths = self._resolver.resolve_existing_profile(request.credential)
        ticket = await self._browser.capture_download(
            browser_profile=paths.browser_profile,
            book_url=canonical_location,
            network_policy=self._network_policy,
            selectors=self._selectors,
            timeout_seconds=self._config.browser_action_timeout_seconds,
        )
        if ticket.selector_version != self._selectors.version:
            raise DiandianError(
                ErrorCode.REMOTE_PROTOCOL_DRIFT,
                "Z-Library browser result used an unreviewed selector version",
                retryable=False,
            )

        operation_staging = Path(tempfile.mkdtemp(dir=self._staging_root, prefix="acquisition-"))
        if os.name != "nt":
            operation_staging.chmod(0o700)
        try:
            downloaded = await asyncio.to_thread(
                self._downloader.download,
                ticket,
                operation_staging,
            )
            validated = await asyncio.to_thread(
                validate_downloaded_document,
                downloaded,
                self._config.archive,
            )
            stored = await asyncio.to_thread(self._publish, downloaded.path, validated)
        finally:
            _remove_staging(operation_staging, self._staging_root)

        if stored.sha256 != validated.sha256 or stored.size_bytes != validated.size_bytes:
            raise DiandianError(
                ErrorCode.UNEXPECTED,
                "Z-Library object verification failed",
                retryable=False,
            )
        title = _safe_metadata(request.options.get("title")) or validated.title
        author = _safe_metadata(request.options.get("author"))
        asset = DocumentAsset(
            id=str(uuid5(NAMESPACE_URL, f"document-asset:{stored.sha256}")),
            storage_key=stored.key,
            display_filename=validated.display_filename,
            mime_type=validated.mime_type,
            size_bytes=stored.size_bytes,
            sha256=stored.sha256,
            title=title,
            author=author,
            origin=SourceOrigin.ZLIBRARY,
            origin_locator=redacted_location,
            rights_provenance_id=rights_id,
        )
        await sink.emit(
            ProgressEvent(
                job_id=sink.job_id,
                step="acquiring",
                current=1,
                total=1,
                message="Stored governed Z-Library document",
            )
        )
        return AcquiredAsset(asset=asset, temporary_key=None)

    def _publish(self, path: Path, validated: ValidatedDocument) -> StoredFile:
        descriptor = _open_private_staging_file(path)
        try:
            with os.fdopen(descriptor, "rb", closefd=False) as content:
                return self._store.put(
                    StorageKey(f"originals/{validated.sha256}"),
                    content,
                )
        finally:
            os.close(descriptor)


def _prepare_staging_root(path: Path) -> Path:
    root = Path(os.path.abspath(path.expanduser()))
    _reject_symlink_components(root)
    if not root.exists():
        root.mkdir(parents=True, mode=0o700)
        if os.name != "nt":
            root.chmod(0o700)
    _validate_private_directory(root)
    return root


def _remove_staging(path: Path, root: Path) -> None:
    absolute = Path(os.path.abspath(path))
    if root not in absolute.parents:
        raise UnsafePathError("Z-Library staging cleanup escaped its managed root")
    metadata = absolute.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise UnsafePathError("Z-Library operation staging must remain a directory")
    shutil.rmtree(absolute)


def _open_private_staging_file(path: Path) -> int:
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise UnsafePathError("Z-Library staging document must be a regular non-symlink file")
    if os.name != "nt":
        if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
            raise UnsafePathError("Z-Library staging document must be owned by the current user")
        if stat.S_IMODE(metadata.st_mode) & 0o077:
            raise UnsafePathError("Z-Library staging document permissions must be private (0600)")
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        current = path.lstat()
        if not os.path.samestat(metadata, opened) or not os.path.samestat(opened, current):
            raise UnsafePathError("Z-Library staging document changed while publishing")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _validate_private_directory(path: Path) -> None:
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise UnsafePathError("Z-Library staging root must be a private directory")
    if os.name != "nt":
        if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
            raise UnsafePathError("Z-Library staging root must be owned by the current user")
        if stat.S_IMODE(metadata.st_mode) & 0o077:
            raise UnsafePathError("Z-Library staging root permissions must be private (0700)")


def _reject_symlink_components(path: Path) -> None:
    current = Path(path.anchor)
    for segment in path.parts[1:]:
        current /= segment
        if current.is_symlink():
            raise UnsafePathError("Z-Library staging path cannot contain symbolic links")


def _safe_metadata(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = " ".join(
        "".join(character for character in value if ord(character) >= 0x20).split()
    )
    return normalized[:200] or None


def _validation(message: str) -> DiandianError:
    return DiandianError(ErrorCode.VALIDATION, message, retryable=False)
