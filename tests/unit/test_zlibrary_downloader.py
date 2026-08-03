from __future__ import annotations

import hashlib
import os
import ssl
import stat
from pathlib import Path

import pytest

from diandianreading.domain import DiandianError, ErrorCode
from diandianreading.infrastructure.acquisition.zlibrary import (
    BoundedZLibraryDownloader,
    BrowserCookie,
    PinnedDestination,
    StdlibPinnedHttpsTransport,
    ValidatedUrl,
    ZLibraryDownloadLimits,
    ZLibraryDownloadTicket,
    ZLibraryNetworkPolicy,
)
from diandianreading.infrastructure.acquisition.zlibrary import downloader as downloader_module

PDF_BYTES = b"%PDF-1.7\nsynthetic\n%%EOF\n"


class StaticResolver:
    def resolve(self, host: str, port: int):
        del port
        return {
            "zlibrary.invalid": ("8.8.8.8",),
            "download.invalid": ("1.1.1.1",),
        }[host]


class FakeResponse:
    def __init__(
        self,
        status: int,
        headers: tuple[tuple[str, str], ...],
        content: bytes = b"",
        *,
        read_error: BaseException | None = None,
    ) -> None:
        self.status = status
        self.headers = headers
        self._content = content
        self._offset = 0
        self._read_error = read_error
        self.closed = False

    def read(self, size: int) -> bytes:
        if self._read_error is not None:
            raise self._read_error
        chunk = self._content[self._offset : self._offset + size]
        self._offset += len(chunk)
        return chunk

    def close(self) -> None:
        self.closed = True


class FakeTransport:
    def __init__(self, *responses: FakeResponse, open_error: BaseException | None = None) -> None:
        self.responses = list(responses)
        self.open_error = open_error
        self.calls = []

    def open(
        self,
        destination,
        headers,
        *,
        connect_timeout_seconds,
        first_byte_timeout_seconds,
        idle_timeout_seconds,
    ):
        self.calls.append(
            (
                destination,
                dict(headers),
                connect_timeout_seconds,
                first_byte_timeout_seconds,
                idle_timeout_seconds,
            )
        )
        if self.open_error is not None:
            raise self.open_error
        return self.responses.pop(0)


def make_staging(tmp_path: Path) -> Path:
    staging = tmp_path / "staging"
    staging.mkdir(mode=0o700)
    if os.name != "nt":
        staging.chmod(0o700)
    return staging


def make_ticket() -> ZLibraryDownloadTicket:
    return ZLibraryDownloadTicket(
        url="https://zlibrary.invalid/start?token=secret",
        suggested_filename="fallback.pdf",
        cookies=(
            BrowserCookie("book_session", "first-secret", ".zlibrary.invalid", "/"),
            BrowserCookie("download_session", "second-secret", ".download.invalid", "/files"),
        ),
        selector_version="zlibrary-dom-v1",
    )


def make_downloader(transport: FakeTransport, **limit_changes) -> BoundedZLibraryDownloader:
    limits = ZLibraryDownloadLimits(**limit_changes)
    return BoundedZLibraryDownloader(
        network_policy=ZLibraryNetworkPolicy(
            frozenset({"zlibrary.invalid", "download.invalid"}),
            StaticResolver(),
        ),
        limits=limits,
        transport=transport,
    )


def test_download_follows_manual_redirect_scopes_cookies_and_streams_privately(tmp_path) -> None:
    redirect = FakeResponse(
        302,
        (("Location", "https://download.invalid/files/book.pdf?signature=secret"),),
    )
    document = FakeResponse(
        200,
        (
            ("Content-Type", "application/pdf"),
            ("Content-Length", str(len(PDF_BYTES))),
            ("Content-Disposition", 'attachment; filename="safe.pdf"'),
        ),
        PDF_BYTES,
    )
    transport = FakeTransport(redirect, document)

    result = make_downloader(transport).download(make_ticket(), make_staging(tmp_path))

    assert result.path.read_bytes() == PDF_BYTES
    assert result.display_filename == "safe.pdf"
    assert result.mime_type == "application/pdf"
    assert result.sha256 == hashlib.sha256(PDF_BYTES).hexdigest()
    assert result.source_locator_redacted == "https://download.invalid/files/book.pdf"
    assert "private-staging" in repr(result)
    assert str(tmp_path) not in repr(result)
    assert transport.calls[0][0].addresses == ("8.8.8.8",)
    assert transport.calls[1][0].addresses == ("1.1.1.1",)
    assert transport.calls[0][1]["Cookie"] == "book_session=first-secret"
    assert transport.calls[1][1]["Cookie"] == "download_session=second-secret"
    assert redirect.closed and document.closed
    if os.name != "nt":
        assert stat.S_IMODE(result.path.stat().st_mode) == 0o600


