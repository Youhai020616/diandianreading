"""HTTP surface for save-as-note and knowledge-note listing (C1).

The route is deliberately not named after ``annotation``: ai-chat.md's
``query_scope.note_ids`` means annotation identifiers, while these rows are
standalone knowledge items, so the payload key is ``knowledge_note``.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from tests.integration.test_local_api_app import (
    ApiHarness,
    complete_local_import,
    open_harness,
)

QUESTION = "What is this book about?"


def answered_message(api: ApiHarness, *, client_message_id: str = "m-1") -> tuple[str, str]:
    """Drive one whole-book question to completion and return (book_id, message_id)."""

    _, book_id = complete_local_import(api)
    conversation = api.client.put(
        f"/api/books/{book_id}/conversation",
        json={"title": "Notes", "default_query_scope": {"type": "book"}},
        headers=api.write_headers(),
    )
    assert conversation.status_code in {200, 201}, conversation.text
    conversation_id = str(conversation.json()["data"]["conversation"]["id"])

    submitted = api.client.post(
        f"/api/conversations/{conversation_id}/messages",
        json={
            "client_message_id": client_message_id,
            "question": QUESTION,
            "query_scope": {"type": "book"},
        },
        headers={**api.write_headers(), "Idempotency-Key": client_message_id},
    )
    assert submitted.status_code == 202, submitted.text
    assert asyncio.run(api.runtime.worker.run_once()) is True

    messages = api.client.get(
        f"/api/conversations/{conversation_id}/messages",
        headers=api.read_headers(),
    )
    assert messages.status_code == 200, messages.text
    assistant = [
        item for item in messages.json()["data"]["messages"] if item["role"] == "assistant"
    ]
    assert assistant, messages.text
    return book_id, str(assistant[-1]["id"])


def test_saves_an_answer_and_repeats_to_the_same_note(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        book_id, message_id = answered_message(api)

        first = api.client.post(
            f"/api/messages/{message_id}/save-as-note",
            json={},
            headers=api.write_headers(),
        )
        assert first.status_code == 201, first.text
        created = first.json()["data"]
        assert created["created"] is True
        note = created["knowledge_note"]
        assert note["book_id"] == book_id
        assert note["source_kind"] == "chat_message"
        assert note["source_id"] == message_id
        assert note["title"]

        # Repeating the request must resolve to the stored note, and must not
        # claim a creation it did not perform.
        second = api.client.post(
            f"/api/messages/{message_id}/save-as-note",
            json={},
            headers=api.write_headers(),
        )
        assert second.status_code == 200, second.text
        repeated = second.json()["data"]
        assert repeated["created"] is False
        assert repeated["knowledge_note"]["id"] == note["id"]

        listing = api.client.get(
            f"/api/books/{book_id}/knowledge-notes", headers=api.read_headers()
        )
        assert listing.status_code == 200, listing.text
        body = listing.json()["data"]
        assert [item["id"] for item in body["knowledge_notes"]] == [note["id"]]
        assert body["next_cursor"] is None


def test_accepts_an_explicit_title(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        _, message_id = answered_message(api)
        response = api.client.post(
            f"/api/messages/{message_id}/save-as-note",
            json={"title": "  我的标题  "},
            headers=api.write_headers(),
        )
        assert response.status_code == 201, response.text
        assert response.json()["data"]["knowledge_note"]["title"] == "我的标题"


def test_rejects_an_unknown_message(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        _ = complete_local_import(api)
        response = api.client.post(
            "/api/messages/missing-message/save-as-note",
            json={},
            headers=api.write_headers(),
        )
        assert response.status_code == 404, response.text
        assert response.json()["error"]["code"] == "NOT_FOUND"


def test_refuses_to_save_a_user_message(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        _, book_id = complete_local_import(api)
        conversation = api.client.put(
            f"/api/books/{book_id}/conversation",
            json={"title": "Notes", "default_query_scope": {"type": "book"}},
            headers=api.write_headers(),
        )
        conversation_id = str(conversation.json()["data"]["conversation"]["id"])
        api.client.post(
            f"/api/conversations/{conversation_id}/messages",
            json={
                "client_message_id": "m-user",
                "question": QUESTION,
                "query_scope": {"type": "book"},
            },
            headers={**api.write_headers(), "Idempotency-Key": "m-user"},
        )
        messages = api.client.get(
            f"/api/conversations/{conversation_id}/messages",
            headers=api.read_headers(),
        )
        user_message = next(
            item for item in messages.json()["data"]["messages"] if item["role"] == "user"
        )
        response = api.client.post(
            f"/api/messages/{user_message['id']}/save-as-note",
            json={},
            headers=api.write_headers(),
        )
        assert response.status_code == 422, response.text
        assert response.json()["error"]["code"] == "VALIDATION"


def test_rejects_unknown_fields_and_a_non_string_title(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        _, message_id = answered_message(api)
        unknown = api.client.post(
            f"/api/messages/{message_id}/save-as-note",
            json={"unexpected": 1},
            headers=api.write_headers(),
        )
        assert unknown.status_code == 422, unknown.text
        wrong_type = api.client.post(
            f"/api/messages/{message_id}/save-as-note",
            json={"title": 7},
            headers=api.write_headers(),
        )
        assert wrong_type.status_code == 422, wrong_type.text


def test_save_requires_the_browser_write_credentials(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        _, message_id = answered_message(api)
        response = api.client.post(
            f"/api/messages/{message_id}/save-as-note",
            json={},
            headers=api.read_headers(),
        )
        assert response.status_code in {401, 403}, response.text


def test_listing_is_empty_for_a_book_without_notes(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        _, book_id = complete_local_import(api)
        response = api.client.get(
            f"/api/books/{book_id}/knowledge-notes", headers=api.read_headers()
        )
        assert response.status_code == 200, response.text
        assert response.json()["data"]["knowledge_notes"] == []
