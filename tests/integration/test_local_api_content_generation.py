"""HTTP surface for content generation, revisions, and cancellation (C1b)."""

from __future__ import annotations

import asyncio
from pathlib import Path

from tests.integration.test_local_api_app import (
    ApiHarness,
    complete_local_import,
    open_harness,
)

QUESTION = "What is this book about?"


def answered_message(api: ApiHarness) -> tuple[str, str]:
    _, book_id = complete_local_import(api)
    conversation = api.client.put(
        f"/api/books/{book_id}/conversation",
        json={"title": "Workbench", "default_query_scope": {"type": "book"}},
        headers=api.write_headers(),
    )
    conversation_id = str(conversation.json()["data"]["conversation"]["id"])
    api.client.post(
        f"/api/conversations/{conversation_id}/messages",
        json={
            "client_message_id": "m-1",
            "question": QUESTION,
            "query_scope": {"type": "book"},
        },
        headers={**api.write_headers(), "Idempotency-Key": "m-1"},
    )
    assert asyncio.run(api.runtime.worker.run_once()) is True
    messages = api.client.get(
        f"/api/conversations/{conversation_id}/messages", headers=api.read_headers()
    )
    assistant = [
        item for item in messages.json()["data"]["messages"] if item["role"] == "assistant"
    ]
    return book_id, str(assistant[-1]["id"])


def submit_generation(api: ApiHarness, message_id: str, **overrides) -> tuple[int, dict]:
    payload = {"content_type": "reading_report", **overrides}
    response = api.client.post(
        f"/api/messages/{message_id}/generate-content",
        json=payload,
        headers=api.write_headers(),
    )
    return response.status_code, (response.json() if response.content else {})


def test_generation_produces_an_ai_draft(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        book_id, message_id = answered_message(api)
        status, body = submit_generation(api, message_id)
        assert status == 202, body
        content_id = body["data"]["job_id"]
        assert body["data"]["status_url"] == f"/api/contents/{content_id}"
        assert body["data"]["content"]["status"] == "queued"
        assert body["data"]["content"]["book_id"] == book_id

        assert asyncio.run(api.runtime.worker.run_once()) is True

        detail = api.client.get(f"/api/contents/{content_id}", headers=api.read_headers())
        assert detail.status_code == 200, detail.text
        data = detail.json()["data"]
        assert data["content"]["status"] == "draft"
        assert data["content"]["latest_revision_number"] == 1
        assert [item["author_kind"] for item in data["revisions"]] == ["ai"]


def test_editing_appends_a_human_revision_and_keeps_the_original(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        _, message_id = answered_message(api)
        _, body = submit_generation(api, message_id)
        content_id = body["data"]["job_id"]
        assert asyncio.run(api.runtime.worker.run_once()) is True

        original = api.client.get(f"/api/contents/{content_id}", headers=api.read_headers()).json()[
            "data"
        ]["revisions"][0]

        edited = api.client.post(
            f"/api/contents/{content_id}/revisions",
            json={"title": "我改过的标题", "body": "我改过的正文。"},
            headers=api.write_headers(),
        )
        assert edited.status_code == 201, edited.text
        assert edited.json()["data"]["content"]["status"] == "editing"

        after = api.client.get(f"/api/contents/{content_id}", headers=api.read_headers()).json()[
            "data"
        ]
        assert [item["author_kind"] for item in after["revisions"]] == ["ai", "human"]
        assert after["revisions"][0]["body"] == original["body"]


def test_cancelling_before_dispatch_stops_the_attempt(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        _, message_id = answered_message(api)
        _, body = submit_generation(api, message_id)
        content_id = body["data"]["job_id"]

        cancelled = api.client.post(
            f"/api/contents/{content_id}/cancel", json={}, headers=api.write_headers()
        )
        assert cancelled.status_code == 202, cancelled.text
        assert cancelled.json()["data"]["cancel_requested"] is True

        asyncio.run(api.runtime.worker.run_once())
        detail = api.client.get(f"/api/contents/{content_id}", headers=api.read_headers()).json()[
            "data"
        ]
        assert detail["content"]["latest_revision_number"] == 0
        assert detail["revisions"] == []


def test_rejects_an_unknown_content_type_and_unknown_fields(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        _, message_id = answered_message(api)
        status, _ = submit_generation(api, message_id, content_type="not_a_type")
        assert status == 422
        unknown = api.client.post(
            f"/api/messages/{message_id}/generate-content",
            json={"content_type": "reading_report", "unexpected": 1},
            headers=api.write_headers(),
        )
        assert unknown.status_code == 422


def test_rejects_generation_for_an_unknown_message(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        _ = complete_local_import(api)
        response = api.client.post(
            "/api/messages/missing/generate-content",
            json={"content_type": "reading_report"},
            headers=api.write_headers(),
        )
        assert response.status_code == 404


def test_accepts_explicit_generation_parameters(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        _, message_id = answered_message(api)
        status, body = submit_generation(
            api,
            message_id,
            content_type="short_post",
            language="en-US",
            tone="concise",
            length="short",
            target_platform="x",
            require_citations=False,
            first_person=True,
        )
        assert status == 202, body
        content = body["data"]["content"]
        assert content["content_type"] == "short_post"
        assert content["tone"] == "concise"
        assert content["target_platform"] == "x"
        assert content["require_citations"] is False
        assert content["first_person"] is True


def test_unknown_content_and_editing_before_a_draft_are_refused(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        _, message_id = answered_message(api)
        missing = api.client.get("/api/contents/missing", headers=api.read_headers())
        assert missing.status_code == 404
        cancel_missing = api.client.post(
            "/api/contents/missing/cancel", json={}, headers=api.write_headers()
        )
        assert cancel_missing.status_code == 404

        _, body = submit_generation(api, message_id)
        content_id = body["data"]["job_id"]
        early_edit = api.client.post(
            f"/api/contents/{content_id}/revisions",
            json={"title": "太早了", "body": "还没有草稿。"},
            headers=api.write_headers(),
        )
        assert early_edit.status_code == 422, early_edit.text


def test_workbench_generates_from_a_book_without_a_message(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        _, book_id = complete_local_import(api)
        response = api.client.post(
            f"/api/books/{book_id}/generate-content",
            json={"content_type": "reading_card", "tone": "personal"},
            headers=api.write_headers(),
        )
        assert response.status_code == 202, response.text
        content_id = response.json()["data"]["job_id"]

        assert asyncio.run(api.runtime.worker.run_once()) is True

        listing = api.client.get(f"/api/books/{book_id}/contents", headers=api.read_headers())
        assert listing.status_code == 200, listing.text
        contents = listing.json()["data"]["contents"]
        assert [item["id"] for item in contents] == [content_id]
        assert contents[0]["status"] == "draft"
        assert contents[0]["content_type"] == "reading_card"


def test_workbench_generation_refuses_an_unknown_book(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        _ = complete_local_import(api)
        response = api.client.post(
            "/api/books/missing/generate-content",
            json={"content_type": "reading_report"},
            headers=api.write_headers(),
        )
        assert response.status_code == 404


def test_workbench_generation_validates_the_payload(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        _, book_id = complete_local_import(api)
        bad_type = api.client.post(
            f"/api/books/{book_id}/generate-content",
            json={"content_type": "nope"},
            headers=api.write_headers(),
        )
        assert bad_type.status_code == 422
        bad_sources = api.client.post(
            f"/api/books/{book_id}/generate-content",
            json={"content_type": "reading_report", "sources": "not-a-list"},
            headers=api.write_headers(),
        )
        assert bad_sources.status_code == 422
