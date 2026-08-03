/**
 * Typed client for the R1/R2 reading and annotation endpoints. The HTTP
 * contract (paths, methods, field names) is frozen; see
 * `src/diandianreading/interfaces/web/app.py` and `serializers.py`.
 */
import { apiRequest, safeApiUrl } from "../api";
import { ApiError } from "../errors";
import {
  annotationEnvelope,
  normalizeAnnotationPage,
  normalizeBookDetail,
  progressEnvelope,
  type AnnotationColorValue,
  type AnnotationView,
  type BookDetail,
  type ProgressView,
} from "./model";

export interface AnchorPayload {
  type: "markdown_offset" | "pdf_page";
  anchor_sha256: string;
  start?: number;
  end?: number;
  chapter_ref?: string;
  quote?: { exact: string; prefix: string; suffix: string };
}

export async function getBookDetail(bookId: string): Promise<BookDetail> {
  const payload = await apiRequest(`/api/books/${encodeURIComponent(bookId)}`);
  const detail = normalizeBookDetail(payload);
  if (detail === null) {
    throw new ApiError(200, "INVALID_RESPONSE", null);
  }
  return detail;
}

interface ContentFetchInit {
  headers: Record<string, string>;
}

async function fetchContent(bookId: string, init: ContentFetchInit): Promise<Response> {
  const url = safeApiUrl(`/api/books/${encodeURIComponent(bookId)}/content`);
  let response: Response;
  try {
    response = await fetch(url.pathname + url.search, {
      method: "GET",
      headers: init.headers,
      credentials: "include",
      mode: "same-origin",
      // The browser HTTP cache is bypassed deliberately: revalidation is the
      // explicit If-None-Match handshake below, so cache behaviour is
      // observable and testable instead of implicit.
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  } catch {
    throw new ApiError(0, "NETWORK_UNAVAILABLE", null);
  }
  if (response.status !== 200 && response.status !== 304) {
    throw new ApiError(response.status, null, null);
  }
  return response;
}

export type TextContentResult =
  | { kind: "fresh"; text: string; etag: string }
  | { kind: "not_modified" };

/**
 * Fetch the derived markdown. When `cachedEtag` (a bare anchor_sha256) is
 * provided the request carries `If-None-Match: "<sha>"` and a 304 answer maps
 * to `not_modified` so the caller reuses its cached text.
 */
export async function getBookContentText(
  bookId: string,
  cachedEtag: string | null,
): Promise<TextContentResult> {
  const headers: Record<string, string> = { Accept: "text/markdown" };
  if (cachedEtag !== null && cachedEtag.length > 0) {
    headers["If-None-Match"] = `"${cachedEtag}"`;
  }
  const response = await fetchContent(bookId, { headers });
  if (response.status === 304) {
    return { kind: "not_modified" };
  }
  const text = await response.text();
  return { kind: "fresh", text, etag: bareEtag(response.headers.get("ETag")) };
}

export interface BytesContentResult {
  bytes: ArrayBuffer;
  etag: string;
}

export async function getBookContentBytes(bookId: string): Promise<BytesContentResult> {
  const response = await fetchContent(bookId, { headers: { Accept: "application/pdf" } });
  const bytes = await response.arrayBuffer();
  return { bytes, etag: bareEtag(response.headers.get("ETag")) };
}

function bareEtag(header: string | null): string {
  if (header === null) {
    return "";
  }
  return header.replace(/^W\//u, "").replace(/^"|"$/gu, "");
}

export async function putProgress(
  bookId: string,
  anchor: AnchorPayload,
  percent: number,
): Promise<ProgressView | null> {
  const payload = await apiRequest(`/api/books/${encodeURIComponent(bookId)}/progress`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ anchor, percent }),
  });
  return progressEnvelope(payload);
}

const ANNOTATION_PAGE_LIMIT = 100;
const ANNOTATION_MAX_PAGES = 20;

export async function listAnnotations(bookId: string): Promise<AnnotationView[]> {
  const collected: AnnotationView[] = [];
  let cursor: { createdAt: string; id: string } | null = null;
  for (let pageIndex = 0; pageIndex < ANNOTATION_MAX_PAGES; pageIndex += 1) {
    const query = new URLSearchParams({
      status: "active,orphaned,deleted",
      limit: String(ANNOTATION_PAGE_LIMIT),
    });
    if (cursor !== null) {
      query.set("before_created_at", cursor.createdAt);
      query.set("before_id", cursor.id);
    }
    const payload = await apiRequest(
      `/api/books/${encodeURIComponent(bookId)}/annotations?${query.toString()}`,
    );
    const page = normalizeAnnotationPage(payload);
    collected.push(...page.annotations);
    if (page.nextCursor === null) {
      break;
    }
    cursor = page.nextCursor;
  }
  return collected;
}

export interface HighlightCreation {
  anchor: AnchorPayload;
  selectedText: string;
  color: AnnotationColorValue;
  body: string | null;
}

export async function createHighlight(
  bookId: string,
  creation: HighlightCreation,
): Promise<AnnotationView | null> {
  const body: Record<string, unknown> = {
    kind: "highlight",
    anchor: creation.anchor,
    selected_text: creation.selectedText,
    color: creation.color,
  };
  if (creation.body !== null && creation.body.length > 0) {
    body["body"] = creation.body;
  }
  const payload = await apiRequest(`/api/books/${encodeURIComponent(bookId)}/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return annotationEnvelope(payload);
}

export interface AnnotationEdit {
  body?: string | null;
  color?: AnnotationColorValue;
}

export async function editAnnotation(
  annotationId: string,
  edit: AnnotationEdit,
): Promise<AnnotationView | null> {
  const body: Record<string, unknown> = {};
  if ("body" in edit) {
    body["body"] = edit.body ?? null;
  }
  if (edit.color !== undefined) {
    body["color"] = edit.color;
  }
  const payload = await apiRequest(`/api/annotations/${encodeURIComponent(annotationId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return annotationEnvelope(payload);
}

export async function deleteAnnotation(annotationId: string): Promise<AnnotationView | null> {
  const payload = await apiRequest(`/api/annotations/${encodeURIComponent(annotationId)}`, {
    method: "DELETE",
  });
  return annotationEnvelope(payload);
}

export async function restoreAnnotation(annotationId: string): Promise<AnnotationView | null> {
  const payload = await apiRequest(
    `/api/annotations/${encodeURIComponent(annotationId)}/restore`,
    { method: "POST" },
  );
  return annotationEnvelope(payload);
}
