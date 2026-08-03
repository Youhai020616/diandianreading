from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from diandianreading.application.ports import (
    AcquiredAsset,
    AcquisitionRequest,
    PreparedDocument,
    ProgressSink,
)
from diandianreading.application.use_cases.import_book import ImportBookUseCase
from diandianreading.application.use_cases.import_source import (
    DurableImportSourceMaterializer,
    ImportSubmissionUseCase,
)
from diandianreading.domain import (
    CredentialRef,
    DiandianError,
    DocumentAsset,
    DocumentPart,
    ErrorCode,
    JobStatus,
    JobStep,
    JobStepStatus,
    PreparationManifest,
    RightsBasis,
    SourceOrigin,
    StorageKey,
    TargetCapabilities,
)
from diandianreading.infrastructure.fakes import FakeKnowledgeAdapter, FakeKnowledgeService
from diandianreading.infrastructure.persistence import (
    SQLiteCatalogRepository,
    SQLiteDatabase,
    SQLiteJobPayloadRepository,
    SQLiteJobRepository,
    SQLiteJobStepRepository,
    SQLiteRightsProvenanceRepository,
    SQLiteUnitOfWorkFactory,
)
from tests.support import FIXED_NOW, SequentialIds


class InjectedCrash(BaseException):
    pass


@dataclass(slots=True)
class MutableClock:
    current: datetime = FIXED_NOW

    def __call__(self) -> datetime:
        return self.current

    def advance(self, delta: timedelta) -> None:
        self.current += delta


class RecordingLocalAcquirer:
    def __init__(self, sha256: str = "a" * 64) -> None:
        self.sha256 = sha256
        self.requests: list[AcquisitionRequest] = []

    async def acquire(
        self,
        request: AcquisitionRequest,
        progress: ProgressSink,
    ) -> AcquiredAsset:
        del progress
        self.requests.append(request)
        return AcquiredAsset(
            asset=DocumentAsset(
                id=f"asset-{self.sha256[:8]}",
                storage_key=StorageKey(f"originals/{self.sha256}"),
                display_filename=Path(request.location).name,
                mime_type="text/markdown",
                size_bytes=32,
                sha256=self.sha256,
                title="Captured",
                author=None,
                origin=SourceOrigin.LOCAL,
                origin_locator=None,
                rights_provenance_id=request.options["rights_provenance_id"],
            ),
            temporary_key=None,
        )


class RecordingZLibraryAcquirer:
    provider = "zlibrary"

    def __init__(self, *, crash_once: bool = False) -> None:
        self.crash_once = crash_once
        self.acquire_calls = 0
        self.canonicalize_calls = 0
        self.locations: list[str] = []

    def canonicalize_location(self, location: str) -> str:
        self.canonicalize_calls += 1
        self.locations.append(location)
        assert location
        return "https://zlibrary.invalid/book/canonical"

    def redact_location(self, location: str) -> str:
        assert location == "https://zlibrary.invalid/book/canonical"
        return location

    async def acquire(
        self,
        request: AcquisitionRequest,
        progress: ProgressSink,
    ) -> AcquiredAsset:
        del progress
        self.acquire_calls += 1
        if self.crash_once and self.acquire_calls == 1:
            raise InjectedCrash("process died during acquisition")
        sha256 = "b" * 64
        return AcquiredAsset(
            asset=DocumentAsset(
                id="asset-zlibrary",
                storage_key=StorageKey(f"originals/{sha256}"),
                display_filename="governed.md",
                mime_type="text/markdown",
                size_bytes=64,
                sha256=sha256,
                title=request.options["title"],
                author=request.options["author"] or None,
                origin=SourceOrigin.ZLIBRARY,
                origin_locator=request.options["source_locator_redacted"],
                rights_provenance_id=request.options["rights_provenance_id"],
            ),
            temporary_key=None,
        )


