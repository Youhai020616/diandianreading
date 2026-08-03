"""Browser-free Phase 4 E2E for governed Z-Library acquisition."""

from __future__ import annotations

import io
import json
import os
import zipfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from diandianreading.application.ports import ProgressSink
from diandianreading.application.use_cases import (
    ZLIBRARY_RIGHTS_POLICY_VERSION,
    ZLibraryAcquisitionCommand,
    ZLibraryAcquisitionUseCase,
)
from diandianreading.domain import (
    CredentialRef,
    DiandianError,
    ErrorCode,
    ProgressEvent,
    RightsBasis,
    UnsafePathError,
    utc_now,
)
from diandianreading.infrastructure.acquisition.zlibrary import (
    BoundedZLibraryDownloader,
    BrowserCookie,
    LegacyProfileInspection,
    PinnedDestination,
    ZLibraryAcquirer,
    ZLibraryAdapterConfig,
    ZLibraryCredentialResolver,
    ZLibraryDownloadTicket,
    ZLibraryLegacyProfileMigrator,
    ZLibraryNetworkPolicy,
    ZLibrarySessionManager,
)
from diandianreading.infrastructure.persistence import (
    SQLiteDatabase,
    SQLiteRightsProvenanceRepository,
    SQLiteUnitOfWorkFactory,
)
from diandianreading.infrastructure.storage import LocalFileStore

_PDF_BYTES = b"%PDF-1.7\nphase 4 synthetic fixture\n%%EOF\n"


@dataclass(slots=True)
class _Progress(ProgressSink):
    events: list[ProgressEvent]

    @property
    def job_id(self) -> str:
        return "phase4-acquisition"

    async def emit(self, event: ProgressEvent) -> None:
        self.events.append(event)


class _StaticResolver:
    def resolve(self, host: str, port: int) -> Sequence[str]:
        if port != 443:
            raise OSError("unexpected synthetic port")
        addresses = {
            "zlibrary.invalid": ("8.8.8.8",),
            "download.invalid": ("1.1.1.1",),
        }
        try:
            return addresses[host]
        except KeyError as exc:
            raise OSError("unexpected synthetic host") from exc


class _FakeBrowser:
    def __init__(self, tickets: Sequence[ZLibraryDownloadTicket]) -> None:
        self._tickets = iter(tickets)
        self.authenticated = True
        self.login_count = 0
        self.health_count = 0
        self.expect_download_count = 0

    async def login(self, **kwargs: object) -> bool:
        browser_profile = kwargs["browser_profile"]
        storage_state = kwargs["storage_state"]
        if not isinstance(browser_profile, Path) or not isinstance(storage_state, Path):
            raise TypeError("Synthetic browser paths were invalid")
        _write_private_bytes(browser_profile / "session.bin", b"synthetic browser session")
        _write_private_bytes(
            storage_state,
            json.dumps({"cookies": [], "origins": []}).encode(),
        )
        self.login_count += 1
        return self.authenticated

    async def is_authenticated(self, **kwargs: object) -> bool:
        browser_profile = kwargs["browser_profile"]
        if not isinstance(browser_profile, Path) or not browser_profile.is_dir():
            return False
        self.health_count += 1
        return self.authenticated

    async def capture_download(self, **kwargs: object) -> ZLibraryDownloadTicket:
        book_url = kwargs["book_url"]
        if not isinstance(book_url, str) or not book_url.startswith(
            "https://zlibrary.invalid/book/"
        ):
            raise RuntimeError("Synthetic browser received a non-canonical book URL")
        self.expect_download_count += 1
        try:
            return next(self._tickets)
        except StopIteration as exc:
            raise RuntimeError("Synthetic expect_download ticket queue was exhausted") from exc


class _FakeResponse:
    def __init__(self, *, mime_type: str, filename: str, content: bytes) -> None:
        self.status = 200
        self.headers = (
            ("Content-Type", mime_type),
            ("Content-Length", str(len(content))),
            ("Content-Disposition", f'attachment; filename="{filename}"'),
        )
        self._content = content
        self._offset = 0
        self.closed = False

    def read(self, size: int) -> bytes:
        chunk = self._content[self._offset : self._offset + size]
        self._offset += len(chunk)
        return chunk

    def close(self) -> None:
        self.closed = True


class _FakeTransport:
    def __init__(self, responses: Sequence[_FakeResponse]) -> None:
        self._responses = iter(responses)
        self.request_count = 0
        self.cookie_scope_count = 0

    def open(
        self,
        destination: PinnedDestination,
        headers: Mapping[str, str],
        *,
        connect_timeout_seconds: float,
        first_byte_timeout_seconds: float,
        idle_timeout_seconds: float,
    ) -> _FakeResponse:
        if (
            connect_timeout_seconds <= 0
            or first_byte_timeout_seconds <= 0
            or idle_timeout_seconds <= 0
            or destination.target.host != "download.invalid"
        ):
            raise OSError("Synthetic bounded transport contract was violated")
        self.request_count += 1
        if headers.get("Cookie") == "session=synthetic-cookie":
            self.cookie_scope_count += 1
        try:
            return next(self._responses)
        except StopIteration as exc:
            raise OSError("Synthetic response queue was exhausted") from exc


