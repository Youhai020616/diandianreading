from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from tests.integration.test_local_api_app import (
    ORIGIN,
    ApiHarness,
    complete_local_import,
    open_harness,
)


def test_reading_endpoints_require_authentication(tmp_path: Path) -> None:
    with (
        open_harness(tmp_path) as api,
        TestClient(
            api.app,
            base_url=ORIGIN,
            client=("127.0.0.1", 50_003),
            follow_redirects=False,
            raise_server_exceptions=False,
        ) as anonymous,
    ):
        for path in ("/api/books/x", "/api/books/x/content"):
            response = anonymous.get(path, headers={"Origin": ORIGIN})
            assert response.status_code == 401, path


def test_unknown_book_detail_is_not_found(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        response = api.client.get("/api/books/missing", headers=api.read_headers())
        assert response.status_code == 404


def read_detail(api: ApiHarness, book_id: str) -> dict[str, object]:
    response = api.client.get(f"/api/books/{book_id}", headers=api.read_headers())
    assert response.status_code == 200, response.text
    detail = response.json()["data"]
    assert isinstance(detail, dict)
    return detail


def test_reading_flow_detail_content_and_progress(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        _, book_id = complete_local_import(api)

        detail = read_detail(api, book_id)
        document = detail["document"]
        assert isinstance(document, dict)
        assert document["mime_type"] == "text/markdown"
        sha256 = str(document["anchor_sha256"])
        chapters = detail["chapters"]
        assert isinstance(chapters, list) and chapters
        assert detail["progress"] is None

        content = api.client.get(f"/api/books/{book_id}/content", headers=api.read_headers())
        assert content.status_code == 200
        assert content.headers["etag"] == f'"{sha256}"'
        assert content.headers["content-type"].startswith("text/markdown")
        assert content.headers["cache-control"] == "no-store"

        cached = api.client.get(
            f"/api/books/{book_id}/content",
            headers={**api.read_headers(), "If-None-Match": f'"{sha256}"'},
        )
        assert cached.status_code == 304
        assert cached.headers["etag"] == f'"{sha256}"'

        first = api.client.put(
            f"/api/books/{book_id}/progress",
            json={
                "anchor": {
                    "type": "markdown_offset",
                    "anchor_sha256": sha256,
                    "start": 0,
                    "end": 0,
                },
                "percent": 0.1,
            },
            headers=api.write_headers(),
        )
        assert first.status_code == 200, first.text
        assert first.json()["data"]["progress"]["version"] == 0

        second = api.client.put(
            f"/api/books/{book_id}/progress",
            json={
                "anchor": {
                    "type": "markdown_offset",
                    "anchor_sha256": sha256,
                    "start": 4,
                    "end": 4,
                },
                "percent": 0.75,
            },
            headers=api.write_headers(),
        )
        assert second.status_code == 200
        assert second.json()["data"]["progress"]["version"] == 1

        final = read_detail(api, book_id)
        progress = final["progress"]
        assert isinstance(progress, dict)
        assert progress["percent"] == 0.75
        anchor = progress["anchor"]
        assert isinstance(anchor, dict) and anchor["start"] == 4


def test_progress_rejects_contract_violations(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        _, book_id = complete_local_import(api)
        detail = read_detail(api, book_id)
        document = detail["document"]
        assert isinstance(document, dict)
        sha256 = str(document["anchor_sha256"])
        url = f"/api/books/{book_id}/progress"

        def put(payload: dict[str, object]) -> int:
            response = api.client.put(url, json=payload, headers=api.write_headers())
            return response.status_code

        valid_anchor: dict[str, object] = {
            "type": "markdown_offset",
            "anchor_sha256": sha256,
            "start": 0,
            "end": 0,
        }
        assert put({"anchor": valid_anchor, "percent": "not-a-number"}) == 422
        assert put({"anchor": valid_anchor, "percent": 1.5}) == 422
        assert put({"anchor": {**valid_anchor, "extra": 1}, "percent": 0.5}) == 422
        assert (
            put(
                {
                    "anchor": {
                        "type": "epub_cfi",
                        "anchor_sha256": sha256,
                    },
                    "percent": 0.5,
                }
            )
            == 422
        )
        assert (
            put(
                {
                    "anchor": {**valid_anchor, "anchor_sha256": "0" * 64},
                    "percent": 0.5,
                }
            )
            == 409
        )
        missing = api.client.put(
            "/api/books/missing/progress",
            json={"anchor": valid_anchor, "percent": 0.5},
            headers=api.write_headers(),
        )
        assert missing.status_code == 404
