from __future__ import annotations

import json
import subprocess
import sys

import pytest


@pytest.mark.e2e
def test_r2_installed_entrypoint_runs_annotation_lifecycle_offline(tmp_path) -> None:
    app_home = tmp_path / "app-home"
    workspace = tmp_path / "workspace"
    command = [
        sys.executable,
        "-m",
        "diandianreading",
        "r2-e2e",
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
        "schema_version": 7,
        "annotation_count": 2,
        "highlight_verified_against_content": True,
        "stale_anchor_rejected": True,
        "edit_applied": True,
        "soft_delete_hides_by_default": True,
        "restore_applied": True,
        "invalid_transition_rejected": True,
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
