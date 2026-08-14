#!/usr/bin/env python3
"""Smoke an installed diandianreading Web process through its real TCP boundary."""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

ORIGIN = "http://localhost:3000"
START_TIMEOUT_SECONDS = 20.0
STOP_TIMEOUT_SECONDS = 15.0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--command", type=Path, required=True)
    parser.add_argument("--home", type=Path, required=True)
    args = parser.parse_args()
    command = args.command.resolve()
    home = args.home.resolve()
    if not command.is_file():
        raise ValueError("installed Web command is unavailable")
    if home.exists():
        raise ValueError("Web smoke home must not already exist")

    environment = dict(os.environ)
    environment["PYTHONUNBUFFERED"] = "1"
    process = subprocess.Popen(
        [
            str(command),
            "--home",
            str(home),
            "web",
            "--no-open",
            "--json",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        env=environment,
    )
    stdout = ""
    stderr = ""
    try:
        health = _wait_for_url(f"{ORIGIN}/healthz", process)
        if json.loads(health) != {"status": "ok"}:
            raise RuntimeError("installed Web process returned an invalid health response")
        index = _read_url(f"{ORIGIN}/")
        assets = re.findall(r'(?:src|href)="\./(assets/[^"]+)"', index)
        if not assets:
            raise RuntimeError("installed Web process did not serve built assets")
        main_asset = next((asset for asset in assets if asset.endswith(".js")), None)
        if main_asset is None or not _read_url(f"{ORIGIN}/{main_asset}"):
            raise RuntimeError("installed Web process did not serve its JavaScript asset")
    finally:
        if process.poll() is None:
            process.terminate()
        try:
            stdout, stderr = process.communicate(timeout=STOP_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            process.kill()
            stdout, stderr = process.communicate(timeout=5.0)
            raise RuntimeError("installed Web process did not stop after SIGTERM") from None

    expected_exit_codes = {0, -signal.SIGTERM, 128 + signal.SIGTERM}
    if process.returncode not in expected_exit_codes:
        raise RuntimeError(f"installed Web process exited with {process.returncode}")
    lines = [line for line in stdout.splitlines() if line.strip()]
    if len(lines) != 1:
        raise RuntimeError("installed Web process emitted an unexpected stdout shape")
    startup = json.loads(lines[0])
    if startup.get("status") != "starting" or startup.get("origin") != ORIGIN:
        raise RuntimeError("installed Web process emitted an invalid startup record")
    combined = f"{stdout}\n{stderr}".casefold()
    if "bootstrap=" in combined or "authorization:" in combined or "cookie:" in combined:
        raise RuntimeError("installed Web process output exposed a credential-shaped value")
    print(
        json.dumps(
            {
                "asset_verified": True,
                "health_verified": True,
                "process_stopped": True,
                "startup_record_verified": True,
                "status": "ok",
            },
            sort_keys=True,
        )
    )
    return 0


def _wait_for_url(url: str, process: subprocess.Popen[str]) -> str:
    deadline = time.monotonic() + START_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("installed Web process exited before readiness")
        try:
            return _read_url(url)
        except (OSError, urllib.error.URLError):
            time.sleep(0.1)
    raise RuntimeError("installed Web process did not become ready")


def _read_url(url: str) -> str:
    request = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(request, timeout=2.0) as response:
        return response.read().decode("utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
