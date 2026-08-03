from __future__ import annotations

import math
import socket

import pytest

from diandianreading.domain import DiandianError, ErrorCode
from diandianreading.infrastructure.acquisition.zlibrary import (
    BrowserCookie,
    SystemDnsResolver,
    ZLibraryAdapterConfig,
    ZLibraryArchiveLimits,
    ZLibraryDownloadLimits,
    ZLibraryDownloadTicket,
    ZLibraryNetworkPolicy,
    ZLibrarySelectorSet,
    cookie_header,
)


class StaticResolver:
    def __init__(self, answers: dict[str, tuple[str, ...]] | None = None) -> None:
        self.answers = {"zlibrary.invalid": ("8.8.8.8",)} if answers is None else answers
        self.calls: list[tuple[str, int]] = []

    def resolve(self, host: str, port: int):
        self.calls.append((host, port))
        answer = self.answers.get(host)
        if answer is None:
            raise OSError("synthetic DNS failure with secret=hidden")
        return answer


def make_policy(resolver: StaticResolver | None = None) -> ZLibraryNetworkPolicy:
    return ZLibraryNetworkPolicy(
        frozenset({"zlibrary.invalid", "download.invalid"}),
        resolver
        or StaticResolver(
            {
                "zlibrary.invalid": ("8.8.8.8",),
                "download.invalid": ("1.1.1.1",),
            }
        ),
    )


def test_book_url_is_canonicalized_and_sensitive_query_is_redacted() -> None:
    policy = make_policy()

    canonical = policy.canonicalize_book_url(
        "https://zlibrary.invalid/book/Book_123/title.html?token=secret#fragment"
    )
    destination = policy.validate_url(
        "https://download.invalid/files/book.pdf?signature=secret#discarded"
    )

    assert canonical == "https://zlibrary.invalid/book/Book_123/title.html"
    assert destination.url.endswith("?signature=secret")
    assert destination.redacted_url == "https://download.invalid/files/book.pdf"
    assert "secret" not in destination.redacted_url
    assert destination.request_target == "/files/book.pdf?signature=secret"


@pytest.mark.parametrize(
    "url",
    [
        "http://zlibrary.invalid/book/id/title.pdf",
        "https://evil.invalid/book/id/title.pdf",
        "https://user:secret@zlibrary.invalid/book/id/title.pdf",
        "https://ZLIBRARY.invalid/book/id/title.pdf",
        "https://zlibrary.invalid./book/id/title.pdf",
        "https://zlibrary.invalid:444/book/id/title.pdf",
        "https://127.0.0.1/book/id/title.pdf",
        "https://zlibrary.invalid/book/%2e%2e/secret",
        "https://zlibrary.invalid/book/id\\secret",
        " https://zlibrary.invalid/book/id/title.pdf",
        "https://zlibrary.invalid/book/id/title.pdf\n",
    ],
)
def test_url_policy_rejects_ambiguous_or_unapproved_destinations(url: str) -> None:
    with pytest.raises(DiandianError) as raised:
        make_policy().validate_url(url)
    assert raised.value.code is ErrorCode.VALIDATION
    assert "secret" not in raised.value.public_message


def test_book_canonicalization_rejects_non_book_and_extra_path_segments() -> None:
    policy = make_policy()
    for url in (
        "https://zlibrary.invalid/",
        "https://zlibrary.invalid/book/id/title/extra",
        "https://zlibrary.invalid/book/",
    ):
        with pytest.raises(DiandianError, match="canonical book"):
            policy.canonicalize_book_url(url)


def test_every_dns_answer_must_be_public_and_connection_is_pinned() -> None:
    resolver = StaticResolver({"zlibrary.invalid": ("8.8.8.8", "1.1.1.1")})
    policy = ZLibraryNetworkPolicy(frozenset({"zlibrary.invalid"}), resolver)

    destination = policy.authorize("https://zlibrary.invalid/book/id")

    assert destination.addresses == ("8.8.8.8", "1.1.1.1")
    assert resolver.calls == [("zlibrary.invalid", 443)]

    for answers in (
        ("8.8.8.8", "127.0.0.1"),
        ("10.0.0.1",),
        ("169.254.169.254",),
        ("::1",),
        ("not-an-address",),
    ):
        blocked = ZLibraryNetworkPolicy(
            frozenset({"zlibrary.invalid"}),
            StaticResolver({"zlibrary.invalid": answers}),
        )
        with pytest.raises(DiandianError) as raised:
            blocked.authorize("https://zlibrary.invalid/book/id")
        assert raised.value.code is ErrorCode.VALIDATION


def test_dns_failure_and_empty_answer_are_safe_source_errors() -> None:
    missing = ZLibraryNetworkPolicy(frozenset({"zlibrary.invalid"}), StaticResolver({}))
    empty = ZLibraryNetworkPolicy(
        frozenset({"zlibrary.invalid"}),
        StaticResolver({"zlibrary.invalid": ()}),
    )

    with pytest.raises(DiandianError) as failed:
        missing.authorize("https://zlibrary.invalid/book/id")
    with pytest.raises(DiandianError) as unresolved:
        empty.authorize("https://zlibrary.invalid/book/id")

    assert failed.value.code is ErrorCode.SOURCE_UNAVAILABLE
    assert unresolved.value.code is ErrorCode.SOURCE_UNAVAILABLE
    assert "secret" not in failed.value.public_message


