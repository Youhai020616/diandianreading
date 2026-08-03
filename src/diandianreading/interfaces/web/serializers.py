"""Public, local-ID-only JSON projections for the Web/API interface."""

from __future__ import annotations

from datetime import datetime

from diandianreading.application.ports.chat import (
    ChatMessagePage,
    ChatRetryResult,
    ChatRunResult,
    ChatSubmissionResult,
    ConversationEnsureResult,
)
from diandianreading.application.ports.reading import ChapterSpanView
from diandianreading.application.use_cases.catalog import BookPage, BookView
from diandianreading.application.use_cases.jobs import JobPage, JobView
from diandianreading.application.use_cases.reading import (
    BookDetailView,
    ReadingDocumentView,
)
from diandianreading.domain.annotations import ContentAnchor, ReadingProgress
from diandianreading.domain.chat import (
    ChatError,
    ChatMessage,
    ChatReference,
    ChatRun,
    ChatRunEvent,
    Conversation,
    EffectiveBookScope,
)
from diandianreading.domain.jobs import JobEvent


def envelope(data: object) -> dict[str, object]:
    return {"data": data}


def iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def book_view(view: BookView) -> dict[str, object]:
    return {
        "id": view.id,
        "title": view.title,
        "author": view.author,
        "status": view.status.value,
        "created_at": iso(view.created_at),
        "updated_at": iso(view.updated_at),
    }


def book_page(page: BookPage) -> dict[str, object]:
    return {
        "books": [book_view(item) for item in page.items],
        "next_cursor": (
            {
                "created_at": iso(page.next_cursor.created_at),
                "id": page.next_cursor.id,
            }
            if page.next_cursor is not None
            else None
        ),
    }


def chapter_span(view: ChapterSpanView) -> dict[str, object]:
    return {
        "reference": view.reference,
        "title": view.title,
        "start": view.start,
        "end": view.end,
    }


def content_anchor(value: ContentAnchor) -> dict[str, object]:
    return {
        "type": value.type.value,
        "anchor_sha256": value.anchor_sha256,
        "start": value.start,
        "end": value.end,
        "chapter_ref": value.chapter_ref,
    }


def reading_progress(value: ReadingProgress) -> dict[str, object]:
    return {
        "book_id": value.book_id,
        "anchor": content_anchor(value.anchor),
        "percent": value.percent,
        "updated_at": iso(value.updated_at),
        "version": value.version,
    }


def reading_document(value: ReadingDocumentView) -> dict[str, object]:
    return {
        "book_id": value.book_id,
        "anchor_sha256": value.anchor_sha256,
        "mime_type": value.mime_type,
        "size_bytes": value.size_bytes,
    }


def book_detail(value: BookDetailView) -> dict[str, object]:
    return {
        "book": book_view(value.book),
        "document": reading_document(value.document),
        "chapters": [chapter_span(item) for item in value.chapters],
        "progress": (reading_progress(value.progress) if value.progress is not None else None),
    }


def job_view(view: JobView) -> dict[str, object]:
    return {
        "id": view.id,
        "job_type": view.job_type,
        "book_title": view.book_title,
        "status": view.status.value,
        "current_step": view.current_step.value if view.current_step is not None else None,
        "attempt": view.attempt,
        "progress_current": view.progress_current,
        "progress_total": view.progress_total,
        "last_error_code": (
            view.last_error_code.value if view.last_error_code is not None else None
        ),
        "last_error_detail_redacted": view.last_error_detail_redacted,
        "retriable": view.retriable,
        "blocked_reason": (view.blocked_reason.value if view.blocked_reason is not None else None),
        "cancel_requested_at": iso(view.cancel_requested_at),
        "not_before": iso(view.not_before),
        "book_id": view.book_id,
        "created_at": iso(view.created_at),
        "updated_at": iso(view.updated_at),
        "started_at": iso(view.started_at),
        "completed_at": iso(view.completed_at),
    }


def job_page(page: JobPage) -> dict[str, object]:
    return {
        "jobs": [job_view(item) for item in page.items],
        "next_cursor": (
            {
                "created_at": iso(page.next_cursor.created_at),
                "id": page.next_cursor.id,
            }
            if page.next_cursor is not None
            else None
        ),
    }


def job_event(event: JobEvent) -> dict[str, object]:
    return {
        "job_id": event.job_id,
        "from_status": event.from_status.value if event.from_status is not None else None,
        "to_status": event.to_status.value,
        "current_step": event.current_step.value if event.current_step is not None else None,
        "attempt": event.attempt,
        "progress_current": event.progress_current,
        "progress_total": event.progress_total,
        "blocked_reason": (
            event.blocked_reason.value if event.blocked_reason is not None else None
        ),
        "cancel_requested_at": iso(event.cancel_requested_at),
        "created_at": iso(event.created_at),
    }


