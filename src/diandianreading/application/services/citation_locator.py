"""Locate provider citation excerpts inside the canonical reading document.

Providers return citation excerpts but no positions (ADR-0007 §2). This
module derives a local ``[start, end)`` codepoint interval by searching the
excerpt in the derived reading text. Only an unambiguous hit produces a
location: zero hits or multiple surviving candidates yield ``None`` so a
citation is never fabricated. Matching is deterministic — an exact pass
first, then a whitespace-run-canonicalized pass with an index map back to
original offsets; there is no fuzzy scoring.
"""

from __future__ import annotations

from dataclasses import dataclass

MIN_EXCERPT_CODEPOINTS = 12


@dataclass(frozen=True, slots=True)
class ExcerptLocation:
    start: int
    end: int


def locate_excerpt(text: str, excerpt: str) -> ExcerptLocation | None:
    """Return the unique location of ``excerpt`` in ``text``, or ``None``."""

    needle = excerpt.strip()
    if len(needle) < MIN_EXCERPT_CODEPOINTS:
        return None

    exact = _unique_find(text, needle)
    if exact is not None:
        return ExcerptLocation(exact, exact + len(needle))
    if _count_occurrences(text, needle) > 1:
        return None

    collapsed_text, index_map = _collapse_whitespace(text)
    collapsed_needle, _ = _collapse_whitespace(needle)
    if len(collapsed_needle) < MIN_EXCERPT_CODEPOINTS:
        return None
    position = _unique_find(collapsed_text, collapsed_needle)
    if position is None:
        return None
    start = index_map[position]
    last_index = position + len(collapsed_needle) - 1
    end = index_map[last_index] + 1
    return ExcerptLocation(start, end)


def _unique_find(text: str, needle: str) -> int | None:
    first = text.find(needle)
    if first < 0:
        return None
    if text.find(needle, first + 1) >= 0:
        return None
    return first


def _count_occurrences(text: str, needle: str) -> int:
    count = 0
    cursor = text.find(needle)
    while cursor >= 0 and count < 2:
        count += 1
        cursor = text.find(needle, cursor + 1)
    return count


def _collapse_whitespace(value: str) -> tuple[str, list[int]]:
    """Collapse whitespace runs to single spaces, keeping an offset map."""

    characters: list[str] = []
    index_map: list[int] = []
    in_whitespace = False
    for index, character in enumerate(value):
        if character.isspace():
            if not in_whitespace and characters:
                characters.append(" ")
                index_map.append(index)
            in_whitespace = True
            continue
        in_whitespace = False
        characters.append(character)
        index_map.append(index)
    while characters and characters[-1] == " ":
        characters.pop()
        index_map.pop()
    return "".join(characters), index_map
