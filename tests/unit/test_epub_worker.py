from __future__ import annotations

import io
import sys
import zipfile
from argparse import Namespace
from types import SimpleNamespace
from xml.etree import ElementTree

import pytest

from diandianreading.infrastructure.documents import epub_worker


def _archive_limits(**overrides: int) -> Namespace:
    values = {
        "max_entries": 10,
        "max_entry": 100,
        "max_total": 200,
        "max_ratio": 100,
        "max_depth": 8,
        "max_name": 100,
    }
    values.update(overrides)
    return Namespace(**values)


def _member(name: str, *, size: int = 1, compressed: int = 1) -> zipfile.ZipInfo:
    member = zipfile.ZipInfo(name)
    member.file_size = size
    member.compress_size = compressed
    member.compress_type = zipfile.ZIP_STORED
    return member


def test_markdown_html_parser_formats_text_and_fails_closed_for_nested_active_content() -> None:
    parser = epub_worker.MarkdownHTMLParser(max_output_bytes=2_000)
    parser.feed(
        "<h2>Title</h2><div>A<br>B</div>"
        "<ul><li>unordered</li></ul><ol><li>ordered</li></ol><li>orphan</li>"
        "<pre>pre</pre><code>code</code><embed src='ignored'/>"
        "<svg><p>hidden</p></svg><p>visible</p></script></ul>"
    )
    parser.close()

    markdown = parser.markdown()
    assert "## Title" in markdown
    assert "- unordered" in markdown
    assert "1. ordered" in markdown
    assert "- orphan" in markdown
    assert "`pre`" in markdown
    assert "`code`" in markdown
    assert "hidden" not in markdown
    assert "visible" in markdown

    mismatched = epub_worker.MarkdownHTMLParser(max_output_bytes=100)
    mismatched.feed("<svg><object></svg></object>must-not-leak")
    assert mismatched.markdown() == ""


def test_markdown_html_parser_enforces_output_budget() -> None:
    parser = epub_worker.MarkdownHTMLParser(max_output_bytes=1)

    with pytest.raises(epub_worker.ParserFailure) as raised:
        parser.feed("too large")

    assert raised.value.code == "SOURCE_LIMIT_EXCEEDED"


def test_archive_member_validation_rejects_unsafe_names_encodings_and_sizes() -> None:
    with pytest.raises(epub_worker.ParserFailure, match="entry count"):
        epub_worker._validate_members([], _archive_limits())

    with pytest.raises(epub_worker.ParserFailure, match="name is unsafe"):
        epub_worker._validate_members([_member("bad\\name")], _archive_limits())

    with pytest.raises(epub_worker.ParserFailure, match="path is unsafe"):
        epub_worker._validate_members([_member("/absolute")], _archive_limits())

    unsupported = _member("unsupported.txt")
    unsupported.compress_type = zipfile.ZIP_BZIP2
    with pytest.raises(epub_worker.ParserFailure, match="encoding is unsupported"):
        epub_worker._validate_members([unsupported], _archive_limits())

    with pytest.raises(epub_worker.ParserFailure, match="entry exceeds"):
        epub_worker._validate_members(
            [_member("large.txt", size=11)], _archive_limits(max_entry=10)
        )

    members = [_member("one.txt", size=6), _member("two.txt", size=6)]
    with pytest.raises(epub_worker.ParserFailure, match="total limit"):
        epub_worker._validate_members(members, _archive_limits(max_total=10))


