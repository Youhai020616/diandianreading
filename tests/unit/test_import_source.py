from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Generic, TypeVar, cast

import pytest

from diandianreading.application.ports import AcquiredAsset, AcquisitionRequest, ProgressSink
from diandianreading.application.use_cases.import_source import (
    IMPORT_SOURCE_PAYLOAD_TYPE,
    ImportSourceCommand,
    ImportSubmissionUseCase,
    deserialize_import_source_command,
    serialize_import_source_command,
)
from diandianreading.domain import (
    CredentialRef,
    DiandianError,
    DocumentAsset,
    ErrorCode,
    Job,
    JobPayload,
    RightsBasis,
    RightsProvenance,
    SourceOrigin,
    StorageKey,
    TargetCapabilities,
)
from tests.support import FIXED_NOW, SequentialIds

T = TypeVar("T")


@dataclass(slots=True)
class SubmissionState:
    jobs: list[Job] = field(default_factory=list)
    payloads: list[JobPayload] = field(default_factory=list)
    rights: list[RightsProvenance] = field(default_factory=list)


class AddRepository(Generic[T]):
    def __init__(self, target: list[T]) -> None:
        self.target = target

    def add(self, value: T) -> None:
        self.target.append(value)


class SubmissionUnitOfWork:
    def __init__(self, state: SubmissionState) -> None:
        self.jobs = AddRepository(state.jobs)
        self.job_payloads = AddRepository(state.payloads)
        self.rights = AddRepository(state.rights)
        self.committed = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        del exc_type, exc_value, traceback

    def commit(self) -> None:
        self.committed = True


class SubmissionFactory:
    def __init__(self, state: SubmissionState) -> None:
        self.state = state

    def __call__(self):
        return SubmissionUnitOfWork(self.state)


class RecordingLocalAcquirer:
    def __init__(
        self,
        *,
        temporary_key: StorageKey | None = None,
        failure: Exception | None = None,
        asset_transform: Callable[[DocumentAsset], DocumentAsset] | None = None,
    ) -> None:
        self.temporary_key = temporary_key
        self.failure = failure
        self.asset_transform: Callable[[DocumentAsset], DocumentAsset] = (
            asset_transform if asset_transform is not None else lambda asset: asset
        )
        self.requests: list[AcquisitionRequest] = []

    async def acquire(
        self,
        request: AcquisitionRequest,
        progress: ProgressSink,
    ) -> AcquiredAsset:
        del progress
        self.requests.append(request)
        if self.failure is not None:
            raise self.failure
        sha256 = "a" * 64
        display_filename = request.options.get("display_filename") or Path(request.location).name
        asset = DocumentAsset(
            id="asset-local",
            storage_key=StorageKey(f"originals/{sha256}"),
            display_filename=display_filename,
            mime_type="text/markdown",
            size_bytes=12,
            sha256=sha256,
            title="Captured title",
            author=None,
            origin=SourceOrigin.LOCAL,
            origin_locator=None,
            rights_provenance_id=request.options["rights_provenance_id"],
        )
        return AcquiredAsset(
            asset=self.asset_transform(asset),
            temporary_key=self.temporary_key,
        )


class RecordingZLibraryAcquirer:
    def __init__(
        self,
        *,
        provider: str = "zlibrary",
        canonical_url: str = "https://zlibrary.invalid/book/canonical",
        redacted_url: str | None = None,
    ) -> None:
        self.provider = provider
        self.canonical_url = canonical_url
        self.redacted_url = redacted_url or canonical_url
        self.canonicalize_calls = 0
        self.redact_calls = 0
        self.acquire_calls = 0
        self.locations: list[str] = []

    def canonicalize_location(self, location: str) -> str:
        self.canonicalize_calls += 1
        self.locations.append(location)
        assert location
        return self.canonical_url

    def redact_location(self, location: str) -> str:
        self.redact_calls += 1
        assert location == self.canonical_url
        return self.redacted_url

    async def acquire(
        self,
        request: AcquisitionRequest,
        progress: ProgressSink,
    ) -> AcquiredAsset:
        del request, progress
        self.acquire_calls += 1
        raise AssertionError("submission must not acquire Z-Library content")


