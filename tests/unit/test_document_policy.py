from __future__ import annotations

import pytest

from diandianreading.domain import DiandianError, ErrorCode, TargetCapabilities
from diandianreading.infrastructure.documents import (
    DocumentSecurityLimits,
    TextChapter,
    chunk_chapters,
    count_words,
    markdown_chapters,
    normalize_markdown,
)


def capabilities(
    *,
    max_words: int = 10,
    max_bytes: int = 1_000,
    max_sources: int = 10,
) -> TargetCapabilities:
    return TargetCapabilities(
        max_source_words=max_words,
        max_source_bytes=max_bytes,
        max_sources_per_workspace=max_sources,
        accepted_mime_types=frozenset({"text/markdown", "application/pdf"}),
    )


def test_word_count_and_markdown_chapters_are_deterministic_for_chinese_and_english() -> None:
    assert count_words("Hello durable-world 你好") == 4
    chapters = markdown_chapters("Preface\r\n\r\n# 第一章\r\nHello world\r\n## Next\r\n内容")

    assert [chapter.reference for chapter in chapters] == [
        "markdown-preamble",
        "markdown-heading-0001",
        "markdown-heading-0002",
    ]
    assert all("\r" not in chapter.markdown for chapter in chapters)
    assert normalize_markdown("  text  \n") == "text\n"


def test_chunk_policy_enforces_words_bytes_and_preserves_chapter_traceability() -> None:
    chapters = (
        TextChapter("chapter-1", "# One\n\none two three four five"),
        TextChapter("chapter-2", "# Two\n\n六七八九十"),
    )
    chunks = chunk_chapters(chapters, capabilities(max_words=4, max_bytes=24))

    assert len(chunks) >= 3
    assert all(chunk.word_count <= 4 for chunk in chunks)
    assert all(chunk.size_bytes <= 24 for chunk in chunks)
    assert {reference for chunk in chunks for reference in chunk.chapter_refs} == {
        "chapter-1",
        "chapter-2",
    }


def test_chunk_policy_deduplicates_identical_content_and_merges_chapter_references() -> None:
    chunks = chunk_chapters(
        (
            TextChapter("chapter-1", "repeat this text"),
            TextChapter("chapter-2", "repeat this text"),
        ),
        capabilities(max_words=3, max_sources=1),
    )

    assert len(chunks) == 1
    assert chunks[0].content == "repeat this text\n"
    assert chunks[0].chapter_refs == ("chapter-1", "chapter-2")


def test_chunk_policy_splits_unbroken_text_and_fails_closed_on_impossible_limits() -> None:
    chunks = chunk_chapters(
        (TextChapter("chapter", "abcdefghij"),),
        capabilities(max_words=1, max_bytes=4),
    )
    assert "".join(chunk.content.strip() for chunk in chunks) == "abcdefghij"
    assert all(chunk.size_bytes <= 4 for chunk in chunks)

    with pytest.raises(DiandianError) as raised:
        chunk_chapters(
            (TextChapter("chapter", "中"),),
            capabilities(max_words=1, max_bytes=2),
        )
    assert raised.value.code is ErrorCode.SOURCE_LIMIT_EXCEEDED


def test_chunk_policy_rejects_source_count_overflow_and_empty_text() -> None:
    with pytest.raises(DiandianError) as too_many:
        chunk_chapters(
            (TextChapter("chapter", "one two three four"),),
            capabilities(max_words=1, max_sources=2),
        )
    assert too_many.value.code is ErrorCode.SOURCE_LIMIT_EXCEEDED

    with pytest.raises(DiandianError) as empty:
        normalize_markdown(" \n\t")
    assert empty.value.code is ErrorCode.CONVERSION_FAILED


def test_document_security_limits_are_finite_and_consistent() -> None:
    assert DocumentSecurityLimits().max_archive_entries > 0
    with pytest.raises(ValueError, match="positive"):
        DocumentSecurityLimits(max_archive_entries=0)
    with pytest.raises(ValueError, match="entry limit"):
        DocumentSecurityLimits(max_archive_entry_bytes=2, max_archive_total_bytes=1)
