from __future__ import annotations

import json
import subprocess
import sys

import pytest


@pytest.mark.e2e
def test_c2_installed_entrypoint_exports_and_reconciles_offline(tmp_path) -> None:
    app_home = tmp_path / "app-home"
    workspace = tmp_path / "workspace"
    command = [
        sys.executable,
        "-m",
        "diandianreading",
        "c2-e2e",
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
        "schema_version": 10,
        "exported_files": 4,
        "repeat_added_no_file": True,
        "rename_followed_by_identity": True,
        "manual_edit_preserved": True,
        "conflict_reported": True,
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