def capabilities() -> TargetCapabilities:
    return TargetCapabilities(
        max_source_words=1_000,
        max_source_bytes=1_000_000,
        max_sources_per_workspace=10,
        accepted_mime_types=frozenset({"text/markdown"}),
    )


def valid_local_command() -> ImportSourceCommand:
    sha256 = "a" * 64
    return ImportSourceCommand(
        provider=SourceOrigin.LOCAL,
        target_credential=CredentialRef("notebooklm", "target-profile"),
        rights_provenance_id="rights-1",
        title="Captured title",
        author=None,
        target_capabilities=capabilities(),
        captured_asset=DocumentAsset(
            id="asset-local",
            storage_key=StorageKey(f"originals/{sha256}"),
            display_filename="book.md",
            mime_type="text/markdown",
            size_bytes=12,
            sha256=sha256,
            title="Captured title",
            author=None,
            origin=SourceOrigin.LOCAL,
            origin_locator=None,
            rights_provenance_id="rights-1",
        ),
    )


def valid_zlibrary_command() -> ImportSourceCommand:
    return ImportSourceCommand(
        provider=SourceOrigin.ZLIBRARY,
        source_url="https://zlibrary.invalid/book/canonical",
        acquisition_credential=CredentialRef("zlibrary", "acquisition-profile"),
        target_credential=CredentialRef("notebooklm", "target-profile"),
        rights_provenance_id="rights-1",
        title="Governed Book",
        author=None,
        target_capabilities=capabilities(),
    )


def canonical_json(payload: object) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def make_use_case(
    state: SubmissionState,
    *,
    local: RecordingLocalAcquirer | None = None,
    zlibrary: RecordingZLibraryAcquirer | None = None,
):
    local = local or RecordingLocalAcquirer()
    zlibrary = zlibrary or RecordingZLibraryAcquirer()
    use_case = ImportSubmissionUseCase(
        unit_of_work=cast(Any, SubmissionFactory(state)),
        local_acquirer=local,
        zlibrary_acquirer=zlibrary,
        id_factory=SequentialIds("job-1", "rights-1"),
        clock=lambda: FIXED_NOW,
    )
    return use_case, local, zlibrary


def test_local_submission_captures_before_acceptance_without_persisting_physical_path() -> None:
    state = SubmissionState()
    use_case, local, _zlibrary = make_use_case(state)
    physical_path = "/Users/example/private/library/secret-book.md"

    job = asyncio.run(
        use_case.submit_local(
            physical_path,
            rights_basis=RightsBasis.OWNED_COPY,
            license_identifier=None,
            evidence_storage_key=None,
            rights_confirmed=True,
            target_credential=CredentialRef("notebooklm", "target-profile"),
            target_capabilities=capabilities(),
            title="Durable Book",
            author="Author",
        )
    )

    assert job.id == "job-1" and job.book_id is None
    assert local.requests[0].location == physical_path
    payload = state.payloads[0]
    assert payload.payload_type == IMPORT_SOURCE_PAYLOAD_TYPE
    assert physical_path not in payload.payload_json
    assert "/Users/example/private" not in payload.payload_json
    command = deserialize_import_source_command(payload.payload_json)
    assert command.captured_asset is not None
    assert command.captured_asset.display_filename == "secret-book.md"
    provenance = state.rights[0]
    assert provenance.acquisition_job_id == job.id
    assert provenance.content_sha256 == "a" * 64
    assert provenance.source_locator_redacted == "https://local.invalid/import/rights-1"


def test_zlibrary_submission_persists_only_canonical_references_without_acquiring() -> None:
    state = SubmissionState()
    use_case, _local, zlibrary = make_use_case(state)

    job = use_case.submit_zlibrary(
        "https://zlibrary.invalid/book/raw?tracking=secret",
        acquisition_credential=CredentialRef("zlibrary", "acquisition-profile"),
        target_credential=CredentialRef("notebooklm", "target-profile"),
        rights_basis=RightsBasis.PUBLIC_DOMAIN,
        license_identifier="Public Domain Mark 1.0",
        evidence_storage_key=None,
        attestation_version="zlibrary-rights-v1",
        rights_confirmed=True,
        target_capabilities=capabilities(),
        title="Governed Book",
    )

    assert job.book_id is None
    assert zlibrary.canonicalize_calls == 1
    assert zlibrary.acquire_calls == 0
    command = deserialize_import_source_command(state.payloads[0].payload_json)
    assert command.source_url == "https://zlibrary.invalid/book/canonical"
    assert command.acquisition_credential == CredentialRef("zlibrary", "acquisition-profile")
    provenance = state.rights[0]
    assert provenance.acquisition_job_id == job.id
    assert provenance.content_sha256 is None


