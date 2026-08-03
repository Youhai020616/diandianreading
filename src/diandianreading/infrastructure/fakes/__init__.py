"""Test and development infrastructure adapters."""

from diandianreading.infrastructure.fakes.documents import FakeDocumentPreparationAdapter
from diandianreading.infrastructure.fakes.knowledge import FakeKnowledgeAdapter
from diandianreading.infrastructure.fakes.notebooklm_sdk import (
    DeterministicNotebookLMService,
    FakeNotebookLMClientFactory,
)

__all__ = [
    "DeterministicNotebookLMService",
    "FakeDocumentPreparationAdapter",
    "FakeKnowledgeAdapter",
    "FakeNotebookLMClientFactory",
]