def test_redirects_are_revalidated_and_browser_rules_pin_each_allowed_host() -> None:
    policy = make_policy()

    relative = policy.authorize_redirect(
        "https://zlibrary.invalid/book/id",
        "/download/book.pdf?token=secret",
    )
    cross_host = policy.authorize_redirect(
        "https://zlibrary.invalid/book/id",
        "https://download.invalid/book.pdf?token=secret",
    )

    assert relative.target.host == "zlibrary.invalid"
    assert cross_host.target.host == "download.invalid"
    assert policy.browser_host_resolver_rules() == (
        "MAP download.invalid 1.1.1.1",
        "MAP zlibrary.invalid 8.8.8.8",
    )
    with pytest.raises(DiandianError):
        policy.authorize_redirect(
            "https://zlibrary.invalid/book/id",
            "http://download.invalid/book.pdf",
        )
    with pytest.raises(DiandianError):
        policy.authorize_redirect("https://zlibrary.invalid/book/id", "\ninvalid")


def test_cookie_header_is_scoped_by_domain_path_and_hides_values_from_repr() -> None:
    policy = make_policy()
    destination = policy.validate_url("https://download.invalid/files/book.pdf")
    cookies = (
        BrowserCookie("session", "secret-value", ".download.invalid", "/files"),
        BrowserCookie("wrong-domain", "hidden", ".evil.invalid", "/"),
        BrowserCookie("wrong-path", "hidden", ".download.invalid", "/account"),
        BrowserCookie("bad", "line\nbreak", ".download.invalid", "/files"),
    )

    assert cookie_header(cookies, destination) == "session=secret-value"
    assert "secret-value" not in repr(cookies[0])
    assert cookie_header((), destination) is None


def test_adapter_configuration_is_disabled_by_default_and_limits_are_finite() -> None:
    config = ZLibraryAdapterConfig()
    assert config.enabled is False
    assert config.allowed_hosts == frozenset({"z-library.sk"})

    with pytest.raises(ValueError):
        ZLibraryDownloadLimits(max_bytes=0)
    with pytest.raises(ValueError):
        ZLibraryDownloadLimits(total_timeout_seconds=math.inf)
    with pytest.raises(ValueError):
        ZLibraryArchiveLimits(max_entries=0)
    with pytest.raises(ValueError):
        ZLibraryAdapterConfig(base_url="http://z-library.sk/")
    with pytest.raises(ValueError):
        ZLibraryAdapterConfig(allowed_hosts=frozenset({"Z-LIBRARY.SK"}))


def test_system_dns_resolver_keeps_only_stream_ip_answers(monkeypatch) -> None:
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda host, port, type: (
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port)),
            (socket.AF_INET, socket.SOCK_DGRAM, 17, "", ("9.9.9.9", port)),
            (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2001:4860:4860::8888", port, 0, 0)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port)),
        ),
    )

    assert SystemDnsResolver().resolve("zlibrary.invalid", 443) == (
        "8.8.8.8",
        "2001:4860:4860::8888",
    )


def test_policy_and_selector_configuration_reject_invalid_finite_values() -> None:
    with pytest.raises(ValueError, match="allowlist"):
        ZLibraryNetworkPolicy(frozenset())
    with pytest.raises(ValueError, match="redirect"):
        ZLibraryDownloadLimits(max_redirects=-1)
    with pytest.raises(ValueError, match="timeouts"):
        ZLibraryDownloadLimits(connect_timeout_seconds=0)
    with pytest.raises(ValueError, match="archive"):
        ZLibraryArchiveLimits(max_compression_ratio=math.inf)
    with pytest.raises(ValueError, match="allowed host"):
        ZLibraryAdapterConfig(allowed_hosts=frozenset())
    with pytest.raises(ValueError, match="invalid port"):
        ZLibraryAdapterConfig(base_url="https://z-library.sk:bad/")
    with pytest.raises(ValueError, match="canonical HTTPS"):
        ZLibraryAdapterConfig(base_url="https://user@z-library.sk/")
    with pytest.raises(ValueError, match="action timeout"):
        ZLibraryAdapterConfig(browser_action_timeout_seconds=0)
    with pytest.raises(ValueError, match="selector version"):
        ZLibrarySelectorSet("", ("auth",), ("download",))
    with pytest.raises(ValueError, match="cannot be empty"):
        ZLibrarySelectorSet("v1", (), ("download",))
    with pytest.raises(ValueError, match="cannot be empty"):
        ZLibrarySelectorSet("v1", (" ",), ("download",))
    with pytest.raises(ValueError, match="ticket URL"):
        ZLibraryDownloadTicket(selector_version="v1")


def test_url_origin_path_traversal_cookie_and_redirect_edge_branches() -> None:
    policy = make_policy()
    validated = policy.validate_url("https://zlibrary.invalid/")
    assert validated.origin == "https://zlibrary.invalid"
    with pytest.raises(DiandianError, match="unsafe"):
        policy.validate_url("https://zlibrary.invalid/../private")
    with pytest.raises(DiandianError, match="malformed"):
        policy.authorize_redirect("https://zlibrary.invalid/", "")

    destination = policy.validate_url("https://download.invalid/files")
    cookies = (
        BrowserCookie("plain", "value", "download.invalid", "not-absolute", secure=False),
        BrowserCookie("bad;name", "value", "download.invalid", "/"),
        BrowserCookie("bad-value", "semi;colon", "download.invalid", "/"),
    )
    assert cookie_header(cookies, destination) == "plain=value"