def test_zlibrary_policy_is_enforced_before_any_adapter_method() -> None:
    state = SubmissionState()
    use_case, _local, zlibrary = make_use_case(state)

    with pytest.raises(DiandianError, match="out of date"):
        use_case.submit_zlibrary(
            "https://zlibrary.invalid/book/raw",
            acquisition_credential=CredentialRef("zlibrary", "acquisition-profile"),
            target_credential=CredentialRef("notebooklm", "target-profile"),
            rights_basis=RightsBasis.PUBLIC_DOMAIN,
            license_identifier="Public Domain Mark 1.0",
            evidence_storage_key=None,
            attestation_version="obsolete",
            rights_confirmed=True,
            target_capabilities=capabilities(),
            title="Governed Book",
        )

    assert zlibrary.canonicalize_calls == 0
    assert zlibrary.acquire_calls == 0
    assert state.jobs == [] and state.rights == []


def test_import_source_serialization_is_canonical_and_deserialization_fails_closed() -> None:
    command = ImportSourceCommand(
        provider=SourceOrigin.ZLIBRARY,
        source_url="https://zlibrary.invalid/book/canonical",
        acquisition_credential=CredentialRef("zlibrary", "acquisition-profile"),
        target_credential=CredentialRef("notebooklm", "target-profile"),
        rights_provenance_id="rights-1",
        title="Book",
        author=None,
        target_capabilities=capabilities(),
    )
    payload_json = serialize_import_source_command(command)
    assert deserialize_import_source_command(payload_json) == command

    noncanonical = json.dumps(json.loads(payload_json), indent=2)
    with pytest.raises(DiandianError, match="invalid or non-canonical"):
        deserialize_import_source_command(noncanonical)

    tampered = json.loads(payload_json)
    tampered["physical_path"] = "/private/book.pdf"
    with pytest.raises(DiandianError, match="invalid or non-canonical"):
        deserialize_import_source_command(
            json.dumps(tampered, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        )


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        pytest.param(
            {"target_credential": CredentialRef("zlibrary", "target-profile")},
            "NotebookLM",
            id="target-provider",
        ),
        pytest.param({"rights_provenance_id": "  "}, "provenance ID", id="rights-id"),
        pytest.param({"title": "\t"}, "title", id="title"),
        pytest.param({"author": "  "}, "author", id="author"),
    ],
)
def test_import_source_command_rejects_invalid_common_fields(
    changes: dict[str, object],
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        replace(valid_local_command(), **changes)


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        pytest.param(
            {"source_url": "https://local.invalid/source"},
            "source URL or credential",
            id="source-url",
        ),
        pytest.param(
            {"acquisition_credential": CredentialRef("zlibrary", "acquisition")},
            "source URL or credential",
            id="acquisition-credential",
        ),
        pytest.param({"captured_asset": None}, "captured DocumentAsset", id="missing-asset"),
    ],
)
def test_import_source_command_enforces_local_payload_shape(
    changes: dict[str, object],
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        replace(valid_local_command(), **changes)


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        pytest.param(
            {"captured_asset": valid_local_command().captured_asset},
            "cannot contain a captured",
            id="captured-asset",
        ),
        pytest.param({"source_url": None}, "canonical source URL", id="missing-source-url"),
        pytest.param(
            {"acquisition_credential": None},
            "Z-Library credential",
            id="missing-acquisition-credential",
        ),
        pytest.param(
            {"acquisition_credential": CredentialRef("notebooklm", "acquisition")},
            "Z-Library credential",
            id="wrong-acquisition-provider",
        ),
    ],
)
def test_import_source_command_enforces_zlibrary_payload_shape(
    changes: dict[str, object],
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        replace(valid_zlibrary_command(), **changes)


@pytest.mark.parametrize(
    "source_url",
    [
        pytest.param("http://zlibrary.invalid/book/1", id="not-https"),
        pytest.param("https://user:password@zlibrary.invalid/book/1", id="userinfo"),
        pytest.param("https://zlibrary.invalid/book/1?token=secret", id="query"),
        pytest.param("https://zlibrary.invalid/book/1#secret", id="fragment"),
    ],
)
def test_import_source_command_rejects_noncanonical_zlibrary_urls(source_url: str) -> None:
    with pytest.raises(DiandianError, match="canonical, queryless, and credential-free") as raised:
        replace(valid_zlibrary_command(), source_url=source_url)
    assert raised.value.code is ErrorCode.VALIDATION


def test_import_source_command_rejects_unsupported_provider() -> None:
    with pytest.raises(ValueError, match="provider is unsupported"):
        replace(valid_local_command(), provider="web")  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "asset_changes",
    [
        pytest.param({"origin": SourceOrigin.ZLIBRARY}, id="origin"),
        pytest.param({"display_filename": "../book.md"}, id="forward-slash"),
        pytest.param({"display_filename": "folder\\book.md"}, id="backslash"),
        pytest.param(
            {"origin_locator": "https://local.invalid/book"},
            id="origin-locator",
        ),
        pytest.param({"rights_provenance_id": "rights-other"}, id="rights"),
        pytest.param({"title": "Other title"}, id="title"),
        pytest.param({"author": "Other author"}, id="author"),
        pytest.param({"derived_from_asset_id": "asset-parent"}, id="derived-asset"),
    ],
)
def test_import_source_command_rejects_mismatched_local_asset_metadata(
    asset_changes: dict[str, object],
) -> None:
    command = valid_local_command()
    assert command.captured_asset is not None
    mismatched = replace(command.captured_asset, **asset_changes)

    with pytest.raises(ValueError, match="metadata does not match"):
        replace(command, captured_asset=mismatched)


