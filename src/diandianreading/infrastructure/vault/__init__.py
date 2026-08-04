"""Obsidian vault export infrastructure (C2, ADR-0008)."""

from diandianreading.infrastructure.vault.obsidian import (
    CONFLICT_SUFFIX,
    DIANDIAN_ID_KEY,
    ObsidianDocument,
    build_document,
    deep_link,
    parse_frontmatter,
    resolve_in_vault,
    sanitize_segment,
)

__all__ = [
    "CONFLICT_SUFFIX",
    "DIANDIAN_ID_KEY",
    "ObsidianDocument",
    "build_document",
    "deep_link",
    "parse_frontmatter",
    "resolve_in_vault",
    "sanitize_segment",
]
