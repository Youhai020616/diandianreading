from __future__ import annotations

import io
import json

import pytest

import diandianreading.interfaces.desktop_sidecar as sidecar_module
from diandianreading.interfaces.desktop_sidecar import (
    CONTROL_PROTOCOL,
    LOCAL_ORIGIN,
    MAX_BOOTSTRAP_BYTES,
    ControlFrameError,
    ReadyControlFrame,
    emit_ready_control_frame,
    parse_ready_control_frame,
)


def test_ready_control_frame_round_trips_and_redacts_bootstrap() -> None:
    frame = ReadyControlFrame("safe-bootstrap-token")

    parsed = parse_ready_control_frame(frame.to_bytes())

    assert parsed == frame
    assert "safe-bootstrap-token" not in repr(frame)
    assert json.loads(frame.to_bytes()) == {
        "protocol": CONTROL_PROTOCOL,
        "event": "ready",
        "origin": LOCAL_ORIGIN,
        "bootstrap": "safe-bootstrap-token",
    }


@pytest.mark.parametrize(
    "payload",
    [
        b"",
        b"[]",
        b"not-json",
        b'{"protocol":"diandian-desktop-v0","event":"ready","origin":"http://localhost:3000","bootstrap":"token"}',
        b'{"protocol":"diandian-desktop-v1","event":"ready","origin":"http://127.0.0.1:3000","bootstrap":"token"}',
        b'{"protocol":"diandian-desktop-v1","event":"ready","origin":"http://localhost:3000","bootstrap":""}',
        b'{"protocol":"diandian-desktop-v1","event":"ready","origin":"http://localhost:3000","bootstrap":"token","extra":true}',
    ],
)
def test_ready_control_frame_rejects_invalid_protocol_data(payload: bytes) -> None:
    with pytest.raises(ControlFrameError):
        parse_ready_control_frame(payload)


def test_ready_control_frame_rejects_oversized_or_unsafe_bootstrap() -> None:
    with pytest.raises(ControlFrameError):
        parse_ready_control_frame(ReadyControlFrame("x" * (MAX_BOOTSTRAP_BYTES + 1)).to_bytes())

    payload = json.dumps(
        {
            "protocol": CONTROL_PROTOCOL,
            "event": "ready",
            "origin": LOCAL_ORIGIN,
            "bootstrap": "unsafe token",
        }
    ).encode()
    with pytest.raises(ControlFrameError):
        parse_ready_control_frame(payload)


def test_frozen_sidecar_uses_only_its_bundled_browser_runtime(tmp_path, monkeypatch) -> None:
    browser_root = tmp_path / "playwright-browsers"
    executable = browser_root / "chromium-1" / "chrome-mac" / "Chromium"
    executable.parent.mkdir(parents=True)
    executable.write_text("browser", encoding="utf-8")
    (browser_root / "browser-manifest.json").write_text(
        json.dumps(
            {"browser": "chromium", "executable": str(executable.relative_to(browser_root))}
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(sidecar_module.sys, "frozen", True, raising=False)
    monkeypatch.setattr(sidecar_module.sys, "_MEIPASS", str(tmp_path), raising=False)

    sidecar_module._configure_bundled_browser_runtime()

    assert sidecar_module.os.environ["PLAYWRIGHT_BROWSERS_PATH"] == str(browser_root)


def test_frozen_sidecar_fails_closed_without_a_valid_browser_manifest(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr(sidecar_module.sys, "frozen", True, raising=False)
    monkeypatch.setattr(sidecar_module.sys, "_MEIPASS", str(tmp_path), raising=False)

    with pytest.raises(ValueError, match="Bundled browser manifest is unavailable"):
        sidecar_module._configure_bundled_browser_runtime()


def test_startup_failure_codes_are_safe_and_actionable() -> None:
    assert sidecar_module._safe_startup_error_code(
        ValueError("Bundled browser is unavailable")
    ) == ("SIDECAR_BROWSER_UNAVAILABLE")
    assert sidecar_module._safe_startup_error_code(
        ValueError("The required port is unavailable")
    ) == ("SIDECAR_PORT_UNAVAILABLE")
    assert sidecar_module._safe_startup_error_code(ValueError("/private/user-data")) == (
        "SIDECAR_START_FAILED"
    )


def test_emit_ready_control_frame_writes_only_one_newline_delimited_frame() -> None:
    stream = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")

    emit_ready_control_frame(ReadyControlFrame("safe-bootstrap-token"), stream)
    stream.seek(0)

    assert stream.read().splitlines() == [
        '{"protocol":"diandian-desktop-v1","event":"ready","origin":"http://localhost:3000","bootstrap":"safe-bootstrap-token"}'
    ]
