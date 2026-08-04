"""Offline C1 E2E: saving an AI answer as a knowledge note.

Import a book, ask a whole-book question, save the answer as a knowledge note,
repeat the save, and prove the second call resolves to the same note without
claiming a creation. The repeat is the point: ai-chat.md promises idempotency on
the message identifier, and ADR-0008 delegates that promise to a database unique
index rather than to an application-level lookup.
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


def run_c1_demo(home: Path, workspace: Path) -> dict[str, object]:
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
            raise FileExistsError("C1 demo requires fresh, non-existing home and workspace paths")
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
        client=("127.0.0.1", 50_007),
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
                "X-Diandian-Filename": "c1-notes.md",
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
                "client_message_id": "c1-question",
                "question": "What does visibility do for the reader?",
                "query_scope": {"type": "book"},
            },
            headers={**write_headers, "Idempotency-Key": "c1-question"},
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
        message_id = str(assistant[-1]["id"])

        first = client.post(
            f"/api/messages/{message_id}/save-as-note",
            json={},
            headers=write_headers,
        )
        assert first.status_code == 201, first.text
        first_body = first.json()["data"]
        assert first_body["created"] is True
        note_id = str(first_body["knowledge_note"]["id"])
        assert first_body["knowledge_note"]["source_kind"] == "chat_message"
        assert first_body["knowledge_note"]["source_id"] == message_id

        repeated = client.post(
            f"/api/messages/{message_id}/save-as-note",
            json={},
            headers=write_headers,
        )
        assert repeated.status_code == 200, repeated.text
        repeated_body = repeated.json()["data"]
        assert repeated_body["created"] is False
        assert repeated_body["knowledge_note"]["id"] == note_id

        listing = client.get(f"/api/books/{book_id}/knowledge-notes", headers=read_headers)
        listing.raise_for_status()
        notes = listing.json()["data"]["knowledge_notes"]
        assert [item["id"] for item in notes] == [note_id]

        # An anchored annotation note is a different entity and must not appear
        # in the knowledge-note listing.
        annotation = client.post(
            f"/api/books/{book_id}/annotations",
            json={"kind": "note", "body": "An anchored thought about the passage."},
            headers=write_headers,
        )
        annotation.raise_for_status()
        after = client.get(f"/api/books/{book_id}/knowledge-notes", headers=read_headers)
        assert [item["id"] for item in after.json()["data"]["knowledge_notes"]] == [note_id]

        missing = client.post(
            "/api/messages/missing-message/save-as-note",
            json={},
            headers=write_headers,
        )
        assert missing.status_code == 404

    return {
        "status": "ok",
        "schema_version": database.schema_version(),
        "knowledge_note_count": len(notes),
        "repeat_returned_same_note": True,
        "annotation_notes_excluded": True,
        "unknown_message_rejected": True,
    }
