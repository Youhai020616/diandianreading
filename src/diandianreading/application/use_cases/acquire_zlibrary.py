"""Governed Z-Library acquisition with an application-layer rights gate."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from uuid import uuid4

from diandianreading.application.ports import (
    AcquiredAsset,
    AcquisitionRequest,
    NullProgressSink,
    ProgressSink,
    UnitOfWorkFactory,
    ZLibraryAcquisitionPort,
)
from diandianreading.domain import (
    CredentialRef,
    DiandianError,
    ErrorCode,
    RightsBasis,
    RightsProvenance,
    SourceOrigin,
    StorageKey,
    utc_now,
)

ZLIBRARY_RIGHTS_POLICY_VERSION = "zlibrary-rights-v1"


@dataclass(frozen=True, slots=True)
class ZLibraryAcquisitionCommand:
    """One non-batch, explicitly confirmed acquisition request."""

    location: str
    credential: CredentialRef
    rights_basis: RightsBasis
    license_identifier: str | None
    evidence_storage_key: StorageKey | None
    attestation_version: str
    rights_confirmed: bool
    options: Mapping[str, str]
    supersedes_id: str | None = None

    def __post_init__(self) -> None:
        if not self.location.strip():
            raise ValueError("Z-Library source location is required")
        if not self.attestation_version.strip():
            raise ValueError("Rights attestation policy version is required")


@dataclass(frozen=True, slots=True)
class ZLibraryAcquisitionResult:
    acquired: AcquiredAsset
    rights_provenance: RightsProvenance


class ZLibraryAcquisitionUseCase:
    """Persist an auditable per-item attestation before invoking the optional Adapter."""

    def __init__(
        self,
        *,
        unit_of_work: UnitOfWorkFactory,
        acquirer: ZLibraryAcquisitionPort,
        enabled: bool = False,
        current_attestation_version: str = ZLIBRARY_RIGHTS_POLICY_VERSION,
        id_factory: Callable[[], str] | None = None,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        if not current_attestation_version.strip():
            raise ValueError("Current rights attestation policy version is required")
        self._unit_of_work = unit_of_work
        self._acquirer = acquirer
        self._enabled = enabled
        self._current_attestation_version = current_attestation_version
        self._id_factory = id_factory or (lambda: str(uuid4()))
        self._clock = clock

    async def execute(
        self,
        command: ZLibraryAcquisitionCommand,
        progress: ProgressSink | None = None,
    ) -> ZLibraryAcquisitionResult:
        if not self._enabled:
            raise _validation("Z-Library acquisition is disabled")
        if self._acquirer.provider != "zlibrary":
            raise _validation("Configured acquisition Adapter is not Z-Library")
        if command.credential.provider != "zlibrary":
            raise _validation("Z-Library acquisition requires a Z-Library credential profile")
        if not command.rights_confirmed:
            raise _validation(
                "Z-Library acquisition requires explicit per-item rights confirmation"
            )
        if command.attestation_version != self._current_attestation_version:
            raise _validation("Z-Library rights attestation is missing or out of date")

        canonical_location = self._acquirer.canonicalize_location(command.location)
        redacted_location = self._acquirer.redact_location(canonical_location)
        timestamp = self._clock()
        provenance = RightsProvenance(
            id=self._id_factory(),
            provider=self._acquirer.provider,
            source_locator_redacted=redacted_location,
            rights_basis=command.rights_basis,
            license_identifier=command.license_identifier,
            evidence_storage_key=command.evidence_storage_key,
            attestation_version=command.attestation_version,
            attested_at=timestamp,
            acquisition_job_id=None,
            content_sha256=None,
            supersedes_id=command.supersedes_id,
            updated_at=timestamp,
            version=0,
        )
        with self._unit_of_work() as unit_of_work:
            unit_of_work.rights.add(provenance)
            unit_of_work.commit()

        options = dict(command.options)
        options["rights_provenance_id"] = provenance.id
        options["source_locator_redacted"] = redacted_location
        acquired = await self._acquirer.acquire(
            AcquisitionRequest(
                provider=self._acquirer.provider,
                location=canonical_location,
                rights_confirmed=True,
                options=options,
                credential=command.credential,
            ),
            progress or NullProgressSink(provenance.id),
        )
        asset = acquired.asset
        if asset.origin is not SourceOrigin.ZLIBRARY:
            raise _validation("Z-Library Adapter returned an asset with the wrong origin")
        if asset.origin_locator != redacted_location:
            raise _validation("Z-Library Adapter returned an asset for a different source")
        if asset.rights_provenance_id != provenance.id:
            raise _validation(
                "Z-Library Adapter returned an asset with different rights provenance"
            )

        bound = provenance.bind_content(asset.sha256, now=self._clock())
        with self._unit_of_work() as unit_of_work:
            persisted = unit_of_work.rights.get(provenance.id)
            if persisted is None:
                raise _validation("Z-Library rights provenance disappeared during acquisition")
            unit_of_work.rights.save(persisted, bound)
            unit_of_work.commit()
        return ZLibraryAcquisitionResult(acquired=acquired, rights_provenance=bound)


def _validation(message: str) -> DiandianError:
    return DiandianError(ErrorCode.VALIDATION, message, retryable=False)
