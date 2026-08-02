#!/usr/bin/env python3
"""Standalone, resource-bounded EPUB spine parser used by the parent adapter."""

from __future__ import annotations

import argparse
import io
import json
import os
import posixpath
import re
import socket
import stat
import sys
import unicodedata
import zipfile
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree

_ALLOWED_COMPRESSION = frozenset({zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED})
_NESTED_ARCHIVE_SUFFIXES = frozenset({".zip", ".epub", ".jar", ".7z", ".rar", ".tar", ".gz"})
_DRIVE_PREFIX = re.compile(r"^[A-Za-z]:")
_SKIPPED_CONTENT_TAGS = frozenset({"script", "style", "svg", "iframe", "object"})
_SKIPPED_VOID_TAGS = frozenset({"embed"})
_COVERAGE_FILE_LIMIT_BYTES = 10 * 1024 * 1024


class ParserFailure(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class MarkdownHTMLParser(HTMLParser):
    def __init__(self, max_output_bytes: int) -> None:
        super().__init__(convert_charrefs=True)
        self._max_output_bytes = max_output_bytes
        self._parts: list[str] = []
        self._output_bytes = 0
        self._skip_stack: list[str] = []
        self._list_stack: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs
        name = tag.casefold()
        if name in _SKIPPED_VOID_TAGS:
            return
        if name in _SKIPPED_CONTENT_TAGS:
            self._skip_stack.append(name)
            return
        if self._skip_stack:
            return
        if name in {"p", "div", "section", "article", "blockquote"}:
            self._append("\n\n")
        elif name in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self._append(f"\n\n{'#' * int(name[1])} ")
        elif name == "br":
            self._append("\n")
        elif name in {"ul", "ol"}:
            self._list_stack.append(name)
            self._append("\n")
        elif name == "li":
            marker = "- " if not self._list_stack or self._list_stack[-1] == "ul" else "1. "
            self._append(f"\n{marker}")
        elif name in {"pre", "code"}:
            self._append("`")

    def handle_endtag(self, tag: str) -> None:
        name = tag.casefold()
        if self._skip_stack:
            if name == self._skip_stack[-1]:
                self._skip_stack.pop()
            return
        if name in _SKIPPED_CONTENT_TAGS or name in _SKIPPED_VOID_TAGS:
            return
        if name in {
            "p",
            "div",
            "section",
            "article",
            "blockquote",
            "li",
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
        }:
            self._append("\n\n")
        elif name in {"ul", "ol"}:
            if self._list_stack:
                self._list_stack.pop()
            self._append("\n")
        elif name in {"pre", "code"}:
            self._append("`")

    def handle_data(self, data: str) -> None:
        if not self._skip_stack:
            self._append(data)

    def markdown(self) -> str:
        value = "".join(self._parts)
        value = unicodedata.normalize("NFC", value).replace("\r\n", "\n").replace("\r", "\n")
        value = re.sub(r"[ \t]+", " ", value)
        value = re.sub(r" *\n *", "\n", value)
        value = re.sub(r"\n{3,}", "\n\n", value).strip()
        return f"{value}\n" if value else ""

    def _append(self, value: str) -> None:
        self._output_bytes += len(value.encode("utf-8"))
        if self._output_bytes > self._max_output_bytes:
            raise ParserFailure("SOURCE_LIMIT_EXCEEDED", "EPUB parser output exceeds its limit")
        self._parts.append(value)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--max-input", type=int, required=True)
    parser.add_argument("--max-entries", type=int, required=True)
    parser.add_argument("--max-entry", type=int, required=True)
    parser.add_argument("--max-total", type=int, required=True)
    parser.add_argument("--max-ratio", type=int, required=True)
    parser.add_argument("--max-depth", type=int, required=True)
    parser.add_argument("--max-name", type=int, required=True)
    parser.add_argument("--max-xml", type=int, required=True)
    parser.add_argument("--max-output", type=int, required=True)
    parser.add_argument("--cpu-seconds", type=int, required=True)
    parser.add_argument("--memory-bytes", type=int, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    _apply_resource_limits(args.cpu_seconds, args.memory_bytes)
    _disable_network()
    try:
        payload = sys.stdin.buffer.read(args.max_input + 1)
        if len(payload) > args.max_input:
            raise ParserFailure("SOURCE_LIMIT_EXCEEDED", "EPUB exceeds the parser input limit")
        result = parse_epub(payload, args)
        encoded = json.dumps(result, ensure_ascii=False, sort_keys=True).encode("utf-8")
        if len(encoded) > args.max_output:
            raise ParserFailure("SOURCE_LIMIT_EXCEEDED", "EPUB parser output exceeds its limit")
        sys.stdout.buffer.write(encoded)
        return 0
    except ParserFailure as exc:
        _write_error(exc.code, exc.message)
        return 2
    except (ElementTree.ParseError, UnicodeError, zipfile.BadZipFile, OSError, ValueError):
        _write_error("CONVERSION_FAILED", "EPUB parsing failed closed")
        return 2


def parse_epub(payload: bytes, args: argparse.Namespace) -> dict[str, object]:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        members = _validate_members(archive.infolist(), args)
        mimetype = _read_member(archive, members.get("mimetype"), 128)
        if mimetype != b"application/epub+zip":
            raise ParserFailure("FORMAT_UNSUPPORTED", "EPUB mimetype entry is invalid")

        container = _parse_xml(
            _read_named_member(archive, members, "META-INF/container.xml", args.max_xml),
            args.max_xml,
        )
        rootfile = next(
            (
                element.attrib.get("full-path", "")
                for element in container.iter()
                if _local_name(element.tag) == "rootfile"
            ),
            "",
        )
        rootfile = _resolve_member("", rootfile)
        package = _parse_xml(
            _read_named_member(archive, members, rootfile, args.max_xml), args.max_xml
        )
        metadata = _metadata(package)
        manifest = {
            element.attrib.get("id", ""): (
                element.attrib.get("href", ""),
                element.attrib.get("media-type", ""),
            )
            for element in package.iter()
            if _local_name(element.tag) == "item" and element.attrib.get("id")
        }
        spine_ids = [
            element.attrib.get("idref", "")
            for element in package.iter()
            if _local_name(element.tag) == "itemref"
        ]
        if not spine_ids:
            raise ParserFailure("CONVERSION_FAILED", "EPUB spine is empty")

        package_dir = posixpath.dirname(rootfile)
        chapters: list[dict[str, str]] = []
        output_budget = args.max_output
        for index, item_id in enumerate(spine_ids, start=1):
            item = manifest.get(item_id)
            if item is None or item[1] not in {"application/xhtml+xml", "text/html"}:
                raise ParserFailure(
                    "CONVERSION_FAILED", "EPUB spine references an invalid document"
                )
            member_name = _resolve_member(package_dir, item[0])
            html_bytes = _read_named_member(archive, members, member_name, args.max_xml)
            if b"<!doctype" in html_bytes.lower() or b"<!entity" in html_bytes.lower():
                raise ParserFailure(
                    "CONVERSION_FAILED", "EPUB markup contains a forbidden declaration"
                )
            parser = MarkdownHTMLParser(output_budget)
            parser.feed(html_bytes.decode("utf-8-sig"))
            parser.close()
            markdown = parser.markdown()
            if markdown:
                output_budget -= len(markdown.encode("utf-8"))
                if output_budget < 0:
                    raise ParserFailure(
                        "SOURCE_LIMIT_EXCEEDED",
                        "EPUB parser output exceeds its limit",
                    )
                chapters.append(
                    {
                        "reference": f"epub-spine-{index:04d}",
                        "markdown": markdown,
                    }
                )
        if not chapters:
            raise ParserFailure("CONVERSION_FAILED", "EPUB contains no readable spine content")
        return {
            "title": metadata.get("title"),
            "author": metadata.get("creator"),
            "chapters": chapters,
        }


def _validate_members(
    members: list[zipfile.ZipInfo],
    args: argparse.Namespace,
) -> dict[str, zipfile.ZipInfo]:
    if not members or len(members) > args.max_entries:
        raise ParserFailure("SOURCE_LIMIT_EXCEEDED", "EPUB archive entry count is invalid")
    normalized_names: set[str] = set()
    validated: dict[str, zipfile.ZipInfo] = {}
    total_size = 0
    for member in members:
        original = member.orig_filename
        name = member.filename
        if "\x00" in original or original != name or "\\" in original:
            raise ParserFailure("CONVERSION_FAILED", "EPUB archive member name is unsafe")
        path_name = name[:-1] if member.is_dir() else name
        parts = path_name.split("/")
        if (
            not path_name
            or name.startswith("/")
            or _DRIVE_PREFIX.match(name)
            or any(part in {"", ".", ".."} for part in parts)
            or len(parts) > args.max_depth
            or len(name) > args.max_name
        ):
            raise ParserFailure("CONVERSION_FAILED", "EPUB archive member path is unsafe")
        collision_key = unicodedata.normalize("NFC", path_name).casefold()
        if collision_key in normalized_names:
            raise ParserFailure("CONVERSION_FAILED", "EPUB archive member names collide")
        normalized_names.add(collision_key)
        mode = (member.external_attr >> 16) & 0xFFFF
        file_type = stat.S_IFMT(mode)
        if file_type and not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            raise ParserFailure("CONVERSION_FAILED", "EPUB archive contains a non-regular entry")
        if member.flag_bits & 0x1 or member.compress_type not in _ALLOWED_COMPRESSION:
            raise ParserFailure("FORMAT_UNSUPPORTED", "EPUB archive encoding is unsupported")
        if member.file_size > args.max_entry:
            raise ParserFailure("SOURCE_LIMIT_EXCEEDED", "EPUB archive entry exceeds its limit")
        total_size += member.file_size
        if total_size > args.max_total:
            raise ParserFailure("SOURCE_LIMIT_EXCEEDED", "EPUB archive exceeds its total limit")
        ratio = member.file_size / max(member.compress_size, 1)
        if ratio > args.max_ratio:
            raise ParserFailure("SOURCE_LIMIT_EXCEEDED", "EPUB archive compression ratio is unsafe")
        suffix = posixpath.splitext(name.casefold())[1]
        if not member.is_dir() and suffix in _NESTED_ARCHIVE_SUFFIXES:
            raise ParserFailure("FORMAT_UNSUPPORTED", "Nested archives are not allowed in EPUB")
        validated[name] = member
    return validated


def _read_named_member(
    archive: zipfile.ZipFile,
    members: dict[str, zipfile.ZipInfo],
    name: str,
    limit: int,
) -> bytes:
    member = members.get(name)
    if member is None:
        raise ParserFailure("CONVERSION_FAILED", "EPUB references a missing archive member")
    return _read_member(archive, member, limit)


def _read_member(
    archive: zipfile.ZipFile,
    member: zipfile.ZipInfo | None,
    limit: int,
) -> bytes:
    if member is None or member.is_dir():
        raise ParserFailure("CONVERSION_FAILED", "EPUB archive member is missing")
    if member.file_size > limit:
        raise ParserFailure("SOURCE_LIMIT_EXCEEDED", "EPUB metadata entry exceeds its limit")
    with archive.open(member, "r") as source:
        value = source.read(limit + 1)
    if len(value) > limit or len(value) != member.file_size:
        raise ParserFailure("SOURCE_LIMIT_EXCEEDED", "EPUB archive member exceeded its limit")
    return value


def _parse_xml(payload: bytes, limit: int) -> ElementTree.Element:
    if len(payload) > limit:
        raise ParserFailure("SOURCE_LIMIT_EXCEEDED", "EPUB XML exceeds its limit")
    lowered = payload.lower()
    if b"<!doctype" in lowered or b"<!entity" in lowered:
        raise ParserFailure("CONVERSION_FAILED", "EPUB XML contains a forbidden declaration")
    return ElementTree.fromstring(payload)


def _metadata(package: ElementTree.Element) -> dict[str, str]:
    values: dict[str, str] = {}
    for element in package.iter():
        name = _local_name(element.tag)
        if name in {"title", "creator"} and element.text and name not in values:
            value = " ".join(element.text.split())[:500]
            if value:
                values[name] = value
    return values


def _resolve_member(base: str, href: str) -> str:
    parsed = urlsplit(href)
    if parsed.scheme or parsed.netloc or parsed.query or not parsed.path:
        raise ParserFailure("CONVERSION_FAILED", "EPUB member reference is unsafe")
    decoded = unquote(parsed.path)
    if "\x00" in decoded or "\\" in decoded or decoded.startswith("/"):
        raise ParserFailure("CONVERSION_FAILED", "EPUB member reference is unsafe")
    resolved = posixpath.normpath(posixpath.join(base, decoded))
    if resolved == ".." or resolved.startswith("../") or _DRIVE_PREFIX.match(resolved):
        raise ParserFailure("CONVERSION_FAILED", "EPUB member reference escaped the package")
    return resolved


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].casefold()


def _apply_resource_limits(cpu_seconds: int, memory_bytes: int) -> None:
    try:
        import resource
    except ImportError:
        return
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))
    resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
    file_limit = _COVERAGE_FILE_LIMIT_BYTES if os.environ.get("COVERAGE_PROCESS_CONFIG") else 0
    resource.setrlimit(resource.RLIMIT_FSIZE, (file_limit, file_limit))
    if sys.platform.startswith("linux"):
        resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))


def _disable_network() -> None:
    def blocked(*args: object, **kwargs: object) -> None:
        del args, kwargs
        raise OSError("network disabled in document parser")

    socket.socket = blocked  # type: ignore[misc,assignment]
    socket.create_connection = blocked  # type: ignore[assignment]
    for name in tuple(os.environ):
        if name.casefold().endswith("_proxy"):
            os.environ.pop(name, None)


def _write_error(code: str, message: str) -> None:
    sys.stdout.write(json.dumps({"error": {"code": code, "message": message}}, sort_keys=True))


if __name__ == "__main__":
    raise SystemExit(main())
