from __future__ import annotations

import json
import subprocess
import sys

import pytest


@pytest.mark.e2e
def test_phase4_cli_runs_governed_adapter_offline_and_refuses_overwrite(tmp_path) -> None:
    database = tmp_path / "state" / "app.sqlite3"
    object_root = tmp_path / "objects"
    credentials_root = tmp_path / "credentials"
    workspace = tmp_path / "workspace"
    command = [
        sys.executable,
        "-m",
        "diandianreading",
        "phase4-e2e",
        "--database",
        str(database),
        "--object-root",
        str(object_root),
        "--credentials-root",
        str(credentials_root),
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

    assert completed.stderr == ""
    payload = json.loads(completed.stdout)
    assert payload == {
        "status": "ok",
        "schema_version": 10,
        "default_disabled_gate_verified": True,
        "rights_record_count": 2,
        "rights_event_count": 4,
        "bound_content_hash_count": 2,
        "published_pdf_count": 1,
        "published_epub_count": 1,
        "expect_download_count": 2,
        "bounded_download_count": 2,
        "legacy_plaintext_config_detected": True,
        "legacy_config_read_count": 0,
        "provider_isolation_verified": True,
        "staging_entry_count": 0,
        "progress_event_count": 2,
    }
    assert "synthetic-cookie" not in completed.stdout
    assert "synthetic-secret" not in completed.stdout
    assert "zlibrary.invalid" not in completed.stdout
    assert str(credentials_root) not in completed.stdout

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
