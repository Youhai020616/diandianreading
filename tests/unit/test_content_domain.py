from __future__ import annotations

import pytest

from diandianreading.domain import InvalidStateTransition
from diandianreading.domain.content import (
    CONTENT_BODY_MAX_CODEPOINTS,
    MAX_CONTENT_SOURCES,
    NOTE_BODY_MAX_CODEPOINTS,
    PUBLISHING_STATUSES,
    ContentAsset,
    ContentLength,
    ContentRevision,
    ContentSource,
    ContentSourceKind,
    ContentStatus,
    ContentTone,
    ContentType,
    GenerationRequest,
    Note,
    NoteSourceKind,
    RevisionAuthor,
    ensure_supported_in_p5,
)
from tests.support import FIXED_NOW


def make_request(**overrides: object) -> GenerationRequest:
    payload: dict[str, object] = {
        "content_type": ContentType.READING_REPORT,
        "sources": (ContentSource(kind=ContentSourceKind.BOOK, reference="book-1"),),
        "language": "zh-CN",
        "tone": ContentTone.RATIONAL,
        "length": ContentLength.MEDIUM,
        "target_platform": None,
        "require_citations": True,
        "first_person": False,
    }
    payload.update(overrides)
    return GenerationRequest(**payload)  # type: ignore[arg-type]


def make_content(
    *,
    status: ContentStatus = ContentStatus.DRAFT,
    latest_revision_number: int = 1,
) -> ContentAsset:
    return ContentAsset(
        id="content-1",
        book_id="book-1",
        request=make_request(),
        status=status,
        latest_revision_number=latest_revision_number,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
        version=0,
    )


def make_note(**overrides: object) -> Note:
    payload: dict[str, object] = {
        "id": "note-1",
        "book_id": "book-1",
        "source_kind": NoteSourceKind.CHAT_MESSAGE,
        "source_id": "message-1",
        "title": "为什么设计要可见",
        "body": "作者认为可见性决定了用户能否形成正确的心智模型。",
        "created_at": FIXED_NOW,
        "updated_at": FIXED_NOW,
        "version": 0,
    }
    payload.update(overrides)
    return Note(**payload)  # type: ignore[arg-type]


class TestNote:
    def test_accepts_a_derived_note(self) -> None:
        note = make_note()
        assert note.source_kind is NoteSourceKind.CHAT_MESSAGE
        assert note.source_id == "message-1"

    def test_manual_notes_carry_no_source_id(self) -> None:
        note = make_note(source_kind=NoteSourceKind.MANUAL, source_id=None)
        assert note.source_id is None

    def test_manual_notes_reject_a_source_id(self) -> None:
        with pytest.raises(ValueError, match="cannot carry a source_id"):
            make_note(source_kind=NoteSourceKind.MANUAL, source_id="message-1")

    @pytest.mark.parametrize("kind", [NoteSourceKind.CHAT_MESSAGE, NoteSourceKind.ANNOTATION])
    def test_derived_notes_require_a_source_id(self, kind: NoteSourceKind) -> None:
        with pytest.raises(ValueError, match="require a source_id"):
            make_note(source_kind=kind, source_id=None)

    def test_rejects_empty_and_oversized_body(self) -> None:
        with pytest.raises(ValueError, match="Note body cannot be empty"):
            make_note(body="")
        with pytest.raises(ValueError, match="cannot exceed"):
            make_note(body="a" * (NOTE_BODY_MAX_CODEPOINTS + 1))

    def test_rejects_nul_in_text(self) -> None:
        with pytest.raises(ValueError, match="cannot contain NUL"):
            make_note(title="bad\x00title")

    def test_rejects_missing_identifiers_and_negative_version(self) -> None:
        with pytest.raises(ValueError, match="id and book_id are required"):
            make_note(book_id="")
        with pytest.raises(ValueError, match="version cannot be negative"):
            make_note(version=-1)


class TestGenerationRequest:
    def test_requires_at_least_one_source(self) -> None:
        with pytest.raises(ValueError, match="at least one source"):
            make_request(sources=())

    def test_rejects_too_many_sources(self) -> None:
        sources = tuple(
            ContentSource(kind=ContentSourceKind.NOTE, reference=f"note-{index}")
            for index in range(MAX_CONTENT_SOURCES + 1)
        )
        with pytest.raises(ValueError, match="cannot exceed"):
            make_request(sources=sources)

    def test_rejects_empty_language_and_platform(self) -> None:
        with pytest.raises(ValueError, match="Generation language cannot be empty"):
            make_request(language="")
        with pytest.raises(ValueError, match="target_platform cannot be empty"):
            make_request(target_platform="")

    def test_rejects_empty_source_reference(self) -> None:
        with pytest.raises(ValueError, match="source reference cannot be empty"):
            ContentSource(kind=ContentSourceKind.TOPIC, reference="")


