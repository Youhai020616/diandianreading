"""Deterministic in-process double for the public notebooklm-py client surface."""

from __future__ import annotations

import inspect
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from typing import cast
from uuid import NAMESPACE_URL, uuid5

from diandianreading.infrastructure.notebooklm.protocols import NotebookLMClientProtocol


@dataclass(frozen=True, slots=True)
class FakeSDKNotebook:
    id: str
    title: str


@dataclass(frozen=True, slots=True)
class FakeSDKSource:
    id: str
    notebook_id: str
    title: str
    content: bytes
    status: str = "processing"

    @property
    def is_ready(self) -> bool:
        return self.status == "ready"

    @property
    def is_processing(self) -> bool:
        return self.status == "processing"

    @property
    def is_error(self) -> bool:
        return self.status == "error"


@dataclass(frozen=True, slots=True)
class FakeSDKChatReference:
    source_id: str
    cited_text: str | None


@dataclass(frozen=True, slots=True)
class FakeSDKAskResult:
    answer: str
    conversation_id: str
    references: list[FakeSDKChatReference]


@dataclass(frozen=True, slots=True)
class FakeSDKGenerationStatus:
    task_id: str
    status: object
    url: str | None = None
    error: str | None = None
    error_code: str | None = None

    @property
    def is_complete(self) -> bool:
        return self.status == "completed"

    @property
    def is_failed(self) -> bool:
        return self.status == "failed"

    @property
    def is_removed(self) -> bool:
        return self.status == "removed"

    @property
    def is_rate_limited(self) -> bool:
        return self.error_code == "USER_DISPLAYABLE_ERROR"


class DeterministicNotebookLMService:
    """State shared across fake clients, mirroring one remote provider account."""

    def __init__(self) -> None:
        self.notebooks: dict[str, FakeSDKNotebook] = {}
        self.sources: dict[str, FakeSDKSource] = {}
        self.generations: dict[str, tuple[str, FakeSDKGenerationStatus]] = {}
        self.calls: list[str] = []
        self.uploaded_paths: list[Path] = []
        self.opened_storage_paths: list[Path] = []
        self.open_count = 0
        self.close_count = 0
        self.before_call_observer: Callable[[str], None] | None = None
        self._failures: dict[str, list[Exception]] = {}

    def queue_failure(self, method: str, error: Exception) -> None:
        self._failures.setdefault(method, []).append(error)

    def before_call(self, method: str) -> None:
        self.calls.append(method)
        if self.before_call_observer is not None:
            self.before_call_observer(method)
        failures = self._failures.get(method)
        if failures:
            raise failures.pop(0)


class FakeNotebookLMClientFactory:
    def __init__(self, service: DeterministicNotebookLMService | None = None) -> None:
        self.service = service or DeterministicNotebookLMService()

    @asynccontextmanager
    async def open(self, storage_path: Path) -> AsyncIterator[NotebookLMClientProtocol]:
        self.service.opened_storage_paths.append(storage_path)
        self.service.open_count += 1
        try:
            client = cast(object, FakeNotebookLMClient(self.service))
            yield cast(NotebookLMClientProtocol, client)
        finally:
            self.service.close_count += 1


class FakeNotebookLMClient:
    def __init__(self, service: DeterministicNotebookLMService) -> None:
        self.notebooks = FakeNotebooksAPI(service)
        self.sources = FakeSourcesAPI(service)
        self.chat = FakeChatAPI(service)
        self.artifacts = FakeArtifactsAPI(service)


class FakeNotebooksAPI:
    def __init__(self, service: DeterministicNotebookLMService) -> None:
        self._service = service

    async def list(self) -> list[FakeSDKNotebook]:
        self._service.before_call("notebooks.list")
        return list(self._service.notebooks.values())

    async def create(self, title: str) -> FakeSDKNotebook:
        self._service.before_call("notebooks.create")
        notebook_id = _fake_id("notebook", f"{title}:{len(self._service.notebooks)}")
        notebook = FakeSDKNotebook(notebook_id, title)
        self._service.notebooks[notebook_id] = notebook
        return notebook

    async def get_or_none(self, notebook_id: str) -> FakeSDKNotebook | None:
        self._service.before_call("notebooks.get_or_none")
        return self._service.notebooks.get(notebook_id)


