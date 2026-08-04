from __future__ import annotations

import json
import subprocess
import sys

import pytest


@pytest.mark.e2e
def test_phase0_cli_runs_fake_import_reopens_sqlite_and_refuses_overwrite(tmp_path) -> None:
    database = tmp_path / "state" / "app.sqlite3"
    workspace = tmp_path / "state" / "workspace"
    command = [
        sys.executable,
        "-m",
        "diandianreading",
        "phase0-e2e",
        "--database",
        str(database),
        "--workspace",
        str(workspace),
    ]
    completed = subprocess.run(
        command,
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )

    payload = json.loads(completed.stdout)
    assert payload["status"] == "ok"
    assert payload["schema_version"] == 9
    assert payload["part_count"] == 2
    assert payload["source_count"] == 2
    assert payload["preparation_manifest_key"].startswith("manifests/")
    assert payload["preparation_manifest_key"].endswith(".json")
    assert payload["remote_operation_count"] == 3
    assert payload["job_event_count"] == 21
    assert database.is_file()

    sentinel = workspace / "phase0-sample.md"
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
    assert error["error"]["code"] == "VALIDATION"
    assert "Traceback" not in repeated.stderr
    assert sentinel.read_text(encoding="utf-8") == original
