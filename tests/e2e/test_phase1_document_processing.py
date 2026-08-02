from __future__ import annotations

import json
import subprocess
import sys

import pytest


@pytest.mark.e2e
def test_phase1_cli_prepares_three_formats_reopens_state_and_refuses_overwrite(tmp_path) -> None:
    database = tmp_path / "state" / "app.sqlite3"
    object_root = tmp_path / "objects"
    workspace = tmp_path / "workspace"
    command = [
        sys.executable,
        "-m",
        "diandianreading",
        "phase1-e2e",
        "--database",
        str(database),
        "--object-root",
        str(object_root),
        "--workspace",
        str(workspace),
    ]

    completed = subprocess.run(
        command,
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert completed.stderr == ""
    payload = json.loads(completed.stdout)
    assert payload["status"] == "ok"
    assert payload["schema_version"] == 2
    assert payload["format_count"] == 3
    assert payload["book_count"] == 3
    assert payload["manifest_count"] == 3
    assert payload["asset_count"] == payload["format_count"] + 1
    assert payload["part_count"] >= payload["format_count"]
    assert payload["source_count"] == payload["part_count"]
    assert payload["remote_operation_count"] == payload["source_count"] + payload["book_count"]
    assert payload["progress_event_count"] > 0
    assert database.is_file()

    sentinel = workspace / "phase1-markdown.md"
    original = sentinel.read_bytes()
    repeated = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert repeated.returncode == 2
    assert repeated.stdout == ""
    error = json.loads(repeated.stderr)
    assert error["status"] == "error"
    assert error["error"]["code"] == "VALIDATION"
    assert error["error"]["retryable"] is False
    assert "Traceback" not in repeated.stderr
    assert sentinel.read_bytes() == original
