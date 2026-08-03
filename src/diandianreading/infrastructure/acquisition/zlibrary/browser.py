"""Browser-facing protocols and secret-safe download tickets."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from diandianreading.infrastructure.acquisition.zlibrary.network import (
    BrowserCookie,
    ZLibraryNetworkPolicy,
)
from diandianreading.infrastructure.acquisition.zlibrary.selectors import ZLibrarySelectorSet


@dataclass(frozen=True, slots=True)
class ZLibraryDownloadTicket:
    url: str = ""
    suggested_filename: str = ""
    cookies: tuple[BrowserCookie, ...] = ()
    selector_version: str = ""

    def __post_init__(self) -> None:
        if not self.url or not self.selector_version:
            raise ValueError("Z-Library download ticket URL and selector version are required")

    def __repr__(self) -> str:
        return (
            "ZLibraryDownloadTicket(url='<redacted>', "
            "suggested_filename='<redacted>', cookies='<redacted>', "
            f"selector_version={self.selector_version!r})"
        )


class ZLibraryBrowserPort(Protocol):
    async def login(
        self,
        *,
        browser_profile: Path,
        storage_state: Path,
        entry_url: str,
        network_policy: ZLibraryNetworkPolicy,
        selectors: ZLibrarySelectorSet,
        timeout_seconds: float,
    ) -> bool: ...

    async def is_authenticated(
        self,
        *,
        browser_profile: Path,
        entry_url: str,
        network_policy: ZLibraryNetworkPolicy,
        selectors: ZLibrarySelectorSet,
        timeout_seconds: float,
    ) -> bool: ...

    async def capture_download(
        self,
        *,
        browser_profile: Path,
        book_url: str,
        network_policy: ZLibraryNetworkPolicy,
        selectors: ZLibrarySelectorSet,
        timeout_seconds: float,
    ) -> ZLibraryDownloadTicket: ...
