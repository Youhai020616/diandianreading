from __future__ import annotations

import json
import subprocess
import sys

import pytest


@pytest.mark.e2e
def test_r4_installed_entrypoint_runs_scoped_chat_offline(tmp_path) -> None:
    app_home = tmp_path / "app-home"
    workspace = tmp_path / "workspace"
    command = [
        sys.executable,
        "-m",
        "diandianreading",
        "r4-e2e",
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
        "status": "ok",
        "schema_version": 8,
        "selection_verified": True,
        "notes_scope_note_count": 1,
        "invalid_scope_rejected": True,
        "citation_count": 1,
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
