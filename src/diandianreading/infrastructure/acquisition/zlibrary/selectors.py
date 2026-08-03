"""Versioned, reviewable DOM selectors for the isolated browser Adapter."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ZLibrarySelectorSet:
    version: str
    authenticated_markers: tuple[str, ...]
    download_triggers: tuple[str, ...]

    def __post_init__(self) -> None:
        if not self.version.strip():
            raise ValueError("Z-Library selector version is required")
        if not self.authenticated_markers or not self.download_triggers:
            raise ValueError("Z-Library selector sets cannot be empty")
        if any(
            not selector.strip()
            for selector in (*self.authenticated_markers, *self.download_triggers)
        ):
            raise ValueError("Z-Library selectors cannot be empty")


ZLIBRARY_SELECTORS_V1 = ZLibrarySelectorSet(
    version="zlibrary-dom-v1",
    authenticated_markers=(
        "a[href='/users/logout.php']",
        "a[href*='/logout']",
        "[data-testid='user-menu']",
    ),
    download_triggers=(
        "a[data-testid='download-button']",
        "a[href*='/dl/']",
        "a[href*='/download/']",
    ),
)