class FakeSourcesAPI:
    def __init__(self, service: DeterministicNotebookLMService) -> None:
        self._service = service

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
    ) -> FakeSDKSource:
        del mime_type, wait_timeout
        self._service.before_call("sources.add_file")
        if notebook_id not in self._service.notebooks:
            raise ValueError("unknown fake SDK notebook")
        path = Path(file_path)
        content = path.read_bytes()
        self._service.uploaded_paths.append(path)
        if on_progress is not None:
            callback_result = on_progress(len(content), len(content))
            if inspect.isawaitable(callback_result):
                await callback_result
        source_id = _fake_id(
            "source", f"{notebook_id}:{len(self._service.sources)}:{content.hex()}"
        )
        source = FakeSDKSource(
            id=source_id,
            notebook_id=notebook_id,
            title=title or path.name,
            content=content,
            status="ready" if wait else "processing",
        )
        self._service.sources[source_id] = source
        return source

    async def get_or_none(self, notebook_id: str, source_id: str) -> FakeSDKSource | None:
        self._service.before_call("sources.get_or_none")
        source = self._service.sources.get(source_id)
        return source if source is not None and source.notebook_id == notebook_id else None

    async def wait_for_sources(
        self,
        notebook_id: str,
        source_ids: list[str],
        timeout: float = 120.0,
        **kwargs: object,
    ) -> list[FakeSDKSource]:
        del timeout, kwargs
        self._service.before_call("sources.wait_for_sources")
        ready: list[FakeSDKSource] = []
        for source_id in source_ids:
            source = self._service.sources.get(source_id)
            if source is None or source.notebook_id != notebook_id:
                raise ValueError("unknown fake SDK source")
            current = replace(source, status="ready")
            self._service.sources[source_id] = current
            ready.append(current)
        return ready


class FakeChatAPI:
    def __init__(self, service: DeterministicNotebookLMService) -> None:
        self._service = service

    async def ask(
        self,
        notebook_id: str,
        question: str,
        source_ids: list[str] | None = None,
        conversation_id: str | None = None,
    ) -> FakeSDKAskResult:
        self._service.before_call("chat.ask")
        if notebook_id not in self._service.notebooks:
            raise ValueError("unknown fake SDK notebook")
        selected = source_ids or [
            source.id
            for source in self._service.sources.values()
            if source.notebook_id == notebook_id
        ]
        conversation = conversation_id or _fake_id("conversation", notebook_id)
        return FakeSDKAskResult(
            answer=f"Grounded fake NotebookLM answer: {question}",
            conversation_id=conversation,
            references=[
                FakeSDKChatReference(source_id, "Deterministic cited passage")
                for source_id in selected
            ],
        )