class DeterministicPreparation:
    def __init__(self, *, crash_once: bool = False) -> None:
        self.crash_once = crash_once
        self.calls = 0

    async def prepare(
        self,
        asset: DocumentAsset,
        capabilities: TargetCapabilities,
        progress: ProgressSink,
    ) -> PreparedDocument:
        del capabilities, progress
        self.calls += 1
        if self.crash_once and self.calls == 1:
            raise InjectedCrash("process died during preparation")
        part_hash = "c" * 64
        return PreparedDocument(
            derived_assets=(),
            parts=(
                DocumentPart(
                    id=f"part-{asset.id}",
                    asset_id=asset.id,
                    sequence=0,
                    storage_key=StorageKey(f"parts/{asset.id}/0000.md"),
                    mime_type="text/markdown",
                    word_count=10,
                    sha256=part_hash,
                    chapter_refs=("chapter-1",),
                    size_bytes=20,
                ),
            ),
            manifest=PreparationManifest(
                root_asset_id=asset.id,
                storage_key=StorageKey(f"manifests/{asset.id}.json"),
                sha256="d" * 64,
            ),
        )


class NotebookLMFakeKnowledgeAdapter(FakeKnowledgeAdapter):
    provider = "notebooklm"


def capabilities() -> TargetCapabilities:
    return TargetCapabilities(
        max_source_words=10_000,
        max_source_bytes=1_000_000,
        max_sources_per_workspace=10,
        accepted_mime_types=frozenset({"text/markdown"}),
    )


def make_database(tmp_path) -> SQLiteDatabase:
    database = SQLiteDatabase(tmp_path / "state" / "app.sqlite3")
    database.migrate()
    return database


def make_submission(
    database: SQLiteDatabase,
    local: RecordingLocalAcquirer,
    zlibrary: RecordingZLibraryAcquirer,
    clock: MutableClock,
    *ids: str,
) -> ImportSubmissionUseCase:
    return ImportSubmissionUseCase(
        unit_of_work=SQLiteUnitOfWorkFactory(database),
        local_acquirer=local,
        zlibrary_acquirer=zlibrary,
        id_factory=SequentialIds(*ids),
        clock=clock,
    )


def make_importer(
    database: SQLiteDatabase,
    zlibrary: RecordingZLibraryAcquirer,
    preparation: DeterministicPreparation,
    clock: MutableClock,
    service: FakeKnowledgeService | None = None,
) -> ImportBookUseCase:
    materializer = DurableImportSourceMaterializer(
        unit_of_work=SQLiteUnitOfWorkFactory(database),
        zlibrary_acquirer=zlibrary,
        preparation=preparation,
        clock=clock,
    )
    return ImportBookUseCase(
        unit_of_work=SQLiteUnitOfWorkFactory(database),
        knowledge=NotebookLMFakeKnowledgeAdapter(service or FakeKnowledgeService.create()),
        clock=clock,
        lease_duration=timedelta(seconds=5),
        retry_delay=timedelta(0),
        materializer=materializer,
    )


def test_local_acceptance_is_path_free_and_materializes_all_steps_inside_job(tmp_path) -> None:
    database = make_database(tmp_path)
    clock = MutableClock()
    local = RecordingLocalAcquirer()
    zlibrary = RecordingZLibraryAcquirer()
    preparation = DeterministicPreparation()
    submission = make_submission(database, local, zlibrary, clock, "job-local", "rights-local")
    physical_path = str(tmp_path / "private" / "selected-book.md")

    job = asyncio.run(
        submission.submit_local(
            physical_path,
            rights_basis=RightsBasis.OWNED_COPY,
            license_identifier=None,
            evidence_storage_key=None,
            rights_confirmed=True,
            target_credential=CredentialRef("notebooklm", "target"),
            target_capabilities=capabilities(),
            title="Local Durable Book",
            author="Local Author",
        )
    )

    payload = SQLiteJobPayloadRepository(database).get(job.id)
    assert payload is not None
    assert physical_path not in payload.payload_json
    with database.connect() as connection:
        dump = "\n".join(connection.iterdump())
    assert physical_path not in dump
    rights = SQLiteRightsProvenanceRepository(database).get("rights-local")
    assert rights is not None
    assert rights.acquisition_job_id == job.id
    assert rights.content_sha256 == "a" * 64

    result = asyncio.run(
        make_importer(database, zlibrary, preparation, clock).run_next(worker_id="w")
    )
    assert result is not None
    assert result.job.status is JobStatus.COMPLETED
    assert result.book.source_hash == "a" * 64
    assert local.requests[0].location == physical_path
    assert preparation.calls == 1
    records = tuple(SQLiteJobStepRepository(database).list(job.id))
    assert len(records) == len(JobStep)
    assert all(record.status is JobStepStatus.COMPLETED for record in records)