class _SequentialIds:
    def __init__(self, *values: str) -> None:
        self._values = iter(values)

    def __call__(self) -> str:
        return next(self._values)


async def run_phase4_demo(
    database_path: Path,
    object_root: Path,
    credentials_root: Path,
    workspace_path: Path,
) -> dict[str, object]:
    """Exercise the real Adapter policy with only synthetic browser and network doubles."""

    database_path = _absolute_path(database_path)
    object_root = _absolute_path(object_root)
    credentials_root = _absolute_path(credentials_root)
    workspace_path = _absolute_path(workspace_path)
    _require_disjoint_new_paths(database_path, object_root, credentials_root, workspace_path)

    database = SQLiteDatabase.create_new(database_path)
    schema_version = database.migrate()
    workspace_path.mkdir(mode=0o700, parents=True, exist_ok=False)
    if os.name != "nt":
        workspace_path.chmod(0o700)
    store = LocalFileStore(object_root)

    epub_bytes = _synthetic_epub()
    tickets = (
        _ticket("phase4.pdf"),
        _ticket("phase4.epub"),
    )
    responses = (
        _FakeResponse(mime_type="application/pdf", filename="phase4.pdf", content=_PDF_BYTES),
        _FakeResponse(
            mime_type="application/epub+zip",
            filename="phase4.epub",
            content=epub_bytes,
        ),
    )
    browser = _FakeBrowser(tickets)
    transport = _FakeTransport(responses)
    config = ZLibraryAdapterConfig(
        enabled=True,
        base_url="https://zlibrary.invalid/",
        allowed_hosts=frozenset({"zlibrary.invalid", "download.invalid"}),
    )
    network_policy = ZLibraryNetworkPolicy(config.allowed_hosts, _StaticResolver())
    resolver = ZLibraryCredentialResolver(credentials_root)
    session = ZLibrarySessionManager(
        resolver=resolver,
        browser=browser,
        network_policy=network_policy,
        config=config,
    )
    downloader = BoundedZLibraryDownloader(
        network_policy=network_policy,
        limits=config.download,
        transport=transport,
    )
    adapter = ZLibraryAcquirer(
        store=store,
        resolver=resolver,
        session_manager=session,
        browser=browser,
        network_policy=network_policy,
        downloader=downloader,
        config=config,
        staging_root=workspace_path / "staging",
    )
    credential = CredentialRef("zlibrary", "phase4-e2e")
    await session.login(credential)

    disabled_gate_verified = False
    try:
        await ZLibraryAcquisitionUseCase(
            unit_of_work=SQLiteUnitOfWorkFactory(database),
            acquirer=adapter,
        ).execute(_command("disabled", credential))
    except DiandianError as exc:
        disabled_gate_verified = (
            exc.code is ErrorCode.VALIDATION and browser.expect_download_count == 0
        )
    if not disabled_gate_verified:
        raise RuntimeError("Phase 4 E2E failed: default-disabled Application gate was bypassed")

    progress = _Progress([])
    use_case = ZLibraryAcquisitionUseCase(
        unit_of_work=SQLiteUnitOfWorkFactory(database),
        acquirer=adapter,
        enabled=True,
        id_factory=_SequentialIds("rights-phase4-pdf", "rights-phase4-epub"),
        clock=utc_now,
    )
    pdf_result = await use_case.execute(_command("pdf", credential), progress)
    epub_result = await use_case.execute(_command("epub", credential), progress)
    results = (pdf_result, epub_result)

    rights = SQLiteRightsProvenanceRepository(database)
    persisted = tuple(rights.get(result.rights_provenance.id) for result in results)
    if any(item is None or item.content_sha256 is None for item in persisted):
        raise RuntimeError("Phase 4 E2E failed: final rights hashes were not bound")
    if any(
        store.stat(result.acquired.asset.storage_key).sha256 != result.acquired.asset.sha256
        for result in results
    ):
        raise RuntimeError("Phase 4 E2E failed: published objects were not content-verified")
    if any((workspace_path / "staging").iterdir()):
        raise RuntimeError("Phase 4 E2E failed: acquisition staging was not cleaned")
    if browser.expect_download_count != 2 or transport.request_count != 2:
        raise RuntimeError("Phase 4 E2E failed: synthetic download tickets were not consumed once")
    if transport.cookie_scope_count != 2:
        raise RuntimeError(
            "Phase 4 E2E failed: browser Cookies were not scoped to download requests"
        )

    legacy_root = workspace_path / "legacy-zlibrary"
    legacy_browser = legacy_root / "browser_profile"
    legacy_browser.mkdir(parents=True, mode=0o700)
    if os.name != "nt":
        legacy_root.chmod(0o700)
        legacy_browser.chmod(0o700)
    _write_private_bytes(legacy_browser / "session.bin", b"legacy synthetic session")
    legacy_config = legacy_root / "config.json"
    _write_private_bytes(
        legacy_config,
        b'{"email":"never-read@example.invalid","password":"never-read"}',
    )
    if os.name != "nt":
        legacy_config.chmod(0o000)
    migrator = ZLibraryLegacyProfileMigrator(
        legacy_root=legacy_root,
        resolver=resolver,
        browser=browser,
        network_policy=network_policy,
        config=config,
    )
    inspection: LegacyProfileInspection = migrator.inspect()
    if not inspection.plaintext_config_detected:
        raise RuntimeError("Phase 4 E2E failed: legacy plaintext config was not detected")

    notebooklm_sentinel = credentials_root / "notebooklm" / "sentinel"
    notebooklm_sentinel.parent.mkdir(mode=0o700)
    _write_private_bytes(notebooklm_sentinel, b"provider isolation sentinel")
    if not session.logout(credential) or notebooklm_sentinel.read_bytes() != (
        b"provider isolation sentinel"
    ):
        raise RuntimeError("Phase 4 E2E failed: Provider logout crossed credential roots")

    with database.connect() as connection:
        database_dump = "\n".join(connection.iterdump())
    forbidden = (
        "synthetic-cookie",
        "never-read@example.invalid",
        "never-read",
        str(credentials_root),
    )
    if any(secret in database_dump for secret in forbidden):
        raise RuntimeError("Phase 4 E2E failed: credential material entered SQLite")
    if not database.integrity_check():
        raise RuntimeError("Phase 4 E2E failed: SQLite integrity check failed")

    return {
        "status": "ok",
        "schema_version": schema_version,
        "default_disabled_gate_verified": disabled_gate_verified,
        "rights_record_count": 2,
        "rights_event_count": sum(
            len(rights.list_events(result.rights_provenance.id)) for result in results
        ),
        "bound_content_hash_count": sum(
            result.rights_provenance.content_sha256 is not None for result in results
        ),
        "published_pdf_count": sum(
            result.acquired.asset.mime_type == "application/pdf" for result in results
        ),
        "published_epub_count": sum(
            result.acquired.asset.mime_type == "application/epub+zip" for result in results
        ),
        "expect_download_count": browser.expect_download_count,
        "bounded_download_count": transport.request_count,
        "legacy_plaintext_config_detected": inspection.plaintext_config_detected,
        "legacy_config_read_count": 0,
        "provider_isolation_verified": True,
        "staging_entry_count": 0,
        "progress_event_count": len(progress.events),
    }


