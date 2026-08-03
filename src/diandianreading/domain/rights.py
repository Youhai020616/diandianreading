"""Auditable rights provenance for governed document acquisition."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import UTC, datetime
from enum import StrEnum
from urllib.parse import urlsplit

from diandianreading.domain.models import StorageKey


class RightsBasis(StrEnum):
    OWNED_COPY = "owned_copy"
    LICENSED = "licensed"
    PUBLIC_DOMAIN = "public_domain"
    OPEN_LICENSE = "open_license"
    EXPLICIT_PERMISSION = "explicit_permission"


@dataclass(frozen=True, slots=True)
class RightsProvenance:
    """One explicit per-item attestation plus its audited acquisition binding."""

    id: str
    provider: str
    source_locator_redacted: str
    rights_basis: RightsBasis
    license_identifier: str | None
    evidence_storage_key: StorageKey | None
    attestation_version: str
    attested_at: datetime
    acquisition_job_id: str | None
    content_sha256: str | None
    supersedes_id: str | None
    updated_at: datetime
    version: int

    def __post_init__(self) -> None:
        required = (
            self.id,
            self.provider,
            self.source_locator_redacted,
            self.attestation_version,
        )
        if any(not value.strip() for value in required):
            raise ValueError(
                "Rights provenance identity, provider, locator, and policy are required"
            )
        if self.version < 0:
            raise ValueError("Rights provenance version cannot be negative")
        if self.supersedes_id == self.id:
            raise ValueError("Rights provenance cannot supersede itself")
        self._validate_locator()
        self._validate_evidence_policy()
        if self.content_sha256 is not None and not _is_sha256(self.content_sha256):
            raise ValueError("Rights provenance content hash must be a SHA-256 digest")
        if self.acquisition_job_id is not None and not self.acquisition_job_id.strip():
            raise ValueError("Rights provenance acquisition Job ID cannot be empty")

    def bind_content(
        self,
        content_sha256: str,
        *,
        acquisition_job_id: str | None = None,
        now: datetime | None = None,
    ) -> RightsProvenance:
        """Bind the attestation to verified bytes using one versioned transition."""

        if not _is_sha256(content_sha256):
            raise ValueError("Rights provenance content hash must be a SHA-256 digest")
        if acquisition_job_id is not None and not acquisition_job_id.strip():
            raise ValueError("Rights provenance acquisition Job ID cannot be empty")
        if self.content_sha256 is not None:
            if self.content_sha256 == content_sha256 and (
                acquisition_job_id is None or self.acquisition_job_id == acquisition_job_id
            ):
                return self
            raise ValueError("Rights provenance is already bound to different content")
        timestamp = now or datetime.now(UTC)
        return replace(
            self,
            content_sha256=content_sha256,
            acquisition_job_id=acquisition_job_id or self.acquisition_job_id,
            updated_at=timestamp,
            version=self.version + 1,
        )

    def bind_acquisition_job(
        self,
        acquisition_job_id: str,
        *,
        now: datetime | None = None,
    ) -> RightsProvenance:
        """Attach the later durable import Job without changing attested rights facts."""

        if not acquisition_job_id.strip():
            raise ValueError("Rights provenance acquisition Job ID cannot be empty")
        if self.acquisition_job_id is not None:
            if self.acquisition_job_id == acquisition_job_id:
                return self
            raise ValueError("Rights provenance is already bound to another acquisition Job")
        return replace(
            self,
            acquisition_job_id=acquisition_job_id,
            updated_at=now or datetime.now(UTC),
            version=self.version + 1,
        )

    def _validate_locator(self) -> None:
        parsed = urlsplit(self.source_locator_redacted)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError(
                "Rights provenance locator must be a redacted HTTPS URL without "
                "credentials or query"
            )

    def _validate_evidence_policy(self) -> None:
        license_identifier = (self.license_identifier or "").strip()
        if (
            self.rights_basis in {RightsBasis.PUBLIC_DOMAIN, RightsBasis.OPEN_LICENSE}
            and not license_identifier
        ):
            raise ValueError("Public-domain and open-license attestations need an identifier")
        if (
            self.rights_basis in {RightsBasis.LICENSED, RightsBasis.EXPLICIT_PERMISSION}
            and self.evidence_storage_key is None
        ):
            raise ValueError("Licensed or explicitly permitted content needs stored evidence")


@dataclass(frozen=True, slots=True)
class RightsProvenanceEvent:
    provenance_id: str
    provider: str
    source_locator_redacted: str
    rights_basis: RightsBasis
    license_identifier: str | None
    evidence_storage_key: StorageKey | None
    attestation_version: str
    attested_at: datetime
    acquisition_job_id: str | None
    content_sha256: str | None
    supersedes_id: str | None
    version: int
    created_at: datetime


def _is_sha256(value: str) -> bool:
    return len(value) == 64 and all(character in "0123456789abcdef" for character in value)
