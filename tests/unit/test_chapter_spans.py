from __future__ import annotations

from itertools import pairwise

import pytest

from diandianreading.infrastructure.documents.policy import (
    markdown_chapter_spans,
    markdown_chapters,
    normalize_markdown,
)

HEADED = "Preamble text.\n\n# One\n\nBody one.\n\n## Two\n\nBody two.\n"
HEADLESS = "Just prose without any heading.\n\nSecond paragraph.\n"


class TestMarkdownChapterSpans:
    def test_spans_tile_the_normalized_text_exactly(self) -> None:
        normalized = normalize_markdown(HEADED)
        spans = markdown_chapter_spans(HEADED)
        assert spans[0].start == 0
        assert spans[-1].end == len(normalized)
        for previous, following in pairwise(spans):
            assert previous.end == following.start

    def test_spans_match_markdown_chapters(self) -> None:
        normalized = normalize_markdown(HEADED)
        chapters = markdown_chapters(HEADED)
        spans = markdown_chapter_spans(HEADED)
        assert [span.reference for span in spans] == [chapter.reference for chapter in chapters]
        assert [normalized[span.start : span.end] for span in spans] == [
            chapter.markdown for chapter in chapters
        ]

    def test_heading_titles_are_extracted(self) -> None:
        spans = markdown_chapter_spans(HEADED)
        assert [span.title for span in spans] == ["", "One", "Two"]

    def test_headless_document_is_one_section(self) -> None:
        spans = markdown_chapter_spans(HEADLESS)
        assert len(spans) == 1
        assert spans[0].reference == "markdown-section-0001"
        assert spans[0].start == 0
        assert spans[0].end == len(normalize_markdown(HEADLESS))

    def test_document_starting_with_heading_has_no_preamble(self) -> None:
        spans = markdown_chapter_spans("# First\n\nBody.\n")
        assert [span.reference for span in spans] == ["markdown-heading-0001"]
        assert spans[0].start == 0

    def test_empty_document_is_rejected(self) -> None:
        with pytest.raises(Exception, match="no readable text"):
            markdown_chapter_spans("   \n")
