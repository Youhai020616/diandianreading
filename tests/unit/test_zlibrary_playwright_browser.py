from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from diandianreading.domain import DiandianError, ErrorCode
from diandianreading.infrastructure.acquisition.zlibrary import (
    ZLIBRARY_SELECTORS_V1,
    PlaywrightZLibraryBrowser,
    ZLibraryNetworkPolicy,
)
from diandianreading.infrastructure.acquisition.zlibrary import playwright_browser as module


class StaticResolver:
    def resolve(self, host: str, port: int):
        assert host == "zlibrary.invalid"
        assert port == 443
        return ("8.8.8.8",)


class FakeRoute:
    def __init__(self) -> None:
        self.aborted = False
        self.continued = False

    async def abort(self, reason: str) -> None:
        assert reason == "blockedbyclient"
        self.aborted = True

    async def continue_(self) -> None:
        self.continued = True


class FakeRequest:
    def __init__(self, url: str) -> None:
        self.url = url


class FakeLocator:
    def __init__(self, page, selector: str) -> None:
        self.page = page
        self.selector = selector

    @property
    def first(self):
        return self

    async def is_visible(self, timeout: float) -> bool:
        assert timeout == 500
        if self.selector in ZLIBRARY_SELECTORS_V1.authenticated_markers:
            return self.page.context.authenticated
        if self.selector in ZLIBRARY_SELECTORS_V1.download_triggers:
            return self.page.context.download_visible and (
                self.selector == ZLIBRARY_SELECTORS_V1.download_triggers[0]
            )
        return False

    async def click(self) -> None:
        self.page.clicked = True


class FakeDownload:
    url = "https://zlibrary.invalid/files/book.pdf?token=secret"
    suggested_filename = "book.pdf"

    def __init__(self) -> None:
        self.cancelled = False

    async def cancel(self) -> None:
        self.cancelled = True


class FakeDownloadInfo:
    def __init__(self, download: FakeDownload) -> None:
        self.download = download

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_value, traceback) -> None:
        del exc_type, exc_value, traceback

    @property
    def value(self):
        async def resolve():
            return self.download

        return resolve()


class FakePage:
    def __init__(self, context) -> None:
        self.context = context
        self.clicked = False

    async def goto(self, url: str, *, wait_until: str, timeout: float) -> None:
        assert wait_until == "domcontentloaded"
        assert timeout > 0
        route = FakeRoute()
        await self.context.route_handler(route, FakeRequest(url))
        if self.context.blocked_subrequest is not None:
            blocked_route = FakeRoute()
            await self.context.route_handler(
                blocked_route,
                FakeRequest(self.context.blocked_subrequest),
            )
            if blocked_route.aborted:
                raise RuntimeError("synthetic blocked request")
        if route.aborted:
            raise RuntimeError("synthetic blocked navigation")

    def locator(self, selector: str) -> FakeLocator:
        return FakeLocator(self, selector)

    def expect_download(self, *, timeout: float) -> FakeDownloadInfo:
        assert timeout > 0
        return FakeDownloadInfo(self.context.download)


class FakeContext:
    def __init__(
        self,
        *,
        authenticated: bool,
        blocked_subrequest: str | None = None,
        download_visible: bool = True,
    ) -> None:
        self.authenticated = authenticated
        self.blocked_subrequest = blocked_subrequest
        self.download_visible = download_visible
        self.download = FakeDownload()
        self.route_handler = None
        self.closed = False
        self.page = FakePage(self)
        self.storage_state_path: Path | None = None

    async def route(self, pattern: str, handler) -> None:
        assert pattern == "**/*"
        self.route_handler = handler

    async def new_page(self) -> FakePage:
        return self.page

    async def storage_state(self, *, path: str) -> None:
        self.storage_state_path = Path(path)
        self.storage_state_path.write_text(
            json.dumps({"cookies": [], "origins": []}),
            encoding="utf-8",
        )

    async def cookies(self, urls):
        assert urls == [self.download.url]
        return [
            {
                "name": "session",
                "value": "secret-cookie",
                "domain": ".zlibrary.invalid",
                "path": "/files",
                "secure": True,
            }
        ]

    async def close(self) -> None:
        self.closed = True


class FakeChromium:
    def __init__(self, contexts: list[FakeContext]) -> None:
        self.contexts = contexts
        self.launches = []

    async def launch_persistent_context(self, profile: str, **kwargs):
        self.launches.append((profile, kwargs))
        return self.contexts.pop(0)


class FakePlaywright:
    def __init__(self, chromium: FakeChromium) -> None:
        self.chromium = chromium
        self.stop_count = 0

    async def stop(self) -> None:
        self.stop_count += 1


class FakeManager:
    def __init__(self, playwright: FakePlaywright) -> None:
        self.playwright = playwright

    async def start(self) -> FakePlaywright:
        return self.playwright


class FakePlaywrightModule:
    def __init__(self, playwright: FakePlaywright) -> None:
        self.playwright = playwright

    def async_playwright(self) -> FakeManager:
        return FakeManager(self.playwright)


def patch_playwright(monkeypatch, *contexts: FakeContext):
    chromium = FakeChromium(list(contexts))
    playwright = FakePlaywright(chromium)
    fake_module = FakePlaywrightModule(playwright)
    monkeypatch.setattr(module.importlib, "import_module", lambda name: fake_module)
    return chromium, playwright


def make_policy() -> ZLibraryNetworkPolicy:
    return ZLibraryNetworkPolicy(frozenset({"zlibrary.invalid"}), StaticResolver())


