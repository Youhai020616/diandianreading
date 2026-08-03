/**
 * PDF reader behaviour against a fake engine (jsdom cannot run pdf.js):
 * page navigation, pdf_page progress anchors, page-level highlights with a
 * typed or selected quote, and the download fallback when the engine fails.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { PdfEngine } from "./lib/pdf";
import { AppController } from "./state/controller";
import {
  clearCsrfCookie,
  installFetchMock,
  jsonResponse,
  setCsrfCookie,
  type RecordedRequest,
} from "./test/mockFetch";

const SHA = "d".repeat(64);

function fakeEngine(): PdfEngine {
  return {
    open: async () => ({
      pageCount: 5,
      getPage: async (pageNumber: number) => ({
        width: 600,
        height: 800,
        render: async () => undefined,
        renderTextLayer: async (container: HTMLElement) => {
          const span = document.createElement("span");
          span.textContent = `第 ${pageNumber} 页的文字内容`;
          container.appendChild(span);
          return true;
        },
      }),
      destroy: async () => undefined,
    }),
  };
}

function failingEngine(): PdfEngine {
  return {
    open: async () => {
      throw new Error("Trusted Types rejected the worker");
    },
  };
}

function detailPayload(progressPage: number | null): unknown {
  return {
    data: {
      book: {
        id: "book-pdf",
        title: "PDF Book",
        author: null,
        status: "reading",
        created_at: "2026-08-01T00:00:00+00:00",
        updated_at: "2026-08-01T00:00:00+00:00",
      },
      document: {
        book_id: "book-pdf",
        anchor_sha256: SHA,
        mime_type: "application/pdf",
        size_bytes: 8,
      },
      chapters: [],
      progress:
        progressPage !== null
          ? {
              book_id: "book-pdf",
              anchor: {
                type: "pdf_page",
                anchor_sha256: SHA,
                start: progressPage,
                end: null,
                chapter_ref: null,
                quote: null,
              },
              percent: progressPage / 5,
              updated_at: "2026-08-01T00:00:00+00:00",
              version: 1,
            }
          : null,
    },
  };
}

interface Harness {
  requests: RecordedRequest[];
  progressPuts: () => RecordedRequest[];
  annotationPosts: () => RecordedRequest[];
}

const controllers: AppController[] = [];

function setupApp(engine: PdfEngine, progressPage: number | null): Harness {
  setCsrfCookie("csrf-token-1");
  const { requests } = installFetchMock((request) => {
    if (request.url === "/api/session") {
      return jsonResponse(200, { data: { authenticated: true, status: "active" } });
    }
    if (request.url === "/api/auth/status") {
      return jsonResponse(200, { data: { providers: {} } });
    }
    if (request.url.startsWith("/api/jobs")) {
      return jsonResponse(200, { data: { jobs: [], next_cursor: null } });
    }
    if (request.url === "/api/books?limit=100") {
      return jsonResponse(200, {
        data: {
          books: [{ id: "book-pdf", title: "PDF Book", author: null, status: "reading" }],
          next_cursor: null,
        },
      });
    }
    if (request.url === "/api/books/book-pdf" && request.method === "GET") {
      return jsonResponse(200, detailPayload(progressPage));
    }
    if (request.url === "/api/books/book-pdf/content" && request.method === "GET") {
      return new Response("PDFBYTES", {
        status: 200,
        headers: { "Content-Type": "application/pdf", ETag: `"${SHA}"` },
      });
    }
    if (request.url.startsWith("/api/books/book-pdf/annotations") && request.method === "GET") {
      return jsonResponse(200, { data: { annotations: [], next_cursor: null } });
    }
    if (request.url === "/api/books/book-pdf/annotations" && request.method === "POST") {
      const body = JSON.parse(String(request.body)) as Record<string, unknown>;
      return jsonResponse(201, {
        data: {
          annotation: {
            id: "ann-pdf-1",
            book_id: "book-pdf",
            kind: "highlight",
            status: "active",
            anchor: body["anchor"],
            selected_text: body["selected_text"],
            body: null,
            color: body["color"],
            created_at: "2026-08-01T02:00:00+00:00",
            updated_at: "2026-08-01T02:00:00+00:00",
            version: 0,
          },
        },
      });
    }
    if (request.url === "/api/books/book-pdf/progress" && request.method === "PUT") {
      return jsonResponse(200, { data: { progress: null } });
    }
    return undefined;
  });

  const controller = new AppController();
  controllers.push(controller);
  render(
    <App
      controller={controller}
      bootstrapTask={Promise.resolve({ attempted: false, ok: true, error: null })}
      pdfEngine={engine}
    />,
  );
  return {
    requests,
    progressPuts: () =>
      requests.filter(
        (request) => request.url === "/api/books/book-pdf/progress" && request.method === "PUT",
      ),
    annotationPosts: () =>
      requests.filter(
        (request) =>
          request.url === "/api/books/book-pdf/annotations" && request.method === "POST",
      ),
  };
}

async function openPdfReader(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /Library \/ 书库/u }));
  await waitFor(() => {
    expect(document.querySelector('[data-open-book="book-pdf"]')).not.toBeNull();
  });
  fireEvent.click(document.querySelector('[data-open-book="book-pdf"]') as HTMLElement);
  await waitFor(() => {
    expect(document.getElementById("reader-content")).not.toBeNull();
  });
}

afterEach(() => {
  vi.useRealTimers();
  for (const controller of controllers.splice(0)) {
    controller.dispose();
  }
  clearCsrfCookie();
});

describe("pdf reader", () => {
  it("restores the pdf_page progress and navigates pages with debounced progress", async () => {
    const harness = setupApp(fakeEngine(), 3);
    await openPdfReader();

    const pageInput = (): HTMLInputElement =>
      document.getElementById("pdf-page-input") as HTMLInputElement;
    await waitFor(() => {
      expect(pageInput().value).toBe("3");
    });
    expect(document.getElementById("pdf-page-count")?.textContent).toBe("/ 5 页");

    vi.useFakeTimers();
    fireEvent.click(document.getElementById("pdf-next-page") as HTMLElement);
    expect(pageInput().value).toBe("4");
    await vi.advanceTimersByTimeAsync(4999);
    expect(harness.progressPuts()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();

    await waitFor(() => {
      expect(harness.progressPuts()).toHaveLength(1);
    });
    const body = JSON.parse(String(harness.progressPuts()[0]!.body)) as Record<string, unknown>;
    expect(body["percent"]).toBeCloseTo(0.8);
    expect(body["anchor"]).toEqual({ type: "pdf_page", anchor_sha256: SHA, start: 4 });
  });

  it("turns pages with arrow keys on the focused reader container", async () => {
    setupApp(fakeEngine(), null);
    await openPdfReader();
    const content = document.getElementById("reader-content") as HTMLElement;
    const pageInput = (): HTMLInputElement =>
      document.getElementById("pdf-page-input") as HTMLInputElement;
    await waitFor(() => {
      expect(pageInput().value).toBe("1");
    });

    content.focus();
    fireEvent.keyDown(content, { key: "ArrowRight" });
    await waitFor(() => {
      expect(pageInput().value).toBe("2");
    });
    fireEvent.keyDown(content, { key: "ArrowLeft" });
    await waitFor(() => {
      expect(pageInput().value).toBe("1");
    });
  });

  it("creates a page-level highlight from a text-layer selection", async () => {
    const harness = setupApp(fakeEngine(), null);
    await openPdfReader();

    let layerSpan: HTMLElement | null = null;
    await waitFor(() => {
      layerSpan = document.querySelector(".pdf-text-layer span");
      expect(layerSpan).not.toBeNull();
    });
    const textNode = (layerSpan as unknown as HTMLElement).firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, textNode.length);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.mouseUp(document.querySelector(".pdf-text-layer") as HTMLElement);

    await waitFor(() => {
      expect(
        screen.getByRole("toolbar", { name: "Highlight selection / 划线所选文字" }),
      ).toBeInTheDocument();
    });
    const toolbar = screen.getByRole("toolbar", { name: "Highlight selection / 划线所选文字" });
    fireEvent.click(
      toolbar.querySelector('button[aria-label="Blue highlight / 蓝色划线"]') as HTMLElement,
    );

    await waitFor(() => {
      expect(harness.annotationPosts()).toHaveLength(1);
    });
    const body = JSON.parse(String(harness.annotationPosts()[0]!.body)) as Record<string, unknown>;
    expect(body["kind"]).toBe("highlight");
    expect(body["color"]).toBe("blue");
    expect(body["selected_text"]).toBe("第 1 页的文字内容");
    expect(body["anchor"]).toEqual({
      type: "pdf_page",
      anchor_sha256: SHA,
      start: 1,
      quote: { exact: "第 1 页的文字内容", prefix: "", suffix: "" },
    });
  });

  it("falls back to a typed quote for page-level highlights", async () => {
    const harness = setupApp(fakeEngine(), null);
    await openPdfReader();
    await waitFor(() => {
      expect(document.getElementById("pdf-manual-quote-button")).not.toBeNull();
    });

    fireEvent.click(document.getElementById("pdf-manual-quote-button") as HTMLElement);
    const input = document.getElementById("pdf-manual-quote-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "手动输入的原文引述" } });
    const form = input.closest("form") as HTMLElement;
    fireEvent.click(
      form.querySelector('button[aria-label="Yellow highlight / 黄色划线"]') as HTMLElement,
    );

    await waitFor(() => {
      expect(harness.annotationPosts()).toHaveLength(1);
    });
    const body = JSON.parse(String(harness.annotationPosts()[0]!.body)) as Record<string, unknown>;
    expect(body["selected_text"]).toBe("手动输入的原文引述");
    expect(body["anchor"]).toEqual({
      type: "pdf_page",
      anchor_sha256: SHA,
      start: 1,
      quote: { exact: "手动输入的原文引述", prefix: "", suffix: "" },
    });
  });

  it("degrades to a download prompt when the engine cannot start", async () => {
    setupApp(failingEngine(), null);
    await openPdfReader();

    await waitFor(() => {
      expect(screen.getByText(/PDF cannot be rendered inline/u)).toBeInTheDocument();
    });
    const download = screen.getByRole("link", { name: "Download PDF / 下载 PDF" });
    expect(download).toHaveAttribute("href", "/api/books/book-pdf/content");
    expect(download).toHaveAttribute("download");
    // No page controls in fallback mode.
    expect(document.getElementById("pdf-page-input")).toBeNull();
  });
});
