"""Desktop-only Python sidecar entry point and control-frame contract.

The future Tauri launcher owns the parent process.  This module deliberately has
no Tauri dependency: it exposes a narrow stdout-only control protocol that any
native launcher can authenticate before opening the local UI.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TextIO

import uvicorn

from diandianreading.interfaces.runtime import ApplicationPaths, RuntimeConfig, create_runtime
from diandianreading.interfaces.web import create_web_app

CONTROL_PROTOCOL = "diandian-desktop-v1"
LOCAL_ORIGIN = "http://localhost:3000"
MAX_CONTROL_FRAME_BYTES = 4096
MAX_BOOTSTRAP_BYTES = 512


class ControlFrameError(ValueError):
    """A launcher must reject malformed or unexpected sidecar control data."""


@dataclass(frozen=True, slots=True)
class ReadyControlFrame:
    """The sole successful startup frame; repr intentionally redacts its secret."""

    bootstrap: str

    def __repr__(self) -> str:
        return "ReadyControlFrame(bootstrap='<redacted>')"

    def to_bytes(self) -> bytes:
        payload = {
            "protocol": CONTROL_PROTOCOL,
            "event": "ready",
            "origin": LOCAL_ORIGIN,
            "bootstrap": self.bootstrap,
        }
        encoded = json.dumps(payload, separators=(",", ":"), sort_keys=False).encode("utf-8")
        if len(encoded) > MAX_CONTROL_FRAME_BYTES:
            raise ControlFrameError("Ready control frame exceeds the protocol limit")
        return encoded


def parse_ready_control_frame(encoded: bytes) -> ReadyControlFrame:
    """Parse exactly one bounded ready frame without accepting forward-compatible fields.

    The native parent uses this before it treats the process as its sidecar.
    Strict keys are intentional: accepting unknown control semantics could turn a
    future protocol mismatch into an unsafe attachment to a local process.
    """

    if not encoded or len(encoded) > MAX_CONTROL_FRAME_BYTES:
        raise ControlFrameError("Control frame size is invalid")
    try:
        decoded = encoded.decode("utf-8")
        payload = json.loads(decoded)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ControlFrameError("Control frame is not valid UTF-8 JSON") from error
    if not isinstance(payload, dict):
        raise ControlFrameError("Control frame must be a JSON object")
    expected = {"protocol", "event", "origin", "bootstrap"}
    if set(payload) != expected:
        raise ControlFrameError("Control frame fields are invalid")
    if payload["protocol"] != CONTROL_PROTOCOL or payload["event"] != "ready":
        raise ControlFrameError("Control frame protocol or event is invalid")
    if payload["origin"] != LOCAL_ORIGIN:
        raise ControlFrameError("Control frame origin is invalid")
    bootstrap = payload["bootstrap"]
    if not isinstance(bootstrap, str) or not bootstrap:
        raise ControlFrameError("Control frame bootstrap is invalid")
    if len(bootstrap.encode("utf-8")) > MAX_BOOTSTRAP_BYTES:
        raise ControlFrameError("Control frame bootstrap exceeds the protocol limit")
    if any(
        character.isspace() or ord(character) < 0x21 or ord(character) > 0x7E
        for character in bootstrap
    ):
        raise ControlFrameError("Control frame bootstrap contains unsafe characters")
    return ReadyControlFrame(bootstrap=bootstrap)


def emit_ready_control_frame(frame: ReadyControlFrame, stream: TextIO) -> None:
    """Write one protocol line and nothing else to the sidecar control stream."""

    stream.buffer.write(frame.to_bytes() + b"\n")
    stream.flush()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="diandian-desktop-sidecar")
    parser.add_argument("--home", type=Path, required=True, help="private application home")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return run(ApplicationPaths(args.home))
    except (ControlFrameError, OSError, ValueError):
        _emit_startup_failure(sys.stderr)
        return 2
    except Exception:
        _emit_startup_failure(sys.stderr)
        return 1


def run(paths: ApplicationPaths, *, stdout: TextIO | None = None) -> int:
    """Start the local runtime and authenticate it to the process parent.

    No secret is accepted through arguments or environment variables.  The
    bootstrap nonce is created only after the port has been reserved and is sent
    once through stdout.  Application logs never share that stream.
    """

    _configure_bundled_browser_runtime()
    _require_port_3000_available()
    runtime = create_runtime(paths, config=RuntimeConfig.from_environment())
    try:
        app = create_web_app(runtime)
        nonce = runtime.security.issue_bootstrap()
        emit_ready_control_frame(ReadyControlFrame(nonce.nonce), stdout or sys.stdout)
        config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=3000,
            access_log=False,
            proxy_headers=False,
            server_header=False,
            ws="none",
            limit_concurrency=64,
            timeout_keep_alive=5,
            timeout_graceful_shutdown=10,
            h11_max_incomplete_event_size=16 * 1024,
            log_level="warning",
            log_config=None,
        )
        uvicorn.Server(config).run()
        return 0
    finally:
        asyncio.run(runtime.aclose())


def _configure_bundled_browser_runtime() -> None:
    """Use only the browser copied beside a frozen executable.

    Source runs keep the normal explicit login setup. A packaged Sidecar must
    never silently fall back to the developer or user Playwright cache.
    """

    if not getattr(sys, "frozen", False):
        return
    bundle_root = getattr(sys, "_MEIPASS", None)
    if not isinstance(bundle_root, str):
        raise ValueError("Bundled browser runtime location is unavailable")
    browser_root = Path(bundle_root) / "playwright-browsers"
    manifest = browser_root / "browser-manifest.json"
    try:
        payload = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("Bundled browser manifest is unavailable") from error
    executable = payload.get("executable")
    if payload.get("browser") != "chromium" or not isinstance(executable, str):
        raise ValueError("Bundled browser manifest is invalid")
    executable_path = (browser_root / executable).resolve()
    if browser_root not in executable_path.parents or not executable_path.is_file():
        raise ValueError("Bundled Chromium executable is unavailable")
    os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(browser_root)


def _require_port_3000_available() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("127.0.0.1", 3000))
        except OSError as error:
            raise ValueError("The required localhost:3000 port is unavailable") from error


def _emit_startup_failure(stream: TextIO) -> None:
    stream.write(
        '{"status":"error","error":{"code":"SIDECAR_START_FAILED",'
        '"message":"Desktop sidecar could not start","retryable":false}}\n'
    )
    stream.flush()