def conversation(value: Conversation) -> dict[str, object]:
    return {
        "id": value.id,
        "book_id": value.book_id,
        "title": value.title,
        "status": value.status.value,
        "created_at": iso(value.created_at),
        "updated_at": iso(value.updated_at),
        "version": value.version,
    }


def conversation_result(value: ConversationEnsureResult) -> dict[str, object]:
    return {
        "conversation": conversation(value.conversation),
        "created": value.created,
    }


def chat_error(value: ChatError | None) -> dict[str, object] | None:
    if value is None:
        return None
    return {
        "code": value.code.value,
        "message": value.message,
        "retriable": value.retriable,
        "retry_after_ms": value.retry_after_ms,
        "request_id": value.request_id,
        "details": {detail.key: list(detail.values) for detail in value.details},
    }


def effective_scope(value: EffectiveBookScope | None) -> dict[str, object] | None:
    if value is None:
        return None
    return {
        "type": value.type.value,
        "book_id": value.book_id,
        "document_part_ids": list(value.document_part_ids),
        "chapter_refs": list(value.chapter_refs),
        "source_labels": list(value.source_labels),
    }


def chat_run(value: ChatRun) -> dict[str, object]:
    return {
        "id": value.id,
        "conversation_id": value.conversation_id,
        "status": value.status.value,
        "phase": value.phase.value if value.phase is not None else None,
        "effective_scope": effective_scope(value.effective_scope),
        "attempt": value.attempt,
        "error": chat_error(value.error),
        "cancel_requested_at": iso(value.cancel_requested_at),
        "created_at": iso(value.created_at),
        "updated_at": iso(value.updated_at),
        "started_at": iso(value.started_at),
        "completed_at": iso(value.completed_at),
        "version": value.version,
    }


def chat_message(value: ChatMessage) -> dict[str, object]:
    return {
        "id": value.id,
        "conversation_id": value.conversation_id,
        "chat_run_id": value.chat_run_id,
        "role": value.role.value,
        "content": value.content,
        "created_at": iso(value.created_at),
        "updated_at": iso(value.updated_at),
        "version": value.version,
    }


def chat_reference(value: ChatReference) -> dict[str, object]:
    return {
        "id": value.id,
        "message_id": value.message_id,
        "citation_number": value.citation_number,
        "book_id": value.book_id,
        "document_part_id": value.document_part_id,
        "chapter_refs": list(value.chapter_refs),
        "label": value.label,
        "passage": value.passage,
        "location": (
            {"type": value.location.type.value, "value": value.location.value}
            if value.location is not None
            else None
        ),
    }


def chat_submission(value: ChatSubmissionResult) -> dict[str, object]:
    return {
        "user_message": chat_message(value.messages.user),
        "assistant_message": chat_message(value.messages.assistant),
        "chat_run": chat_run(value.run),
        "replayed": value.replayed,
    }


def chat_result(value: ChatRunResult) -> dict[str, object]:
    return {
        "chat_run": chat_run(value.run),
        "assistant_message": chat_message(value.assistant_message),
        "references": [chat_reference(reference) for reference in value.references],
    }


def chat_retry(value: ChatRetryResult) -> dict[str, object]:
    return {
        "chat_run": chat_run(value.run),
        "client_retry_id": value.client_retry_id,
        "replayed": value.replayed,
    }


def chat_message_page(
    page: ChatMessagePage,
    *,
    references_by_message: dict[str, tuple[ChatReference, ...]],
    active_run: ChatRun | None,
) -> dict[str, object]:
    messages: list[dict[str, object]] = []
    for message in page.messages:
        projected = chat_message(message)
        projected["references"] = [
            chat_reference(reference) for reference in references_by_message.get(message.id, ())
        ]
        messages.append(projected)
    return {
        "messages": messages,
        "active_chat_run": chat_run(active_run) if active_run is not None else None,
        "next_cursor": (
            {
                "created_at": iso(page.next_cursor.created_at),
                "message_id": page.next_cursor.message_id,
            }
            if page.next_cursor is not None
            else None
        ),
    }


def chat_run_event(value: ChatRunEvent) -> dict[str, object]:
    return {
        "id": value.id,
        "chat_run_id": value.chat_run_id,
        "run_version": value.run_version,
        "event_type": value.event_type.value,
        "status": value.status.value,
        "phase": value.phase.value if value.phase is not None else None,
        "error": chat_error(value.error),
        "created_at": iso(value.created_at),
    }
