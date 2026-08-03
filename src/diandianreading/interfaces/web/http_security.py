"""HTTP-specific enforcement for ADR-0005's local single-origin boundary."""

from __future__ import annotations

import asyncio
import time
from collections import defaultdict, deque
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import StrEnum
from threading import Lock
from urllib.parse import urlsplit

from fastapi import Request

from diandianreading.infrastructure.local_api import (
    AuthenticatedSession,
    CsrfValidationError,
    InstallTokenAuthenticationError,
    LocalApiSecurityError,
    LocalApiSecurityService,
    SessionAuthenticationError,
)

SESSION_COOKIE = "diandian_session"
CSRF_COOKIE = "diandian_csrf"
CSRF_HEADER = "x-csrf-token"
_FORWARDED_HEADERS = frozenset(
    {"forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"}
)
_SAFE_METHODS = frozenset({"GET", "HEAD"})


class LocalHttpError(RuntimeError):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.safe_message = message


class PrincipalKind(StrEnum):
    BROWSER_SESSION = "browser_session"
    INSTALL_TOKEN = "install_token"


@dataclass(frozen=True, slots=True)
class RequestPrincipal:
    kind: PrincipalKind
    session: AuthenticatedSession | None = None


@dataclass(frozen=True, slots=True)
class LocalHttpConfig:
    canonical_origin: str = "http://localhost:3000"
    allowed_hosts: frozenset[str] = field(
        default_factory=lambda: frozenset({"localhost:3000", "127.0.0.1:3000", "[::1]:3000"})
    )
    allowed_peers: frozenset[str] = field(default_factory=lambda: frozenset({"127.0.0.1", "::1"}))
    max_header_bytes: int = 16 * 1024
    max_headers: int = 64
    max_request_target_bytes: int = 4 * 1024
    max_json_bytes: int = 64 * 1024
    max_sse_connections_per_session: int = 2
    sse_poll_seconds: float = 0.5
    sse_heartbeat_seconds: float = 15.0
    sse_max_seconds: float = 5 * 60.0

    def __post_init__(self) -> None:
        parsed = urlsplit(self.canonical_origin)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
            or parsed.username
            or parsed.password
        ):
            raise ValueError("Canonical local origin is invalid")
        if not self.allowed_hosts or not self.allowed_peers:
            raise ValueError("Local HTTP Host and peer allowlists cannot be empty")
        integer_limits = (
            self.max_header_bytes,
            self.max_headers,
            self.max_request_target_bytes,
            self.max_json_bytes,
            self.max_sse_connections_per_session,
        )
        if any(type(value) is not int or value <= 0 for value in integer_limits):
            raise ValueError("Local HTTP integer limits must be positive")
        durations = (
            self.sse_poll_seconds,
            self.sse_heartbeat_seconds,
            self.sse_max_seconds,
        )
        if any(value <= 0 for value in durations):
            raise ValueError("Local HTTP SSE durations must be positive")
        if self.sse_poll_seconds > self.sse_heartbeat_seconds:
            raise ValueError("SSE poll interval cannot exceed the heartbeat interval")

    @property
    def secure_cookies(self) -> bool:
        return self.canonical_origin.startswith("https://")


