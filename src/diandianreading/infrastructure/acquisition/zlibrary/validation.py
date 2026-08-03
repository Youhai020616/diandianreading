"""Downloaded PDF/EPUB identification and bounded archive preflight."""

from __future__ import annotations

import hashlib
import os
import re
import stat
import unicodedata
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import BinaryIO

from diandianreading.domain import DiandianError, ErrorCode, UnsafePathError
from diandianreading.infrastructure.acquisition.zlibrary.config import ZLibraryArchiveLimits
from diandianreading.infrastructure.acquisition.zlibrary.downloader import DownloadedFile

_CHUNK_SIZE = 1024 * 1024
_MIME_BY_SUFFIX = {
    ".pdf": "application/pdf",
    ".epub": "application/epub+zip",
}


@dataclass(frozen=True, slots=True)
class ValidatedDocument:
    display_filename: str
    title: str
    mime_type: str
    size_bytes: int
    sha256: str


def validate_downloaded_document(
    downloaded: DownloadedFile,
    archive_limits: ZLibraryArchiveLimits,
) -> ValidatedDocument:
    suffix = Path(downloaded.display_filename).suffix.casefold()
    expected_mime = _MIME_BY_SUFFIX.get(suffix)
    if expected_mime is None or expected_mime != downloaded.mime_type:
        raise DiandianError(
            ErrorCode.FORMAT_UNSUPPORTED,
            "Z-Library filename extension and declared MIME type do not match",
            retryable=False,
        )

    descriptor = _open_private_file(downloaded.path)
    try:
        with os.fdopen(descriptor, "rb", closefd=False) as document:
            size_bytes, sha256 = _verify_stream(document)
            if size_bytes != downloaded.size_bytes or sha256 != downloaded.sha256:
                raise UnsafePathError("Z-Library staging document changed after download")
            document.seek(0)
            if expected_mime == "application/pdf":
                _validate_pdf(document, size_bytes)
            else:
                _validate_epub(document, archive_limits)
    finally:
        os.close(descriptor)

    title = _display_title(Path(downloaded.display_filename).stem)
    return ValidatedDocument(
        display_filename=downloaded.display_filename,
        title=title,
        mime_type=expected_mime,
        size_bytes=size_bytes,
        sha256=sha256,
    )


def _open_private_file(path: Path) -> int:
    try:
        before = path.lstat()
    except FileNotFoundError as exc:
        raise UnsafePathError("Z-Library staging document is missing") from exc
    _validate_file_metadata(before)
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        current = path.lstat()
        _validate_file_metadata(opened)
        _validate_file_metadata(current)
        if not os.path.samestat(before, opened) or not os.path.samestat(opened, current):
            raise UnsafePathError("Z-Library staging document changed while opening")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _validate_file_metadata(metadata: os.stat_result) -> None:
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise UnsafePathError("Z-Library staging document must be a regular non-symlink file")
    if os.name != "nt":
        if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
            raise UnsafePathError("Z-Library staging document must be owned by the current user")
        if stat.S_IMODE(metadata.st_mode) & 0o077:
            raise UnsafePathError("Z-Library staging document permissions must be private (0600)")


def _verify_stream(document: BinaryIO) -> tuple[int, str]:
    digest = hashlib.sha256()
    size_bytes = 0
    while True:
        chunk = document.read(_CHUNK_SIZE)
        if not chunk:
            break
        size_bytes += len(chunk)
        digest.update(chunk)
    return size_bytes, digest.hexdigest()


def _validate_pdf(document: BinaryIO, size_bytes: int) -> None:
    prefix = document.read(8)
    if not prefix.startswith(b"%PDF-"):
        raise _format_error("Z-Library PDF signature is invalid")
    document.seek(max(0, size_bytes - 2048))
    if b"%%EOF" not in document.read(2048):
        raise _format_error("Z-Library PDF end marker is missing")


def _validate_epub(document: BinaryIO, limits: ZLibraryArchiveLimits) -> None:
    try:
        with zipfile.ZipFile(document) as archive:
            entries = archive.infolist()
            if not entries or len(entries) > limits.max_entries:
                raise _format_error("Z-Library EPUB entry count exceeds the configured limit")
            total_uncompressed = 0
            normalized_names: set[str] = set()
            mimetype_info: zipfile.ZipInfo | None = None
            for entry in entries:
                _validate_archive_entry(entry, limits)
                normalized = _normalized_entry_name(entry.filename)
                collision_key = normalized.casefold()
                if collision_key in normalized_names:
                    raise _format_error("Z-Library EPUB contains colliding entry names")
                normalized_names.add(collision_key)
                total_uncompressed += entry.file_size
                if total_uncompressed > limits.max_total_uncompressed_bytes:
                    raise _format_error(
                        "Z-Library EPUB uncompressed size exceeds the configured limit"
                    )
                if normalized == "mimetype":
                    mimetype_info = entry
            if mimetype_info is None or mimetype_info.is_dir():
                raise _format_error("Z-Library EPUB is missing its mimetype entry")
            if mimetype_info.compress_type != zipfile.ZIP_STORED or mimetype_info.file_size > 64:
                raise _format_error("Z-Library EPUB mimetype entry is invalid")
            with archive.open(mimetype_info) as mimetype_file:
                mimetype = mimetype_file.read(65)
            if mimetype != b"application/epub+zip":
                raise _format_error("Z-Library EPUB mimetype does not match its container")
    except (zipfile.BadZipFile, NotImplementedError, RuntimeError) as exc:
        raise _format_error("Z-Library EPUB container is invalid") from exc


def _validate_archive_entry(entry: zipfile.ZipInfo, limits: ZLibraryArchiveLimits) -> None:
    normalized = _normalized_entry_name(entry.filename)
    path = PurePosixPath(normalized)
    if (
        len(entry.filename) > limits.max_filename_length
        or len(path.parts) > limits.max_directory_depth
        or entry.file_size < 0
        or entry.file_size > limits.max_entry_bytes
        or entry.compress_size < 0
    ):
        raise _format_error("Z-Library EPUB entry exceeds configured limits")
    if entry.flag_bits & 0x1:
        raise _format_error("Z-Library EPUB cannot contain encrypted entries")
    if entry.file_size > 0:
        ratio = entry.file_size / max(entry.compress_size, 1)
        if ratio > limits.max_compression_ratio:
            raise _format_error("Z-Library EPUB compression ratio exceeds the configured limit")
    mode = entry.external_attr >> 16
    file_type = stat.S_IFMT(mode)
    if file_type not in (0, stat.S_IFREG, stat.S_IFDIR):
        raise _format_error("Z-Library EPUB contains a non-regular archive entry")
    if entry.is_dir() and file_type == stat.S_IFREG:
        raise _format_error("Z-Library EPUB archive entry type is inconsistent")


def _normalized_entry_name(name: str) -> str:
    if not name or "\x00" in name or "\\" in name:
        raise _format_error("Z-Library EPUB contains an unsafe entry name")
    normalized = unicodedata.normalize("NFC", name)
    path = PurePosixPath(normalized)
    if (
        path.is_absolute()
        or any(part in {"", ".", ".."} for part in path.parts)
        or (path.parts and ":" in path.parts[0])
    ):
        raise _format_error("Z-Library EPUB contains an unsafe entry path")
    return str(path)


def _display_title(stem: str) -> str:
    normalized = re.sub(r"\s+", " ", stem.replace("_", " ").replace("-", " ")).strip()
    return normalized[:200] or "Untitled document"


def _format_error(message: str) -> DiandianError:
    return DiandianError(ErrorCode.FORMAT_UNSUPPORTED, message, retryable=False)
