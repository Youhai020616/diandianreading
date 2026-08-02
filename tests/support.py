"""Shared deterministic test factories."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from diandianreading.application.ports import ProgressSink
from diandianreading.application.use_cases import ImportBookCommand
from diandianreading.domain import (
    CredentialRef,
    DocumentAsset,
    DocumentPart,
    ProgressEvent,
    SourceOrigin,
    StorageKey,
)

FIXED_NOW = datetime(2026, 8, 3, 12, 0, tzinfo=UTC)


@dataclass(slots=True)
class RecordingProgressSink(ProgressSink):
    events: list[ProgressEvent]

    @property
    def job_id(self) -> str:
        return "test-job"

    async def emit(self, event: ProgressEvent) -> None:
        self.events.append(event)


class RaisingProgressSink:
    @property
    def job_id(self) -> str:
        return "test-job"

    async def emit(self, event: ProgressEvent) -> None:
        del event
        raise RuntimeError("observer disconnected with secret=do-not-leak")


class SequentialIds:
    def __init__(self, *values: str) -> None:
        self._values = iter(values)
        self._fallback = 0

    def __call__(self) -> str:
        try:
            return next(self._values)
        except StopIteration:
            self._fallback += 1
            return f"generated-{self._fallback}"


def make_import_command(tmp_path: Path, *, part_count: int = 2) -> ImportBookCommand:
    original = tmp_path / "book.md"
    original.write_text("# Book\n\nA durable reading source.\n", encoding="utf-8")
    asset = DocumentAsset(
        id="asset-1",
        storage_key=StorageKey("originals/asset-1"),
        display_filename=original.name,
        mime_type="text/markdown",
        size_bytes=original.stat().st_size,
        sha256=_hash(original),
        title="Test Book",
        author="Test Author",
        origin=SourceOrigin.LOCAL,
        origin_locator=None,
        rights_provenance_id="rights-test-local",
    )
    parts: list[DocumentPart] = []
    for index in range(part_count):
        path = tmp_path / f"part-{index}.md"
        path.write_text(f"# Chapter {index + 1}\n\nPart {index + 1}.\n", encoding="utf-8")
        parts.append(
            DocumentPart(
                id=f"part-{index}",
                asset_id=asset.id,
                sequence=index,
                storage_key=StorageKey(f"parts/asset-1/{index:04d}"),
                mime_type="text/markdown",
                word_count=4,
                sha256=_hash(path),
                chapter_refs=(f"chapter-{index + 1}",),
                size_bytes=path.stat().st_size,
            )
        )
    return ImportBookCommand(
        title="Test Book",
        author="Test Author",
        asset=asset,
        parts=tuple(parts),
        credential=CredentialRef(provider="fake", profile="test"),
    )


def _hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()
