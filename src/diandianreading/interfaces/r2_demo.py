"""Offline R2 E2E: highlight and note lifecycle over the secured local API.

Import a markdown book, create a verified highlight and a standalone note,
list, edit, soft-delete, and restore them, and prove that stale anchors and
invalid transitions are rejected — all without any provider dependency.
"""

from __future__ import annotations

import asyncio
import os
import warnings
from pathlib import Path

from diandianreading.interfaces.phase5_demo import create_phase5_demo_runtime
from diandianreading.interfaces.web import LocalHttpConfig, create_web_app

_SOURCE = (
    b"# Anchored Reading\n"
    b"\n"
    b"The annotated sentence proves the reader keeps user thoughts safe.\n"
    b"\n"
    b"# Closing\n"
    b"\n"
    b"The closing chapter ends the fixture.\n"
)
_SELECTION = "The annotated sentence proves the reader keeps user thoughts safe."


def run_r2_demo(home: Path, workspace: Path) -> dict[str, object]:
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
            raise FileExistsError("R2 demo requires fresh, non-existing home and workspace paths")
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
        client=("127.0.0.1", 50_004),
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
                "X-Diandian-Filename": "r2-annotations.md",
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

        content_response = client.get(f"/api/books/{book_id}/content", headers=read_headers)
        content_response.raise_for_status()
        text = content_response.text
        sha256 = content_response.headers["etag"].strip('"')
        start = text.index(_SELECTION)
        end = start + len(_SELECTION)

        highlight_response = client.post(
            f"/api/books/{book_id}/annotations",
            json={
                "kind": "highlight",
                "anchor": {
                    "type": "markdown_offset",
                    "anchor_sha256": sha256,
                    "start": start,
                    "end": end,
                    "chapter_ref": "markdown-heading-0001",
                    "quote": {
                        "exact": _SELECTION,
                        "prefix": text[max(0, start - 16) : start],
                        "suffix": text[end : end + 16],
                    },
                },
                "selected_text": _SELECTION,
                "color": "yellow",
                "body": "First thought about the sentence.",
            },
            headers=write_headers,
        )
        highlight_response.raise_for_status()
        highlight = highlight_response.json()["data"]["annotation"]
        assert highlight["kind"] == "highlight"

        note_response = client.post(
            f"/api/books/{book_id}/annotations",
            json={"kind": "note", "body": "A standalone reflection."},
            headers=write_headers,
        )
        note_response.raise_for_status()
        note = note_response.json()["data"]["annotation"]
        assert note["anchor"] is None

        stale = client.post(
            f"/api/books/{book_id}/annotations",
            json={
                "kind": "highlight",
                "anchor": {
                    "type": "markdown_offset",
                    "anchor_sha256": "0" * 64,
                    "start": start,
                    "end": end,
                    "quote": {"exact": _SELECTION},
                },
                "selected_text": _SELECTION,
                "color": "yellow",
            },
            headers=write_headers,
        )
        assert stale.status_code == 409

        listed = client.get(f"/api/books/{book_id}/annotations", headers=read_headers).json()[
            "data"
        ]
        assert len(listed["annotations"]) == 2

        edited = client.patch(
            f"/api/annotations/{highlight['id']}",
            json={"body": "Sharper thought.", "color": "green"},
            headers=write_headers,
        )
        edited.raise_for_status()
        edited_annotation = edited.json()["data"]["annotation"]
        assert edited_annotation["color"] == "green"

        deleted = client.delete(f"/api/annotations/{note['id']}", headers=write_headers)
        deleted.raise_for_status()
        assert deleted.json()["data"]["annotation"]["status"] == "deleted"

        default_list = client.get(f"/api/books/{book_id}/annotations", headers=read_headers).json()[
            "data"
        ]["annotations"]
        assert len(default_list) == 1

        restored = client.post(f"/api/annotations/{note['id']}/restore", headers=write_headers)
        restored.raise_for_status()
        assert restored.json()["data"]["annotation"]["status"] == "active"

        double_restore = client.post(
            f"/api/annotations/{note['id']}/restore", headers=write_headers
        )
        assert double_restore.status_code == 409

    return {
        "status": "ok",
        "schema_version": database.schema_version(),
        "annotation_count": 2,
        "highlight_verified_against_content": True,
        "stale_anchor_rejected": True,
        "edit_applied": True,
        "soft_delete_hides_by_default": True,
        "restore_applied": True,
        "invalid_transition_rejected": True,
    }
