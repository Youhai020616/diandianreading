from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from diandianreading.domain import (
    Book,
    BookStatus,
    CredentialRef,
    DocumentAsset,
    DocumentPart,
    InvalidStateTransition,
    JobStep,
    PreparationManifest,
    RemoteOperation,
    RemoteOperationKind,
    RemoteOperationStatus,
    RemoteProbeStrategy,
    SourceOrigin,
    StorageKey,
    TargetCapabilities,
)
from tests.support import FIXED_NOW


def make_asset(
    *,
    display_filename: str = "book.md",
    size_bytes: int = 1,
    sha256: str = "hash",
    origin_locator: str | None = None,
    rights_provenance_id: str = "rights-local",
    derived_from_asset_id: str | None = None,
) -> DocumentAsset:
    return DocumentAsset(
        id="asset",
        storage_key=StorageKey("originals/book"),
        display_filename=display_filename,
        mime_type="text/markdown",
        size_bytes=size_bytes,
        sha256=sha256,
        title=None,
        author=None,
        origin=SourceOrigin.LOCAL,
        origin_locator=origin_locator,
        rights_provenance_id=rights_provenance_id,
        derived_from_asset_id=derived_from_asset_id,
    )


def make_remote_operation(
    *,
    baseline_snapshot_redacted: str = "[]",
    status: RemoteOperationStatus = RemoteOperationStatus.PREPARED,
    dispatch_attempt: int = 0,
    external_id: str | None = None,
    dispatched_at: datetime | None = None,
    resolved_at: datetime | None = None,
    version: int = 0,
) -> RemoteOperation:
    return RemoteOperation(
        id="operation",
        job_id="job",
        step=JobStep.UPLOADING,
        provider="notebooklm",
        credential_profile="default",
        kind=RemoteOperationKind.ADD_SOURCE,
        idempotency_key="key",
        local_resource_id="part",
        input_hash="hash",
        probe_strategy=RemoteProbeStrategy.EXTERNAL_ID,
        baseline_snapshot_redacted=baseline_snapshot_redacted,
        request_summary_redacted='{"part":"part"}',
        status=status,
        dispatch_attempt=dispatch_attempt,
        external_id=external_id,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
        dispatched_at=dispatched_at,
        resolved_at=resolved_at,
        version=version,
    )


def test_domain_models_validate_invariants() -> None:
    with pytest.raises(ValueError, match="title"):
        Book("book", " ", None, "hash", BookStatus.IMPORTING, FIXED_NOW, FIXED_NOW)
    with pytest.raises(ValueError, match="source_hash"):
        Book("book", "Title", None, "", BookStatus.IMPORTING, FIXED_NOW, FIXED_NOW)
    with pytest.raises(ValueError, match="negative"):
        make_asset(size_bytes=-1)
    with pytest.raises(ValueError, match="sha256"):
        make_asset(sha256="")
    with pytest.raises(ValueError, match="canonical"):
        make_asset(origin_locator="https://example.com/book?token=secret")
    asset = make_asset(origin_locator="https://example.com/book")
    assert asset.origin_locator is not None
    assert asset.origin_locator.endswith("/book")
    with pytest.raises(ValueError, match="display_filename"):
        make_asset(display_filename="")
    with pytest.raises(ValueError, match="rights_provenance_id"):
        make_asset(rights_provenance_id="")
    with pytest.raises(ValueError, match="derive from itself"):
        make_asset(derived_from_asset_id="asset")

    with pytest.raises(ValueError, match="sequence"):
        DocumentPart("part", "asset", -1, StorageKey("parts/one"), "text/markdown", 1, "hash", ())
    with pytest.raises(ValueError, match="word_count"):
        DocumentPart("part", "asset", 0, StorageKey("parts/one"), "text/markdown", -1, "hash", ())
    with pytest.raises(ValueError, match="sha256"):
        DocumentPart("part", "asset", 0, StorageKey("parts/one"), "text/markdown", 1, "", ())
    with pytest.raises(ValueError, match="size_bytes"):
        DocumentPart(
            "part",
            "asset",
            0,
            StorageKey("parts/one"),
            "text/markdown",
            1,
            "hash",
            (),
            -1,
        )
    with pytest.raises(ValueError, match="root_asset_id"):
        PreparationManifest("", StorageKey("manifests/one"), "hash")
    with pytest.raises(ValueError, match="sha256"):
        PreparationManifest("asset", StorageKey("manifests/one"), "")
    with pytest.raises(ValueError, match="required"):
        CredentialRef("", "default")
    with pytest.raises(ValueError, match="opaque"):
        CredentialRef("fake", "../other-profile")
    for invalid_key in ("", "/absolute", "../escape", "parts\\escape", "https://url"):
        with pytest.raises(ValueError, match="StorageKey"):
            StorageKey(invalid_key)


