/**
 * Integration: creation workbench -> generate, revise, and export.
 *
 * The assertion that matters most is authorship: the AI draft and the user's
 * edit must be distinguishable in the UI, because a draft that cannot answer
 * "did I write this" is the AI-content risk the PRD names.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { AppController } from "./state/controller";
import {
  clearCsrfCookie,
  installFetchMock,
  jsonResponse,
  setCsrfCookie,
  type RecordedRequest,
} from "./test/mockFetch";

const BOOK = {
  id: "book-1",
  title: "设计心理学",
  author: "Norman",
  status: "ready",
  created_at: "2026-08-04T00:00:00+00:00",
  updated_at: "2026-08-04T00:00:00+00:00",
};

const ASSET = {
  id: "content-1",
  book_id: "book-1",
  content_type: "reading_report",
  status: "draft",
  language: "zh-CN",
  tone: "rational",
  length: "medium",
  target_platform: null,
  require_citations: true,
  first_person: false,
  sources: [{ kind: "book", reference: "book-1" }],
  latest_revision_number: 1,
};

const AI_REVISION = {
  id: "revision-1",
  content_id: "content-1",
  revision_number: 1,
  author_kind: "ai",
  title: "模型写的标题",
  body: "模型写的正文。",
  created_at: "2026-08-04T00:00:00+00:00",
};

const HUMAN_REVISION = {
  ...AI_REVISION,
  id: "revision-2",
  revision_number: 2,
  author_kind: "human",
  title: "我改的标题",
  body: "我改的正文。",
};

const VAULT = { id: "vault-1", name: "My Vault", root_path: "/Users/me/Vault" };

interface Options {
  revisions?: unknown[];
  exports?: unknown[];
  vault?: typeof VAULT | null;
  vaultError?: string;
}

function installWorkbenchApi(options: Options = {}): { requests: RecordedRequest[] } {
  let revisions = options.revisions ?? [AI_REVISION];
  let vault = options.vault ?? null;
  return installFetchMock((request) => {
    const url = new URL(request.url, "http://localhost:3000");
    const path = url.pathname;
    if (path === "/api/session/status") {
      return jsonResponse(200, { data: { authenticated: true, csrf: "token" } });
    }
    if (path === "/api/books" && request.method === "GET") {
      return jsonResponse(200, { data: { books: [BOOK], next_cursor: null } });
    }
    if (path === "/api/jobs") {
      return jsonResponse(200, { data: { jobs: [], next_cursor: null } });
    }
    if (path === "/api/connections" || path === "/api/providers") {
      return jsonResponse(200, { data: { providers: [] } });
    }
    if (path === "/api/books/book-1/contents") {
      return jsonResponse(200, { data: { contents: [ASSET] } });
    }
    if (path === "/api/obsidian/vault" && request.method === "GET") {
      return jsonResponse(200, { data: { vault } });
    }
    if (path === "/api/obsidian/vault" && request.method === "PUT") {
      if (options.vaultError !== undefined) {
        return jsonResponse(422, {
          error: { code: "VALIDATION", message: options.vaultError },
        });
      }
      vault = VAULT;
      return jsonResponse(200, { data: { vault } });
    }
    if (path === "/api/books/book-1/generate-content") {
      return jsonResponse(202, {
        data: { job_id: "content-1", content: ASSET, status_url: "/api/contents/content-1" },
      });
    }
    if (path === "/api/contents/content-1" && request.method === "GET") {
      return jsonResponse(200, { data: { content: ASSET, revisions } });
    }
    if (path === "/api/contents/content-1/revisions") {
      revisions = [AI_REVISION, HUMAN_REVISION];
      return jsonResponse(201, { data: { content: { ...ASSET, status: "editing" } } });
    }
    if (path === "/api/books/book-1/obsidian-export") {
      return jsonResponse(200, {
        data: {
          exports: options.exports ?? [
            {
              target_kind: "notes",
              outcome: "conflict",
              relative_path: "Books/设计心理学/Notes.md",
              deep_link: "obsidian://open?vault=v&file=x",
              conflict_path: "Books/设计心理学/Notes.diandian-conflict.md",
            },
          ],
          conflicts: [],
        },
      });
    }
    return jsonResponse(200, { data: {} });
  });
}

async function openWorkbench(): Promise<void> {
  const { container } = render(
    <App
      controller={new AppController()}
      bootstrapTask={Promise.resolve({ attempted: false, ok: true, error: null })}
    />,
  );
  const navButton = await waitFor(() => {
    const found = container.querySelector<HTMLButtonElement>('[data-view="workbench"]');
    expect(found).toBeTruthy();
    return found as HTMLButtonElement;
  });
  fireEvent.click(navButton);
  await waitFor(() => expect(screen.getByLabelText("来源书籍")).toBeVisible());
  fireEvent.change(screen.getByLabelText("来源书籍"), { target: { value: "book-1" } });
}

describe("creation workbench", () => {
  afterEach(() => {
    clearCsrfCookie();
  });

  it("submits a generation request with the chosen parameters", async () => {
    setCsrfCookie("token");
    const { requests } = installWorkbenchApi();
    await openWorkbench();

    fireEvent.change(screen.getByLabelText("内容类型"), { target: { value: "short_post" } });
    fireEvent.change(screen.getByLabelText("语气"), { target: { value: "concise" } });
    fireEvent.click(screen.getByText("生成 / Generate"));

    await waitFor(() => {
      const submitted = requests.find(
        (item) => item.url.includes("/generate-content") && item.method === "POST",
      );
      expect(submitted).toBeTruthy();
      const body = JSON.parse(String(submitted?.body ?? "{}"));
      expect(body.content_type).toBe("short_post");
      expect(body.tone).toBe("concise");
      expect(body.require_citations).toBe(true);
    });
  });

  it("distinguishes the AI draft from the user's edit", async () => {
    setCsrfCookie("token");
    installWorkbenchApi();
    await openWorkbench();

    await waitFor(() => expect(screen.getByLabelText("内容列表")).toBeInTheDocument());
    fireEvent.click(screen.getByText(/reading_report/));

    await waitFor(() => expect(screen.getByText("当前查看：AI 原始稿")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("正文"), { target: { value: "我改的正文。" } });
    fireEvent.click(screen.getByText("保存为新修订"));

    await waitFor(() =>
      expect(screen.getByText("第 2 版 · 我的修改稿")).toBeInTheDocument(),
    );
    // The model's original is still listed, not replaced.
    expect(screen.getByText("第 1 版 · AI 原始稿")).toBeInTheDocument();
  });

  it("keeps the AI draft readable after switching revisions", async () => {
    setCsrfCookie("token");
    installWorkbenchApi({ revisions: [AI_REVISION, HUMAN_REVISION] });
    await openWorkbench();

    await waitFor(() => expect(screen.getByLabelText("内容列表")).toBeInTheDocument());
    fireEvent.click(screen.getByText(/reading_report/));
    await waitFor(() => expect(screen.getByText("当前查看：我的修改稿")).toBeInTheDocument());

    fireEvent.click(screen.getByText("第 1 版 · AI 原始稿"));
    await waitFor(() => expect(screen.getByText("当前查看：AI 原始稿")).toBeInTheDocument());
    expect(screen.getByLabelText("正文")).toHaveValue("模型写的正文。");
  });

  it("reports an export conflict instead of claiming success", async () => {
    setCsrfCookie("token");
    installWorkbenchApi({ vault: VAULT });
    await openWorkbench();
    await waitFor(() =>
      expect(screen.getByTestId("workbench-vault-state")).toHaveTextContent(
        "/Users/me/Vault",
      ),
    );

    fireEvent.click(screen.getByText("导出到 Obsidian"));

    await waitFor(() =>
      expect(screen.getByTestId("workbench-status")).toHaveTextContent(
        "已写入冲突文件而不是覆盖",
      ),
    );
    const list = screen.getByLabelText("导出结果");
    expect(list).toHaveTextContent("Notes.diandian-conflict.md");
  });

  it("configures the export vault from the workbench", async () => {
    setCsrfCookie("token");
    const { requests } = installWorkbenchApi();
    await openWorkbench();

    fireEvent.change(screen.getByLabelText("Vault 名称"), {
      target: { value: "My Vault" },
    });
    fireEvent.change(screen.getByLabelText("Vault 根目录（绝对路径）"), {
      target: { value: "/Users/me/Vault" },
    });
    fireEvent.click(screen.getByText("保存 Vault"));

    await waitFor(() => {
      const saved = requests.find(
        (item) => item.url.includes("/api/obsidian/vault") && item.method === "PUT",
      );
      expect(saved).toBeTruthy();
      expect(JSON.parse(String(saved?.body ?? "{}"))).toEqual({
        name: "My Vault",
        root_path: "/Users/me/Vault",
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId("workbench-vault-state")).toHaveTextContent(
        "/Users/me/Vault",
      ),
    );
  });

  // An export that silently does nothing is worse than a refusal: the user
  // would believe their notes reached the vault.
  it("refuses to export before a vault is configured", async () => {
    setCsrfCookie("token");
    const { requests } = installWorkbenchApi();
    await openWorkbench();
    await waitFor(() =>
      expect(screen.getByTestId("workbench-vault-state")).toHaveTextContent("尚未配置"),
    );

    fireEvent.click(screen.getByText("导出到 Obsidian"));

    await waitFor(() =>
      expect(screen.getByTestId("workbench-status")).toHaveTextContent(
        "尚未配置 Obsidian Vault",
      ),
    );
    expect(requests.some((item) => item.url.includes("obsidian-export"))).toBe(false);
  });

  it("shows the local rule that rejected a vault path", async () => {
    setCsrfCookie("token");
    installWorkbenchApi({ vaultError: "Vault path must be absolute" });
    await openWorkbench();

    fireEvent.change(screen.getByLabelText("Vault 根目录（绝对路径）"), {
      target: { value: "relative/path" },
    });
    fireEvent.click(screen.getByText("保存 Vault"));

    await waitFor(() =>
      expect(screen.getByTestId("workbench-status")).toHaveTextContent(
        "Vault path must be absolute",
      ),
    );
  });

  it("refuses to generate without a book", async () => {
    setCsrfCookie("token");
    installWorkbenchApi();
    const { container } = render(
    <App
      controller={new AppController()}
      bootstrapTask={Promise.resolve({ attempted: false, ok: true, error: null })}
    />,
  );
    const navButton = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>('[data-view="workbench"]');
      expect(found).toBeTruthy();
      return found as HTMLButtonElement;
    });
    fireEvent.click(navButton);

    fireEvent.click(screen.getByText("生成 / Generate"));
    await waitFor(() =>
      expect(screen.getByTestId("workbench-status")).toHaveTextContent("请先选择一本书"),
    );
  });
});