def test_member_xml_metadata_and_reference_helpers_fail_closed() -> None:
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w") as output:
        output.writestr("entry.txt", b"abc")
        output.writestr("directory/", b"")
    with zipfile.ZipFile(io.BytesIO(payload.getvalue())) as archive:
        members = {member.filename: member for member in archive.infolist()}
        assert epub_worker._read_named_member(archive, members, "entry.txt", 3) == b"abc"
        with pytest.raises(epub_worker.ParserFailure, match="archive member is missing"):
            epub_worker._read_member(archive, None, 10)
        with pytest.raises(epub_worker.ParserFailure, match="archive member is missing"):
            epub_worker._read_member(archive, members["directory/"], 10)
        with pytest.raises(epub_worker.ParserFailure, match="metadata entry"):
            epub_worker._read_member(archive, members["entry.txt"], 2)
        with pytest.raises(epub_worker.ParserFailure, match="missing archive member"):
            epub_worker._read_named_member(archive, members, "missing.txt", 10)

    with pytest.raises(epub_worker.ParserFailure, match="XML exceeds"):
        epub_worker._parse_xml(b"<root/>", 2)
    with pytest.raises(epub_worker.ParserFailure, match="forbidden declaration"):
        epub_worker._parse_xml(b"<!DOCTYPE root><root/>", 100)

    package = ElementTree.fromstring(
        "<package><title>  Test   Title  </title><title>Ignored</title>"
        "<creator>   </creator><creator>Test Author</creator></package>"
    )
    assert epub_worker._metadata(package) == {
        "title": "Test Title",
        "creator": "Test Author",
    }
    assert epub_worker._local_name("{namespace}TiTlE") == "title"

    assert epub_worker._resolve_member("OEBPS", "chapter.xhtml#section") == "OEBPS/chapter.xhtml"
    for unsafe in (
        "https://example.invalid/chapter.xhtml",
        "chapter.xhtml?query=forbidden",
        "/absolute.xhtml",
        "..%2F..%2Fescape.xhtml",
        "bad\\name.xhtml",
        "nul%00name.xhtml",
    ):
        with pytest.raises(epub_worker.ParserFailure):
            epub_worker._resolve_member("OEBPS", unsafe)
    with pytest.raises(epub_worker.ParserFailure):
        epub_worker._resolve_member("", "C%3Adrive.xhtml")


def test_resource_limits_remain_finite_with_and_without_coverage(monkeypatch) -> None:
    calls: list[tuple[int, tuple[int, int]]] = []
    fake_resource = SimpleNamespace(
        RLIMIT_CPU=1,
        RLIMIT_NOFILE=2,
        RLIMIT_FSIZE=3,
        RLIMIT_AS=4,
        setrlimit=lambda resource, limits: calls.append((resource, limits)),
    )
    monkeypatch.setitem(sys.modules, "resource", fake_resource)
    monkeypatch.setattr(epub_worker.sys, "platform", "linux")
    monkeypatch.setenv("COVERAGE_PROCESS_CONFIG", "instrumented")

    epub_worker._apply_resource_limits(cpu_seconds=7, memory_bytes=123)

    assert calls == [
        (1, (7, 7)),
        (2, (32, 32)),
        (3, (epub_worker._COVERAGE_FILE_LIMIT_BYTES, epub_worker._COVERAGE_FILE_LIMIT_BYTES)),
        (4, (123, 123)),
    ]

    calls.clear()
    monkeypatch.delenv("COVERAGE_PROCESS_CONFIG")
    epub_worker._apply_resource_limits(cpu_seconds=5, memory_bytes=456)
    assert (3, (0, 0)) in calls


def test_network_disable_blocks_sockets_and_removes_proxy_environment(monkeypatch) -> None:
    monkeypatch.setattr(epub_worker.socket, "socket", epub_worker.socket.socket)
    monkeypatch.setattr(
        epub_worker.socket,
        "create_connection",
        epub_worker.socket.create_connection,
    )
    monkeypatch.setattr(
        epub_worker.os,
        "environ",
        {"HTTPS_PROXY": "http://proxy.invalid", "SAFE_VALUE": "kept"},
    )

    epub_worker._disable_network()

    assert epub_worker.os.environ == {"SAFE_VALUE": "kept"}
    with pytest.raises(OSError, match="network disabled"):
        epub_worker.socket.socket()
    with pytest.raises(OSError, match="network disabled"):
        epub_worker.socket.create_connection(("example.invalid", 443))
