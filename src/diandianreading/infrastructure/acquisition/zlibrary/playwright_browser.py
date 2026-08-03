"""Lazy Playwright browser implementation for interactive Z-Library sessions."""

from __future__ import annotations

import asyncio
import importlib
import time
from pathlib import Path
from typing import Any

from diandianreading.domain import DiandianError, ErrorCode
from diandianreading.infrastructure.acquisition.zlibrary.browser import (
    ZLibraryBrowserPort,
    ZLibraryDownloadTicket,
)
from diandianreading.infrastructure.acquisition.zlibrary.network import (
    BrowserCookie,
    ZLibraryNetworkPolicy,
)
from diandianreading.infrastructure.acquisition.zlibrary.selectors import ZLibrarySelectorSet


class PlaywrightZLibraryBrowser(ZLibraryBrowserPort):
    """Use a persistent isolated Profile and cancel Playwright's unbounded transfer."""

    def __init__(self, *, headless: bool = False) -> None:
        self._headless = headless

    async def login(
        self,
        *,
        browser_profile: Path,
        storage_state: Path,
        entry_url: str,
        network_policy: ZLibraryNetworkPolicy,
        selectors: ZLibrarySelectorSet,
        timeout_seconds: float,
    ) -> bool:
        context, blocked, playwright = await self._open_context(browser_profile, network_policy)
        try:
            page = await context.new_page()
            await self._navigate(page, entry_url, timeout_seconds, blocked)
            authenticated = await self._wait_for_authenticated(
                page,
                selectors,
                timeout_seconds=timeout_seconds,
            )
            if authenticated:
                await context.storage_state(path=str(storage_state))
            self._raise_blocked(blocked)
            return authenticated
        finally:
            try:
                await context.close()
            finally:
                await playwright.stop()

    async def is_authenticated(
        self,
        *,
        browser_profile: Path,
        entry_url: str,
        network_policy: ZLibraryNetworkPolicy,
        selectors: ZLibrarySelectorSet,
        timeout_seconds: float,
    ) -> bool:
        context, blocked, playwright = await self._open_context(browser_profile, network_policy)
        try:
            page = await context.new_page()
            await self._navigate(page, entry_url, min(timeout_seconds, 30.0), blocked)
            authenticated = await self._wait_for_authenticated(
                page,
                selectors,
                timeout_seconds=min(timeout_seconds, 30.0),
            )
            self._raise_blocked(blocked)
            return authenticated
        finally:
            try:
                await context.close()
            finally:
                await playwright.stop()

    async def capture_download(
        self,
        *,
        browser_profile: Path,
        book_url: str,
        network_policy: ZLibraryNetworkPolicy,
        selectors: ZLibrarySelectorSet,
        timeout_seconds: float,
    ) -> ZLibraryDownloadTicket:
        _ = network_policy.authorize(book_url)
        context, blocked, playwright = await self._open_context(browser_profile, network_policy)
        download: Any | None = None
        try:
            page = await context.new_page()
            await self._navigate(page, book_url, min(timeout_seconds, 60.0), blocked)
            if not await self._wait_for_authenticated(
                page,
                selectors,
                timeout_seconds=min(timeout_seconds, 30.0),
            ):
                raise _auth_required("Z-Library profile is missing or expired")
            trigger = await self._first_visible(page, selectors.download_triggers)
            if trigger is None:
                raise DiandianError(
                    ErrorCode.REMOTE_PROTOCOL_DRIFT,
                    "Z-Library download control no longer matches the reviewed selector set",
                    retryable=False,
                )
            async with page.expect_download(timeout=timeout_seconds * 1000) as download_info:
                await trigger.click()
            captured_download = await download_info.value
            download = captured_download
            download_url = str(captured_download.url)
            suggested_filename = str(captured_download.suggested_filename)
            _ = network_policy.authorize(download_url)
            raw_cookies = await context.cookies([download_url])
            cookies = tuple(_browser_cookie(item) for item in raw_cookies)
            self._raise_blocked(blocked)
            return ZLibraryDownloadTicket(
                url=download_url,
                suggested_filename=suggested_filename,
                cookies=cookies,
                selector_version=selectors.version,
            )
        finally:
            try:
                if download is not None:
                    await download.cancel()
            finally:
                try:
                    await context.close()
                finally:
                    await playwright.stop()

    async def _open_context(
        self,
        browser_profile: Path,
        network_policy: ZLibraryNetworkPolicy,
    ) -> tuple[Any, list[DiandianError], Any]:
        playwright_module = _playwright_module()
        playwright = await playwright_module.async_playwright().start()
        rules = ",".join(network_policy.browser_host_resolver_rules())
        try:
            context = await playwright.chromium.launch_persistent_context(
                str(browser_profile),
                headless=self._headless,
                accept_downloads=True,
                service_workers="block",
                proxy={"server": "direct://"},
                args=[
                    "--no-proxy-server",
                    "--proxy-bypass-list=*",
                    f"--host-resolver-rules={rules}",
                ],
            )
        except Exception as exc:
            await playwright.stop()
            raise DiandianError(
                ErrorCode.SOURCE_UNAVAILABLE,
                "Z-Library browser could not be started",
                retryable=True,
            ) from exc
        except BaseException:
            await playwright.stop()
            raise

        blocked: list[DiandianError] = []

        async def route_request(route: Any, request: Any) -> None:
            try:
                await asyncio.to_thread(network_policy.authorize, str(request.url))
            except DiandianError as exc:
                blocked.append(exc)
                await route.abort("blockedbyclient")
                return
            await route.continue_()

        try:
            await context.route("**/*", route_request)
        except Exception as exc:
            try:
                await context.close()
            finally:
                await playwright.stop()
            raise DiandianError(
                ErrorCode.REMOTE_PROTOCOL_DRIFT,
                "Z-Library browser network interception could not be installed",
                retryable=False,
            ) from exc
        except BaseException:
            try:
                await context.close()
            finally:
                await playwright.stop()
            raise
        return context, blocked, playwright

    @staticmethod
    async def _navigate(
        page: Any,
        url: str,
        timeout_seconds: float,
        blocked: list[DiandianError],
    ) -> None:
        try:
            await page.goto(
                url,
                wait_until="domcontentloaded",
                timeout=timeout_seconds * 1000,
            )
        except Exception as exc:
            if blocked:
                raise blocked[0] from exc
            raise DiandianError(
                ErrorCode.SOURCE_UNAVAILABLE,
                "Z-Library page could not be loaded",
                retryable=True,
            ) from exc

    @classmethod
    async def _wait_for_authenticated(
        cls,
        page: Any,
        selectors: ZLibrarySelectorSet,
        *,
        timeout_seconds: float,
    ) -> bool:
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            if await cls._first_visible(page, selectors.authenticated_markers) is not None:
                return True
            await asyncio.sleep(0.25)
        return False

    @staticmethod
    async def _first_visible(page: Any, selectors: tuple[str, ...]) -> Any | None:
        for selector in selectors:
            locator = page.locator(selector).first
            try:
                if await locator.is_visible(timeout=500):
                    return locator
            except Exception:
                continue
        return None

    @staticmethod
    def _raise_blocked(blocked: list[DiandianError]) -> None:
        if blocked:
            raise blocked[0]


def _playwright_module() -> Any:
    try:
        return importlib.import_module("playwright.async_api")
    except ModuleNotFoundError as exc:
        raise DiandianError(
            ErrorCode.VALIDATION,
            "Z-Library browser support is not installed; install the zlibrary extra",
            retryable=False,
        ) from exc


def _browser_cookie(raw: object) -> BrowserCookie:
    if not isinstance(raw, dict):
        raise DiandianError(
            ErrorCode.REMOTE_PROTOCOL_DRIFT,
            "Z-Library browser returned an invalid Cookie record",
            retryable=False,
        )
    return BrowserCookie(
        name=str(raw.get("name", "")),
        value=str(raw.get("value", "")),
        domain=str(raw.get("domain", "")),
        path=str(raw.get("path", "/")),
        secure=bool(raw.get("secure", True)),
    )


def _auth_required(message: str) -> DiandianError:
    return DiandianError(ErrorCode.AUTH_REQUIRED, message, retryable=False)
