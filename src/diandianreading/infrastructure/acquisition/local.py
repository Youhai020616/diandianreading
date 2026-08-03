"""Local-file acquisition into private object storage."""

from __future__ import annotations

import hashlib
import os
import re
import stat
import tempfile
from pathlib import Path
from typing import BinaryIO, cast
from uuid import NAMESPACE_URL, uuid5

from diandianreading.application.ports import (
    AcquiredAsset,
    AcquisitionRequest,
    BestEffortProgressSink,
    DocumentAcquirer,
    FileStore,
    ProgressSink,
)
from diandianreading.domain import (
    DiandianError,
    DocumentAsset,
    ErrorCode,
    ProgressEvent,
    SourceOrigin,
    StorageKey,
    UnsafePathError,
)

_CHUNK_SIZE = 1024 * 1024
_MIME_BY_SUFFIX = {
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".pdf": "application/pdf",
    ".epub": "application/epub+zip",
}


class LocalFileAcquirer(DocumentAcquirer):
    """Copy one explicitly selected local file into content-addressed storage."""

    def __init__(self, store: FileStore, *, max_input_bytes: int = 100 * 1024 * 1024) -> None:
        if max_input_bytes <= 0:
            raise ValueError("LocalFileAcquirer max_input_bytes must be positive")
        self._store = store
        self._max_input_bytes = max_input_bytes

    async def acquire(
        self,
        request: AcquisitionRequest,
        progress: ProgressSink,
    ) -> AcquiredAsset:
        sink = BestEffortProgressSink(progress)
        if request.provider != "local":
            raise ValueError("LocalFileAcquirer only accepts the local provider")
        if not request.rights_confirmed:
            raise DiandianError(
                ErrorCode.VALIDATION,
                "Local document import requires explicit rights confirmation",
                retryable=False,
            )
        rights_id = request.options.get("rights_provenance_id", "").strip()
        if not rights_id:
            raise DiandianError(
                ErrorCode.VALIDATION,
                "Local document import requires rights provenance",
                retryable=False,
            )

        source = Path(os.path.abspath(Path(request.location).expanduser()))
        suffix = source.suffix.casefold()
        display_filename = _requested_display_filename(
            request.options.get("display_filename"),
            fallback=source.name,
            expected_suffix=suffix,
        )
        mime_type = _MIME_BY_SUFFIX.get(suffix)
        if mime_type is None:
            raise DiandianError(
                ErrorCode.FORMAT_UNSUPPORTED,
                "Local document format is not supported",
                retryable=False,
            )

        descriptor = self._open_source(source)
        digest = hashlib.sha256()
        size_bytes = 0
        prefix = b""
        with (
            os.fdopen(descriptor, "rb") as input_file,
            tempfile.SpooledTemporaryFile(
                max_size=8 * 1024 * 1024,
                mode="w+b",
            ) as staged,
        ):
            while True:
                chunk = input_file.read(_CHUNK_SIZE)
                if not chunk:
                    break
                if not prefix:
                    prefix = chunk[:16]
                size_bytes += len(chunk)
                if size_bytes > self._max_input_bytes:
                    raise DiandianError(
                        ErrorCode.SOURCE_LIMIT_EXCEEDED,
                        "Local document exceeds the configured byte limit",
                        retryable=False,
                    )
                digest.update(chunk)
                _ = staged.write(chunk)
            if size_bytes == 0:
                raise DiandianError(
                    ErrorCode.SOURCE_UNAVAILABLE,
                    "Local document is empty",
                    retryable=False,
                )
            self._validate_magic(mime_type, prefix)
            sha256 = digest.hexdigest()
            key = StorageKey(f"originals/{sha256}")
            _ = staged.seek(0)
            stored = self._store.put(key, cast(BinaryIO, cast(object, staged)))

        if stored.sha256 != sha256 or stored.size_bytes != size_bytes:
            raise DiandianError(
                ErrorCode.UNEXPECTED,
                "Local object verification failed",
                retryable=False,
            )
        asset_id = str(uuid5(NAMESPACE_URL, f"document-asset:{sha256}"))
        asset = DocumentAsset(
            id=asset_id,
            storage_key=stored.key,
            display_filename=display_filename,
            mime_type=mime_type,
            size_bytes=stored.size_bytes,
            sha256=stored.sha256,
            title=_display_title(Path(display_filename).stem),
            author=request.options.get("author") or None,
            origin=SourceOrigin.LOCAL,
            origin_locator=None,
            rights_provenance_id=rights_id,
        )
        await sink.emit(
            ProgressEvent(
                job_id=sink.job_id,
                step="acquiring",
                current=1,
                total=1,
                message="Stored local document",
            )
        )
        return AcquiredAsset(asset=asset, temporary_key=None)

    @staticmethod
    def _open_source(path: Path) -> int:
        try:
            before_open = path.lstat()
        except OSError as exc:
            raise UnsafePathError("Local document must be an accessible non-symlink file") from exc
        if stat.S_ISLNK(before_open.st_mode) or not stat.S_ISREG(before_open.st_mode):
            raise UnsafePathError("Local document must be a regular non-symlink file")

        flags = os.O_RDONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(path, flags)
        except OSError as exc:
            raise UnsafePathError("Local document must be an accessible non-symlink file") from exc
        try:
            metadata = os.fstat(descriptor)
            try:
                after_open = path.lstat()
            except OSError as exc:
                raise UnsafePathError("Local document changed while it was being opened") from exc
            if (
                stat.S_ISLNK(after_open.st_mode)
                or not stat.S_ISREG(metadata.st_mode)
                or not os.path.samestat(metadata, after_open)
            ):
                raise UnsafePathError("Local document changed while it was being opened")
            if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
                raise UnsafePathError("Local document must be owned by the current user")
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise

    @staticmethod
    def _validate_magic(mime_type: str, prefix: bytes) -> None:
        if mime_type == "application/pdf" and not prefix.startswith(b"%PDF-"):
            raise DiandianError(
                ErrorCode.FORMAT_UNSUPPORTED,
                "Local PDF signature does not match its extension",
                retryable=False,
            )
        if mime_type == "application/epub+zip" and not prefix.startswith(b"PK\x03\x04"):
            raise DiandianError(
                ErrorCode.FORMAT_UNSUPPORTED,
                "Local EPUB signature does not match its extension",
                retryable=False,
            )
        if mime_type == "text/markdown" and (
            prefix.startswith((b"%PDF-", b"PK\x03\x04")) or b"\x00" in prefix
        ):
            raise DiandianError(
                ErrorCode.FORMAT_UNSUPPORTED,
                "Local Markdown signature does not match its extension",
                retryable=False,
            )


def _requested_display_filename(
    requested: str | None,
    *,
    fallback: str,
    expected_suffix: str,
) -> str:
    value = requested.strip() if requested is not None and requested.strip() else fallback
    if (
        not value
        or Path(value).name != value
        or "/" in value
        or "\\" in value
        or len(value.encode("utf-8")) > 255
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
        or Path(value).suffix.casefold() != expected_suffix
    ):
        raise DiandianError(
            ErrorCode.VALIDATION,
            "Local document display filename is invalid",
            retryable=False,
        )
    return value


def _display_title(stem: str) -> str:
    normalized = re.sub(r"\s+", " ", stem.replace("_", " ").replace("-", " ")).strip()
    return normalized[:200] or "Untitled document"
