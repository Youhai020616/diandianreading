"""Provider-neutral reconciliation Port for uncertain remote write outcomes."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol

from diandianreading.domain import (
    Book,
    CredentialRef,
    DocumentPart,
    RemoteOperation,
    RemoteProbeStrategy,
    WorkspaceRef,
)


class ReconciliationStatus(StrEnum):
    RECOVERED = "recovered"
    PROVEN_ABSENT = "proven_absent"
    AMBIGUOUS = "ambiguous"


@dataclass(frozen=True, slots=True)
class ReconciliationResult:
    status: ReconciliationStatus
    external_id: str | None = None

    def __post_init__(self) -> None:
        if (self.status is ReconciliationStatus.RECOVERED) != bool(self.external_id):
            raise ValueError("Only a recovered reconciliation result has an external identifier")


class KnowledgeHealthPort(Protocol):
    async def credential_is_healthy(self, credential: CredentialRef) -> bool: ...


class KnowledgeReconciliationPort(Protocol):
    probe_strategy: RemoteProbeStrategy

    async def reconcile_workspace(
        self,
        book: Book,
        credential: CredentialRef,
        operation: RemoteOperation,
    ) -> ReconciliationResult: ...

    async def reconcile_source(
        self,
        workspace: WorkspaceRef,
        part: DocumentPart,
        operation: RemoteOperation,
    ) -> ReconciliationResult: ...