def test_target_capabilities_require_positive_nonempty_limits() -> None:
    capabilities = TargetCapabilities(
        max_source_words=350_000,
        max_source_bytes=10_000_000,
        max_sources_per_workspace=50,
        accepted_mime_types=frozenset({"application/pdf", "text/markdown"}),
    )
    assert "text/markdown" in capabilities.accepted_mime_types

    with pytest.raises(ValueError, match="positive"):
        TargetCapabilities(0, 1, 1, frozenset({"text/plain"}))
    with pytest.raises(ValueError, match="MIME"):
        TargetCapabilities(1, 1, 1, frozenset())


def test_remote_operation_dispatches_then_succeeds_with_external_identity() -> None:
    prepared = make_remote_operation()
    dispatched_at = FIXED_NOW + timedelta(seconds=1)
    resolved_at = FIXED_NOW + timedelta(seconds=2)

    assert prepared.status is RemoteOperationStatus.PREPARED
    assert prepared.is_unresolved

    dispatched = prepared.dispatch(now=dispatched_at)
    assert dispatched.status is RemoteOperationStatus.DISPATCHED
    assert dispatched.dispatch_attempt == 1
    assert dispatched.dispatched_at == dispatched_at
    assert dispatched.updated_at == dispatched_at
    assert dispatched.version == prepared.version + 1
    assert dispatched.is_unresolved

    succeeded = dispatched.succeed("external", now=resolved_at)
    assert succeeded.status is RemoteOperationStatus.SUCCEEDED
    assert succeeded.external_id == "external"
    assert succeeded.resolved_at == resolved_at
    assert succeeded.updated_at == resolved_at
    assert succeeded.version == dispatched.version + 1
    assert not succeeded.is_unresolved

    with pytest.raises(InvalidStateTransition, match="cannot dispatch"):
        dispatched.dispatch()
    with pytest.raises(InvalidStateTransition, match="cannot resolve"):
        prepared.succeed("external")
    with pytest.raises(ValueError, match="external_id"):
        dispatched.succeed("")
    with pytest.raises(InvalidStateTransition, match="cannot resolve"):
        succeeded.succeed("again")


def test_remote_operation_ambiguity_requires_reconciliation_or_proven_absence() -> None:
    prepared = make_remote_operation()
    dispatched = prepared.dispatch(now=FIXED_NOW + timedelta(seconds=1))

    with pytest.raises(InvalidStateTransition, match="cannot become ambiguous"):
        prepared.mark_ambiguous()
    with pytest.raises(InvalidStateTransition, match="cannot retry"):
        prepared.prepare_retry_after_absence()

    ambiguous = dispatched.mark_ambiguous(now=FIXED_NOW + timedelta(seconds=2))
    assert ambiguous.status is RemoteOperationStatus.AMBIGUOUS
    assert ambiguous.dispatch_attempt == 1
    assert ambiguous.external_id is None
    assert ambiguous.is_unresolved

    with pytest.raises(InvalidStateTransition, match="cannot resolve"):
        ambiguous.succeed("external")

    reconciled = ambiguous.reconcile(
        "external-from-probe",
        now=FIXED_NOW + timedelta(seconds=3),
    )
    assert reconciled.status is RemoteOperationStatus.RECONCILED
    assert reconciled.external_id == "external-from-probe"
    assert reconciled.resolved_at == FIXED_NOW + timedelta(seconds=3)
    assert not reconciled.is_unresolved

    retry_prepared = ambiguous.prepare_retry_after_absence(now=FIXED_NOW + timedelta(seconds=3))
    assert retry_prepared.status is RemoteOperationStatus.PREPARED
    assert retry_prepared.dispatch_attempt == 1
    assert retry_prepared.dispatched_at == dispatched.dispatched_at
    assert retry_prepared.external_id is None

    cancelled_retry = retry_prepared.cancel_before_dispatch(now=FIXED_NOW + timedelta(seconds=4))
    assert cancelled_retry.status is RemoteOperationStatus.CANCELLED_BEFORE_DISPATCH
    assert cancelled_retry.dispatch_attempt == 1

    redispatched = retry_prepared.dispatch(now=FIXED_NOW + timedelta(seconds=4))
    assert redispatched.dispatch_attempt == 2
    assert redispatched.dispatched_at == FIXED_NOW + timedelta(seconds=4)

    with pytest.raises(InvalidStateTransition, match="cannot retry"):
        reconciled.prepare_retry_after_absence()


