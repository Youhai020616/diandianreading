"""Document preparation boundary for parser-backed infrastructure."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from diandianreading.application.ports.progress import ProgressSink
from diandianreading.domain import (
    DocumentAsset,
    DocumentPart,
    PreparationManifest,
    StorageKey,
    TargetCapabilities,
)


@dataclass(frozen=True, slots=True)
class PreparedDocument:
    derived_assets: tuple[DocumentAsset, ...]
    parts: tuple[DocumentPart, ...]
    manifest: PreparationManifest

    @property
    def manifest_key(self) -> StorageKey:
        return self.manifest.storage_key


class DocumentPreparationPort(Protocol):
    async def prepare(
        self,
        asset: DocumentAsset,
        capabilities: TargetCapabilities,
        progress: ProgressSink,
    ) -> PreparedDocument: ...
