"""Structural seams around the public notebooklm-py client surface."""

from __future__ import annotations

from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from pathlib import Path
from typing import BinaryIO, Protocol

from diandianreading.application.ports import StoredFile
from diandianreading.domain import StorageKey


class SDKNotebook(Protocol):
    id: str
    title: str


class SDKSource(Protocol):
    id: str

    @property
    def is_ready(self) -> bool: ...

    @property
    def is_processing(self) -> bool: ...

    @property
    def is_error(self) -> bool: ...


class SDKChatReference(Protocol):
    source_id: str
    cited_text: str | None


class SDKAskResult(Protocol):
    answer: str
    conversation_id: str
    references: list[SDKChatReference]


class SDKGenerationStatus(Protocol):
    task_id: str
    status: object
    url: str | None
    error: str | None
    error_code: str | None

    @property
    def is_complete(self) -> bool: ...

    @property
    def is_failed(self) -> bool: ...

    @property
    def is_removed(self) -> bool: ...

    @property
    def is_rate_limited(self) -> bool: ...


class SDKNotebooksAPI(Protocol):
    async def list(self) -> list[SDKNotebook]: ...

    async def create(self, title: str) -> SDKNotebook: ...

    async def get_or_none(self, notebook_id: str) -> SDKNotebook | None: ...


class SDKSourcesAPI(Protocol):
    async def add_file(
        self,
        notebook_id: str,
        file_path: str | Path,
        mime_type: str | None = None,
        *,
        wait: bool = False,
        wait_timeout: float = 120.0,
        title: str | None = None,
        on_progress: Callable[[int, int], object] | None = None,
    ) -> SDKSource: ...

    async def get_or_none(self, notebook_id: str, source_id: str) -> SDKSource | None: ...

    async def wait_for_sources(
        self,
        notebook_id: str,
        source_ids: list[str],
        timeout: float = 120.0,
        **kwargs: object,
    ) -> list[SDKSource]: ...


class SDKChatAPI(Protocol):
    async def ask(
        self,
        notebook_id: str,
        question: str,
        source_ids: list[str] | None = None,
        conversation_id: str | None = None,
    ) -> SDKAskResult: ...


class SDKArtifactsAPI(Protocol):
    async def generate_audio(
        self, notebook_id: str, *, instructions: str | None = None
    ) -> SDKGenerationStatus: ...

    async def generate_video(
        self, notebook_id: str, *, instructions: str | None = None
    ) -> SDKGenerationStatus: ...

    async def generate_report(
        self, notebook_id: str, *, extra_instructions: str | None = None
    ) -> SDKGenerationStatus: ...

    async def generate_study_guide(
        self, notebook_id: str, *, extra_instructions: str | None = None
    ) -> SDKGenerationStatus: ...

    async def generate_quiz(
        self, notebook_id: str, *, instructions: str | None = None
    ) -> SDKGenerationStatus: ...

    async def generate_flashcards(
        self, notebook_id: str, *, instructions: str | None = None
    ) -> SDKGenerationStatus: ...

    async def generate_infographic(
        self, notebook_id: str, *, instructions: str | None = None
    ) -> SDKGenerationStatus: ...

    async def generate_slide_deck(
        self, notebook_id: str, *, instructions: str | None = None
    ) -> SDKGenerationStatus: ...

    async def generate_data_table(
        self, notebook_id: str, *, instructions: str | None = None
    ) -> SDKGenerationStatus: ...

    async def wait_for_completion(
        self,
        notebook_id: str,
        task_id: str,
        *,
        timeout: float = 300.0,
    ) -> SDKGenerationStatus: ...

    async def download_audio(
        self, notebook_id: str, output_path: str, artifact_id: str | None = None
    ) -> str: ...

    async def download_video(
        self, notebook_id: str, output_path: str, artifact_id: str | None = None
    ) -> str: ...

    async def download_report(
        self, notebook_id: str, output_path: str, artifact_id: str | None = None
    ) -> str: ...

    async def download_quiz(
        self,
        notebook_id: str,
        output_path: str,
        artifact_id: str | None = None,
        output_format: str = "json",
    ) -> str: ...

    async def download_flashcards(
        self,
        notebook_id: str,
        output_path: str,
        artifact_id: str | None = None,
        output_format: str = "json",
    ) -> str: ...

    async def download_infographic(
        self, notebook_id: str, output_path: str, artifact_id: str | None = None
    ) -> str: ...

    async def download_slide_deck(
        self,
        notebook_id: str,
        output_path: str,
        artifact_id: str | None = None,
        output_format: str = "pdf",
    ) -> str: ...

    async def download_data_table(
        self, notebook_id: str, output_path: str, artifact_id: str | None = None
    ) -> str: ...


class NotebookLMClientProtocol(Protocol):
    notebooks: SDKNotebooksAPI
    sources: SDKSourcesAPI
    chat: SDKChatAPI
    artifacts: SDKArtifactsAPI


class NotebookLMClientFactoryProtocol(Protocol):
    def open(self, storage_path: Path) -> AbstractAsyncContextManager[NotebookLMClientProtocol]: ...


class NotebookLMFileStore(Protocol):
    def put(self, key: StorageKey, content: BinaryIO) -> StoredFile: ...

    def stat(self, key: StorageKey) -> StoredFile: ...

    def resolve_for_read(self, key: StorageKey) -> Path: ...