def test_zlibrary_is_accepted_before_adapter_call_and_executes_only_after_claim(tmp_path) -> None:
    database = make_database(tmp_path)
    clock = MutableClock()
    local = RecordingLocalAcquirer()
    zlibrary = RecordingZLibraryAcquirer()
    preparation = DeterministicPreparation()
    submission = make_submission(database, local, zlibrary, clock, "job-z", "rights-z")
    raw_location = (
        "https://reader:download-secret@zlibrary.invalid/book/raw?token=download-secret#private"
    )

    job = submission.submit_zlibrary(
        raw_location,
        acquisition_credential=CredentialRef("zlibrary", "acquisition"),
        target_credential=CredentialRef("notebooklm", "target"),
        rights_basis=RightsBasis.PUBLIC_DOMAIN,
        license_identifier="Public Domain Mark 1.0",
        evidence_storage_key=None,
        attestation_version="zlibrary-rights-v1",
        rights_confirmed=True,
        target_capabilities=capabilities(),
        title="Governed Durable Book",
    )

    assert zlibrary.acquire_calls == 0
    assert zlibrary.locations == [raw_location]
    accepted = SQLiteJobRepository(database).get(job.id)
    assert accepted is not None and accepted.book_id is None
    payload = SQLiteJobPayloadRepository(database).get(job.id)
    assert payload is not None
    payload_data = json.loads(payload.payload_json)
    assert payload_data["source_url"] == "https://zlibrary.invalid/book/canonical"
    assert payload_data["acquisition_credential"] == {
        "profile": "acquisition",
        "provider": "zlibrary",
    }
    assert payload_data["target_credential"] == {
        "profile": "target",
        "provider": "notebooklm",
    }
    assert raw_location not in payload.payload_json
    assert "download-secret" not in payload.payload_json
    assert "reader:" not in payload.payload_json
    with database.connect() as connection:
        dump = "\n".join(connection.iterdump())
    assert raw_location not in dump
    assert "download-secret" not in dump
    result = asyncio.run(
        make_importer(database, zlibrary, preparation, clock).run(job.id, worker_id="worker")
    )
    assert result.job.status is JobStatus.COMPLETED
    assert zlibrary.acquire_calls == 1
    rights = SQLiteRightsProvenanceRepository(database).get("rights-z")
    assert rights is not None
    assert rights.acquisition_job_id == job.id
    assert rights.content_sha256 == "b" * 64


