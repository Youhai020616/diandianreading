"""Durable import workflow over provider-neutral Ports."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from datetime import datetime
from uuid import uuid4

from diandianreading.application.ports import (
    BestEffortProgressSink,
    KnowledgeIngestionPort,
    NullProgressSink,
    ProgressSink,
    ScopedProgressSink,
    UnitOfWork,
    UnitOfWorkFactory,
)
from diandianreading.domain import (
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
    JobStatus,
    JobStep,
    KnowledgeSourceRef,
    KnowledgeStatus,
    ProgressEvent,
    RemoteOperation,
    RemoteOperationKind,
    RemoteOperationRef,
    RemoteOperationStatus,
    WorkspaceRef,
    utc_now,
)


@dataclass(frozen=True, slots=True)
class ImportBookCommand:
    title: str
    author: str | None
    asset: DocumentAsset
    parts: tuple[DocumentPart, ...]
    credential: CredentialRef

    def __post_init__(self) -> None:
        if not self.title.strip():
            raise ValueError("Import title cannot be empty")
        if not self.parts:
            raise ValueError("At least one DocumentPart is required")
        if any(part.asset_id != self.asset.id for part in self.parts):
            raise ValueError("Every DocumentPart must belong to the command asset")
        sequences = [part.sequence for part in self.parts]
        if sequences != list(range(len(self.parts))):
            raise ValueError("DocumentPart sequences must be contiguous and start at zero")


@dataclass(frozen=True, slots=True)
class ImportBookResult:
    book: Book
    job: Job
    workspace: WorkspaceRef
    sources: tuple[KnowledgeSourceRef, ...]


class ImportBookUseCase:
    """Persist local checkpoints and remote operation intents for one import."""

    def __init__(
        self,
        *,
        unit_of_work: UnitOfWorkFactory,
        knowledge: KnowledgeIngestionPort,
        id_factory: Callable[[], str] | None = None,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self._unit_of_work = unit_of_work
        self._knowledge = knowledge
        self._id_factory = id_factory or (lambda: str(uuid4()))
        self._clock = clock

    async def execute(
        self,
        command: ImportBookCommand,
        progress: ProgressSink | None = None,
    ) -> ImportBookResult:
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
        job = Job.create(
            job_id=self._id_factory(),
            job_type="import_book",
            input_hash=command.asset.sha256,
            book_id=book.id,
            now=timestamp,
        )
        sink = BestEffortProgressSink(
            ScopedProgressSink(job.id, progress or NullProgressSink(job.id))
        )
        import_started = False

        try:
            acquiring = job.advance(JobStep.ACQUIRING, now=self._clock())
            with self._unit_of_work() as unit_of_work:
                unit_of_work.catalog.add_book(book)
                unit_of_work.jobs.add(job)
                unit_of_work.jobs.save_transition(job, acquiring)
                unit_of_work.commit()
            job = acquiring
            import_started = True
            await self._notify_step(job, sink)

            job = await self._advance(
                job,
                JobStep.STORING,
                sink,
                lambda unit_of_work: unit_of_work.catalog.add_asset(book.id, command.asset),
            )

            def save_parts(unit_of_work: UnitOfWork) -> None:
                for part in command.parts:
                    unit_of_work.catalog.add_part(part)

            job = await self._advance(job, JobStep.PREPARING, sink, save_parts)

            workspace_operation = self._persist_operation_intent(
                job,
                kind=RemoteOperationKind.ENSURE_WORKSPACE,
                local_resource_id=book.id,
                input_hash=book.source_hash,
            )
            job = await self._advance(job, JobStep.CREATING_WORKSPACE, sink)
            workspace = await self._knowledge.ensure_workspace(
                book,
                command.credential,
                _operation_ref(workspace_operation),
                sink,
            )
            completed_workspace_operation = workspace_operation.complete(
                workspace.external_id,
                now=self._clock(),
            )
            workspace_timestamp = self._clock()
            external_workspace = ExternalWorkspace(
                id=workspace.id,
                book_id=book.id,
                provider=workspace.provider,
                credential_profile=command.credential.profile,
                external_id=workspace.external_id,
                status=workspace.status,
                created_at=workspace_timestamp,
                updated_at=workspace_timestamp,
            )

            def persist_workspace(unit_of_work: UnitOfWork) -> None:
                unit_of_work.mappings.save_workspace(external_workspace)
                unit_of_work.operations.save(
                    workspace_operation,
                    completed_workspace_operation,
                )

            job = await self._advance(job, JobStep.UPLOADING, sink, persist_workspace)

            uploaded: list[KnowledgeSourceRef] = []
            for index, part in enumerate(command.parts, start=1):
                source_operation = self._persist_operation_intent(
                    job,
                    kind=RemoteOperationKind.ADD_SOURCE,
                    local_resource_id=part.id,
                    input_hash=part.sha256,
                )
                source = await self._knowledge.add_part(
                    workspace,
                    part,
                    _operation_ref(source_operation),
                    sink,
                )
                completed_source_operation = source_operation.complete(
                    source.external_id,
                    now=self._clock(),
                )
                source_timestamp = self._clock()
                external_source = ExternalSource(
                    id=source.id,
                    workspace_id=source.workspace_id,
                    document_part_id=source.document_part_id,
                    external_id=source.external_id,
                    checksum=source.checksum,
                    status=source.status,
                    created_at=source_timestamp,
                    updated_at=source_timestamp,
                )
                progressed = job.report_progress(index, len(command.parts), now=self._clock())
                with self._unit_of_work() as unit_of_work:
                    unit_of_work.mappings.save_source(external_source)
                    unit_of_work.operations.save(
                        source_operation,
                        completed_source_operation,
                    )
                    unit_of_work.jobs.save_transition(job, progressed)
                    unit_of_work.commit()
                job = progressed
                uploaded.append(source)

            job = await self._advance(job, JobStep.PROCESSING, sink)
            ready = tuple(await self._knowledge.wait_sources(workspace, uploaded, sink))
            self._verify_sources(command.parts, workspace, uploaded, ready)

            def persist_ready_sources(unit_of_work: UnitOfWork) -> None:
                ready_by_id = {source.id: source for source in ready}
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
                if any(
                    source.status is not KnowledgeStatus.READY
                    for source in unit_of_work.mappings.list_sources(workspace.id)
                ):
                    raise DiandianError(
                        ErrorCode.SOURCE_PROCESSING_FAILED,
                        "Persisted source mappings are not ready",
                    )

            job = await self._advance(
                job,
                JobStep.VERIFYING,
                sink,
                persist_ready_sources,
            )

            ready_book = replace(book, status=BookStatus.READY, updated_at=self._clock())
            completed_job = job.advance(JobStep.COMPLETED, now=self._clock())
            with self._unit_of_work() as unit_of_work:
                unit_of_work.catalog.update_book(ready_book)
                unit_of_work.jobs.save_transition(job, completed_job)
                unit_of_work.commit()
            book = ready_book
            job = completed_job
            await self._notify_step(job, sink)
            return ImportBookResult(book=book, job=job, workspace=workspace, sources=ready)
        except DiandianError as error:
            if import_started:
                self._record_failure(job.id, error)
            raise
        except Exception as error:
            unexpected = DiandianError(
                ErrorCode.UNEXPECTED,
                "Unexpected import failure",
                retryable=False,
            )
            if import_started:
                self._record_failure(job.id, unexpected)
            raise unexpected from error

    async def _advance(
        self,
        job: Job,
        step: JobStep,
        sink: ProgressSink,
        mutation: Callable[[UnitOfWork], None] | None = None,
    ) -> Job:
        current = job.advance(step, now=self._clock())
        with self._unit_of_work() as unit_of_work:
            if mutation is not None:
                mutation(unit_of_work)
            unit_of_work.jobs.save_transition(job, current)
            unit_of_work.commit()
        await self._notify_step(current, sink)
        return current

    async def _notify_step(self, job: Job, sink: ProgressSink) -> None:
        await sink.emit(
            ProgressEvent(
                job_id=job.id,
                step=job.step.value,
                current=job.progress_current,
                total=job.progress_total,
                message=f"Import step: {job.step.value}",
            )
        )

    def _persist_operation_intent(
        self,
        job: Job,
        *,
        kind: RemoteOperationKind,
        local_resource_id: str,
        input_hash: str,
    ) -> RemoteOperation:
        idempotency_key = f"{job.id}:{kind.value}:{local_resource_id}:{input_hash}"
        with self._unit_of_work() as unit_of_work:
            existing = unit_of_work.operations.get_by_idempotency_key(idempotency_key)
            if existing is not None:
                unit_of_work.commit()
                return existing
            timestamp = self._clock()
            operation = RemoteOperation(
                id=self._id_factory(),
                job_id=job.id,
                kind=kind,
                idempotency_key=idempotency_key,
                local_resource_id=local_resource_id,
                input_hash=input_hash,
                status=RemoteOperationStatus.PENDING,
                external_id=None,
                created_at=timestamp,
                updated_at=timestamp,
                version=0,
            )
            unit_of_work.operations.add(operation)
            unit_of_work.commit()
            return operation

    def _record_failure(self, job_id: str, error: DiandianError) -> None:
        with self._unit_of_work() as unit_of_work:
            persisted_job = unit_of_work.jobs.get(job_id)
            if persisted_job is None or persisted_job.is_terminal:
                unit_of_work.commit()
                return
            failed = persisted_job.fail(
                error.code,
                error.public_message,
                retryable=error.retryable,
                now=self._clock(),
            )
            unit_of_work.jobs.save_transition(persisted_job, failed)
            if failed.status is not JobStatus.BLOCKED and failed.book_id is not None:
                persisted_book = unit_of_work.catalog.get_book(failed.book_id)
                if persisted_book is not None:
                    unit_of_work.catalog.update_book(
                        replace(
                            persisted_book,
                            status=BookStatus.FAILED,
                            updated_at=self._clock(),
                        )
                    )
            unit_of_work.commit()

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
        if len(part_by_id) != len(parts):
            raise _source_verification_error()
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


def _operation_ref(operation: RemoteOperation) -> RemoteOperationRef:
    return RemoteOperationRef(
        id=operation.id,
        idempotency_key=operation.idempotency_key,
        kind=operation.kind,
        local_resource_id=operation.local_resource_id,
        input_hash=operation.input_hash,
        external_id=operation.external_id,
    )


def _source_verification_error() -> DiandianError:
    return DiandianError(
        ErrorCode.SOURCE_PROCESSING_FAILED,
        "Knowledge sources did not become ready with their original identities",
    )
