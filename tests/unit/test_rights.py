from __future__ import annotations

from dataclasses import replace
from datetime import timedelta

import pytest

from diandianreading.domain import RightsBasis, RightsProvenance, StorageKey
from tests.support import FIXED_NOW


def make_rights(**changes: object) -> RightsProvenance:
    values: dict[str, object] = {
        "id": "rights-1",
        "provider": "zlibrary",
        "source_locator_redacted": "https://zlibrary.invalid/book/synthetic-book",
        "rights_basis": RightsBasis.PUBLIC_DOMAIN,
        "license_identifier": "Public Domain Mark 1.0",
        "evidence_storage_key": None,
        "attestation_version": "zlibrary-rights-v1",
        "attested_at": FIXED_NOW,
        "acquisition_job_id": None,
        "content_sha256": None,
        "supersedes_id": None,
        "updated_at": FIXED_NOW,
        "version": 0,
    }
    values.update(changes)
    return RightsProvenance(**values)  # type: ignore[arg-type]


def test_rights_provenance_requires_redacted_https_identity_and_current_policy_fields() -> None:
    for changes in (
        {"id": ""},
        {"provider": " "},
        {"attestation_version": ""},
        {"source_locator_redacted": "http://zlibrary.invalid/book/test"},
        {"source_locator_redacted": "https://user:secret@zlibrary.invalid/book/test"},
        {"source_locator_redacted": "https://zlibrary.invalid/book/test?token=secret"},
        {"source_locator_redacted": "https://zlibrary.invalid/book/test#fragment"},
        {"version": -1},
        {"supersedes_id": "rights-1"},
    ):
        with pytest.raises(ValueError):
            make_rights(**changes)


def test_rights_basis_enforces_evidence_policy() -> None:
    for basis in (RightsBasis.PUBLIC_DOMAIN, RightsBasis.OPEN_LICENSE):
        with pytest.raises(ValueError, match="identifier"):
            make_rights(rights_basis=basis, license_identifier=None)

    for basis in (RightsBasis.LICENSED, RightsBasis.EXPLICIT_PERMISSION):
        with pytest.raises(ValueError, match="stored evidence"):
            make_rights(rights_basis=basis, license_identifier=None)
        assert (
            make_rights(
                rights_basis=basis,
                license_identifier=None,
                evidence_storage_key=StorageKey("originals/rights-evidence"),
            ).rights_basis
            is basis
        )

    assert (
        make_rights(
            rights_basis=RightsBasis.OWNED_COPY,
            license_identifier=None,
        ).rights_basis
        is RightsBasis.OWNED_COPY
    )


def test_rights_provenance_binds_verified_content_once_and_is_idempotent() -> None:
    bound_at = FIXED_NOW + timedelta(seconds=1)
    digest = "a" * 64
    provenance = make_rights()

    bound = provenance.bind_content(digest, acquisition_job_id="job-1", now=bound_at)

    assert bound.content_sha256 == digest
    assert bound.acquisition_job_id == "job-1"
    assert bound.updated_at == bound_at
    assert bound.version == 1
    assert bound.bind_content(digest) is bound
    with pytest.raises(ValueError, match="different content"):
        bound.bind_content("b" * 64)
    with pytest.raises(ValueError, match="SHA-256"):
        provenance.bind_content("not-a-digest")


def test_rights_provenance_can_bind_later_job_without_mutating_attested_facts() -> None:
    provenance = make_rights().bind_content("a" * 64, now=FIXED_NOW + timedelta(seconds=1))
    bound = provenance.bind_acquisition_job("job-1", now=FIXED_NOW + timedelta(seconds=2))

    assert bound.acquisition_job_id == "job-1"
    assert bound.version == 2
    assert replace(bound, acquisition_job_id=None, version=provenance.version) != provenance
    assert bound.bind_acquisition_job("job-1") is bound
    with pytest.raises(ValueError, match="another acquisition Job"):
        bound.bind_acquisition_job("job-2")
