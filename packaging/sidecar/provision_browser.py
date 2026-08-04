#!/usr/bin/env python3
"""Provision the exact Chromium revision used by a desktop-sidecar artifact."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from importlib.metadata import version
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="provision bundled Playwright Chromium")
    parser.add_argument(
        "--output", type=Path, required=True, help="empty browser resource directory"
    )
    return parser.parse_args()


def _browser_executable(root: Path) -> Path | None:
    executable_names = {"chromium", "chrome", "google chrome for testing"}
    return next(
        (
            path
            for path in root.rglob("*")
            if path.is_file() and path.name.casefold() in executable_names
        ),
        None,
    )


def main() -> int:
    args = parse_args()
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()):
        raise ValueError("Browser output directory must be empty")
    output.mkdir(parents=True, exist_ok=True)
    environment = {**os.environ, "PLAYWRIGHT_BROWSERS_PATH": str(output)}
    try:
        subprocess.run(
            [sys.executable, "-m", "playwright", "install", "chromium"],
            check=True,
            env=environment,
        )
        executable = _browser_executable(output)
        if executable is None:
            raise ValueError("Playwright provisioning did not create a Chromium executable")
        revision_directory = next(
            (parent for parent in executable.parents if parent.parent == output), None
        )
        if revision_directory is None:
            raise ValueError("Playwright Chromium revision directory is invalid")
        (output / "browser-manifest.json").write_text(
            json.dumps(
                {
                    "format": "diandian-browser-manifest-v1",
                    "browser": "chromium",
                    "playwright_version": version("playwright"),
                    "revision": revision_directory.name,
                    "executable": str(executable.relative_to(output)),
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
    except BaseException:
        shutil.rmtree(output, ignore_errors=True)
        raise
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
