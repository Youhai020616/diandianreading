from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from diandianreading.application.use_cases.chat import ChatUseCaseError
from diandianreading.domain import DiandianError, ErrorCode
from diandianreading.domain.chat import ChatError, ChatErrorCode
from diandianreading.interfaces.phase5_demo import (
    Phase5DemoRuntime,
    create_phase5_demo_runtime,
)
from diandianreading.interfaces.web import LocalHttpConfig, create_web_app
from diandianreading.interfaces.web.app import _job_event_stream
from diandianreading.interfaces.web.http_security import SseConnectionLimiter

ORIGIN = "http://localhost:3000"


@dataclass(slots=True)
class ApiHarness:
    runtime: Phase5DemoRuntime
    app: FastAPI
    client: TestClient
    csrf: str

    def read_headers(self) -> dict[str, str]:
        return {"Origin": ORIGIN}

    def write_headers(self) -> dict[str, str]:
        return {"Origin": ORIGIN, "X-CSRF-Token": self.csrf}


class _ConnectedRequest:
    async def is_disconnected(self) -> bool:
        return False


@contextmanager
def open_harness(tmp_path: Path, *, zlibrary_enabled: bool = False) -> Iterator[ApiHarness]:
    runtime, _ = create_phase5_demo_runtime(tmp_path / "home")
    runtime.zlibrary_enabled = zlibrary_enabled
    app = create_web_app(runtime, start_worker=False, close_runtime=False)
    nonce = runtime.security.issue_bootstrap()
    with TestClient(
        app,
        base_url=ORIGIN,
        client=("127.0.0.1", 50_001),
        follow_redirects=False,
        raise_server_exceptions=False,
    ) as client:
        response = client.post(
            "/api/session/bootstrap",
            json={"nonce": nonce.nonce},
            headers={"Origin": ORIGIN},
        )
        assert response.status_code == 200, response.text
        csrf = client.cookies.get("diandian_csrf")
        assert csrf is not None
        yield ApiHarness(runtime, app, client, csrf)


@pytest.fixture
def api(tmp_path: Path) -> Iterator[ApiHarness]:
    with open_harness(tmp_path) as harness:
        yield harness


def submit_local_import(
    api: ApiHarness,
    *,
    content: bytes = b"# Local book\n\nGrounded local reading.\n",
    filename: str = "book.md",
) -> dict[str, object]:
    response = api.client.post(
        "/api/imports",
        content=content,
        headers={
            **api.write_headers(),
            "Content-Type": "application/octet-stream",
            "X-Diandian-Provider": "local",
            "X-Diandian-Filename": filename,
            "X-Diandian-Rights-Basis": "owned_copy",
            "X-Diandian-Rights-Confirmed": "true",
            "X-Diandian-NotebookLM-Profile": "default",
        },
    )
    assert response.status_code == 202, response.text
    return response.json()["data"]["job"]


def complete_local_import(api: ApiHarness) -> tuple[str, str]:
    submitted = submit_local_import(api)
    assert asyncio.run(api.runtime.worker.run_once()) is True
    response = api.client.get(f"/api/jobs/{submitted['id']}", headers=api.read_headers())
    assert response.status_code == 200
    job = response.json()["data"]["job"]
    assert job["status"] == "completed"
    assert isinstance(job["book_id"], str)
    return str(job["id"]), str(job["book_id"])


