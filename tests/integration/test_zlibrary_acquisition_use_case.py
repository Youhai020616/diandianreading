from __future__ import annotations

import asyncio
from dataclasses import replace

import pytest

from diandianreading.application.ports import AcquiredAsset, AcquisitionRequest, ProgressSink
from diandianreading.application.use_cases import (
    ZLIBRARY_RIGHTS_POLICY_VERSION,
    ZLibraryAcquisitionCommand,
    ZLibraryAcquisitionUseCase,
)
from diandianreading.domain import (
    CredentialRef,
    DiandianError,
    DocumentAsset,
    ErrorCode,
    RightsBasis,
    SourceOrigin,
    StorageKey,
)
from diandianreading.infrastructure.persistence import (
    SQLiteDatabase,
    SQLiteRightsProvenanceRepository,
    SQLiteUnitOfWorkFactory,
)
from tests.support import FIXED_NOW, RecordingProgressSink, SequentialIds


class RecordingZLibraryAcquirer:
    provider = "zlibrary"

    def __init__(self, repository: SQLiteRightsProvenanceRepository) -> None:
        self.repository = repository
        self.requests: list[AcquisitionRequest] = []
        self.fail = False
        self.asset_transform = lambda asset: asset

    def canonicalize_location(self, location: str) -> str:
        assert location
        return "https://zlibrary.invalid/book/synthetic-book"

    def redact_location(self, location: str) -> str:
        assert location == "https://zlibrary.invalid/book/synthetic-book"
        return location

    async def acquire(
        self,
        request: AcquisitionRequest,
        progress: ProgressSink,
    ) -> AcquiredAsset:
        del progress
        self.requests.append(request)
        rights_id = request.options["rights_provenance_id"]
        persisted = self.repository.get(rights_id)
        assert persisted is not None
        assert persisted.content_sha256 is None
        if self.fail:
            raise DiandianError(
                ErrorCode.SOURCE_UNAVAILABLE,
                "Synthetic provider unavailable",
                retryable=True,
            )
        asset = DocumentAsset(
            id="asset-zlibrary",
            storage_key=StorageKey("originals/" + "a" * 64),
            display_filename="synthetic.pdf",
            mime_type="application/pdf",
            size_bytes=16,
            sha256="a" * 64,
            title="Synthetic Book",
            author=None,
            origin=SourceOrigin.ZLIBRARY,
            origin_locator=request.options["source_locator_redacted"],
            rights_provenance_id=rights_id,
        )
        return AcquiredAsset(asset=self.asset_transform(asset), temporary_key=None)


def make_runtime(tmp_path, *, enabled: bool = True):
    database = SQLiteDatabase(tmp_path / "state" / "app.sqlite3")
    database.migrate()
    repository = SQLiteRightsProvenanceRepository(database)
    adapter = RecordingZLibraryAcquirer(repository)
    use_case = ZLibraryAcquisitionUseCase(
        unit_of_work=SQLiteUnitOfWorkFactory(database),
        acquirer=adapter,
        enabled=enabled,
        id_factory=SequentialIds("rights-1"),
        clock=lambda: FIXED_NOW,
    )
    return repository, adapter, use_case


def make_command(**changes: object) -> ZLibraryAcquisitionCommand:
    values: dict[str, object] = {
        "location": "https://zlibrary.invalid/book/synthetic-book?tracking=removed",
        "credential": CredentialRef("zlibrary", "test-profile"),
        "rights_basis": RightsBasis.PUBLIC_DOMAIN,
        "license_identifier": "Public Domain Mark 1.0",
        "evidence_storage_key": None,
        "attestation_version": ZLIBRARY_RIGHTS_POLICY_VERSION,
        "rights_confirmed": True,
        "options": {"title": "Synthetic Book"},
    }
    values.update(changes)
    return ZLibraryAcquisitionCommand(**values)  # type: ignore[arg-type]


def test_command_and_use_case_configuration_require_nonempty_policy_inputs(tmp_path) -> None:
    with pytest.raises(ValueError, match="source location"):
        make_command(location=" ")
    with pytest.raises(ValueError, match="policy version"):
        make_command(attestation_version=" ")

    _repository, adapter, _use_case = make_runtime(tmp_path)
    with pytest.raises(ValueError, match="Current rights"):
        ZLibraryAcquisitionUseCase(
            unit_of_work=lambda: None,  # type: ignore[arg-type, return-value]
            acquirer=adapter,
            current_attestation_version=" ",
        )


def test_application_rejects_misconfigured_provider_adapter_before_persistence(tmp_path) -> None:
    repository, adapter, use_case = make_runtime(tmp_path)
    adapter.provider = "other"

    with pytest.raises(DiandianError, match="not Z-Library"):
        asyncio.run(use_case.execute(make_command()))

    assert repository.get("rights-1") is None
    assert adapter.requests == []


def test_application_persists_rights_before_adapter_and_binds_verified_content(tmp_path) -> None:
    repository, adapter, use_case = make_runtime(tmp_path)
    progress = RecordingProgressSink([])

    result = asyncio.run(use_case.execute(make_command(), progress))

    assert len(adapter.requests) == 1
    request = adapter.requests[0]
    assert request.location == "https://zlibrary.invalid/book/synthetic-book"
    assert request.credential == CredentialRef("zlibrary", "test-profile")
    assert request.rights_confirmed is True
    assert request.options["rights_provenance_id"] == "rights-1"
    assert result.rights_provenance.content_sha256 == "a" * 64
    assert repository.get("rights-1") == result.rights_provenance
    assert [event.version for event in repository.list_events("rights-1")] == [0, 1]


@pytest.mark.parametrize(
    ("enabled", "changes", "message"),
    [
        (False, {}, "disabled"),
        (True, {"rights_confirmed": False}, "explicit per-item"),
        (True, {"attestation_version": "obsolete"}, "out of date"),
        (True, {"credential": CredentialRef("other", "profile")}, "credential profile"),
    ],
)
def test_application_rejects_before_adapter_when_gate_is_not_satisfied(
    tmp_path,
    enabled: bool,
    changes: dict[str, object],
    message: str,
) -> None:
    repository, adapter, use_case = make_runtime(tmp_path, enabled=enabled)

    with pytest.raises(DiandianError, match=message):
        asyncio.run(use_case.execute(make_command(**changes)))

    assert adapter.requests == []
    assert repository.get("rights-1") is None


def test_adapter_failure_leaves_unbound_audit_record(tmp_path) -> None:
    repository, adapter, use_case = make_runtime(tmp_path)
    adapter.fail = True

    with pytest.raises(DiandianError) as raised:
        asyncio.run(use_case.execute(make_command()))

    assert raised.value.code is ErrorCode.SOURCE_UNAVAILABLE
    persisted = repository.get("rights-1")
    assert persisted is not None
    assert persisted.content_sha256 is None
    assert len(repository.list_events("rights-1")) == 1


@pytest.mark.parametrize(
    "transform",
    [
        lambda asset: replace(asset, origin=SourceOrigin.LOCAL),
        lambda asset: replace(asset, origin_locator="https://zlibrary.invalid/book/other"),
        lambda asset: replace(asset, rights_provenance_id="rights-other"),
    ],
)
def test_application_rejects_mismatched_adapter_output(tmp_path, transform) -> None:
    repository, adapter, use_case = make_runtime(tmp_path)
    adapter.asset_transform = transform

    with pytest.raises(DiandianError, match="returned an asset"):
        asyncio.run(use_case.execute(make_command()))

    persisted = repository.get("rights-1")
    assert persisted is not None
    assert persisted.content_sha256 is None