def test_v2_auth_resume_checks_target_credential_and_continues_same_job(tmp_path) -> None:
    database = make_database(tmp_path)
    clock = MutableClock()
    service = FakeKnowledgeService.create()
    service.healthy = False
    local = RecordingLocalAcquirer()
    zlibrary = RecordingZLibraryAcquirer()
    preparation = DeterministicPreparation()
    submission = make_submission(database, local, zlibrary, clock, "job-auth", "rights-auth")
    job = asyncio.run(
        submission.submit_local(
            tmp_path / "auth.md",
            rights_basis=RightsBasis.OWNED_COPY,
            license_identifier=None,
            evidence_storage_key=None,
            rights_confirmed=True,
            target_credential=CredentialRef("notebooklm", "target"),
            target_capabilities=capabilities(),
            title="Auth Resume Book",
        )
    )
    importer = make_importer(database, zlibrary, preparation, clock, service)
    payload_before = SQLiteJobPayloadRepository(database).get(job.id)
    assert payload_before is not None

    with pytest.raises(DiandianError) as blocked_error:
        asyncio.run(importer.run(job.id, worker_id="worker-before-auth"))
    assert blocked_error.value.code is ErrorCode.AUTH_REQUIRED
    blocked = SQLiteJobRepository(database).get(job.id)
    assert (
        blocked is not None and blocked.status is JobStatus.BLOCKED and blocked.book_id is not None
    )
    assert len(local.requests) == 1
    assert preparation.calls == 1
    assert len(SQLiteCatalogRepository(database).list_parts(blocked.book_id)) == 1

    with pytest.raises(DiandianError, match="still unavailable"):
        asyncio.run(importer.resume_after_auth(job.id))
    service.healthy = True
    resumed = asyncio.run(importer.resume_after_auth(job.id))
    assert resumed.status is JobStatus.QUEUED
    result = asyncio.run(importer.run(job.id, worker_id="worker-after-auth"))
    assert result.job.status is JobStatus.COMPLETED
    assert preparation.calls == 1
    assert len(SQLiteCatalogRepository(database).list_parts(result.book.id)) == 1
    assert SQLiteJobPayloadRepository(database).get(job.id) == payload_before
    assert service.workspace_write_count == 1
    assert service.source_write_count == 1


@pytest.mark.parametrize("crash_stage", ["acquisition", "preparation"])
def test_expired_lease_recovers_crash_during_source_materialization(
    tmp_path,
    crash_stage: str,
) -> None:
    database = make_database(tmp_path)
    clock = MutableClock()
    local = RecordingLocalAcquirer()
    zlibrary = RecordingZLibraryAcquirer(crash_once=crash_stage == "acquisition")
    preparation = DeterministicPreparation(crash_once=crash_stage == "preparation")
    submission = make_submission(database, local, zlibrary, clock, "job-crash", "rights-crash")
    job = submission.submit_zlibrary(
        "https://zlibrary.invalid/book/raw",
        acquisition_credential=CredentialRef("zlibrary", "acquisition"),
        target_credential=CredentialRef("notebooklm", "target"),
        rights_basis=RightsBasis.PUBLIC_DOMAIN,
        license_identifier="Public Domain Mark 1.0",
        evidence_storage_key=None,
        attestation_version="zlibrary-rights-v1",
        rights_confirmed=True,
        target_capabilities=capabilities(),
        title="Crash Recovery Book",
    )
    importer = make_importer(database, zlibrary, preparation, clock)
    payload_before = SQLiteJobPayloadRepository(database).get(job.id)
    assert payload_before is not None

    with pytest.raises(InjectedCrash):
        asyncio.run(importer.run(job.id, worker_id="worker-before-crash"))
    stranded = SQLiteJobRepository(database).get(job.id)
    assert stranded is not None and stranded.status is JobStatus.RUNNING

    clock.advance(timedelta(seconds=6))
    result = asyncio.run(importer.run(job.id, worker_id="worker-after-crash"))
    assert result.job.status is JobStatus.COMPLETED
    assert result.job.lease_generation == 2
    assert zlibrary.acquire_calls == (2 if crash_stage == "acquisition" else 1)
    assert preparation.calls == (2 if crash_stage == "preparation" else 1)
    catalog = SQLiteCatalogRepository(database)
    assert len(catalog.list_assets(result.book.id)) == 1
    assert len(catalog.list_parts(result.book.id)) == 1
    assert SQLiteJobPayloadRepository(database).get(job.id) == payload_before


