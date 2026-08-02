"""Document preparation boundary for parser-backed infrastructure."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from diandianreading.application.ports.progress import ProgressSink
from diandianreading.domain import DocumentAsset, DocumentPart, StorageKey, TargetCapabilities


@dataclass(frozen=True, slots=True)
class PreparedDocument:
    derived_assets: tuple[DocumentAsset, ...]
    parts: tuple[DocumentPart, ...]
    manifest_key: StorageKey


class DocumentPreparationPort(Protocol):
    async def prepare(
        self,
        asset: DocumentAsset,
        capabilities: TargetCapabilities,
        progress: ProgressSink,
    ) -> PreparedDocument: ...
