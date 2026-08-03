"""Bridge the reading surface into chat: selection verification and text access.

Implements the chat-side ``SelectionVerifier`` and ``DocumentTextReader``
Ports on top of the reading service and the local part store, so the chat
use case can ground selections and locate citation excerpts without
importing the reading use case directly.
"""

from __future__ import annotations

import hashlib

from diandianreading.application.ports.repositories import UnitOfWorkFactory
from diandianreading.application.ports.storage import FileStore
from diandianreading.application.services.citation_locator import locate_excerpt
from diandianreading.application.use_cases.reading import ReadingService
from diandianreading.domain import DiandianError, DocumentPart, ErrorCode
from diandianreading.domain.chat import SelectionLocator

_MARKDOWN_MIME = "text/markdown"
_READ_CHUNK = 1024 * 1024


class ReadingChatBridge:
    """Verify selections against their claimed Part and read citation text."""

    def __init__(
        self,
        *,
        reading: ReadingService,
        unit_of_work: UnitOfWorkFactory,
        file_store: FileStore,
    ) -> None:
        self._reading = reading
        self._unit_of_work = unit_of_work
        self._file_store = file_store

    def verify_selection(
        self,
        *,
        book_id: str,
        document_part_id: str,
        locator: SelectionLocator,
        selected_text: str,
    ) -> bool:
        del locator  # Part-level verification is textual; offsets are whole-document.
        needle = selected_text.strip()
        if not needle:
            return False
        try:
            with self._unit_of_work() as unit_of_work:
                parts = tuple(unit_of_work.catalog.list_parts(book_id))
                unit_of_work.commit()
            part = next((item for item in parts if item.id == document_part_id), None)
            if part is None or part.mime_type != _MARKDOWN_MIME:
                return False
            text = self._read_part_text(part)
        except DiandianError:
            return False
        if needle in text:
            return True
        return locate_excerpt(text, needle) is not None

    def read_markdown_text(self, book_id: str) -> tuple[str, str] | None:
        try:
            content = self._reading.get_content(book_id)
        except DiandianError:
            return None
        if content.document.mime_type != _MARKDOWN_MIME:
            return None
        try:
            text = content.payload.decode("utf-8")
        except UnicodeDecodeError:
            return None
        return content.document.anchor_sha256, text

    def _read_part_text(self, part: DocumentPart) -> str:
        digest = hashlib.sha256()
        payload = bytearray()
        with self._file_store.open(part.storage_key) as source:
            while True:
                chunk = source.read(_READ_CHUNK)
                if not chunk:
                    break
                payload.extend(chunk)
                digest.update(chunk)
        if digest.hexdigest() != part.sha256:
            raise DiandianError(
                ErrorCode.SOURCE_UNAVAILABLE,
                "Stored part no longer matches its recorded checksum",
                retryable=False,
            )
        return payload.decode("utf-8")
