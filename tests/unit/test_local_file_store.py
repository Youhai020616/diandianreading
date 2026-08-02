from __future__ import annotations

import io
import os
import stat

import pytest

from diandianreading.domain import (
    DiandianError,
    ErrorCode,
    RepositoryConflict,
    StorageKey,
    UnsafePathError,
)
from diandianreading.infrastructure.storage import LocalFileStore


def test_local_file_store_round_trips_deduplicates_and_deletes_private_objects(tmp_path) -> None:
    root = tmp_path / "objects"
    store = LocalFileStore(root)
    key = StorageKey("originals/content-hash")

    first = store.put(key, io.BytesIO(b"durable content"))
    repeated = store.put(key, io.BytesIO(b"durable content"))

    assert repeated == first
    assert store.stat(key) == first
    with store.open(key) as stored:
        assert stored.read() == b"durable content"
    if os.name != "nt":
        assert stat.S_IMODE(root.stat().st_mode) == 0o700
        assert stat.S_IMODE((root / key.value).stat().st_mode) == 0o600

    store.delete(key)
    store.delete(key)
    with pytest.raises(FileNotFoundError, match="Unknown local object"):
        store.open(key)


def test_local_file_store_never_overwrites_a_key_with_different_content(tmp_path) -> None:
    store = LocalFileStore(tmp_path / "objects")
    key = StorageKey("parts/asset/part.md")
    original = store.put(key, io.BytesIO(b"first"))

    with pytest.raises(RepositoryConflict, match="content collision"):
        store.put(key, io.BytesIO(b"second"))

    assert store.stat(key) == original
    with store.open(key) as stored:
        assert stored.read() == b"first"


def test_local_file_store_rejects_an_object_changed_during_open(tmp_path, monkeypatch) -> None:
    store = LocalFileStore(tmp_path / "objects")
    key = StorageKey("originals/content-hash")
    store.put(key, io.BytesIO(b"durable content"))
    monkeypatch.setattr(os.path, "samestat", lambda left, right: False)

    with pytest.raises(UnsafePathError, match="changed while it was being opened"):
        store.open(key)


def test_local_file_store_enforces_namespace_size_and_binary_content(tmp_path) -> None:
    store = LocalFileStore(tmp_path / "objects", max_object_bytes=4)

    with pytest.raises(UnsafePathError, match="namespace"):
        store.put(StorageKey("unknown/object"), io.BytesIO(b"data"))
    with pytest.raises(DiandianError) as oversized:
        store.put(StorageKey("originals/large"), io.BytesIO(b"12345"))
    assert oversized.value.code is ErrorCode.SOURCE_LIMIT_EXCEEDED
    with pytest.raises(TypeError, match="binary mode"):
        store.put(StorageKey("originals/text"), io.StringIO("text"))  # type: ignore[arg-type]
    assert not (tmp_path / "objects" / "originals" / "large").exists()


def test_local_file_store_rejects_symlink_roots_directories_and_objects(tmp_path) -> None:
    if not hasattr(os, "symlink"):
        pytest.skip("symlinks unavailable")

    outside = tmp_path / "outside"
    outside.mkdir(mode=0o700)
    root_link = tmp_path / "root-link"
    root_link.symlink_to(outside, target_is_directory=True)
    with pytest.raises(UnsafePathError, match="symlinks"):
        LocalFileStore(root_link)

    root = tmp_path / "objects"
    store = LocalFileStore(root)
    nested_link = root / "parts"
    nested_link.symlink_to(outside, target_is_directory=True)
    with pytest.raises(UnsafePathError, match="must not be a symlink"):
        store.put(StorageKey("parts/asset/part.md"), io.BytesIO(b"content"))
    nested_link.unlink()

    key = StorageKey("originals/link")
    target = outside / "target"
    target.write_bytes(b"secret")
    (root / "originals").mkdir(mode=0o700)
    (root / key.value).symlink_to(target)
    with pytest.raises(UnsafePathError, match="regular non-symlink"):
        store.open(key)
