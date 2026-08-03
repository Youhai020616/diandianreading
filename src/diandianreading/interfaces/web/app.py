"""FastAPI composition for the secured, single-port local product."""

from __future__ import annotations

import asyncio
import json
import os
import stat
import tempfile
import time
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager, suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol, cast, overload
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from starlette.middleware.base import RequestResponseEndpoint

from diandianreading.application.ports.chat import ChatMessageCursor
from diandianreading.application.use_cases.annotations import (
    AnnotationCursor,
    AnnotationNotFoundError,
    AnnotationService,
)
from diandianreading.application.use_cases.catalog import (
    BookCursor,
    BookNotFoundError,
    BookQuery,
    CatalogService,
)
from diandianreading.application.use_cases.chat import (
    ChatUseCase,
    ChatUseCaseError,
    SubmitChatCommand,
)
from diandianreading.application.use_cases.import_book import ImportBookUseCase
from diandianreading.application.use_cases.import_source import ImportSubmissionUseCase
from diandianreading.application.use_cases.jobs import (
    JobCursor,
    JobNotFoundError,
    JobQuery,
    JobService,
    JobServiceError,
)
from diandianreading.application.use_cases.reading import ReadingService
from diandianreading.domain import (
    CredentialRef,
    DiandianError,
    ErrorCode,
    Job,
    JobStatus,
    RightsBasis,
    TargetCapabilities,
)
from diandianreading.domain.annotations import (
    AnnotationColor,
    AnnotationStatus,
    ContentAnchor,
    TextQuote,
)
from diandianreading.domain.chat import (
    ChatErrorCode,
    ChatMessageRole,
    ChatReference,
    ChatReferenceLocationType,
    ChatRunStatus,
    QueryScope,
    QueryScopeType,
)
from diandianreading.infrastructure.local_api import (
    AuthenticatedSession,
    BootstrapAuthenticationError,
    LocalApiSecurityError,
    LocalApiSecurityService,
    SessionRevocationReason,
)
from diandianreading.interfaces.runtime import ApplicationPaths
from diandianreading.interfaces.web import serializers
from diandianreading.interfaces.web.http_security import (
    CSRF_COOKIE,
    SESSION_COOKIE,
    FixedWindowRateLimiter,
    LocalHttpConfig,
    LocalHttpError,
    LocalHttpSecurityBoundary,
    RequestPrincipal,
    SseConnectionLimiter,
)
from diandianreading.worker.runner import WorkerRunner

_CSP = "; ".join(
    (
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self'",
        "font-src 'self'",
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'",
    )
)
_ALLOWED_IMPORT_CONTENT_TYPES = frozenset({"application/json", "application/octet-stream"})
_ALLOWED_BOOK_SUFFIXES = frozenset({".epub", ".md", ".markdown", ".pdf"})
_EVIDENCE_REQUIRED_BASES = frozenset({RightsBasis.LICENSED, RightsBasis.EXPLICIT_PERMISSION})
_TERMINAL_JOB_STATUSES = frozenset({JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED})
_TERMINAL_CHAT_STATUSES = frozenset(
    {ChatRunStatus.COMPLETED, ChatRunStatus.FAILED, ChatRunStatus.CANCELLED}
)


class ProviderSessionStatus(Protocol):
    @property
    def provider(self) -> str: ...

    @property
    def profile(self) -> str: ...

    @property
    def state(self) -> object: ...

    @property
    def checked_at(self) -> datetime: ...


class ProviderSessionPort(Protocol):
    async def status(self, credential: CredentialRef) -> ProviderSessionStatus: ...


class WebRuntime(Protocol):
    paths: ApplicationPaths
    import_submission: ImportSubmissionUseCase
    imports: ImportBookUseCase
    jobs: JobService
    catalog: CatalogService
    reading: ReadingService
    annotations: AnnotationService
    chat: ChatUseCase
    security: LocalApiSecurityService
    worker: WorkerRunner

    @property
    def notebooklm_session(self) -> ProviderSessionPort: ...

    @property
    def zlibrary_session(self) -> ProviderSessionPort: ...

    @property
    def target_capabilities(self) -> TargetCapabilities: ...

    @property
    def zlibrary_enabled(self) -> bool: ...

    async def aclose(self) -> None: ...


class ApiProblem(RuntimeError):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        *,
        retriable: bool = False,
        details: Mapping[str, object] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.safe_message = message
        self.retriable = retriable
        self.details = dict(details or {})


class _WorkerStop:
    def __init__(self) -> None:
        self._event = asyncio.Event()

    def is_set(self) -> bool:
        return self._event.is_set()

    async def wait(self) -> object:
        await self._event.wait()
        return None

    def set(self) -> None:
        self._event.set()