def test_import_source_serialization_preserves_unicode_and_sorted_sets_canonically() -> None:
    command = replace(
        valid_zlibrary_command(),
        title="点点阅读",
        author="测试作者",
        target_capabilities=TargetCapabilities(
            max_source_words=1_000,
            max_source_bytes=1_000_000,
            max_sources_per_workspace=10,
            accepted_mime_types=frozenset({"text/markdown", "application/pdf"}),
        ),
    )

    payload_json = serialize_import_source_command(command)
    payload = json.loads(payload_json)

    assert payload_json == canonical_json(payload)
    assert "点点阅读" in payload_json and "\\u" not in payload_json
    assert payload["target_capabilities"]["accepted_mime_types"] == [
        "application/pdf",
        "text/markdown",
    ]
    assert deserialize_import_source_command(payload_json) == command


@pytest.mark.parametrize(
    "payload_json",
    [
        pytest.param("{", id="invalid-json"),
        pytest.param("null", id="null"),
        pytest.param("[]", id="array"),
        pytest.param('"payload"', id="string"),
    ],
)
def test_import_source_deserialization_rejects_malformed_json(payload_json: str) -> None:
    with pytest.raises(DiandianError, match="invalid or non-canonical") as raised:
        deserialize_import_source_command(payload_json)
    assert raised.value.code is ErrorCode.REPOSITORY_CONFLICT


@pytest.mark.parametrize(
    ("section", "field", "value"),
    [
        pytest.param(
            "target_capabilities",
            "accepted_mime_types",
            "text/markdown",
            id="mime-types-not-list",
        ),
        pytest.param(
            "target_capabilities",
            "accepted_mime_types",
            ["text/markdown", ""],
            id="empty-mime-type",
        ),
        pytest.param(
            "target_capabilities",
            "max_source_bytes",
            True,
            id="boolean-limit",
        ),
        pytest.param("target_credential", "profile", "../credentials.json", id="target-profile"),
        pytest.param(
            "acquisition_credential",
            "provider",
            "notebooklm",
            id="acquisition-provider",
        ),
        pytest.param("root", "title", " ", id="blank-title"),
    ],
)
def test_import_source_deserialization_rejects_canonical_but_invalid_fields(
    section: str,
    field: str,
    value: object,
) -> None:
    payload = json.loads(serialize_import_source_command(valid_zlibrary_command()))
    target = payload if section == "root" else payload[section]
    assert isinstance(target, dict)
    target[field] = value

    with pytest.raises(DiandianError, match="invalid or non-canonical") as raised:
        deserialize_import_source_command(canonical_json(payload))
    assert raised.value.code is ErrorCode.REPOSITORY_CONFLICT