def test_static_liveness_and_network_boundary_fail_closed(api: ApiHarness) -> None:
    health = api.client.get("/healthz")
    assert health.json() == {"status": "ok"}
    assert health.headers["content-security-policy"].startswith("default-src 'none'")
    assert "img-src 'self' data:" not in health.headers["content-security-policy"]
    assert "access-control-allow-origin" not in health.headers

    index = api.client.get("/")
    assert index.status_code == 200
    assert "localStorage" not in index.text
    assert api.client.get("/").status_code == 200
    assert api.client.get("/openapi.json").status_code == 404

    with TestClient(
        api.app,
        base_url=ORIGIN,
        client=("127.0.0.1", 50_002),
        raise_server_exceptions=False,
    ) as anonymous:
        unauthenticated = anonymous.get("/api/jobs", headers={"Origin": ORIGIN})
        assert unauthenticated.status_code == 401
        assert unauthenticated.json()["error"]["code"] == "AUTH_REQUIRED"

        bearer = api.runtime.install_tokens.read_for_cli()
        authorized = anonymous.get(
            "/api/jobs",
            headers={"Authorization": f"Bearer {bearer.token}"},
        )
        assert authorized.status_code == 200
        assert bearer.token not in authorized.text

    assert (
        api.client.get(
            "/api/jobs",
            headers={**api.read_headers(), "Host": "attacker.invalid"},
        ).status_code
        == 403
    )
    assert (
        api.client.get(
            "/api/jobs",
            headers={**api.read_headers(), "Forwarded": "for=127.0.0.1"},
        ).status_code
        == 403
    )
    assert (
        api.client.get(
            "/api/jobs",
            headers={"Origin": "https://attacker.invalid"},
        ).status_code
        == 403
    )
    assert (
        api.client.options(
            "/api/jobs",
            headers={
                "Origin": "https://attacker.invalid",
                "Access-Control-Request-Method": "GET",
            },
        ).status_code
        == 403
    )

    same_origin_fetch = api.client.get(
        "/api/jobs",
        headers={"Sec-Fetch-Site": "same-origin"},
    )
    assert same_origin_fetch.status_code == 200
    missing_origin_evidence = api.client.get("/api/jobs")
    assert missing_origin_evidence.status_code == 403


def test_network_boundary_rejects_non_loopback_and_duplicate_security_headers(
    api: ApiHarness,
) -> None:
    with TestClient(
        api.app,
        base_url=ORIGIN,
        client=("192.0.2.10", 50_003),
        raise_server_exceptions=False,
    ) as remote_peer:
        rejected_peer = remote_peer.get("/healthz")
    assert rejected_peer.status_code == 403
    assert rejected_peer.json()["error"]["code"] == "VALIDATION"

    duplicate_host = api.client.get(
        "/healthz",
        headers=[("Host", "localhost:3000"), ("Host", "localhost:3000")],
    )
    duplicate_cookie = api.client.get(
        "/api/jobs",
        headers=[
            ("Origin", ORIGIN),
            ("Cookie", "diandian_session=first"),
            ("Cookie", "diandian_session=second"),
        ],
    )
    duplicate_authorization = api.client.get(
        "/api/jobs",
        headers=[
            ("Authorization", "Bearer first"),
            ("Authorization", "Bearer second"),
        ],
    )
    duplicate_origin = api.client.post(
        "/api/session/bootstrap",
        json={"nonce": "not-consumed"},
        headers=[("Origin", ORIGIN), ("Origin", ORIGIN)],
    )

    for response, expected_status in (
        (duplicate_host, 403),
        (duplicate_cookie, 400),
        (duplicate_authorization, 400),
        (duplicate_origin, 400),
    ):
        assert response.status_code == expected_status, response.text
        assert response.json()["error"]["code"] == "VALIDATION"


def test_network_boundary_enforces_header_and_request_target_limits(api: ApiHarness) -> None:
    config = LocalHttpConfig()
    too_many_headers = api.client.get(
        "/healthz",
        headers=[(f"X-Test-{index}", "x") for index in range(config.max_headers)],
    )
    assert too_many_headers.status_code == 431
    assert too_many_headers.json()["error"]["code"] == "VALIDATION"

    oversized_headers = api.client.get(
        "/healthz",
        headers={"X-Oversized": "x" * config.max_header_bytes},
    )
    assert oversized_headers.status_code == 431
    assert oversized_headers.json()["error"]["code"] == "VALIDATION"

    query_budget = config.max_request_target_bytes - len("/healthz") - 1
    at_limit_query = "q=" + "x" * (query_budget - len("q="))
    at_limit = api.client.get(f"/healthz?{at_limit_query}")
    assert at_limit.status_code == 200

    over_limit = api.client.get(f"/healthz?{at_limit_query}x")
    assert over_limit.status_code == 414
    assert over_limit.json()["error"]["code"] == "VALIDATION"