def create_web_app(
    runtime: WebRuntime,
    *,
    config: LocalHttpConfig | None = None,
    start_worker: bool = True,
    close_runtime: bool = True,
) -> FastAPI:
    """Create one production-shaped app; tests may disable only the worker lifecycle."""

    http_config = config or LocalHttpConfig()
    boundary = LocalHttpSecurityBoundary(runtime.security, http_config)
    bootstrap_limiter = FixedWindowRateLimiter(limit=8, window_seconds=60.0)
    mutation_limiter = FixedWindowRateLimiter(limit=60, window_seconds=60.0)
    reader_limiter = FixedWindowRateLimiter(limit=240, window_seconds=60.0)
    sse_limiter = SseConnectionLimiter(http_config.max_sse_connections_per_session)
    static_root = Path(__file__).with_name("static")

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        stop = _WorkerStop()
        task: asyncio.Task[None] | None = None
        if start_worker:
            task = asyncio.create_task(runtime.worker.run_forever(stop), name="diandian-worker")
        try:
            yield
        finally:
            stop.set()
            if task is not None:
                try:
                    await asyncio.wait_for(task, timeout=5.0)
                except TimeoutError:
                    task.cancel()
                    with suppress(asyncio.CancelledError):
                        await task
                except Exception:
                    pass
            if close_runtime:
                await runtime.aclose()

    app = FastAPI(
        title="diandianreading local API",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        debug=False,
        lifespan=lifespan,
    )

    @app.middleware("http")
    async def enforce_local_boundary(
        request: Request,
        call_next: RequestResponseEndpoint,
    ) -> Response:
        try:
            boundary.validate_network_boundary(request)
            response = await call_next(request)
        except LocalHttpError as error:
            response = _problem_response(
                error.status_code,
                error.code,
                error.safe_message,
                request_id=_request_id(),
            )
        return _secure_response(response)

    @app.exception_handler(ApiProblem)
    async def handle_api_problem(_: Request, error: ApiProblem) -> JSONResponse:
        return _problem_response(
            error.status_code,
            error.code,
            error.safe_message,
            retriable=error.retriable,
            details=error.details,
            request_id=_request_id(),
        )

    @app.exception_handler(LocalHttpError)
    async def handle_http_error(_: Request, error: LocalHttpError) -> JSONResponse:
        return _problem_response(
            error.status_code,
            error.code,
            error.safe_message,
            request_id=_request_id(),
        )

    @app.exception_handler(ChatUseCaseError)
    async def handle_chat_error(_: Request, error: ChatUseCaseError) -> JSONResponse:
        status = _chat_error_status(error.error.code)
        details: dict[str, object] = {
            detail.key: list(detail.values) for detail in error.error.details
        }
        if error.active_run_id is not None:
            details["active_run_url"] = f"/api/chat-runs/{error.active_run_id}"
        payload = {
            "error": {
                **cast(dict[str, object], serializers.chat_error(error.error)),
                "details": details,
            }
        }
        return JSONResponse(payload, status_code=status)

    @app.exception_handler(JobNotFoundError)
    @app.exception_handler(BookNotFoundError)
    @app.exception_handler(AnnotationNotFoundError)
    async def handle_not_found(_: Request, error: Exception) -> JSONResponse:
        del error
        return _problem_response(
            404,
            "NOT_FOUND",
            "The requested local resource was not found",
            request_id=_request_id(),
        )

    @app.exception_handler(JobServiceError)
    async def handle_job_error(_: Request, error: JobServiceError) -> JSONResponse:
        return _problem_response(
            409,
            error.code.value,
            error.public_message,
            retriable=error.retryable,
            request_id=_request_id(),
        )

    @app.exception_handler(DiandianError)
    async def handle_domain_error(_: Request, error: DiandianError) -> JSONResponse:
        return _problem_response(
            _domain_error_status(error.code),
            _public_error_code(error.code),
            error.public_message,
            retriable=error.retryable,
            request_id=_request_id(),
        )

    @app.exception_handler(LocalApiSecurityError)
    async def handle_security_error(_: Request, error: LocalApiSecurityError) -> JSONResponse:
        del error
        return _problem_response(
            401,
            "AUTH_REQUIRED",
            "Local API authentication is required",
            request_id=_request_id(),
        )

    @app.exception_handler(RequestValidationError)
    @app.exception_handler(ValueError)
    async def handle_validation_error(_: Request, error: Exception) -> JSONResponse:
        del error
        return _problem_response(
            422,
            "VALIDATION",
            "The request did not satisfy the local API contract",
            request_id=_request_id(),
        )

    @app.exception_handler(Exception)
    async def handle_unexpected(_: Request, error: Exception) -> JSONResponse:
        del error
        return _problem_response(
            500,
            "UNEXPECTED",
            "Unexpected local service failure",
            request_id=_request_id(),
        )

    def authorize(
        request: Request,
        *,
        mutate: bool = False,
        session_only: bool = False,
        limiter: FixedWindowRateLimiter | None = None,
    ) -> RequestPrincipal:
        principal = boundary.authenticate(
            request,
            require_csrf=mutate,
            session_only=session_only,
        )
        if mutate:
            effective_limiter = limiter if limiter is not None else mutation_limiter
            key = (
                f"session:{principal.session.id}"
                if principal.session is not None
                else f"bearer:{request.client.host if request.client else 'unknown'}"
            )
            if not effective_limiter.allow(key):
                raise ApiProblem(
                    429,
                    "REMOTE_RATE_LIMITED",
                    "Too many local side-effect requests; retry later",
                    retriable=True,
                )
        return principal

    @app.get("/healthz", include_in_schema=False)
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/", include_in_schema=False)
    async def index() -> FileResponse:
        return FileResponse(static_root / "index.html", media_type="text/html")

    @app.get("/static/app.css", include_in_schema=False)
    async def stylesheet() -> FileResponse:
        return FileResponse(static_root / "app.css", media_type="text/css")

    @app.get("/static/app.js", include_in_schema=False)
    async def javascript() -> FileResponse:
        return FileResponse(static_root / "app.js", media_type="text/javascript")

    @app.post("/api/session/bootstrap")
    async def bootstrap_session(request: Request) -> JSONResponse:
        boundary.require_bootstrap_origin(request)
        peer = request.client.host if request.client is not None else "unknown"
        if not bootstrap_limiter.allow(peer):
            raise ApiProblem(429, "AUTH_REQUIRED", "Bootstrap attempt limit exceeded")
        payload = await _read_json_object(request, http_config.max_json_bytes)
        _require_exact_fields(payload, required={"nonce"})
        nonce = _required_text(payload, "nonce", max_length=4096)
        try:
            credentials = runtime.security.consume_bootstrap(nonce)
        except BootstrapAuthenticationError:
            raise ApiProblem(401, "AUTH_REQUIRED", "Bootstrap credential is invalid") from None
        response = JSONResponse(
            serializers.envelope(
                {
                    "authenticated": True,
                    "status": "active",
                    "idle_expires_at": serializers.iso(credentials.idle_expires_at),
                    "absolute_expires_at": serializers.iso(credentials.absolute_expires_at),
                }
            )
        )
        response.set_cookie(
            SESSION_COOKIE,
            credentials.session_token,
            httponly=True,
            secure=http_config.secure_cookies,
            samesite="strict",
            path="/",
        )
        response.set_cookie(
            CSRF_COOKIE,
            credentials.csrf_token,
            httponly=False,
            secure=http_config.secure_cookies,
            samesite="strict",
            path="/",
        )
        return response

    @app.get("/api/session")
    async def session_status(request: Request) -> dict[str, object]:
        principal = authorize(request)
        return serializers.envelope(
            {
                "authenticated": True,
                "status": "active",
                "mode": principal.kind.value,
                "idle_expires_at": (
                    serializers.iso(principal.session.idle_expires_at)
                    if principal.session is not None
                    else None
                ),
                "absolute_expires_at": (
                    serializers.iso(principal.session.absolute_expires_at)
                    if principal.session is not None
                    else None
                ),
            }
        )

    @app.post("/api/session/logout")
    async def logout_session(request: Request) -> Response:
        principal = authorize(request, mutate=True, session_only=True)
        assert principal.session is not None
        _ = runtime.security.revoke_session(
            principal.session,
            reason=SessionRevocationReason.LOGOUT,
        )
        response = Response(status_code=204)
        response.delete_cookie(SESSION_COOKIE, path="/", samesite="strict")
        response.delete_cookie(CSRF_COOKIE, path="/", samesite="strict")
        return response

    @app.get("/api/auth/status")
    async def provider_status(request: Request) -> dict[str, object]:
        _ = authorize(request)
        notebook_status = await _provider_status(
            runtime.notebooklm_session,
            CredentialRef("notebooklm", "default"),
        )
        zlibrary_status = (
            await _provider_status(
                runtime.zlibrary_session,
                CredentialRef("zlibrary", "default"),
            )
            if runtime.zlibrary_enabled
            else {
                "provider": "zlibrary",
                "profile": "default",
                "state": "disabled",
                "enabled": False,
            }
        )
        return serializers.envelope(
            {"providers": {"notebooklm": notebook_status, "zlibrary": zlibrary_status}}
        )

    @app.post("/api/imports", status_code=202)
    async def submit_import(request: Request) -> JSONResponse:
        _ = authorize(request, mutate=True)
        content_type = _base_content_type(request.headers.get("content-type"))
        if content_type not in _ALLOWED_IMPORT_CONTENT_TYPES:
            raise ApiProblem(415, "VALIDATION", "Import content type is not supported")
        if content_type == "application/octet-stream":
            job = await _submit_local_import(runtime, request)
        else:
            if not runtime.zlibrary_enabled:
                raise ApiProblem(409, "VALIDATION", "Z-Library acquisition is disabled")
            payload = await _read_json_object(request, http_config.max_json_bytes)
            job = _submit_zlibrary_import(runtime, payload)
        return JSONResponse(
            serializers.envelope({"job": serializers.job_view(runtime.jobs.get(job.id))}),
            status_code=202,
        )

    @app.get("/api/jobs")
    async def list_jobs(request: Request) -> dict[str, object]:
        _ = authorize(request)
        query = _job_query(request)
        return serializers.envelope(serializers.job_page(runtime.jobs.list(query)))

    @app.get("/api/jobs/{job_id}")
    async def get_job(job_id: str, request: Request) -> dict[str, object]:
        _ = authorize(request)
        return serializers.envelope({"job": serializers.job_view(runtime.jobs.get(job_id))})

    @app.post("/api/jobs/{job_id}/retry")
    async def retry_job(job_id: str, request: Request) -> dict[str, object]:
        _ = authorize(request, mutate=True)
        return serializers.envelope({"job": serializers.job_view(runtime.jobs.retry(job_id))})

    @app.get("/api/jobs/{job_id}/events")
    async def stream_job_events(job_id: str, request: Request) -> StreamingResponse:
        principal = authorize(request, session_only=True)
        assert principal.session is not None
        _ = runtime.jobs.get(job_id)
        after = _last_event_id(request)
        if not await sse_limiter.acquire(principal.session.id):
            raise ApiProblem(429, "REMOTE_RATE_LIMITED", "SSE connection limit exceeded")
        stream = _job_event_stream(
            runtime.jobs,
            runtime.security,
            principal.session,
            request,
            job_id,
            after,
            sse_limiter,
            http_config,
        )
        return _sse_response(stream)

    @app.get("/api/books")
    async def list_books(request: Request) -> dict[str, object]:
        _ = authorize(request)
        page = runtime.catalog.list(_book_query(request))
        return serializers.envelope(serializers.book_page(page))

    @app.get("/api/books/{book_id}")
    async def get_book_detail(book_id: str, request: Request) -> dict[str, object]:
        _ = authorize(request)
        detail = runtime.reading.get_detail(book_id)
        return serializers.envelope(serializers.book_detail(detail))

    @app.get("/api/books/{book_id}/content")
    async def get_book_content(book_id: str, request: Request) -> Response:
        _ = authorize(request)
        content = runtime.reading.get_content(book_id)
        etag = f'"{content.document.anchor_sha256}"'
        headers = {"ETag": etag}
        if _if_none_match(request, etag):
            return Response(status_code=304, headers=headers)
        media_type = (
            "text/markdown; charset=utf-8"
            if content.document.mime_type == "text/markdown"
            else content.document.mime_type
        )
        return Response(content=content.payload, media_type=media_type, headers=headers)

    @app.put("/api/books/{book_id}/progress")
    async def put_reading_progress(book_id: str, request: Request) -> dict[str, object]:
        _ = authorize(request, mutate=True, limiter=reader_limiter)
        payload = await _read_json_object(request, http_config.max_json_bytes)
        _require_exact_fields(payload, required={"anchor", "percent"})
        anchor = _content_anchor(payload["anchor"])
        percent = payload["percent"]
        if isinstance(percent, bool) or not isinstance(percent, int | float):
            raise ApiProblem(422, "VALIDATION", "percent must be a number")
        progress = runtime.reading.save_progress(book_id, anchor, float(percent))
        return serializers.envelope({"progress": serializers.reading_progress(progress)})

    @app.post("/api/books/{book_id}/annotations", status_code=201)
    async def create_annotation(book_id: str, request: Request) -> JSONResponse:
        _ = authorize(request, mutate=True, limiter=reader_limiter)
        payload = await _read_json_object(request, http_config.max_json_bytes)
        kind = payload.get("kind")
        if kind == "highlight":
            _require_exact_fields(
                payload,
                required={"kind", "anchor", "selected_text", "color"},
                optional={"body"},
            )
            annotation = runtime.annotations.create_highlight(
                book_id,
                anchor=_content_anchor(payload["anchor"], quote="required"),
                selected_text=_annotation_text(payload, "selected_text"),
                body=_optional_annotation_text(payload, "body"),
                color=_annotation_color(payload["color"]),
            )
        elif kind == "note":
            _require_exact_fields(payload, required={"kind", "body"}, optional={"anchor"})
            raw_anchor = payload.get("anchor")
            annotation = runtime.annotations.create_note(
                book_id,
                body=_annotation_text(payload, "body"),
                anchor=(
                    _content_anchor(raw_anchor, quote="optional")
                    if raw_anchor is not None
                    else None
                ),
            )
        else:
            raise ApiProblem(422, "VALIDATION", "kind must be highlight or note")
        return JSONResponse(
            serializers.envelope({"annotation": serializers.annotation(annotation)}),
            status_code=201,
        )

    @app.get("/api/books/{book_id}/annotations")
    async def list_annotations(book_id: str, request: Request) -> dict[str, object]:
        _ = authorize(request)
        page = runtime.annotations.list_for_book(
            book_id,
            statuses=_annotation_statuses(request),
            limit=_annotation_limit(request),
            before=_annotation_cursor(request),
        )
        return serializers.envelope(
            {
                "annotations": [serializers.annotation(item) for item in page.items],
                "next_cursor": (
                    {
                        "created_at": serializers.iso(page.next_cursor.created_at),
                        "id": page.next_cursor.id,
                    }
                    if page.next_cursor is not None
                    else None
                ),
            }
        )

    @app.patch("/api/annotations/{annotation_id}")
    async def edit_annotation(annotation_id: str, request: Request) -> dict[str, object]:
        _ = authorize(request, mutate=True, limiter=reader_limiter)
        payload = await _read_json_object(request, http_config.max_json_bytes)
        _require_exact_fields(payload, required=set(), optional={"body", "color"})
        if not payload:
            raise ApiProblem(422, "VALIDATION", "At least one editable field is required")
        body_change: tuple[str | None] | None = None
        if "body" in payload:
            body_change = (_optional_annotation_text(payload, "body"),)
        color = _annotation_color(payload["color"]) if "color" in payload else None
        annotation = runtime.annotations.edit(annotation_id, body_change=body_change, color=color)
        return serializers.envelope({"annotation": serializers.annotation(annotation)})

    @app.delete("/api/annotations/{annotation_id}")
    async def delete_annotation(annotation_id: str, request: Request) -> dict[str, object]:
        _ = authorize(request, mutate=True, limiter=reader_limiter)
        annotation = runtime.annotations.soft_delete(annotation_id)
        return serializers.envelope({"annotation": serializers.annotation(annotation)})

    @app.post("/api/annotations/{annotation_id}/restore")
    async def restore_annotation(annotation_id: str, request: Request) -> dict[str, object]:
        _ = authorize(request, mutate=True, limiter=reader_limiter)
        annotation = runtime.annotations.restore(annotation_id)
        return serializers.envelope({"annotation": serializers.annotation(annotation)})

    @app.get("/api/books/{book_id}/conversation")
    async def get_book_conversation(book_id: str, request: Request) -> dict[str, object]:
        _ = authorize(request)
        _ = runtime.catalog.get(book_id)
        value = runtime.chat.get_conversation_for_book(book_id)
        if value is None:
            raise ApiProblem(404, "NOT_FOUND", "Book conversation was not found")
        return serializers.envelope({"conversation": serializers.conversation(value)})

    @app.put("/api/books/{book_id}/conversation")
    async def ensure_book_conversation(book_id: str, request: Request) -> JSONResponse:
        _ = authorize(request, mutate=True)
        payload = await _read_json_object(request, http_config.max_json_bytes)
        _require_exact_fields(
            payload,
            required={"title", "default_query_scope"},
        )
        title = _required_text(payload, "title", max_length=180)
        scope = _query_scope(payload["default_query_scope"])
        scope.require_whole_book()
        result = runtime.chat.ensure_conversation(book_id, title=title)
        return JSONResponse(
            serializers.envelope(serializers.conversation_result(result)),
            status_code=201 if result.created else 200,
        )

    @app.get("/api/conversations/{conversation_id}/messages")
    async def list_messages(conversation_id: str, request: Request) -> dict[str, object]:
        _ = authorize(request)
        if runtime.chat.get_conversation(conversation_id) is None:
            raise ApiProblem(404, "NOT_FOUND", "Conversation was not found")
        limit, cursor = _message_query(request)
        page = runtime.chat.list_messages(conversation_id, before=cursor, limit=limit)
        references: dict[str, tuple[ChatReference, ...]] = {}
        for message in page.messages:
            if message.role is not ChatMessageRole.ASSISTANT:
                continue
            result = runtime.chat.get_result(message.chat_run_id)
            if result is not None:
                references[message.id] = result.references
        return serializers.envelope(
            serializers.chat_message_page(
                page,
                references_by_message=references,
                active_run=runtime.chat.get_active_run(conversation_id),
            )
        )

    @app.post("/api/conversations/{conversation_id}/messages", status_code=202)
    async def submit_message(conversation_id: str, request: Request) -> JSONResponse:
        _ = authorize(request, mutate=True)
        payload = await _read_json_object(request, http_config.max_json_bytes)
        _require_exact_fields(
            payload,
            required={"client_message_id", "question", "query_scope"},
        )
        client_message_id = _required_text(payload, "client_message_id", max_length=512)
        idempotency_key = _required_header(request, "idempotency-key", max_length=512)
        result = runtime.chat.submit(
            SubmitChatCommand(
                conversation_id=conversation_id,
                client_message_id=client_message_id,
                question=_required_text(payload, "question", max_length=8_000),
                query_scope=_query_scope(payload["query_scope"]),
                idempotency_key=idempotency_key,
            )
        )
        return JSONResponse(
            serializers.envelope(serializers.chat_submission(result)),
            status_code=200 if result.replayed else 202,
        )

    @app.get("/api/chat-runs/{run_id}")
    async def get_chat_run(run_id: str, request: Request) -> dict[str, object]:
        _ = authorize(request)
        result = runtime.chat.get_result(run_id)
        if result is None:
            raise ApiProblem(404, "NOT_FOUND", "Chat Run was not found")
        return serializers.envelope(serializers.chat_result(result))

    @app.post("/api/chat-runs/{run_id}/cancel")
    async def cancel_chat_run(run_id: str, request: Request) -> dict[str, object]:
        _ = authorize(request, mutate=True)
        run = runtime.chat.request_cancel(run_id)
        return serializers.envelope({"chat_run": serializers.chat_run(run)})

    @app.post("/api/chat-runs/{run_id}/retry")
    async def retry_chat_run(run_id: str, request: Request) -> dict[str, object]:
        _ = authorize(request, mutate=True)
        payload = await _read_json_object(request, http_config.max_json_bytes)
        _require_exact_fields(payload, required={"client_retry_id"})
        client_retry_id = _required_text(payload, "client_retry_id", max_length=512)
        idempotency_key = _required_header(request, "idempotency-key", max_length=512)
        if idempotency_key != client_retry_id:
            raise ApiProblem(409, "IDEMPOTENCY_CONFLICT", "Retry idempotency key does not match")
        return serializers.envelope(
            serializers.chat_retry(runtime.chat.retry(run_id, client_retry_id))
        )

    @app.get("/api/chat-runs/{run_id}/events")
    async def stream_chat_events(run_id: str, request: Request) -> StreamingResponse:
        principal = authorize(request, session_only=True)
        assert principal.session is not None
        if runtime.chat.get_result(run_id) is None:
            raise ApiProblem(404, "NOT_FOUND", "Chat Run was not found")
        after = _last_event_id(request)
        if not await sse_limiter.acquire(principal.session.id):
            raise ApiProblem(429, "REMOTE_RATE_LIMITED", "SSE connection limit exceeded")
        stream = _chat_event_stream(
            runtime.chat,
            runtime.security,
            principal.session,
            request,
            run_id,
            after,
            sse_limiter,
            http_config,
        )
        return _sse_response(stream)

    return app


