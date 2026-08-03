from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from diandianreading.application.ports.knowledge import (
    KnowledgeAnswer,
    KnowledgeReference,
)
from diandianreading.infrastructure.fakes import FakeKnowledgeAdapter
from tests.integration.test_local_api_app import (
    ApiHarness,
    complete_local_import,
    open_harness,
)

QUESTION = "What does the selection mean?"


def ensure_conversation(api: ApiHarness, book_id: str) -> str:
    response = api.client.put(
        f"/api/books/{book_id}/conversation",
        json={"title": "Scoped", "default_query_scope": {"type": "book"}},
        headers=api.write_headers(),
    )
    assert response.status_code in {200, 201}, response.text
    return str(response.json()["data"]["conversation"]["id"])


def locate_setup(api: ApiHarness) -> tuple[str, str, str, str, int, int]:
    _, book_id = complete_local_import(api)
    conversation_id = ensure_conversation(api, book_id)
    detail = api.client.get(f"/api/books/{book_id}", headers=api.read_headers()).json()["data"]
    part_id = detail["parts"][0]["id"]
    content = api.client.get(f"/api/books/{book_id}/content", headers=api.read_headers())
    text = content.text
    sha256 = content.headers["etag"].strip('"')
    selection = "Grounded local reading."
    start = text.index(selection)
    return book_id, conversation_id, part_id, sha256, start, start + len(selection)


def submit_scope(
    api: ApiHarness,
    conversation_id: str,
    scope: dict[str, object],
    *,
    message_id: str,
) -> tuple[int, dict[str, object]]:
    response = api.client.post(
        f"/api/conversations/{conversation_id}/messages",
        json={
            "client_message_id": message_id,
            "question": QUESTION,
            "query_scope": scope,
        },
        headers={**api.write_headers(), "Idempotency-Key": message_id},
    )
    body = response.json() if response.content else {}
    return response.status_code, body


def run_to_completion(api: ApiHarness, run_id: str) -> dict[str, object]:
    assert asyncio.run(api.runtime.worker.run_once()) is True
    result = api.client.get(f"/api/chat-runs/{run_id}", headers=api.read_headers())
    assert result.status_code == 200, result.text
    payload = result.json()["data"]
    assert isinstance(payload, dict)
    return payload


