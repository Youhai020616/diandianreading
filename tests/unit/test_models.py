from __future__ import annotations

import pytest

from diandianreading.domain import (
    Book,
    BookStatus,
    CredentialRef,
    DocumentAsset,
    DocumentPart,
    InvalidStateTransition,
    PreparationManifest,
    RemoteOperation,
    RemoteOperationKind,
    RemoteOperationStatus,
    SourceOrigin,
    StorageKey,
    TargetCapabilities,
)
from tests.support import FIXED_NOW


def make_asset(**overrides):
    values = {
        "id": "asset",
        "storage_key": StorageKey("originals/book"),
        "display_filename": "book.md",
        "mime_type": "text/markdown",
        "size_bytes": 1,
        "sha256": "hash",
        "title": None,
        "author": None,
        "origin": SourceOrigin.LOCAL,
        "origin_locator": None,
        "rights_provenance_id": "rights-local",
    }
    values.update(overrides)
    return DocumentAsset(**values)


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
    assert make_asset(origin_locator="https://example.com/book").origin_locator.endswith("/book")
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


def test_remote_operation_completes_once_with_external_identity() -> None:
    operation = RemoteOperation(
        id="operation",
        job_id="job",
        kind=RemoteOperationKind.ADD_SOURCE,
        idempotency_key="key",
        local_resource_id="part",
        input_hash="hash",
        status=RemoteOperationStatus.PENDING,
        external_id=None,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
        version=0,
    )
    completed = operation.complete("external", now=FIXED_NOW)
    assert completed.status is RemoteOperationStatus.COMPLETED
    assert completed.external_id == "external"
    assert completed.version == 1

    with pytest.raises(InvalidStateTransition, match="cannot complete"):
        completed.complete("again")
    with pytest.raises(ValueError, match="external_id"):
        operation.complete("")
