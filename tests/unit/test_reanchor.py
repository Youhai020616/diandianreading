from __future__ import annotations

from datetime import timedelta

import pytest

from diandianreading.application.services.reanchor import (
    ReanchorDisposition,
    reanchor_annotation,
    reanchor_annotations,
)
from diandianreading.domain.annotations import (
    Annotation,
    AnnotationColor,
    AnnotationKind,
    AnnotationStatus,
    ContentAnchor,
    TextQuote,
)
from diandianreading.domain.chat import ChatReferenceLocationType
from tests.support import FIXED_NOW

OLD_SHA = "deadbeef" * 8
NEW_SHA = "cafef00d" * 8
LATER = FIXED_NOW + timedelta(minutes=5)

CHAPTER_ONE = "# Chapter One\n\nThe quick brown fox jumps over the lazy dog.\n\n"
CHAPTER_TWO = "# Chapter Two\n\nPack my box with five dozen liquor jugs.\n"
OLD_DOC = CHAPTER_ONE + CHAPTER_TWO


def make_highlight(
    exact: str,
    *,
    prefix: str = "",
    suffix: str = "",
    start: int = 0,
    annotation_id: str = "ann-1",
    sha256: str = OLD_SHA,
    status: AnnotationStatus = AnnotationStatus.ACTIVE,
) -> Annotation:
    return Annotation(
        id=annotation_id,
        book_id="book-1",
        kind=AnnotationKind.HIGHLIGHT,
        status=status,
        anchor=ContentAnchor(
            type=ChatReferenceLocationType.MARKDOWN_OFFSET,
            anchor_sha256=sha256,
            start=start,
            end=start + len(exact),
            chapter_ref="markdown-heading-0001",
            quote=TextQuote(exact=exact, prefix=prefix, suffix=suffix),
        ),
        selected_text=exact,
        body=None,
        color=AnnotationColor.YELLOW,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
        version=0,
    )


def make_note(
    *,
    annotation_id: str = "note-1",
    anchor: ContentAnchor | None = None,
    status: AnnotationStatus = AnnotationStatus.ACTIVE,
) -> Annotation:
    return Annotation(
        id=annotation_id,
        book_id="book-1",
        kind=AnnotationKind.NOTE,
        status=status,
        anchor=anchor,
        selected_text=None,
        body="my private thought",
        color=None,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
        version=0,
    )


def test_unchanged_document_hash_preserves_annotation_untouched() -> None:
    exact = "quick brown fox"
    annotation = make_highlight(exact, start=OLD_DOC.index(exact))
    result = reanchor_annotation(
        annotation, document_text=OLD_DOC, document_sha256=OLD_SHA, now=LATER
    )
    assert result.disposition is ReanchorDisposition.UNCHANGED
    assert result.annotation is annotation
    assert not result.changed


def test_local_edit_reanchors_unique_quote_to_new_offsets() -> None:
    new_doc = "# Preface\n\nNewly added words.\n\n" + OLD_DOC
    exact = "quick brown fox"
    annotation = make_highlight(exact, prefix="The ", suffix=" jumps", start=OLD_DOC.index(exact))
    result = reanchor_annotation(
        annotation, document_text=new_doc, document_sha256=NEW_SHA, now=LATER
    )
    assert result.disposition is ReanchorDisposition.REANCHORED
    assert result.changed
    moved = result.annotation
    assert moved.status is AnnotationStatus.ACTIVE
    anchor = moved.anchor
    assert anchor is not None
    assert anchor.anchor_sha256 == NEW_SHA
    assert (anchor.start, anchor.end) == (new_doc.index(exact), new_doc.index(exact) + len(exact))
    assert anchor.start is not None and anchor.end is not None
    assert new_doc[anchor.start : anchor.end] == exact
    assert anchor.chapter_ref is None
    assert annotation.anchor is not None and anchor.quote == annotation.anchor.quote
    assert moved.selected_text == exact
    assert moved.version == annotation.version + 1
    assert moved.updated_at == LATER


def test_chapter_reorder_reanchors_quote_in_moved_chapter() -> None:
    new_doc = CHAPTER_TWO + "\n" + CHAPTER_ONE
    exact = "quick brown fox"
    annotation = make_highlight(exact, start=OLD_DOC.index(exact))
    result = reanchor_annotation(
        annotation, document_text=new_doc, document_sha256=NEW_SHA, now=LATER
    )
    assert result.disposition is ReanchorDisposition.REANCHORED
    anchor = result.annotation.anchor
    assert anchor is not None and anchor.start == new_doc.index(exact)


def test_repeated_text_without_context_orphans() -> None:
    exact = "to be or not to be"
    new_doc = f"{exact}, that is the question. Later the refrain returns: {exact} once more."
    annotation = make_highlight(exact, start=0)
    result = reanchor_annotation(
        annotation, document_text=new_doc, document_sha256=NEW_SHA, now=LATER
    )
    assert result.disposition is ReanchorDisposition.ORPHANED
    orphan = result.annotation
    assert orphan.status is AnnotationStatus.ORPHANED
    assert orphan.anchor == annotation.anchor
    assert orphan.selected_text == annotation.selected_text
    assert orphan.version == annotation.version + 1
    assert orphan.updated_at == LATER