@pytest.mark.parametrize(
    ("headers", "content", "code"),
    [
        ((("Content-Type", "text/html"),), b"<html>login</html>", ErrorCode.FORMAT_UNSUPPORTED),
        (
            (("Content-Type", "application/pdf"), ("Content-Encoding", "gzip")),
            PDF_BYTES,
            ErrorCode.REMOTE_PROTOCOL_DRIFT,
        ),
        (
            (("Content-Type", "application/pdf"), ("Content-Length", "999")),
            PDF_BYTES,
            ErrorCode.SOURCE_LIMIT_EXCEEDED,
        ),
        (
            (("Content-Type", "application/pdf"), ("Content-Length", "1")),
            PDF_BYTES,
            ErrorCode.SOURCE_UNAVAILABLE,
        ),
        ((("Content-Type", "application/pdf"),), b"", ErrorCode.SOURCE_UNAVAILABLE),
        (
            (("Content-Type", "application/pdf"), ("Content-Length", "01")),
            PDF_BYTES,
            ErrorCode.REMOTE_PROTOCOL_DRIFT,
        ),
        (
            (
                ("Content-Type", "application/pdf"),
                ("Content-Length", str(len(PDF_BYTES))),
                ("Content-Length", str(len(PDF_BYTES))),
            ),
            PDF_BYTES,
            ErrorCode.REMOTE_PROTOCOL_DRIFT,
        ),
    ],
)
def test_download_rejects_type_encoding_length_and_empty_body(
    tmp_path,
    headers,
    content: bytes,
    code: ErrorCode,
) -> None:
    response = FakeResponse(200, headers, content)
    downloader = make_downloader(FakeTransport(response), max_bytes=100)
    staging = make_staging(tmp_path)

    with pytest.raises(DiandianError) as raised:
        downloader.download(make_ticket(), staging)

    assert raised.value.code is code
    assert list(staging.iterdir()) == []
    assert response.closed


def test_actual_stream_limit_applies_without_content_length(tmp_path) -> None:
    response = FakeResponse(
        200,
        (("Content-Type", "application/pdf"),),
        PDF_BYTES,
    )
    staging = make_staging(tmp_path)

    with pytest.raises(DiandianError) as raised:
        make_downloader(FakeTransport(response), max_bytes=8).download(make_ticket(), staging)

    assert raised.value.code is ErrorCode.SOURCE_LIMIT_EXCEEDED
    assert list(staging.iterdir()) == []


def test_redirect_limit_and_malformed_redirect_fail_closed(tmp_path) -> None:
    first = FakeResponse(302, (("Location", "/again"),))
    second = FakeResponse(302, (("Location", "/third"),))
    staging = make_staging(tmp_path)

    with pytest.raises(DiandianError) as limited:
        make_downloader(FakeTransport(first, second), max_redirects=1).download(
            make_ticket(), staging
        )
    assert limited.value.code is ErrorCode.REMOTE_PROTOCOL_DRIFT

    missing = FakeResponse(302, ())
    with pytest.raises(DiandianError) as malformed:
        make_downloader(FakeTransport(missing)).download(make_ticket(), staging)
    assert malformed.value.code is ErrorCode.REMOTE_PROTOCOL_DRIFT


def test_connection_and_idle_timeout_are_typed_and_redacted(tmp_path) -> None:
    staging = make_staging(tmp_path)
    with pytest.raises(DiandianError) as connect_timeout:
        make_downloader(FakeTransport(open_error=TimeoutError("secret URL"))).download(
            make_ticket(), staging
        )
    stalled = FakeResponse(
        200,
        (("Content-Type", "application/pdf"),),
        read_error=TimeoutError("secret cookie"),
    )
    with pytest.raises(DiandianError) as idle_timeout:
        make_downloader(FakeTransport(stalled)).download(make_ticket(), staging)

    assert connect_timeout.value.code is ErrorCode.DOWNLOAD_TIMEOUT
    assert idle_timeout.value.code is ErrorCode.DOWNLOAD_TIMEOUT
    assert "secret" not in connect_timeout.value.public_message
    assert "secret" not in idle_timeout.value.public_message


