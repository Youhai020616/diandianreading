/**
 * ReaderController behaviour contracts: >=5s progress debounce with a single
 * silent retry after 409, and explicit If-None-Match content revalidation.
 */
import { waitFor } from "@testing-library/dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCsrfCookie,
  installFetchMock,
  jsonResponse,
  setCsrfCookie,
  type RecordedRequest,
} from "../test/mockFetch";
import type { BookSnapshot } from "../lib/types";
import { ReaderController } from "./readerController";

const SHA_1 = "a".repeat(64);
const SHA_2 = "b".repeat(64);
const BOOK: BookSnapshot = { id: "book-1", title: "Book One", author: "", status: "ready" };

const MARKDOWN_V1 = "# 章一\n\n第一段正文内容。\n\n# 章二\n\n第二段正文内容。\n";
const MARKDOWN_V2 = "# 新章一\n\n改版后的正文内容。\n";

function cpLen(text: string): number {
  return Array.from(text).length;
}

function detailPayload(sha: string, markdown: string): unknown {
  return {
    data: {
      book: {
        id: BOOK.id,
        title: BOOK.title,
        author: null,
        status: "ready",
        created_at: "2026-08-01T00:00:00+00:00",
        updated_at: "2026-08-01T00:00:00+00:00",
      },
      document: {
        book_id: BOOK.id,
        anchor_sha256: sha,
        mime_type: "text/markdown",
        size_bytes: markdown.length,
      },
      chapters: [
        { reference: "markdown-heading-0001", title: "章一", start: 0, end: cpLen(markdown) },
      ],
      progress: null,
    },
  };
}

function markdownResponse(text: string, sha: string): Response {
  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "text/markdown; charset=utf-8", ETag: `"${sha}"` },
  });
}

function emptyAnnotations(): Response {
  return jsonResponse(200, { data: { annotations: [], next_cursor: null } });
}

interface Harness {
  reader: ReaderController;
  requests: RecordedRequest[];
  putResponses: Array<() => Response>;
  contentRequests: () => RecordedRequest[];
  putRequests: () => RecordedRequest[];
}

const disposers: Array<() => void> = [];

function setup(options?: { conflictThenNewDocument?: boolean }): Harness {
  setCsrfCookie("csrf-token-1");
  const putResponses: Array<() => Response> = [];
  let sha = SHA_1;
  let markdown = MARKDOWN_V1;

  const { requests } = installFetchMock((request) => {
    if (request.url === `/api/books/${BOOK.id}` && request.method === "GET") {
      return jsonResponse(200, detailPayload(sha, markdown));
    }
    if (request.url === `/api/books/${BOOK.id}/content` && request.method === "GET") {
      const conditional = request.headers.get("If-None-Match");
      if (conditional === `"${sha}"`) {
        return new Response(null, { status: 304, headers: { ETag: `"${sha}"` } });
      }
      return markdownResponse(markdown, sha);
    }
    if (request.url.startsWith(`/api/books/${BOOK.id}/annotations`) && request.method === "GET") {
      return emptyAnnotations();
    }
    if (request.url === `/api/books/${BOOK.id}/progress` && request.method === "PUT") {
      const next = putResponses.shift();
      if (next !== undefined) {
        const response = next();
        if (response.status === 409 && options?.conflictThenNewDocument === true) {
          sha = SHA_2;
          markdown = MARKDOWN_V2;
        }
        return response;
      }
      return jsonResponse(200, { data: { progress: null } });
    }
    return undefined;
  });

  const reader = new ReaderController();
  disposers.push(() => reader.dispose());
  return {
    reader,
    requests,
    putResponses,
    contentRequests: () =>
      requests.filter(
        (request) => request.url === `/api/books/${BOOK.id}/content` && request.method === "GET",
      ),
    putRequests: () =>
      requests.filter(
        (request) => request.url === `/api/books/${BOOK.id}/progress` && request.method === "PUT",
      ),
  };
}

async function openAndAwaitReady(reader: ReaderController): Promise<void> {
  reader.openBook(BOOK);
  await waitFor(() => {
    expect(reader.store.getState().status).toBe("ready");
  });
}

afterEach(() => {
  vi.useRealTimers();
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  clearCsrfCookie();
});

