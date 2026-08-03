from __future__ import annotations

import hashlib
import os
import stat
import zipfile
from pathlib import Path

import pytest

from diandianreading.domain import DiandianError, ErrorCode, UnsafePathError
from diandianreading.infrastructure.acquisition.zlibrary import (
    DownloadedFile,
    ZLibraryArchiveLimits,
    validate_downloaded_document,
)

PDF_BYTES = b"%PDF-1.7\nsynthetic\n%%EOF\n"


def write_private(path: Path, content: bytes) -> None:
    path.write_bytes(content)
    if os.name != "nt":
        path.chmod(0o600)


def downloaded(path: Path, filename: str, mime_type: str) -> DownloadedFile:
    content = path.read_bytes()
    return DownloadedFile(
        path=path,
        display_filename=filename,
        mime_type=mime_type,
        size_bytes=len(content),
        sha256=hashlib.sha256(content).hexdigest(),
        source_locator_redacted="https://download.invalid/file",
    )


def write_epub(path: Path, entries: list[tuple[zipfile.ZipInfo | str, bytes]]) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        mimetype = zipfile.ZipInfo("mimetype")
        mimetype.compress_type = zipfile.ZIP_STORED
        archive.writestr(mimetype, b"application/epub+zip")
        for name, content in entries:
            archive.writestr(name, content)
    if os.name != "nt":
        path.chmod(0o600)


def test_valid_pdf_and_epub_pass_signature_hash_and_archive_preflight(tmp_path) -> None:
    pdf = tmp_path / "book.pdf"
    write_private(pdf, PDF_BYTES)
    epub = tmp_path / "book.epub"
    write_epub(epub, [("META-INF/container.xml", b"<container/>")])

    valid_pdf = validate_downloaded_document(
        downloaded(pdf, "safe-book.pdf", "application/pdf"),
        ZLibraryArchiveLimits(),
    )
    valid_epub = validate_downloaded_document(
        downloaded(epub, "safe-book.epub", "application/epub+zip"),
        ZLibraryArchiveLimits(),
    )

    assert valid_pdf.title == "safe book"
    assert valid_pdf.sha256 == hashlib.sha256(PDF_BYTES).hexdigest()
    assert valid_epub.mime_type == "application/epub+zip"
    assert set(tmp_path.iterdir()) == {pdf, epub}


@pytest.mark.parametrize(
    ("content", "filename", "mime_type"),
    [
        (PDF_BYTES, "book.exe", "application/pdf"),
        (PDF_BYTES, "book.epub", "application/pdf"),
        (b"not-pdf", "book.pdf", "application/pdf"),
        (b"%PDF-1.7 without terminator", "book.pdf", "application/pdf"),
    ],
)
def test_document_identity_requires_matching_extension_mime_and_magic(
    tmp_path,
    content: bytes,
    filename: str,
    mime_type: str,
) -> None:
    path = tmp_path / "download"
    write_private(path, content)

    with pytest.raises(DiandianError) as raised:
        validate_downloaded_document(
            downloaded(path, filename, mime_type),
            ZLibraryArchiveLimits(),
        )

    assert raised.value.code is ErrorCode.FORMAT_UNSUPPORTED


@pytest.mark.parametrize("entry_name", ["../escape", "/absolute", "C:/drive", "dir\\file"])
def test_epub_rejects_path_traversal_and_ambiguous_names(tmp_path, entry_name: str) -> None:
    path = tmp_path / "unsafe.epub"
    write_epub(path, [(entry_name, b"unsafe")])

    with pytest.raises(DiandianError, match="unsafe entry"):
        validate_downloaded_document(
            downloaded(path, "unsafe.epub", "application/epub+zip"),
            ZLibraryArchiveLimits(),
        )
    assert not (tmp_path / "escape").exists()


def test_epub_rejects_case_unicode_collisions_symlinks_and_compression_bombs(tmp_path) -> None:
    collision = tmp_path / "collision.epub"
    write_epub(collision, [("OPS/A.txt", b"a"), ("ops/a.TXT", b"b")])
    with pytest.raises(DiandianError, match="colliding"):
        validate_downloaded_document(
            downloaded(collision, "collision.epub", "application/epub+zip"),
            ZLibraryArchiveLimits(),
        )

    symlink = tmp_path / "symlink.epub"
    link_info = zipfile.ZipInfo("OPS/link")
    link_info.external_attr = (stat.S_IFLNK | 0o777) << 16
    write_epub(symlink, [(link_info, b"target")])
    with pytest.raises(DiandianError, match="non-regular"):
        validate_downloaded_document(
            downloaded(symlink, "symlink.epub", "application/epub+zip"),
            ZLibraryArchiveLimits(),
        )

    bomb = tmp_path / "bomb.epub"
    compressed = zipfile.ZipInfo("OPS/repeated.txt")
    compressed.compress_type = zipfile.ZIP_DEFLATED
    write_epub(bomb, [(compressed, b"x" * 10_000)])
    with pytest.raises(DiandianError, match="compression ratio"):
        validate_downloaded_document(
            downloaded(bomb, "bomb.epub", "application/epub+zip"),
            ZLibraryArchiveLimits(max_compression_ratio=2),
        )


def test_epub_limits_entry_count_size_depth_and_mimetype(tmp_path) -> None:
    path = tmp_path / "limited.epub"
    write_epub(path, [("a/b/c/content.txt", b"content")])

    for limits in (
        ZLibraryArchiveLimits(max_entries=1),
        ZLibraryArchiveLimits(max_entry_bytes=3),
        ZLibraryArchiveLimits(max_total_uncompressed_bytes=10),
        ZLibraryArchiveLimits(max_directory_depth=2),
        ZLibraryArchiveLimits(max_filename_length=5),
    ):
        with pytest.raises(DiandianError):
            validate_downloaded_document(
                downloaded(path, "limited.epub", "application/epub+zip"),
                limits,
            )

    missing = tmp_path / "missing-mimetype.epub"
    with zipfile.ZipFile(missing, "w") as archive:
        archive.writestr("content.txt", b"content")
    if os.name != "nt":
        missing.chmod(0o600)
    with pytest.raises(DiandianError, match="mimetype"):
        validate_downloaded_document(
            downloaded(missing, "missing.epub", "application/epub+zip"),
            ZLibraryArchiveLimits(),
        )


def test_validation_rejects_changed_or_symlinked_staging_file(tmp_path) -> None:
    path = tmp_path / "book.pdf"
    write_private(path, PDF_BYTES)
    metadata = downloaded(path, "book.pdf", "application/pdf")
    write_private(path, PDF_BYTES + b"changed")
    with pytest.raises(UnsafePathError, match="changed"):
        validate_downloaded_document(metadata, ZLibraryArchiveLimits())

    if hasattr(os, "symlink"):
        target = tmp_path / "target.pdf"
        write_private(target, PDF_BYTES)
        link = tmp_path / "link.pdf"
        link.symlink_to(target)
        linked_download = DownloadedFile(
            path=link,
            display_filename="book.pdf",
            mime_type="application/pdf",
            size_bytes=len(PDF_BYTES),
            sha256=hashlib.sha256(PDF_BYTES).hexdigest(),
            source_locator_redacted="https://download.invalid/file",
        )
        with pytest.raises(UnsafePathError, match="non-symlink"):
            validate_downloaded_document(linked_download, ZLibraryArchiveLimits())
