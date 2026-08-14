#!/usr/bin/env python3
"""Reject broken relative Markdown links in repository documentation."""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

_LINK = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
_EXCLUDED_PARTS = frozenset({".git", ".tmp", ".venv", "dist", "node_modules"})


def main() -> int:
    missing: list[str] = []
    for document in sorted(Path.cwd().rglob("*.md")):
        if _EXCLUDED_PARTS.intersection(document.parts):
            continue
        payload = document.read_text(encoding="utf-8")
        for match in _LINK.finditer(payload):
            raw_target = match.group(1).strip().split(maxsplit=1)[0].strip("<>")
            parsed = urlsplit(raw_target)
            if not raw_target or parsed.scheme or raw_target.startswith("#"):
                continue
            relative = unquote(parsed.path)
            if relative and not (document.parent / relative).exists():
                missing.append(f"{document}: {relative}")
    if missing:
        raise ValueError("Missing relative Markdown links:\n" + "\n".join(missing))
    print("relative Markdown links: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
