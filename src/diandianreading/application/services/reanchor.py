"""Pure re-anchoring engine for reader annotations (ADR-0007 §2).

When a book is re-imported, its derived markdown gets a new content hash and
every stored offset becomes meaningless. This engine decides, per annotation
and without any IO, whether the annotation is preserved, moved onto the new
document via its quote fingerprint, or orphaned:

- Annotations that are already anchored to the new hash, or are not eligible
  (soft-deleted, already orphaned, never anchored) are returned unchanged.
  Every step is idempotent, so an interrupted sweep can safely re-run.
- Otherwise ``quote.exact`` is searched in the new document text. Exactly one
  hit re-anchors the annotation. With several hits, the bounded
  ``prefix``/``suffix`` context filters the candidates, and only a single
  surviving candidate counts as unique.
- Zero hits, or a quote that stays ambiguous after context filtering, orphan
  the annotation while preserving its original locator and text for manual
  relocation. Nothing is ever silently deleted or misplaced.

A rewritten anchor drops ``chapter_ref``: chapter identifiers are derived
from the new document, and without the new chapter index any kept value would
be fabricated locality. ``pdf_page`` anchors cannot be recomputed from text
at all, so they orphan when their document hash changes.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum

from diandianreading.domain.annotations import (
    Annotation,
    AnnotationStatus,
    ContentAnchor,
    TextQuote,
)
from diandianreading.domain.chat import ChatReferenceLocationType

_SHA256_HEX_LENGTH = 64
_SHA256_ALPHABET = frozenset("0123456789abcdef")


class ReanchorDisposition(StrEnum):
    """How the engine settled one annotation against the new document."""

    UNCHANGED = "unchanged"
    REANCHORED = "reanchored"
    ORPHANED = "orphaned"


@dataclass(frozen=True, slots=True)
class ReanchorResult:
    """One settled annotation; persist ``annotation`` when ``changed`` is true."""

    annotation: Annotation
    disposition: ReanchorDisposition

    @property
    def changed(self) -> bool:
        return self.disposition is not ReanchorDisposition.UNCHANGED


def reanchor_annotation(
    annotation: Annotation,
    *,
    document_text: str,
    document_sha256: str,
    now: datetime | None = None,
) -> ReanchorResult:
    """Settle one annotation against the newly derived document."""

    _require_document_sha256(document_sha256)
    anchor = annotation.anchor
    if (
        annotation.status is not AnnotationStatus.ACTIVE
        or anchor is None
        or anchor.anchor_sha256 == document_sha256
    ):
        return ReanchorResult(annotation=annotation, disposition=ReanchorDisposition.UNCHANGED)
    if anchor.type is not ChatReferenceLocationType.MARKDOWN_OFFSET or anchor.quote is None:
        return ReanchorResult(
            annotation=annotation.mark_orphaned(now=now),
            disposition=ReanchorDisposition.ORPHANED,
        )
    start = _locate_unique(document_text, anchor.quote)
    if start is None:
        return ReanchorResult(
            annotation=annotation.mark_orphaned(now=now),
            disposition=ReanchorDisposition.ORPHANED,
        )
    moved = ContentAnchor(
        type=ChatReferenceLocationType.MARKDOWN_OFFSET,
        anchor_sha256=document_sha256,
        start=start,
        end=start + len(anchor.quote.exact),
        chapter_ref=None,
        quote=anchor.quote,
    )
    return ReanchorResult(
        annotation=annotation.reanchor(moved, now=now),
        disposition=ReanchorDisposition.REANCHORED,
    )


def reanchor_annotations(
    annotations: Iterable[Annotation],
    *,
    document_text: str,
    document_sha256: str,
    now: datetime | None = None,
) -> tuple[ReanchorResult, ...]:
    """Settle annotations one by one; outcomes are independent per item."""

    return tuple(
        reanchor_annotation(
            annotation,
            document_text=document_text,
            document_sha256=document_sha256,
            now=now,
        )
        for annotation in annotations
    )


def _locate_unique(document_text: str, quote: TextQuote) -> int | None:
    hits = _find_all(document_text, quote.exact)
    if not hits:
        return None
    if len(hits) == 1:
        return hits[0]
    contextual = [start for start in hits if _context_matches(document_text, start, quote)]
    if len(contextual) == 1:
        return contextual[0]
    return None


def _find_all(document_text: str, exact: str) -> list[int]:
    hits: list[int] = []
    cursor = document_text.find(exact)
    while cursor != -1:
        hits.append(cursor)
        cursor = document_text.find(exact, cursor + 1)
    return hits


def _context_matches(document_text: str, start: int, quote: TextQuote) -> bool:
    prefix = quote.prefix
    if prefix and document_text[max(start - len(prefix), 0) : start] != prefix:
        return False
    suffix = quote.suffix
    end = start + len(quote.exact)
    return not (suffix and document_text[end : end + len(suffix)] != suffix)


def _require_document_sha256(value: str) -> None:
    if len(value) != _SHA256_HEX_LENGTH or not set(value) <= _SHA256_ALPHABET:
        raise ValueError("document_sha256 must be a lowercase sha256 hex digest")