def _ticket(filename: str) -> ZLibraryDownloadTicket:
    return ZLibraryDownloadTicket(
        url=f"https://download.invalid/files/{filename}?token=synthetic-secret",
        suggested_filename=filename,
        cookies=(
            BrowserCookie(
                name="session",
                value="synthetic-cookie",
                domain=".download.invalid",
                path="/files",
            ),
        ),
        selector_version="zlibrary-dom-v1",
    )


def _command(kind: str, credential: CredentialRef) -> ZLibraryAcquisitionCommand:
    return ZLibraryAcquisitionCommand(
        location=f"https://zlibrary.invalid/book/synthetic-{kind}?tracking=removed",
        credential=credential,
        rights_basis=RightsBasis.PUBLIC_DOMAIN,
        license_identifier="Public Domain Mark 1.0",
        evidence_storage_key=None,
        attestation_version=ZLIBRARY_RIGHTS_POLICY_VERSION,
        rights_confirmed=True,
        options={"title": f"Phase 4 {kind.upper()} Fixture"},
    )


def _synthetic_epub() -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        mimetype = zipfile.ZipInfo("mimetype")
        mimetype.compress_type = zipfile.ZIP_STORED
        archive.writestr(mimetype, b"application/epub+zip")
        archive.writestr("META-INF/container.xml", b"<container/>")
        archive.writestr("OPS/chapter.xhtml", b"<html><body>Fixture</body></html>")
    return output.getvalue()


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
            raise FileExistsError(f"Refusing to overwrite existing Phase 4 {label}")
    paths = (database, object_root, credentials_root, workspace)
    for index, path in enumerate(paths):
        for other in paths[index + 1 :]:
            if path == other or path in other.parents or other in path.parents:
                raise UnsafePathError("Phase 4 database and data roots must be disjoint")


def _write_private_bytes(path: Path, content: bytes) -> None:
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(descriptor, 0o600)
        offset = 0
        while offset < len(content):
            written = os.write(descriptor, content[offset:])
            if written <= 0:
                raise OSError("Private fixture write failed")
            offset += written
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
