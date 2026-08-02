"""Real local document preparation backed by private object storage."""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import subprocess
import sys
from dataclasses import asdict
from pathlib import Path
from typing import TypedDict, cast
from uuid import NAMESPACE_URL, uuid5

from diandianreading.application.ports import (
    BestEffortProgressSink,
    DocumentPreparationPort,
    FileStore,
    PreparedDocument,
    ProgressSink,
)
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
from diandianreading.infrastructure.documents.policy import (
    DocumentSecurityLimits,
    PreparedChunk,
    TextChapter,
    chunk_chapters,
    markdown_chapters,
    normalize_markdown,
)

_CHUNK_SIZE = 1024 * 1024
_MARKDOWN_MIME = "text/markdown"
_PDF_MIME = "application/pdf"
_EPUB_MIME = "application/epub+zip"


class _ParsedEpub(TypedDict):
    title: object
    author: object
    chapters: tuple[TextChapter, ...]


class LocalDocumentPreparationAdapter(DocumentPreparationPort):
    """Prepare Markdown, EPUB, and PDF assets without exposing physical paths."""

    def __init__(
        self,
        store: FileStore,
        *,
        limits: DocumentSecurityLimits | None = None,
    ) -> None:
        self._store = store
        self._limits = limits or DocumentSecurityLimits()

    async def prepare(
        self,
        asset: DocumentAsset,
        capabilities: TargetCapabilities,
        progress: ProgressSink,
    ) -> PreparedDocument:
        sink = BestEffortProgressSink(progress)
        await sink.emit(
            ProgressEvent(
                job_id=sink.job_id,
                step="preparing",
                current=0,
                total=None,
                message="Preparing local document",
            )
        )
        prepared = await asyncio.to_thread(self._prepare_sync, asset, capabilities)
        await sink.emit(
            ProgressEvent(
                job_id=sink.job_id,
                step="preparing",
                current=len(prepared.parts),
                total=len(prepared.parts),
                message="Prepared local document parts",
            )
        )
        return prepared

    def _prepare_sync(
        self,
        asset: DocumentAsset,
        capabilities: TargetCapabilities,
    ) -> PreparedDocument:
        payload = self._read_verified_asset(asset)
        if asset.mime_type == _MARKDOWN_MIME:
            self._require_target_mime(_MARKDOWN_MIME, capabilities)
            text = _decode_markdown(payload)
            parts = self._store_chunks(
                asset,
                chunk_chapters(markdown_chapters(text), capabilities),
            )
            derived_assets: tuple[DocumentAsset, ...] = ()
        elif asset.mime_type == _EPUB_MIME:
            self._require_target_mime(_MARKDOWN_MIME, capabilities)
            parsed = self._parse_epub(payload)
            chapters = parsed["chapters"]
            markdown = normalize_markdown(
                "\n\n---\n\n".join(chapter.markdown for chapter in chapters)
            )
            derived = self._store_derived_markdown(asset, markdown, parsed)
            parts = self._store_chunks(
                derived,
                chunk_chapters(chapters, capabilities),
            )
            derived_assets = (derived,)
        elif asset.mime_type == _PDF_MIME:
            self._require_target_mime(_PDF_MIME, capabilities)
            _validate_pdf(payload)
            if len(payload) > capabilities.max_source_bytes:
                raise DiandianError(
                    ErrorCode.SOURCE_LIMIT_EXCEEDED,
                    "PDF exceeds the target source byte limit",
                    retryable=False,
                )
            part = DocumentPart(
                id=str(uuid5(NAMESPACE_URL, f"pdf-part:{asset.id}:{asset.sha256}")),
                asset_id=asset.id,
                sequence=0,
                storage_key=asset.storage_key,
                mime_type=_PDF_MIME,
                word_count=0,
                sha256=asset.sha256,
                chapter_refs=("pdf-document",),
                size_bytes=asset.size_bytes,
            )
            parts = (part,)
            derived_assets = ()
        else:
            raise DiandianError(
                ErrorCode.FORMAT_UNSUPPORTED,
                "Document format is not supported for preparation",
                retryable=False,
            )

        manifest = self._store_manifest(asset, derived_assets, parts, capabilities)
        return PreparedDocument(
            derived_assets=derived_assets,
            parts=parts,
            manifest=manifest,
        )

    def _read_verified_asset(self, asset: DocumentAsset) -> bytes:
        if asset.size_bytes > self._limits.max_input_bytes:
            raise DiandianError(
                ErrorCode.SOURCE_LIMIT_EXCEEDED,
                "Document exceeds the parser input limit",
                retryable=False,
            )
        digest = hashlib.sha256()
        payload = bytearray()
        with self._store.open(asset.storage_key) as source:
            while True:
                chunk = source.read(_CHUNK_SIZE)
                if not chunk:
                    break
                payload.extend(chunk)
                digest.update(chunk)
                if len(payload) > self._limits.max_input_bytes:
                    raise DiandianError(
                        ErrorCode.SOURCE_LIMIT_EXCEEDED,
                        "Document exceeds the parser input limit",
                        retryable=False,
                    )
        if len(payload) != asset.size_bytes or digest.hexdigest() != asset.sha256:
            raise DiandianError(
                ErrorCode.SOURCE_UNAVAILABLE,
                "Stored document no longer matches its recorded checksum",
                retryable=False,
            )
        return bytes(payload)

    def _store_derived_markdown(
        self,
        root: DocumentAsset,
        markdown: str,
        parsed: _ParsedEpub,
    ) -> DocumentAsset:
        content = markdown.encode("utf-8")
        sha256 = hashlib.sha256(content).hexdigest()
        asset_id = str(uuid5(NAMESPACE_URL, f"derived-markdown:{root.id}:{sha256}"))
        key = StorageKey(f"derived/{root.id}/{sha256}.md")
        stored = self._store.put(key, _bytes_reader(content))
        return DocumentAsset(
            id=asset_id,
            storage_key=stored.key,
            display_filename=f"{Path(root.display_filename).stem}.md",
            mime_type=_MARKDOWN_MIME,
            size_bytes=stored.size_bytes,
            sha256=stored.sha256,
            title=_metadata_value(parsed.get("title")) or root.title,
            author=_metadata_value(parsed.get("author")) or root.author,
            origin=root.origin,
            origin_locator=root.origin_locator,
            rights_provenance_id=root.rights_provenance_id,
            derived_from_asset_id=root.id,
        )

    def _store_chunks(
        self,
        part_asset: DocumentAsset,
        chunks: tuple[PreparedChunk, ...],
    ) -> tuple[DocumentPart, ...]:
        parts: list[DocumentPart] = []
        for sequence, chunk in enumerate(chunks):
            content = chunk.content.encode("utf-8")
            sha256 = hashlib.sha256(content).hexdigest()
            key = StorageKey(f"parts/{part_asset.id}/{sequence:04d}-{sha256}.md")
            stored = self._store.put(key, _bytes_reader(content))
            if stored.size_bytes != chunk.size_bytes or stored.sha256 != sha256:
                raise DiandianError(
                    ErrorCode.UNEXPECTED,
                    "Prepared source verification failed",
                    retryable=False,
                )
            parts.append(
                DocumentPart(
                    id=str(
                        uuid5(
                            NAMESPACE_URL,
                            f"document-part:{part_asset.id}:{sequence}:{sha256}",
                        )
                    ),
                    asset_id=part_asset.id,
                    sequence=sequence,
                    storage_key=stored.key,
                    mime_type=_MARKDOWN_MIME,
                    word_count=chunk.word_count,
                    sha256=stored.sha256,
                    chapter_refs=chunk.chapter_refs,
                    size_bytes=stored.size_bytes,
                )
            )
        return tuple(parts)

    def _store_manifest(
        self,
        root: DocumentAsset,
        derived_assets: tuple[DocumentAsset, ...],
        parts: tuple[DocumentPart, ...],
        capabilities: TargetCapabilities,
    ) -> PreparationManifest:
        payload = {
            "version": 1,
            "root_asset": _asset_manifest(root),
            "derived_assets": [_asset_manifest(asset) for asset in derived_assets],
            "parts": [
                {
                    "id": part.id,
                    "asset_id": part.asset_id,
                    "sequence": part.sequence,
                    "storage_key": part.storage_key.value,
                    "mime_type": part.mime_type,
                    "word_count": part.word_count,
                    "size_bytes": part.size_bytes,
                    "sha256": part.sha256,
                    "chapter_refs": list(part.chapter_refs),
                }
                for part in parts
            ],
            "policy": {
                "name": "local-document-preparation",
                "version": 1,
                "security_limits": asdict(self._limits),
                "target_capabilities": {
                    "max_source_words": capabilities.max_source_words,
                    "max_source_bytes": capabilities.max_source_bytes,
                    "max_sources_per_workspace": capabilities.max_sources_per_workspace,
                    "accepted_mime_types": sorted(capabilities.accepted_mime_types),
                },
            },
        }
        content = json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        sha256 = hashlib.sha256(content).hexdigest()
        key = StorageKey(f"manifests/{root.id}/{sha256}.json")
        stored = self._store.put(key, _bytes_reader(content))
        return PreparationManifest(
            root_asset_id=root.id,
            storage_key=stored.key,
            sha256=stored.sha256,
        )

    def _parse_epub(self, payload: bytes) -> _ParsedEpub:
        worker = Path(__file__).with_name("epub_worker.py")
        limits = self._limits
        command = [
            sys.executable,
            "-I",
            str(worker),
            "--max-input",
            str(limits.max_input_bytes),
            "--max-entries",
            str(limits.max_archive_entries),
            "--max-entry",
            str(limits.max_archive_entry_bytes),
            "--max-total",
            str(limits.max_archive_total_bytes),
            "--max-ratio",
            str(limits.max_compression_ratio),
            "--max-depth",
            str(limits.max_archive_depth),
            "--max-name",
            str(limits.max_archive_name_length),
            "--max-xml",
            str(limits.max_xml_bytes),
            "--max-output",
            str(limits.max_parser_output_bytes),
            "--cpu-seconds",
            str(limits.parser_cpu_seconds),
            "--memory-bytes",
            str(limits.parser_memory_bytes),
        ]
        try:
            completed = subprocess.run(
                command,
                input=payload,
                capture_output=True,
                timeout=limits.parser_timeout_seconds,
                check=False,
                env=_parser_environment(),
            )
        except subprocess.TimeoutExpired as exc:
            raise DiandianError(
                ErrorCode.CONVERSION_FAILED,
                "EPUB parser exceeded its wall-clock limit",
                retryable=False,
            ) from exc
        if len(completed.stdout) > limits.max_parser_output_bytes:
            raise DiandianError(
                ErrorCode.SOURCE_LIMIT_EXCEEDED,
                "EPUB parser output exceeded its byte limit",
                retryable=False,
            )
        try:
            result = cast(object, json.loads(completed.stdout))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise DiandianError(
                ErrorCode.CONVERSION_FAILED,
                "EPUB parser returned an invalid response",
                retryable=False,
            ) from exc
        if completed.returncode != 0:
            result_mapping = _object_mapping(result)
            error = (
                _object_mapping(result_mapping.get("error")) if result_mapping is not None else None
            )
            code = error.get("code") if error is not None else None
            message = error.get("message") if error is not None else None
            raise DiandianError(
                _parser_error_code(code),
                message if isinstance(message, str) else "EPUB parsing failed closed",
                retryable=False,
            )
        return _validated_epub_result(result, limits.max_parser_output_bytes)

    @staticmethod
    def _require_target_mime(mime_type: str, capabilities: TargetCapabilities) -> None:
        if mime_type not in capabilities.accepted_mime_types:
            raise DiandianError(
                ErrorCode.FORMAT_UNSUPPORTED,
                "Prepared source MIME type is not accepted by the target",
                retryable=False,
            )