def test_import_source_deserialization_preserves_typed_url_validation() -> None:
    payload = json.loads(serialize_import_source_command(valid_zlibrary_command()))
    payload["source_url"] = "https://zlibrary.invalid/book?token=secret"

    with pytest.raises(DiandianError, match="canonical, queryless, and credential-free") as raised:
        deserialize_import_source_command(canonical_json(payload))
    assert raised.value.code is ErrorCode.VALIDATION


@pytest.mark.parametrize(
    "mime_types",
    [
        pytest.param(["text/markdown", "application/pdf"], id="unsorted"),
        pytest.param(["application/pdf", "application/pdf"], id="duplicate"),
    ],
)
def test_import_source_deserialization_rejects_semantically_noncanonical_arrays(
    mime_types: list[str],
) -> None:
    command = replace(
        valid_zlibrary_command(),
        target_capabilities=TargetCapabilities(
            max_source_words=1_000,
            max_source_bytes=1_000_000,
            max_sources_per_workspace=10,
            accepted_mime_types=frozenset({"application/pdf", "text/markdown"}),
        ),
    )
    payload = json.loads(serialize_import_source_command(command))
    payload["target_capabilities"]["accepted_mime_types"] = mime_types

    with pytest.raises(DiandianError, match="invalid or non-canonical"):
        deserialize_import_source_command(canonical_json(payload))


def test_import_source_deserialization_rejects_missing_required_field() -> None:
    payload = json.loads(serialize_import_source_command(valid_zlibrary_command()))
    del payload["author"]

    with pytest.raises(DiandianError, match="invalid or non-canonical"):
        deserialize_import_source_command(canonical_json(payload))


@pytest.mark.parametrize(
    ("rights_confirmed", "target_credential", "message"),
    [
        pytest.param(
            False,
            CredentialRef("notebooklm", "target-profile"),
            "rights confirmation",
            id="unconfirmed-rights",
        ),
        pytest.param(
            True,
            CredentialRef("zlibrary", "target-profile"),
            "NotebookLM",
            id="wrong-target-provider",
        ),
    ],
)
def test_local_submission_rejects_policy_inputs_before_acquisition(
    rights_confirmed: bool,
    target_credential: CredentialRef,
    message: str,
) -> None:
    state = SubmissionState()
    use_case, local, _zlibrary = make_use_case(state)

    with pytest.raises(DiandianError, match=message) as raised:
        asyncio.run(
            use_case.submit_local(
                "/private/book.md",
                rights_basis=RightsBasis.OWNED_COPY,
                license_identifier=None,
                evidence_storage_key=None,
                rights_confirmed=rights_confirmed,
                target_credential=target_credential,
                target_capabilities=capabilities(),
            )
        )

    assert raised.value.code is ErrorCode.VALIDATION
    assert local.requests == []
    assert state.jobs == [] and state.payloads == [] and state.rights == []


@pytest.mark.parametrize(
    ("rights_basis", "license_identifier", "evidence_storage_key"),
    [
        pytest.param(RightsBasis.PUBLIC_DOMAIN, None, None, id="public-domain-license"),
        pytest.param(RightsBasis.OPEN_LICENSE, "  ", None, id="open-license-identifier"),
        pytest.param(RightsBasis.LICENSED, "commercial", None, id="licensed-evidence"),
        pytest.param(
            RightsBasis.EXPLICIT_PERMISSION,
            None,
            None,
            id="permission-evidence",
        ),
    ],
)
def test_local_submission_rejects_invalid_rights_evidence_without_accepting_job(
    rights_basis: RightsBasis,
    license_identifier: str | None,
    evidence_storage_key: StorageKey | None,
) -> None:
    state = SubmissionState()
    use_case, local, _zlibrary = make_use_case(state)

    with pytest.raises(DiandianError, match="current evidence policy") as raised:
        asyncio.run(
            use_case.submit_local(
                "/private/book.md",
                rights_basis=rights_basis,
                license_identifier=license_identifier,
                evidence_storage_key=evidence_storage_key,
                rights_confirmed=True,
                target_credential=CredentialRef("notebooklm", "target-profile"),
                target_capabilities=capabilities(),
            )
        )

    assert raised.value.code is ErrorCode.VALIDATION
    assert local.requests == []
    assert state.jobs == [] and state.payloads == [] and state.rights == []


