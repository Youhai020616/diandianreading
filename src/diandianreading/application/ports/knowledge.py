"""Provider-neutral knowledge service Ports."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from diandianreading.application.ports.progress import ProgressSink
from diandianreading.domain import (
    Book,
    CredentialRef,
    DocumentAsset,
    DocumentPart,
    KnowledgeSourceRef,
    RemoteOperationRef,
    StorageKey,
    WorkspaceRef,
)


@dataclass(frozen=True, slots=True)
class KnowledgeReference:
    external_source_id: str
    document_part_id: str | None
    excerpt: str | None


@dataclass(frozen=True, slots=True)
class KnowledgeAnswer:
    answer: str
    conversation_id: str | None
    references: tuple[KnowledgeReference, ...]


@dataclass(frozen=True, slots=True)
class GenerationHandle:
    id: str
    workspace_id: str
    content_type: str


@dataclass(frozen=True, slots=True)
class GeneratedContent:
    id: str
    content_type: str
    title: str
    text: str | None
    remote_url: str | None


class KnowledgeIngestionPort(Protocol):
    async def ensure_workspace(
        self,
        book: Book,
        credential: CredentialRef,
        operation: RemoteOperationRef,
        progress: ProgressSink,
    ) -> WorkspaceRef: ...

    async def add_part(
        self,
        workspace: WorkspaceRef,
        part: DocumentPart,
        operation: RemoteOperationRef,
        progress: ProgressSink,
    ) -> KnowledgeSourceRef: ...

    async def wait_sources(
        self,
        workspace: WorkspaceRef,
        sources: Sequence[KnowledgeSourceRef],
        progress: ProgressSink,
    ) -> Sequence[KnowledgeSourceRef]: ...


class KnowledgeQueryPort(Protocol):
    async def ask(
        self,
        workspace: WorkspaceRef,
        question: str,
        external_source_ids: Sequence[str] | None,
        provider_conversation_id: str | None,
    ) -> KnowledgeAnswer: ...


class KnowledgeGenerationPort(Protocol):
    async def generate(
        self,
        workspace: WorkspaceRef,
        content_type: str,
        instructions: str | None,
    ) -> GenerationHandle: ...

    async def wait(self, handle: GenerationHandle) -> GeneratedContent: ...

    async def download(
        self, content: GeneratedContent, destination: StorageKey
    ) -> DocumentAsset: ...
