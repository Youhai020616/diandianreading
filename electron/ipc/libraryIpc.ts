import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dialog } from "electron";
import { importNotesIntoDatabase } from "../importers/notesImporter";
import {
  listWeReadNotebooks,
  syncWeReadBooksIntoDatabase,
  type WeReadNotebookBook,
} from "../importers/wereadSyncService";
import { searchOnlineBookMetadata, type BookMetadataCandidate } from "../router/metadataService";
import { type BookSource } from "../storage/database";
import { state, ipc, metadataLookups, cleanPageBookTitle, requireDb } from "../appState";

export function registerLibraryIpc(): void {
  // ---------- Local SQLite Library & Notes ----------

  ipc.handle("library:list-books", (_win, query?: string) => requireDb().listBooks(query ?? ""));

  ipc.handle("library:get-book", (_win, id: string) => requireDb().getBook(id));

  ipc.handle(
    "library:create-book",
    (
      _win,
      input: {
        title: string;
        author?: string;
        isbn?: string;
        publisher?: string;
        publishedYear?: string;
        description?: string;
        tags?: string[];
        coverUrl?: string;
        source?: BookSource;
      },
    ) => requireDb().findOrCreateBook(input),
  );

  ipc.handle(
    "library:update-book",
    (
      _win,
      input: {
        id: string;
        title?: string;
        author?: string;
        isbn?: string;
        publisher?: string;
        publishedYear?: string;
        description?: string;
        tags?: string[];
        coverUrl?: string;
      },
    ) => {
      const { id, ...patch } = input;
      return requireDb().updateBook(id, patch);
    },
  );

  ipc.handle("library:delete-book", (_win, id: string) => {
    requireDb().deleteBook(id);
    return { deleted: true };
  });

  ipc.handle("library:list-highlights", (_win, input: { bookId: string; query?: string }) =>
    requireDb().listHighlights(input.bookId, input.query ?? ""),
  );

  ipc.handle("library:search-highlights", (_win, input: { query: string; limit?: number }) =>
    requireDb().searchAllHighlights(input.query ?? "", input.limit ?? 40),
  );

  ipc.handle(
    "library:add-highlight",
    (
      _win,
      input: {
        bookId: string;
        chapter?: string;
        quote: string;
        note?: string;
        source?: BookSource;
      },
    ) => requireDb().addHighlight(input),
  );

  ipc.handle("library:update-highlight-note", (_win, input: { id: string; note: string }) =>
    requireDb().updateHighlightNote(input.id, input.note),
  );

  ipc.handle("library:delete-highlight", (_win, id: string) => {
    requireDb().deleteHighlight(id);
    return { deleted: true };
  });

  ipc.handle(
    "library:import-notes-text",
    (
      _win,
      input: {
        rawText: string;
        format?: "auto" | "kindle" | "weread";
        fallbackTitle?: string;
        fallbackAuthor?: string;
      },
    ) =>
      importNotesIntoDatabase(requireDb(), input.rawText, {
        format: input.format,
        fallbackTitle: input.fallbackTitle,
        fallbackAuthor: input.fallbackAuthor,
      }),
  );

  ipc.handle(
    "library:import-notes-file",
    async (win, input?: { format?: "auto" | "kindle" | "weread"; fallbackTitle?: string }) => {
      const result = await dialog.showOpenDialog(win, {
        title: "选择 Kindle My Clippings.txt 或微信读书导出的笔记文件",
        properties: ["openFile"],
        filters: [
          { name: "文本与 Markdown 笔记", extensions: ["txt", "md", "markdown"] },
          { name: "所有文件", extensions: ["*"] },
        ],
      });
      if (result.canceled || !result.filePaths[0]) {
        return { canceled: true as const };
      }
      const filePath = result.filePaths[0];
      const rawText = fs.readFileSync(filePath, "utf8");
      const stem = path.basename(filePath, path.extname(filePath));
      const outcome = importNotesIntoDatabase(requireDb(), rawText, {
        format: input?.format ?? "auto",
        fallbackTitle: input?.fallbackTitle,
        fileTitle: stem.toLowerCase() === "my clippings" ? undefined : stem,
      });
      return { canceled: false as const, fileName: path.basename(filePath), ...outcome };
    },
  );

  ipc.handle("library:capture-from-browser", async (_win, input?: { bookId?: string; note?: string }) => {
    if (!state.browserService) throw new Error("内置浏览器未就绪");
    const snap = await state.browserService.readPageContent({ maxChars: 6000 });
    const quote = (snap.selection || "").trim() || snap.text.trim().slice(0, 600);
    if (!quote) {
      throw new Error(
        snap.likelyCanvasReader
          ? "右侧页面似乎为画布渲染，未能读取到文本。请先在页面中选中文字，或切换到微信读书「笔记/划线」页面后再采集。"
          : "右侧当前页面暂无可采集的选中文本或正文内容。",
      );
    }
    const db = requireDb();
    let book = input?.bookId ? db.getBook(input.bookId) : null;
    if (!book) {
      const source: BookSource = snap.url.includes("weread.qq.com") ? "weread" : "manual";
      book = db.findOrCreateBook({
        title: cleanPageBookTitle(snap.title),
        source,
        sourceLocator: snap.url,
      });
    }
    const added = db.addHighlight({
      bookId: book.id,
      chapter: snap.title,
      quote,
      note: input?.note ?? "",
      source: book.source,
    });
    return {
      book,
      highlight: added.record,
      deduplicated: added.deduplicated,
      usedSelection: Boolean(snap.selection.trim()),
    };
  });

  ipc.handle("library:lookup-metadata", async (win, query: string, bookId?: string) => {
    if (!bookId) return searchOnlineBookMetadata(query);
    const book = requireDb().getBook(bookId);
    if (!book) throw new Error("找不到这本书，请重新打开书库。");
    const lookup = { id: crypto.randomUUID(), bookId, candidates: [] as BookMetadataCandidate[] };
    metadataLookups.set(win, lookup);
    const result = await searchOnlineBookMetadata(query, book);
    lookup.candidates = result.candidates;
    return { ...result, lookupId: lookup.id };
  });

  ipc.handle("library:apply-metadata", async (win, bookId: string, lookupId: string, index: number) => {
    const lookup = metadataLookups.get(win);
    const edition = lookup?.candidates[index];
    if (!lookup || lookup.id !== lookupId || lookup.bookId !== bookId || !Number.isInteger(index) || !edition) {
      throw new Error("查询结果已更新，请重新查询并选择版本。");
    }
    const coverReady = edition.coverUrl ? await state.bookCovers.get(edition.coverUrl) : null;
    if (metadataLookups.get(win) !== lookup) throw new Error("查询结果已更新，请重新选择版本。");
    const db = requireDb();
    const book = db.getBook(bookId);
    if (!book) throw new Error("找不到这本书，请重新打开书库。");
    db.updateBook(bookId, {
      author: book.author || edition.author,
      isbn: edition.isbn || undefined,
      publisher: edition.publisher || undefined,
      publishedYear: edition.publishedYear || undefined,
      description: edition.description || undefined,
      coverUrl: coverReady ? edition.coverUrl : undefined,
    }, edition.title);
    metadataLookups.delete(win);
    return { coverUnavailable: Boolean(edition.coverUrl && !coverReady) };
  });

  ipc.handle("library:get-book-cover", (_win, bookId: string) => {
    const coverUrl = requireDb().getBook(bookId)?.coverUrl;
    return coverUrl ? state.bookCovers.get(coverUrl) : null;
  });

  ipc.handle("library:weread-list-notebooks", async () => {
    if (!state.browserService) throw new Error("内置浏览器未就绪");
    const cookies = await state.browserService.exportCookiesForOrigin("https://weread.qq.com");
    return listWeReadNotebooks(cookies);
  });

  ipc.handle("library:weread-sync-books", async (_win, books: WeReadNotebookBook[]) => {
    if (!state.browserService) throw new Error("内置浏览器未就绪");
    if (!Array.isArray(books) || books.length === 0) {
      throw new Error("请至少选择一本书进行同步");
    }
    const cookies = await state.browserService.exportCookiesForOrigin("https://weread.qq.com");
    return syncWeReadBooksIntoDatabase(requireDb(), cookies, books, (url) => state.bookCovers.get(url));
  });

  ipc.handle("library:random-recall", (_win, excludeId?: string) =>
    requireDb().getRandomRecallHighlight(excludeId),
  );

  ipc.handle("library:reading-stats", (_win, monthKey?: string) =>
    requireDb().getReadingStats(monthKey),
  );

  ipc.handle("library:find-related-highlights", (_win, input: { text: string; limit?: number }) =>
    requireDb().findRelatedHighlights(String(input?.text ?? ""), input?.limit ?? 4),
  );
}
