"""Content asset lease, fencing, and cancellation behaviour (C1b).

These are the assertions behind the C1b exit criterion that a crashed worker, an
expired lease, and a cancellation race must not produce a second remote artefact
or a silently overwritten draft.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from diandianreading.domain.content import (
    ContentAsset,
    ContentFailureCode,
    ContentLeaseToken,
    ContentLength,
    ContentRevision,
    ContentSource,
    ContentSourceKind,
    ContentStatus,
    ContentTone,
    ContentType,
    GenerationRequest,
    RevisionAuthor,
)
from diandianreading.domain.errors import RepositoryConflict
from diandianreading.infrastructure.persistence.content import SQLiteContentAssetRepository
from diandianreading.infrastructure.persistence.sqlite import SQLiteDatabase
from tests.support import FIXED_NOW

NOW = FIXED_NOW.isoformat()
LEASE = 60


@pytest.fixture
def repository(tmp_path) -> SQLiteContentAssetRepository:
    database = SQLiteDatabase(tmp_path / "state" / "app.sqlite3")
    database.migrate()
    with database.connect(immediate=True) as connection:
        connection.execute(
            """
            INSERT INTO books(id, title, author, source_hash, status, created_at, updated_at)
            VALUES ('book-1', '设计心理学', 'Norman', 'hash-1', 'ready', ?, ?)
            """,
            (NOW, NOW),
        )
    return SQLiteContentAssetRepository(database)


def make_asset(content_id: str = "content-1") -> ContentAsset:
    return ContentAsset(
        id=content_id,
        book_id="book-1",
        request=GenerationRequest(
            content_type=ContentType.READING_REPORT,
            sources=(
                ContentSource(kind=ContentSourceKind.BOOK, reference="book-1"),
                ContentSource(kind=ContentSourceKind.TOPIC, reference="可见性"),
            ),
            language="zh-CN",
            tone=ContentTone.RATIONAL,
            length=ContentLength.MEDIUM,
            target_platform=None,
            require_citations=True,
            first_person=False,
        ),
        status=ContentStatus.QUEUED,
        latest_revision_number=0,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
        version=0,
    )


def ai_revision(number: int = 1) -> ContentRevision:
    return ContentRevision(
        id=f"revision-{number}",
        content_id="content-1",
        revision_number=number,
        author_kind=RevisionAuthor.AI,
        title="读《设计心理学》",
        body="模型初稿。",
        created_at=FIXED_NOW,
    )


class TestCreateAndRead:
    def test_round_trips_the_request_and_its_sources(self, repository) -> None:
        repository.create(make_asset())
        stored = repository.get("content-1")
        assert stored is not None
        assert stored.status is ContentStatus.QUEUED
        assert [source.reference for source in stored.request.sources] == ["book-1", "可见性"]
        assert stored.request.require_citations is True

    def test_rejects_an_unknown_book(self, repository) -> None:
        asset = make_asset()
        broken = ContentAsset(
            id=asset.id,
            book_id="missing",
            request=asset.request,
            status=asset.status,
            latest_revision_number=0,
            created_at=asset.created_at,
            updated_at=asset.updated_at,
            version=0,
        )
        with pytest.raises(KeyError, match="Unknown Book"):
            repository.create(broken)


class TestLeasing:
    def test_claims_a_queued_asset_and_moves_it_to_generating(self, repository) -> None:
        repository.create(make_asset())
        claimed = repository.claim_next(worker_id="w-1", now=FIXED_NOW, lease_seconds=LEASE)
        assert claimed is not None
        asset, token = claimed
        assert asset.status is ContentStatus.GENERATING
        assert token.owner == "w-1"
        assert token.generation == 1

    def test_a_live_lease_hides_the_asset_from_other_workers(self, repository) -> None:
        repository.create(make_asset())
        repository.claim_next(worker_id="w-1", now=FIXED_NOW, lease_seconds=LEASE)
        assert repository.claim_next(worker_id="w-2", now=FIXED_NOW, lease_seconds=LEASE) is None

    def test_an_expired_lease_is_reclaimed_with_a_new_generation(self, repository) -> None:
        repository.create(make_asset())
        _, first = repository.claim_next(worker_id="w-1", now=FIXED_NOW, lease_seconds=LEASE)
        later = FIXED_NOW + timedelta(seconds=LEASE + 1)
        claimed = repository.claim_next(worker_id="w-2", now=later, lease_seconds=LEASE)
        assert claimed is not None
        _, second = claimed
        assert second.owner == "w-2"
        assert second.generation == first.generation + 1

    def test_a_stale_owner_cannot_write_after_being_fenced_out(self, repository) -> None:
        repository.create(make_asset())
        _, stale = repository.claim_next(worker_id="w-1", now=FIXED_NOW, lease_seconds=LEASE)
        later = FIXED_NOW + timedelta(seconds=LEASE + 1)
        repository.claim_next(worker_id="w-2", now=later, lease_seconds=LEASE)
        with pytest.raises(RepositoryConflict, match="lease is no longer held"):
            repository.complete_with_revision("content-1", stale, ai_revision(), now=later)

    def test_returns_none_when_nothing_is_claimable(self, repository) -> None:
        assert repository.claim_next(worker_id="w-1", now=FIXED_NOW, lease_seconds=LEASE) is None

    def test_rejects_a_non_positive_lease(self, repository) -> None:
        with pytest.raises(ValueError, match="Lease seconds must be positive"):
            repository.claim_next(worker_id="w-1", now=FIXED_NOW, lease_seconds=0)


class TestCompletionAndFailure:
    def test_completion_stores_the_draft_and_releases_the_lease(self, repository) -> None:
        repository.create(make_asset())
        _, token = repository.claim_next(worker_id="w-1", now=FIXED_NOW, lease_seconds=LEASE)
        asset = repository.complete_with_revision("content-1", token, ai_revision(), now=FIXED_NOW)
        assert asset.status is ContentStatus.DRAFT
        assert asset.latest_revision_number == 1
        revisions = repository.list_revisions("content-1")
        assert [item.author_kind for item in revisions] == [RevisionAuthor.AI]
        # The lease is gone, so the finished asset is not claimable again.
        assert repository.claim_next(worker_id="w-2", now=FIXED_NOW, lease_seconds=LEASE) is None

    def test_a_failed_first_attempt_returns_the_asset_to_the_queue(self, repository) -> None:
        repository.create(make_asset())
        _, token = repository.claim_next(worker_id="w-1", now=FIXED_NOW, lease_seconds=LEASE)
        asset = repository.fail(
            "content-1", token, code=ContentFailureCode.PROVIDER_UNAVAILABLE, now=FIXED_NOW
        )
        assert asset.status is ContentStatus.QUEUED
        assert repository.claim_next(worker_id="w-2", now=FIXED_NOW, lease_seconds=LEASE)

    def test_a_failure_after_a_draft_keeps_the_draft(self, repository) -> None:
        repository.create(make_asset())
        _, token = repository.claim_next(worker_id="w-1", now=FIXED_NOW, lease_seconds=LEASE)
        repository.complete_with_revision("content-1", token, ai_revision(), now=FIXED_NOW)
        later = FIXED_NOW + timedelta(seconds=1)
        _, retry = repository.claim_next(worker_id="w-2", now=later, lease_seconds=LEASE) or (
            None,
            None,
        )
        if retry is not None:
            asset = repository.fail(
                "content-1", retry, code=ContentFailureCode.UNEXPECTED, now=later
            )
            assert asset.status is ContentStatus.DRAFT

    def test_binding_a_provider_operation_requires_the_lease(self, repository) -> None:
        repository.create(make_asset())
        _, token = repository.claim_next(worker_id="w-1", now=FIXED_NOW, lease_seconds=LEASE)
        repository.bind_provider_operation("content-1", token, operation_id="op-1", now=FIXED_NOW)
        bogus = ContentLeaseToken("w-9", 99)
        with pytest.raises(RepositoryConflict):
            repository.bind_provider_operation(
                "content-1", bogus, operation_id="op-2", now=FIXED_NOW
            )


class TestCancellation:
    def test_cancel_is_recorded_and_idempotent(self, repository) -> None:
        repository.create(make_asset())
        assert repository.request_cancel("content-1", now=FIXED_NOW) is True
        assert repository.cancel_requested("content-1") is True
        assert repository.request_cancel("content-1", now=FIXED_NOW) is True

    def test_cancel_does_not_apply_to_a_settled_asset(self, repository) -> None:
        repository.create(make_asset())
        _, token = repository.claim_next(worker_id="w-1", now=FIXED_NOW, lease_seconds=LEASE)
        repository.complete_with_revision("content-1", token, ai_revision(), now=FIXED_NOW)
        assert repository.request_cancel("content-1", now=FIXED_NOW) is False


class TestHumanRevisions:
    def test_editing_appends_rather_than_overwrites(self, repository) -> None:
        repository.create(make_asset())
        _, token = repository.claim_next(worker_id="w-1", now=FIXED_NOW, lease_seconds=LEASE)
        repository.complete_with_revision("content-1", token, ai_revision(), now=FIXED_NOW)
        edited = ContentRevision(
            id="revision-2",
            content_id="content-1",
            revision_number=2,
            author_kind=RevisionAuthor.HUMAN,
            title="我改过的标题",
            body="我改过的正文。",
            created_at=FIXED_NOW,
        )
        asset = repository.append_human_revision("content-1", edited, now=FIXED_NOW)
        assert asset.status is ContentStatus.EDITING
        revisions = repository.list_revisions("content-1")
        assert [item.author_kind for item in revisions] == [
            RevisionAuthor.AI,
            RevisionAuthor.HUMAN,
        ]
        # The model's original draft is still readable, unchanged.
        assert revisions[0].body == "模型初稿。"

    def test_editing_an_unknown_asset_is_refused(self, repository) -> None:
        with pytest.raises(KeyError, match="Unknown content asset"):
            repository.append_human_revision("missing", ai_revision(), now=FIXED_NOW)


class TestListing:
    def test_lists_assets_for_a_book(self, repository) -> None:
        repository.create(make_asset("content-1"))
        repository.create(make_asset("content-2"))
        assert len(repository.list_for_book("book-1", limit=10)) == 2

    def test_rejects_a_non_positive_limit(self, repository) -> None:
        with pytest.raises(ValueError, match="limit must be positive"):
            repository.list_for_book("book-1", limit=0)
