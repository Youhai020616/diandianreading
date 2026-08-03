"""Durable source submission and materialization for import_source.v2 Jobs."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Final, cast, final
from urllib.parse import quote, urlsplit
from uuid import NAMESPACE_URL, uuid4, uuid5

from diandianreading.application.ports.acquisition import (
    AcquisitionRequest,
    DocumentAcquirer,
    ZLibraryAcquisitionPort,
)
from diandianreading.application.ports.documents import (
    DocumentPreparationPort,
    PreparedDocument,
)
from diandianreading.application.ports.progress import NullProgressSink, ProgressSink
from diandianreading.application.ports.repositories import UnitOfWorkFactory
from diandianreading.application.use_cases.acquire_zlibrary import (
    ZLIBRARY_RIGHTS_POLICY_VERSION,
)
from diandianreading.domain import (
    Book,
    BookStatus,
    CredentialRef,
    DiandianError,
    DocumentAsset,
    ErrorCode,
    Job,
    JobPayload,
    JobStatus,
    JobStep,
    JobStepRecord,
    JobStepStatus,
    RightsBasis,
    RightsProvenance,
    SourceOrigin,
    StorageKey,
    TargetCapabilities,
    utc_now,
)

if TYPE_CHECKING:
    from diandianreading.application.use_cases.import_book import ImportBookCommand

IMPORT_SOURCE_PAYLOAD_TYPE: Final = "import_source.v2"
_IMPORT_JOB_TYPE: Final = "import_book"
_LOCAL_PROVIDER: Final = "local"
_ZLIBRARY_PROVIDER: Final = "zlibrary"
_NOTEBOOKLM_PROVIDER: Final = "notebooklm"


@dataclass(frozen=True, slots=True)
class ImportSourceCommand:
    """Canonical, path-free input persisted for a durable import."""

    provider: SourceOrigin
    target_credential: CredentialRef
    rights_provenance_id: str
    title: str
    author: str | None
    target_capabilities: TargetCapabilities
    source_url: str | None = None
    acquisition_credential: CredentialRef | None = None
    captured_asset: DocumentAsset | None = None

    def __post_init__(self) -> None:
        if self.target_credential.provider != _NOTEBOOKLM_PROVIDER:
            raise ValueError("Import target credential must reference NotebookLM")
        if not self.rights_provenance_id.strip():
            raise ValueError("Import source rights provenance ID is required")
        if not self.title.strip():
            raise ValueError("Import source title cannot be empty")
        if self.author is not None and not self.author.strip():
            raise ValueError("Import source author cannot be blank")

        if self.provider is SourceOrigin.LOCAL:
            if self.source_url is not None or self.acquisition_credential is not None:
                raise ValueError("Local import payload cannot contain a source URL or credential")
            if self.captured_asset is None:
                raise ValueError("Local import payload requires a captured DocumentAsset")
            _validate_local_asset(self.captured_asset, self)
            return

        if self.provider is not SourceOrigin.ZLIBRARY:
            raise ValueError("Import source provider is unsupported")
        if self.captured_asset is not None:
            raise ValueError("Z-Library import payload cannot contain a captured DocumentAsset")
        if self.source_url is None:
            raise ValueError("Z-Library import payload requires a canonical source URL")
        _validate_canonical_https_url(self.source_url, field_name="Z-Library source URL")
        if (
            self.acquisition_credential is None
            or self.acquisition_credential.provider != _ZLIBRARY_PROVIDER
        ):
            raise ValueError("Z-Library import requires a Z-Library credential reference")


@final
class ImportSubmissionUseCase:
    """Accept path-free durable Jobs after local capture or governed URL validation."""

    def __init__(
        self,
        *,
        unit_of_work: UnitOfWorkFactory,
        local_acquirer: DocumentAcquirer,
        zlibrary_acquirer: ZLibraryAcquisitionPort,
        current_rights_policy: str = ZLIBRARY_RIGHTS_POLICY_VERSION,
        id_factory: Callable[[], str] | None = None,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        if not current_rights_policy.strip():
            raise ValueError("Current rights policy version is required")
        self._unit_of_work = unit_of_work
        self._local_acquirer = local_acquirer
        self._zlibrary_acquirer = zlibrary_acquirer
        self._current_rights_policy = current_rights_policy
        self._id_factory = id_factory or (lambda: str(uuid4()))
        self._clock = clock

    async def submit_local(
        self,
        path: str | Path,
        *,
        rights_basis: RightsBasis,
        license_identifier: str | None,
        evidence_storage_key: StorageKey | None,
        rights_confirmed: bool,
        target_credential: CredentialRef,
        target_capabilities: TargetCapabilities,
        title: str | None = None,
        author: str | None = None,
        display_filename: str | None = None,
    ) -> Job:
        job_id = self._id_factory()
        rights_id = self._id_factory()
        if rights_confirmed is not True:
            raise _validation("Local import requires explicit rights confirmation")
        _validate_target_credential(target_credential)
        timestamp = self._clock()
        locator = _local_rights_locator(rights_id)
        unbound = _new_rights_provenance(
            provenance_id=rights_id,
            provider=_LOCAL_PROVIDER,
            source_locator_redacted=locator,
            rights_basis=rights_basis,
            license_identifier=license_identifier,
            evidence_storage_key=evidence_storage_key,
            attestation_version=self._current_rights_policy,
            acquisition_job_id=job_id,
            content_sha256=None,
            now=timestamp,
        )

        acquired = await self._local_acquirer.acquire(
            AcquisitionRequest(
                provider=_LOCAL_PROVIDER,
                location=str(path),
                rights_confirmed=True,
                options={
                    "rights_provenance_id": rights_id,
                    "title": _normalize_optional_metadata(title) or "",
                    "author": _normalize_optional_metadata(author) or "",
                    "display_filename": display_filename or "",
                },
                credential=None,
            ),
            NullProgressSink(job_id),
        )
        if acquired.temporary_key is not None:
            raise _validation("Local capture did not publish a durable DocumentAsset")
        captured = acquired.asset
        resolved_title = _normalize_optional_metadata(title) or captured.title
        if resolved_title is None:
            resolved_title = Path(captured.display_filename).stem.strip() or "Untitled document"
        resolved_author = _normalize_optional_metadata(author)
        if resolved_author is None:
            resolved_author = captured.author
        captured = replace(captured, title=resolved_title, author=resolved_author)

        command = ImportSourceCommand(
            provider=SourceOrigin.LOCAL,
            target_credential=target_credential,
            rights_provenance_id=rights_id,
            title=resolved_title,
            author=resolved_author,
            target_capabilities=target_capabilities,
            captured_asset=captured,
        )
        provenance = replace(unbound, content_sha256=captured.sha256)
        return self._accept(job_id, command, provenance, now=timestamp)

    def submit_zlibrary(
        self,
        location: str,
        *,
        acquisition_credential: CredentialRef,
        target_credential: CredentialRef,
        rights_basis: RightsBasis,
        license_identifier: str | None,
        evidence_storage_key: StorageKey | None,
        attestation_version: str,
        rights_confirmed: bool,
        target_capabilities: TargetCapabilities,
        title: str,
        author: str | None = None,
    ) -> Job:
        job_id = self._id_factory()
        rights_id = self._id_factory()
        if self._zlibrary_acquirer.provider != _ZLIBRARY_PROVIDER:
            raise _validation("Configured acquisition Adapter is not Z-Library")
        if not location.strip():
            raise _validation("Z-Library source location is required")
        if rights_confirmed is not True:
            raise _validation("Z-Library import requires explicit per-item rights confirmation")
        if attestation_version != self._current_rights_policy:
            raise _validation("Z-Library rights attestation is missing or out of date")
        if acquisition_credential.provider != _ZLIBRARY_PROVIDER:
            raise _validation("Z-Library import requires a Z-Library credential reference")
        _validate_target_credential(target_credential)
        _validate_rights_evidence(
            rights_basis,
            license_identifier=license_identifier,
            evidence_storage_key=evidence_storage_key,
        )
        normalized_title = _normalize_required_metadata(title, field_name="Import title")
        normalized_author = _normalize_optional_metadata(author)

        canonical_url = self._zlibrary_acquirer.canonicalize_location(location)
        redacted_url = self._zlibrary_acquirer.redact_location(canonical_url)
        _validate_canonical_https_url(canonical_url, field_name="Z-Library source URL")
        _validate_canonical_https_url(redacted_url, field_name="Z-Library redacted URL")

        timestamp = self._clock()
        provenance = _new_rights_provenance(
            provenance_id=rights_id,
            provider=_ZLIBRARY_PROVIDER,
            source_locator_redacted=redacted_url,
            rights_basis=rights_basis,
            license_identifier=license_identifier,
            evidence_storage_key=evidence_storage_key,
            attestation_version=attestation_version,
            acquisition_job_id=job_id,
            content_sha256=None,
            now=timestamp,
        )
        command = ImportSourceCommand(
            provider=SourceOrigin.ZLIBRARY,
            source_url=canonical_url,
            acquisition_credential=acquisition_credential,
            target_credential=target_credential,
            rights_provenance_id=rights_id,
            title=normalized_title,
            author=normalized_author,
            target_capabilities=target_capabilities,
        )
        return self._accept(job_id, command, provenance, now=timestamp)

    def _accept(
        self,
        job_id: str,
        command: ImportSourceCommand,
        provenance: RightsProvenance,
        *,
        now: datetime,
    ) -> Job:
        payload_json = serialize_import_source_command(command)
        input_hash = _sha256_text(payload_json)
        job = Job.create(
            job_id=job_id,
            job_type=_IMPORT_JOB_TYPE,
            input_hash=input_hash,
            book_id=None,
            now=now,
        )
        payload = JobPayload(
            job_id=job.id,
            payload_type=IMPORT_SOURCE_PAYLOAD_TYPE,
            payload_json=payload_json,
            input_hash=input_hash,
            created_at=now,
        )
        with self._unit_of_work() as unit_of_work:
            unit_of_work.jobs.add(job)
            unit_of_work.job_payloads.add(payload)
            unit_of_work.rights.add(provenance)
            unit_of_work.commit()
        return job


@final
class DurableImportSourceMaterializer:
    """Materialize acquisition, storage, and preparation inside a claimed Job."""

    def __init__(
        self,
        *,
        unit_of_work: UnitOfWorkFactory,
        zlibrary_acquirer: ZLibraryAcquisitionPort,
        preparation: DocumentPreparationPort,
        id_factory: Callable[[], str] | None = None,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        if zlibrary_acquirer.provider != _ZLIBRARY_PROVIDER:
            raise ValueError("Durable import materializer requires a Z-Library Adapter")
        self._unit_of_work = unit_of_work
        self._zlibrary_acquirer = zlibrary_acquirer
        self._preparation = preparation
        self._id_factory = id_factory or (lambda: str(uuid4()))
        self._clock = clock

    async def materialize(
        self,
        job: Job,
        payload: JobPayload,
        progress: ProgressSink,
    ) -> tuple[Job, ImportBookCommand]:
        command = self._validate_payload(job, payload)
        lease_duration = _lease_duration(job)
        job, book, root = await self._acquire(job, command, progress, lease_duration)
        job = self._store(job, book, root, lease_duration)
        job, prepared = await self._prepare(
            job,
            book,
            root,
            command,
            progress,
            lease_duration,
        )
        import_command = _build_import_command(command, root, prepared)
        return job, import_command

    def _validate_payload(self, job: Job, payload: JobPayload) -> ImportSourceCommand:
        if payload.job_id != job.id or payload.payload_type != IMPORT_SOURCE_PAYLOAD_TYPE:
            raise _conflict("Durable import source payload is unavailable")
        actual_hash = _sha256_text(payload.payload_json)
        if actual_hash != payload.input_hash or actual_hash != job.input_hash:
            raise _conflict("Durable import source payload fingerprint does not match")
        return deserialize_import_source_command(payload.payload_json)

    async def _acquire(
        self,
        job: Job,
        command: ImportSourceCommand,
        progress: ProgressSink,
        lease_duration: timedelta,
    ) -> tuple[Job, Book, DocumentAsset]:
        job = self._heartbeat(job, lease_duration)
        input_hash = _acquisition_input_hash(command)
        job, record, completed = self._start_step(job, JobStep.ACQUIRING, input_hash)
        if completed:
            book, root = self._load_acquired(job, command)
            return job, book, root

        if command.provider is SourceOrigin.LOCAL:
            captured = command.captured_asset
            if captured is None:
                raise _conflict("Captured local DocumentAsset is unavailable")
            root = captured
            provenance = self._load_rights(command.rights_provenance_id)
            self._validate_rights(command, job, provenance, expected_hash=root.sha256)
        else:
            provenance = self._load_rights(command.rights_provenance_id)
            self._validate_rights(command, job, provenance, expected_hash=None)
            source_url = command.source_url
            credential = command.acquisition_credential
            if source_url is None or credential is None:
                raise _conflict("Z-Library acquisition input is unavailable")
            acquired = await self._zlibrary_acquirer.acquire(
                AcquisitionRequest(
                    provider=_ZLIBRARY_PROVIDER,
                    location=source_url,
                    rights_confirmed=True,
                    options={
                        "rights_provenance_id": provenance.id,
                        "source_locator_redacted": provenance.source_locator_redacted,
                        "title": command.title,
                        "author": command.author or "",
                    },
                    credential=credential,
                ),
                progress,
            )
            if acquired.temporary_key is not None:
                raise _validation("Z-Library acquisition did not publish a durable DocumentAsset")
            root = acquired.asset
            _validate_zlibrary_asset(root, command, provenance)

        job = self._heartbeat(job, lease_duration)
        timestamp = self._clock()
        book = Book(
            id=book_id_for_job(job.id),
            title=command.title,
            author=command.author,
            source_hash=root.sha256,
            status=BookStatus.IMPORTING,
            created_at=timestamp,
            updated_at=timestamp,
        )
        attached = job.attach_book(book.id, job.lease_token, now=timestamp)
        completed_record = record.complete(
            _canonical_json({"asset_id": root.id, "book_id": book.id}),
            now=timestamp,
        )
        with self._unit_of_work() as unit_of_work:
            persisted_rights = unit_of_work.rights.get(command.rights_provenance_id)
            if persisted_rights is None:
                raise _conflict("Rights provenance is unavailable during acquisition")
            self._validate_rights(
                command,
                job,
                persisted_rights,
                expected_hash=(root.sha256 if command.provider is SourceOrigin.LOCAL else None),
            )
            duplicate = unit_of_work.catalog.get_book_by_source_hash(root.sha256)
            if duplicate is not None and duplicate.id != book.id:
                raise _duplicate_source()
            if duplicate is None:
                unit_of_work.catalog.add_book(book)
                unit_of_work.catalog.add_asset(book.id, root)
            else:
                persisted_root = _root_asset(unit_of_work.catalog.list_assets(book.id))
                if duplicate != book or persisted_root != root:
                    raise _conflict("Recovered Book does not match acquired source content")
            if persisted_rights.content_sha256 is None:
                bound = persisted_rights.bind_content(
                    root.sha256,
                    acquisition_job_id=job.id,
                    now=timestamp,
                )
                unit_of_work.rights.save(persisted_rights, bound)
            elif persisted_rights.content_sha256 != root.sha256:
                raise _conflict("Rights provenance content binding does not match acquisition")
            unit_of_work.jobs.save_transition(job, attached)
            unit_of_work.job_steps.save(record, completed_record, job.lease_token)
            unit_of_work.commit()
        return attached, book, root

    def _store(
        self,
        job: Job,
        book: Book,
        root: DocumentAsset,
        lease_duration: timedelta,
    ) -> Job:
        job = self._heartbeat(job, lease_duration)
        job, record, completed = self._start_step(job, JobStep.STORING, root.sha256)
        persisted_book, persisted_root = self._load_book_and_root(job)
        if persisted_book != book or persisted_root != root:
            raise _conflict("Catalogued root DocumentAsset changed before storage checkpoint")
        if completed:
            return job
        completed_record = record.complete(
            _canonical_json(
                {
                    "asset_id": root.id,
                    "sha256": root.sha256,
                    "storage_key": root.storage_key.value,
                }
            ),
            now=self._clock(),
        )
        with self._unit_of_work() as unit_of_work:
            unit_of_work.job_steps.save(record, completed_record, job.lease_token)
            unit_of_work.commit()
        return job

    async def _prepare(
        self,
        job: Job,
        book: Book,
        root: DocumentAsset,
        command: ImportSourceCommand,
        progress: ProgressSink,
        lease_duration: timedelta,
    ) -> tuple[Job, PreparedDocument]:
        job = self._heartbeat(job, lease_duration)
        input_hash = _preparation_input_hash(root, command.target_capabilities)
        job, record, completed = self._start_step(job, JobStep.PREPARING, input_hash)
        if completed:
            return job, self._load_prepared(book, root, command)

        prepared = await self._preparation.prepare(root, command.target_capabilities, progress)
        _validate_prepared_document(root, prepared, command)
        job = self._heartbeat(job, lease_duration)
        completed_record = record.complete(
            _canonical_json(
                {
                    "derived_asset_ids": [asset.id for asset in prepared.derived_assets],
                    "manifest": prepared.manifest.storage_key.value,
                    "part_ids": [part.id for part in prepared.parts],
                }
            ),
            now=self._clock(),
        )
        with self._unit_of_work() as unit_of_work:
            persisted_book = unit_of_work.catalog.get_book(book.id)
            persisted_root = _root_asset(unit_of_work.catalog.list_assets(book.id))
            if persisted_book != book or persisted_root != root:
                raise _conflict("Catalogued root DocumentAsset changed during preparation")
            for asset in prepared.derived_assets:
                unit_of_work.catalog.add_asset(book.id, asset)
            for part in prepared.parts:
                unit_of_work.catalog.add_part(part)
            unit_of_work.catalog.add_manifest(book.id, prepared.manifest)
            unit_of_work.job_steps.save(record, completed_record, job.lease_token)
            unit_of_work.commit()
        return job, prepared

    def _heartbeat(self, job: Job, lease_duration: timedelta) -> Job:
        now = self._clock()
        with self._unit_of_work() as unit_of_work:
            current = unit_of_work.jobs.get(job.id)
            if current is None:
                raise _conflict("Durable import Job disappeared during materialization")
            current.assert_lease(job.lease_token)
            if current.is_cancel_requested:
                active = (
                    unit_of_work.job_steps.get(
                        current.id,
                        current.current_step,
                        current.attempt,
                    )
                    if current.current_step is not None
                    else None
                )
                if active is not None and active.status in {
                    JobStepStatus.RUNNING,
                    JobStepStatus.BLOCKED,
                }:
                    unit_of_work.job_steps.save(
                        active,
                        active.cancel(now=now),
                        current.lease_token,
                    )
                cancelled = current.cancel(token=current.lease_token, now=now)
                unit_of_work.jobs.save_transition(current, cancelled)
                unit_of_work.commit()
                error = DiandianError(ErrorCode.CANCELLED, "Job cancelled", retryable=False)
                error.__dict__["durably_projected"] = True
                raise error
            renewed = unit_of_work.jobs.heartbeat(
                current.id,
                current.lease_token,
                lease_expires_at=now + lease_duration,
                now=now,
            )
            unit_of_work.commit()
        return renewed

    def _start_step(
        self,
        job: Job,
        step: JobStep,
        input_hash: str,
    ) -> tuple[Job, JobStepRecord, bool]:
        with self._unit_of_work() as unit_of_work:
            latest = unit_of_work.job_steps.latest(job.id, step)
            if latest is not None and latest.status is JobStepStatus.COMPLETED:
                if latest.input_hash != input_hash:
                    raise _conflict("Completed durable import Step fingerprint changed")
                unit_of_work.commit()
                return job, latest, True

            current = job
            if current.current_step is not step:
                current = current.begin_step(step, current.lease_token, now=self._clock())
                unit_of_work.jobs.save_transition(job, current)
            record = unit_of_work.job_steps.get(current.id, step, current.attempt)
            if record is None:
                record = JobStepRecord.start(
                    job_id=current.id,
                    step=step,
                    attempt=current.attempt,
                    input_hash=input_hash,
                    now=self._clock(),
                )
                unit_of_work.job_steps.add(record, current.lease_token)
            elif record.input_hash != input_hash or record.status is not JobStepStatus.RUNNING:
                raise _conflict("Active durable import Step checkpoint is inconsistent")
            unit_of_work.commit()
        return current, record, False

    def _load_acquired(
        self,
        job: Job,
        command: ImportSourceCommand,
    ) -> tuple[Book, DocumentAsset]:
        book, root = self._load_book_and_root(job)
        if book.id != book_id_for_job(job.id) or book.source_hash != root.sha256:
            raise _conflict("Completed acquisition checkpoint has inconsistent Book identity")
        provenance = self._load_rights(command.rights_provenance_id)
        self._validate_rights(command, job, provenance, expected_hash=root.sha256)
        if command.provider is SourceOrigin.LOCAL:
            if command.captured_asset != root:
                raise _conflict("Captured local DocumentAsset changed after acceptance")
        else:
            _validate_zlibrary_asset(root, command, provenance)
        return book, root

    def _load_book_and_root(self, job: Job) -> tuple[Book, DocumentAsset]:
        if job.book_id is None:
            raise _conflict("Durable import Job has no attached Book")
        with self._unit_of_work() as unit_of_work:
            book = unit_of_work.catalog.get_book(job.book_id)
            assets = tuple(unit_of_work.catalog.list_assets(job.book_id))
            unit_of_work.commit()
        if book is None:
            raise _conflict("Durable import Book is unavailable")
        return book, _root_asset(assets)

    def _load_prepared(
        self,
        book: Book,
        root: DocumentAsset,
        command: ImportSourceCommand,
    ) -> PreparedDocument:
        with self._unit_of_work() as unit_of_work:
            assets = tuple(unit_of_work.catalog.list_assets(book.id))
            parts = tuple(unit_of_work.catalog.list_parts(book.id))
            manifest = unit_of_work.catalog.get_manifest(root.id)
            unit_of_work.commit()
        if manifest is None:
            raise _conflict("Completed preparation checkpoint has no manifest")
        derived = tuple(asset for asset in assets if asset.id != root.id)
        prepared = PreparedDocument(derived_assets=derived, parts=parts, manifest=manifest)
        _validate_prepared_document(root, prepared, command)
        return prepared

    def _load_rights(self, provenance_id: str) -> RightsProvenance:
        with self._unit_of_work() as unit_of_work:
            provenance = unit_of_work.rights.get(provenance_id)
            unit_of_work.commit()
        if provenance is None:
            raise _conflict("Rights provenance is unavailable")
        return provenance

    def _validate_rights(
        self,
        command: ImportSourceCommand,
        job: Job,
        provenance: RightsProvenance,
        *,
        expected_hash: str | None,
    ) -> None:
        expected_locator = (
            _local_rights_locator(command.rights_provenance_id)
            if command.provider is SourceOrigin.LOCAL
            else self._redacted_zlibrary_url(command)
        )
        if (
            provenance.id != command.rights_provenance_id
            or provenance.provider != command.provider.value
            or provenance.source_locator_redacted != expected_locator
            or provenance.acquisition_job_id != job.id
        ):
            raise _conflict("Rights provenance does not match the durable import payload")
        if expected_hash is None:
            if provenance.content_sha256 is not None:
                raise _conflict("Uncheckpointed acquisition has an unexpected content binding")
        elif provenance.content_sha256 != expected_hash:
            raise _conflict("Rights provenance content binding does not match imported bytes")

    def _redacted_zlibrary_url(self, command: ImportSourceCommand) -> str:
        if command.source_url is None:
            raise _conflict("Z-Library source URL is unavailable")
        canonical = self._zlibrary_acquirer.canonicalize_location(command.source_url)
        if canonical != command.source_url:
            raise _conflict("Persisted Z-Library source URL is not canonical")
        redacted = self._zlibrary_acquirer.redact_location(canonical)
        _validate_canonical_https_url(redacted, field_name="Z-Library redacted URL")
        return redacted


def serialize_import_source_command(command: ImportSourceCommand) -> str:
    return _canonical_json(
        {
            "acquisition_credential": _credential_payload(command.acquisition_credential),
            "author": command.author,
            "captured_asset": _asset_payload(command.captured_asset),
            "provider": command.provider.value,
            "rights_provenance_id": command.rights_provenance_id,
            "source_url": command.source_url,
            "target_capabilities": {
                "accepted_mime_types": sorted(command.target_capabilities.accepted_mime_types),
                "max_source_bytes": command.target_capabilities.max_source_bytes,
                "max_source_words": command.target_capabilities.max_source_words,
                "max_sources_per_workspace": (
                    command.target_capabilities.max_sources_per_workspace
                ),
            },
            "target_credential": _credential_payload(command.target_credential),
            "title": command.title,
        }
    )


def deserialize_import_source_command(payload_json: str) -> ImportSourceCommand:
    try:
        payload = _require_object(
            cast(object, json.loads(payload_json)),
            {
                "acquisition_credential",
                "author",
                "captured_asset",
                "provider",
                "rights_provenance_id",
                "source_url",
                "target_capabilities",
                "target_credential",
                "title",
            },
            "Import source payload",
        )
        capabilities_payload = _require_object(
            payload["target_capabilities"],
            {
                "accepted_mime_types",
                "max_source_bytes",
                "max_source_words",
                "max_sources_per_workspace",
            },
            "Target capabilities",
        )
        accepted_value = capabilities_payload["accepted_mime_types"]
        if not isinstance(accepted_value, list):
            raise ValueError("Target accepted MIME types are invalid")
        accepted_objects = cast(list[object], accepted_value)
        if not all(isinstance(item, str) and item for item in accepted_objects):
            raise ValueError("Target accepted MIME types are invalid")
        accepted = tuple(cast(str, item) for item in accepted_objects)
        command = ImportSourceCommand(
            provider=SourceOrigin(_require_string(payload["provider"], "provider")),
            source_url=_optional_string(payload["source_url"], "source_url"),
            acquisition_credential=_credential_from_payload(
                payload["acquisition_credential"],
                optional=True,
            ),
            target_credential=_require_credential(payload["target_credential"]),
            rights_provenance_id=_require_string(
                payload["rights_provenance_id"],
                "rights_provenance_id",
            ),
            title=_require_string(payload["title"], "title"),
            author=_optional_string(payload["author"], "author"),
            target_capabilities=TargetCapabilities(
                max_source_words=_require_int(
                    capabilities_payload["max_source_words"],
                    "max_source_words",
                ),
                max_source_bytes=_require_int(
                    capabilities_payload["max_source_bytes"],
                    "max_source_bytes",
                ),
                max_sources_per_workspace=_require_int(
                    capabilities_payload["max_sources_per_workspace"],
                    "max_sources_per_workspace",
                ),
                accepted_mime_types=frozenset(accepted),
            ),
            captured_asset=_asset_from_payload(payload["captured_asset"]),
        )
        if serialize_import_source_command(command) != payload_json:
            raise ValueError("Import source payload is not canonical")
        return command
    except DiandianError:
        raise
    except (KeyError, TypeError, ValueError) as error:
        raise _conflict("Import source payload is invalid or non-canonical") from error


def book_id_for_job(job_id: str) -> str:
    if not job_id.strip():
        raise ValueError("Job ID cannot be empty")
    return str(uuid5(NAMESPACE_URL, f"diandianreading:book:{job_id}"))


def _new_rights_provenance(
    *,
    provenance_id: str,
    provider: str,
    source_locator_redacted: str,
    rights_basis: RightsBasis,
    license_identifier: str | None,
    evidence_storage_key: StorageKey | None,
    attestation_version: str,
    acquisition_job_id: str,
    content_sha256: str | None,
    now: datetime,
) -> RightsProvenance:
    try:
        return RightsProvenance(
            id=provenance_id,
            provider=provider,
            source_locator_redacted=source_locator_redacted,
            rights_basis=rights_basis,
            license_identifier=license_identifier,
            evidence_storage_key=evidence_storage_key,
            attestation_version=attestation_version,
            attested_at=now,
            acquisition_job_id=acquisition_job_id,
            content_sha256=content_sha256,
            supersedes_id=None,
            updated_at=now,
            version=0,
        )
    except ValueError as error:
        raise _validation(
            "Rights provenance does not satisfy the current evidence policy"
        ) from error


def _validate_rights_evidence(
    basis: RightsBasis,
    *,
    license_identifier: str | None,
    evidence_storage_key: StorageKey | None,
) -> None:
    if (
        basis in {RightsBasis.PUBLIC_DOMAIN, RightsBasis.OPEN_LICENSE}
        and not (license_identifier or "").strip()
    ):
        raise _validation("Public-domain and open-license imports need an identifier")
    if basis in {RightsBasis.LICENSED, RightsBasis.EXPLICIT_PERMISSION} and (
        evidence_storage_key is None
    ):
        raise _validation("Licensed or explicitly permitted imports need stored evidence")


def _validate_target_credential(credential: CredentialRef) -> None:
    if credential.provider != _NOTEBOOKLM_PROVIDER:
        raise _validation("Import target credential must reference NotebookLM")


def _validate_local_asset(asset: DocumentAsset, command: ImportSourceCommand) -> None:
    if (
        asset.origin is not SourceOrigin.LOCAL
        or "/" in asset.display_filename
        or "\\" in asset.display_filename
        or asset.origin_locator is not None
        or asset.rights_provenance_id != command.rights_provenance_id
        or asset.title != command.title
        or asset.author != command.author
        or asset.derived_from_asset_id is not None
    ):
        raise ValueError("Captured local DocumentAsset metadata does not match the payload")


def _validate_zlibrary_asset(
    asset: DocumentAsset,
    command: ImportSourceCommand,
    provenance: RightsProvenance,
) -> None:
    if (
        asset.origin is not SourceOrigin.ZLIBRARY
        or "/" in asset.display_filename
        or "\\" in asset.display_filename
        or asset.origin_locator != provenance.source_locator_redacted
        or asset.rights_provenance_id != command.rights_provenance_id
        or asset.title != command.title
        or asset.author != command.author
        or asset.derived_from_asset_id is not None
    ):
        raise _validation("Z-Library Adapter returned mismatched DocumentAsset metadata")


def _build_import_command(
    command: ImportSourceCommand,
    root: DocumentAsset,
    prepared: PreparedDocument,
) -> ImportBookCommand:
    from diandianreading.application.use_cases.import_book import ImportBookCommand

    return ImportBookCommand(
        title=command.title,
        author=command.author,
        asset=root,
        derived_assets=prepared.derived_assets,
        parts=prepared.parts,
        manifest=prepared.manifest,
        credential=command.target_credential,
    )


def _validate_prepared_document(
    root: DocumentAsset,
    prepared: PreparedDocument,
    command: ImportSourceCommand,
) -> None:
    try:
        _ = _build_import_command(command, root, prepared)
    except ValueError as error:
        raise _validation("Prepared document output is inconsistent") from error
    capabilities = command.target_capabilities
    if len(prepared.parts) > capabilities.max_sources_per_workspace or any(
        part.mime_type not in capabilities.accepted_mime_types
        or part.word_count > capabilities.max_source_words
        or part.size_bytes > capabilities.max_source_bytes
        for part in prepared.parts
    ):
        raise _validation("Prepared document exceeds persisted target capabilities")
    for asset in prepared.derived_assets:
        if (
            asset.rights_provenance_id != root.rights_provenance_id
            or asset.origin is not root.origin
            or asset.origin_locator != root.origin_locator
        ):
            raise _validation("Prepared DocumentAsset provenance does not match its root")


def _root_asset(assets: Sequence[DocumentAsset]) -> DocumentAsset:
    roots = tuple(asset for asset in assets if asset.derived_from_asset_id is None)
    if len(roots) != 1:
        raise _conflict("Book must have exactly one root DocumentAsset")
    return roots[0]


def _lease_duration(job: Job) -> timedelta:
    if (
        job.status is not JobStatus.RUNNING
        or job.lease_expires_at is None
        or job.lease_expires_at <= job.updated_at
    ):
        raise _conflict("Claimed durable import Job has an invalid Lease")
    return job.lease_expires_at - job.updated_at


def _acquisition_input_hash(command: ImportSourceCommand) -> str:
    return _sha256_text(serialize_import_source_command(command))


def _preparation_input_hash(
    root: DocumentAsset,
    capabilities: TargetCapabilities,
) -> str:
    return _sha256_text(
        _canonical_json(
            {
                "accepted_mime_types": sorted(capabilities.accepted_mime_types),
                "max_source_bytes": capabilities.max_source_bytes,
                "max_source_words": capabilities.max_source_words,
                "max_sources_per_workspace": capabilities.max_sources_per_workspace,
                "root_asset_id": root.id,
                "root_sha256": root.sha256,
            }
        )
    )


def _credential_payload(credential: CredentialRef | None) -> dict[str, str] | None:
    if credential is None:
        return None
    return {"profile": credential.profile, "provider": credential.provider}


def _credential_from_payload(value: object, *, optional: bool) -> CredentialRef | None:
    if value is None:
        if optional:
            return None
        raise ValueError("Credential reference is required")
    credential = _require_object(value, {"profile", "provider"}, "Credential reference")
    return CredentialRef(
        provider=_require_string(credential["provider"], "credential provider"),
        profile=_require_string(credential["profile"], "credential profile"),
    )


def _require_credential(value: object) -> CredentialRef:
    credential = _credential_from_payload(value, optional=False)
    if credential is None:
        raise ValueError("Credential reference is required")
    return credential


def _asset_payload(asset: DocumentAsset | None) -> dict[str, object] | None:
    if asset is None:
        return None
    return {
        "author": asset.author,
        "derived_from_asset_id": asset.derived_from_asset_id,
        "display_filename": asset.display_filename,
        "id": asset.id,
        "mime_type": asset.mime_type,
        "origin": asset.origin.value,
        "origin_locator": asset.origin_locator,
        "rights_provenance_id": asset.rights_provenance_id,
        "sha256": asset.sha256,
        "size_bytes": asset.size_bytes,
        "storage_key": asset.storage_key.value,
        "title": asset.title,
    }


def _asset_from_payload(value: object) -> DocumentAsset | None:
    if value is None:
        return None
    asset = _require_object(
        value,
        {
            "author",
            "derived_from_asset_id",
            "display_filename",
            "id",
            "mime_type",
            "origin",
            "origin_locator",
            "rights_provenance_id",
            "sha256",
            "size_bytes",
            "storage_key",
            "title",
        },
        "Captured DocumentAsset",
    )
    return DocumentAsset(
        id=_require_string(asset["id"], "asset id"),
        storage_key=StorageKey(_require_string(asset["storage_key"], "asset storage key")),
        display_filename=_require_string(asset["display_filename"], "asset display filename"),
        mime_type=_require_string(asset["mime_type"], "asset MIME type"),
        size_bytes=_require_int(asset["size_bytes"], "asset size"),
        sha256=_require_string(asset["sha256"], "asset sha256"),
        title=_optional_string(asset["title"], "asset title"),
        author=_optional_string(asset["author"], "asset author"),
        origin=SourceOrigin(_require_string(asset["origin"], "asset origin")),
        origin_locator=_optional_string(asset["origin_locator"], "asset origin locator"),
        rights_provenance_id=_require_string(
            asset["rights_provenance_id"],
            "asset rights provenance id",
        ),
        derived_from_asset_id=_optional_string(
            asset["derived_from_asset_id"],
            "asset parent id",
        ),
    )


def _require_object(
    value: object,
    expected: set[str],
    field_name: str,
) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ValueError(f"{field_name} fields are invalid")
    unknown_mapping = cast(dict[object, object], value)
    if not all(isinstance(key, str) for key in unknown_mapping):
        raise ValueError(f"{field_name} fields are invalid")
    mapping = cast(dict[str, object], unknown_mapping)
    if set(mapping) != expected:
        raise ValueError(f"{field_name} fields are invalid")
    return mapping


def _require_string(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{field_name} must be a non-empty string")
    return value


def _optional_string(value: object, field_name: str) -> str | None:
    if value is None:
        return None
    return _require_string(value, field_name)


def _require_int(value: object, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{field_name} must be an integer")
    return value


def _validate_canonical_https_url(value: str, *, field_name: str) -> None:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise _validation(f"{field_name} must be canonical, queryless, and credential-free")


def _local_rights_locator(rights_id: str) -> str:
    return f"https://local.invalid/import/{quote(rights_id, safe='')}"


def _normalize_required_metadata(value: str, *, field_name: str) -> str:
    normalized = _normalize_optional_metadata(value)
    if normalized is None:
        raise _validation(f"{field_name} cannot be empty")
    return normalized


def _normalize_optional_metadata(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = " ".join(
        "".join(character for character in value if ord(character) >= 0x20).split()
    )
    return normalized[:200] or None


def _canonical_json(payload: object) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _validation(message: str) -> DiandianError:
    return DiandianError(ErrorCode.VALIDATION, message, retryable=False)


def _conflict(message: str) -> DiandianError:
    return DiandianError(ErrorCode.REPOSITORY_CONFLICT, message, retryable=False)


def _duplicate_source() -> DiandianError:
    return DiandianError(
        ErrorCode.VALIDATION,
        "Document content has already been imported",
        retryable=False,
    )