def test_non_success_status_and_header_limits_fail_without_staging_file(tmp_path) -> None:
    staging = make_staging(tmp_path)
    unavailable = FakeResponse(503, ())
    with pytest.raises(DiandianError) as status:
        make_downloader(FakeTransport(unavailable)).download(make_ticket(), staging)
    assert status.value.code is ErrorCode.SOURCE_UNAVAILABLE
    assert status.value.retryable is True

    oversized = FakeResponse(
        200,
        (("Content-Type", "application/pdf"), ("X-Large", "x" * 100)),
        PDF_BYTES,
    )
    with pytest.raises(DiandianError) as headers:
        make_downloader(FakeTransport(oversized), max_header_bytes=32).download(
            make_ticket(), staging
        )
    assert headers.value.code is ErrorCode.REMOTE_PROTOCOL_DRIFT
    assert list(staging.iterdir()) == []


def test_downloader_rejects_unsafe_staging_directory(tmp_path) -> None:
    response = FakeResponse(200, (("Content-Type", "application/pdf"),), PDF_BYTES)
    missing = tmp_path / "missing"
    with pytest.raises(DiandianError):
        make_downloader(FakeTransport(response)).download(make_ticket(), missing)

    broad = make_staging(tmp_path)
    if os.name != "nt":
        broad.chmod(0o755)
        with pytest.raises(DiandianError, match="permissions"):
            make_downloader(FakeTransport(response)).download(make_ticket(), broad)


def test_total_timeout_is_enforced_before_transport_dispatch(tmp_path) -> None:
    moments = iter((0.0, 181.0))
    transport = FakeTransport(FakeResponse(200, (), PDF_BYTES))
    downloader = BoundedZLibraryDownloader(
        network_policy=ZLibraryNetworkPolicy(
            frozenset({"zlibrary.invalid"}),
            StaticResolver(),
        ),
        limits=ZLibraryDownloadLimits(total_timeout_seconds=180),
        transport=transport,
        clock=lambda: next(moments),
    )

    with pytest.raises(DiandianError) as raised:
        downloader.download(make_ticket(), make_staging(tmp_path))

    assert raised.value.code is ErrorCode.DOWNLOAD_TIMEOUT
    assert transport.calls == []


def test_response_header_count_malformed_values_and_filename_policy(tmp_path) -> None:
    staging = make_staging(tmp_path)
    too_many = FakeResponse(
        200,
        (("Content-Type", "application/pdf"), ("X-One", "1"), ("X-Two", "2")),
        PDF_BYTES,
    )
    with pytest.raises(DiandianError, match="too many"):
        make_downloader(FakeTransport(too_many), max_headers=2).download(make_ticket(), staging)

    malformed = FakeResponse(
        200,
        (("Content-Type", "application/pdf"), ("X-Bad", "line\nvalue")),
        PDF_BYTES,
    )
    with pytest.raises(DiandianError, match="malformed header"):
        make_downloader(FakeTransport(malformed)).download(make_ticket(), staging)

    safe_fallback = FakeResponse(
        200,
        (("Content-Type", "application/pdf"),),
        PDF_BYTES,
    )
    result = make_downloader(FakeTransport(safe_fallback)).download(
        ZLibraryDownloadTicket(
            url=make_ticket().url,
            suggested_filename="../folder\\fallback.pdf",
            selector_version="zlibrary-dom-v1",
        ),
        staging,
    )
    assert result.display_filename == "fallback.pdf"

    empty_name = FakeResponse(200, (("Content-Type", "application/pdf"),), PDF_BYTES)
    with pytest.raises(DiandianError, match="safe document filename"):
        make_downloader(FakeTransport(empty_name)).download(
            ZLibraryDownloadTicket(
                url=make_ticket().url,
                suggested_filename="...",
                selector_version="zlibrary-dom-v1",
            ),
            staging,
        )