def test_selection_scope_verified_roundtrip(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        book_id, conversation_id, part_id, sha256, start, end = locate_setup(api)
        del book_id
        status, body = submit_scope(
            api,
            conversation_id,
            {
                "type": "selection",
                "document_part_id": part_id,
                "locator": {
                    "type": "markdown_offset",
                    "value": f"{sha256}:{start}:{end}",
                },
                "selected_text": "Grounded local reading.",
            },
            message_id="sel-1",
        )
        assert status == 202, body
        run_id = body["data"]["chat_run"]["id"]
        payload = run_to_completion(api, str(run_id))
        run = payload["chat_run"]
        assert isinstance(run, dict)
        assert run["status"] == "completed"
        scope = run["effective_scope"]
        assert isinstance(scope, dict)
        assert scope["type"] == "selection"
        assert scope["supplemental"] == ["selection"]
        assert scope["document_part_ids"] == [part_id]


def test_selection_scope_unverified_when_text_is_foreign(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        _, conversation_id, part_id, sha256, start, end = locate_setup(api)
        status, body = submit_scope(
            api,
            conversation_id,
            {
                "type": "selection",
                "document_part_id": part_id,
                "locator": {
                    "type": "markdown_offset",
                    "value": f"{sha256}:{start}:{end}",
                },
                "selected_text": "This sentence never appears in the imported book.",
            },
            message_id="sel-2",
        )
        assert status == 202, body
        payload = run_to_completion(api, str(body["data"]["chat_run"]["id"]))
        run = payload["chat_run"]
        assert isinstance(run, dict) and run["status"] == "completed"
        scope = run["effective_scope"]
        assert isinstance(scope, dict)
        assert scope["supplemental"] == ["selection_unverified"]


def test_notes_scope_roundtrip_and_ownership(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        book_id, conversation_id, _, _, _, _ = locate_setup(api)
        note = api.client.post(
            f"/api/books/{book_id}/annotations",
            json={"kind": "note", "body": "my grounded thought"},
            headers=api.write_headers(),
        )
        assert note.status_code == 201
        note_id = str(note.json()["data"]["annotation"]["id"])

        status, body = submit_scope(
            api,
            conversation_id,
            {"type": "notes", "note_ids": [note_id]},
            message_id="notes-1",
        )
        assert status == 202, body
        payload = run_to_completion(api, str(body["data"]["chat_run"]["id"]))
        run = payload["chat_run"]
        assert isinstance(run, dict) and run["status"] == "completed"
        scope = run["effective_scope"]
        assert isinstance(scope, dict)
        assert scope["type"] == "notes"
        assert scope["note_ids"] == [note_id]
        assert scope["supplemental"] == ["notes"]

        status, body = submit_scope(
            api,
            conversation_id,
            {"type": "notes", "note_ids": ["unknown-note"]},
            message_id="notes-2",
        )
        assert status == 202
        payload = run_to_completion(api, str(body["data"]["chat_run"]["id"]))
        failed_run = payload["chat_run"]
        assert isinstance(failed_run, dict)
        assert failed_run["status"] == "failed"
        error = failed_run["error"]
        assert isinstance(error, dict) and error["code"] == "NOT_FOUND"


def test_scope_contract_violations(tmp_path: Path) -> None:
    with open_harness(tmp_path) as api:
        book_id, conversation_id, part_id, _, _, _ = locate_setup(api)

        for scope in (
            {"type": "selection", "document_part_id": part_id},
            {"type": "notes", "note_ids": []},
            {"type": "chapters", "chapter_ids": ["markdown-heading-0001"]},
            {"type": "unknown"},
        ):
            status, _ = submit_scope(api, conversation_id, scope, message_id=f"bad-{scope['type']}")
            assert status == 422, scope

        response = api.client.put(
            f"/api/books/{book_id}/conversation",
            json={
                "title": "Scoped",
                "default_query_scope": {
                    "type": "selection",
                    "document_part_id": part_id,
                    "locator": {"type": "markdown_offset", "value": "x:0:1"},
                    "selected_text": "Grounded local reading.",
                },
            },
            headers=api.write_headers(),
        )
        assert response.status_code == 422


def test_book_scope_citations_gain_local_locations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with open_harness(tmp_path) as api:
        book_id, conversation_id, _, sha256, _, _ = locate_setup(api)
        content = api.client.get(f"/api/books/{book_id}/content", headers=api.read_headers())
        text = content.text
        excerpt = "Grounded local reading."
        start = text.index(excerpt)
        end = start + len(excerpt)

        original_ask = FakeKnowledgeAdapter.ask

        async def excerpt_ask(
            self: FakeKnowledgeAdapter,
            workspace: object,
            question: str,
            external_source_ids: object,
            provider_conversation_id: object,
        ) -> KnowledgeAnswer:
            answer = await original_ask(
                self, workspace, question, external_source_ids, provider_conversation_id
            )
            return KnowledgeAnswer(
                answer=answer.answer,
                conversation_id=answer.conversation_id,
                references=tuple(
                    KnowledgeReference(
                        external_source_id=reference.external_source_id,
                        document_part_id=reference.document_part_id,
                        excerpt=excerpt,
                    )
                    for reference in answer.references
                ),
            )

        monkeypatch.setattr(FakeKnowledgeAdapter, "ask", excerpt_ask)

        status, body = submit_scope(api, conversation_id, {"type": "book"}, message_id="cite-1")
        assert status == 202
        payload = run_to_completion(api, str(body["data"]["chat_run"]["id"]))
        references = payload["references"]
        assert isinstance(references, list) and references
        location = references[0]["location"]
        assert location == {
            "type": "markdown_offset",
            "value": f"{sha256}:{start}:{end}",
        }