def _decode_markdown(payload: bytes) -> str:
    try:
        return normalize_markdown(payload.decode("utf-8-sig"))
    except UnicodeDecodeError as exc:
        raise DiandianError(
            ErrorCode.CONVERSION_FAILED,
            "Markdown must be valid UTF-8",
            retryable=False,
        ) from exc


def _validate_pdf(payload: bytes) -> None:
    if not payload.startswith(b"%PDF-") or b"%%EOF" not in payload[-2048:]:
        raise DiandianError(
            ErrorCode.CONVERSION_FAILED,
            "PDF structure is incomplete or invalid",
            retryable=False,
        )


def _asset_manifest(asset: DocumentAsset) -> dict[str, object]:
    return {
        "id": asset.id,
        "storage_key": asset.storage_key.value,
        "display_filename": asset.display_filename,
        "mime_type": asset.mime_type,
        "size_bytes": asset.size_bytes,
        "sha256": asset.sha256,
        "title": asset.title,
        "author": asset.author,
        "origin": asset.origin.value,
        "origin_locator": asset.origin_locator,
        "rights_provenance_id": asset.rights_provenance_id,
        "derived_from_asset_id": asset.derived_from_asset_id,
    }


def _validated_epub_result(result: object, max_output_bytes: int) -> _ParsedEpub:
    result_mapping = _object_mapping(result)
    if result_mapping is None:
        raise DiandianError(
            ErrorCode.CONVERSION_FAILED,
            "EPUB parser returned an invalid document",
            retryable=False,
        )
    raw_chapters_value = result_mapping.get("chapters")
    if not isinstance(raw_chapters_value, list):
        raise DiandianError(
            ErrorCode.CONVERSION_FAILED,
            "EPUB parser returned an invalid document",
            retryable=False,
        )
    raw_chapters = cast(list[object], raw_chapters_value)
    chapters: list[TextChapter] = []
    consumed = 0
    for raw_item in raw_chapters:
        item = _object_mapping(raw_item)
        if item is None:
            raise DiandianError(
                ErrorCode.CONVERSION_FAILED,
                "EPUB parser returned an invalid chapter",
                retryable=False,
            )
        reference = item.get("reference")
        markdown = item.get("markdown")
        if not isinstance(reference, str) or not isinstance(markdown, str):
            raise DiandianError(
                ErrorCode.CONVERSION_FAILED,
                "EPUB parser returned an invalid chapter",
                retryable=False,
            )
        consumed += len(markdown.encode("utf-8"))
        if consumed > max_output_bytes:
            raise DiandianError(
                ErrorCode.SOURCE_LIMIT_EXCEEDED,
                "EPUB parser output exceeded its byte limit",
                retryable=False,
            )
        chapters.append(TextChapter(reference=reference, markdown=markdown))
    if not chapters:
        raise DiandianError(
            ErrorCode.CONVERSION_FAILED,
            "EPUB parser returned no readable chapters",
            retryable=False,
        )
    return {
        "title": result_mapping.get("title"),
        "author": result_mapping.get("author"),
        "chapters": tuple(chapters),
    }


