from __future__ import annotations

import json
import subprocess
import sys

import pytest


@pytest.mark.e2e
def test_phase3_cli_recovers_every_crash_boundary_and_refuses_overwrite(tmp_path) -> None:
    database = tmp_path / "state" / "app.sqlite3"
    workspace = tmp_path / "workspace"
    command = [
        sys.executable,
        "-m",
        "diandianreading",
        "phase3-e2e",
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
        timeout=60,
    )

    assert completed.stderr == ""
    payload = json.loads(completed.stdout)
    assert payload["status"] == "ok"
    assert payload["schema_version"] == 4
    assert payload["crash_boundary_count"] == 11
    assert payload["completed_job_count"] == 13
    assert payload["cancelled_job_count"] == 1
    assert payload["auth_resume_count"] == 1
    assert payload["manual_ambiguity_resolution_count"] == 1
    assert payload["lease_generation_two_or_more_count"] == 13
    assert payload["book_count"] == 14
    assert payload["source_count"] == 35
    assert payload["remote_operation_count"] == 49
    assert payload["unresolved_operation_count"] == 0
    assert payload["reconciled_operation_count"] >= 3
    assert payload["provider_workspace_write_count"] == 13
    assert payload["provider_source_write_count"] == 35
    assert payload["job_event_count"] > payload["job_step_count"] > 0

    sentinel = workspace / "sentinel.txt"
    sentinel.write_text("preserve me", encoding="utf-8")
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
    assert "Traceback" not in repeated.stderr
    assert sentinel.read_text(encoding="utf-8") == "preserve me"
