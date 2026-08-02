"""Deterministic document preparation adapter for Phase 0 and contract tests."""

from __future__ import annotations

import hashlib

from diandianreading.application.ports.documents import (
    DocumentPreparationPort,
    PreparedDocument,
)
from diandianreading.application.ports.progress import BestEffortProgressSink, ProgressSink
from diandianreading.domain import (
    DiandianError,
    DocumentAsset,
    DocumentPart,
    ErrorCode,
    PreparationManifest,
    ProgressEvent,
    StorageKey,
    TargetCapabilities,
)


class FakeDocumentPreparationAdapter(DocumentPreparationPort):
    """Deterministic Phase 0 preparation with no physical storage access."""

    supported_input_mime_types: frozenset[str] = frozenset({"text/markdown"})

    def __init__(self, parts: tuple[DocumentPart, ...]) -> None:
        self._parts: tuple[DocumentPart, ...] = parts

    async def prepare(
        self,
        asset: DocumentAsset,
        capabilities: TargetCapabilities,
        progress: ProgressSink,
    ) -> PreparedDocument:
        sink = BestEffortProgressSink(progress)
        if asset.mime_type not in self.supported_input_mime_types:
            raise DiandianError(
                ErrorCode.FORMAT_UNSUPPORTED,
                f"Unsupported fake document MIME type: {asset.mime_type}",
                retryable=False,
            )
        if not self._parts:
            raise ValueError("Fake preparation requires at least one DocumentPart")
        if len(self._parts) > capabilities.max_sources_per_workspace:
            raise DiandianError(
                ErrorCode.SOURCE_LIMIT_EXCEEDED,
                "Fake document exceeds source-count capability",
                retryable=False,
            )

        part_ids: set[str] = set()
        storage_keys: set[StorageKey] = set()
        checksums: set[str] = set()
        for sequence, part in enumerate(self._parts):
            if part.asset_id != asset.id:
                raise ValueError("Fake prepared Part belongs to another asset")
            if part.sequence != sequence:
                raise ValueError(
                    "Fake prepared Part sequences must be contiguous and start at zero"
                )
            if part.id in part_ids or part.storage_key in storage_keys or part.sha256 in checksums:
                raise ValueError("Fake prepared Parts must have unique identities and content")
            if part.mime_type not in capabilities.accepted_mime_types:
                raise DiandianError(
                    ErrorCode.FORMAT_UNSUPPORTED,
                    f"Unsupported prepared source MIME type: {part.mime_type}",
                    retryable=False,
                )
            if (
                part.word_count > capabilities.max_source_words
                or part.size_bytes > capabilities.max_source_bytes
            ):
                raise DiandianError(
                    ErrorCode.SOURCE_LIMIT_EXCEEDED,
                    "Fake prepared Part exceeds target capabilities",
                    retryable=False,
                )
            part_ids.add(part.id)
            storage_keys.add(part.storage_key)
            checksums.add(part.sha256)
        await sink.emit(
            ProgressEvent(
                job_id=sink.job_id,
                step="preparing",
                current=len(self._parts),
                total=len(self._parts),
                message="Prepared fake document parts",
            )
        )
        manifest_key = StorageKey(f"manifests/{asset.id}.json")
        manifest_sha256 = hashlib.sha256(
            f"fake-preparation-manifest:{asset.id}".encode()
        ).hexdigest()
        return PreparedDocument(
            derived_assets=(),
            parts=self._parts,
            manifest=PreparationManifest(
                root_asset_id=asset.id,
                storage_key=manifest_key,
                sha256=manifest_sha256,
            ),
        )
