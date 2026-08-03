"""Reader document processing backed by the deterministic markdown policy."""

from __future__ import annotations

from diandianreading.application.ports.reading import ChapterSpanView
from diandianreading.domain import DiandianError, ErrorCode
from diandianreading.infrastructure.documents.policy import (
    markdown_chapter_spans,
    normalize_markdown,
)


class PolicyReadingDocumentProcessor:
    """Implement ReadingDocumentProcessor with the same policy used at import."""

    def normalize(self, raw: bytes) -> str:
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError as error:
            raise DiandianError(
                ErrorCode.CONVERSION_FAILED,
                "Document is not valid UTF-8 text",
                retryable=False,
            ) from error
        return normalize_markdown(text)

    def chapter_spans(self, text: str) -> tuple[ChapterSpanView, ...]:
        return tuple(
            ChapterSpanView(
                reference=span.reference,
                title=span.title,
                start=span.start,
                end=span.end,
            )
            for span in markdown_chapter_spans(text)
        )