def test_remote_operation_can_cancel_only_while_prepared_before_dispatch() -> None:
    prepared = make_remote_operation()
    cancelled_at = FIXED_NOW + timedelta(seconds=1)

    cancelled = prepared.cancel_before_dispatch(now=cancelled_at)
    assert cancelled.status is RemoteOperationStatus.CANCELLED_BEFORE_DISPATCH
    assert cancelled.dispatch_attempt == 0
    assert cancelled.dispatched_at is None
    assert cancelled.resolved_at == cancelled_at
    assert cancelled.version == prepared.version + 1
    assert not cancelled.is_unresolved

    with pytest.raises(InvalidStateTransition, match="proven safe"):
        cancelled.cancel_before_dispatch()

    dispatched = prepared.dispatch(now=cancelled_at)
    with pytest.raises(InvalidStateTransition, match="proven safe"):
        dispatched.cancel_before_dispatch()

    retry_prepared = dispatched.prepare_retry_after_absence(now=FIXED_NOW + timedelta(seconds=2))
    cancelled_retry = retry_prepared.cancel_before_dispatch(now=FIXED_NOW + timedelta(seconds=3))
    assert cancelled_retry.status is RemoteOperationStatus.CANCELLED_BEFORE_DISPATCH
    assert cancelled_retry.dispatch_attempt == 1


def test_remote_operation_terminal_failure_resolves_any_unresolved_state() -> None:
    prepared = make_remote_operation()
    dispatched = prepared.dispatch(now=FIXED_NOW + timedelta(seconds=1))
    ambiguous = dispatched.mark_ambiguous(now=FIXED_NOW + timedelta(seconds=2))
    failed_at = FIXED_NOW + timedelta(seconds=3)

    for operation in (prepared, dispatched, ambiguous):
        failed = operation.fail_terminal(now=failed_at)
        assert failed.status is RemoteOperationStatus.FAILED_TERMINAL
        assert failed.resolved_at == failed_at
        assert failed.version == operation.version + 1
        assert not failed.is_unresolved

        with pytest.raises(InvalidStateTransition, match="cannot fail"):
            failed.fail_terminal()


def test_remote_operation_rejects_inconsistent_persisted_state() -> None:
    with pytest.raises(ValueError, match="required"):
        make_remote_operation(baseline_snapshot_redacted="")
    with pytest.raises(ValueError, match="counters"):
        make_remote_operation(dispatch_attempt=-1)
    with pytest.raises(ValueError, match="resolved_at"):
        make_remote_operation(resolved_at=FIXED_NOW)
    with pytest.raises(ValueError, match="resolved_at"):
        make_remote_operation(
            status=RemoteOperationStatus.SUCCEEDED,
            external_id="external",
        )
    with pytest.raises(ValueError, match="external identifier"):
        make_remote_operation(
            status=RemoteOperationStatus.SUCCEEDED,
            external_id=None,
            resolved_at=FIXED_NOW,
        )
    with pytest.raises(ValueError, match="undispatched"):
        make_remote_operation(dispatched_at=FIXED_NOW)
