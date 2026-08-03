"""Finite, fail-closed configuration for the optional Z-Library Adapter."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from urllib.parse import urlsplit


@dataclass(frozen=True, slots=True)
class ZLibraryDownloadLimits:
    max_bytes: int = 100 * 1024 * 1024
    max_header_bytes: int = 32 * 1024
    max_headers: int = 100
    max_redirects: int = 5
    connect_timeout_seconds: float = 10.0
    first_byte_timeout_seconds: float = 20.0
    idle_timeout_seconds: float = 20.0
    total_timeout_seconds: float = 180.0

    def __post_init__(self) -> None:
        integer_limits = (
            self.max_bytes,
            self.max_header_bytes,
            self.max_headers,
        )
        if any(value <= 0 for value in integer_limits):
            raise ValueError("Z-Library download limits must be positive")
        if self.max_redirects < 0:
            raise ValueError("Z-Library redirect limit cannot be negative")
        timeouts = (
            self.connect_timeout_seconds,
            self.first_byte_timeout_seconds,
            self.idle_timeout_seconds,
            self.total_timeout_seconds,
        )
        if any(value <= 0 or not math.isfinite(value) for value in timeouts):
            raise ValueError("Z-Library download timeouts must be positive and finite")


@dataclass(frozen=True, slots=True)
class ZLibraryArchiveLimits:
    max_entries: int = 10_000
    max_entry_bytes: int = 64 * 1024 * 1024
    max_total_uncompressed_bytes: int = 256 * 1024 * 1024
    max_compression_ratio: float = 200.0
    max_directory_depth: int = 32
    max_filename_length: int = 255

    def __post_init__(self) -> None:
        integer_limits = (
            self.max_entries,
            self.max_entry_bytes,
            self.max_total_uncompressed_bytes,
            self.max_directory_depth,
            self.max_filename_length,
        )
        if any(value <= 0 for value in integer_limits) or (
            self.max_compression_ratio <= 0 or not math.isfinite(self.max_compression_ratio)
        ):
            raise ValueError("Z-Library archive limits must be positive and finite")


@dataclass(frozen=True, slots=True)
class ZLibraryAdapterConfig:
    enabled: bool = False
    base_url: str = "https://z-library.sk/"
    allowed_hosts: frozenset[str] = field(default_factory=lambda: frozenset({"z-library.sk"}))
    download: ZLibraryDownloadLimits = field(default_factory=ZLibraryDownloadLimits)
    archive: ZLibraryArchiveLimits = field(default_factory=ZLibraryArchiveLimits)
    browser_action_timeout_seconds: float = 15 * 60.0
    headless: bool = False

    def __post_init__(self) -> None:
        if not self.allowed_hosts:
            raise ValueError("Z-Library requires at least one exact allowed host")
        normalized_hosts = frozenset(_normalize_host(host) for host in self.allowed_hosts)
        if normalized_hosts != self.allowed_hosts:
            raise ValueError("Z-Library allowed hosts must already be lowercase canonical ASCII")
        parsed = urlsplit(self.base_url)
        try:
            port = parsed.port
        except ValueError as exc:
            raise ValueError("Z-Library base URL has an invalid port") from exc
        raw_host = parsed.netloc.rsplit(":", 1)[0] if port is not None else parsed.netloc
        if (
            parsed.scheme != "https"
            or parsed.hostname not in normalized_hosts
            or raw_host != parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or port not in (None, 443)
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("Z-Library base URL must use an allowed canonical HTTPS origin")
        if self.browser_action_timeout_seconds <= 0 or not math.isfinite(
            self.browser_action_timeout_seconds
        ):
            raise ValueError("Z-Library browser action timeout must be positive and finite")


def _normalize_host(host: str) -> str:
    if not host or host != host.strip() or host.endswith("."):
        raise ValueError("Z-Library allowed hosts must be non-empty canonical names")
    if any(ord(character) > 127 for character in host):
        raise ValueError("Z-Library allowed hosts must use canonical ASCII")
    normalized = host.casefold()
    if len(normalized) > 253:
        raise ValueError("Z-Library allowed host is too long")
    labels = normalized.split(".")
    if any(
        not label
        or len(label) > 63
        or label.startswith("-")
        or label.endswith("-")
        or any(not (character.isalnum() or character == "-") for character in label)
        for label in labels
    ):
        raise ValueError("Z-Library allowed host is not a valid DNS name")
    return normalized
