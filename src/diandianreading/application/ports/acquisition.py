"""Document acquisition boundary."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol

from diandianreading.application.ports.progress import ProgressSink
from diandianreading.domain import CredentialRef, DocumentAsset, StorageKey


@dataclass(frozen=True, slots=True)
class AcquisitionRequest:
    provider: str
    location: str
    rights_confirmed: bool
    options: Mapping[str, str]
    credential: CredentialRef | None = None


@dataclass(frozen=True, slots=True)
class AcquiredAsset:
    asset: DocumentAsset
    temporary_key: StorageKey | None


class DocumentAcquirer(Protocol):
    async def acquire(
        self,
        request: AcquisitionRequest,
        progress: ProgressSink,
    ) -> AcquiredAsset: ...


class ZLibraryAcquisitionPort(DocumentAcquirer, Protocol):
    provider: str

    def canonicalize_location(self, location: str) -> str: ...

    def redact_location(self, location: str) -> str: ...