def test_zero_hits_orphans() -> None:
    annotation = make_highlight("vanished text")
    result = reanchor_annotation(
        annotation, document_text=OLD_DOC, document_sha256=NEW_SHA, now=LATER
    )
    assert result.disposition is ReanchorDisposition.ORPHANED


def test_prefix_and_suffix_disambiguate_between_duplicates() -> None:
    exact = "hello world"
    new_doc = f"Alpha says {exact} first. Beta says {exact} second."
    annotation = make_highlight(exact, prefix="Beta says ", suffix=" second")
    result = reanchor_annotation(
        annotation, document_text=new_doc, document_sha256=NEW_SHA, now=LATER
    )
    assert result.disposition is ReanchorDisposition.REANCHORED
    anchor = result.annotation.anchor
    assert anchor is not None and anchor.start == new_doc.rindex(exact)


def test_context_that_stays_ambiguous_orphans() -> None:
    exact = "hello world"
    new_doc = f"A said: {exact}. B said: {exact}. "
    annotation = make_highlight(exact, prefix="said: ", suffix=". ")
    result = reanchor_annotation(
        annotation, document_text=new_doc, document_sha256=NEW_SHA, now=LATER
    )
    assert result.disposition is ReanchorDisposition.ORPHANED


def test_context_that_matches_nowhere_orphans() -> None:
    exact = "hello world"
    new_doc = f"A said: {exact}. B said: {exact}. "
    annotation = make_highlight(exact, prefix="C said: ", suffix="!")
    result = reanchor_annotation(
        annotation, document_text=new_doc, document_sha256=NEW_SHA, now=LATER
    )
    assert result.disposition is ReanchorDisposition.ORPHANED


def test_overlapping_hits_are_ambiguous_until_context_filters() -> None:
    ambiguous = make_highlight("aaa", annotation_id="ann-a")
    result = reanchor_annotation(
        ambiguous, document_text="aaaa", document_sha256=NEW_SHA, now=LATER
    )
    assert result.disposition is ReanchorDisposition.ORPHANED

    contextual = make_highlight("aaa", prefix="a", annotation_id="ann-b")
    result = reanchor_annotation(
        contextual, document_text="aaaa", document_sha256=NEW_SHA, now=LATER
    )
    assert result.disposition is ReanchorDisposition.REANCHORED
    anchor = result.annotation.anchor
    assert anchor is not None and (anchor.start, anchor.end) == (1, 4)


def test_orphaned_annotation_is_left_untouched() -> None:
    exact = "quick brown fox"
    annotation = make_highlight(exact, status=AnnotationStatus.ORPHANED)
    result = reanchor_annotation(
        annotation, document_text=OLD_DOC, document_sha256=NEW_SHA, now=LATER
    )
    assert result.disposition is ReanchorDisposition.UNCHANGED
    assert result.annotation is annotation


def test_deleted_annotation_is_left_untouched() -> None:
    annotation = make_highlight("quick brown fox", status=AnnotationStatus.DELETED)
    result = reanchor_annotation(
        annotation, document_text=OLD_DOC, document_sha256=NEW_SHA, now=LATER
    )
    assert result.disposition is ReanchorDisposition.UNCHANGED
    assert result.annotation is annotation


def test_unanchored_note_is_left_untouched() -> None:
    annotation = make_note()
    result = reanchor_annotation(
        annotation, document_text=OLD_DOC, document_sha256=NEW_SHA, now=LATER
    )
    assert result.disposition is ReanchorDisposition.UNCHANGED
    assert result.annotation is annotation


def test_pdf_anchor_orphans_when_document_hash_changes() -> None:
    anchor = ContentAnchor(type=ChatReferenceLocationType.PDF_PAGE, anchor_sha256=OLD_SHA, start=3)
    annotation = make_note(anchor=anchor)
    same = reanchor_annotation(
        annotation, document_text=OLD_DOC, document_sha256=OLD_SHA, now=LATER
    )
    assert same.disposition is ReanchorDisposition.UNCHANGED
    changed = reanchor_annotation(
        annotation, document_text=OLD_DOC, document_sha256=NEW_SHA, now=LATER
    )
    assert changed.disposition is ReanchorDisposition.ORPHANED
    assert changed.annotation.anchor == anchor


def test_markdown_anchor_without_quote_orphans() -> None:
    anchor = ContentAnchor(
        type=ChatReferenceLocationType.MARKDOWN_OFFSET,
        anchor_sha256=OLD_SHA,
        start=0,
        end=5,
    )
    annotation = make_note(anchor=anchor)
    result = reanchor_annotation(
        annotation, document_text=OLD_DOC, document_sha256=NEW_SHA, now=LATER
    )
    assert result.disposition is ReanchorDisposition.ORPHANED