class LocalHttpSecurityBoundary:
    def __init__(self, service: LocalApiSecurityService, config: LocalHttpConfig) -> None:
        self._service = service
        self._config = config

    def validate_network_boundary(self, request: Request) -> None:
        raw_headers = tuple(request.scope.get("headers", ()))
        if len(raw_headers) > self._config.max_headers:
            raise LocalHttpError(431, "VALIDATION", "Request headers exceed the local limit")
        header_bytes = sum(len(name) + len(value) + 4 for name, value in raw_headers)
        if header_bytes > self._config.max_header_bytes:
            raise LocalHttpError(431, "VALIDATION", "Request headers exceed the local limit")

        names = [name.decode("latin-1").casefold() for name, _ in raw_headers]
        if any(name in _FORWARDED_HEADERS for name in names):
            raise LocalHttpError(403, "VALIDATION", "Forwarded request headers are not accepted")
        if names.count("host") != 1:
            raise LocalHttpError(403, "VALIDATION", "Request Host is not allowed")
        if names.count("cookie") > 1 or names.count("authorization") > 1:
            raise LocalHttpError(400, "VALIDATION", "Duplicate security headers are not accepted")

        host = request.headers.get("host", "").casefold()
        if host not in self._config.allowed_hosts:
            raise LocalHttpError(403, "VALIDATION", "Request Host is not allowed")
        client = request.client
        if client is None or client.host not in self._config.allowed_peers:
            raise LocalHttpError(403, "VALIDATION", "Request peer is not allowed")

        query = request.scope.get("query_string", b"")
        raw_path = request.scope.get("raw_path", b"")
        if not isinstance(query, bytes) or not isinstance(raw_path, bytes):
            raise LocalHttpError(400, "VALIDATION", "Request target is invalid")
        target_size = len(raw_path) + (1 + len(query) if query else 0)
        if target_size > self._config.max_request_target_bytes:
            raise LocalHttpError(414, "VALIDATION", "Request target exceeds the local limit")
        if request.method == "OPTIONS":
            raise LocalHttpError(403, "VALIDATION", "Cross-origin preflight is not accepted")

    def authenticate(
        self,
        request: Request,
        *,
        require_csrf: bool = False,
        session_only: bool = False,
    ) -> RequestPrincipal:
        cookie_header = request.headers.get("cookie")
        if cookie_header is not None:
            if request.headers.get("authorization") is not None:
                raise self._authentication_error()
            self._validate_browser_origin(request)
            session_token = _single_cookie(cookie_header, SESSION_COOKIE)
            if session_token is None:
                raise self._authentication_error()
            try:
                session = self._service.authenticate_session(session_token)
                if require_csrf:
                    csrf_cookie = _single_cookie(cookie_header, CSRF_COOKIE)
                    csrf_header = _single_header(request, CSRF_HEADER)
                    self._service.validate_csrf(session, csrf_header, csrf_cookie)
            except (SessionAuthenticationError, CsrfValidationError, LocalApiSecurityError):
                raise self._authentication_error() from None
            return RequestPrincipal(PrincipalKind.BROWSER_SESSION, session)

        if session_only:
            raise self._authentication_error()
        try:
            _ = self._service.authenticate_bearer(_single_header(request, "authorization"))
        except (InstallTokenAuthenticationError, LocalApiSecurityError):
            raise self._authentication_error() from None
        return RequestPrincipal(PrincipalKind.INSTALL_TOKEN)

    def require_bootstrap_origin(self, request: Request) -> None:
        if _single_header(request, "origin") != self._config.canonical_origin:
            raise LocalHttpError(403, "VALIDATION", "Browser Origin is not allowed")

    def session_is_active(self, session: AuthenticatedSession) -> bool:
        return self._service.is_session_active(session)

    def _validate_browser_origin(self, request: Request) -> None:
        origin = _single_header(request, "origin")
        if origin == self._config.canonical_origin:
            return
        if origin is not None or request.method not in _SAFE_METHODS:
            raise LocalHttpError(403, "VALIDATION", "Browser Origin is not allowed")
        if _single_header(request, "sec-fetch-site") != "same-origin":
            raise LocalHttpError(403, "VALIDATION", "Browser Origin is not allowed")

    @staticmethod
    def _authentication_error() -> LocalHttpError:
        return LocalHttpError(401, "AUTH_REQUIRED", "Local API authentication is required")


class FixedWindowRateLimiter:
    """Small in-memory limiter for bootstrap and side-effect request categories."""

    def __init__(
        self,
        *,
        limit: int,
        window_seconds: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if limit <= 0 or window_seconds <= 0:
            raise ValueError("Rate limiter values must be positive")
        self._limit = limit
        self._window = window_seconds
        self._clock = clock
        self._entries: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def allow(self, key: str) -> bool:
        now = self._clock()
        threshold = now - self._window
        with self._lock:
            entries = self._entries[key]
            while entries and entries[0] <= threshold:
                entries.popleft()
            if len(entries) >= self._limit:
                return False
            entries.append(now)
            return True


class SseConnectionLimiter:
    def __init__(self, per_session_limit: int) -> None:
        if per_session_limit <= 0:
            raise ValueError("SSE connection limit must be positive")
        self._limit = per_session_limit
        self._counts: dict[str, int] = {}
        self._lock = asyncio.Lock()

    async def acquire(self, session_id: str) -> bool:
        async with self._lock:
            current = self._counts.get(session_id, 0)
            if current >= self._limit:
                return False
            self._counts[session_id] = current + 1
            return True

    async def release(self, session_id: str) -> None:
        async with self._lock:
            current = self._counts.get(session_id, 0)
            if current <= 1:
                self._counts.pop(session_id, None)
            else:
                self._counts[session_id] = current - 1


def _single_header(request: Request, name: str) -> str | None:
    values = request.headers.getlist(name)
    if len(values) > 1:
        raise LocalHttpError(400, "VALIDATION", "Duplicate security headers are not accepted")
    return values[0] if values else None


def _single_cookie(raw_cookie: str, name: str) -> str | None:
    matches: list[str] = []
    for item in raw_cookie.split(";"):
        key, separator, value = item.strip().partition("=")
        if separator and key == name:
            matches.append(value)
    if len(matches) > 1:
        raise LocalHttpError(400, "VALIDATION", "Duplicate security cookies are not accepted")
    return matches[0] if matches else None
