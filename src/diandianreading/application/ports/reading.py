"""Reader-facing document processing Port owned by the application layer."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True, slots=True)
class ChapterSpanView:
    """Chapter tile of the normalized reading document in codepoint offsets."""

    reference: str
    title: str
    start: int
    end: int


class ReadingDocumentProcessor(Protocol):
    """Deterministic normalization and chapter outline for markdown documents."""

    def normalize(self, raw: bytes) -> str: ...

    def chapter_spans(self, text: str) -> tuple[ChapterSpanView, ...]: ...