def _object_mapping(value: object) -> dict[str, object] | None:
    if not isinstance(value, dict):
        return None
    mapping = cast(dict[object, object], value)
    if not all(isinstance(key, str) for key in mapping):
        return None
    return cast(dict[str, object], mapping)


def _metadata_value(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    printable = "".join(character for character in value if character.isprintable())
    normalized = " ".join(printable.split())
    return normalized[:500] or None


def _bytes_reader(content: bytes) -> io.BytesIO:
    return io.BytesIO(content)


def _parser_environment() -> dict[str, str]:
    allowed = {"PATH", "SYSTEMROOT", "WINDIR", "TMPDIR", "TMP", "TEMP"}
    environment = {name: value for name, value in os.environ.items() if name in allowed}
    coverage_config = os.environ.get("COVERAGE_PROCESS_CONFIG")
    if coverage_config and "coverage" in sys.modules:
        environment["COVERAGE_PROCESS_CONFIG"] = coverage_config
    environment.update({"PYTHONHASHSEED": "0", "PYTHONNOUSERSITE": "1"})
    return environment


def _parser_error_code(value: object) -> ErrorCode:
    if value == ErrorCode.FORMAT_UNSUPPORTED.value:
        return ErrorCode.FORMAT_UNSUPPORTED
    if value == ErrorCode.SOURCE_LIMIT_EXCEEDED.value:
        return ErrorCode.SOURCE_LIMIT_EXCEEDED
    return ErrorCode.CONVERSION_FAILED