def test_local_submission_persists_safe_display_filename_override_only() -> None:
    state = SubmissionState()
    use_case, local, _zlibrary = make_use_case(state)
    physical_path = "/Users/example/private/original-name.md"

    asyncio.run(
        use_case.submit_local(
            physical_path,
            rights_basis=RightsBasis.OWNED_COPY,
            license_identifier=None,
            evidence_storage_key=None,
            rights_confirmed=True,
            target_credential=CredentialRef("notebooklm", "target-profile"),
            target_capabilities=capabilities(),
            title="Renamed Book",
            display_filename="shareable-name.md",
        )
    )

    assert local.requests[0].options["display_filename"] == "shareable-name.md"
    payload_json = state.payloads[0].payload_json
    command = deserialize_import_source_command(payload_json)
    assert command.captured_asset is not None
    assert command.captured_asset.display_filename == "shareable-name.md"
    assert physical_path not in payload_json
    assert "/Users/example/private" not in payload_json


@pytest.mark.parametrize("display_filename", ["../book.md", "folder\\book.md"])
def test_local_submission_rejects_path_like_display_filename_override(
    display_filename: str,
) -> None:
    state = SubmissionState()
    use_case, local, _zlibrary = make_use_case(state)

    with pytest.raises(ValueError, match="metadata does not match"):
        asyncio.run(
            use_case.submit_local(
                "/private/book.md",
                rights_basis=RightsBasis.OWNED_COPY,
                license_identifier=None,
                evidence_storage_key=None,
                rights_confirmed=True,
                target_credential=CredentialRef("notebooklm", "target-profile"),
                target_capabilities=capabilities(),
                title="Captured title",
                display_filename=display_filename,
            )
        )

    assert len(local.requests) == 1
    assert state.jobs == [] and state.payloads == [] and state.rights == []


def test_local_submission_propagates_acquisition_failure_without_durable_state() -> None:
    state = SubmissionState()
    failure = DiandianError(
        ErrorCode.SOURCE_UNAVAILABLE,
        "Local source disappeared",
        retryable=False,
    )
    local = RecordingLocalAcquirer(failure=failure)
    use_case, _local, _zlibrary = make_use_case(state, local=local)

    with pytest.raises(DiandianError, match="source disappeared") as raised:
        asyncio.run(
            use_case.submit_local(
                "/private/missing.md",
                rights_basis=RightsBasis.OWNED_COPY,
                license_identifier=None,
                evidence_storage_key=None,
                rights_confirmed=True,
                target_credential=CredentialRef("notebooklm", "target-profile"),
                target_capabilities=capabilities(),
            )
        )

    assert raised.value is failure
    assert len(local.requests) == 1
    assert state.jobs == [] and state.payloads == [] and state.rights == []


def test_local_submission_rejects_temporary_acquisition_without_durable_state() -> None:
    state = SubmissionState()
    local = RecordingLocalAcquirer(temporary_key=StorageKey("temporary/local-capture"))
    use_case, _local, _zlibrary = make_use_case(state, local=local)

    with pytest.raises(DiandianError, match="did not publish a durable") as raised:
        asyncio.run(
            use_case.submit_local(
                "/private/book.md",
                rights_basis=RightsBasis.OWNED_COPY,
                license_identifier=None,
                evidence_storage_key=None,
                rights_confirmed=True,
                target_credential=CredentialRef("notebooklm", "target-profile"),
                target_capabilities=capabilities(),
            )
        )

    assert raised.value.code is ErrorCode.VALIDATION
    assert state.jobs == [] and state.payloads == [] and state.rights == []


