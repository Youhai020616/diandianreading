"""Exact-origin URL policy, public-address DNS pinning, and scoped cookies."""

from __future__ import annotations

import ipaddress
import re
import socket
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Protocol
from urllib.parse import unquote, urljoin, urlsplit, urlunsplit

from diandianreading.domain import DiandianError, ErrorCode

_BOOK_PATH = re.compile(
    r"^/book/(?P<book_id>[A-Za-z0-9_-]{1,128})(?:/(?P<slug>[A-Za-z0-9._~-]{1,240}))?/?$"
)
_COOKIE_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
_MAX_URL_LENGTH = 8192


class DnsResolver(Protocol):
    def resolve(self, host: str, port: int) -> Sequence[str]: ...


class SystemDnsResolver:
    def resolve(self, host: str, port: int) -> Sequence[str]:
        addresses: list[str] = []
        for family, socket_type, _protocol, _canonical, sockaddr in socket.getaddrinfo(
            host,
            port,
            type=socket.SOCK_STREAM,
        ):
            if socket_type != socket.SOCK_STREAM or family not in (socket.AF_INET, socket.AF_INET6):
                continue
            address = str(sockaddr[0])
            if address not in addresses:
                addresses.append(address)
        return tuple(addresses)


@dataclass(frozen=True, slots=True)
class ValidatedUrl:
    url: str
    redacted_url: str
    scheme: str
    host: str
    port: int
    path: str
    query: str

    @property
    def origin(self) -> str:
        return f"{self.scheme}://{self.host}"

    @property
    def request_target(self) -> str:
        return f"{self.path}?{self.query}" if self.query else self.path


@dataclass(frozen=True, slots=True)
class PinnedDestination:
    target: ValidatedUrl
    addresses: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class BrowserCookie:
    name: str
    value: str = field(repr=False)
    domain: str
    path: str = "/"
    secure: bool = True


