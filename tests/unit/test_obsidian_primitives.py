"""Path, frontmatter, and deep-link refusals for Obsidian export (C2).

The vault is a directory the user edits by hand, and every input here is
untrusted: folder names come from book metadata, bodies come from the provider.
These tests pin the three refusals ADR-0008 relies on.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from diandianreading.domain.vault import (
    DIANDIAN_HASH_KEY,
    DIANDIAN_ID_KEY,
    MAX_SEGMENT_CODEPOINTS,
    VaultPathError,
    build_document,
    content_digest,
    deep_link,
    parse_frontmatter,
    resolve_in_vault,
    sanitize_segment,
)


class TestSanitizeSegment:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("设计心理学", "设计心理学"),
            ("Design/Psychology", "Design Psychology"),
            ("..", "untitled"),
            ("../../etc/passwd", "etc passwd"),
            ("  .hidden  ", "hidden"),
            ("a\x00b", "a b"),
            ("C:\\Windows", "C Windows"),
            ("", "untitled"),
            ("   ", "untitled"),
        ],
    )
    def test_produces_a_safe_single_segment(self, raw: str, expected: str) -> None:
        assert sanitize_segment(raw) == expected

    def test_never_emits_a_separator(self) -> None:
        for raw in ("a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b"):
            assert "/" not in sanitize_segment(raw)
            assert "\\" not in sanitize_segment(raw)

    def test_renames_reserved_device_names(self) -> None:
        assert sanitize_segment("CON") == "CON-file"
        assert sanitize_segment("lpt1") == "lpt1-file"

    def test_bounds_the_length(self) -> None:
        assert len(sanitize_segment("a" * 500)) == MAX_SEGMENT_CODEPOINTS


class TestResolveInVault:
    def test_joins_beneath_the_root(self, tmp_path: Path) -> None:
        resolved = resolve_in_vault(tmp_path, "Books", "设计心理学", "Book.md")
        assert resolved.parent.name == "设计心理学"
        assert tmp_path.resolve() in resolved.parents

    @pytest.mark.parametrize(
        "segments",
        [
            ("..", "escape.md"),
            ("Books", "..", "..", "escape.md"),
            ("/absolute", "escape.md"),
            ("Books/../..", "escape.md"),
        ],
    )
    def test_traversal_attempts_stay_inside(self, tmp_path: Path, segments) -> None:
        resolved = resolve_in_vault(tmp_path, *segments)
        assert tmp_path.resolve() in resolved.parents

    def test_requires_at_least_one_segment(self, tmp_path: Path) -> None:
        with pytest.raises(VaultPathError, match="at least one segment"):
            resolve_in_vault(tmp_path)


class TestBuildDocument:
    def test_writes_identity_and_digest(self) -> None:
        document = build_document(diandian_id="book-1", title="设计心理学", body="正文")
        fields = parse_frontmatter(document.text)
        assert fields[DIANDIAN_ID_KEY] == "book-1"
        assert fields[DIANDIAN_HASH_KEY] == document.digest
        assert fields["title"] == "设计心理学"

    def test_neutralises_a_body_that_would_close_the_frontmatter(self) -> None:
        document = build_document(diandian_id="book-1", title="t", body="before\n---\nafter")
        fields = parse_frontmatter(document.text)
        # The forged break did not truncate the block: every key survived.
        assert fields[DIANDIAN_ID_KEY] == "book-1"
        assert "\u200b---" in document.text

    def test_neutralises_a_body_that_forges_an_identity(self) -> None:
        document = build_document(
            diandian_id="book-1",
            title="t",
            body=f"{DIANDIAN_ID_KEY}: attacker-controlled",
        )
        assert parse_frontmatter(document.text)[DIANDIAN_ID_KEY] == "book-1"

    def test_escapes_quotes_in_a_title(self) -> None:
        document = build_document(diandian_id="book-1", title='He said "hi"', body="b")
        assert parse_frontmatter(document.text)["title"] == 'He said "hi"'

    def test_rejects_an_empty_identity(self) -> None:
        with pytest.raises(VaultPathError, match="stable identity"):
            build_document(diandian_id="  ", title="t", body="b")

    def test_rejects_extra_keys_that_shadow_the_exporter(self) -> None:
        for key in (DIANDIAN_ID_KEY, DIANDIAN_HASH_KEY, "title"):
            with pytest.raises(VaultPathError, match="reserved"):
                build_document(diandian_id="book-1", title="t", body="b", extra={key: "x"})

    def test_accepts_additional_metadata(self) -> None:
        document = build_document(
            diandian_id="book-1", title="t", body="b", extra={"author": "Norman"}
        )
        assert parse_frontmatter(document.text)["author"] == "Norman"

    def test_digest_tracks_the_escaped_body(self) -> None:
        document = build_document(diandian_id="book-1", title="t", body="b")
        assert document.digest == content_digest(document.body)


class TestParseFrontmatter:
    def test_returns_nothing_without_a_block(self) -> None:
        assert parse_frontmatter("no frontmatter here") == {}
        assert parse_frontmatter("") == {}

    def test_ignores_malformed_lines(self) -> None:
        text = "---\ngood: value\nnot a pair\n---\nbody"
        assert parse_frontmatter(text) == {"good": "value"}

    def test_stops_at_the_closing_delimiter(self) -> None:
        text = "---\na: 1\n---\nb: 2\n"
        assert parse_frontmatter(text) == {"a": "1"}


class TestDeepLink:
    def test_encodes_the_vault_and_path(self) -> None:
        link = deep_link("My Vault", "Books/设计心理学/Book.md")
        assert link.startswith("obsidian://open?vault=My%20Vault&file=")
        assert "%2F" in link

    def test_does_not_use_a_custom_product_scheme(self) -> None:
        # ADR-0008 section 8: the reverse direction stays a local HTTP URL so the
        # desktop shell never has to parse an untrusted custom scheme.
        assert deep_link("v", "f").startswith("obsidian://")