def test_anchored_note_with_quote_reanchors_like_a_highlight() -> None:
    exact = "five dozen liquor jugs"
    anchor = ContentAnchor(
        type=ChatReferenceLocationType.MARKDOWN_OFFSET,
        anchor_sha256=OLD_SHA,
        start=OLD_DOC.index(exact),
        end=OLD_DOC.index(exact) + len(exact),
        quote=TextQuote(exact=exact),
    )
    annotation = make_note(anchor=anchor)
    new_doc = "prelude\n\n" + OLD_DOC
    result = reanchor_annotation(
        annotation, document_text=new_doc, document_sha256=NEW_SHA, now=LATER
    )
    assert result.disposition is ReanchorDisposition.REANCHORED
    moved = result.annotation.anchor
    assert moved is not None and moved.start == new_doc.index(exact)


def test_offsets_are_unicode_codepoints() -> None:
    exact = "海上生明月"
    new_doc = "🌊🌊 序言。海上生明月。天涯共此时。"
    annotation = make_highlight(exact, start=0)
    result = reanchor_annotation(
        annotation, document_text=new_doc, document_sha256=NEW_SHA, now=LATER
    )
    assert result.disposition is ReanchorDisposition.REANCHORED
    anchor = result.annotation.anchor
    assert anchor is not None
    assert (anchor.start, anchor.end) == (new_doc.index(exact), new_doc.index(exact) + len(exact))
    assert anchor.start is not None and anchor.end is not None
    assert new_doc[anchor.start : anchor.end] == exact


@pytest.mark.parametrize(
    "bad_sha",
    ["", "short", "G" * 64, ("deadbeef" * 8).upper(), "deadbeef" * 8 + "0"],
)
def test_rejects_malformed_document_sha(bad_sha: str) -> None:
    annotation = make_highlight("quick brown fox")
    with pytest.raises(ValueError, match="lowercase sha256"):
        reanchor_annotation(annotation, document_text=OLD_DOC, document_sha256=bad_sha, now=LATER)


def test_batch_is_per_annotation_and_reentrant() -> None:
    new_doc = "# Preface\n\nNewly added words.\n\n" + OLD_DOC
    exact = "quick brown fox"
    reanchorable = make_highlight(exact, start=OLD_DOC.index(exact), annotation_id="ann-move")
    doomed = make_highlight("vanished text", annotation_id="ann-orphan")
    floating_note = make_note(annotation_id="ann-note")
    deleted = make_highlight(exact, annotation_id="ann-deleted", status=AnnotationStatus.DELETED)
    already_current = make_highlight(
        "Pack my box",
        start=new_doc.index("Pack my box"),
        sha256=NEW_SHA,
        annotation_id="ann-current",
    )
    batch = [reanchorable, doomed, floating_note, deleted, already_current]

    first = reanchor_annotations(batch, document_text=new_doc, document_sha256=NEW_SHA, now=LATER)
    assert [result.disposition for result in first] == [
        ReanchorDisposition.REANCHORED,
        ReanchorDisposition.ORPHANED,
        ReanchorDisposition.UNCHANGED,
        ReanchorDisposition.UNCHANGED,
        ReanchorDisposition.UNCHANGED,
    ]
    assert [result.changed for result in first] == [True, True, False, False, False]

    swept = [result.annotation for result in first]
    second = reanchor_annotations(
        swept,
        document_text=new_doc,
        document_sha256=NEW_SHA,
        now=LATER + timedelta(minutes=1),
    )
    assert all(result.disposition is ReanchorDisposition.UNCHANGED for result in second)
    assert [result.annotation for result in second] == swept
    for result, annotation in zip(second, swept, strict=True):
        assert result.annotation is annotation


@pytest.mark.parametrize("padding", [0, 1, 17, 64, 350])
@pytest.mark.parametrize("copies", [1, 2, 3])
def test_hit_count_governs_disposition_wherever_the_quote_lands(padding: int, copies: int) -> None:
    exact = "an unmistakable sentence"
    new_doc = "".join(f"{'x' * padding}[{index}] {exact} tail-{index}. " for index in range(copies))
    annotation = make_highlight(exact)
    result = reanchor_annotation(
        annotation, document_text=new_doc, document_sha256=NEW_SHA, now=LATER
    )
    if copies == 1:
        assert result.disposition is ReanchorDisposition.REANCHORED
        anchor = result.annotation.anchor
        assert anchor is not None and anchor.start is not None and anchor.end is not None
        assert new_doc[anchor.start : anchor.end] == exact
    else:
        assert result.disposition is ReanchorDisposition.ORPHANED


@pytest.mark.parametrize("target", [0, 1, 2])
def test_context_selects_exactly_the_annotated_occurrence(target: int) -> None:
    exact = "repeated refrain"
    new_doc = "".join(f"<<{index}>> {exact} (({index})) " for index in range(3))
    annotation = make_highlight(exact, prefix=f"<<{target}>> ", suffix=f" (({target}))")
    result = reanchor_annotation(
        annotation, document_text=new_doc, document_sha256=NEW_SHA, now=LATER
    )
    assert result.disposition is ReanchorDisposition.REANCHORED
    anchor = result.annotation.anchor
    assert anchor is not None
    marker = f"<<{target}>> "
    assert anchor.start == new_doc.index(marker) + len(marker)