async def _submit_local_import(runtime: WebRuntime, request: Request) -> Job:
    provider = _required_header(request, "x-diandian-provider", max_length=32)
    if provider != "local":
        raise ApiProblem(422, "VALIDATION", "Raw imports must use the local provider")
    filename = _safe_filename(_required_header(request, "x-diandian-filename", max_length=512))
    rights_basis = _rights_basis(
        _required_header(request, "x-diandian-rights-basis", max_length=64)
    )
    _reject_evidence_required_basis(rights_basis)
    if _required_header(request, "x-diandian-rights-confirmed", max_length=8) != "true":
        raise ApiProblem(422, "VALIDATION", "Explicit rights confirmation is required")
    profile = _required_header(request, "x-diandian-notebooklm-profile", max_length=128)
    license_identifier = _optional_header(
        request,
        "x-diandian-license-identifier",
        max_length=256,
    )
    title = _optional_header(request, "x-diandian-title", max_length=200)
    author = _optional_header(request, "x-diandian-author", max_length=200)

    upload_root = _prepare_private_directory(runtime.paths.upload_root)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=upload_root,
        prefix="upload-",
        suffix=Path(filename).suffix.casefold(),
    )
    temporary = Path(temporary_name)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(descriptor, 0o600)
        await _stream_request_to_descriptor(
            request,
            descriptor,
            max_bytes=runtime.target_capabilities.max_source_bytes,
        )
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        return await runtime.import_submission.submit_local(
            temporary,
            rights_basis=rights_basis,
            license_identifier=license_identifier,
            evidence_storage_key=None,
            rights_confirmed=True,
            target_credential=CredentialRef("notebooklm", profile),
            target_capabilities=runtime.target_capabilities,
            title=title,
            author=author,
            display_filename=filename,
        )
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)


