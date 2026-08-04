"""R4 selection/notes QueryScope use-case tests over real SQLite persistence.

Fake provider + fake verifier + real SQLite chat and annotation repositories, covering
ai-chat.md §4: supplemental-context delimiting, §4.3 three-state source semantics,
ownership validation, SOURCE_NOT_READY on empty explicit scopes, durable effective
scopes, and idempotent replay.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import final

import pytest

from diandianreading.application.ports.knowledge import KnowledgeAnswer, KnowledgeReference
from diandianreading.application.use_cases.chat import (
    ChatUseCase,
    ChatUseCaseError,
    SubmitChatCommand,
    _ResolvedQuery,
)
from diandianreading.domain.annotations import (
    Annotation,
    AnnotationColor,
    AnnotationKind,
    AnnotationStatus,
    ContentAnchor,
    TextQuote,
)
from diandianreading.domain.chat import (
    ChatErrorCode,
    ChatReferenceLocationType,
    ChatRunStatus,
    EffectiveBookScope,
    QueryScope,
    QueryScopeType,
    SelectionLocator,
    SupplementalContextKind,
    supplemental_text_hash,
)
from diandianreading.domain.models import (
    Book,
    BookStatus,
    CredentialRef,
    ExternalSource,
    ExternalWorkspace,
    KnowledgeStatus,
    WorkspaceRef,
)
from diandianreading.infrastructure.persistence.annotations import SQLiteAnnotationRepository
from diandianreading.infrastructure.persistence.chat import SQLiteChatRepository
from diandianreading.infrastructure.persistence.sqlite import (
    SQLiteCatalogRepository,
    SQLiteDatabase,
    SQLiteKnowledgeMappingRepository,
)
from tests.support import FIXED_NOW, make_import_command

_SELECTION_TEXT = "好的设计应该让正确的行为变得自然。"
_LOCATOR = SelectionLocator(
    ChatReferenceLocationType.MARKDOWN_OFFSET,
    "0-16@" + "a" * 64,
)


@dataclass(slots=True)
class MutableClock:
    current: datetime = FIXED_NOW

    def __call__(self) -> datetime:
        return self.current

    def advance(self, delta: timedelta) -> None:
        self.current += delta


@final
class SequentialIds:
    def __init__(self) -> None:
        self._value = 0

    def __call__(self) -> str:
        self._value += 1
        return f"scope-local-{self._value}"


@dataclass(frozen=True, slots=True)
class AskCall:
    workspace_id: str
    question: str
    external_source_ids: tuple[str, ...] | None
    provider_conversation_id: str | None


@final
class FakeKnowledge:
    def __init__(self) -> None:
        self.healthy = True
        self.calls: list[AskCall] = []
        self.answer = KnowledgeAnswer(
            answer="A grounded scoped answer [1].",
            conversation_id="provider-conversation-secret",
            references=(
                KnowledgeReference(
                    external_source_id="provider-source-secret-1",
                    document_part_id="part-0",
                    excerpt="A cited passage.",
                ),
            ),
        )

    async def credential_is_healthy(self, credential: CredentialRef) -> bool:
        del credential
        return self.healthy

    async def ask(
        self,
        workspace: WorkspaceRef,
        question: str,
        external_source_ids: Sequence[str] | None,
        provider_conversation_id: str | None,
    ) -> KnowledgeAnswer:
        self.calls.append(
            AskCall(
                workspace_id=workspace.id,
                question=question,
                external_source_ids=(
                    None if external_source_ids is None else tuple(external_source_ids)
                ),
                provider_conversation_id=provider_conversation_id,
            )
        )
        return self.answer


@dataclass(frozen=True, slots=True)
class VerifyCall:
    book_id: str
    document_part_id: str
    locator: SelectionLocator
    selected_text: str


@dataclass(slots=True)
class FakeSelectionVerifier:
    result: bool = True
    failure: Exception | None = None
    calls: list[VerifyCall] = field(default_factory=list)

    def verify_selection(
        self,
        *,
        book_id: str,
        document_part_id: str,
        locator: SelectionLocator,
        selected_text: str,
    ) -> bool:
        self.calls.append(VerifyCall(book_id, document_part_id, locator, selected_text))
        if self.failure is not None:
            raise self.failure
        return self.result


@dataclass(frozen=True, slots=True)
class ScopeRuntime:
    database: SQLiteDatabase
    use_case: ChatUseCase
    chat_repository: SQLiteChatRepository
    annotations: SQLiteAnnotationRepository
    knowledge: FakeKnowledge
    verifier: FakeSelectionVerifier
    clock: MutableClock
    conversation_id: str
    book: Book


def make_runtime(tmp_path: Path) -> ScopeRuntime:
    database = SQLiteDatabase(tmp_path / "state" / "app.sqlite3")
    assert database.migrate() == 10
    catalog = SQLiteCatalogRepository(database)
    mappings = SQLiteKnowledgeMappingRepository(database)
    command = make_import_command(tmp_path, part_count=2)
    book = Book(
        id="book-1",
        title="Scoped Chat",
        author="Test Author",
        source_hash=command.asset.sha256,
        status=BookStatus.READY,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
    )
    catalog.add_book(book)
    catalog.add_asset(book.id, command.asset)
    for part in command.parts:
        catalog.add_part(part)
    workspace = ExternalWorkspace(
        id="workspace-local-1",
        book_id=book.id,
        provider="fake-provider",
        credential_profile="local-profile",
        external_id="provider-workspace-secret",
        status=KnowledgeStatus.READY,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
    )
    mappings.save_workspace(workspace)
    for index, part in enumerate(command.parts, start=1):
        mappings.save_source(
            _source(workspace.id, part.id, f"provider-source-secret-{index}", part.sha256)
        )
    chat_repository = SQLiteChatRepository(database)
    annotations = SQLiteAnnotationRepository(database)
    knowledge = FakeKnowledge()
    verifier = FakeSelectionVerifier()
    clock = MutableClock()
    use_case = ChatUseCase(
        repository=chat_repository,
        knowledge_query=knowledge,
        knowledge_health=knowledge,
        selection_verifier=verifier,
        annotations=annotations,
        id_factory=SequentialIds(),
        clock=clock,
        lease_duration=timedelta(seconds=5),
    )
    ensured = use_case.ensure_conversation(book.id)
    return ScopeRuntime(
        database=database,
        use_case=use_case,
        chat_repository=chat_repository,
        annotations=annotations,
        knowledge=knowledge,
        verifier=verifier,
        clock=clock,
        conversation_id=ensured.conversation.id,
        book=book,
    )


def _source(
    workspace_id: str,
    part_id: str,
    external_id: str,
    checksum: str,
) -> ExternalSource:
    return ExternalSource(
        id=f"source-{part_id}",
        workspace_id=workspace_id,
        document_part_id=part_id,
        external_id=external_id,
        checksum=checksum,
        status=KnowledgeStatus.READY,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
    )


def selection_command(
    runtime: ScopeRuntime,
    *,
    client_id: str = "selection-1",
    text: str = _SELECTION_TEXT,
    part_id: str = "part-0",
    question: str = "解释这段话",
) -> SubmitChatCommand:
    return SubmitChatCommand(
        conversation_id=runtime.conversation_id,
        client_message_id=client_id,
        question=question,
        query_scope=QueryScope.selection(
            document_part_id=part_id,
            locator=_LOCATOR,
            selected_text=text,
        ),
        selection_text=text,
        idempotency_key=client_id,
    )


def add_note(
    runtime: ScopeRuntime,
    *,
    note_id: str,
    body: str,
    book_id: str | None = None,
    status: AnnotationStatus = AnnotationStatus.ACTIVE,
) -> Annotation:
    annotation = Annotation(
        id=note_id,
        book_id=book_id or runtime.book.id,
        kind=AnnotationKind.NOTE,
        status=AnnotationStatus.ACTIVE,
        anchor=None,
        selected_text=None,
        body=body,
        color=None,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
        version=0,
    )
    runtime.annotations.add(annotation)
    if status is AnnotationStatus.DELETED:
        deleted = annotation.soft_delete(now=FIXED_NOW)
        runtime.annotations.save(annotation, deleted)
        return deleted
    return annotation


def add_highlight(runtime: ScopeRuntime, *, annotation_id: str, text: str) -> Annotation:
    annotation = Annotation(
        id=annotation_id,
        book_id=runtime.book.id,
        kind=AnnotationKind.HIGHLIGHT,
        status=AnnotationStatus.ACTIVE,
        anchor=ContentAnchor(
            type=ChatReferenceLocationType.MARKDOWN_OFFSET,
            anchor_sha256="b" * 64,
            start=0,
            end=len(text),
            quote=TextQuote(exact=text),
        ),
        selected_text=text,
        body="highlight remark",
        color=AnnotationColor.YELLOW,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
        version=0,
    )
    runtime.annotations.add(annotation)
    return annotation


def notes_command(
    runtime: ScopeRuntime,
    note_ids: tuple[str, ...],
    *,
    client_id: str = "notes-1",
    question: str = "把它和我的笔记联系起来",
) -> SubmitChatCommand:
    return SubmitChatCommand(
        conversation_id=runtime.conversation_id,
        client_message_id=client_id,
        question=question,
        query_scope=QueryScope.notes(note_ids),
        idempotency_key=client_id,
    )


def run_failure(runtime: ScopeRuntime, command: SubmitChatCommand) -> ChatUseCaseError:
    submitted = runtime.use_case.submit(command)
    with pytest.raises(ChatUseCaseError) as failure:
        _ = asyncio.run(runtime.use_case.run(submitted.run.id, worker_id="worker-fail"))
    return failure.value


def test_verified_selection_restricts_sources_and_delimits_supplemental_context(
    tmp_path: Path,
) -> None:
    runtime = make_runtime(tmp_path)
    result = asyncio.run(
        runtime.use_case.execute(selection_command(runtime), worker_id="worker-selection")
    )

    assert result.run.status is ChatRunStatus.COMPLETED
    scope = result.run.effective_scope
    assert scope is not None
    assert scope.type is QueryScopeType.SELECTION
    assert scope.document_part_ids == ("part-0",)
    assert scope.chapter_refs == ("chapter-1",)
    assert scope.note_ids == ()
    assert scope.supplemental == (SupplementalContextKind.SELECTION,)

    assert len(runtime.knowledge.calls) == 1
    call = runtime.knowledge.calls[0]
    assert call.external_source_ids == ("provider-source-secret-1",)
    assert call.question.startswith("解释这段话")
    assert "<<<USER_CONTEXT_1 kind=selection ref=part-0 verified=yes>>>" in call.question
    assert _SELECTION_TEXT in call.question
    assert "仅作为回答的参考资料" in call.question

    assert runtime.verifier.calls == [
        VerifyCall(
            book_id="book-1",
            document_part_id="part-0",
            locator=_LOCATOR,
            selected_text=_SELECTION_TEXT,
        )
    ]

    with runtime.database.connect() as connection:
        row = connection.execute(
            "SELECT query_scope_json, context_hash FROM chat_runs WHERE id = ?",
            (result.run.id,),
        ).fetchone()
        snapshot = connection.execute(
            "SELECT context_hash, payload_json FROM chat_run_contexts WHERE chat_run_id = ?",
            (result.run.id,),
        ).fetchone()
    assert row is not None
    assert _SELECTION_TEXT not in str(row["query_scope_json"])
    assert supplemental_text_hash(_SELECTION_TEXT) in str(row["query_scope_json"])
    assert snapshot is not None
    assert str(snapshot["context_hash"]) == str(row["context_hash"])
    assert _SELECTION_TEXT in str(snapshot["payload_json"])

    reloaded = SQLiteChatRepository(runtime.database).get_result(result.run.id)
    assert reloaded is not None
    assert reloaded.run.effective_scope == scope
    assert reloaded.run.query_scope == result.run.query_scope


@pytest.mark.parametrize("mode", ("mismatch", "verifier-error", "no-verifier"))
def test_unverifiable_selection_is_marked_user_provided_context(
    tmp_path: Path,
    mode: str,
) -> None:
    runtime = make_runtime(tmp_path)
    if mode == "mismatch":
        runtime.verifier.result = False
    elif mode == "verifier-error":
        runtime.verifier.failure = RuntimeError("reader storage unavailable secret-path")
    else:
        object.__setattr__(runtime.use_case, "_selection_verifier", None)

    result = asyncio.run(
        runtime.use_case.execute(selection_command(runtime), worker_id="worker-unverified")
    )
    scope = result.run.effective_scope
    assert scope is not None
    assert scope.supplemental == (SupplementalContextKind.SELECTION_UNVERIFIED,)
    assert "verified=no" in runtime.knowledge.calls[0].question
    assert result.run.status is ChatRunStatus.COMPLETED


def test_selection_scope_rejections_never_call_the_provider(tmp_path: Path) -> None:
    runtime = make_runtime(tmp_path)

    unknown_part = run_failure(
        runtime,
        selection_command(runtime, client_id="selection-unknown-part", part_id="part-9"),
    )
    assert unknown_part.error.code is ChatErrorCode.NOT_FOUND

    with runtime.database.connect(immediate=True) as connection:
        _ = connection.execute(
            "DELETE FROM external_sources WHERE document_part_id = ?",
            ("part-0",),
        )
    not_ready = run_failure(
        runtime,
        selection_command(runtime, client_id="selection-no-source"),
    )
    assert not_ready.error.code is ChatErrorCode.SOURCE_NOT_READY
    assert not_ready.error.retriable

    assert runtime.knowledge.calls == []
    assert runtime.verifier.calls == []


def test_selection_submission_validation_and_payload_limits(tmp_path: Path) -> None:
    runtime = make_runtime(tmp_path)

    command = selection_command(runtime, client_id="selection-missing-body")
    with pytest.raises(ChatUseCaseError) as missing_body:
        _ = runtime.use_case.submit(
            SubmitChatCommand(
                conversation_id=command.conversation_id,
                client_message_id=command.client_message_id,
                question=command.question,
                query_scope=command.query_scope,
                selection_text=None,
                idempotency_key=command.idempotency_key,
            )
        )
    assert missing_body.value.error.code is ChatErrorCode.VALIDATION

    with pytest.raises(ChatUseCaseError) as digest_mismatch:
        _ = runtime.use_case.submit(
            SubmitChatCommand(
                conversation_id=command.conversation_id,
                client_message_id="selection-mismatch",
                question=command.question,
                query_scope=command.query_scope,
                selection_text="A different body",
                idempotency_key="selection-mismatch",
            )
        )
    assert digest_mismatch.value.error.code is ChatErrorCode.VALIDATION

    with pytest.raises(ChatUseCaseError) as body_for_book:
        _ = runtime.use_case.submit(
            SubmitChatCommand(
                conversation_id=command.conversation_id,
                client_message_id="book-with-body",
                question=command.question,
                query_scope=QueryScope.book(),
                selection_text="stray body",
                idempotency_key="book-with-body",
            )
        )
    assert body_for_book.value.error.code is ChatErrorCode.VALIDATION

    oversized_scope = QueryScope(
        type=QueryScopeType.SELECTION,
        document_part_id="part-0",
        locator=_LOCATOR,
        selected_text_sha256="c" * 64,
    )
    with pytest.raises(ChatUseCaseError) as oversized:
        _ = runtime.use_case.submit(
            SubmitChatCommand(
                conversation_id=command.conversation_id,
                client_message_id="selection-oversized",
                question=command.question,
                query_scope=oversized_scope,
                selection_text="s" * 20_001,
                idempotency_key="selection-oversized",
            )
        )
    assert oversized.value.error.code is ChatErrorCode.PAYLOAD_TOO_LARGE
    assert runtime.knowledge.calls == []


def test_selection_submission_is_idempotent_and_conflicts_on_changed_context(
    tmp_path: Path,
) -> None:
    runtime = make_runtime(tmp_path)
    first = runtime.use_case.submit(selection_command(runtime))
    replay = runtime.use_case.submit(selection_command(runtime))
    assert replay.replayed
    assert replay.run.id == first.run.id

    with pytest.raises(ChatUseCaseError) as conflict:
        _ = runtime.use_case.submit(selection_command(runtime, text="换了一段完全不同的话。"))
    assert conflict.value.error.code is ChatErrorCode.IDEMPOTENCY_CONFLICT

    with runtime.database.connect() as connection:
        counts = connection.execute(
            """
            SELECT
                (SELECT count(*) FROM chat_runs) AS runs,
                (SELECT count(*) FROM chat_run_contexts) AS contexts
            """
        ).fetchone()
    assert counts is not None
    assert (counts["runs"], counts["contexts"]) == (1, 1)


def test_notes_scope_grounds_on_body_sources_and_quotes_local_annotations(
    tmp_path: Path,
) -> None:
    runtime = make_runtime(tmp_path)
    _ = add_note(runtime, note_id="note-1", body="第一条笔记:行为设计。")
    _ = add_highlight(runtime, annotation_id="highlight-1", text="A highlighted passage.")

    result = asyncio.run(
        runtime.use_case.execute(
            notes_command(runtime, ("note-1", "highlight-1")),
            worker_id="worker-notes",
        )
    )
    assert result.run.status is ChatRunStatus.COMPLETED
    scope = result.run.effective_scope
    assert scope is not None
    assert scope.type is QueryScopeType.NOTES
    assert scope.note_ids == ("note-1", "highlight-1")
    assert scope.supplemental == (SupplementalContextKind.NOTES,)
    assert scope.document_part_ids == ("part-0", "part-1")

    call = runtime.knowledge.calls[0]
    assert call.external_source_ids == (
        "provider-source-secret-1",
        "provider-source-secret-2",
    )
    assert "<<<USER_CONTEXT_1 kind=note ref=note-1>>>" in call.question
    assert "第一条笔记:行为设计。" in call.question
    assert "<<<USER_CONTEXT_2 kind=note ref=highlight-1>>>" in call.question
    assert "A highlighted passage.\n\nhighlight remark" in call.question

    persisted = runtime.chat_repository.get_run(result.run.id)
    assert persisted is not None
    assert persisted.context_hash is not None
    with runtime.database.connect() as connection:
        snapshot = connection.execute(
            "SELECT context_hash FROM chat_run_contexts WHERE chat_run_id = ?",
            (result.run.id,),
        ).fetchone()
    assert snapshot is not None
    assert str(snapshot["context_hash"]) == persisted.context_hash

    reloaded = SQLiteChatRepository(runtime.database).get_result(result.run.id)
    assert reloaded is not None
    assert reloaded.run.effective_scope == scope


def test_notes_ownership_and_lifecycle_rejections_never_call_the_provider(
    tmp_path: Path,
) -> None:
    runtime = make_runtime(tmp_path)
    catalog = SQLiteCatalogRepository(runtime.database)
    other_book = Book(
        id="book-2",
        title="Another Book",
        author="Someone Else",
        source_hash="9" * 64,
        status=BookStatus.READY,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
    )
    catalog.add_book(other_book)
    _ = add_note(runtime, note_id="note-own", body="A local note.")
    _ = add_note(runtime, note_id="note-foreign", body="Foreign note.", book_id=other_book.id)
    _ = add_note(
        runtime,
        note_id="note-deleted",
        body="Deleted note.",
        status=AnnotationStatus.DELETED,
    )

    unknown = run_failure(
        runtime,
        notes_command(runtime, ("note-own", "note-missing"), client_id="notes-unknown"),
    )
    assert unknown.error.code is ChatErrorCode.NOT_FOUND

    cross_book = run_failure(
        runtime,
        notes_command(runtime, ("note-foreign",), client_id="notes-cross-book"),
    )
    assert cross_book.error.code is ChatErrorCode.VALIDATION

    deleted = run_failure(
        runtime,
        notes_command(runtime, ("note-deleted",), client_id="notes-deleted"),
    )
    assert deleted.error.code is ChatErrorCode.NOT_FOUND

    assert runtime.knowledge.calls == []


def test_oversized_notes_context_is_payload_too_large_without_provider_call(
    tmp_path: Path,
) -> None:
    runtime = make_runtime(tmp_path)
    note_ids = []
    for index in range(11):
        note_id = f"note-big-{index}"
        _ = add_note(runtime, note_id=note_id, body="n" * 10_000)
        note_ids.append(note_id)

    failure = run_failure(
        runtime,
        notes_command(runtime, tuple(note_ids), client_id="notes-oversized"),
    )
    assert failure.error.code is ChatErrorCode.PAYLOAD_TOO_LARGE
    assert not failure.error.retriable
    assert runtime.knowledge.calls == []


def test_notes_scope_without_annotation_store_fails_closed(tmp_path: Path) -> None:
    runtime = make_runtime(tmp_path)
    _ = add_note(runtime, note_id="note-1", body="A note.")
    object.__setattr__(runtime.use_case, "_annotations", None)

    failure = run_failure(
        runtime,
        notes_command(runtime, ("note-1",), client_id="notes-no-store"),
    )
    assert failure.error.code is ChatErrorCode.UNEXPECTED
    assert runtime.knowledge.calls == []


def test_explicit_scope_resolving_to_no_sources_is_source_not_ready(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = make_runtime(tmp_path)
    _ = add_note(runtime, note_id="note-1", body="A note.")
    submitted = runtime.use_case.submit(
        notes_command(runtime, ("note-1",), client_id="notes-empty-resolution")
    )
    empty = _ResolvedQuery(
        question="A question",
        provider_source_ids=(),
        effective_scope=EffectiveBookScope(
            type=QueryScopeType.NOTES,
            book_id=runtime.book.id,
            document_part_ids=("part-0",),
            chapter_refs=("chapter-1",),
            source_labels=("Part 1",),
            note_ids=("note-1",),
            supplemental=(SupplementalContextKind.NOTES,),
        ),
    )
    monkeypatch.setattr(
        ChatUseCase,
        "_resolve_scope",
        lambda self, context: empty,
    )
    with pytest.raises(ChatUseCaseError) as failure:
        _ = asyncio.run(runtime.use_case.run(submitted.run.id, worker_id="worker-empty"))
    assert failure.value.error.code is ChatErrorCode.SOURCE_NOT_READY
    assert runtime.knowledge.calls == []


def test_notes_retry_rebuilds_snapshot_and_recovery_keeps_effective_scope(
    tmp_path: Path,
) -> None:
    runtime = make_runtime(tmp_path)
    _ = add_note(runtime, note_id="note-1", body="A stable note body.")
    runtime.knowledge.healthy = False
    submitted = runtime.use_case.submit(
        notes_command(runtime, ("note-1",), client_id="notes-retry")
    )
    with pytest.raises(ChatUseCaseError) as auth_failure:
        _ = asyncio.run(runtime.use_case.run(submitted.run.id, worker_id="worker-auth"))
    assert auth_failure.value.error.code is ChatErrorCode.AUTH_REQUIRED

    failed = runtime.chat_repository.get_run(submitted.run.id)
    assert failed is not None
    assert failed.effective_scope is not None
    assert failed.effective_scope.type is QueryScopeType.NOTES
    assert failed.context_hash is not None
    first_hash = failed.context_hash

    retried = runtime.use_case.retry(submitted.run.id, "notes-client-retry-1")
    assert retried.run.context_hash is None

    runtime.knowledge.healthy = True
    completed = asyncio.run(runtime.use_case.run(submitted.run.id, worker_id="worker-recovered"))
    assert completed.run.status is ChatRunStatus.COMPLETED
    assert completed.run.attempt == 2
    assert completed.run.context_hash == first_hash
    assert completed.run.effective_scope == failed.effective_scope
    assert len(runtime.knowledge.calls) == 1


def test_selection_recovery_after_lease_expiry_reuses_the_persisted_scope(
    tmp_path: Path,
) -> None:
    runtime = make_runtime(tmp_path)
    submitted = runtime.use_case.submit(selection_command(runtime, client_id="selection-crash"))
    claimed = runtime.chat_repository.claim(
        submitted.run.id,
        "worker-before-crash",
        lease_expires_at=runtime.clock() + timedelta(seconds=5),
        now=runtime.clock(),
    )
    assert claimed.status is ChatRunStatus.RUNNING

    runtime.clock.advance(timedelta(seconds=6))
    result = asyncio.run(runtime.use_case.run(submitted.run.id, worker_id="worker-after-crash"))
    assert result.run.status is ChatRunStatus.COMPLETED
    assert result.run.lease_generation == 2
    scope = result.run.effective_scope
    assert scope is not None
    assert scope.type is QueryScopeType.SELECTION
    assert len(runtime.knowledge.calls) == 1
