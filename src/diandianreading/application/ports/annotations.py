"""Persistence Ports for reader annotations and reading progress.

Frozen in W0 (ADR-0007) so annotation storage, the re-anchoring sweep, and the
reader API can be built in parallel against one contract. Mutations follow the
repository-wide optimistic pattern: ``save(previous, current)`` must fail with
a conflict when the stored row no longer matches ``previous.version``.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import Protocol

from diandianreading.domain.annotations import (
    Annotation,
    AnnotationStatus,
    ReadingProgress,
)


class AnnotationRepository(Protocol):
    def add(self, annotation: Annotation) -> None: ...

    def save(self, previous: Annotation, current: Annotation) -> None: ...

    def get(self, annotation_id: str) -> Annotation | None: ...

    def list_for_book(
        self,
        book_id: str,
        *,
        statuses: Sequence[AnnotationStatus] | None = None,
        limit: int,
        before_created_at: datetime | None = None,
        before_id: str | None = None,
    ) -> Sequence[Annotation]: ...

    def list_for_anchor_document(
        self,
        anchor_sha256: str,
        *,
        statuses: Sequence[AnnotationStatus] | None = None,
    ) -> Sequence[Annotation]: ...

    def count_for_book(self, book_id: str) -> int: ...


class ReadingProgressRepository(Protocol):
    def get(self, book_id: str) -> ReadingProgress | None: ...

    def save(self, previous: ReadingProgress | None, current: ReadingProgress) -> None: ...
