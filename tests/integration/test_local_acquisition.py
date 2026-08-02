from __future__ import annotations

import asyncio
import os

import pytest

from diandianreading.application.ports import AcquisitionRequest
from diandianreading.domain import DiandianError, ErrorCode, UnsafePathError
from diandianreading.infrastructure.acquisition import LocalFileAcquirer
from diandianreading.infrastructure.storage import LocalFileStore
from tests.support import RaisingProgressSink, RecordingProgressSink


def request(path, *, rights_confirmed: bool = True) -> AcquisitionRequest:
    return AcquisitionRequest(
        provider="local",
        location=str(path),
        rights_confirmed=rights_confirmed,
        options={"rights_provenance_id": "rights-local-test", "author": "Test Author"},
    )


def test_local_acquirer_publishes_content_addressed_assets_and_deduplicates(tmp_path) -> None:
    source = tmp_path / "book.md"
    source.write_text("# Book\n\nDurable local content.\n", encoding="utf-8")
    store = LocalFileStore(tmp_path / "objects")
    acquirer = LocalFileAcquirer(store)
    progress = RecordingProgressSink(events=[])

    first = asyncio.run(acquirer.acquire(request(source), progress))
    repeated = asyncio.run(acquirer.acquire(request(source), progress))

    assert repeated.asset == first.asset
    assert first.asset.display_filename == "book.md"
    assert first.asset.mime_type == "text/markdown"
    assert first.asset.author == "Test Author"
    assert first.asset.origin_locator is None
    assert first.temporary_key is None
    assert store.stat(first.asset.storage_key).sha256 == first.asset.sha256
    assert [event.step for event in progress.events] == ["acquiring", "acquiring"]


def test_local_acquirer_progress_observer_failure_does_not_change_success(tmp_path) -> None:
    source = tmp_path / "book.md"
    source.write_text("# Book\n\nDurable local content.\n", encoding="utf-8")
    store = LocalFileStore(tmp_path / "objects")

    acquired = asyncio.run(LocalFileAcquirer(store).acquire(request(source), RaisingProgressSink()))

    assert store.stat(acquired.asset.storage_key).sha256 == acquired.asset.sha256


def test_local_acquirer_requires_rights_supported_provider_and_nonempty_file(tmp_path) -> None:
    source = tmp_path / "book.md"
    source.write_text("content", encoding="utf-8")
    acquirer = LocalFileAcquirer(LocalFileStore(tmp_path / "objects"))

    with pytest.raises(DiandianError) as rights:
        asyncio.run(
            acquirer.acquire(request(source, rights_confirmed=False), RecordingProgressSink([]))
        )
    assert rights.value.code is ErrorCode.VALIDATION

    missing_rights = AcquisitionRequest("local", str(source), True, {})
    with pytest.raises(DiandianError) as provenance:
        asyncio.run(acquirer.acquire(missing_rights, RecordingProgressSink([])))
    assert provenance.value.code is ErrorCode.VALIDATION

    with pytest.raises(ValueError, match="local provider"):
        asyncio.run(
            acquirer.acquire(
                AcquisitionRequest("other", str(source), True, {"rights_provenance_id": "r"}),
                RecordingProgressSink([]),
            )
        )

    source.write_bytes(b"")
    with pytest.raises(DiandianError) as empty:
        asyncio.run(acquirer.acquire(request(source), RecordingProgressSink([])))
    assert empty.value.code is ErrorCode.SOURCE_UNAVAILABLE


def test_local_acquirer_rejects_magic_mismatch_size_overflow_and_symlinks(tmp_path) -> None:
    store = LocalFileStore(tmp_path / "objects")
    source = tmp_path / "book.pdf"
    source.write_text("not a pdf", encoding="utf-8")
    with pytest.raises(DiandianError) as mismatch:
        asyncio.run(LocalFileAcquirer(store).acquire(request(source), RecordingProgressSink([])))
    assert mismatch.value.code is ErrorCode.FORMAT_UNSUPPORTED

    source.write_bytes(b"%PDF-1.4\n1234567890\n%%EOF")
    with pytest.raises(DiandianError) as oversized:
        asyncio.run(
            LocalFileAcquirer(store, max_input_bytes=8).acquire(
                request(source), RecordingProgressSink([])
            )
        )
    assert oversized.value.code is ErrorCode.SOURCE_LIMIT_EXCEEDED

    if hasattr(os, "symlink"):
        target = tmp_path / "target.md"
        target.write_text("content", encoding="utf-8")
        link = tmp_path / "link.md"
        link.symlink_to(target)
        with pytest.raises(UnsafePathError, match="non-symlink"):
            asyncio.run(LocalFileAcquirer(store).acquire(request(link), RecordingProgressSink([])))