def _submit_zlibrary_import(runtime: WebRuntime, payload: dict[str, object]) -> Job:
    _require_exact_fields(
        payload,
        required={
            "provider",
            "location",
            "zlibrary_profile",
            "notebooklm_profile",
            "rights_basis",
            "license_identifier",
            "rights_confirmed",
            "attestation_version",
            "title",
            "author",
        },
    )
    if payload["provider"] != "zlibrary" or payload["rights_confirmed"] is not True:
        raise ApiProblem(422, "VALIDATION", "Z-Library import attestation is invalid")
    rights_basis = _rights_basis(payload["rights_basis"])
    _reject_evidence_required_basis(rights_basis)
    return runtime.import_submission.submit_zlibrary(
        _required_text(payload, "location", max_length=2048),
        acquisition_credential=CredentialRef(
            "zlibrary",
            _required_text(payload, "zlibrary_profile", max_length=128),
        ),
        target_credential=CredentialRef(
            "notebooklm",
            _required_text(payload, "notebooklm_profile", max_length=128),
        ),
        rights_basis=rights_basis,
        license_identifier=_optional_text(payload, "license_identifier", max_length=256),
        evidence_storage_key=None,
        attestation_version=_required_text(payload, "attestation_version", max_length=128),
        rights_confirmed=True,
        target_capabilities=runtime.target_capabilities,
        title=_required_text(payload, "title", max_length=200),
        author=_optional_text(payload, "author", max_length=200),
    )


