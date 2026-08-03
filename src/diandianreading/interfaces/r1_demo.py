"""Offline R1 E2E: import, book detail, content, chapters, and progress.

Runs the real secured local API against the offline demo runtime (fake
knowledge adapter, real SQLite, real object storage) and proves the reader
data path end to end without any provider or browser dependency.
"""

from __future__ import annotations

import asyncio
import os
import warnings
from itertools import pairwise
from pathlib import Path

from diandianreading.interfaces.phase5_demo import create_phase5_demo_runtime
from diandianreading.interfaces.web import LocalHttpConfig, create_web_app

_SOURCE = (
    b"Preface before the first heading anchors the preamble span.\n"
    b"\n"
    b"# Chapter One\n"
    b"\n"
    b"Chapter one keeps enough grounded text to read.\n"
    b"\n"
    b"# Chapter Two\n"
    b"\n"
    b"Chapter two closes the offline reading fixture.\n"
)


def run_r1_demo(home: Path, workspace: Path) -> dict[str, object]:
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
            raise FileExistsError("R1 demo requires fresh, non-existing home and workspace paths")
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
        client=("127.0.0.1", 50_002),
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
                "X-Diandian-Filename": "r1-reading.md",
                "X-Diandian-Rights-Basis": "owned_copy",
                "X-Diandian-Rights-Confirmed": "true",
                "X-Diandian-NotebookLM-Profile": "default",
            },
        )
        import_response.raise_for_status()
        job_id = import_response.json()["data"]["job"]["id"]
        assert asyncio.run(runtime.worker.run_once()) is True
        job_response = client.get(f"/api/jobs/{job_id}", headers=read_headers)
        job_response.raise_for_status()
        job = job_response.json()["data"]["job"]
        assert job["status"] == "completed"
        book_id = str(job["book_id"])

        detail_response = client.get(f"/api/books/{book_id}", headers=read_headers)
        detail_response.raise_for_status()
        detail = detail_response.json()["data"]
        document = detail["document"]
        assert document["mime_type"] == "text/markdown"
        sha256 = str(document["anchor_sha256"])
        assert len(sha256) == 64
        chapters = detail["chapters"]
        chapter_refs = [chapter["reference"] for chapter in chapters]
        assert chapter_refs == [
            "markdown-preamble",
            "markdown-heading-0001",
            "markdown-heading-0002",
        ]
        assert [chapter["title"] for chapter in chapters] == [
            "",
            "Chapter One",
            "Chapter Two",
        ]
        assert detail["progress"] is None

        content_response = client.get(f"/api/books/{book_id}/content", headers=read_headers)
        content_response.raise_for_status()
        etag = content_response.headers["etag"]
        assert etag == f'"{sha256}"'
        text = content_response.text
        assert chapters[0]["start"] == 0
        assert chapters[-1]["end"] == len(text)
        for previous, following in pairwise(chapters):
            assert previous["end"] == following["start"]
        assert text[chapters[1]["start"] :].startswith("# Chapter One")

        cached_response = client.get(
            f"/api/books/{book_id}/content",
            headers={**read_headers, "If-None-Match": etag},
        )
        assert cached_response.status_code == 304

        caret = chapters[1]["start"]
        first_progress = client.put(
            f"/api/books/{book_id}/progress",
            json={
                "anchor": {
                    "type": "markdown_offset",
                    "anchor_sha256": sha256,
                    "start": caret,
                    "end": caret,
                    "chapter_ref": "markdown-heading-0001",
                },
                "percent": 0.42,
            },
            headers=write_headers,
        )
        first_progress.raise_for_status()
        assert first_progress.json()["data"]["progress"]["version"] == 0

        second_progress = client.put(
            f"/api/books/{book_id}/progress",
            json={
                "anchor": {
                    "type": "markdown_offset",
                    "anchor_sha256": sha256,
                    "start": chapters[2]["start"],
                    "end": chapters[2]["start"],
                    "chapter_ref": "markdown-heading-0002",
                },
                "percent": 0.8,
            },
            headers=write_headers,
        )
        second_progress.raise_for_status()
        progress = second_progress.json()["data"]["progress"]
        assert progress["version"] == 1

        stale_anchor = client.put(
            f"/api/books/{book_id}/progress",
            json={
                "anchor": {
                    "type": "markdown_offset",
                    "anchor_sha256": "0" * 64,
                    "start": 0,
                    "end": 0,
                },
                "percent": 0.1,
            },
            headers=write_headers,
        )
        assert stale_anchor.status_code == 409

        final_detail = client.get(f"/api/books/{book_id}", headers=read_headers)
        final_detail.raise_for_status()
        final_progress = final_detail.json()["data"]["progress"]
        assert final_progress is not None and final_progress["percent"] == 0.8

        books_response = client.get("/api/books?limit=100", headers=read_headers)
        books_response.raise_for_status()
        books = books_response.json()["data"]["books"]
        assert [book["id"] for book in books] == [book_id]

    return {
        "status": "ok",
        "schema_version": database.schema_version(),
        "book_count": 1,
        "chapter_refs": chapter_refs,
        "chapters_tile_content": True,
        "content_not_modified": True,
        "stale_anchor_rejected": True,
        "final_progress_version": 1,
    }
