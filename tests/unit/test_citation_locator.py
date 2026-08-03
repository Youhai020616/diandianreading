from __future__ import annotations

from diandianreading.application.services.citation_locator import (
    ExcerptLocation,
    locate_excerpt,
)

TEXT = (
    "# One\n\n"
    "The reader keeps user thoughts safe and sound.\n\n"
    "# Two\n\n"
    "A second chapter repeats nothing important.\n"
)


class TestLocateExcerpt:
    def test_unique_exact_match(self) -> None:
        excerpt = "keeps user thoughts safe"
        location = locate_excerpt(TEXT, excerpt)
        assert location is not None
        assert TEXT[location.start : location.end] == excerpt

    def test_strips_provider_padding(self) -> None:
        location = locate_excerpt(TEXT, "  keeps user thoughts safe \n")
        assert location is not None
        assert TEXT[location.start : location.end] == "keeps user thoughts safe"

    def test_zero_hits_returns_none(self) -> None:
        assert locate_excerpt(TEXT, "phrase that never appears here") is None

    def test_ambiguous_hits_return_none(self) -> None:
        text = "the repeated sentence here. the repeated sentence here."
        assert locate_excerpt(text, "the repeated sentence here") is None

    def test_short_excerpts_are_rejected(self) -> None:
        assert locate_excerpt(TEXT, "safe") is None
        assert locate_excerpt(TEXT, "   \n  ") is None

    def test_whitespace_canonicalized_match(self) -> None:
        excerpt = "keeps user\nthoughts   safe"
        location = locate_excerpt(TEXT, excerpt)
        assert location is not None
        assert TEXT[location.start : location.end] == "keeps user thoughts safe"

    def test_canonicalized_ambiguity_returns_none(self) -> None:
        text = "alpha beta  gamma delta. alpha\nbeta gamma delta."
        assert locate_excerpt(text, "alpha beta gamma delta") is None

    def test_overlapping_occurrences_are_ambiguous(self) -> None:
        text = "one two one two one two tail"
        assert locate_excerpt(text, "one two one two") is None

    def test_location_type(self) -> None:
        location = locate_excerpt(TEXT, "A second chapter repeats nothing")
        assert isinstance(location, ExcerptLocation)
        assert location.end - location.start == len("A second chapter repeats nothing")
