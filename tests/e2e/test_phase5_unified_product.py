from __future__ import annotations

import json
import subprocess
import sys

import pytest


@pytest.mark.e2e
def test_phase5_installed_entrypoint_runs_secured_api_worker_and_chat_offline(tmp_path) -> None:
    app_home = tmp_path / "app-home"
    workspace = tmp_path / "workspace"
    command = [
        sys.executable,
        "-m",
        "diandianreading",
        "phase5-e2e",
        "--app-home",
        str(app_home),
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
    assert json.loads(completed.stdout) == {
        "book_count": 1,
        "chat_sse_verified": True,
        "chat_status": "completed",
        "citation_count": 1,
        "cross_origin_rejected": True,
        "job_sse_verified": True,
        "job_status": "completed",
        "provider_status_verified": True,
        "schema_version": 10,
        "session_bootstrap_verified": True,
        "status": "ok",
    }
    assert str(app_home) not in completed.stdout

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