class TestContentRevision:
    def make_revision(self, **overrides: object) -> ContentRevision:
        payload: dict[str, object] = {
            "id": "revision-1",
            "content_id": "content-1",
            "revision_number": 1,
            "author_kind": RevisionAuthor.AI,
            "title": "读《设计心理学》",
            "body": "初稿正文。",
            "created_at": FIXED_NOW,
        }
        payload.update(overrides)
        return ContentRevision(**payload)  # type: ignore[arg-type]

    def test_first_revision_must_be_authored_by_the_model(self) -> None:
        with pytest.raises(ValueError, match="first revision must record the model"):
            self.make_revision(author_kind=RevisionAuthor.HUMAN)

    def test_later_revisions_may_be_human(self) -> None:
        revision = self.make_revision(revision_number=2, author_kind=RevisionAuthor.HUMAN)
        assert revision.author_kind is RevisionAuthor.HUMAN

    def test_numbering_starts_at_one(self) -> None:
        with pytest.raises(ValueError, match="numbering starts at 1"):
            self.make_revision(revision_number=0)

    def test_rejects_oversized_body(self) -> None:
        with pytest.raises(ValueError, match="cannot exceed"):
            self.make_revision(body="a" * (CONTENT_BODY_MAX_CODEPOINTS + 1))


class TestGeneratedContentLifecycle:
    def test_follows_the_frozen_happy_path(self) -> None:
        content = make_content(status=ContentStatus.QUEUED, latest_revision_number=0)
        content = content.transition(ContentStatus.GENERATING)
        assert content.status is ContentStatus.GENERATING
        content = ContentAsset(
            id=content.id,
            book_id=content.book_id,
            request=content.request,
            status=ContentStatus.GENERATING,
            latest_revision_number=1,
            created_at=content.created_at,
            updated_at=content.updated_at,
            version=content.version,
        )
        content = content.transition(ContentStatus.DRAFT)
        content = content.transition(ContentStatus.EDITING)
        content = content.transition(ContentStatus.APPROVED)
        assert content.status is ContentStatus.APPROVED

    def test_regeneration_returns_to_the_queue_from_every_editable_state(self) -> None:
        for status in (ContentStatus.DRAFT, ContentStatus.EDITING, ContentStatus.APPROVED):
            content = make_content(status=status)
            assert content.transition(ContentStatus.QUEUED).status is ContentStatus.QUEUED

    def test_rejects_skipping_generation(self) -> None:
        content = make_content(status=ContentStatus.QUEUED, latest_revision_number=0)
        with pytest.raises(InvalidStateTransition, match="queued to draft"):
            content.transition(ContentStatus.DRAFT)

    def test_published_is_terminal(self) -> None:
        content = make_content(status=ContentStatus.PUBLISHED)
        with pytest.raises(InvalidStateTransition):
            content.transition(ContentStatus.EDITING)

    def test_transition_bumps_version_and_timestamp(self) -> None:
        content = make_content(status=ContentStatus.DRAFT)
        moved = content.transition(ContentStatus.APPROVED, now=FIXED_NOW)
        assert moved.version == content.version + 1
        assert moved.updated_at == FIXED_NOW

    def test_settled_content_requires_a_revision(self) -> None:
        with pytest.raises(ValueError, match="requires at least one revision"):
            make_content(status=ContentStatus.DRAFT, latest_revision_number=0)

    def test_pending_content_may_have_no_revision(self) -> None:
        for status in (ContentStatus.QUEUED, ContentStatus.GENERATING):
            assert make_content(status=status, latest_revision_number=0).status is status

    def test_rejects_missing_identifiers_and_negative_counters(self) -> None:
        with pytest.raises(ValueError, match="id and book_id are required"):
            ContentAsset(
                id="",
                book_id="book-1",
                request=make_request(),
                status=ContentStatus.QUEUED,
                latest_revision_number=0,
                created_at=FIXED_NOW,
                updated_at=FIXED_NOW,
                version=0,
            )
        with pytest.raises(ValueError, match="version cannot be negative"):
            make_content(latest_revision_number=1).__class__(
                id="content-1",
                book_id="book-1",
                request=make_request(),
                status=ContentStatus.DRAFT,
                latest_revision_number=1,
                created_at=FIXED_NOW,
                updated_at=FIXED_NOW,
                version=-1,
            )
        with pytest.raises(ValueError, match="latest_revision_number cannot be negative"):
            make_content(status=ContentStatus.QUEUED, latest_revision_number=-1)


class TestPublishingGate:
    def test_publishing_statuses_are_refused_in_p5(self) -> None:
        for status in PUBLISHING_STATUSES:
            with pytest.raises(ValueError, match="P6 publishing track"):
                ensure_supported_in_p5(status)

    def test_p5_statuses_pass_the_gate(self) -> None:
        for status in ContentStatus:
            if status in PUBLISHING_STATUSES:
                continue
            ensure_supported_in_p5(status)

    def test_the_gate_covers_exactly_the_two_publishing_states(self) -> None:
        assert {ContentStatus.SCHEDULED, ContentStatus.PUBLISHED} == PUBLISHING_STATUSES
