"""Pinned-HTTPS, manually redirected, bounded Z-Library download streaming."""

from __future__ import annotations

import hashlib
import http.client
import os
import re
import socket
import ssl
import stat
import tempfile
import time
import unicodedata
from collections.abc import Callable, Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass
from email.message import Message
from pathlib import Path
from typing import Protocol

from diandianreading.domain import DiandianError, ErrorCode, UnsafePathError
from diandianreading.infrastructure.acquisition.zlibrary.browser import ZLibraryDownloadTicket
from diandianreading.infrastructure.acquisition.zlibrary.config import ZLibraryDownloadLimits
from diandianreading.infrastructure.acquisition.zlibrary.network import (
    PinnedDestination,
    ZLibraryNetworkPolicy,
    cookie_header,
)

_CHUNK_SIZE = 1024 * 1024
_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
_ALLOWED_MIME_TYPES = frozenset({"application/pdf", "application/epub+zip"})
_HEADER_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")


class HttpResponseStream(Protocol):
    @property
    def status(self) -> int: ...

    @property
    def headers(self) -> Sequence[tuple[str, str]]: ...

    def read(self, size: int) -> bytes: ...

    def close(self) -> None: ...


class PinnedHttpsTransport(Protocol):
    def open(
        self,
        destination: PinnedDestination,
        headers: Mapping[str, str],
        *,
        connect_timeout_seconds: float,
        first_byte_timeout_seconds: float,
        idle_timeout_seconds: float,
    ) -> HttpResponseStream: ...


@dataclass(frozen=True, slots=True)
class DownloadedFile:
    path: Path
    display_filename: str
    mime_type: str
    size_bytes: int
    sha256: str
    source_locator_redacted: str

    def __repr__(self) -> str:
        return (
            "DownloadedFile(path='<private-staging>', "
            f"display_filename={self.display_filename!r}, mime_type={self.mime_type!r}, "
            f"size_bytes={self.size_bytes!r}, sha256={self.sha256!r}, "
            f"source_locator_redacted={self.source_locator_redacted!r})"
        )