async def _provider_status(
    manager: ProviderSessionPort,
    credential: CredentialRef,
) -> dict[str, object]:
    try:
        status = await manager.status(credential)
        state = getattr(status.state, "value", status.state)
        if not isinstance(state, str):
            raise TypeError("Provider status state is invalid")
        return {
            "provider": status.provider,
            "profile": status.profile,
            "state": state,
            "enabled": True,
            "checked_at": serializers.iso(status.checked_at),
        }
    except Exception:
        return {
            "provider": credential.provider,
            "profile": credential.profile,
            "state": "error",
            "enabled": True,
        }


async def _job_event_stream(
    jobs: JobService,
    security: LocalApiSecurityService,
    session: AuthenticatedSession,
    request: Request,
    job_id: str,
    after_event_id: int | None,
    limiter: SseConnectionLimiter,
    config: LocalHttpConfig,
) -> AsyncIterator[bytes]:
    cursor = after_event_id or 0
    started = time.monotonic()
    last_write = started
    try:
        while time.monotonic() - started < config.sse_max_seconds:
            if not security.is_session_active(session) or await request.is_disconnected():
                return
            events = tuple(event for event in jobs.list_events(job_id) if event.version > cursor)
            for event in events:
                cursor = event.version
                yield _sse_event(
                    _job_event_type(event.to_status),
                    serializers.job_event(event),
                    event_id=cursor,
                )
                last_write = time.monotonic()
            snapshot = jobs.get(job_id)
            if snapshot.status in _TERMINAL_JOB_STATUSES:
                return
            if time.monotonic() - last_write >= config.sse_heartbeat_seconds:
                yield b": keep-alive\n\n"
                last_write = time.monotonic()
            await asyncio.sleep(config.sse_poll_seconds)
    finally:
        await limiter.release(session.id)


