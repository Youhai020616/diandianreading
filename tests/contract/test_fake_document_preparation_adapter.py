from __future__ import annotations

import asyncio
from dataclasses import replace

import pytest

from diandianreading.application.ports import NullProgressSink
from diandianreading.domain import DiandianError, ErrorCode, StorageKey, TargetCapabilities
from diandianreading.infrastructure.fakes import FakeDocumentPreparationAdapter
from tests.support import RecordingProgressSink, make_import_command


def capabilities(
    *,
    max_source_words: int = 350_000,
    max_source_bytes: int = 10_000_000,
    max_sources_per_workspace: int = 50,
) -> TargetCapabilities:
    return TargetCapabilities(
        max_source_words=max_source_words,
        max_source_bytes=max_source_bytes,
        max_sources_per_workspace=max_sources_per_workspace,
        accepted_mime_types=frozenset({"text/markdown"}),
    )


def test_fake_preparation_returns_deterministic_parts_manifest_and_progress(tmp_path) -> None:
    command = make_import_command(tmp_path)
    progress = RecordingProgressSink(events=[])

    prepared = asyncio.run(
        FakeDocumentPreparationAdapter(command.parts).prepare(
            command.asset,
            capabilities(),
            progress,
        )
    )

    assert prepared.derived_assets == ()
    assert prepared.parts == command.parts
    assert prepared.manifest_key == StorageKey(f"manifests/{command.asset.id}.json")
    assert len(progress.events) == 1
    assert progress.events[0].job_id == progress.job_id
    assert progress.events[0].step == "preparing"
    assert progress.events[0].current == len(command.parts)
    assert progress.events[0].total == len(command.parts)


def test_fake_preparation_rejects_unsupported_input_mime(tmp_path) -> None:
    command = make_import_command(tmp_path, part_count=1)
    unsupported = replace(command.asset, mime_type="application/epub+zip")

    with pytest.raises(DiandianError) as raised:
        asyncio.run(
            FakeDocumentPreparationAdapter(command.parts).prepare(
                unsupported,
                capabilities(),
                NullProgressSink("job-1"),
            )
        )

    assert raised.value.code is ErrorCode.FORMAT_UNSUPPORTED
    assert raised.value.retryable is False


def test_fake_preparation_rejects_part_for_another_asset(tmp_path) -> None:
    command = make_import_command(tmp_path, part_count=1)
    wrong_part = replace(command.parts[0], asset_id="another-asset")

    with pytest.raises(ValueError, match="belongs to another asset"):
        asyncio.run(
            FakeDocumentPreparationAdapter((wrong_part,)).prepare(
                command.asset,
                capabilities(),
                NullProgressSink("job-1"),
            )
        )


def test_fake_preparation_rejects_empty_or_structurally_invalid_parts(tmp_path) -> None:
    command = make_import_command(tmp_path, part_count=2)
    invalid_cases = (
        ((), "at least one"),
        ((replace(command.parts[0], sequence=1),), "contiguous"),
        (
            (command.parts[0], replace(command.parts[1], id=command.parts[0].id)),
            "unique identities",
        ),
    )

    for parts, expected_message in invalid_cases:
        with pytest.raises(ValueError, match=expected_message):
            asyncio.run(
                FakeDocumentPreparationAdapter(parts).prepare(
                    command.asset,
                    capabilities(),
                    NullProgressSink("job-1"),
                )
            )


def test_fake_preparation_rejects_unsupported_output_mime(tmp_path) -> None:
    command = make_import_command(tmp_path, part_count=1)
    unsupported = replace(command.parts[0], mime_type="application/pdf")

    with pytest.raises(DiandianError) as raised:
        asyncio.run(
            FakeDocumentPreparationAdapter((unsupported,)).prepare(
                command.asset,
                capabilities(),
                NullProgressSink("job-1"),
            )
        )

    assert raised.value.code is ErrorCode.FORMAT_UNSUPPORTED
    assert raised.value.retryable is False


def test_fake_preparation_rejects_part_over_word_limit(tmp_path) -> None:
    command = make_import_command(tmp_path, part_count=1)
    oversized = replace(command.parts[0], word_count=5)

    with pytest.raises(DiandianError) as raised:
        asyncio.run(
            FakeDocumentPreparationAdapter((oversized,)).prepare(
                command.asset,
                capabilities(max_source_words=4),
                NullProgressSink("job-1"),
            )
        )

    assert raised.value.code is ErrorCode.SOURCE_LIMIT_EXCEEDED
    assert raised.value.retryable is False


def test_fake_preparation_rejects_part_over_byte_limit(tmp_path) -> None:
    command = make_import_command(tmp_path, part_count=1)

    with pytest.raises(DiandianError) as raised:
        asyncio.run(
            FakeDocumentPreparationAdapter(command.parts).prepare(
                command.asset,
                capabilities(max_source_bytes=1),
                NullProgressSink("job-1"),
            )
        )

    assert raised.value.code is ErrorCode.SOURCE_LIMIT_EXCEEDED
    assert raised.value.retryable is False


def test_fake_preparation_rejects_source_count_over_limit(tmp_path) -> None:
    command = make_import_command(tmp_path, part_count=2)

    with pytest.raises(DiandianError) as raised:
        asyncio.run(
            FakeDocumentPreparationAdapter(command.parts).prepare(
                command.asset,
                capabilities(max_sources_per_workspace=1),
                NullProgressSink("job-1"),
            )
        )

    assert raised.value.code is ErrorCode.SOURCE_LIMIT_EXCEEDED
    assert raised.value.retryable is False