def test_playwright_browser_uses_persistent_context_real_marker_and_storage_snapshot(
    tmp_path, monkeypatch
) -> None:
    context = FakeContext(authenticated=True)
    chromium, playwright = patch_playwright(monkeypatch, context)
    browser_profile = tmp_path / "browser"
    browser_profile.mkdir()
    storage_state = tmp_path / "storage.json"

    authenticated = asyncio.run(
        PlaywrightZLibraryBrowser(headless=True).login(
            browser_profile=browser_profile,
            storage_state=storage_state,
            entry_url="https://zlibrary.invalid/",
            network_policy=make_policy(),
            selectors=ZLIBRARY_SELECTORS_V1,
            timeout_seconds=1,
        )
    )

    assert authenticated is True
    assert json.loads(storage_state.read_text())["cookies"] == []
    assert context.closed is True
    assert playwright.stop_count == 1
    profile, options = chromium.launches[0]
    assert profile == str(browser_profile)
    assert options["accept_downloads"] is True
    assert options["service_workers"] == "block"
    assert options["proxy"] == {"server": "direct://"}
    assert "--no-proxy-server" in options["args"]
    assert "--host-resolver-rules=MAP zlibrary.invalid 8.8.8.8" in options["args"]


def test_playwright_capture_consumes_expect_download_cancels_transfer_and_redacts_repr(
    tmp_path, monkeypatch
) -> None:
    context = FakeContext(authenticated=True)
    _chromium, playwright = patch_playwright(monkeypatch, context)
    browser_profile = tmp_path / "browser"
    browser_profile.mkdir()

    ticket = asyncio.run(
        PlaywrightZLibraryBrowser().capture_download(
            browser_profile=browser_profile,
            book_url="https://zlibrary.invalid/book/synthetic",
            network_policy=make_policy(),
            selectors=ZLIBRARY_SELECTORS_V1,
            timeout_seconds=1,
        )
    )

    assert context.page.clicked is True
    assert context.download.cancelled is True
    assert context.closed is True
    assert playwright.stop_count == 1
    assert ticket.url.endswith("?token=secret")
    assert ticket.cookies[0].value == "secret-cookie"
    assert "secret" not in repr(ticket)


def test_playwright_health_returns_false_without_authenticated_marker(
    tmp_path, monkeypatch
) -> None:
    context = FakeContext(authenticated=False)
    _chromium, playwright = patch_playwright(monkeypatch, context)
    browser_profile = tmp_path / "browser"
    browser_profile.mkdir()

    authenticated = asyncio.run(
        PlaywrightZLibraryBrowser().is_authenticated(
            browser_profile=browser_profile,
            entry_url="https://zlibrary.invalid/",
            network_policy=make_policy(),
            selectors=ZLIBRARY_SELECTORS_V1,
            timeout_seconds=0.001,
        )
    )

    assert authenticated is False
    assert context.closed is True
    assert playwright.stop_count == 1


def test_playwright_capture_rejects_expired_session_and_missing_reviewed_trigger(
    tmp_path, monkeypatch
) -> None:
    expired = FakeContext(authenticated=False)
    missing_trigger = FakeContext(authenticated=True, download_visible=False)
    _chromium, playwright = patch_playwright(monkeypatch, expired, missing_trigger)
    browser_profile = tmp_path / "browser"
    browser_profile.mkdir()
    browser = PlaywrightZLibraryBrowser()

    with pytest.raises(DiandianError) as auth:
        asyncio.run(
            browser.capture_download(
                browser_profile=browser_profile,
                book_url="https://zlibrary.invalid/book/synthetic",
                network_policy=make_policy(),
                selectors=ZLIBRARY_SELECTORS_V1,
                timeout_seconds=0.001,
            )
        )
    with pytest.raises(DiandianError) as selector:
        asyncio.run(
            browser.capture_download(
                browser_profile=browser_profile,
                book_url="https://zlibrary.invalid/book/synthetic",
                network_policy=make_policy(),
                selectors=ZLIBRARY_SELECTORS_V1,
                timeout_seconds=0.01,
            )
        )

    assert auth.value.code is ErrorCode.AUTH_REQUIRED
    assert selector.value.code is ErrorCode.REMOTE_PROTOCOL_DRIFT
    assert expired.closed and missing_trigger.closed
    assert playwright.stop_count == 2


def test_playwright_route_blocks_disallowed_browser_subrequest(tmp_path, monkeypatch) -> None:
    context = FakeContext(
        authenticated=True,
        blocked_subrequest="https://evil.invalid/tracker",
    )
    _chromium, playwright = patch_playwright(monkeypatch, context)
    browser_profile = tmp_path / "browser"
    browser_profile.mkdir()

    with pytest.raises(DiandianError) as raised:
        asyncio.run(
            PlaywrightZLibraryBrowser().is_authenticated(
                browser_profile=browser_profile,
                entry_url="https://zlibrary.invalid/",
                network_policy=make_policy(),
                selectors=ZLIBRARY_SELECTORS_V1,
                timeout_seconds=0.01,
            )
        )

    assert raised.value.code is ErrorCode.VALIDATION
    assert context.closed is True
    assert playwright.stop_count == 1


def test_playwright_optional_dependency_failure_is_typed_and_safe(monkeypatch) -> None:
    def missing(name: str):
        raise ModuleNotFoundError(name)

    monkeypatch.setattr(module.importlib, "import_module", missing)
    with pytest.raises(DiandianError) as raised:
        asyncio.run(
            PlaywrightZLibraryBrowser().is_authenticated(
                browser_profile=Path("unused"),
                entry_url="https://zlibrary.invalid/",
                network_policy=make_policy(),
                selectors=ZLIBRARY_SELECTORS_V1,
                timeout_seconds=0.01,
            )
        )
    assert raised.value.code is ErrorCode.VALIDATION
    assert "zlibrary extra" in raised.value.public_message