def test_stdlib_transport_retries_only_prevalidated_addresses_and_closes_response(
    monkeypatch,
) -> None:
    target = ValidatedUrl(
        url="https://zlibrary.invalid/file.pdf",
        redacted_url="https://zlibrary.invalid/file.pdf",
        scheme="https",
        host="zlibrary.invalid",
        port=443,
        path="/file.pdf",
        query="",
    )
    destination = PinnedDestination(target, ("8.8.8.8", "1.1.1.1"))

    class FakeSocket:
        def __init__(self) -> None:
            self.timeouts = []

        def settimeout(self, timeout: float) -> None:
            self.timeouts.append(timeout)

    class RawResponse:
        status = 200

        def __init__(self) -> None:
            self.closed = False

        def getheaders(self):
            return [("Content-Type", "application/pdf")]

        def read(self, size: int) -> bytes:
            assert size == 4
            return b"data"

        def close(self) -> None:
            self.closed = True

    instances = []

    class FakeConnection:
        def __init__(self, host, port, *, pinned_address, timeout, context) -> None:
            del context
            self.host = host
            self.port = port
            self.pinned_address = pinned_address
            self.timeout = timeout
            self.sock = FakeSocket()
            self.response = RawResponse()
            self.closed = False
            instances.append(self)

        def request(self, method, target_value, headers) -> None:
            assert method == "GET"
            assert target_value == "/file.pdf"
            assert headers["Accept-Encoding"] == "identity"
            if self.pinned_address == "8.8.8.8":
                raise OSError("synthetic first address failure")

        def getresponse(self):
            return self.response

        def close(self) -> None:
            self.closed = True

    monkeypatch.setattr(downloader_module, "_PinnedHTTPSConnection", FakeConnection)
    stream = StdlibPinnedHttpsTransport(tls_context=object()).open(
        destination,
        {"Accept-Encoding": "identity"},
        connect_timeout_seconds=1,
        first_byte_timeout_seconds=2,
        idle_timeout_seconds=3,
    )

    assert stream.read(4) == b"data"
    assert instances[0].closed is True
    assert instances[1].sock.timeouts == [2, 3]
    stream.close()
    assert instances[1].closed is True
    assert instances[1].response.closed is True

    with pytest.raises(OSError, match="No validated"):
        StdlibPinnedHttpsTransport(tls_context=object()).open(
            PinnedDestination(target, ()),
            {},
            connect_timeout_seconds=1,
            first_byte_timeout_seconds=2,
            idle_timeout_seconds=3,
        )


def test_pinned_https_connection_uses_validated_ip_but_tls_hostname_and_closes_on_failure(
    monkeypatch,
) -> None:
    class RawSocket:
        def __init__(self) -> None:
            self.closed = False

        def close(self) -> None:
            self.closed = True

    class FakeTlsContext:
        def __init__(self, *, fail: bool = False) -> None:
            self.fail = fail
            self.calls = []
            self.verify_mode = ssl.CERT_REQUIRED
            self.check_hostname = True

        def wrap_socket(self, raw_socket, *, server_hostname):
            self.calls.append((raw_socket, server_hostname))
            if self.fail:
                raise OSError("synthetic TLS failure")
            return "wrapped-socket"

    created = []

    def create_connection(address, timeout):
        created.append((address, timeout))
        return RawSocket()

    monkeypatch.setattr(downloader_module.socket, "create_connection", create_connection)
    tls = FakeTlsContext()
    connection = downloader_module._PinnedHTTPSConnection(
        "zlibrary.invalid",
        443,
        pinned_address="8.8.8.8",
        timeout=5,
        context=tls,
    )
    connection.connect()
    assert created == [(("8.8.8.8", 443), 5)]
    assert tls.calls[0][1] == "zlibrary.invalid"
    assert connection.sock == "wrapped-socket"

    failing_tls = FakeTlsContext(fail=True)
    failing = downloader_module._PinnedHTTPSConnection(
        "zlibrary.invalid",
        443,
        pinned_address="1.1.1.1",
        timeout=5,
        context=failing_tls,
    )
    with pytest.raises(OSError, match="TLS failure"):
        failing.connect()
    assert failing_tls.calls[0][0].closed is True