class BoundedZLibraryDownloader:
    def __init__(
        self,
        *,
        network_policy: ZLibraryNetworkPolicy,
        limits: ZLibraryDownloadLimits,
        transport: PinnedHttpsTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._network_policy = network_policy
        self._limits = limits
        self._transport = transport or StdlibPinnedHttpsTransport()
        self._clock = clock

    def download(self, ticket: ZLibraryDownloadTicket, staging_directory: Path) -> DownloadedFile:
        staging = _prepare_staging_directory(staging_directory)
        started_at = self._clock()
        destination = self._network_policy.authorize(ticket.url)
        redirects = 0
        while True:
            self._assert_total_timeout(started_at)
            headers = {
                "Accept": "application/pdf, application/epub+zip",
                "Accept-Encoding": "identity",
                "Connection": "close",
                "User-Agent": "diandianreading-zlibrary-adapter/1",
            }
            scoped_cookies = cookie_header(ticket.cookies, destination.target)
            if scoped_cookies is not None:
                headers["Cookie"] = scoped_cookies
            response = self._open(destination, headers)
            try:
                response_headers = _validated_headers(response.headers, self._limits)
                if response.status in _REDIRECT_STATUSES:
                    redirects += 1
                    if redirects > self._limits.max_redirects:
                        raise _validation("Z-Library download exceeded the redirect limit")
                    location = _single_header(response_headers, "location", required=True)
                    assert location is not None
                    destination = self._network_policy.authorize_redirect(
                        destination.target.url,
                        location,
                    )
                    continue
                if not 200 <= response.status < 300:
                    raise DiandianError(
                        ErrorCode.SOURCE_UNAVAILABLE,
                        "Z-Library download endpoint did not return a document",
                        retryable=response.status >= 500 or response.status == 429,
                    )
                return self._stream_response(
                    response,
                    response_headers,
                    ticket=ticket,
                    destination=destination,
                    staging=staging,
                    started_at=started_at,
                )
            finally:
                response.close()

    def _open(
        self,
        destination: PinnedDestination,
        headers: Mapping[str, str],
    ) -> HttpResponseStream:
        try:
            return self._transport.open(
                destination,
                headers,
                connect_timeout_seconds=self._limits.connect_timeout_seconds,
                first_byte_timeout_seconds=self._limits.first_byte_timeout_seconds,
                idle_timeout_seconds=self._limits.idle_timeout_seconds,
            )
        except TimeoutError as exc:
            raise DiandianError(
                ErrorCode.DOWNLOAD_TIMEOUT,
                "Z-Library download timed out before the response",
                retryable=True,
            ) from exc
        except (OSError, http.client.HTTPException) as exc:
            raise DiandianError(
                ErrorCode.SOURCE_UNAVAILABLE,
                "Z-Library download connection failed",
                retryable=True,
            ) from exc

    def _stream_response(
        self,
        response: HttpResponseStream,
        headers: Mapping[str, tuple[str, ...]],
        *,
        ticket: ZLibraryDownloadTicket,
        destination: PinnedDestination,
        staging: Path,
        started_at: float,
    ) -> DownloadedFile:
        content_encoding = _single_header(headers, "content-encoding")
        if content_encoding is not None and content_encoding.casefold() != "identity":
            raise _validation("Z-Library download used an unsupported content encoding")
        mime_header = _single_header(headers, "content-type", required=True)
        assert mime_header is not None
        mime_type = mime_header.partition(";")[0].strip().casefold()
        if mime_type not in _ALLOWED_MIME_TYPES:
            raise DiandianError(
                ErrorCode.FORMAT_UNSUPPORTED,
                "Z-Library response MIME type is not an allowed document format",
                retryable=False,
            )
        declared_length = _content_length(headers)
        if declared_length is not None and declared_length > self._limits.max_bytes:
            raise DiandianError(
                ErrorCode.SOURCE_LIMIT_EXCEEDED,
                "Z-Library document exceeds the configured byte limit",
                retryable=False,
            )

        descriptor, temporary_name = tempfile.mkstemp(
            dir=staging,
            prefix="download-",
            suffix=".staging",
        )
        temporary = Path(temporary_name)
        digest = hashlib.sha256()
        size_bytes = 0
        try:
            if hasattr(os, "fchmod"):
                os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb") as output:
                while True:
                    self._assert_total_timeout(started_at)
                    try:
                        chunk = response.read(_CHUNK_SIZE)
                    except TimeoutError as exc:
                        raise DiandianError(
                            ErrorCode.DOWNLOAD_TIMEOUT,
                            "Z-Library download stalled",
                            retryable=True,
                        ) from exc
                    if not chunk:
                        break
                    if not isinstance(chunk, bytes):
                        raise TypeError("Z-Library download stream must produce bytes")
                    size_bytes += len(chunk)
                    if size_bytes > self._limits.max_bytes:
                        raise DiandianError(
                            ErrorCode.SOURCE_LIMIT_EXCEEDED,
                            "Z-Library document exceeds the configured byte limit",
                            retryable=False,
                        )
                    output.write(chunk)
                    digest.update(chunk)
                output.flush()
                os.fsync(output.fileno())
            if size_bytes == 0:
                raise DiandianError(
                    ErrorCode.SOURCE_UNAVAILABLE,
                    "Z-Library download returned an empty document",
                    retryable=False,
                )
            if declared_length is not None and size_bytes != declared_length:
                raise DiandianError(
                    ErrorCode.SOURCE_UNAVAILABLE,
                    "Z-Library download length did not match its response metadata",
                    retryable=True,
                )
            display_filename = _display_filename(headers, ticket.suggested_filename)
            return DownloadedFile(
                path=temporary,
                display_filename=display_filename,
                mime_type=mime_type,
                size_bytes=size_bytes,
                sha256=digest.hexdigest(),
                source_locator_redacted=destination.target.redacted_url,
            )
        except BaseException:
            with suppress(OSError):
                os.close(descriptor)
            temporary.unlink(missing_ok=True)
            raise

    def _assert_total_timeout(self, started_at: float) -> None:
        if self._clock() - started_at > self._limits.total_timeout_seconds:
            raise DiandianError(
                ErrorCode.DOWNLOAD_TIMEOUT,
                "Z-Library download exceeded the total time limit",
                retryable=True,
            )


class StdlibPinnedHttpsTransport:
    def __init__(self, tls_context: ssl.SSLContext | None = None) -> None:
        self._tls_context = tls_context or ssl.create_default_context()

    def open(
        self,
        destination: PinnedDestination,
        headers: Mapping[str, str],
        *,
        connect_timeout_seconds: float,
        first_byte_timeout_seconds: float,
        idle_timeout_seconds: float,
    ) -> HttpResponseStream:
        last_error: OSError | None = None
        for address in destination.addresses:
            connection = _PinnedHTTPSConnection(
                destination.target.host,
                destination.target.port,
                pinned_address=address,
                timeout=connect_timeout_seconds,
                context=self._tls_context,
            )
            try:
                connection.request(
                    "GET",
                    destination.target.request_target,
                    headers=dict(headers),
                )
                if connection.sock is not None:
                    connection.sock.settimeout(first_byte_timeout_seconds)
                response = connection.getresponse()
                if connection.sock is not None:
                    connection.sock.settimeout(idle_timeout_seconds)
                return _StdlibResponse(response, connection)
            except OSError as exc:
                last_error = exc
                connection.close()
        if last_error is not None:
            raise last_error
        raise OSError("No validated Z-Library destination addresses")


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(
        self,
        host: str,
        port: int,
        *,
        pinned_address: str,
        timeout: float,
        context: ssl.SSLContext,
    ) -> None:
        super().__init__(host, port, timeout=timeout, context=context)
        self._pinned_address = pinned_address
        self._tls_context = context

    def connect(self) -> None:
        raw_socket = socket.create_connection(
            (self._pinned_address, self.port),
            self.timeout,
        )
        try:
            self.sock = self._tls_context.wrap_socket(raw_socket, server_hostname=self.host)
        except BaseException:
            raw_socket.close()
            raise


class _StdlibResponse:
    def __init__(
        self,
        response: http.client.HTTPResponse,
        connection: http.client.HTTPSConnection,
    ) -> None:
        self.status = response.status
        self.headers = tuple((name, value) for name, value in response.getheaders())
        self._response = response
        self._connection = connection

    def read(self, size: int) -> bytes:
        return self._response.read(size)

    def close(self) -> None:
        try:
            self._response.close()
        finally:
            self._connection.close()


def _validated_headers(
    headers: Sequence[tuple[str, str]],
    limits: ZLibraryDownloadLimits,
) -> dict[str, tuple[str, ...]]:
    if len(headers) > limits.max_headers:
        raise _validation("Z-Library response contained too many headers")
    size_bytes = 0
    normalized: dict[str, list[str]] = {}
    for raw_name, raw_value in headers:
        name = raw_name.strip().casefold()
        value = raw_value.strip()
        size_bytes += len(raw_name.encode("utf-8")) + len(raw_value.encode("utf-8")) + 4
        if not _HEADER_NAME.fullmatch(name) or any(
            character in raw_value for character in ("\r", "\n", "\x00")
        ):
            raise _validation("Z-Library response contained a malformed header")
        normalized.setdefault(name, []).append(value)
    if size_bytes > limits.max_header_bytes:
        raise _validation("Z-Library response headers exceeded the configured limit")
    return {name: tuple(values) for name, values in normalized.items()}


def _single_header(
    headers: Mapping[str, tuple[str, ...]],
    name: str,
    *,
    required: bool = False,
) -> str | None:
    values = headers.get(name, ())
    if not values:
        if required:
            raise _validation(f"Z-Library response omitted required {name} metadata")
        return None
    if len(values) != 1:
        raise _validation(f"Z-Library response contained ambiguous {name} metadata")
    return values[0]


def _content_length(headers: Mapping[str, tuple[str, ...]]) -> int | None:
    raw = _single_header(headers, "content-length")
    if raw is None:
        return None
    try:
        value = int(raw, 10)
    except ValueError as exc:
        raise _validation("Z-Library response Content-Length is invalid") from exc
    if value < 0 or str(value) != raw:
        raise _validation("Z-Library response Content-Length is invalid")
    return value


def _display_filename(
    headers: Mapping[str, tuple[str, ...]],
    suggested_filename: str,
) -> str:
    candidate = ""
    disposition = _single_header(headers, "content-disposition")
    if disposition:
        message = Message()
        message["content-disposition"] = disposition
        candidate = message.get_filename() or ""
    candidate = candidate or suggested_filename
    candidate = unicodedata.normalize("NFC", candidate.replace("\\", "/").rsplit("/", 1)[-1])
    candidate = "".join(
        character for character in candidate if ord(character) >= 0x20 and ord(character) != 0x7F
    ).strip(" .")
    if not candidate:
        raise DiandianError(
            ErrorCode.FORMAT_UNSUPPORTED,
            "Z-Library response did not provide a safe document filename",
            retryable=False,
        )
    return candidate[:240]


def _prepare_staging_directory(path: Path) -> Path:
    staging = Path(os.path.abspath(path))
    try:
        metadata = staging.lstat()
    except FileNotFoundError as exc:
        raise UnsafePathError("Z-Library staging directory does not exist") from exc
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise UnsafePathError("Z-Library staging must be a regular private directory")
    if os.name != "nt":
        if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
            raise UnsafePathError("Z-Library staging must be owned by the current user")
        if stat.S_IMODE(metadata.st_mode) & 0o077:
            raise UnsafePathError("Z-Library staging permissions must be private (0700)")
    return staging


def _validation(message: str) -> DiandianError:
    return DiandianError(ErrorCode.REMOTE_PROTOCOL_DRIFT, message, retryable=False)