class ZLibraryNetworkPolicy:
    """Validate each URL and bind each connection to already-checked public addresses."""

    def __init__(self, allowed_hosts: frozenset[str], resolver: DnsResolver | None = None) -> None:
        if not allowed_hosts:
            raise ValueError("Z-Library network policy needs an exact host allowlist")
        self._allowed_hosts = allowed_hosts
        self._resolver = resolver or SystemDnsResolver()

    @property
    def allowed_hosts(self) -> frozenset[str]:
        return self._allowed_hosts

    def canonicalize_book_url(self, location: str) -> str:
        validated = self.validate_url(location)
        match = _BOOK_PATH.fullmatch(validated.path)
        if match is None:
            raise _validation("Z-Library location is not a canonical book URL")
        book_id = match.group("book_id")
        slug = match.group("slug")
        path = f"/book/{book_id}"
        if slug:
            path += f"/{slug}"
        return urlunsplit(("https", validated.host, path, "", ""))

    def redact_url(self, location: str) -> str:
        validated = self.validate_url(location)
        return validated.redacted_url

    def validate_url(self, location: str) -> ValidatedUrl:
        if (
            not location
            or not location.startswith("https://")
            or location != location.strip()
            or len(location) > _MAX_URL_LENGTH
            or "\\" in location
            or any(ord(character) < 0x21 or ord(character) == 0x7F for character in location)
        ):
            raise _validation("Z-Library URL is malformed")
        parsed = urlsplit(location)
        try:
            port = parsed.port
        except ValueError as exc:
            raise _validation("Z-Library URL has an invalid port") from exc
        host = parsed.hostname
        if (
            parsed.scheme != "https"
            or not parsed.netloc
            or host is None
            or parsed.username is not None
            or parsed.password is not None
            or port not in (None, 443)
        ):
            raise _validation("Z-Library URL must use canonical HTTPS without credentials")
        raw_host = parsed.netloc.rsplit(":", 1)[0] if port is not None else parsed.netloc
        if (
            any(ord(character) > 127 for character in host)
            or host != host.casefold()
            or raw_host != host
        ):
            raise _validation("Z-Library URL host must be canonical lowercase ASCII")
        if host.endswith(".") or _is_ip_literal(host) or host not in self._allowed_hosts:
            raise _validation("Z-Library URL host is not allowed")
        if not parsed.path.startswith("/") or "%" in parsed.path:
            raise _validation("Z-Library URL path is ambiguous")
        try:
            decoded_path = unquote(parsed.path, errors="strict")
        except UnicodeError as exc:
            raise _validation("Z-Library URL path is malformed") from exc
        if any(segment in {".", ".."} for segment in decoded_path.split("/")) or any(
            ord(character) < 0x20 or character == "\\" for character in decoded_path
        ):
            raise _validation("Z-Library URL path is unsafe")
        if any(ord(character) < 0x20 or ord(character) == 0x7F for character in parsed.query):
            raise _validation("Z-Library URL query is malformed")

        canonical_url = urlunsplit(("https", host, parsed.path or "/", parsed.query, ""))
        redacted_url = urlunsplit(("https", host, parsed.path or "/", "", ""))
        return ValidatedUrl(
            url=canonical_url,
            redacted_url=redacted_url,
            scheme="https",
            host=host,
            port=443,
            path=parsed.path or "/",
            query=parsed.query,
        )

    def authorize(self, location: str) -> PinnedDestination:
        target = self.validate_url(location)
        try:
            resolved = self._resolver.resolve(target.host, target.port)
        except OSError as exc:
            raise DiandianError(
                ErrorCode.SOURCE_UNAVAILABLE,
                "Z-Library destination could not be resolved",
                retryable=True,
            ) from exc
        addresses: list[str] = []
        for raw_address in resolved:
            try:
                address = ipaddress.ip_address(raw_address)
            except ValueError as exc:
                raise _validation("Z-Library DNS returned an invalid address") from exc
            if not address.is_global:
                raise _validation("Z-Library destination resolved to a non-public address")
            normalized = address.compressed
            if normalized not in addresses:
                addresses.append(normalized)
        if not addresses:
            raise DiandianError(
                ErrorCode.SOURCE_UNAVAILABLE,
                "Z-Library destination did not resolve to an address",
                retryable=True,
            )
        return PinnedDestination(target=target, addresses=tuple(addresses))

    def authorize_redirect(self, current_url: str, location: str) -> PinnedDestination:
        if not location or any(ord(character) < 0x20 for character in location):
            raise _validation("Z-Library redirect location is malformed")
        redirected = urljoin(current_url, location)
        return self.authorize(redirected)

    def browser_host_resolver_rules(self) -> tuple[str, ...]:
        """Resolve every allowed browser host once and return Chromium pinning rules."""

        rules: list[str] = []
        for host in sorted(self._allowed_hosts):
            pinned = self.authorize(f"https://{host}/")
            address = next(
                (candidate for candidate in pinned.addresses if ":" not in candidate),
                pinned.addresses[0],
            )
            replacement = f"[{address}]" if ":" in address else address
            rules.append(f"MAP {host} {replacement}")
        return tuple(rules)


def cookie_header(cookies: Sequence[BrowserCookie], destination: ValidatedUrl) -> str | None:
    selected: list[str] = []
    for cookie in cookies:
        domain = cookie.domain.casefold().lstrip(".")
        domain_matches = destination.host == domain or (
            cookie.domain.startswith(".") and destination.host.endswith(f".{domain}")
        )
        path = cookie.path if cookie.path.startswith("/") else "/"
        path_matches = destination.path == path or destination.path.startswith(
            path.rstrip("/") + "/"
        )
        if (
            not domain_matches
            or not path_matches
            or (cookie.secure and destination.scheme != "https")
            or not _COOKIE_NAME.fullmatch(cookie.name)
            or any(character in cookie.value for character in ("\r", "\n", ";"))
        ):
            continue
        selected.append(f"{cookie.name}={cookie.value}")
    return "; ".join(selected) if selected else None


def _is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


def _validation(message: str) -> DiandianError:
    return DiandianError(ErrorCode.VALIDATION, message, retryable=False)