def test_local_submission_uses_captured_metadata_when_overrides_are_absent() -> None:
    state = SubmissionState()
    local = RecordingLocalAcquirer(
        asset_transform=lambda asset: replace(
            asset,
            display_filename="fallback-title.md",
            title=None,
            author="Captured Author",
        )
    )
    use_case, _local, _zlibrary = make_use_case(state, local=local)

    asyncio.run(
        use_case.submit_local(
            "/private/book.md",
            rights_basis=RightsBasis.OWNED_COPY,
            license_identifier=None,
            evidence_storage_key=None,
            rights_confirmed=True,
            target_credential=CredentialRef("notebooklm", "target-profile"),
            target_capabilities=capabilities(),
        )
    )

    command = deserialize_import_source_command(state.payloads[0].payload_json)
    assert command.title == "fallback-title"
    assert command.author == "Captured Author"
    assert command.captured_asset is not None
    assert command.captured_asset.title == command.title
    assert command.captured_asset.author == command.author


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        pytest.param({"location": "  "}, "location is required", id="location"),
        pytest.param({"rights_confirmed": False}, "rights confirmation", id="confirmation"),
        pytest.param(
            {"acquisition_credential": CredentialRef("notebooklm", "acquisition")},
            "Z-Library credential",
            id="acquisition-provider",
        ),
        pytest.param(
            {"target_credential": CredentialRef("zlibrary", "target")},
            "NotebookLM",
            id="target-provider",
        ),
        pytest.param({"title": " \t\n"}, "title cannot be empty", id="title"),
    ],
)
def test_zlibrary_submission_rejects_invalid_inputs_before_adapter_calls(
    overrides: dict[str, object],
    message: str,
) -> None:
    state = SubmissionState()
    use_case, _local, zlibrary = make_use_case(state)
    values: dict[str, Any] = {
        "location": "https://zlibrary.invalid/book/raw",
        "acquisition_credential": CredentialRef("zlibrary", "acquisition"),
        "target_credential": CredentialRef("notebooklm", "target"),
        "rights_basis": RightsBasis.PUBLIC_DOMAIN,
        "license_identifier": "Public Domain Mark 1.0",
        "evidence_storage_key": None,
        "attestation_version": "zlibrary-rights-v1",
        "rights_confirmed": True,
        "target_capabilities": capabilities(),
        "title": "Governed Book",
    }
    values.update(overrides)
    location = values.pop("location")
    assert isinstance(location, str)

    with pytest.raises(DiandianError, match=message) as raised:
        use_case.submit_zlibrary(location, **values)

    assert raised.value.code is ErrorCode.VALIDATION
    assert zlibrary.canonicalize_calls == 0
    assert zlibrary.acquire_calls == 0
    assert state.jobs == [] and state.payloads == [] and state.rights == []


def test_zlibrary_submission_rejects_misconfigured_adapter_before_calls() -> None:
    state = SubmissionState()
    zlibrary = RecordingZLibraryAcquirer(provider="mirror")
    use_case, _local, _zlibrary = make_use_case(state, zlibrary=zlibrary)

    with pytest.raises(DiandianError, match="not Z-Library"):
        use_case.submit_zlibrary(
            "https://zlibrary.invalid/book/raw",
            acquisition_credential=CredentialRef("zlibrary", "acquisition"),
            target_credential=CredentialRef("notebooklm", "target"),
            rights_basis=RightsBasis.PUBLIC_DOMAIN,
            license_identifier="Public Domain Mark 1.0",
            evidence_storage_key=None,
            attestation_version="zlibrary-rights-v1",
            rights_confirmed=True,
            target_capabilities=capabilities(),
            title="Governed Book",
        )

    assert zlibrary.canonicalize_calls == 0
    assert zlibrary.acquire_calls == 0
    assert state.jobs == [] and state.rights == []


