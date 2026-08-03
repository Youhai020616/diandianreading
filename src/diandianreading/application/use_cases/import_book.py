"""Recoverable import workflow over provider-neutral Ports."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from enum import StrEnum
from typing import Never, Protocol
from uuid import NAMESPACE_URL, uuid4, uuid5

from diandianreading.application.ports import (
    BestEffortProgressSink,
    KnowledgeHealthPort,
    KnowledgeIngestionPort,
    KnowledgeReconciliationPort,
    NullProgressSink,
    ProgressSink,
    ReconciliationStatus,
    ScopedProgressSink,
    UnitOfWork,
    UnitOfWorkFactory,
    source_input_hash,
    workspace_input_hash,
)
from diandianreading.domain import (
    BlockedReason,
    Book,
    BookStatus,
    CredentialRef,
    DiandianError,
    DocumentAsset,
    DocumentPart,
    ErrorCode,
    ExternalSource,
    ExternalWorkspace,
    Job,
    JobPayload,
    JobStatus,
    JobStep,
    JobStepRecord,
    JobStepStatus,
    KnowledgeSourceRef,
    KnowledgeStatus,
    LeaseToken,
    PreparationManifest,
    ProgressEvent,
    RemoteOperation,
    RemoteOperationKind,
    RemoteOperationRef,
    RemoteOperationStatus,
    SourceOrigin,
    StorageKey,
    WorkspaceRef,
    utc_now,
)


class RecoverableKnowledgePort(
    KnowledgeIngestionPort,
    KnowledgeReconciliationPort,
    KnowledgeHealthPort,
    Protocol,
):
    pass


class WorkflowCheckpoint(StrEnum):
    AFTER_STEP_STARTED = "after_step_started"
    AFTER_STEP_CHECKPOINT = "after_step_checkpoint"
    AFTER_INTENT_PREPARED = "after_intent_prepared"
    AFTER_OPERATION_DISPATCHED = "after_operation_dispatched"
    AFTER_PROVIDER_COMMIT = "after_provider_commit"
    AFTER_SOURCE_CHECKPOINT = "after_source_checkpoint"
    SOURCE_WAIT_IN_FLIGHT = "source_wait_in_flight"


WorkflowCheckpointHook = Callable[[WorkflowCheckpoint, str, str | None], None]


@dataclass(frozen=True, slots=True)
class ImportBookCommand:
    title: str
    author: str | None
    asset: DocumentAsset
    parts: tuple[DocumentPart, ...]
    credential: CredentialRef
    derived_assets: tuple[DocumentAsset, ...] = ()
    manifest: PreparationManifest | None = None

    def __post_init__(self) -> None:
        if not self.title.strip():
            raise ValueError("Import title cannot be empty")
        if not self.parts:
            raise ValueError("At least one DocumentPart is required")
        if self.asset.derived_from_asset_id is not None:
            raise ValueError("Import root DocumentAsset cannot be derived from another asset")

        asset_ids = {self.asset.id}
        for derived in self.derived_assets:
            if derived.id in asset_ids:
                raise ValueError("DocumentAsset identities must be unique")
            if derived.derived_from_asset_id not in asset_ids:
                raise ValueError("Derived DocumentAssets must follow an existing parent asset")
            asset_ids.add(derived.id)
        if any(part.asset_id not in asset_ids for part in self.parts):
            raise ValueError("Every DocumentPart must belong to an imported DocumentAsset")
        if len({part.id for part in self.parts}) != len(self.parts):
            raise ValueError("DocumentPart identities must be unique")
        content_identities = {(part.asset_id, part.sha256) for part in self.parts}
        if len(content_identities) != len(self.parts):
            raise ValueError("DocumentPart content must be unique within each DocumentAsset")
        sequences = [part.sequence for part in self.parts]
        if sequences != list(range(len(self.parts))):
            raise ValueError("DocumentPart sequences must be contiguous and start at zero")
        if self.manifest is not None and self.manifest.root_asset_id != self.asset.id:
            raise ValueError("PreparationManifest must describe the command root asset")


@dataclass(frozen=True, slots=True)
class ImportBookResult:
    book: Book
    job: Job
    workspace: WorkspaceRef
    sources: tuple[KnowledgeSourceRef, ...]


class _WorkflowPaused(Exception):
    def __init__(self, error: DiandianError) -> None:
        super().__init__(error.public_message)
        self.error = error


class ImportBookUseCase:
    """Submit and run a lease-fenced, checkpointed import Saga."""

    def __init__(
        self,
        *,
        unit_of_work: UnitOfWorkFactory,
        knowledge: RecoverableKnowledgePort,
        id_factory: Callable[[], str] | None = None,
        clock: Callable[[], datetime] = utc_now,
        lease_duration: timedelta = timedelta(seconds=30),
        retry_delay: timedelta = timedelta(seconds=5),
        max_attempts: int = 3,
        checkpoint_hook: WorkflowCheckpointHook | None = None,
    ) -> None:
        if lease_duration <= timedelta(0) or retry_delay < timedelta(0):
            raise ValueError("Workflow Lease and retry durations must be finite and valid")
        if max_attempts < 1:
            raise ValueError("Workflow max_attempts must be positive")
        self._unit_of_work = unit_of_work
        self._knowledge = knowledge
        self._id_factory = id_factory or (lambda: str(uuid4()))
        self._clock = clock
        self._lease_duration = lease_duration
        self._retry_delay = retry_delay
        self._max_attempts = max_attempts
        self._checkpoint_hook = checkpoint_hook or (lambda checkpoint, job_id, key: None)

    def submit(self, command: ImportBookCommand) -> Job:
        timestamp = self._clock()
        book = Book(
            id=self._id_factory(),
            title=command.title.strip(),
            author=command.author.strip() if command.author else None,
            source_hash=command.asset.sha256,
            status=BookStatus.IMPORTING,
            created_at=timestamp,
            updated_at=timestamp,
        )
        payload_json = _serialize_command(command)
        payload_hash = hashlib.sha256(payload_json.encode()).hexdigest()
        job = Job.create(
            job_id=self._id_factory(),
            job_type="import_book",
            input_hash=payload_hash,
            book_id=book.id,
            now=timestamp,
        )
        payload = JobPayload(
            job_id=job.id,
            payload_type="import_book.v1",
            payload_json=payload_json,
            input_hash=payload_hash,
            created_at=timestamp,
        )
        with self._unit_of_work() as unit_of_work:
            unit_of_work.catalog.add_book(book)
            unit_of_work.jobs.add(job)
            unit_of_work.job_payloads.add(payload)
            unit_of_work.commit()
        return job

    async def execute(
        self,
        command: ImportBookCommand,
        progress: ProgressSink | None = None,
    ) -> ImportBookResult:
        job = self.submit(command)
        return await self.run(
            job.id,
            worker_id=f"inline-{job.id}",
            progress=progress,
        )

    async def run(
        self,
        job_id: str,
        *,
        worker_id: str,
        progress: ProgressSink | None = None,
    ) -> ImportBookResult:
        now = self._clock()
        with self._unit_of_work() as unit_of_work:
            job = unit_of_work.jobs.claim(
                job_id,
                worker_id,
                lease_expires_at=now + self._lease_duration,
                now=now,
            )
            unit_of_work.commit()
        sink = BestEffortProgressSink(
            ScopedProgressSink(job.id, progress or NullProgressSink(job.id))
        )
        token = job.lease_token

        try:
            command = self._load_command(job)
            book = self._require_book(job)
            job = self._check_cancellation(job)
            job = await self._run_local_step(
                job,
                JobStep.ACQUIRING,
                command.asset.sha256,
                _canonical_json({"asset_id": command.asset.id}),
                sink,
            )
            job = await self._run_local_step(
                job,
                JobStep.STORING,
                command.asset.sha256,
                _canonical_json({"storage_key": command.asset.storage_key.value}),
                sink,
                mutation=lambda unit_of_work: unit_of_work.catalog.add_asset(
                    book.id, command.asset
                ),
            )
            preparation_hash = _preparation_input_hash(command)

            def save_prepared_document(unit_of_work: UnitOfWork) -> None:
                for derived in command.derived_assets:
                    unit_of_work.catalog.add_asset(book.id, derived)
                for part in command.parts:
                    unit_of_work.catalog.add_part(part)
                if command.manifest is not None:
                    unit_of_work.catalog.add_manifest(book.id, command.manifest)

            job = await self._run_local_step(
                job,
                JobStep.PREPARING,
                preparation_hash,
                _canonical_json(
                    {
                        "part_ids": [part.id for part in command.parts],
                        "manifest": (
                            command.manifest.storage_key.value if command.manifest else None
                        ),
                    }
                ),
                sink,
                mutation=save_prepared_document,
            )
            workspace, job = await self._ensure_workspace(job, book, command, sink)
            sources, job = await self._upload_sources(job, workspace, command, sink)
            ready, job = await self._wait_sources(job, workspace, command, sources, sink)
            return await self._verify_and_complete(job, book, workspace, command, ready, sink)
        except _WorkflowPaused as paused:
            raise paused.error from None
        except DiandianError as error:
            self._fail_running_job(job.id, error, token)
            raise
        except Exception as error:
            unexpected = DiandianError(
                ErrorCode.UNEXPECTED,
                "Unexpected recoverable import failure",
                retryable=False,
            )
            self._fail_running_job(job.id, unexpected, token)
            raise unexpected from error

    def request_cancel(self, job_id: str) -> Job:
        now = self._clock()
        with self._unit_of_work() as unit_of_work:
            job = unit_of_work.jobs.request_cancel(job_id, now=now)
            if job.status in {JobStatus.QUEUED, JobStatus.BLOCKED}:
                operations = tuple(unit_of_work.operations.list_for_job(job.id))
                if any(
                    operation.status
                    in {RemoteOperationStatus.DISPATCHED, RemoteOperationStatus.AMBIGUOUS}
                    for operation in operations
                ):
                    unit_of_work.commit()
                    return job
                for operation in operations:
                    if operation.status is RemoteOperationStatus.PREPARED:
                        unit_of_work.operations.save(
                            operation,
                            operation.cancel_before_dispatch(now=now),
                        )
                cancelled = job.cancel(now=now)
                unit_of_work.jobs.save_transition(job, cancelled)
                job = cancelled
            unit_of_work.commit()
        return job

    def retry(self, job_id: str) -> Job:
        with self._unit_of_work() as unit_of_work:
            job = unit_of_work.jobs.get(job_id)
            if job is None:
                raise KeyError(f"Unknown Job: {job_id}")
            retried = job.retry(now=self._clock())
            unit_of_work.jobs.save_transition(job, retried)
            unit_of_work.commit()
        return retried

    async def resume_after_auth(self, job_id: str) -> Job:
        with self._unit_of_work() as unit_of_work:
            job = unit_of_work.jobs.get(job_id)
            payload = unit_of_work.job_payloads.get(job_id)
            unit_of_work.commit()
        if job is None or payload is None:
            raise KeyError(f"Unknown Job: {job_id}")
        command = _deserialize_command(payload.payload_json)
        if not await self._knowledge.credential_is_healthy(command.credential):
            raise DiandianError(
                ErrorCode.AUTH_REQUIRED,
                "Provider authentication is still unavailable",
                retryable=False,
            )
        with self._unit_of_work() as unit_of_work:
            current = unit_of_work.jobs.get(job_id)
            if current is None:
                raise KeyError(f"Unknown Job: {job_id}")
            resumed = current.resume(BlockedReason.AUTH_REQUIRED, now=self._clock())
            unit_of_work.jobs.save_transition(current, resumed)
            unit_of_work.commit()
        return resumed

    def resolve_ambiguous_operation(
        self,
        job_id: str,
        idempotency_key: str,
        *,
        external_id: str | None = None,
        confirmed_absent: bool = False,
    ) -> Job:
        if bool(external_id) == confirmed_absent:
            raise ValueError("Choose exactly one ambiguous outcome resolution")
        now = self._clock()
        with self._unit_of_work() as unit_of_work:
            job = unit_of_work.jobs.get(job_id)
            operation = unit_of_work.operations.get_by_idempotency_key(idempotency_key)
            if job is None or operation is None or operation.job_id != job_id:
                raise KeyError("Unknown Job remote operation")
            if job.status is not JobStatus.BLOCKED or job.blocked_reason is not (
                BlockedReason.REMOTE_OUTCOME_AMBIGUOUS
            ):
                raise DiandianError(
                    ErrorCode.VALIDATION,
                    "Job is not blocked on an ambiguous remote outcome",
                    retryable=False,
                )
            if external_id:
                resolved = operation.reconcile(external_id, now=now)
            else:
                resolved = operation.prepare_retry_after_absence(now=now)
            unit_of_work.operations.save(operation, resolved)

            if job.is_cancel_requested and resolved.status is RemoteOperationStatus.PREPARED:
                cancelled_operation = resolved.cancel_before_dispatch(now=now)
                unit_of_work.operations.save(resolved, cancelled_operation)

            unresolved_unknowns = tuple(
                candidate
                for candidate in unit_of_work.operations.list_for_job(job.id)
                if candidate.status
                in {RemoteOperationStatus.DISPATCHED, RemoteOperationStatus.AMBIGUOUS}
            )
            if unresolved_unknowns:
                unit_of_work.commit()
                return job

            if job.is_cancel_requested:
                for candidate in unit_of_work.operations.list_for_job(job.id):
                    if candidate.status is RemoteOperationStatus.PREPARED:
                        unit_of_work.operations.save(
                            candidate,
                            candidate.cancel_before_dispatch(now=now),
                        )
                current = job.cancel(now=now)
            else:
                current = job.resume(BlockedReason.REMOTE_OUTCOME_AMBIGUOUS, now=now)
            unit_of_work.jobs.save_transition(job, current)
            unit_of_work.commit()
        return current

    def heartbeat(self, job_id: str, token: LeaseToken) -> Job:
        now = self._clock()
        with self._unit_of_work() as unit_of_work:
            job = unit_of_work.jobs.heartbeat(
                job_id,
                token,
                lease_expires_at=now + self._lease_duration,
                now=now,
            )
            unit_of_work.commit()
        return job

    async def _run_local_step(
        self,
        job: Job,
        step: JobStep,
        input_hash: str,
        output_ref: str,
        sink: ProgressSink,
        mutation: Callable[[UnitOfWork], None] | None = None,
    ) -> Job:
        job = self._check_cancellation(self._heartbeat(job))
        job, record, already_completed = self._start_step(job, step, input_hash)
        if already_completed:
            return job
        self._checkpoint_hook(WorkflowCheckpoint.AFTER_STEP_STARTED, job.id, step.value)
        completed = record.complete(output_ref, now=self._clock())
        with self._unit_of_work() as unit_of_work:
            if mutation is not None:
                mutation(unit_of_work)
            unit_of_work.job_steps.save(record, completed, job.lease_token)
            unit_of_work.commit()
        self._checkpoint_hook(WorkflowCheckpoint.AFTER_STEP_CHECKPOINT, job.id, step.value)
        await self._notify(job, sink)
        return job

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
                    raise DiandianError(
                        ErrorCode.VALIDATION,
                        "Completed Job Step input fingerprint changed",
                        retryable=False,
                    )
                unit_of_work.commit()
                return job, latest, True

            current = job
            if job.current_step is not step:
                current = job.begin_step(step, job.lease_token, now=self._clock())
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
                raise DiandianError(
                    ErrorCode.VALIDATION,
                    "Active Job Step checkpoint is inconsistent",
                    retryable=False,
                )
            unit_of_work.commit()
        return current, record, False

    async def _ensure_workspace(
        self,
        job: Job,
        book: Book,
        command: ImportBookCommand,
        sink: ProgressSink,
    ) -> tuple[WorkspaceRef, Job]:
        job = self._check_cancellation(self._heartbeat(job))
        job, record, completed = self._start_step(
            job,
            JobStep.CREATING_WORKSPACE,
            workspace_input_hash(book, command.credential),
        )
        persisted = self._workspace_for_book(book.id)
        if completed:
            if persisted is None:
                raise DiandianError(
                    ErrorCode.REPOSITORY_CONFLICT,
                    "Completed workspace Step has no persisted mapping",
                )
            return _workspace_ref(persisted), job

        operation = self._prepare_operation(
            job,
            step=JobStep.CREATING_WORKSPACE,
            kind=RemoteOperationKind.ENSURE_WORKSPACE,
            local_resource_id=book.id,
            input_hash=workspace_input_hash(book, command.credential),
            credential=command.credential,
        )
        workspace = await self._resolve_workspace_operation(
            job,
            record,
            operation,
            book,
            command.credential,
            sink,
        )
        return workspace, job

    async def _resolve_workspace_operation(
        self,
        job: Job,
        record: JobStepRecord,
        operation: RemoteOperation,
        book: Book,
        credential: CredentialRef,
        sink: ProgressSink,
    ) -> WorkspaceRef:
        operation = await self._reconcile_workspace_if_needed(
            job, record, operation, book, credential
        )
        if operation.status in {
            RemoteOperationStatus.SUCCEEDED,
            RemoteOperationStatus.RECONCILED,
        }:
            persisted = self._workspace_for_book(book.id)
            if persisted is not None:
                completed_record = record.complete(
                    _canonical_json({"workspace_id": persisted.id}),
                    now=self._clock(),
                )
                with self._unit_of_work() as unit_of_work:
                    unit_of_work.job_steps.save(record, completed_record, job.lease_token)
                    unit_of_work.commit()
                return _workspace_ref(persisted)
            workspace = await self._knowledge.ensure_workspace(
                book,
                credential,
                _operation_ref(operation),
                sink,
            )
            self._persist_workspace_checkpoint(job, record, operation, book, credential, workspace)
            return workspace

        job = self._check_cancellation(job)
        dispatched = operation.dispatch(now=self._clock())
        with self._unit_of_work() as unit_of_work:
            unit_of_work.operations.save(operation, dispatched, job.lease_token)
            unit_of_work.commit()
        self._checkpoint_hook(
            WorkflowCheckpoint.AFTER_OPERATION_DISPATCHED,
            job.id,
            dispatched.idempotency_key,
        )
        try:
            workspace = await self._knowledge.ensure_workspace(
                book,
                credential,
                _operation_ref(dispatched),
                sink,
            )
        except DiandianError as error:
            self._handle_remote_write_error(job, record, dispatched, error)
        except Exception as error:
            ambiguous = DiandianError(
                ErrorCode.REMOTE_OUTCOME_AMBIGUOUS,
                "Remote workspace outcome is ambiguous",
                retryable=False,
            )
            self._block_ambiguous(job, record, dispatched, ambiguous, cause=error)
        self._checkpoint_hook(
            WorkflowCheckpoint.AFTER_PROVIDER_COMMIT,
            job.id,
            dispatched.idempotency_key,
        )
        self._persist_workspace_checkpoint(job, record, dispatched, book, credential, workspace)
        return workspace

    def _persist_workspace_checkpoint(
        self,
        job: Job,
        record: JobStepRecord,
        operation: RemoteOperation,
        book: Book,
        credential: CredentialRef,
        workspace: WorkspaceRef,
    ) -> None:
        timestamp = self._clock()
        completed_operation = (
            operation
            if operation.status
            in {
                RemoteOperationStatus.SUCCEEDED,
                RemoteOperationStatus.RECONCILED,
            }
            else operation.succeed(workspace.external_id, now=timestamp)
        )
        external_workspace = ExternalWorkspace(
            id=workspace.id,
            book_id=book.id,
            provider=workspace.provider,
            credential_profile=credential.profile,
            external_id=workspace.external_id,
            status=workspace.status,
            created_at=timestamp,
            updated_at=timestamp,
        )
        completed_record = record.complete(
            _canonical_json({"workspace_id": workspace.id}),
            now=timestamp,
        )
        with self._unit_of_work() as unit_of_work:
            unit_of_work.mappings.save_workspace(external_workspace)
            if completed_operation is not operation:
                unit_of_work.operations.save(operation, completed_operation, job.lease_token)
            unit_of_work.job_steps.save(record, completed_record, job.lease_token)
            unit_of_work.commit()
        self._checkpoint_hook(
            WorkflowCheckpoint.AFTER_STEP_CHECKPOINT,
            job.id,
            JobStep.CREATING_WORKSPACE.value,
        )

    async def _upload_sources(
        self,
        job: Job,
        workspace: WorkspaceRef,
        command: ImportBookCommand,
        sink: ProgressSink,
    ) -> tuple[tuple[KnowledgeSourceRef, ...], Job]:
        job = self._check_cancellation(self._heartbeat(job))
        upload_hash = _upload_input_hash(workspace, command.parts)
        job, record, completed = self._start_step(job, JobStep.UPLOADING, upload_hash)
        if completed:
            return self._source_refs(workspace.id), job

        uploaded: list[KnowledgeSourceRef] = []
        for index, part in enumerate(command.parts, start=1):
            job = self._check_cancellation(self._heartbeat(job))
            operation = self._prepare_operation(
                job,
                step=JobStep.UPLOADING,
                kind=RemoteOperationKind.ADD_SOURCE,
                local_resource_id=part.id,
                input_hash=source_input_hash(workspace, part),
                credential=command.credential,
            )
            source = await self._resolve_source_operation(
                job,
                record,
                operation,
                workspace,
                part,
                sink,
            )
            uploaded.append(source)
            record, job = self._save_upload_progress(
                job,
                record,
                index,
                len(command.parts),
            )
            self._checkpoint_hook(
                WorkflowCheckpoint.AFTER_SOURCE_CHECKPOINT,
                job.id,
                operation.idempotency_key,
            )

        completed_record = record.complete(
            _canonical_json({"source_ids": [source.id for source in uploaded]}),
            now=self._clock(),
        )
        with self._unit_of_work() as unit_of_work:
            unit_of_work.job_steps.save(record, completed_record, job.lease_token)
            unit_of_work.commit()
        await self._notify(job, sink)
        return tuple(uploaded), job

    async def _resolve_source_operation(
        self,
        job: Job,
        record: JobStepRecord,
        operation: RemoteOperation,
        workspace: WorkspaceRef,
        part: DocumentPart,
        sink: ProgressSink,
    ) -> KnowledgeSourceRef:
        operation = await self._reconcile_source_if_needed(
            job,
            record,
            operation,
            workspace,
            part,
        )
        existing = {
            source.document_part_id: source for source in self._external_sources(workspace.id)
        }.get(part.id)
        if operation.status in {
            RemoteOperationStatus.SUCCEEDED,
            RemoteOperationStatus.RECONCILED,
        }:
            if existing is not None:
                return _source_ref(existing)
            source = await self._knowledge.add_part(
                workspace,
                part,
                _operation_ref(operation),
                sink,
            )
            self._persist_source_checkpoint(job, operation, source)
            return source

        job = self._check_cancellation(job)
        dispatched = operation.dispatch(now=self._clock())
        with self._unit_of_work() as unit_of_work:
            unit_of_work.operations.save(operation, dispatched, job.lease_token)
            unit_of_work.commit()
        self._checkpoint_hook(
            WorkflowCheckpoint.AFTER_OPERATION_DISPATCHED,
            job.id,
            dispatched.idempotency_key,
        )
        try:
            source = await self._knowledge.add_part(
                workspace,
                part,
                _operation_ref(dispatched),
                sink,
            )
        except DiandianError as error:
            self._handle_remote_write_error(job, record, dispatched, error)
        except Exception as error:
            ambiguous = DiandianError(
                ErrorCode.REMOTE_OUTCOME_AMBIGUOUS,
                "Remote source outcome is ambiguous",
                retryable=False,
            )
            self._block_ambiguous(job, record, dispatched, ambiguous, cause=error)
        self._checkpoint_hook(
            WorkflowCheckpoint.AFTER_PROVIDER_COMMIT,
            job.id,
            dispatched.idempotency_key,
        )
        self._persist_source_checkpoint(job, dispatched, source)
        return source

    def _persist_source_checkpoint(
        self,
        job: Job,
        operation: RemoteOperation,
        source: KnowledgeSourceRef,
    ) -> None:
        timestamp = self._clock()
        completed_operation = (
            operation
            if operation.status
            in {
                RemoteOperationStatus.SUCCEEDED,
                RemoteOperationStatus.RECONCILED,
            }
            else operation.succeed(source.external_id, now=timestamp)
        )
        external_source = ExternalSource(
            id=source.id,
            workspace_id=source.workspace_id,
            document_part_id=source.document_part_id,
            external_id=source.external_id,
            checksum=source.checksum,
            status=source.status,
            created_at=timestamp,
            updated_at=timestamp,
        )
        with self._unit_of_work() as unit_of_work:
            unit_of_work.jobs.assert_lease(job.id, job.lease_token)
            unit_of_work.mappings.save_source(external_source)
            if completed_operation is not operation:
                unit_of_work.operations.save(operation, completed_operation, job.lease_token)
            unit_of_work.commit()

    def _save_upload_progress(
        self,
        job: Job,
        record: JobStepRecord,
        current: int,
        total: int,
    ) -> tuple[JobStepRecord, Job]:
        effective_current = max(
            current,
            record.progress_current or 0,
            job.progress_current or 0,
        )
        progressed_record = record.report_progress(effective_current, total)
        progressed_job = job.report_progress(
            effective_current,
            total,
            job.lease_token,
            now=self._clock(),
        )
        with self._unit_of_work() as unit_of_work:
            unit_of_work.job_steps.save(record, progressed_record, job.lease_token)
            unit_of_work.jobs.save_transition(job, progressed_job)
            unit_of_work.commit()
        return progressed_record, progressed_job

    async def _wait_sources(
        self,
        job: Job,
        workspace: WorkspaceRef,
        command: ImportBookCommand,
        sources: Sequence[KnowledgeSourceRef],
        sink: ProgressSink,
    ) -> tuple[tuple[KnowledgeSourceRef, ...], Job]:
        job = self._check_cancellation(self._heartbeat(job))
        processing_hash = _processing_input_hash(workspace, sources)
        job, record, completed = self._start_step(job, JobStep.PROCESSING, processing_hash)
        if completed:
            return self._source_refs(workspace.id), job
        self._checkpoint_hook(WorkflowCheckpoint.SOURCE_WAIT_IN_FLIGHT, job.id, None)
        try:
            ready = tuple(await self._knowledge.wait_sources(workspace, sources, sink))
        except DiandianError as error:
            self._handle_read_error(job, record, error)
        self._verify_sources(command.parts, workspace, sources, ready)
        ready_by_id = {source.id: source for source in ready}
        completed_record = record.complete(
            _canonical_json({"ready_source_ids": sorted(ready_by_id)}),
            now=self._clock(),
        )
        with self._unit_of_work() as unit_of_work:
            persisted = tuple(unit_of_work.mappings.list_sources(workspace.id))
            if {source.id for source in persisted} != set(ready_by_id):
                raise DiandianError(
                    ErrorCode.SOURCE_PROCESSING_FAILED,
                    "Persisted source mappings do not match provider results",
                )
            for source in persisted:
                unit_of_work.mappings.save_source(
                    replace(
                        source,
                        status=ready_by_id[source.id].status,
                        updated_at=self._clock(),
                    )
                )
            unit_of_work.job_steps.save(record, completed_record, job.lease_token)
            unit_of_work.commit()
        return ready, job

    async def _verify_and_complete(
        self,
        job: Job,
        book: Book,
        workspace: WorkspaceRef,
        command: ImportBookCommand,
        ready: Sequence[KnowledgeSourceRef],
        sink: ProgressSink,
    ) -> ImportBookResult:
        job = self._check_cancellation(self._heartbeat(job))
        verifying_hash = _processing_input_hash(workspace, ready)
        job, record, completed = self._start_step(job, JobStep.VERIFYING, verifying_hash)
        persisted_sources = self._external_sources(workspace.id)
        if len(persisted_sources) != len(command.parts) or any(
            source.status is not KnowledgeStatus.READY for source in persisted_sources
        ):
            raise DiandianError(
                ErrorCode.SOURCE_PROCESSING_FAILED,
                "Not all expected sources are ready",
            )
        operations = self._operations(job.id)
        if any(operation.is_unresolved for operation in operations):
            raise DiandianError(
                ErrorCode.REMOTE_OUTCOME_AMBIGUOUS,
                "Import cannot complete with unresolved remote operations",
                retryable=False,
            )
        ready_book = replace(book, status=BookStatus.READY, updated_at=self._clock())
        completed_job = job.complete(job.lease_token, now=self._clock())
        completed_record = (
            record
            if completed
            else record.complete(
                _canonical_json({"verified_source_count": len(persisted_sources)}),
                now=self._clock(),
            )
        )
        with self._unit_of_work() as unit_of_work:
            unit_of_work.catalog.update_book(ready_book)
            if not completed:
                unit_of_work.job_steps.save(record, completed_record, job.lease_token)
            unit_of_work.jobs.save_transition(job, completed_job)
            unit_of_work.commit()
        await self._notify(completed_job, sink)
        return ImportBookResult(
            book=ready_book,
            job=completed_job,
            workspace=workspace,
            sources=tuple(_source_ref(source) for source in persisted_sources),
        )

    async def _reconcile_workspace_if_needed(
        self,
        job: Job,
        record: JobStepRecord,
        operation: RemoteOperation,
        book: Book,
        credential: CredentialRef,
    ) -> RemoteOperation:
        if operation.status not in {
            RemoteOperationStatus.DISPATCHED,
            RemoteOperationStatus.AMBIGUOUS,
        }:
            return operation
        result = await self._knowledge.reconcile_workspace(book, credential, operation)
        return self._apply_reconciliation(job, record, operation, result.status, result.external_id)

    async def _reconcile_source_if_needed(
        self,
        job: Job,
        record: JobStepRecord,
        operation: RemoteOperation,
        workspace: WorkspaceRef,
        part: DocumentPart,
    ) -> RemoteOperation:
        if operation.status not in {
            RemoteOperationStatus.DISPATCHED,
            RemoteOperationStatus.AMBIGUOUS,
        }:
            return operation
        result = await self._knowledge.reconcile_source(workspace, part, operation)
        return self._apply_reconciliation(job, record, operation, result.status, result.external_id)

    def _apply_reconciliation(
        self,
        job: Job,
        record: JobStepRecord,
        operation: RemoteOperation,
        status: ReconciliationStatus,
        external_id: str | None,
    ) -> RemoteOperation:
        if status is ReconciliationStatus.RECOVERED:
            assert external_id is not None
            reconciled = operation.reconcile(external_id, now=self._clock())
        elif status is ReconciliationStatus.PROVEN_ABSENT:
            reconciled = operation.prepare_retry_after_absence(now=self._clock())
        else:
            error = DiandianError(
                ErrorCode.REMOTE_OUTCOME_AMBIGUOUS,
                "Remote operation outcome requires explicit resolution",
                retryable=False,
            )
            self._block_ambiguous(job, record, operation, error)
        with self._unit_of_work() as unit_of_work:
            unit_of_work.operations.save(operation, reconciled, job.lease_token)
            unit_of_work.commit()
        return reconciled

    def _prepare_operation(
        self,
        job: Job,
        *,
        step: JobStep,
        kind: RemoteOperationKind,
        local_resource_id: str,
        input_hash: str,
        credential: CredentialRef,
    ) -> RemoteOperation:
        idempotency_key = f"{job.id}:{kind.value}:{local_resource_id}:{input_hash}"
        with self._unit_of_work() as unit_of_work:
            existing = unit_of_work.operations.get_by_idempotency_key(idempotency_key)
            if existing is not None:
                unit_of_work.commit()
                return existing
            timestamp = self._clock()
            operation = RemoteOperation(
                id=str(uuid5(NAMESPACE_URL, f"diandianreading:operation:{idempotency_key}")),
                job_id=job.id,
                step=step,
                provider=credential.provider,
                credential_profile=credential.profile,
                kind=kind,
                idempotency_key=idempotency_key,
                local_resource_id=local_resource_id,
                input_hash=input_hash,
                probe_strategy=self._knowledge.probe_strategy,
                baseline_snapshot_redacted="{}",
                request_summary_redacted=_canonical_json(
                    {"kind": kind.value, "local_resource_id": local_resource_id}
                ),
                status=RemoteOperationStatus.PREPARED,
                dispatch_attempt=0,
                external_id=None,
                created_at=timestamp,
                updated_at=timestamp,
                dispatched_at=None,
                resolved_at=None,
                version=0,
            )
            unit_of_work.operations.add(operation, job.lease_token)
            unit_of_work.commit()
        self._checkpoint_hook(
            WorkflowCheckpoint.AFTER_INTENT_PREPARED,
            job.id,
            operation.idempotency_key,
        )
        return operation

    def _handle_remote_write_error(
        self,
        job: Job,
        record: JobStepRecord,
        operation: RemoteOperation,
        error: DiandianError,
    ) -> Never:
        if error.code is ErrorCode.AUTH_REQUIRED:
            prepared = operation.prepare_retry_after_absence(now=self._clock())
            self._pause_job(
                job,
                record,
                error,
                blocked_reason=BlockedReason.AUTH_REQUIRED,
                operation_previous=operation,
                operation_current=prepared,
            )
        if error.code is ErrorCode.REMOTE_RATE_LIMITED and job.attempt < self._max_attempts:
            prepared = operation.prepare_retry_after_absence(now=self._clock())
            self._pause_job(
                job,
                record,
                error,
                retry=True,
                operation_previous=operation,
                operation_current=prepared,
            )
        if error.code in {
            ErrorCode.REMOTE_UNAVAILABLE,
            ErrorCode.DOWNLOAD_TIMEOUT,
            ErrorCode.REMOTE_OUTCOME_AMBIGUOUS,
        }:
            self._block_ambiguous(job, record, operation, error)
        failed_operation = operation.fail_terminal(now=self._clock())
        self._pause_job(
            job,
            record,
            error,
            terminal=True,
            operation_previous=operation,
            operation_current=failed_operation,
        )

    def _handle_read_error(
        self,
        job: Job,
        record: JobStepRecord,
        error: DiandianError,
    ) -> Never:
        if error.code is ErrorCode.AUTH_REQUIRED:
            self._pause_job(
                job,
                record,
                error,
                blocked_reason=BlockedReason.AUTH_REQUIRED,
            )
        if error.retryable and job.attempt < self._max_attempts:
            self._pause_job(job, record, error, retry=True)
        self._pause_job(job, record, error, terminal=True)

    def _block_ambiguous(
        self,
        job: Job,
        record: JobStepRecord,
        operation: RemoteOperation,
        error: DiandianError,
        *,
        cause: Exception | None = None,
    ) -> Never:
        ambiguous = (
            operation
            if operation.status is RemoteOperationStatus.AMBIGUOUS
            else operation.mark_ambiguous(now=self._clock())
        )
        self._pause_job(
            job,
            record,
            error,
            blocked_reason=BlockedReason.REMOTE_OUTCOME_AMBIGUOUS,
            operation_previous=operation,
            operation_current=ambiguous,
            cause=cause,
        )

    def _pause_job(
        self,
        job: Job,
        record: JobStepRecord,
        error: DiandianError,
        *,
        blocked_reason: BlockedReason | None = None,
        retry: bool = False,
        terminal: bool = False,
        operation_previous: RemoteOperation | None = None,
        operation_current: RemoteOperation | None = None,
        cause: Exception | None = None,
    ) -> Never:
        if sum((blocked_reason is not None, retry, terminal)) != 1:
            raise ValueError("Workflow pause must choose one Job outcome")
        now = self._clock()
        if blocked_reason is not None:
            current = job.block(
                blocked_reason,
                error.code,
                error.public_message,
                job.lease_token,
                now=now,
            )
            current_record = record.block(error.code, error.public_message, now=now)
        elif retry:
            current = job.queue_retry(
                error.code,
                error.public_message,
                job.lease_token,
                not_before=now + self._retry_delay,
                now=now,
            )
            current_record = record.fail(error.code, error.public_message, now=now)
        else:
            current = job.fail(
                error.code,
                error.public_message,
                job.lease_token,
                retriable=error.retryable,
                now=now,
            )
            current_record = record.fail(error.code, error.public_message, now=now)
        with self._unit_of_work() as unit_of_work:
            if operation_previous is not None and operation_current is not None:
                unit_of_work.operations.save(
                    operation_previous,
                    operation_current,
                    job.lease_token,
                )
            unit_of_work.job_steps.save(record, current_record, job.lease_token)
            unit_of_work.jobs.save_transition(job, current)
            if terminal and current.book_id is not None:
                book = unit_of_work.catalog.get_book(current.book_id)
                if book is not None:
                    unit_of_work.catalog.update_book(
                        replace(book, status=BookStatus.FAILED, updated_at=now)
                    )
            unit_of_work.commit()
        raise _WorkflowPaused(error) from cause

    def _check_cancellation(self, job: Job) -> Job:
        with self._unit_of_work() as unit_of_work:
            persisted = unit_of_work.jobs.get(job.id)
            if persisted is None:
                raise KeyError(f"Unknown Job: {job.id}")
            persisted.assert_lease(job.lease_token)
            if not persisted.is_cancel_requested:
                unit_of_work.commit()
                return persisted

            now = self._clock()
            active_record = (
                unit_of_work.job_steps.get(
                    persisted.id,
                    persisted.current_step,
                    persisted.attempt,
                )
                if persisted.current_step is not None
                else None
            )
            unresolved = tuple(
                operation
                for operation in unit_of_work.operations.list_for_job(job.id)
                if operation.status
                in {RemoteOperationStatus.DISPATCHED, RemoteOperationStatus.AMBIGUOUS}
            )
            if unresolved:
                message = "Cancellation is waiting for remote outcome reconciliation"
                blocked = persisted.block(
                    BlockedReason.REMOTE_OUTCOME_AMBIGUOUS,
                    ErrorCode.REMOTE_OUTCOME_AMBIGUOUS,
                    message,
                    persisted.lease_token,
                    now=now,
                )
                if active_record is not None and active_record.status is JobStepStatus.RUNNING:
                    unit_of_work.job_steps.save(
                        active_record,
                        active_record.block(
                            ErrorCode.REMOTE_OUTCOME_AMBIGUOUS,
                            message,
                            now=now,
                        ),
                        persisted.lease_token,
                    )
                unit_of_work.jobs.save_transition(persisted, blocked)
                unit_of_work.commit()
                raise _WorkflowPaused(
                    DiandianError(
                        ErrorCode.REMOTE_OUTCOME_AMBIGUOUS,
                        message,
                        retryable=False,
                    )
                )

            for operation in unit_of_work.operations.list_for_job(job.id):
                if operation.status is RemoteOperationStatus.PREPARED:
                    unit_of_work.operations.save(
                        operation,
                        operation.cancel_before_dispatch(now=now),
                        persisted.lease_token,
                    )
            if active_record is not None and active_record.status in {
                JobStepStatus.RUNNING,
                JobStepStatus.BLOCKED,
            }:
                unit_of_work.job_steps.save(
                    active_record,
                    active_record.cancel(now=now),
                    persisted.lease_token,
                )
            cancelled = persisted.cancel(token=persisted.lease_token, now=now)
            unit_of_work.jobs.save_transition(persisted, cancelled)
            unit_of_work.commit()
        raise _WorkflowPaused(DiandianError(ErrorCode.CANCELLED, "Job cancelled", retryable=False))

    def _heartbeat(self, job: Job) -> Job:
        return self.heartbeat(job.id, job.lease_token)

    def _fail_running_job(
        self,
        job_id: str,
        error: DiandianError,
        token: LeaseToken,
    ) -> None:
        with self._unit_of_work() as unit_of_work:
            job = unit_of_work.jobs.get(job_id)
            if (
                job is None
                or job.status is not JobStatus.RUNNING
                or job.lease_owner != token.owner
                or job.lease_generation != token.generation
            ):
                unit_of_work.commit()
                return

            now = self._clock()
            active_record = (
                unit_of_work.job_steps.get(job.id, job.current_step, job.attempt)
                if job.current_step is not None
                else None
            )
            unknown_operations = tuple(
                operation
                for operation in unit_of_work.operations.list_for_job(job.id)
                if operation.status
                in {RemoteOperationStatus.DISPATCHED, RemoteOperationStatus.AMBIGUOUS}
            )
            if unknown_operations:
                message = "Remote operation outcome requires reconciliation"
                current = job.block(
                    BlockedReason.REMOTE_OUTCOME_AMBIGUOUS,
                    ErrorCode.REMOTE_OUTCOME_AMBIGUOUS,
                    message,
                    token,
                    now=now,
                )
                if active_record is not None and active_record.status is JobStepStatus.RUNNING:
                    unit_of_work.job_steps.save(
                        active_record,
                        active_record.block(
                            ErrorCode.REMOTE_OUTCOME_AMBIGUOUS,
                            message,
                            now=now,
                        ),
                        token,
                    )
            elif error.retryable and job.attempt < self._max_attempts:
                current = job.queue_retry(
                    error.code,
                    error.public_message,
                    token,
                    not_before=now + self._retry_delay,
                    now=now,
                )
                if active_record is not None and active_record.status in {
                    JobStepStatus.RUNNING,
                    JobStepStatus.BLOCKED,
                }:
                    unit_of_work.job_steps.save(
                        active_record,
                        active_record.fail(error.code, error.public_message, now=now),
                        token,
                    )
            else:
                current = job.fail(
                    error.code,
                    error.public_message,
                    token,
                    retriable=error.retryable,
                    now=now,
                )
                if active_record is not None and active_record.status in {
                    JobStepStatus.RUNNING,
                    JobStepStatus.BLOCKED,
                }:
                    unit_of_work.job_steps.save(
                        active_record,
                        active_record.fail(error.code, error.public_message, now=now),
                        token,
                    )
                for operation in unit_of_work.operations.list_for_job(job.id):
                    if operation.status is RemoteOperationStatus.PREPARED:
                        unit_of_work.operations.save(
                            operation,
                            operation.fail_terminal(now=now),
                            token,
                        )
                if job.book_id is not None:
                    book = unit_of_work.catalog.get_book(job.book_id)
                    if book is not None:
                        unit_of_work.catalog.update_book(
                            replace(book, status=BookStatus.FAILED, updated_at=now)
                        )
            unit_of_work.jobs.save_transition(job, current)
            unit_of_work.commit()

    def _load_command(self, job: Job) -> ImportBookCommand:
        with self._unit_of_work() as unit_of_work:
            payload = unit_of_work.job_payloads.get(job.id)
            unit_of_work.commit()
        if payload is None or payload.payload_type != "import_book.v1":
            raise DiandianError(
                ErrorCode.REPOSITORY_CONFLICT,
                "Import Job payload is unavailable",
                retryable=False,
            )
        actual_hash = hashlib.sha256(payload.payload_json.encode()).hexdigest()
        if actual_hash != payload.input_hash or actual_hash != job.input_hash:
            raise DiandianError(
                ErrorCode.REPOSITORY_CONFLICT,
                "Import Job payload fingerprint does not match",
                retryable=False,
            )
        return _deserialize_command(payload.payload_json)

    def _require_book(self, job: Job) -> Book:
        if job.book_id is None:
            raise DiandianError(
                ErrorCode.REPOSITORY_CONFLICT,
                "Import Job has no Book",
                retryable=False,
            )
        with self._unit_of_work() as unit_of_work:
            book = unit_of_work.catalog.get_book(job.book_id)
            unit_of_work.commit()
        if book is None:
            raise DiandianError(
                ErrorCode.REPOSITORY_CONFLICT,
                "Import Job Book is unavailable",
                retryable=False,
            )
        return book

    def _workspace_for_book(self, book_id: str) -> ExternalWorkspace | None:
        with self._unit_of_work() as unit_of_work:
            workspace = unit_of_work.mappings.get_workspace_for_book(book_id)
            unit_of_work.commit()
        return workspace

    def _external_sources(self, workspace_id: str) -> tuple[ExternalSource, ...]:
        with self._unit_of_work() as unit_of_work:
            sources = tuple(unit_of_work.mappings.list_sources(workspace_id))
            unit_of_work.commit()
        return sources

    def _source_refs(self, workspace_id: str) -> tuple[KnowledgeSourceRef, ...]:
        return tuple(_source_ref(source) for source in self._external_sources(workspace_id))

    def _operations(self, job_id: str) -> tuple[RemoteOperation, ...]:
        with self._unit_of_work() as unit_of_work:
            operations = tuple(unit_of_work.operations.list_for_job(job_id))
            unit_of_work.commit()
        return operations

    async def _notify(self, job: Job, sink: ProgressSink) -> None:
        step = job.current_step.value if job.current_step is not None else "queued"
        await sink.emit(
            ProgressEvent(
                job_id=job.id,
                step=step,
                current=job.progress_current,
                total=job.progress_total,
                message=f"Import step: {step}",
            )
        )

    @staticmethod
    def _verify_sources(
        parts: Sequence[DocumentPart],
        workspace: WorkspaceRef,
        uploaded: Sequence[KnowledgeSourceRef],
        ready: Sequence[KnowledgeSourceRef],
    ) -> None:
        if len(uploaded) != len(parts) or len(ready) != len(uploaded):
            raise _source_verification_error()
        uploaded_by_id = {source.id: source for source in uploaded}
        ready_by_id = {source.id: source for source in ready}
        if len(uploaded_by_id) != len(uploaded) or len(ready_by_id) != len(ready):
            raise _source_verification_error()
        if set(uploaded_by_id) != set(ready_by_id):
            raise _source_verification_error()
        part_by_id = {part.id: part for part in parts}
        for source_id, ready_source in ready_by_id.items():
            uploaded_source = uploaded_by_id[source_id]
            part = part_by_id.get(uploaded_source.document_part_id)
            if (
                part is None
                or ready_source.workspace_id != workspace.id
                or ready_source.document_part_id != uploaded_source.document_part_id
                or ready_source.external_id != uploaded_source.external_id
                or ready_source.checksum != uploaded_source.checksum
                or ready_source.checksum != part.sha256
                or ready_source.status is not KnowledgeStatus.READY
            ):
                raise _source_verification_error()


def _serialize_command(command: ImportBookCommand) -> str:
    return _canonical_json(
        {
            "title": command.title,
            "author": command.author,
            "asset": _asset_payload(command.asset),
            "derived_assets": [_asset_payload(asset) for asset in command.derived_assets],
            "parts": [_part_payload(part) for part in command.parts],
            "credential": {
                "provider": command.credential.provider,
                "profile": command.credential.profile,
            },
            "manifest": (
                {
                    "root_asset_id": command.manifest.root_asset_id,
                    "storage_key": command.manifest.storage_key.value,
                    "sha256": command.manifest.sha256,
                }
                if command.manifest
                else None
            ),
        }
    )


def _deserialize_command(payload_json: str) -> ImportBookCommand:
    payload = json.loads(payload_json)
    if not isinstance(payload, dict):
        raise ValueError("Import Job payload must be an object")
    credential = payload["credential"]
    manifest = payload.get("manifest")
    if not isinstance(credential, dict):
        raise ValueError("Import Job credential reference is invalid")
    return ImportBookCommand(
        title=str(payload["title"]),
        author=str(payload["author"]) if payload.get("author") is not None else None,
        asset=_asset_from_payload(payload["asset"]),
        derived_assets=tuple(_asset_from_payload(item) for item in payload["derived_assets"]),
        parts=tuple(_part_from_payload(item) for item in payload["parts"]),
        credential=CredentialRef(str(credential["provider"]), str(credential["profile"])),
        manifest=(
            PreparationManifest(
                root_asset_id=str(manifest["root_asset_id"]),
                storage_key=StorageKey(str(manifest["storage_key"])),
                sha256=str(manifest["sha256"]),
            )
            if isinstance(manifest, dict)
            else None
        ),
    )


def _asset_payload(asset: DocumentAsset) -> dict[str, object]:
    return {
        "id": asset.id,
        "storage_key": asset.storage_key.value,
        "display_filename": asset.display_filename,
        "mime_type": asset.mime_type,
        "size_bytes": asset.size_bytes,
        "sha256": asset.sha256,
        "title": asset.title,
        "author": asset.author,
        "origin": asset.origin.value,
        "origin_locator": asset.origin_locator,
        "rights_provenance_id": asset.rights_provenance_id,
        "derived_from_asset_id": asset.derived_from_asset_id,
    }


def _asset_from_payload(value: object) -> DocumentAsset:
    if not isinstance(value, dict):
        raise ValueError("Import Job asset payload is invalid")
    return DocumentAsset(
        id=str(value["id"]),
        storage_key=StorageKey(str(value["storage_key"])),
        display_filename=str(value["display_filename"]),
        mime_type=str(value["mime_type"]),
        size_bytes=int(str(value["size_bytes"])),
        sha256=str(value["sha256"]),
        title=str(value["title"]) if value.get("title") is not None else None,
        author=str(value["author"]) if value.get("author") is not None else None,
        origin=SourceOrigin(str(value["origin"])),
        origin_locator=(
            str(value["origin_locator"]) if value.get("origin_locator") is not None else None
        ),
        rights_provenance_id=str(value["rights_provenance_id"]),
        derived_from_asset_id=(
            str(value["derived_from_asset_id"])
            if value.get("derived_from_asset_id") is not None
            else None
        ),
    )


def _part_payload(part: DocumentPart) -> dict[str, object]:
    return {
        "id": part.id,
        "asset_id": part.asset_id,
        "sequence": part.sequence,
        "storage_key": part.storage_key.value,
        "mime_type": part.mime_type,
        "word_count": part.word_count,
        "sha256": part.sha256,
        "chapter_refs": list(part.chapter_refs),
        "size_bytes": part.size_bytes,
    }


def _part_from_payload(value: object) -> DocumentPart:
    if not isinstance(value, dict) or not isinstance(value.get("chapter_refs"), list):
        raise ValueError("Import Job part payload is invalid")
    return DocumentPart(
        id=str(value["id"]),
        asset_id=str(value["asset_id"]),
        sequence=int(str(value["sequence"])),
        storage_key=StorageKey(str(value["storage_key"])),
        mime_type=str(value["mime_type"]),
        word_count=int(str(value["word_count"])),
        sha256=str(value["sha256"]),
        chapter_refs=tuple(str(item) for item in value["chapter_refs"]),
        size_bytes=int(str(value["size_bytes"])),
    )


def _preparation_input_hash(command: ImportBookCommand) -> str:
    return _hash_payload(
        {
            "root": command.asset.sha256,
            "derived": [asset.sha256 for asset in command.derived_assets],
            "parts": [part.sha256 for part in command.parts],
            "manifest": command.manifest.sha256 if command.manifest else None,
        }
    )


def _upload_input_hash(
    workspace: WorkspaceRef,
    parts: Sequence[DocumentPart],
) -> str:
    return _hash_payload(
        {
            "workspace_id": workspace.id,
            "workspace_external_id": workspace.external_id,
            "parts": [{"id": part.id, "sha256": part.sha256} for part in parts],
        }
    )


def _processing_input_hash(
    workspace: WorkspaceRef,
    sources: Sequence[KnowledgeSourceRef],
) -> str:
    return _hash_payload(
        {
            "workspace_id": workspace.id,
            "sources": [
                {
                    "id": source.id,
                    "external_id": source.external_id,
                    "checksum": source.checksum,
                }
                for source in sources
            ],
        }
    )


def _hash_payload(payload: object) -> str:
    return hashlib.sha256(_canonical_json(payload).encode()).hexdigest()


def _canonical_json(payload: object) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _operation_ref(operation: RemoteOperation) -> RemoteOperationRef:
    return RemoteOperationRef(
        id=operation.id,
        idempotency_key=operation.idempotency_key,
        kind=operation.kind,
        local_resource_id=operation.local_resource_id,
        input_hash=operation.input_hash,
        external_id=operation.external_id,
    )


def _workspace_ref(workspace: ExternalWorkspace) -> WorkspaceRef:
    return WorkspaceRef(
        id=workspace.id,
        provider=workspace.provider,
        external_id=workspace.external_id,
        status=workspace.status,
    )


def _source_ref(source: ExternalSource) -> KnowledgeSourceRef:
    return KnowledgeSourceRef(
        id=source.id,
        workspace_id=source.workspace_id,
        document_part_id=source.document_part_id,
        external_id=source.external_id,
        checksum=source.checksum,
        status=source.status,
    )


def _source_verification_error() -> DiandianError:
    return DiandianError(
        ErrorCode.SOURCE_PROCESSING_FAILED,
        "Knowledge sources did not become ready with their original identities",
    )
