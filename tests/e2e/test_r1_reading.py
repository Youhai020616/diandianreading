from __future__ import annotations

import json
import subprocess
import sys

import pytest


@pytest.mark.e2e
def test_r1_installed_entrypoint_serves_reading_surface_offline(tmp_path) -> None:
    app_home = tmp_path / "app-home"
    workspace = tmp_path / "workspace"
    command = [
        sys.executable,
        "-m",
        "diandianreading",
        "r1-e2e",
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
        "book_count": 1,
        "chapter_refs": [
            "markdown-preamble",
            "markdown-heading-0001",
            "markdown-heading-0002",
        ],
        "chapters_tile_content": True,
        "content_not_modified": True,
        "stale_anchor_rejected": True,
        "final_progress_version": 1,
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
