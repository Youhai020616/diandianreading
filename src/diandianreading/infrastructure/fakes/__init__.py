"""Test and development infrastructure adapters."""

from diandianreading.infrastructure.fakes.documents import FakeDocumentPreparationAdapter
from diandianreading.infrastructure.fakes.knowledge import (
    FakeKnowledgeAdapter,
    FakeKnowledgeService,
)
from diandianreading.infrastructure.fakes.notebooklm_sdk import (
    DeterministicNotebookLMService,
    FakeNotebookLMClientFactory,
)

__all__ = [
    "DeterministicNotebookLMService",
    "FakeDocumentPreparationAdapter",
    "FakeKnowledgeAdapter",
    "FakeKnowledgeService",
    "FakeNotebookLMClientFactory",
]
