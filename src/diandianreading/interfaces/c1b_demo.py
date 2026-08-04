"""Offline C1b E2E: generating a content asset from an AI answer.

Import a book, ask a question, request a reading report, let the worker claim and
run one generation attempt, then edit the draft. The point of the run is that the
model's first revision survives the edit: authorship is what lets a user answer
"did I write this" months later, which is the AI-content risk the PRD names.
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


def run_c1b_demo(home: Path, workspace: Path) -> dict[str, object]:
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
            raise FileExistsError("C1b demo requires fresh, non-existing home and workspace paths")
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
        client=("127.0.0.1", 50_009),
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
                "X-Diandian-Filename": "c1b-content.md",
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
                "client_message_id": "c1b-question",
                "question": "What does visibility do for the reader?",
                "query_scope": {"type": "book"},
            },
            headers={**write_headers, "Idempotency-Key": "c1b-question"},
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

        generate = client.post(
            f"/api/messages/{message_id}/generate-content",
            json={"content_type": "reading_report", "language": "zh-CN"},
            headers=write_headers,
        )
        assert generate.status_code == 202, generate.text
        submitted = generate.json()["data"]
        content_id = str(submitted["job_id"])
        assert submitted["content"]["status"] == "queued"
        assert submitted["status_url"] == f"/api/contents/{content_id}"

        assert asyncio.run(runtime.worker.run_once()) is True

        drafted = client.get(f"/api/contents/{content_id}", headers=read_headers)
        drafted.raise_for_status()
        draft = drafted.json()["data"]
        assert draft["content"]["status"] == "draft"
        assert [item["author_kind"] for item in draft["revisions"]] == ["ai"]
        original_body = draft["revisions"][0]["body"]

        edited = client.post(
            f"/api/contents/{content_id}/revisions",
            json={"title": "我改过的标题", "body": "我改过的正文。"},
            headers=write_headers,
        )
        assert edited.status_code == 201, edited.text
        assert edited.json()["data"]["content"]["status"] == "editing"

        after = client.get(f"/api/contents/{content_id}", headers=read_headers).json()["data"]
        authors = [item["author_kind"] for item in after["revisions"]]
        assert authors == ["ai", "human"]
        # The model's draft is still readable, byte for byte.
        assert after["revisions"][0]["body"] == original_body

        # A second worker turn must not start another generation for a settled asset.
        assert asyncio.run(runtime.worker.run_once()) is False
        settled = client.get(f"/api/contents/{content_id}", headers=read_headers).json()["data"]
        assert len(settled["revisions"]) == 2

        missing = client.post(
            "/api/messages/missing-message/generate-content",
            json={"content_type": "reading_report"},
            headers=write_headers,
        )
        assert missing.status_code == 404

    return {
        "status": "ok",
        "schema_version": database.schema_version(),
        "revision_authors": authors,
        "ai_draft_preserved": True,
        "settled_asset_not_reclaimed": True,
        "unknown_message_rejected": True,
    }
