"""Progress reporting boundary."""

from __future__ import annotations

import logging
from typing import Protocol

from diandianreading.domain import ProgressEvent, safe_public_message

logger = logging.getLogger(__name__)


class ProgressSink(Protocol):
    @property
    def job_id(self) -> str:
        """Return the Job receiving progress updates."""
        ...

    async def emit(self, event: ProgressEvent) -> None:
        """Publish one provider-neutral, user-safe progress event."""
        ...


class NullProgressSink:
    def __init__(self, job_id: str = "") -> None:
        self._job_id: str = job_id

    @property
    def job_id(self) -> str:
        return self._job_id

    async def emit(self, event: ProgressEvent) -> None:
        del event


class ScopedProgressSink:
    """Bind an arbitrary sink to a Job and normalize adapter events."""

    def __init__(self, job_id: str, delegate: ProgressSink) -> None:
        self._job_id: str = job_id
        self._delegate: ProgressSink = delegate

    @property
    def job_id(self) -> str:
        return self._job_id

    async def emit(self, event: ProgressEvent) -> None:
        normalized = ProgressEvent(
            job_id=self._job_id,
            step=event.step,
            current=event.current,
            total=event.total,
            message=safe_public_message(event.message),
        )
        await self._delegate.emit(normalized)


class BestEffortProgressSink:
    """Prevent observer failures from controlling durable workflow execution."""

    def __init__(self, delegate: ProgressSink) -> None:
        self._delegate: ProgressSink = delegate

    @property
    def job_id(self) -> str:
        return self._delegate.job_id

    async def emit(self, event: ProgressEvent) -> None:
        try:
            await self._delegate.emit(event)
        except Exception as exc:
            logger.warning("Progress observer failed: %s", type(exc).__name__)