def test_duplicate_source_hash_fails_with_safe_typed_validation(tmp_path) -> None:
    database = make_database(tmp_path)
    clock = MutableClock()
    local = RecordingLocalAcquirer()
    zlibrary = RecordingZLibraryAcquirer()
    preparation = DeterministicPreparation()
    submission = make_submission(
        database,
        local,
        zlibrary,
        clock,
        "job-first",
        "rights-first",
        "job-second",
        "rights-second",
    )
    importer = make_importer(database, zlibrary, preparation, clock)

    async def submit(job_title: str):
        return await submission.submit_local(
            tmp_path / f"{job_title}.md",
            rights_basis=RightsBasis.OWNED_COPY,
            license_identifier=None,
            evidence_storage_key=None,
            rights_confirmed=True,
            target_credential=CredentialRef("notebooklm", "target"),
            target_capabilities=capabilities(),
            title=job_title,
        )

    first = asyncio.run(submit("First"))
    second = asyncio.run(submit("Second"))
    asyncio.run(importer.run(first.id, worker_id="worker-first"))

    with pytest.raises(DiandianError, match="already been imported") as raised:
        asyncio.run(importer.run(second.id, worker_id="worker-second"))
    assert raised.value.code is ErrorCode.VALIDATION
    failed = SQLiteJobRepository(database).get(second.id)
    assert failed is not None and failed.status is JobStatus.FAILED
    assert failed.book_id is None


@pytest.mark.parametrize("tamper_mode", ["fingerprint", "semantic"])
def test_invalid_durable_payload_never_executes_source_side_effects(
    tmp_path,
    tamper_mode: str,
) -> None:
    database = make_database(tmp_path)
    clock = MutableClock()
    local = RecordingLocalAcquirer()
    zlibrary = RecordingZLibraryAcquirer()
    preparation = DeterministicPreparation()
    submission = make_submission(database, local, zlibrary, clock, "job-tampered", "rights-t")
    job = submission.submit_zlibrary(
        "https://zlibrary.invalid/book/raw?token=discarded",
        acquisition_credential=CredentialRef("zlibrary", "acquisition"),
        target_credential=CredentialRef("notebooklm", "target"),
        rights_basis=RightsBasis.PUBLIC_DOMAIN,
        license_identifier="Public Domain Mark 1.0",
        evidence_storage_key=None,
        attestation_version="zlibrary-rights-v1",
        rights_confirmed=True,
        target_capabilities=capabilities(),
        title="Tamper Resistant Book",
    )
    payload = SQLiteJobPayloadRepository(database).get(job.id)
    assert payload is not None

    if tamper_mode == "fingerprint":
        with database.connect(immediate=True) as connection:
            connection.execute(
                "UPDATE job_payloads SET payload_json = ? WHERE job_id = ?",
                (payload.payload_json + " ", job.id),
            )
    else:
        payload_data = json.loads(payload.payload_json)
        payload_data["title"] = " "
        payload_json = json.dumps(
            payload_data,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        input_hash = hashlib.sha256(payload_json.encode("utf-8")).hexdigest()
        with database.connect(immediate=True) as connection:
            connection.execute(
                """
                UPDATE job_payloads
                SET payload_json = ?, input_hash = ?
                WHERE job_id = ?
                """,
                (payload_json, input_hash, job.id),
            )
            connection.execute(
                "UPDATE jobs SET input_hash = ? WHERE id = ?",
                (input_hash, job.id),
            )

    importer = make_importer(database, zlibrary, preparation, clock)
    with pytest.raises(DiandianError) as raised:
        asyncio.run(importer.run(job.id, worker_id="worker-tampered"))

    assert raised.value.code is ErrorCode.REPOSITORY_CONFLICT
    assert zlibrary.acquire_calls == 0
    assert preparation.calls == 0
    failed = SQLiteJobRepository(database).get(job.id)
    assert failed is not None and failed.status is JobStatus.FAILED
    assert failed.book_id is None
    rights = SQLiteRightsProvenanceRepository(database).get("rights-t")
    assert rights is not None and rights.content_sha256 is None
