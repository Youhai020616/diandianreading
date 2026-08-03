from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from diandianreading.application.ports import AcquisitionRequest, NullProgressSink
from diandianreading.application.use_cases import (
    ZLIBRARY_RIGHTS_POLICY_VERSION,
    ZLibraryAcquisitionCommand,
    ZLibraryAcquisitionUseCase,
)
from diandianreading.domain import CredentialRef, DiandianError, ErrorCode, RightsBasis
from diandianreading.infrastructure.acquisition.zlibrary import (
    BoundedZLibraryDownloader,
    BrowserCookie,
    ZLibraryAcquirer,
    ZLibraryAdapterConfig,
    ZLibraryCredentialResolver,
    ZLibraryDownloadTicket,
    ZLibraryNetworkPolicy,
    ZLibrarySessionManager,
)
from diandianreading.infrastructure.persistence import (
    SQLiteDatabase,
    SQLiteRightsProvenanceRepository,
    SQLiteUnitOfWorkFactory,
)
from diandianreading.infrastructure.storage import LocalFileStore
from tests.support import FIXED_NOW, RecordingProgressSink, SequentialIds

PDF_BYTES = b"%PDF-1.7\nfull adapter fixture\n%%EOF\n"


class StaticResolver:
    def resolve(self, host: str, port: int):
        assert port == 443
        return {
            "zlibrary.invalid": ("8.8.8.8",),
            "download.invalid": ("1.1.1.1",),
        }[host]


class FakeBrowser:
    def __init__(self) -> None:
        self.authenticated = True
        self.capture_count = 0
        self.ticket_consumed = False
        self.selector_version = "zlibrary-dom-v1"

    async def login(self, **kwargs) -> bool:
        browser_profile = kwargs["browser_profile"]
        storage_state = kwargs["storage_state"]
        (browser_profile / "session.bin").write_bytes(b"session")
        storage_state.write_text(json.dumps({"cookies": [], "origins": []}), encoding="utf-8")
        return self.authenticated

    async def is_authenticated(self, **kwargs) -> bool:
        assert kwargs["browser_profile"].is_dir()
        return self.authenticated

    async def capture_download(self, **kwargs) -> ZLibraryDownloadTicket:
        assert kwargs["book_url"] == "https://zlibrary.invalid/book/synthetic-book"
        self.capture_count += 1
        self.ticket_consumed = True
        return ZLibraryDownloadTicket(
            url="https://download.invalid/files/synthetic.pdf?token=never-log",
            suggested_filename="synthetic.pdf",
            cookies=(BrowserCookie("session", "private", ".download.invalid", "/files"),),
            selector_version=self.selector_version,
        )