@pytest.mark.parametrize(
    ("rights_basis", "license_identifier", "evidence_storage_key", "message"),
    [
        pytest.param(
            RightsBasis.PUBLIC_DOMAIN,
            None,
            None,
            "need an identifier",
            id="public-domain-license",
        ),
        pytest.param(
            RightsBasis.OPEN_LICENSE,
            "  ",
            None,
            "need an identifier",
            id="open-license-identifier",
        ),
        pytest.param(
            RightsBasis.LICENSED,
            "commercial",
            None,
            "need stored evidence",
            id="licensed-evidence",
        ),
        pytest.param(
            RightsBasis.EXPLICIT_PERMISSION,
            None,
            None,
            "need stored evidence",
            id="permission-evidence",
        ),
    ],
)
def test_zlibrary_submission_enforces_rights_evidence_before_adapter_calls(
    rights_basis: RightsBasis,
    license_identifier: str | None,
    evidence_storage_key: StorageKey | None,
    message: str,
) -> None:
    state = SubmissionState()
    use_case, _local, zlibrary = make_use_case(state)

    with pytest.raises(DiandianError, match=message) as raised:
        use_case.submit_zlibrary(
            "https://zlibrary.invalid/book/raw",
            acquisition_credential=CredentialRef("zlibrary", "acquisition"),
            target_credential=CredentialRef("notebooklm", "target"),
            rights_basis=rights_basis,
            license_identifier=license_identifier,
            evidence_storage_key=evidence_storage_key,
            attestation_version="zlibrary-rights-v1",
            rights_confirmed=True,
            target_capabilities=capabilities(),
            title="Governed Book",
        )

    assert raised.value.code is ErrorCode.VALIDATION
    assert zlibrary.canonicalize_calls == 0
    assert zlibrary.acquire_calls == 0
    assert state.jobs == [] and state.payloads == [] and state.rights == []


@pytest.mark.parametrize(
    ("canonical_url", "redacted_url"),
    [
        pytest.param("http://zlibrary.invalid/book/1", None, id="canonical-http"),
        pytest.param(
            "https://user:password@zlibrary.invalid/book/1",
            None,
            id="canonical-userinfo",
        ),
        pytest.param(
            "https://zlibrary.invalid/book/1?token=secret",
            None,
            id="canonical-query",
        ),
        pytest.param(
            "https://zlibrary.invalid/book/1",
            "https://zlibrary.invalid/book/1?token=secret",
            id="redacted-query",
        ),
    ],
)
def test_zlibrary_submission_rejects_noncanonical_adapter_locations(
    canonical_url: str,
    redacted_url: str | None,
) -> None:
    state = SubmissionState()
    zlibrary = RecordingZLibraryAcquirer(
        canonical_url=canonical_url,
        redacted_url=redacted_url,
    )
    use_case, _local, _zlibrary = make_use_case(state, zlibrary=zlibrary)

    with pytest.raises(DiandianError, match="canonical, queryless, and credential-free"):
        use_case.submit_zlibrary(
            "https://zlibrary.invalid/book/raw",
            acquisition_credential=CredentialRef("zlibrary", "acquisition"),
            target_credential=CredentialRef("notebooklm", "target"),
            rights_basis=RightsBasis.PUBLIC_DOMAIN,
            license_identifier="Public Domain Mark 1.0",
            evidence_storage_key=None,
            attestation_version="zlibrary-rights-v1",
            rights_confirmed=True,
            target_capabilities=capabilities(),
            title="Governed Book",
        )

    assert zlibrary.canonicalize_calls == 1
    assert zlibrary.redact_calls == 1
    assert zlibrary.acquire_calls == 0
    assert state.jobs == [] and state.payloads == [] and state.rights == []


def test_zlibrary_submission_normalizes_metadata_and_drops_raw_location_secrets() -> None:
    state = SubmissionState()
    use_case, _local, zlibrary = make_use_case(state)
    raw_location = (
        "https://reader:super-secret@zlibrary.invalid/book/raw?token=super-secret#private"
    )

    use_case.submit_zlibrary(
        raw_location,
        acquisition_credential=CredentialRef("zlibrary", "acquisition-profile"),
        target_credential=CredentialRef("notebooklm", "target-profile"),
        rights_basis=RightsBasis.PUBLIC_DOMAIN,
        license_identifier="Public Domain Mark 1.0",
        evidence_storage_key=None,
        attestation_version="zlibrary-rights-v1",
        rights_confirmed=True,
        target_capabilities=capabilities(),
        title="  Governed\t Book  ",
        author="  Test\n Author  ",
    )

    payload_json = state.payloads[0].payload_json
    command = deserialize_import_source_command(payload_json)
    assert zlibrary.locations == [raw_location]
    assert command.title == "Governed Book"
    assert command.author == "Test Author"
    assert command.source_url == "https://zlibrary.invalid/book/canonical"
    assert raw_location not in payload_json
    assert "super-secret" not in payload_json
    assert "reader:" not in payload_json