describe("progress debounce", () => {
  it("coalesces reports into one PUT after 5 seconds with the latest position", async () => {
    const harness = setup();
    await openAndAwaitReady(harness.reader);

    vi.useFakeTimers();
    harness.reader.reportMarkdownPosition(2, 0.1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(harness.putRequests()).toHaveLength(0);

    harness.reader.reportMarkdownPosition(7, 0.5);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await waitFor(() => {
      expect(harness.putRequests()).toHaveLength(1);
    });

    const put = harness.putRequests()[0] as RecordedRequest;
    expect(put.headers.get("X-CSRF-Token")).toBe("csrf-token-1");
    const body = JSON.parse(String(put.body)) as {
      anchor: Record<string, unknown>;
      percent: number;
    };
    expect(body.percent).toBe(0.5);
    expect(body.anchor).toEqual({
      type: "markdown_offset",
      anchor_sha256: SHA_1,
      start: 7,
      end: 7,
      chapter_ref: "markdown-heading-0001",
    });
  });

  it("does not fire more than one PUT per debounce window", async () => {
    const harness = setup();
    await openAndAwaitReady(harness.reader);

    vi.useFakeTimers();
    for (let step = 0; step < 20; step += 1) {
      harness.reader.reportMarkdownPosition(step, step / 20);
      await vi.advanceTimersByTimeAsync(200);
    }
    // 4s elapsed: still nothing.
    expect(harness.putRequests()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    await waitFor(() => {
      expect(harness.putRequests()).toHaveLength(1);
    });
  });
});

describe("progress 409 retry", () => {
  it("silently refreshes the document and retries exactly once with the new sha", async () => {
    const harness = setup({ conflictThenNewDocument: true });
    harness.putResponses.push(() =>
      jsonResponse(409, {
        error: { code: "REPOSITORY_CONFLICT", message: "stale anchor" },
      }),
    );
    await openAndAwaitReady(harness.reader);

    vi.useFakeTimers();
    harness.reader.reportMarkdownPosition(9999, 0.9);
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();

    await waitFor(() => {
      expect(harness.putRequests()).toHaveLength(2);
    });

    const retry = harness.putRequests()[1] as RecordedRequest;
    const body = JSON.parse(String(retry.body)) as { anchor: Record<string, unknown> };
    expect(body.anchor["anchor_sha256"]).toBe(SHA_2);
    // The caret was clamped into the refreshed (shorter) document.
    expect(body.anchor["start"]).toBe(cpLen(MARKDOWN_V2));

    // The refresh replaced the rendered document without surfacing an error.
    const state = harness.reader.store.getState();
    expect(state.status).toBe("ready");
    expect(state.errorText).toBeNull();
    expect(state.doc?.source).toBe(MARKDOWN_V2);
    expect(state.detail?.document.anchorSha256).toBe(SHA_2);
  });

  it("gives up silently when the retry conflicts again", async () => {
    const harness = setup();
    harness.putResponses.push(() =>
      jsonResponse(409, { error: { code: "REPOSITORY_CONFLICT", message: "conflict" } }),
    );
    harness.putResponses.push(() =>
      jsonResponse(409, { error: { code: "REPOSITORY_CONFLICT", message: "conflict" } }),
    );
    await openAndAwaitReady(harness.reader);

    vi.useFakeTimers();
    harness.reader.reportMarkdownPosition(3, 0.3);
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();

    await waitFor(() => {
      expect(harness.putRequests()).toHaveLength(2);
    });
    const state = harness.reader.store.getState();
    expect(state.status).toBe("ready");
    expect(state.errorText).toBeNull();
  });
});

describe("content ETag revalidation", () => {
  it("sends If-None-Match on reopen and reuses the cached text on 304", async () => {
    const harness = setup();
    await openAndAwaitReady(harness.reader);

    const first = harness.contentRequests()[0] as RecordedRequest;
    expect(first.headers.get("If-None-Match")).toBeNull();

    harness.reader.closeBook();
    await openAndAwaitReady(harness.reader);

    const second = harness.contentRequests()[1] as RecordedRequest;
    expect(second.headers.get("If-None-Match")).toBe(`"${SHA_1}"`);
    expect(harness.reader.store.getState().doc?.source).toBe(MARKDOWN_V1);
  });
});