class FakeArtifactsAPI:
    def __init__(self, service: DeterministicNotebookLMService) -> None:
        self._service = service

    async def generate_audio(
        self, notebook_id: str, *, instructions: str | None = None
    ) -> FakeSDKGenerationStatus:
        return self._generate(notebook_id, "audio", instructions)

    async def generate_video(
        self, notebook_id: str, *, instructions: str | None = None
    ) -> FakeSDKGenerationStatus:
        return self._generate(notebook_id, "video", instructions)

    async def generate_report(
        self, notebook_id: str, *, extra_instructions: str | None = None
    ) -> FakeSDKGenerationStatus:
        return self._generate(notebook_id, "report", extra_instructions)

    async def generate_study_guide(
        self, notebook_id: str, *, extra_instructions: str | None = None
    ) -> FakeSDKGenerationStatus:
        return self._generate(notebook_id, "study_guide", extra_instructions)

    async def generate_quiz(
        self, notebook_id: str, *, instructions: str | None = None
    ) -> FakeSDKGenerationStatus:
        return self._generate(notebook_id, "quiz", instructions)

    async def generate_flashcards(
        self, notebook_id: str, *, instructions: str | None = None
    ) -> FakeSDKGenerationStatus:
        return self._generate(notebook_id, "flashcards", instructions)

    async def generate_infographic(
        self, notebook_id: str, *, instructions: str | None = None
    ) -> FakeSDKGenerationStatus:
        return self._generate(notebook_id, "infographic", instructions)

    async def generate_slide_deck(
        self, notebook_id: str, *, instructions: str | None = None
    ) -> FakeSDKGenerationStatus:
        return self._generate(notebook_id, "slide_deck", instructions)

    async def generate_data_table(
        self, notebook_id: str, *, instructions: str | None = None
    ) -> FakeSDKGenerationStatus:
        return self._generate(notebook_id, "data_table", instructions)

    async def wait_for_completion(
        self,
        notebook_id: str,
        task_id: str,
        *,
        timeout: float = 300.0,
    ) -> FakeSDKGenerationStatus:
        del timeout
        self._service.before_call("artifacts.wait_for_completion")
        generation = self._service.generations.get(task_id)
        if generation is None or generation[0] != notebook_id:
            raise ValueError("unknown fake SDK generation")
        complete = replace(
            generation[1],
            status="completed",
            url=f"https://notebooklm.invalid/artifacts/{task_id}",
        )
        self._service.generations[task_id] = (notebook_id, complete)
        return complete

    async def download_audio(
        self, notebook_id: str, output_path: str, artifact_id: str | None = None
    ) -> str:
        return self._download(notebook_id, output_path, artifact_id, "audio")

    async def download_video(
        self, notebook_id: str, output_path: str, artifact_id: str | None = None
    ) -> str:
        return self._download(notebook_id, output_path, artifact_id, "video")

    async def download_report(
        self, notebook_id: str, output_path: str, artifact_id: str | None = None
    ) -> str:
        return self._download(notebook_id, output_path, artifact_id, "report")

    async def download_quiz(
        self,
        notebook_id: str,
        output_path: str,
        artifact_id: str | None = None,
        output_format: str = "json",
    ) -> str:
        del output_format
        return self._download(notebook_id, output_path, artifact_id, "quiz")

    async def download_flashcards(
        self,
        notebook_id: str,
        output_path: str,
        artifact_id: str | None = None,
        output_format: str = "json",
    ) -> str:
        del output_format
        return self._download(notebook_id, output_path, artifact_id, "flashcards")

    async def download_infographic(
        self, notebook_id: str, output_path: str, artifact_id: str | None = None
    ) -> str:
        return self._download(notebook_id, output_path, artifact_id, "infographic")

    async def download_slide_deck(
        self,
        notebook_id: str,
        output_path: str,
        artifact_id: str | None = None,
        output_format: str = "pdf",
    ) -> str:
        del output_format
        return self._download(notebook_id, output_path, artifact_id, "slide_deck")

    async def download_data_table(
        self, notebook_id: str, output_path: str, artifact_id: str | None = None
    ) -> str:
        return self._download(notebook_id, output_path, artifact_id, "data_table")

    def _generate(
        self,
        notebook_id: str,
        content_type: str,
        instructions: str | None,
    ) -> FakeSDKGenerationStatus:
        self._service.before_call(f"artifacts.generate_{content_type}")
        if notebook_id not in self._service.notebooks:
            raise ValueError("unknown fake SDK notebook")
        task_id = _fake_id(
            "artifact",
            f"{notebook_id}:{content_type}:{instructions}:{len(self._service.generations)}",
        )
        status = FakeSDKGenerationStatus(task_id, "in_progress")
        self._service.generations[task_id] = (notebook_id, status)
        return status

    def _download(
        self,
        notebook_id: str,
        output_path: str,
        artifact_id: str | None,
        content_type: str,
    ) -> str:
        self._service.before_call(f"artifacts.download_{content_type}")
        if artifact_id is None:
            raise ValueError("fake SDK download requires an artifact identifier")
        generation = self._service.generations.get(artifact_id)
        if generation is None or generation[0] != notebook_id:
            raise ValueError("unknown fake SDK generation")
        path = Path(output_path)
        path.write_bytes(f"{content_type}:{artifact_id}\n".encode())
        return str(path)


def _fake_id(kind: str, identity: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"diandianreading:fake-notebooklm:{kind}:{identity}"))
