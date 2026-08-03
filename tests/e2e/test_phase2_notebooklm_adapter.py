from __future__ import annotations

import json
import subprocess
import sys

import pytest


@pytest.mark.e2e
def test_phase2_cli_runs_full_adapter_flow_reopens_state_and_refuses_overwrite(tmp_path) -> None:
    database = tmp_path / "state" / "app.sqlite3"
    object_root = tmp_path / "objects"
    credentials_root = tmp_path / "credentials"
    workspace = tmp_path / "workspace"
    command = [
        sys.executable,
        "-m",
        "diandianreading",
        "phase2-e2e",
        "--database",
        str(database),
        "--object-root",
        str(object_root),
        "--credentials-root",
        str(credentials_root),
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
    assert payload["schema_version"] == 5
    assert payload["book_count"] == 1
    assert payload["part_count"] >= 1
    assert payload["source_count"] == payload["part_count"]
    assert payload["citation_count"] == payload["source_count"]
    assert payload["generated_content_count"] == 1
    assert payload["downloaded_asset_count"] == 1
    assert payload["remote_operation_count"] == payload["source_count"] + 3
    assert payload["provider_write_intent_count"] == payload["remote_operation_count"]
    assert payload["client_open_count"] == 2
    assert payload["client_close_count"] == 2
    assert payload["progress_event_count"] > 0
    assert str(credentials_root) not in completed.stdout

    sentinel = workspace / "phase2-source.md"
    original = sentinel.read_text(encoding="utf-8")
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
    assert str(credentials_root) not in repeated.stderr
    assert "Traceback" not in repeated.stderr
    assert sentinel.read_text(encoding="utf-8") == original
