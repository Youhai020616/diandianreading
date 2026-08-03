"""Provider-neutral knowledge service Ports."""

from __future__ import annotations

import hashlib
import json
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
    workspace_id: str
    content_type: str
    title: str
    text: str | None
    remote_url: str | None


def normalize_content_type(content_type: str) -> str:
    """Normalize a provider-neutral content type used in persisted fingerprints."""

    normalized = content_type.strip().lower().replace("-", "_")
    if not normalized or not normalized.replace("_", "").isalnum():
        raise ValueError("Content type must be a non-empty alphanumeric identifier")
    return normalized


def generation_input_hash(content_type: str, instructions: str | None) -> str:
    """Build the stable input fingerprint required by a generation intent."""

    payload = {
        "content_type": normalize_content_type(content_type),
        "instructions": instructions.strip() if instructions else None,
    }
    canonical = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(canonical.encode()).hexdigest()


def download_input_hash(content: GeneratedContent, destination: StorageKey) -> str:
    """Build the stable input fingerprint required by a download intent."""

    payload = {
        "content_id": content.id,
        "content_type": normalize_content_type(content.content_type),
        "destination": destination.value,
        "remote_url": content.remote_url,
        "text": content.text,
        "title": content.title,
        "workspace_id": content.workspace_id,
    }
    canonical = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(canonical.encode()).hexdigest()


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
        operation: RemoteOperationRef,
    ) -> GenerationHandle: ...

    async def wait(self, handle: GenerationHandle) -> GeneratedContent: ...

    async def download(
        self,
        content: GeneratedContent,
        destination: StorageKey,
        operation: RemoteOperationRef,
    ) -> DocumentAsset: ...
