"""Public notebooklm-py client factory with bounded resource settings."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import cast

from notebooklm import NotebookLMClient

from diandianreading.infrastructure.notebooklm.protocols import NotebookLMClientProtocol


class NotebookLMClientFactory:
    """Open clients only through the SDK's canonical public context-manager API."""

    def __init__(
        self,
        *,
        timeout: float = 30.0,
        chat_timeout: float = 180.0,
        rate_limit_max_retries: int = 3,
        server_error_max_retries: int = 3,
        max_concurrent_uploads: int = 4,
        max_concurrent_rpcs: int = 16,
    ) -> None:
        if timeout <= 0 or chat_timeout <= 0:
            raise ValueError("NotebookLM client timeouts must be positive")
        if rate_limit_max_retries < 0 or server_error_max_retries < 0:
            raise ValueError("NotebookLM retry limits cannot be negative")
        if max_concurrent_uploads <= 0 or max_concurrent_rpcs <= 0:
            raise ValueError("NotebookLM concurrency limits must be positive")
        self._timeout = timeout
        self._chat_timeout = chat_timeout
        self._rate_limit_max_retries = rate_limit_max_retries
        self._server_error_max_retries = server_error_max_retries
        self._max_concurrent_uploads = max_concurrent_uploads
        self._max_concurrent_rpcs = max_concurrent_rpcs

    @asynccontextmanager
    async def open(self, storage_path: Path) -> AsyncIterator[NotebookLMClientProtocol]:
        async with NotebookLMClient.from_storage(
            path=str(storage_path),
            timeout=self._timeout,
            chat_timeout=self._chat_timeout,
            rate_limit_max_retries=self._rate_limit_max_retries,
            server_error_max_retries=self._server_error_max_retries,
            max_concurrent_uploads=self._max_concurrent_uploads,
            max_concurrent_rpcs=self._max_concurrent_rpcs,
        ) as client:
            yield cast(NotebookLMClientProtocol, cast(object, client))
