#!/usr/bin/env python3
"""Smoke an installed diandianreading Web process through its real TCP boundary."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ORIGIN = "http://localhost:3000"
START_TIMEOUT_SECONDS = 20.0
STOP_TIMEOUT_SECONDS = 15.0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--command", required=True)
    parser.add_argument("--command-arg", action="append", default=[])
    parser.add_argument("--working-directory", type=Path)
    parser.add_argument("--start-timeout", type=float, default=START_TIMEOUT_SECONDS)
    parser.add_argument("--home", type=Path, required=True)
    args = parser.parse_args()
    if not 0 < args.start_timeout <= 300:
        raise ValueError("Web smoke start timeout is invalid")
    executable = shutil.which(args.command)
    if executable is None:
        candidate = Path(args.command).resolve()
        executable = str(candidate) if candidate.is_file() else None
    elif not Path(executable).is_absolute():
        executable = str(Path(executable).resolve())
    if executable is None:
        raise ValueError("installed Web command is unavailable")
    command = (executable, *args.command_arg)
    working_directory = (
        args.working_directory.resolve() if args.working_directory is not None else None
    )
    if working_directory is not None and not working_directory.is_dir():
        raise ValueError("Web smoke working directory is unavailable")
    home = args.home.resolve()
    if home.exists():
        raise ValueError("Web smoke home must not already exist")

    environment = dict(os.environ)
    environment["PYTHONUNBUFFERED"] = "1"
    process = subprocess.Popen(
        [
            *command,
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
        cwd=working_directory,
    )
    stdout = ""
    stderr = ""
    try:
        health = _wait_for_url(f"{ORIGIN}/healthz", process, timeout_seconds=args.start_timeout)
        if json.loads(health) != {"status": "ok"}:
            raise RuntimeError("installed Web process returned an invalid health response")
        index = _read_url(f"{ORIGIN}/")
        assets = re.findall(r'(?:src|href)="\./(assets/[^"]+)"', index)
        if not assets:
            raise RuntimeError("installed Web process did not serve built assets")
        main_asset = next((asset for asset in assets if asset.endswith(".js")), None)
        if main_asset is None or not _read_url(f"{ORIGIN}/{main_asset}"):
            raise RuntimeError("installed Web process did not serve its JavaScript asset")
        _verify_secure_reopen(
            command,
            home,
            environment=environment,
            working_directory=working_directory,
        )
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
                "reopen_verified": True,
                "startup_record_verified": True,
                "status": "ok",
            },
            sort_keys=True,
        )
    )
    return 0


def _verify_secure_reopen(
    command: tuple[str, ...],
    home: Path,
    *,
    environment: dict[str, str],
    working_directory: Path | None,
) -> None:
    opened = subprocess.run(
        [*command, "--home", str(home), "open", "--print-url"],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=20.0,
        env=environment,
        cwd=working_directory,
    )
    if opened.returncode != 0 or "do not share" not in opened.stderr:
        raise RuntimeError("installed CLI could not authenticate the running Web process")
    one_time_url = opened.stdout.strip()
    fragment = urllib.parse.parse_qs(urllib.parse.urlsplit(one_time_url).fragment)
    nonces = fragment.get("bootstrap", [])
    if len(nonces) != 1:
        raise RuntimeError("installed CLI returned an invalid reopen URL")
    body = json.dumps({"nonce": nonces[0]}).encode("utf-8")
    request = urllib.request.Request(
        f"{ORIGIN}/api/session/bootstrap",
        data=body,
        headers={"Content-Type": "application/json", "Origin": ORIGIN},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=2.0) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if payload.get("data", {}).get("authenticated") is not True:
        raise RuntimeError("installed CLI reopen nonce did not establish a browser session")


def _wait_for_url(
    url: str,
    process: subprocess.Popen[str],
    *,
    timeout_seconds: float,
) -> str:
    deadline = time.monotonic() + timeout_seconds
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