async def _chat_event_stream(
    chat: ChatUseCase,
    security: LocalApiSecurityService,
    session: AuthenticatedSession,
    request: Request,
    run_id: str,
    after_event_id: int | None,
    limiter: SseConnectionLimiter,
    config: LocalHttpConfig,
) -> AsyncIterator[bytes]:
    cursor = after_event_id
    started = time.monotonic()
    last_write = started
    try:
        while time.monotonic() - started < config.sse_max_seconds:
            if not security.is_session_active(session) or await request.is_disconnected():
                return
            events = chat.list_events(run_id, after_event_id=cursor, limit=100)
            for event in events:
                cursor = event.id
                yield _sse_event(
                    event.event_type.value,
                    serializers.chat_run_event(event),
                    event_id=event.id,
                )
                last_write = time.monotonic()
            result = chat.get_result(run_id)
            if result is None or result.run.status in _TERMINAL_CHAT_STATUSES:
                return
            if time.monotonic() - last_write >= config.sse_heartbeat_seconds:
                yield b": keep-alive\n\n"
                last_write = time.monotonic()
            await asyncio.sleep(config.sse_poll_seconds)
    finally:
        await limiter.release(session.id)


def _sse_event(event_type: str, data: Mapping[str, object], *, event_id: int) -> bytes:
    encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return f"id: {event_id}\nevent: {event_type}\ndata: {encoded}\n\n".encode()


def _sse_response(stream: AsyncIterator[bytes]) -> StreamingResponse:
    return StreamingResponse(
        stream,
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
        },
    )


def _job_event_type(status: JobStatus) -> str:
    if status is JobStatus.COMPLETED:
        return "job.completed"
    if status is JobStatus.FAILED:
        return "job.failed"
    if status is JobStatus.BLOCKED:
        return "job.blocked"
    if status is JobStatus.CANCELLED:
        return "job.cancelled"
    return "job.updated"


def _job_query(request: Request) -> JobQuery:
    values = _query_values(request, {"limit", "status", "before_created_at", "before_id"})
    limit = _bounded_int(values.get("limit"), default=50, minimum=1, maximum=100)
    status_value = values.get("status")
    status = JobStatus(status_value) if status_value is not None else None
    cursor = _cursor(values, JobCursor)
    return JobQuery(status=status, limit=limit, before=cursor)


def _if_none_match(request: Request, etag: str) -> bool:
    header = request.headers.get("if-none-match")
    if header is None:
        return False
    candidates = {candidate.strip() for candidate in header.split(",")}
    return "*" in candidates or etag in candidates


def _optional_int(payload: Mapping[str, object], key: str) -> int | None:
    value = payload.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ApiProblem(422, "VALIDATION", f"{key} must be an integer")
    return value


def _content_anchor(
    value: object,
    *,
    quote: str = "forbidden",
) -> ContentAnchor:
    if not isinstance(value, Mapping):
        raise ApiProblem(422, "VALIDATION", "anchor must be an object")
    payload = cast(Mapping[str, object], value)
    optional = {"start", "end", "chapter_ref"}
    if quote != "forbidden":
        optional.add("quote")
    _require_exact_fields(
        payload,
        required={"type", "anchor_sha256"},
        optional=optional,
    )
    raw_type = payload.get("type")
    if not isinstance(raw_type, str):
        raise ApiProblem(422, "VALIDATION", "anchor type must be text")
    try:
        location_type = ChatReferenceLocationType(raw_type)
    except ValueError:
        raise ApiProblem(422, "VALIDATION", "anchor type is not supported") from None
    sha256 = payload.get("anchor_sha256")
    if not isinstance(sha256, str):
        raise ApiProblem(422, "VALIDATION", "anchor_sha256 must be text")
    chapter_ref = payload.get("chapter_ref")
    if chapter_ref is not None and not isinstance(chapter_ref, str):
        raise ApiProblem(422, "VALIDATION", "chapter_ref must be text")
    parsed_quote = _text_quote(payload.get("quote"))
    if quote == "required" and parsed_quote is None:
        raise ApiProblem(422, "VALIDATION", "anchor quote is required")
    return ContentAnchor(
        type=location_type,
        anchor_sha256=sha256,
        start=_optional_int(payload, "start"),
        end=_optional_int(payload, "end"),
        chapter_ref=chapter_ref,
        quote=parsed_quote,
    )


def _text_quote(value: object) -> TextQuote | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise ApiProblem(422, "VALIDATION", "anchor quote must be an object")
    payload = cast(Mapping[str, object], value)
    _require_exact_fields(payload, required={"exact"}, optional={"prefix", "suffix"})
    parts: dict[str, str] = {}
    for key in ("exact", "prefix", "suffix"):
        raw = payload.get(key, "")
        if not isinstance(raw, str):
            raise ApiProblem(422, "VALIDATION", f"quote {key} must be text")
        parts[key] = raw
    return TextQuote(exact=parts["exact"], prefix=parts["prefix"], suffix=parts["suffix"])


