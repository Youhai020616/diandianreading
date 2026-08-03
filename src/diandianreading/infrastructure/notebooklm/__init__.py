"""NotebookLM infrastructure adapter exports."""

from diandianreading.infrastructure.notebooklm.adapter import (
    NotebookLMAdapter,
    NotebookLMAdapterConfig,
    NotebookLMProfileHealth,
)
from diandianreading.infrastructure.notebooklm.client import NotebookLMClientFactory
from diandianreading.infrastructure.notebooklm.credentials import CredentialPathResolver
from diandianreading.infrastructure.notebooklm.errors import (
    NotebookLMOperation,
    map_notebooklm_error,
)
from diandianreading.infrastructure.notebooklm.protocols import (
    NotebookLMClientFactoryProtocol,
    NotebookLMClientProtocol,
)

__all__ = [
    "CredentialPathResolver",
    "NotebookLMAdapter",
    "NotebookLMAdapterConfig",
    "NotebookLMClientFactory",
    "NotebookLMClientFactoryProtocol",
    "NotebookLMClientProtocol",
    "NotebookLMOperation",
    "NotebookLMProfileHealth",
    "map_notebooklm_error",
]
