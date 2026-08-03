from __future__ import annotations

from pathlib import Path

from tests.integration.test_local_api_app import (
    ApiHarness,
    complete_local_import,
    open_harness,
)


def import_and_locate(api: ApiHarness) -> tuple[str, str, int, int, str]:
    _, book_id = complete_local_import(api)
    content = api.client.get(f"/api/books/{book_id}/content", headers=api.read_headers())
    assert content.status_code == 200
    text = content.text
    sha256 = content.headers["etag"].strip('"')
    selection = "Grounded local reading."
    start = text.index(selection)
    return book_id, sha256, start, start + len(selection), selection


def highlight_payload(sha256: str, start: int, end: int, selection: str) -> dict[str, object]:
    return {
        "kind": "highlight",
        "anchor": {
            "type": "markdown_offset",
            "anchor_sha256": sha256,
            "start": start,
            "end": end,
            "quote": {"exact": selection},
        },
        "selected_text": selection,
        "color": "yellow",
    }


def test_annotation_http_lifecycle(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        book_id, sha256, start, end, selection = import_and_locate(api)
        base = f"/api/books/{book_id}/annotations"

        created = api.client.post(
            base,
            json=highlight_payload(sha256, start, end, selection),
            headers=api.write_headers(),
        )
        assert created.status_code == 201, created.text
        annotation = created.json()["data"]["annotation"]
        assert annotation["anchor"]["quote"]["exact"] == selection

        note = api.client.post(
            base,
            json={"kind": "note", "body": "standalone"},
            headers=api.write_headers(),
        )
        assert note.status_code == 201
        note_id = note.json()["data"]["annotation"]["id"]

        listed = api.client.get(base, headers=api.read_headers())
        assert listed.status_code == 200
        assert len(listed.json()["data"]["annotations"]) == 2

        edited = api.client.patch(
            f"/api/annotations/{annotation['id']}",
            json={"color": "pink"},
            headers=api.write_headers(),
        )
        assert edited.status_code == 200
        assert edited.json()["data"]["annotation"]["color"] == "pink"

        deleted = api.client.delete(f"/api/annotations/{note_id}", headers=api.write_headers())
        assert deleted.status_code == 200
        remaining = api.client.get(base, headers=api.read_headers()).json()["data"]
        assert len(remaining["annotations"]) == 1

        deleted_only = api.client.get(f"{base}?status=deleted", headers=api.read_headers()).json()[
            "data"
        ]["annotations"]
        assert [item["id"] for item in deleted_only] == [note_id]

        restored = api.client.post(
            f"/api/annotations/{note_id}/restore", headers=api.write_headers()
        )
        assert restored.status_code == 200
        assert restored.json()["data"]["annotation"]["status"] == "active"


def test_annotation_http_contract_violations(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        book_id, sha256, start, end, selection = import_and_locate(api)
        base = f"/api/books/{book_id}/annotations"

        def post(payload: dict[str, object]) -> int:
            return api.client.post(base, json=payload, headers=api.write_headers()).status_code

        assert post({"kind": "unknown"}) == 422
        valid = highlight_payload(sha256, start, end, selection)
        assert post({**valid, "extra": 1}) == 422

        missing_quote = highlight_payload(sha256, start, end, selection)
        anchor = dict(missing_quote["anchor"])  # type: ignore[arg-type]
        del anchor["quote"]
        missing_quote["anchor"] = anchor
        assert post(missing_quote) == 422

        stale = highlight_payload("0" * 64, start, end, selection)
        assert post(stale) == 409

        drifted = highlight_payload(sha256, start, end + 1, selection)
        assert post(drifted) == 409

        assert post({"kind": "note", "body": ""}) == 422

        unauthorized = api.client.post(base, json=valid, headers=api.read_headers())
        assert unauthorized.status_code in {401, 403}

        missing_book = api.client.post(
            "/api/books/missing/annotations",
            json=valid,
            headers=api.write_headers(),
        )
        assert missing_book.status_code == 404

        assert api.client.get(f"{base}?status=bogus", headers=api.read_headers()).status_code == 422
        assert (
            api.client.get(
                f"{base}?before_created_at=2026-01-01T00:00:00",
                headers=api.read_headers(),
            ).status_code
            == 422
        )
        assert (
            api.client.patch(
                "/api/annotations/missing",
                json={"color": "pink"},
                headers=api.write_headers(),
            ).status_code
            == 404
        )
        assert (
            api.client.patch(
                f"/api/annotations/{import_and_locate.__name__}",
                json={},
                headers=api.write_headers(),
            ).status_code
            == 422
        )