def _annotation_text(payload: Mapping[str, object], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value:
        raise ApiProblem(422, "VALIDATION", f"{key} must be non-empty text")
    return value


def _optional_annotation_text(payload: Mapping[str, object], key: str) -> str | None:
    value = payload.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise ApiProblem(422, "VALIDATION", f"{key} must be non-empty text or null")
    return value


def _annotation_color(value: object) -> AnnotationColor:
    if not isinstance(value, str):
        raise ApiProblem(422, "VALIDATION", "color must be text")
    try:
        return AnnotationColor(value)
    except ValueError:
        raise ApiProblem(422, "VALIDATION", "color is not supported") from None


def _annotation_limit(request: Request) -> int:
    raw = request.query_params.get("limit")
    if raw is None:
        return 50
    try:
        limit = int(raw)
    except ValueError:
        raise ApiProblem(422, "VALIDATION", "limit must be an integer") from None
    if limit < 1 or limit > 100:
        raise ApiProblem(422, "VALIDATION", "limit must be between 1 and 100")
    return limit


def _annotation_statuses(request: Request) -> tuple[AnnotationStatus, ...]:
    raw = request.query_params.get("status")
    if raw is None:
        return (AnnotationStatus.ACTIVE, AnnotationStatus.ORPHANED)
    statuses: list[AnnotationStatus] = []
    for token in raw.split(","):
        try:
            status = AnnotationStatus(token.strip())
        except ValueError:
            raise ApiProblem(422, "VALIDATION", "status filter is not supported") from None
        if status not in statuses:
            statuses.append(status)
    if not statuses:
        raise ApiProblem(422, "VALIDATION", "status filter cannot be empty")
    return tuple(statuses)


def _annotation_cursor(request: Request) -> AnnotationCursor | None:
    created_at = request.query_params.get("before_created_at")
    identifier = request.query_params.get("before_id")
    if created_at is None and identifier is None:
        return None
    if created_at is None or identifier is None:
        raise ApiProblem(422, "VALIDATION", "before_created_at and before_id must be paired")
    try:
        parsed = datetime.fromisoformat(created_at)
    except ValueError:
        raise ApiProblem(422, "VALIDATION", "before_created_at must be ISO-8601") from None
    return AnnotationCursor(created_at=parsed, id=identifier)


def _book_query(request: Request) -> BookQuery:
    values = _query_values(request, {"limit", "before_created_at", "before_id"})
    limit = _bounded_int(values.get("limit"), default=50, minimum=1, maximum=100)
    return BookQuery(limit=limit, before=_cursor(values, BookCursor))


def _message_query(request: Request) -> tuple[int, ChatMessageCursor | None]:
    values = _query_values(
        request,
        {"limit", "before_created_at", "before_message_id"},
    )
    limit = _bounded_int(values.get("limit"), default=50, minimum=1, maximum=100)
    created_at = values.get("before_created_at")
    message_id = values.get("before_message_id")
    if (created_at is None) != (message_id is None):
        raise ApiProblem(422, "VALIDATION", "Message cursor fields must be provided together")
    cursor = (
        ChatMessageCursor(_parse_datetime(created_at), message_id)
        if created_at is not None and message_id is not None
        else None
    )
    return limit, cursor


@overload
def _cursor(
    values: Mapping[str, str],
    cursor_type: type[JobCursor],
) -> JobCursor | None: ...


@overload
def _cursor(
    values: Mapping[str, str],
    cursor_type: type[BookCursor],
) -> BookCursor | None: ...


def _cursor(
    values: Mapping[str, str],
    cursor_type: type[JobCursor] | type[BookCursor],
) -> JobCursor | BookCursor | None:
    created_at = values.get("before_created_at")
    identifier = values.get("before_id")
    if (created_at is None) != (identifier is None):
        raise ApiProblem(422, "VALIDATION", "Cursor fields must be provided together")
    if created_at is None or identifier is None:
        return None
    return cursor_type(created_at=_parse_datetime(created_at), id=identifier)


def _query_values(request: Request, allowed: set[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for key in request.query_params:
        if key not in allowed or len(request.query_params.getlist(key)) != 1:
            raise ApiProblem(422, "VALIDATION", "Query parameters are invalid")
        value = request.query_params[key]
        if not value or len(value) > 512:
            raise ApiProblem(422, "VALIDATION", "Query parameters are invalid")
        result[key] = value
    return result


def _last_event_id(request: Request) -> int | None:
    values = request.headers.getlist("last-event-id")
    if not values:
        return None
    if len(values) != 1 or not values[0].isdigit():
        raise ApiProblem(422, "VALIDATION", "Last-Event-ID is invalid")
    value = int(values[0])
    if value < 0 or value > (1 << 63) - 1:
        raise ApiProblem(422, "VALIDATION", "Last-Event-ID is invalid")
    return value


async def _read_json_object(request: Request, max_bytes: int) -> dict[str, object]:
    if _base_content_type(request.headers.get("content-type")) != "application/json":
        raise ApiProblem(415, "VALIDATION", "JSON content type is required")
    body = await _read_bounded_body(request, max_bytes)
    try:
        decoded = body.decode("utf-8")
        value = json.loads(decoded, object_pairs_hook=_unique_json_object)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise ApiProblem(422, "VALIDATION", "JSON body is invalid") from None
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ApiProblem(422, "VALIDATION", "JSON body must be an object")
    return cast(dict[str, object], value)


async def _read_bounded_body(request: Request, max_bytes: int) -> bytes:
    expected = _content_length(request, max_bytes)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > max_bytes or len(body) > expected:
            raise ApiProblem(413, "PAYLOAD_TOO_LARGE", "Request body exceeds the local limit")
    if len(body) != expected:
        raise ApiProblem(400, "VALIDATION", "Request body length did not match Content-Length")
    return bytes(body)


async def _stream_request_to_descriptor(
    request: Request,
    descriptor: int,
    *,
    max_bytes: int,
) -> None:
    expected = _content_length(request, max_bytes)
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > max_bytes or total > expected:
            raise ApiProblem(413, "PAYLOAD_TOO_LARGE", "Import exceeds the local byte limit")
        _write_all(descriptor, chunk)
    if total != expected or total == 0:
        raise ApiProblem(400, "VALIDATION", "Import body length did not match Content-Length")


def _content_length(request: Request, max_bytes: int) -> int:
    values = request.headers.getlist("content-length")
    if len(values) != 1 or not values[0].isdigit():
        raise ApiProblem(411, "VALIDATION", "A single Content-Length header is required")
    value = int(values[0])
    if value <= 0:
        raise ApiProblem(400, "VALIDATION", "Request body cannot be empty")
    if value > max_bytes:
        raise ApiProblem(413, "PAYLOAD_TOO_LARGE", "Request body exceeds the local limit")
    return value


def _write_all(descriptor: int, payload: bytes) -> None:
    view = memoryview(payload)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise OSError("Local upload write failed")
        view = view[written:]


def _unique_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON field")
        result[key] = value
    return result


def _require_exact_fields(
    payload: Mapping[str, object],
    *,
    required: set[str],
    optional: set[str] | None = None,
) -> None:
    allowed = required | (optional or set())
    if set(payload) - allowed or not required.issubset(payload):
        raise ApiProblem(422, "VALIDATION", "JSON fields do not match the endpoint contract")


def _required_text(payload: Mapping[str, object], key: str, *, max_length: int) -> str:
    value = payload.get(key)
    if not isinstance(value, str):
        raise ApiProblem(422, "VALIDATION", f"{key} must be text")
    normalized = value.strip()
    if not normalized or len(normalized) > max_length or _has_control(normalized):
        raise ApiProblem(422, "VALIDATION", f"{key} is invalid")
    return normalized


def _optional_text(
    payload: Mapping[str, object],
    key: str,
    *,
    max_length: int,
) -> str | None:
    value = payload.get(key)
    if value is None:
        return None
    return _required_text(payload, key, max_length=max_length)


def _required_header(request: Request, name: str, *, max_length: int) -> str:
    values = request.headers.getlist(name)
    if len(values) != 1:
        raise ApiProblem(422, "VALIDATION", f"{name} header is required exactly once")
    value = values[0].strip()
    if not value or len(value) > max_length or _has_control(value):
        raise ApiProblem(422, "VALIDATION", f"{name} header is invalid")
    return value


def _optional_header(request: Request, name: str, *, max_length: int) -> str | None:
    values = request.headers.getlist(name)
    if not values:
        return None
    if len(values) != 1:
        raise ApiProblem(422, "VALIDATION", f"{name} header is duplicated")
    value = values[0].strip()
    if not value:
        return None
    if len(value) > max_length or _has_control(value):
        raise ApiProblem(422, "VALIDATION", f"{name} header is invalid")
    return value


def _rights_basis(value: object) -> RightsBasis:
    if not isinstance(value, str):
        raise ApiProblem(422, "VALIDATION", "Rights basis is invalid")
    try:
        return RightsBasis(value)
    except ValueError:
        raise ApiProblem(422, "VALIDATION", "Rights basis is invalid") from None


def _reject_evidence_required_basis(value: RightsBasis) -> None:
    if value in _EVIDENCE_REQUIRED_BASES:
        raise ApiProblem(
            422,
            "VALIDATION",
            "This rights basis requires a separately stored evidence record",
        )


def _query_scope(value: object) -> QueryScope:
    if not isinstance(value, dict) or set(value) != {"type"}:
        raise ApiProblem(422, "VALIDATION", "Query scope is invalid")
    scope_type = value.get("type")
    if not isinstance(scope_type, str):
        raise ApiProblem(422, "VALIDATION", "Query scope is invalid")
    try:
        return QueryScope(QueryScopeType(scope_type))
    except ValueError:
        raise ApiProblem(422, "VALIDATION", "Query scope is invalid") from None


def _safe_filename(value: str) -> str:
    if (
        value in {".", ".."}
        or Path(value).name != value
        or "/" in value
        or "\\" in value
        or len(value.encode("utf-8")) > 255
        or Path(value).suffix.casefold() not in _ALLOWED_BOOK_SUFFIXES
    ):
        raise ApiProblem(422, "VALIDATION", "Import filename is invalid or unsupported")
    return value


def _prepare_private_directory(path: Path) -> Path:
    absolute = Path(os.path.abspath(path.expanduser()))
    current = Path(absolute.anchor)
    for segment in absolute.parts[1:]:
        current /= segment
        if current.is_symlink():
            raise ApiProblem(500, "UNEXPECTED", "Local upload storage is unavailable")
    absolute.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != "nt":
        absolute.chmod(0o700)
    metadata = absolute.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise ApiProblem(500, "UNEXPECTED", "Local upload storage is unavailable")
    if os.name != "nt" and (
        (hasattr(os, "getuid") and metadata.st_uid != os.getuid())
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        raise ApiProblem(500, "UNEXPECTED", "Local upload storage is unavailable")
    return absolute


def _parse_datetime(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        raise ApiProblem(422, "VALIDATION", "Cursor timestamp is invalid") from None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ApiProblem(422, "VALIDATION", "Cursor timestamp must include a timezone")
    return parsed.astimezone(UTC)


def _bounded_int(
    value: str | None,
    *,
    default: int,
    minimum: int,
    maximum: int,
) -> int:
    if value is None:
        return default
    if not value.isdigit():
        raise ApiProblem(422, "VALIDATION", "Pagination limit is invalid")
    parsed = int(value)
    if parsed < minimum or parsed > maximum:
        raise ApiProblem(422, "VALIDATION", "Pagination limit is invalid")
    return parsed


def _base_content_type(value: str | None) -> str:
    return value.split(";", 1)[0].strip().casefold() if value is not None else ""


def _has_control(value: str) -> bool:
    return any(ord(character) < 32 or ord(character) == 127 for character in value)


def _secure_response(response: Response) -> Response:
    response.headers["Content-Security-Policy"] = _CSP
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = (
        "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
    )
    response.headers["Cache-Control"] = "no-store"
    for header in ("access-control-allow-origin", "access-control-allow-credentials"):
        if header in response.headers:
            del response.headers[header]
    return response


def _problem_response(
    status_code: int,
    code: str,
    message: str,
    *,
    request_id: str,
    retriable: bool = False,
    details: Mapping[str, object] | None = None,
) -> JSONResponse:
    return JSONResponse(
        {
            "error": {
                "code": code,
                "message": message,
                "retriable": retriable,
                "request_id": request_id,
                "details": dict(details or {}),
            }
        },
        status_code=status_code,
    )


def _chat_error_status(code: ChatErrorCode) -> int:
    if code is ChatErrorCode.NOT_FOUND:
        return 404
    if code in {ChatErrorCode.CONVERSATION_BUSY, ChatErrorCode.IDEMPOTENCY_CONFLICT}:
        return 409
    if code is ChatErrorCode.PAYLOAD_TOO_LARGE:
        return 413
    if code is ChatErrorCode.AUTH_REQUIRED:
        return 401
    if code in {ChatErrorCode.REMOTE_RATE_LIMITED}:
        return 429
    if code in {ChatErrorCode.REMOTE_UNAVAILABLE, ChatErrorCode.SOURCE_NOT_READY}:
        return 503
    return 422 if code is ChatErrorCode.VALIDATION else 500


def _domain_error_status(code: ErrorCode) -> int:
    if code is ErrorCode.AUTH_REQUIRED:
        return 401
    if code is ErrorCode.SOURCE_LIMIT_EXCEEDED:
        return 413
    if code in {ErrorCode.VALIDATION, ErrorCode.FORMAT_UNSUPPORTED}:
        return 422
    if code is ErrorCode.REPOSITORY_CONFLICT:
        return 409
    if code is ErrorCode.REMOTE_RATE_LIMITED:
        return 429
    if code in {
        ErrorCode.SOURCE_UNAVAILABLE,
        ErrorCode.DOWNLOAD_TIMEOUT,
        ErrorCode.REMOTE_UNAVAILABLE,
    }:
        return 503
    return 500


def _public_error_code(code: ErrorCode) -> str:
    return "PAYLOAD_TOO_LARGE" if code is ErrorCode.SOURCE_LIMIT_EXCEEDED else code.value


def _request_id() -> str:
    return f"req-{uuid4()}"