class FakeResponse:
    def __init__(self, *, mime_type: str = "application/pdf", content: bytes = PDF_BYTES) -> None:
        self.status = 200
        self.headers = (
            ("Content-Type", mime_type),
            ("Content-Length", str(len(content))),
            ("Content-Disposition", 'attachment; filename="synthetic.pdf"'),
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


class FakeTransport:
    def __init__(self, response: FakeResponse) -> None:
        self.response = response
        self.calls = []

    def open(self, destination, headers, **timeouts):
        self.calls.append((destination, dict(headers), dict(timeouts)))
        return self.response


def make_runtime(tmp_path: Path, *, adapter_enabled: bool = True, response=None):
    database = SQLiteDatabase(tmp_path / "state" / "app.sqlite3")
    database.migrate()
    config = ZLibraryAdapterConfig(
        enabled=adapter_enabled,
        base_url="https://zlibrary.invalid/",
        allowed_hosts=frozenset({"zlibrary.invalid", "download.invalid"}),
    )
    policy = ZLibraryNetworkPolicy(config.allowed_hosts, StaticResolver())
    resolver = ZLibraryCredentialResolver(tmp_path / "credentials")
    browser = FakeBrowser()
    session = ZLibrarySessionManager(
        resolver=resolver,
        browser=browser,
        network_policy=policy,
        config=config,
        clock=lambda: FIXED_NOW,
    )
    transport = FakeTransport(response or FakeResponse())
    downloader = BoundedZLibraryDownloader(
        network_policy=policy,
        limits=config.download,
        transport=transport,
    )
    store = LocalFileStore(tmp_path / "objects")
    adapter = ZLibraryAcquirer(
        store=store,
        resolver=resolver,
        session_manager=session,
        browser=browser,
        network_policy=policy,
        downloader=downloader,
        config=config,
        staging_root=tmp_path / "staging",
    )
    use_case = ZLibraryAcquisitionUseCase(
        unit_of_work=SQLiteUnitOfWorkFactory(database),
        acquirer=adapter,
        enabled=True,
        id_factory=SequentialIds("rights-1"),
        clock=lambda: FIXED_NOW,
    )
    return database, store, resolver, browser, session, transport, adapter, use_case


def command() -> ZLibraryAcquisitionCommand:
    return ZLibraryAcquisitionCommand(
        location="https://zlibrary.invalid/book/synthetic-book?tracking=removed",
        credential=CredentialRef("zlibrary", "test"),
        rights_basis=RightsBasis.PUBLIC_DOMAIN,
        license_identifier="Public Domain Mark 1.0",
        evidence_storage_key=None,
        attestation_version=ZLIBRARY_RIGHTS_POLICY_VERSION,
        rights_confirmed=True,
        options={"title": "Synthetic Fixture", "author": "Test Author"},
    )


def test_full_zlibrary_adapter_flow_verifies_publishes_cleans_and_binds_rights(tmp_path) -> None:
    database, store, resolver, browser, session, transport, _adapter, use_case = make_runtime(
        tmp_path
    )
    credential = CredentialRef("zlibrary", "test")
    asyncio.run(session.login(credential))
    progress = RecordingProgressSink([])

    result = asyncio.run(use_case.execute(command(), progress))

    asset = result.acquired.asset
    assert browser.capture_count == 1
    assert browser.ticket_consumed is True
    assert transport.calls[0][1]["Cookie"] == "session=private"
    assert asset.sha256 == result.rights_provenance.content_sha256
    assert asset.rights_provenance_id == result.rights_provenance.id
    assert asset.origin_locator == "https://zlibrary.invalid/book/synthetic-book"
    assert store.resolve_for_read(asset.storage_key).read_bytes() == PDF_BYTES
    assert list((tmp_path / "staging").iterdir()) == []
    assert len(progress.events) == 1
    assert SQLiteRightsProvenanceRepository(database).get("rights-1") == result.rights_provenance
    assert resolver.resolve_existing_profile(credential).browser_profile.is_dir()


def test_adapter_default_disabled_defense_leaves_unbound_attestation_and_no_browser_call(
    tmp_path,
) -> None:
    (
        database,
        _store,
        _resolver,
        browser,
        _session,
        _transport,
        _adapter,
        use_case,
    ) = make_runtime(tmp_path, adapter_enabled=False)

    with pytest.raises(DiandianError, match="disabled"):
        asyncio.run(use_case.execute(command()))

    persisted = SQLiteRightsProvenanceRepository(database).get("rights-1")
    assert persisted is not None
    assert persisted.content_sha256 is None
    assert browser.capture_count == 0
    assert list((tmp_path / "staging").iterdir()) == []


def test_invalid_download_fails_current_acquisition_cleans_staging_and_does_not_bind_rights(
    tmp_path,
) -> None:
    response = FakeResponse(mime_type="text/html", content=b"<html>login</html>")
    (
        database,
        _store,
        _resolver,
        browser,
        session,
        _transport,
        _adapter,
        use_case,
    ) = make_runtime(tmp_path, response=response)
    asyncio.run(session.login(CredentialRef("zlibrary", "test")))

    with pytest.raises(DiandianError) as raised:
        asyncio.run(use_case.execute(command()))

    assert raised.value.code is ErrorCode.FORMAT_UNSUPPORTED
    persisted = SQLiteRightsProvenanceRepository(database).get("rights-1")
    assert persisted is not None and persisted.content_sha256 is None
    assert browser.capture_count == 1
    assert response.closed is True
    assert list((tmp_path / "staging").iterdir()) == []
    assert list((tmp_path / "objects" / "originals").glob("*")) == []


def test_adapter_defense_in_depth_rejects_invalid_requests_before_browser(tmp_path) -> None:
    (
        _database,
        _store,
        _resolver,
        browser,
        _session,
        _transport,
        adapter,
        _use_case,
    ) = make_runtime(tmp_path)
    valid = {
        "provider": "zlibrary",
        "location": "https://zlibrary.invalid/book/synthetic-book",
        "rights_confirmed": True,
        "options": {
            "rights_provenance_id": "rights-1",
            "source_locator_redacted": "https://zlibrary.invalid/book/synthetic-book",
        },
        "credential": CredentialRef("zlibrary", "test"),
    }
    invalid_requests = (
        {**valid, "provider": "other"},
        {**valid, "rights_confirmed": False},
        {**valid, "options": {}},
        {**valid, "credential": None},
        {**valid, "credential": CredentialRef("other", "test")},
        {
            **valid,
            "options": {
                "rights_provenance_id": "rights-1",
                "source_locator_redacted": "https://zlibrary.invalid/book/other",
            },
        },
    )

    for values in invalid_requests:
        with pytest.raises(DiandianError) as raised:
            asyncio.run(
                adapter.acquire(
                    AcquisitionRequest(**values),  # type: ignore[arg-type]
                    NullProgressSink("test"),
                )
            )
        assert raised.value.code is ErrorCode.VALIDATION
    assert browser.capture_count == 0


def test_adapter_rejects_unreviewed_selector_version_and_keeps_rights_unbound(tmp_path) -> None:
    (
        database,
        _store,
        _resolver,
        browser,
        session,
        _transport,
        _adapter,
        use_case,
    ) = make_runtime(tmp_path)
    browser.selector_version = "unreviewed"
    asyncio.run(session.login(CredentialRef("zlibrary", "test")))

    with pytest.raises(DiandianError) as raised:
        asyncio.run(use_case.execute(command()))

    assert raised.value.code is ErrorCode.REMOTE_PROTOCOL_DRIFT
    persisted = SQLiteRightsProvenanceRepository(database).get("rights-1")
    assert persisted is not None and persisted.content_sha256 is None
