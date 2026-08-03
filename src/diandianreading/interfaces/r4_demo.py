"""Offline R4 E2E: selection and notes chat scopes over the secured local API.

Import a book, ask with a verified selection scope, ask with a notes scope
backed by a real annotation, and prove the effective scope projections and
scope validation behave per the AI chat design (ai-chat.md §4).
"""

from __future__ import annotations

import asyncio
import os
import warnings
from pathlib import Path

from diandianreading.interfaces.phase5_demo import create_phase5_demo_runtime
from diandianreading.interfaces.web import LocalHttpConfig, create_web_app

_SOURCE = (
    b"# Scoped Reading\n"
    b"\n"
    b"The scoped sentence grounds a verified selection question.\n"
    b"\n"
    b"# Closing\n"
    b"\n"
    b"The closing chapter ends the fixture.\n"
)
_SELECTION = "The scoped sentence grounds a verified selection question."


def run_r4_demo(home: Path, workspace: Path) -> dict[str, object]:
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
            raise FileExistsError("R4 demo requires fresh, non-existing home and workspace paths")
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
        client=("127.0.0.1", 50_005),
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
                "X-Diandian-Filename": "r4-scopes.md",
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
            json={"title": "Scoped chat", "default_query_scope": {"type": "book"}},
            headers=write_headers,
        )
        conversation.raise_for_status()
        conversation_id = conversation.json()["data"]["conversation"]["id"]

        detail = client.get(f"/api/books/{book_id}", headers=read_headers).json()["data"]
        part_id = detail["parts"][0]["id"]
        content_response = client.get(f"/api/books/{book_id}/content", headers=read_headers)
        text = content_response.text
        sha256 = content_response.headers["etag"].strip('"')
        start = text.index(_SELECTION)
        end = start + len(_SELECTION)

        selection_submit = client.post(
            f"/api/conversations/{conversation_id}/messages",
            json={
                "client_message_id": "r4-selection",
                "question": "Explain this selection.",
                "query_scope": {
                    "type": "selection",
                    "document_part_id": part_id,
                    "locator": {
                        "type": "markdown_offset",
                        "value": f"{sha256}:{start}:{end}",
                    },
                    "selected_text": _SELECTION,
                },
            },
            headers={**write_headers, "Idempotency-Key": "r4-selection"},
        )
        selection_submit.raise_for_status()
        selection_run = selection_submit.json()["data"]["chat_run"]["id"]
        assert asyncio.run(runtime.worker.run_once()) is True
        selection_result = client.get(
            f"/api/chat-runs/{selection_run}", headers=read_headers
        ).json()["data"]
        selection_scope = selection_result["chat_run"]["effective_scope"]
        assert selection_result["chat_run"]["status"] == "completed"
        assert selection_scope["type"] == "selection"
        assert selection_scope["supplemental"] == ["selection"]

        note = client.post(
            f"/api/books/{book_id}/annotations",
            json={"kind": "note", "body": "The demo note grounds a notes question."},
            headers=write_headers,
        )
        note.raise_for_status()
        note_id = note.json()["data"]["annotation"]["id"]

        notes_submit = client.post(
            f"/api/conversations/{conversation_id}/messages",
            json={
                "client_message_id": "r4-notes",
                "question": "Relate my notes to the book.",
                "query_scope": {"type": "notes", "note_ids": [note_id]},
            },
            headers={**write_headers, "Idempotency-Key": "r4-notes"},
        )
        notes_submit.raise_for_status()
        notes_run = notes_submit.json()["data"]["chat_run"]["id"]
        assert asyncio.run(runtime.worker.run_once()) is True
        notes_result = client.get(f"/api/chat-runs/{notes_run}", headers=read_headers).json()[
            "data"
        ]
        notes_scope = notes_result["chat_run"]["effective_scope"]
        assert notes_result["chat_run"]["status"] == "completed"
        assert notes_scope["type"] == "notes"
        assert notes_scope["note_ids"] == [note_id]
        assert notes_scope["supplemental"] == ["notes"]
        assert notes_result["references"]

        invalid = client.post(
            f"/api/conversations/{conversation_id}/messages",
            json={
                "client_message_id": "r4-invalid",
                "question": "Bad scope.",
                "query_scope": {"type": "notes", "note_ids": []},
            },
            headers={**write_headers, "Idempotency-Key": "r4-invalid"},
        )
        assert invalid.status_code == 422

    return {
        "status": "ok",
        "schema_version": database.schema_version(),
        "selection_verified": True,
        "notes_scope_note_count": 1,
        "invalid_scope_rejected": True,
        "citation_count": len(notes_result["references"]),
    }
