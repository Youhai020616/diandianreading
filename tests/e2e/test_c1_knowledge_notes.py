from __future__ import annotations

import json
import subprocess
import sys

import pytest


@pytest.mark.e2e
def test_c1_installed_entrypoint_saves_answers_as_notes_offline(tmp_path) -> None:
    app_home = tmp_path / "app-home"
    workspace = tmp_path / "workspace"
    command = [
        sys.executable,
        "-m",
        "diandianreading",
        "c1-e2e",
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
        "knowledge_note_count": 1,
        "repeat_returned_same_note": True,
        "annotation_notes_excluded": True,
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
