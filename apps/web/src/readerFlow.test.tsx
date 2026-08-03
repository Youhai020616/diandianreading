/**
 * Integration: Library entry -> markdown reader -> highlights and sidebar.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { SOURCE_OFFSET_ATTRIBUTE } from "./lib/reader/selection";
import { AppController } from "./state/controller";
import {
  clearCsrfCookie,
  installFetchMock,
  jsonResponse,
  setCsrfCookie,
  type RecordedRequest,
} from "./test/mockFetch";

const SHA = "c".repeat(64);

const MARKDOWN = [
  "# 第一章",
  "",
  "这一段是正文，用来测试划线映射的准确性。",
  "",
  "# 第二章",
  "",
  "第二章的段落内容。",
  "",
].join("\n");

function cpIndexOf(source: string, needle: string): number {
  const index = source.indexOf(needle);
  if (index === -1) {
    throw new Error(`needle missing: ${needle}`);
  }
  return Array.from(source.slice(0, index)).length;
}

function cpLen(text: string): number {
  return Array.from(text).length;
}

const CHAPTER_2_CP = cpIndexOf(MARKDOWN, "# 第二章");

function bookPayload(): unknown {
  return {
    data: {
      books: [
        { id: "book-1", title: "Book One", author: "作者甲", status: "ready" },
        { id: "book-2", title: "Book Two", author: null, status: "pending" },
      ],
      next_cursor: null,
    },
  };
}

function detailPayload(): unknown {
  return {
    data: {
      book: {
        id: "book-1",
        title: "Book One",
        author: "作者甲",
        status: "ready",
        created_at: "2026-08-01T00:00:00+00:00",
        updated_at: "2026-08-01T00:00:00+00:00",
      },
      document: {
        book_id: "book-1",
        anchor_sha256: SHA,
        mime_type: "text/markdown",
        size_bytes: MARKDOWN.length,
      },
      chapters: [
        { reference: "markdown-heading-0001", title: "第一章", start: 0, end: CHAPTER_2_CP },
        {
          reference: "markdown-heading-0002",
          title: "第二章",
          start: CHAPTER_2_CP,
          end: cpLen(MARKDOWN),
        },
      ],
      progress: null,
    },
  };
}

const HIGHLIGHT_TEXT = "正文";
const HL_START = cpIndexOf(MARKDOWN, HIGHLIGHT_TEXT);

function annotationRecord(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    book_id: "book-1",
    kind: "highlight",
    status: "active",
    anchor: {
      type: "markdown_offset",
      anchor_sha256: SHA,
      start: HL_START,
      end: HL_START + 2,
      chapter_ref: "markdown-heading-0001",
      quote: { exact: HIGHLIGHT_TEXT, prefix: "这一段是", suffix: "，用来" },
    },
    selected_text: HIGHLIGHT_TEXT,
    body: null,
    color: "yellow",
    created_at: "2026-08-01T01:00:00+00:00",
    updated_at: "2026-08-01T01:00:00+00:00",
    version: 0,
    ...overrides,
  };
}

interface Harness {
  requests: RecordedRequest[];
  annotationPosts: () => RecordedRequest[];
}

const controllers: AppController[] = [];

function setupApp(annotations: Array<Record<string, unknown>>): Harness {
  setCsrfCookie("csrf-token-1");
  let postCounter = 100;

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
      return jsonResponse(200, bookPayload());
    }
    if (request.url === "/api/books/book-1" && request.method === "GET") {
      return jsonResponse(200, detailPayload());
    }
    if (request.url === "/api/books/book-1/content" && request.method === "GET") {
      return new Response(MARKDOWN, {
        status: 200,
        headers: { "Content-Type": "text/markdown; charset=utf-8", ETag: `"${SHA}"` },
      });
    }
    if (request.url.startsWith("/api/books/book-1/annotations") && request.method === "GET") {
      return jsonResponse(200, { data: { annotations, next_cursor: null } });
    }
    if (request.url === "/api/books/book-1/annotations" && request.method === "POST") {
      const body = JSON.parse(String(request.body)) as Record<string, unknown>;
      postCounter += 1;
      return jsonResponse(201, {
        data: {
          annotation: annotationRecord(`ann-created-${postCounter}`, {
            anchor: body["anchor"],
            selected_text: body["selected_text"],
            body: body["body"] ?? null,
            color: body["color"],
            created_at: "2026-08-01T02:00:00+00:00",
          }),
        },
      });
    }
    const patchMatch = /^\/api\/annotations\/([^/]+)$/u.exec(request.url);
    if (patchMatch !== null && (request.method === "PATCH" || request.method === "DELETE")) {
      const id = patchMatch[1] as string;
      const existing = annotations.find((entry) => entry["id"] === id) ?? annotationRecord(id);
      if (request.method === "DELETE") {
        return jsonResponse(200, {
          data: { annotation: { ...existing, status: "deleted", version: 1 } },
        });
      }
      const body = JSON.parse(String(request.body)) as Record<string, unknown>;
      return jsonResponse(200, {
        data: { annotation: { ...existing, ...body, version: 1 } },
      });
    }
    const restoreMatch = /^\/api\/annotations\/([^/]+)\/restore$/u.exec(request.url);
    if (restoreMatch !== null && request.method === "POST") {
      const id = restoreMatch[1] as string;
      const existing = annotations.find((entry) => entry["id"] === id) ?? annotationRecord(id);
      return jsonResponse(200, {
        data: { annotation: { ...existing, status: "active", version: 2 } },
      });
    }
    if (request.url === "/api/books/book-1/progress" && request.method === "PUT") {
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
    />,
  );

  return {
    requests,
    annotationPosts: () =>
      requests.filter(
        (request) =>
          request.url === "/api/books/book-1/annotations" && request.method === "POST",
      ),
  };
}

async function openReader(): Promise<HTMLElement> {
  const libraryNav = screen.getByRole("button", { name: /Library \/ 书库/u });
  fireEvent.click(libraryNav);
  await waitFor(() => {
    expect(document.querySelector('[data-open-book="book-1"]')).not.toBeNull();
  });
  fireEvent.click(document.querySelector('[data-open-book="book-1"]') as HTMLElement);
  await waitFor(() => {
    expect(document.getElementById("reader-content")).not.toBeNull();
  });
  return document.getElementById("reader-content") as HTMLElement;
}

afterEach(() => {
  for (const controller of controllers.splice(0)) {
    controller.dispose();
  }
  clearCsrfCookie();
  window.getSelection()?.removeAllRanges();
});

describe("library entry", () => {
  it("lists books with readable status and gates non-ready books", async () => {
    setupApp([]);
    fireEvent.click(screen.getByRole("button", { name: /Library \/ 书库/u }));
    await waitFor(() => {
      expect(screen.getByText("Book One")).toBeInTheDocument();
    });
    expect(screen.getByText("Ready / 可阅读")).toBeInTheDocument();
    expect(screen.getByText("Processing / 处理中")).toBeInTheDocument();
    const blocked = document.querySelector('[data-open-book="book-2"]') as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
  });
});

describe("markdown reader", () => {
  it("renders the parsed document with chapters and existing highlights", async () => {
    setupApp([
      annotationRecord("ann-old"),
      annotationRecord("ann-new", {
        anchor: {
          type: "markdown_offset",
          anchor_sha256: SHA,
          start: HL_START + 1,
          end: HL_START + 4,
          chapter_ref: "markdown-heading-0001",
          quote: { exact: "文，用", prefix: "", suffix: "" },
        },
        selected_text: "文，用",
        color: "blue",
        created_at: "2026-08-01T03:00:00+00:00",
      }),
      annotationRecord("ann-orphaned", {
        status: "orphaned",
        created_at: "2026-08-01T00:30:00+00:00",
      }),
      annotationRecord("ann-deleted", {
        status: "deleted",
        created_at: "2026-08-01T00:10:00+00:00",
      }),
    ]);
    const content = await openReader();

    // Chapters from the detail payload.
    const chapterButtons = Array.from(document.querySelectorAll(".chapter-button")).map(
      (button) => button.textContent,
    );
    expect(chapterButtons).toEqual(["第一章", "第二章"]);

    // Rendered markdown blocks with codepoint offsets.
    const heading = content.querySelector(".md-heading") as HTMLElement;
    expect(heading.textContent).toBe("第一章");
    expect(heading.getAttribute("data-start")).toBe("0");

    // Overlap: the later-created blue highlight owns the shared piece.
    const marks = Array.from(content.querySelectorAll("mark.reader-mark"));
    expect(marks.length).toBeGreaterThanOrEqual(2);
    const overlapPiece = marks.find(
      (mark) => mark.getAttribute("data-annotation-id") === "ann-new",
    );
    expect(overlapPiece).toBeDefined();
    const olderPieces = marks.filter(
      (mark) => mark.getAttribute("data-annotation-id") === "ann-old",
    );
    for (const piece of olderPieces) {
      expect(piece.classList.contains("hl-yellow")).toBe(true);
    }

    // The orphaned annotation is badged in the sidebar; deleted sits in its group.
    expect(screen.getByText("Orphaned / 已失锚")).toBeInTheDocument();
    expect(screen.getByText(/Deleted \/ 已删除（1）/u)).toBeInTheDocument();

    // Clicking a mark activates the matching sidebar card.
    fireEvent.click(overlapPiece as HTMLElement);
    await waitFor(() => {
      expect(
        document.querySelector('[data-annotation-card="ann-new"]')?.classList.contains(
          "is-active",
        ),
      ).toBe(true);
    });
  });

  it("creates a highlight from a DOM selection with exact offsets and quote", async () => {
    const harness = setupApp([]);
    const content = await openReader();

    const needle = "测试划线映射";
    const sourceIndex = MARKDOWN.indexOf(needle);
    const mapped = Array.from(
      content.querySelectorAll(`[${SOURCE_OFFSET_ATTRIBUTE}]`),
    ).find((element) => {
      const su = Number.parseInt(element.getAttribute(SOURCE_OFFSET_ATTRIBUTE) ?? "", 10);
      const text = element.textContent ?? "";
      return sourceIndex >= su && sourceIndex + needle.length <= su + text.length;
    }) as HTMLElement;
    const textNode = mapped.firstChild as Text;
    const su = Number.parseInt(mapped.getAttribute(SOURCE_OFFSET_ATTRIBUTE) ?? "", 10);

    const range = document.createRange();
    range.setStart(textNode, sourceIndex - su);
    range.setEnd(textNode, sourceIndex - su + needle.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.mouseUp(content);

    await waitFor(() => {
      expect(document.getElementById("selection-toolbar")).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Green highlight / 绿色划线" }));
    await waitFor(() => {
      expect(harness.annotationPosts()).toHaveLength(1);
    });

    const post = harness.annotationPosts()[0] as RecordedRequest;
    const body = JSON.parse(String(post.body)) as Record<string, unknown>;
    expect(body["kind"]).toBe("highlight");
    expect(body["color"]).toBe("green");
    expect(body["selected_text"]).toBe(needle);
    const anchor = body["anchor"] as Record<string, unknown>;
    expect(anchor["type"]).toBe("markdown_offset");
    expect(anchor["anchor_sha256"]).toBe(SHA);
    expect(anchor["start"]).toBe(cpIndexOf(MARKDOWN, needle));
    expect(anchor["end"]).toBe(cpIndexOf(MARKDOWN, needle) + cpLen(needle));
    expect(anchor["chapter_ref"]).toBe("markdown-heading-0001");
    const quote = anchor["quote"] as Record<string, unknown>;
    expect(quote["exact"]).toBe(needle);
    expect(cpLen(String(quote["prefix"]))).toBeLessThanOrEqual(64);
    expect(cpLen(String(quote["suffix"]))).toBeLessThanOrEqual(64);
    expect(String(quote["prefix"]).endsWith("用来")).toBe(true);
    expect(String(quote["suffix"]).startsWith("的准确性")).toBe(true);

    // The created highlight is rendered immediately.
    await waitFor(() => {
      expect(
        content.querySelector('mark.reader-mark[data-annotation-id^="ann-created"]'),
      ).not.toBeNull();
    });
  });

  it("creates a highlight with an attached thought through the note draft", async () => {
    const harness = setupApp([]);
    const content = await openReader();

    const mapped = content.querySelector(`[${SOURCE_OFFSET_ATTRIBUTE}]`) as HTMLElement;
    const textNode = mapped.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, Math.min(3, textNode.length));
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.mouseUp(content);
    await waitFor(() => {
      expect(document.getElementById("selection-note-button")).not.toBeNull();
    });

    fireEvent.click(document.getElementById("selection-note-button") as HTMLElement);
    const input = document.getElementById("selection-note-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "我的想法" } });
    fireEvent.click(document.getElementById("selection-note-save") as HTMLElement);

    await waitFor(() => {
      expect(harness.annotationPosts()).toHaveLength(1);
    });
    const body = JSON.parse(String(harness.annotationPosts()[0]!.body)) as Record<string, unknown>;
    expect(body["kind"]).toBe("highlight");
    expect(body["body"]).toBe("我的想法");
  });

  it("supports edit, recolor, soft delete, and restore from the sidebar", async () => {
    setupApp([annotationRecord("ann-old")]);
    await openReader();

    const card = (): HTMLElement =>
      document.querySelector('[data-annotation-card="ann-old"]') as HTMLElement;
    await waitFor(() => {
      expect(card()).not.toBeNull();
    });

    // Edit the thought.
    fireEvent.click(screen.getByRole("button", { name: "Add thought / 写想法" }));
    const editArea = document.getElementById("annotation-edit-ann-old") as HTMLTextAreaElement;
    fireEvent.change(editArea, { target: { value: "补充想法" } });
    fireEvent.click(screen.getByRole("button", { name: "Save / 保存" }));
    await waitFor(() => {
      expect(card().textContent).toContain("补充想法");
    });

    // Recolor.
    const recolor = card().querySelector('button[aria-label="Blue highlight / 蓝色划线"]');
    fireEvent.click(recolor as HTMLElement);
    await waitFor(() => {
      const currentDot = card().querySelector(".swatch-dot") as HTMLElement;
      expect(currentDot.classList.contains("swatch-blue")).toBe(true);
    });

    // Soft delete moves it into the deleted group with a restore action.
    fireEvent.click(card().querySelector('[data-annotation-delete="ann-old"]') as HTMLElement);
    await waitFor(() => {
      expect(screen.getByText(/Deleted \/ 已删除（1）/u)).toBeInTheDocument();
    });
    fireEvent.click(
      document.querySelector('[data-annotation-restore="ann-old"]') as HTMLElement,
    );
    await waitFor(() => {
      expect(card().getAttribute("data-status")).toBe("active");
    });
  });

  it("jumps back to the text from the sidebar and navigates chapters by keyboard", async () => {
    setupApp([annotationRecord("ann-old")]);
    const content = await openReader();

    await waitFor(() => {
      expect(document.querySelector('[data-annotation-jump="ann-old"]')).not.toBeNull();
    });
    fireEvent.click(document.querySelector('[data-annotation-jump="ann-old"]') as HTMLElement);
    await waitFor(() => {
      expect(
        content.querySelector('mark[data-annotation-id="ann-old"]')?.classList.contains(
          "is-active",
        ),
      ).toBe(true);
    });

    // ArrowRight on the focused reader container moves to the next chapter.
    content.focus();
    fireEvent.keyDown(content, { key: "ArrowRight" });
    await waitFor(() => {
      const active = document.querySelector(".chapter-button.is-active");
      expect(active?.textContent).toBe("第二章");
    });
    fireEvent.keyDown(content, { key: "ArrowLeft" });
    await waitFor(() => {
      const active = document.querySelector(".chapter-button.is-active");
      expect(active?.textContent).toBe("第一章");
    });
  });
});
