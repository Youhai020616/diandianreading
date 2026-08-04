from __future__ import annotations

import json
import subprocess
import sys

import pytest


@pytest.mark.e2e
def test_c1b_installed_entrypoint_generates_and_edits_content_offline(tmp_path) -> None:
    app_home = tmp_path / "app-home"
    workspace = tmp_path / "workspace"
    command = [
        sys.executable,
        "-m",
        "diandianreading",
        "c1b-e2e",
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
        "revision_authors": ["ai", "human"],
        "ai_draft_preserved": True,
        "settled_asset_not_reclaimed": True,
        "unknown_message_rejected": True,
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
