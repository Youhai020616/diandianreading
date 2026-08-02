"""Local object storage boundary."""

from __future__ import annotations

from dataclasses import dataclass
from typing import BinaryIO, Protocol

from diandianreading.domain import StorageKey


@dataclass(frozen=True, slots=True)
class StoredFile:
    key: StorageKey
    size_bytes: int
    sha256: str


class FileStore(Protocol):
    def put(self, key: StorageKey, content: BinaryIO) -> StoredFile: ...

    def open(self, key: StorageKey) -> BinaryIO: ...

    def delete(self, key: StorageKey) -> None: ...
