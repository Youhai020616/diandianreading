"""Path, frontmatter, and deep-link primitives for Obsidian export.

This module is the security boundary of C2. Everything it handles is untrusted:
directory names come from book metadata, body text comes from the provider, and
the vault itself is a directory the user edits by hand between exports.

Three refusals are encoded here rather than left implicit:

* a path segment can never escape the vault root (ADR-0008 section 6);
* body text can never terminate or forge the YAML frontmatter (section 7);
* an export never silently overwrites a file the user has edited (section 5).
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

#: Frontmatter key holding the stable local identity used for reconciliation.
DIANDIAN_ID_KEY = "diandian_id"

#: Frontmatter key holding the digest of the body this product last wrote.
DIANDIAN_HASH_KEY = "diandian_content_hash"

#: Suffix for the file written instead of overwriting a user's manual edit.
CONFLICT_SUFFIX = ".diandian-conflict.md"

MAX_SEGMENT_CODEPOINTS = 80

_WINDOWS_RESERVED = frozenset(
    {
        "con",
        "prn",
        "aux",
        "nul",
        *(f"com{index}" for index in range(1, 10)),
        *(f"lpt{index}" for index in range(1, 10)),
    }
)

# Separators, control characters, and the characters Windows and macOS refuse.
_UNSAFE = re.compile(r"[\x00-\x1f\x7f/\\:*?\"<>|]")
_COLLAPSE = re.compile(r"\s+")


class VaultPathError(ValueError):
    """A path could not be produced safely inside the vault."""


def sanitize_segment(raw: str) -> str:
    """Turn untrusted text into one safe path segment.

    The result never contains a separator, never starts with a dot, is never a
    reserved device name, and is bounded. An input that sanitises to nothing
    becomes ``untitled`` rather than an empty segment, because an empty segment
    would silently collapse the path and place the file one directory up.
    """

    normalized = unicodedata.normalize("NFC", raw)
    stripped = _UNSAFE.sub(" ", normalized)
    collapsed = _COLLAPSE.sub(" ", stripped).strip(" .")
    if not collapsed:
        return "untitled"
    if collapsed.lower() in _WINDOWS_RESERVED:
        collapsed = f"{collapsed}-file"
    return collapsed[:MAX_SEGMENT_CODEPOINTS].strip(" .") or "untitled"


def resolve_in_vault(vault_root: Path, *segments: str) -> Path:
    """Join sanitised segments under the vault root and assert containment.

    Sanitising and then re-checking the resolved path is deliberate belt and
    braces: a bug in the sanitiser must not be sufficient to write outside the
    vault, so containment is verified again after resolution.
    """

    if not segments:
        raise VaultPathError("An export path needs at least one segment")
    root = vault_root.resolve()
    candidate = root
    for segment in segments:
        candidate = candidate / sanitize_segment(segment)
    resolved = Path(candidate).resolve()
    if resolved != root and root not in resolved.parents:
        raise VaultPathError("Export path escaped the vault root")
    return resolved


def content_digest(body: str) -> str:
    """Digest of the body this product wrote, used to detect manual edits."""

    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _escape_body(body: str) -> str:
    """Neutralise lines that would terminate or forge the frontmatter.

    A provider answer may legitimately contain a Markdown thematic break. Left
    alone at the start of a line it would close the YAML block, making every
    following line parse as body — or, worse, letting generated text inject a
    ``diandian_id`` and hijack reconciliation.
    """

    lines = []
    for line in body.splitlines():
        if line.strip() == "---" or line.startswith(
            (f"{DIANDIAN_ID_KEY}:", f"{DIANDIAN_HASH_KEY}:")
        ):
            lines.append(f"\u200b{line}")
        else:
            lines.append(line)
    return "\n".join(lines)


def _quote_yaml(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")
    return f'"{escaped}"'


@dataclass(frozen=True, slots=True)
class ObsidianDocument:
    """A rendered export target: frontmatter plus escaped body."""

    diandian_id: str
    body: str
    text: str
    digest: str


def build_document(
    *,
    diandian_id: str,
    title: str,
    body: str,
    extra: dict[str, str] | None = None,
) -> ObsidianDocument:
    """Render one export file with a machine-readable identity header."""

    if not diandian_id.strip():
        raise VaultPathError("An export document needs a stable identity")
    safe_body = _escape_body(body)
    digest = content_digest(safe_body)
    lines = [
        "---",
        f"{DIANDIAN_ID_KEY}: {_quote_yaml(diandian_id)}",
        f"{DIANDIAN_HASH_KEY}: {digest}",
        f"title: {_quote_yaml(title)}",
    ]
    for key, value in sorted((extra or {}).items()):
        if key in {DIANDIAN_ID_KEY, DIANDIAN_HASH_KEY, "title"}:
            raise VaultPathError(f"Frontmatter key {key} is reserved for the exporter")
        lines.append(f"{key}: {_quote_yaml(value)}")
    lines.extend(["---", "", safe_body, ""])
    return ObsidianDocument(
        diandian_id=diandian_id,
        body=safe_body,
        text="\n".join(lines),
        digest=digest,
    )


def parse_frontmatter(text: str) -> dict[str, str]:
    """Read a bounded frontmatter block, ignoring anything malformed.

    Only the exporter's own keys matter, so this is intentionally a minimal
    reader rather than a YAML parser: a vault file is untrusted input, and
    handing it to a general parser would widen the attack surface for no gain.
    """

    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    fields: dict[str, str] = {}
    for line in lines[1:]:
        if line.strip() == "---":
            break
        key, separator, value = line.partition(":")
        if not separator:
            continue
        cleaned = value.strip()
        if len(cleaned) >= 2 and cleaned[0] == '"' and cleaned[-1] == '"':
            cleaned = cleaned[1:-1].replace('\\"', '"').replace("\\\\", "\\")
        fields[key.strip()] = cleaned
    return fields


def deep_link(vault_name: str, relative_path: str) -> str:
    """Build the ``obsidian://`` URL that opens an exported file.

    The reverse direction deliberately stays an ordinary local HTTP URL: D2
    froze the rule that the desktop shell exposes no Tauri command, and adding a
    custom scheme would create a new way into that boundary (ADR-0008 section 8).
    """

    return (
        f"obsidian://open?vault={quote(vault_name, safe='')}&file={quote(relative_path, safe='')}"
    )
