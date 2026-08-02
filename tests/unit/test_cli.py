from __future__ import annotations

import json

import pytest

from diandianreading.infrastructure.persistence import SQLiteDatabase
from diandianreading.interfaces.cli import build_parser, main


def test_cli_requires_a_subcommand() -> None:
    with pytest.raises(SystemExit) as raised:
        build_parser().parse_args([])
    assert raised.value.code == 2


def test_cli_runs_phase0_demo_and_returns_structured_collision_error(tmp_path, capsys) -> None:
    database = tmp_path / "state" / "app.sqlite3"
    workspace = tmp_path / "state" / "workspace"
    argv = [
        "phase0-e2e",
        "--database",
        str(database),
        "--workspace",
        str(workspace),
    ]
    assert main(argv) == 0
    first_capture = capsys.readouterr()
    payload = json.loads(first_capture.out)
    assert payload["status"] == "ok"
    assert payload["progress_event_count"] > 0
    assert payload["preparation_manifest_key"].startswith("manifests/")
    assert payload["remote_operation_count"] == 3
    sentinel = workspace / "phase0-sample.md"
    original = sentinel.read_text(encoding="utf-8")

    assert main(argv) == 2
    second_capture = capsys.readouterr()
    error = json.loads(second_capture.err)
    assert error == {
        "error": {
            "code": "VALIDATION",
            "message": f"Refusing to overwrite existing workspace: {workspace}",
            "retryable": False,
        },
        "status": "error",
    }
    assert second_capture.out == ""
    assert sentinel.read_text(encoding="utf-8") == original


def test_cli_expands_tilde_before_existing_database_check(tmp_path, monkeypatch, capsys) -> None:
    home = tmp_path / "home"
    state = home / ".state"
    state.mkdir(parents=True, mode=0o700)
    state.chmod(0o700)
    database = SQLiteDatabase.create_new(state / "app.sqlite3")
    monkeypatch.setenv("HOME", str(home))

    exit_code = main(
        [
            "phase0-e2e",
            "--database",
            "~/.state/app.sqlite3",
            "--workspace",
            "~/.state/workspace",
        ]
    )

    assert exit_code == 2
    error = json.loads(capsys.readouterr().err)
    assert error["error"]["code"] == "VALIDATION"
    assert str(database.path) in error["error"]["message"]
