"""Finite worker orchestration for durable Import Jobs and Chat Runs."""

from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import Protocol, final

from diandianreading.domain import DiandianError

_MIN_POLL_INTERVAL_SECONDS = 0.001
_MAX_POLL_INTERVAL_SECONDS = 60.0


class ImportJobWorkerPort(Protocol):
    async def run_next(self, *, worker_id: str) -> object | None: ...


class ChatRunWorkerPort(Protocol):
    async def run_next(self, *, worker_id: str) -> object | None: ...


class ContentGenerationWorkerPort(Protocol):
    async def run_next(self, *, worker_id: str) -> object | None: ...


class StopEventPort(Protocol):
    def is_set(self) -> bool: ...

    async def wait(self) -> object: ...


@final
class WorkerRunner:
    def __init__(
        self,
        *,
        imports: ImportJobWorkerPort,
        chat: ChatRunWorkerPort | None = None,
        content: ContentGenerationWorkerPort | None = None,
        worker_id: str = "worker",
        poll_interval: float = 1.0,
    ) -> None:
        if not worker_id.strip() or len(worker_id) > 512:
            raise ValueError("Worker ID must be a non-empty bounded string")
        _validate_poll_interval(poll_interval)
        self._imports = imports
        self._chat = chat
        self._content = content
        self._worker_id = worker_id
        self._poll_interval = poll_interval

    async def run_once(self) -> bool:
        handled = await self._run_import_once()
        if self._chat is not None:
            handled = await self._run_chat_once() or handled
        if self._content is not None:
            handled = await self._run_content_once() or handled
        return handled

    async def run_forever(
        self,
        stop_event: StopEventPort,
        *,
        poll_interval: float | None = None,
    ) -> None:
        interval = self._poll_interval if poll_interval is None else poll_interval
        _validate_poll_interval(interval)
        while not stop_event.is_set():
            handled = await self.run_once()
            if handled:
                await asyncio.sleep(0)
                continue
            with suppress(TimeoutError):
                await asyncio.wait_for(stop_event.wait(), timeout=interval)

    async def _run_import_once(self) -> bool:
        try:
            result = await self._imports.run_next(worker_id=self._worker_id)
        except DiandianError as error:
            if _is_projected_import_error(error):
                return True
            raise
        return result is not None

    async def _run_content_once(self) -> bool:
        assert self._content is not None
        # Generation projects its own failures onto the content asset row, so a
        # typed domain error here is a completed turn, not a worker crash.
        try:
            result = await self._content.run_next(worker_id=self._worker_id)
        except DiandianError:
            return True
        return result is not None

    async def _run_chat_once(self) -> bool:
        assert self._chat is not None
        try:
            result = await self._chat.run_next(worker_id=self._worker_id)
        except Exception as error:
            if (
                isinstance(error, DiandianError) and _is_projected_import_error(error)
            ) or _is_projected_chat_error(error):
                return True
            raise
        return result is not None


def _is_projected_import_error(error: DiandianError) -> bool:
    return getattr(error, "durably_projected", False) is True


def _is_projected_chat_error(error: Exception) -> bool:
    run_id = getattr(error, "run_id", None)
    safe_error = getattr(error, "error", None)
    return isinstance(run_id, str) and bool(run_id.strip()) and safe_error is not None


def _validate_poll_interval(value: float) -> None:
    if not _MIN_POLL_INTERVAL_SECONDS <= value <= _MAX_POLL_INTERVAL_SECONDS:
        raise ValueError(
            "Worker poll interval must be between "
            f"{_MIN_POLL_INTERVAL_SECONDS} and {_MAX_POLL_INTERVAL_SECONDS} seconds"
        )
