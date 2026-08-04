"""Offline C2 E2E: exporting a book to an Obsidian vault.

Export twice, rename a file the way a user would, edit another by hand, and
export again. The run proves the two rules that make repeated export safe: a
renamed file is still recognised by its identity rather than its name, and a file
the user has edited is never overwritten.
"""

from __future__ import annotations

import asyncio
import os
import warnings
from pathlib import Path

from diandianreading.interfaces.phase5_demo import create_phase5_demo_runtime
from diandianreading.interfaces.web import LocalHttpConfig, create_web_app

_SOURCE = (
    b"# Knowledge Capture\n"
    b"\n"
    b"Visibility lets a reader build a correct mental model.\n"
    b"\n"
    b"# Closing\n"
    b"\n"
    b"The closing chapter ends the fixture.\n"
)


def run_c2_demo(home: Path, workspace: Path) -> dict[str, object]:
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message="Using `httpx` with `starlette.testclient` is deprecated.*",
        )
        from fastapi.testclient import TestClient

    home_path = Path(os.path.abspath(home.expanduser()))
    workspace_path = Path(os.path.abspath(workspace.expanduser()))
    for path in (home_path, workspace_path):
        if path.exists():
            raise FileExistsError("C2 demo requires fresh, non-existing home and workspace paths")
    workspace_path.mkdir(parents=True, mode=0o700)
    if os.name != "nt":
        workspace_path.chmod(0o700)

    runtime, database = create_phase5_demo_runtime(home_path)
    app = create_web_app(
        runtime,
        config=LocalHttpConfig(),
        start_worker=False,
        close_runtime=False,
    )
    bootstrap = runtime.security.issue_bootstrap()
    origin = "http://localhost:3000"
    read_headers = {"Origin": origin}

    with TestClient(
        app,
        base_url=origin,
        client=("127.0.0.1", 50_011),
        follow_redirects=False,
    ) as client:
        response = client.post(
            "/api/session/bootstrap",
            json={"nonce": bootstrap.nonce},
            headers=read_headers,
        )
        response.raise_for_status()
        csrf = client.cookies.get("diandian_csrf")
        assert csrf is not None
        write_headers = {"Origin": origin, "X-CSRF-Token": csrf}

        import_response = client.post(
            "/api/imports",
            content=_SOURCE,
            headers={
                **write_headers,
                "Content-Type": "application/octet-stream",
                "X-Diandian-Provider": "local",
                "X-Diandian-Filename": "c2-export.md",
                "X-Diandian-Rights-Basis": "owned_copy",
                "X-Diandian-Rights-Confirmed": "true",
                "X-Diandian-NotebookLM-Profile": "default",
            },
        )
        import_response.raise_for_status()
        job_id = import_response.json()["data"]["job"]["id"]
        assert asyncio.run(runtime.worker.run_once()) is True
        job = client.get(f"/api/jobs/{job_id}", headers=read_headers).json()["data"]["job"]
        assert job["status"] == "completed"
        book_id = str(job["book_id"])

        conversation = client.put(
            f"/api/books/{book_id}/conversation",
            json={"title": "Knowledge capture", "default_query_scope": {"type": "book"}},
            headers=write_headers,
        )
        conversation.raise_for_status()
        conversation_id = conversation.json()["data"]["conversation"]["id"]

        submitted = client.post(
            f"/api/conversations/{conversation_id}/messages",
            json={
                "client_message_id": "c2-question",
                "question": "What does visibility do for the reader?",
                "query_scope": {"type": "book"},
            },
            headers={**write_headers, "Idempotency-Key": "c2-question"},
        )
        submitted.raise_for_status()
        assert asyncio.run(runtime.worker.run_once()) is True

        messages = client.get(
            f"/api/conversations/{conversation_id}/messages", headers=read_headers
        )
        messages.raise_for_status()
        assistant = [
            item for item in messages.json()["data"]["messages"] if item["role"] == "assistant"
        ]
        assert assistant

        note = client.post(
            f"/api/books/{book_id}/annotations",
            json={"kind": "note", "body": "一条锚定笔记。"},
            headers=write_headers,
        )
        note.raise_for_status()

        vault_root = home_path.parent / "vault"
        vault_root.mkdir(parents=True, exist_ok=True)
        configured = client.put(
            "/api/obsidian/vault",
            json={"name": "DemoVault", "root_path": str(vault_root)},
            headers=write_headers,
        )
        configured.raise_for_status()

        first = client.post(f"/api/books/{book_id}/obsidian-export", json={}, headers=write_headers)
        first.raise_for_status()
        created = first.json()["data"]["exports"]
        assert sorted(item["target_kind"] for item in created) == [
            "book",
            "highlights",
            "notes",
            "summary",
        ]
        assert all(item["outcome"] == "created" for item in created)
        file_count_after_first = len(list(vault_root.rglob("*.md")))

        second = client.post(
            f"/api/books/{book_id}/obsidian-export", json={}, headers=write_headers
        )
        second.raise_for_status()
        assert all(item["outcome"] == "unchanged" for item in second.json()["data"]["exports"])
        assert len(list(vault_root.rglob("*.md"))) == file_count_after_first

        notes_relpath = next(
            item["relative_path"] for item in created if item["target_kind"] == "notes"
        )
        notes_file = vault_root / notes_relpath
        renamed = notes_file.with_name("我改名的笔记.md")
        notes_file.rename(renamed)

        client.post(
            f"/api/books/{book_id}/annotations",
            json={"kind": "note", "body": "第二条锚定笔记。"},
            headers=write_headers,
        ).raise_for_status()
        third = client.post(f"/api/books/{book_id}/obsidian-export", json={}, headers=write_headers)
        third.raise_for_status()
        renamed_result = next(
            item for item in third.json()["data"]["exports"] if item["target_kind"] == "notes"
        )
        assert renamed_result["outcome"] == "updated"
        assert renamed_result["relative_path"].endswith("我改名的笔记.md")
        assert len(list(vault_root.rglob("*.md"))) == file_count_after_first

        renamed.write_text(
            renamed.read_text(encoding="utf-8") + "\n我手写的一段。\n", encoding="utf-8"
        )
        client.post(
            f"/api/books/{book_id}/annotations",
            json={"kind": "note", "body": "第三条锚定笔记。"},
            headers=write_headers,
        ).raise_for_status()
        fourth = client.post(
            f"/api/books/{book_id}/obsidian-export", json={}, headers=write_headers
        )
        fourth.raise_for_status()
        conflicts = fourth.json()["data"]["conflicts"]
        assert [item["target_kind"] for item in conflicts] == ["notes"]
        assert "我手写的一段。" in renamed.read_text(encoding="utf-8")

    return {
        "status": "ok",
        "schema_version": database.schema_version(),
        "exported_files": file_count_after_first,
        "repeat_added_no_file": True,
        "rename_followed_by_identity": True,
        "manual_edit_preserved": True,
        "conflict_reported": True,
    }
