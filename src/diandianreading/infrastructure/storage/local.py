"""Private, content-verifying local object storage."""

from __future__ import annotations

import hashlib
import os
import stat
import tempfile
from contextlib import suppress
from pathlib import Path
from typing import BinaryIO

from diandianreading.application.ports import FileStore, StoredFile
from diandianreading.domain import (
    DiandianError,
    ErrorCode,
    RepositoryConflict,
    StorageKey,
    UnsafePathError,
)

_CHUNK_SIZE = 1024 * 1024
_ALLOWED_NAMESPACES = frozenset({"originals", "derived", "parts", "manifests"})


class LocalFileStore(FileStore):
    """Resolve opaque keys below one private root and publish files atomically."""

    def __init__(self, root: Path, *, max_object_bytes: int = 100 * 1024 * 1024) -> None:
        if max_object_bytes <= 0:
            raise ValueError("LocalFileStore max_object_bytes must be positive")
        self._root = Path(os.path.abspath(root.expanduser()))
        self._max_object_bytes = max_object_bytes
        self._prepare_root()

    def put(self, key: StorageKey, content: BinaryIO) -> StoredFile:
        target = self._target(key, create_parents=True)
        descriptor, temporary_name = tempfile.mkstemp(
            dir=target.parent,
            prefix=".staging-",
            suffix=".tmp",
        )
        temporary = Path(temporary_name)
        digest = hashlib.sha256()
        size_bytes = 0
        try:
            if hasattr(os, "fchmod"):
                os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb") as output:
                while True:
                    chunk = content.read(_CHUNK_SIZE)
                    if not chunk:
                        break
                    if not isinstance(chunk, bytes):
                        raise TypeError("FileStore content must be opened in binary mode")
                    size_bytes += len(chunk)
                    if size_bytes > self._max_object_bytes:
                        raise DiandianError(
                            ErrorCode.SOURCE_LIMIT_EXCEEDED,
                            "Local object exceeds the configured byte limit",
                            retryable=False,
                        )
                    output.write(chunk)
                    digest.update(chunk)
                output.flush()
                os.fsync(output.fileno())

            staged = StoredFile(key=key, size_bytes=size_bytes, sha256=digest.hexdigest())
            if target.exists() or target.is_symlink():
                return self._deduplicate_existing(target, staged, temporary)
            try:
                os.link(temporary, target, follow_symlinks=False)
            except FileExistsError:
                return self._deduplicate_existing(target, staged, temporary)
            if os.name != "nt":
                target.chmod(0o600)
            temporary.unlink()
            self._fsync_directory(target.parent)
            self._validate_file(target)
            return staged
        except BaseException:
            with suppress(OSError):
                os.close(descriptor)
            temporary.unlink(missing_ok=True)
            raise

    def open(self, key: StorageKey) -> BinaryIO:
        target = self._target(key, create_parents=False)
        self._validate_file(target)
        flags = os.O_RDONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(target, flags)
        try:
            metadata = os.fstat(descriptor)
            try:
                after_open = target.lstat()
            except OSError as exc:
                raise UnsafePathError("Local object changed while it was being opened") from exc
            self._validate_metadata(target, after_open)
            if not os.path.samestat(metadata, after_open):
                raise UnsafePathError("Local object changed while it was being opened")
            self._validate_metadata(target, metadata)
            return os.fdopen(descriptor, "rb")
        except BaseException:
            os.close(descriptor)
            raise

    def delete(self, key: StorageKey) -> None:
        target = self._target(key, create_parents=False)
        if not target.exists() and not target.is_symlink():
            return
        self._validate_file(target)
        target.unlink()
        self._fsync_directory(target.parent)

    def stat(self, key: StorageKey) -> StoredFile:
        target = self._target(key, create_parents=False)
        self._validate_file(target)
        digest = hashlib.sha256()
        size_bytes = 0
        with self.open(key) as stored:
            for chunk in iter(lambda: stored.read(_CHUNK_SIZE), b""):
                size_bytes += len(chunk)
                digest.update(chunk)
        return StoredFile(key=key, size_bytes=size_bytes, sha256=digest.hexdigest())

    def _prepare_root(self) -> None:
        self._reject_symlink_components(self._root)
        if not self._root.exists():
            self._root.mkdir(parents=True, mode=0o700)
        self._validate_directory(self._root)

    def _target(self, key: StorageKey, *, create_parents: bool) -> Path:
        segments = key.value.split("/")
        if segments[0] not in _ALLOWED_NAMESPACES:
            raise UnsafePathError(f"Unknown local object namespace: {segments[0]}")
        parent = self._root
        for segment in segments[:-1]:
            candidate = parent / segment
            if create_parents and not candidate.exists() and not candidate.is_symlink():
                candidate.mkdir(mode=0o700)
            self._validate_directory(candidate)
            parent = candidate
        target = parent / segments[-1]
        if target.parent != parent or self._root not in target.parents:
            raise UnsafePathError("StorageKey escaped the local object root")
        return target

    def _deduplicate_existing(
        self,
        target: Path,
        staged: StoredFile,
        temporary: Path,
    ) -> StoredFile:
        self._validate_file(target)
        existing = self.stat(staged.key)
        if existing.size_bytes != staged.size_bytes or existing.sha256 != staged.sha256:
            raise RepositoryConflict(f"StorageKey content collision: {staged.key.value}")
        temporary.unlink(missing_ok=True)
        return existing

    def _validate_file(self, path: Path) -> None:
        try:
            metadata = path.lstat()
        except FileNotFoundError as exc:
            raise FileNotFoundError(f"Unknown local object: {path.name}") from exc
        self._validate_metadata(path, metadata)

    @staticmethod
    def _validate_metadata(path: Path, metadata: os.stat_result) -> None:
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise UnsafePathError(f"Local object must be a regular non-symlink file: {path.name}")
        if os.name != "nt":
            if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
                raise UnsafePathError(f"Local object is not owned by the current user: {path.name}")
            if stat.S_IMODE(metadata.st_mode) & 0o077:
                raise UnsafePathError(
                    f"Local object permissions must be private (0600): {path.name}"
                )

    @staticmethod
    def _validate_directory(path: Path) -> None:
        try:
            metadata = path.lstat()
        except FileNotFoundError as exc:
            raise UnsafePathError(f"Local object directory does not exist: {path.name}") from exc
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise UnsafePathError(f"Local object directory must not be a symlink: {path.name}")
        if os.name != "nt":
            if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
                raise UnsafePathError(
                    f"Local object directory is not owned by the current user: {path.name}"
                )
            if stat.S_IMODE(metadata.st_mode) & 0o077:
                raise UnsafePathError(
                    f"Local object directory permissions must be private (0700): {path.name}"
                )

    @staticmethod
    def _reject_symlink_components(path: Path) -> None:
        current = Path(path.anchor)
        for segment in path.parts[1:]:
            current /= segment
            if current.is_symlink():
                raise UnsafePathError(f"Local object path cannot contain symlinks: {segment}")

    @staticmethod
    def _fsync_directory(path: Path) -> None:
        if os.name == "nt":
            return
        flags = os.O_RDONLY
        if hasattr(os, "O_DIRECTORY"):
            flags |= os.O_DIRECTORY
        descriptor = os.open(path, flags)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