def test_json_endpoints_reject_invalid_content_type_and_oversized_body(
    api: ApiHarness,
) -> None:
    wrong_content_type = api.client.post(
        "/api/session/bootstrap",
        content=b'{"nonce":"unused"}',
        headers={"Origin": ORIGIN, "Content-Type": "text/plain"},
    )
    assert wrong_content_type.status_code == 415
    assert wrong_content_type.json()["error"]["code"] == "VALIDATION"

    oversized_body = b'{"nonce":"' + b"x" * LocalHttpConfig().max_json_bytes + b'"}'
    too_large = api.client.post(
        "/api/session/bootstrap",
        content=oversized_body,
        headers={"Origin": ORIGIN, "Content-Type": "application/json"},
    )
    assert too_large.status_code == 413
    assert too_large.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"


def test_bearer_and_browser_cookie_credentials_cannot_be_mixed(api: ApiHarness) -> None:
    bearer = api.runtime.install_tokens.read_for_cli()
    response = api.client.get(
        "/api/jobs",
        headers={
            **api.read_headers(),
            "Authorization": f"Bearer {bearer.token}",
        },
    )
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "AUTH_REQUIRED"
    assert bearer.token not in response.text


def test_install_token_can_issue_one_safe_reopen_nonce(api: ApiHarness) -> None:
    token = api.runtime.install_tokens.read_for_cli().token
    with TestClient(
        api.app,
        base_url=ORIGIN,
        client=("127.0.0.1", 50_003),
        follow_redirects=False,
        raise_server_exceptions=False,
    ) as client:
        unauthorized = client.post(
            "/api/session/bootstrap-nonces",
            headers={"Authorization": "Bearer wrong-token"},
        )
        assert unauthorized.status_code == 401

        issued = client.post(
            "/api/session/bootstrap-nonces",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert issued.status_code == 200
        assert issued.headers["cache-control"] == "no-store"
        nonce = issued.json()["data"]["nonce"]
        assert isinstance(nonce, str)
        assert nonce
        assert token not in issued.text

        consumed = client.post(
            "/api/session/bootstrap",
            json={"nonce": nonce},
            headers={"Origin": ORIGIN},
        )
        assert consumed.status_code == 200
        replay = client.post(
            "/api/session/bootstrap",
            json={"nonce": nonce},
            headers={"Origin": ORIGIN},
        )
        assert replay.status_code == 401

    browser_attempt = api.client.post(
        "/api/session/bootstrap-nonces",
        headers=api.write_headers(),
    )
    assert browser_attempt.status_code == 403
    assert browser_attempt.json()["error"]["code"] == "VALIDATION"


def test_bootstrap_csrf_rotation_logout_and_rate_limits(api: ApiHarness) -> None:
    missing_csrf = api.client.post("/api/jobs/missing/retry", headers={"Origin": ORIGIN})
    assert missing_csrf.status_code == 401
    wrong_csrf = api.client.post(
        "/api/jobs/missing/retry",
        headers={"Origin": ORIGIN, "X-CSRF-Token": "wrong"},
    )
    assert wrong_csrf.status_code == 401

    one_time = api.runtime.security.issue_bootstrap()
    exchanged = api.client.post(
        "/api/session/bootstrap",
        json={"nonce": one_time.nonce},
        headers={"Origin": ORIGIN},
    )
    assert exchanged.status_code == 200
    api.csrf = api.client.cookies.get("diandian_csrf") or ""
    replay = api.client.post(
        "/api/session/bootstrap",
        json={"nonce": one_time.nonce},
        headers={"Origin": ORIGIN},
    )
    assert replay.status_code == 401
    assert one_time.nonce not in replay.text

    for _ in range(5):
        rejected = api.client.post(
            "/api/session/bootstrap",
            json={"nonce": "invalid"},
            headers={"Origin": ORIGIN},
        )
        assert rejected.status_code == 401
    limited = api.client.post(
        "/api/session/bootstrap",
        json={"nonce": "invalid"},
        headers={"Origin": ORIGIN},
    )
    assert limited.status_code == 429

    current = api.client.get("/api/session", headers=api.read_headers())
    assert current.status_code == 200
    _ = api.runtime.security.rotate_install_token()
    rotated = api.client.get("/api/session", headers=api.read_headers())
    assert rotated.status_code == 401

    replacement = api.runtime.security.issue_bootstrap()
    response = api.client.post(
        "/api/session/bootstrap",
        json={"nonce": replacement.nonce},
        headers={"Origin": ORIGIN},
    )
    assert response.status_code == 429


def test_logout_revokes_browser_session(api: ApiHarness) -> None:
    response = api.client.post("/api/session/logout", headers=api.write_headers())
    assert response.status_code == 204
    assert api.client.get("/api/session", headers=api.read_headers()).status_code == 401


def test_provider_status_manager_exception_is_sanitized(
    api: ApiHarness,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fail_status(_: object) -> object:
        raise RuntimeError("provider cookie=secret-provider-value")

    monkeypatch.setattr(api.runtime.notebooklm_session, "status", fail_status)
    response = api.client.get("/api/auth/status", headers=api.read_headers())

    assert response.status_code == 200
    providers = response.json()["data"]["providers"]
    assert providers["notebooklm"] == {
        "provider": "notebooklm",
        "profile": "default",
        "state": "error",
        "enabled": True,
    }
    assert providers["zlibrary"]["state"] == "disabled"
    assert "secret-provider-value" not in response.text


@pytest.mark.parametrize(
    ("error_code", "expected_status", "expected_public_code"),
    [
        (ErrorCode.AUTH_REQUIRED, 401, "AUTH_REQUIRED"),
        (ErrorCode.SOURCE_LIMIT_EXCEEDED, 413, "PAYLOAD_TOO_LARGE"),
        (ErrorCode.VALIDATION, 422, "VALIDATION"),
        (ErrorCode.FORMAT_UNSUPPORTED, 422, "FORMAT_UNSUPPORTED"),
        (ErrorCode.REPOSITORY_CONFLICT, 409, "REPOSITORY_CONFLICT"),
        (ErrorCode.REMOTE_RATE_LIMITED, 429, "REMOTE_RATE_LIMITED"),
        (ErrorCode.SOURCE_UNAVAILABLE, 503, "SOURCE_UNAVAILABLE"),
        (ErrorCode.DOWNLOAD_TIMEOUT, 503, "DOWNLOAD_TIMEOUT"),
        (ErrorCode.REMOTE_UNAVAILABLE, 503, "REMOTE_UNAVAILABLE"),
        (ErrorCode.UNEXPECTED, 500, "UNEXPECTED"),
    ],
)
def test_domain_exception_status_mapping(
    api: ApiHarness,
    monkeypatch: pytest.MonkeyPatch,
    error_code: ErrorCode,
    expected_status: int,
    expected_public_code: str,
) -> None:
    def fail_list(_: object) -> object:
        raise DiandianError(error_code, "Safe domain failure")

    monkeypatch.setattr(api.runtime.jobs, "list", fail_list)
    response = api.client.get("/api/jobs", headers=api.read_headers())

    assert response.status_code == expected_status
    assert response.json()["error"]["code"] == expected_public_code
    assert response.json()["error"]["message"] == "Safe domain failure"


@pytest.mark.parametrize(
    ("error_code", "expected_status"),
    [
        (ChatErrorCode.NOT_FOUND, 404),
        (ChatErrorCode.CONVERSATION_BUSY, 409),
        (ChatErrorCode.IDEMPOTENCY_CONFLICT, 409),
        (ChatErrorCode.PAYLOAD_TOO_LARGE, 413),
        (ChatErrorCode.AUTH_REQUIRED, 401),
        (ChatErrorCode.REMOTE_RATE_LIMITED, 429),
        (ChatErrorCode.REMOTE_UNAVAILABLE, 503),
        (ChatErrorCode.SOURCE_NOT_READY, 503),
        (ChatErrorCode.VALIDATION, 422),
        (ChatErrorCode.UNEXPECTED, 500),
    ],
)
def test_chat_exception_status_mapping(
    api: ApiHarness,
    monkeypatch: pytest.MonkeyPatch,
    error_code: ChatErrorCode,
    expected_status: int,
) -> None:
    def fail_get_conversation(_: str) -> object:
        raise ChatUseCaseError(
            ChatError.safe(
                error_code,
                "Safe chat failure",
                request_id="chat-status-mapping",
            )
        )

    monkeypatch.setattr(api.runtime.chat, "get_conversation", fail_get_conversation)
    response = api.client.get(
        "/api/conversations/conversation-status-mapping/messages",
        headers=api.read_headers(),
    )

    assert response.status_code == expected_status
    assert response.json()["error"]["code"] == error_code.value
    assert response.json()["error"]["message"] == "Safe chat failure"


def test_local_import_is_bounded_path_free_and_runs_to_completion(api: ApiHarness) -> None:
    submitted = submit_local_import(api)
    assert submitted["status"] == "queued"
    assert submitted["job_type"] == "import_book"
    assert submitted["book_id"] is None

    with api.runtime.database.connect() as connection:
        payload = connection.execute(
            "SELECT payload_json FROM job_payloads WHERE job_id = ?",
            (submitted["id"],),
        ).fetchone()
    assert payload is not None
    payload_json = str(payload[0])
    assert str(api.runtime.paths.home) not in payload_json
    assert "upload-" not in payload_json
    assert tuple(api.runtime.paths.upload_root.iterdir()) == ()

    assert asyncio.run(api.runtime.worker.run_once()) is True
    detail = api.client.get(f"/api/jobs/{submitted['id']}", headers=api.read_headers())
    job = detail.json()["data"]["job"]
    assert job["status"] == "completed"
    assert job["book_title"] == "book"
    assert job["book_id"]

    jobs = api.client.get("/api/jobs?limit=1", headers=api.read_headers())
    assert jobs.status_code == 200
    assert jobs.json()["data"]["jobs"][0]["id"] == submitted["id"]
    books = api.client.get("/api/books?limit=100", headers=api.read_headers())
    assert books.status_code == 200
    assert books.json()["data"]["books"][0]["status"] == "ready"
    events = api.client.get(
        f"/api/jobs/{submitted['id']}/events",
        headers=api.read_headers(),
    )
    assert events.status_code == 200
    assert "event: job.completed" in events.text


def test_import_rejects_bad_lengths_names_rights_and_disabled_provider(
    api: ApiHarness,
) -> None:
    common = {
        **api.write_headers(),
        "Content-Type": "application/octet-stream",
        "X-Diandian-Provider": "local",
        "X-Diandian-Filename": "book.md",
        "X-Diandian-Rights-Basis": "owned_copy",
        "X-Diandian-Rights-Confirmed": "true",
        "X-Diandian-NotebookLM-Profile": "default",
    }
    too_large = api.client.post(
        "/api/imports",
        content=b"x",
        headers={
            **common,
            "Content-Length": str(api.runtime.target_capabilities.max_source_bytes + 1),
        },
    )
    assert too_large.status_code == 413

    traversal = api.client.post(
        "/api/imports",
        content=b"text",
        headers={**common, "X-Diandian-Filename": "../book.md"},
    )
    assert traversal.status_code == 422
    unsupported = api.client.post(
        "/api/imports",
        content=b"text",
        headers={**common, "X-Diandian-Filename": "book.exe"},
    )
    assert unsupported.status_code == 422
    evidence_required = api.client.post(
        "/api/imports",
        content=b"text",
        headers={**common, "X-Diandian-Rights-Basis": "licensed"},
    )
    assert evidence_required.status_code == 422

    zlibrary = api.client.post(
        "/api/imports",
        json={"provider": "zlibrary"},
        headers=api.write_headers(),
    )
    assert zlibrary.status_code == 409


def test_zlibrary_submission_is_attested_and_does_not_acquire_during_post(
    tmp_path: Path,
) -> None:
    with open_harness(tmp_path, zlibrary_enabled=True) as api:
        response = api.client.post(
            "/api/imports",
            json={
                "provider": "zlibrary",
                "location": "https://z-library.sk/book/example?tracking=ignored",
                "zlibrary_profile": "default",
                "notebooklm_profile": "default",
                "rights_basis": "owned_copy",
                "license_identifier": None,
                "rights_confirmed": True,
                "attestation_version": "zlibrary-rights-v1",
                "title": "Example Book",
                "author": "Example Author",
            },
            headers=api.write_headers(),
        )
        assert response.status_code == 202, response.text
        job = response.json()["data"]["job"]
        assert job["status"] == "queued"
        with api.runtime.database.connect() as connection:
            payload = connection.execute(
                "SELECT payload_json FROM job_payloads WHERE job_id = ?",
                (job["id"],),
            ).fetchone()
        assert payload is not None
        persisted = json.loads(str(payload[0]))
        assert persisted["source_url"] == "https://z-library.sk/book/offline-fixture"
        assert "tracking" not in str(payload[0])


def test_whole_book_chat_idempotency_busy_cancel_completion_and_sse(
    api: ApiHarness,
) -> None:
    _, book_id = complete_local_import(api)
    missing = api.client.get(
        f"/api/books/{book_id}/conversation",
        headers=api.read_headers(),
    )
    assert missing.status_code == 404

    conversation = api.client.put(
        f"/api/books/{book_id}/conversation",
        json={
            "title": "Discuss Local Book",
            "default_query_scope": {"type": "book"},
        },
        headers=api.write_headers(),
    )
    assert conversation.status_code == 201, conversation.text
    conversation_id = conversation.json()["data"]["conversation"]["id"]
    replayed_conversation = api.client.put(
        f"/api/books/{book_id}/conversation",
        json={
            "title": "A different ignored title",
            "default_query_scope": {"type": "book"},
        },
        headers=api.write_headers(),
    )
    assert replayed_conversation.status_code == 200
    assert replayed_conversation.json()["data"]["conversation"]["id"] == conversation_id

    unsupported_scope = api.client.post(
        f"/api/conversations/{conversation_id}/messages",
        json={
            "client_message_id": "msg-unsupported",
            "question": "Explain chapter one",
            "query_scope": {"type": "chapters"},
        },
        headers={**api.write_headers(), "Idempotency-Key": "msg-unsupported"},
    )
    assert unsupported_scope.status_code == 422

    command = {
        "client_message_id": "msg-first",
        "question": "What is this book about?",
        "query_scope": {"type": "book"},
    }
    first = api.client.post(
        f"/api/conversations/{conversation_id}/messages",
        json=command,
        headers={**api.write_headers(), "Idempotency-Key": "msg-first"},
    )
    assert first.status_code == 202, first.text
    first_run = first.json()["data"]["chat_run"]["id"]
    replay = api.client.post(
        f"/api/conversations/{conversation_id}/messages",
        json=command,
        headers={**api.write_headers(), "Idempotency-Key": "msg-first"},
    )
    assert replay.status_code == 200
    assert replay.json()["data"]["chat_run"]["id"] == first_run

    busy = api.client.post(
        f"/api/conversations/{conversation_id}/messages",
        json={
            "client_message_id": "msg-busy",
            "question": "A second question",
            "query_scope": {"type": "book"},
        },
        headers={**api.write_headers(), "Idempotency-Key": "msg-busy"},
    )
    assert busy.status_code == 409
    assert busy.json()["error"]["details"]["active_run_url"].endswith(first_run)

    active_messages = api.client.get(
        f"/api/conversations/{conversation_id}/messages?limit=50",
        headers=api.read_headers(),
    )
    assert active_messages.json()["data"]["active_chat_run"]["id"] == first_run

    cancelled = api.client.post(
        f"/api/chat-runs/{first_run}/cancel",
        headers=api.write_headers(),
    )
    assert cancelled.status_code == 200
    assert cancelled.json()["data"]["chat_run"]["status"] == "cancelled"

    mismatched_retry = api.client.post(
        f"/api/chat-runs/{first_run}/retry",
        json={"client_retry_id": "retry-cancelled"},
        headers={**api.write_headers(), "Idempotency-Key": "different-retry-key"},
    )
    assert mismatched_retry.status_code == 409
    assert mismatched_retry.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"

    second_id = "msg-complete"
    second = api.client.post(
        f"/api/conversations/{conversation_id}/messages",
        json={
            "client_message_id": second_id,
            "question": "What does the fixture prove?",
            "query_scope": {"type": "book"},
        },
        headers={**api.write_headers(), "Idempotency-Key": second_id},
    )
    assert second.status_code == 202
    second_run = second.json()["data"]["chat_run"]["id"]
    assert asyncio.run(api.runtime.worker.run_once()) is True

    result = api.client.get(f"/api/chat-runs/{second_run}", headers=api.read_headers())
    assert result.status_code == 200
    data = result.json()["data"]
    assert data["chat_run"]["status"] == "completed"
    assert data["chat_run"]["effective_scope"]["type"] == "book"
    assert data["assistant_message"]["content"].startswith("Fake grounded answer")
    assert len(data["references"]) == 1
    assert "external_source_id" not in result.text
    assert "provider_conversation" not in result.text

    history = api.client.get(
        f"/api/conversations/{conversation_id}/messages?limit=50",
        headers=api.read_headers(),
    )
    messages = history.json()["data"]["messages"]
    assert len(messages) == 4
    assert any(message["references"] for message in messages if message["role"] == "assistant")
    assert history.json()["data"]["active_chat_run"] is None

    newest_page = api.client.get(
        f"/api/conversations/{conversation_id}/messages?limit=2",
        headers=api.read_headers(),
    )
    assert newest_page.status_code == 200
    newest_data = newest_page.json()["data"]
    assert len(newest_data["messages"]) == 2
    cursor = newest_data["next_cursor"]
    assert cursor is not None

    older_page = api.client.get(
        f"/api/conversations/{conversation_id}/messages",
        params={
            "limit": "2",
            "before_created_at": cursor["created_at"],
            "before_message_id": cursor["message_id"],
        },
        headers=api.read_headers(),
    )
    assert older_page.status_code == 200
    older_data = older_page.json()["data"]
    assert len(older_data["messages"]) == 2
    assert older_data["next_cursor"] is None
    paged_ids = {message["id"] for message in newest_data["messages"] + older_data["messages"]}
    assert paged_ids == {message["id"] for message in messages}

    invalid_message_cursors = (
        {"before_created_at": cursor["created_at"]},
        {"before_message_id": cursor["message_id"]},
        {
            "before_created_at": "2026-08-03T12:00:00",
            "before_message_id": cursor["message_id"],
        },
        [
            ("before_created_at", cursor["created_at"]),
            ("before_created_at", cursor["created_at"]),
            ("before_message_id", cursor["message_id"]),
        ],
    )
    for params in invalid_message_cursors:
        invalid_cursor = api.client.get(
            f"/api/conversations/{conversation_id}/messages",
            params=params,
            headers=api.read_headers(),
        )
        assert invalid_cursor.status_code == 422
        assert invalid_cursor.json()["error"]["code"] == "VALIDATION"

    events = api.client.get(
        f"/api/chat-runs/{second_run}/events",
        headers=api.read_headers(),
    )
    assert events.status_code == 200
    assert "event: chat_run.completed" in events.text


def test_sse_rechecks_revocation_and_releases_the_connection_slot(api: ApiHarness) -> None:
    session_token = api.client.cookies.get("diandian_session")
    assert session_token is not None
    session = api.runtime.security.authenticate_session(session_token)
    limiter = SseConnectionLimiter(per_session_limit=1)
    assert api.runtime.security.revoke_session(session)

    rejected_reconnect = api.client.get(
        "/api/jobs/not-read-after-revocation/events",
        headers=api.read_headers(),
    )
    assert rejected_reconnect.status_code == 401
    assert rejected_reconnect.json()["error"]["code"] == "AUTH_REQUIRED"

    async def consume_revoked_stream() -> None:
        assert await limiter.acquire(session.id)
        stream = _job_event_stream(
            api.runtime.jobs,
            api.runtime.security,
            session,
            cast(Request, cast(object, _ConnectedRequest())),
            "not-read-after-revocation",
            None,
            limiter,
            LocalHttpConfig(),
        )
        assert [chunk async for chunk in stream] == []
        assert await limiter.acquire(session.id)
        await limiter.release(session.id)

    asyncio.run(consume_revoked_stream())


def test_query_json_and_event_cursor_validation(api: ApiHarness) -> None:
    assert (
        api.client.get(
            "/api/jobs?limit=0",
            headers=api.read_headers(),
        ).status_code
        == 422
    )
    assert (
        api.client.get(
            "/api/books?unknown=value",
            headers=api.read_headers(),
        ).status_code
        == 422
    )
    assert (
        api.client.get(
            "/api/jobs?before_id=only-one-half",
            headers=api.read_headers(),
        ).status_code
        == 422
    )

    duplicate_json = api.client.post(
        "/api/session/bootstrap",
        content=b'{"nonce":"one","nonce":"two"}',
        headers={"Origin": ORIGIN, "Content-Type": "application/json"},
    )
    assert duplicate_json.status_code == 422

    submitted = submit_local_import(api, filename="cursor.md")
    assert asyncio.run(api.runtime.worker.run_once()) is True
    invalid_cursor = api.client.get(
        f"/api/jobs/{submitted['id']}/events",
        headers={**api.read_headers(), "Last-Event-ID": "invalid"},
    )
    assert invalid_cursor.status_code == 422
