#!/usr/bin/env python3
"""Offline smoke test for a built desktop-sidecar directory."""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="smoke test a desktop-sidecar artifact")
    parser.add_argument("--artifact", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    executable = args.artifact / "diandian-desktop-sidecar"
    manifest = args.artifact / "sidecar-manifest.json"
    if not executable.is_file() or not manifest.is_file():
        raise ValueError("Sidecar artifact is incomplete")
    with tempfile.TemporaryDirectory(prefix="diandian-sidecar-smoke-") as temporary:
        process = subprocess.Popen(
            [str(executable), "--home", temporary],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            if process.stdout is None:
                raise ValueError("Sidecar stdout is unavailable")
            line = process.stdout.readline()
            frame = json.loads(line)
            if (
                frame.get("protocol") != "diandian-desktop-v1"
                or frame.get("origin") != "http://localhost:3000"
                or not isinstance(frame.get("bootstrap"), str)
                or not frame["bootstrap"]
            ):
                raise ValueError("Sidecar ready control frame is invalid")
            for _ in range(20):
                try:
                    with urllib.request.urlopen(
                        "http://localhost:3000/healthz", timeout=1
                    ) as response:
                        if response.status == 200:
                            break
                except OSError:
                    time.sleep(0.1)
            else:
                raise ValueError("Sidecar health endpoint did not become ready")
        finally:
            process.terminate()
            process.wait(timeout=20)
            if process.stderr is not None and process.stderr.read():
                raise ValueError("Sidecar wrote unexpected startup diagnostics")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
