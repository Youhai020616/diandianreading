import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { renderReadingCardHtml } from "../electron/cards/cardTemplates";
import { exportBookToObsidian, exportDraftToObsidian } from "../electron/export/obsidianExporter";
import { importNotesIntoDatabase } from "../electron/importers/notesImporter";
import { KnowledgeDatabase } from "../electron/storage/database";

/**
 * The product's main path in one run, without Electron, accounts or a network model:
 * capture a passage → deduplicate it → draft with immutable AI/human revisions →
 * render a share card safely → export to Obsidian without overwriting manual edits.
 */
let root: string;
let vault: string;
let db: KnowledgeDatabase;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "diandian-main-path-"));
  vault = path.join(root, "vault");
  fs.mkdirSync(vault);
  db = new KnowledgeDatabase(path.join(root, "state.sqlite"));
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

it("runs capture → dedupe → revisions → card → Obsidian conflict copy end to end", () => {
  // 1. The same passage arrives twice: once from a Kindle import, once saved by hand.
  const quote = "人们总是高估一年能做的事，低估十年能做的事。<script>alert(1)</script>";
  const clippings = [
    "长期主义 (某作者)",
    "- 您在位置 #120-121的标注 | 添加于 2026年11月20日星期五 下午10:00:00",
    "",
    quote,
    "==========",
  ].join("\n");
  const imported = importNotesIntoDatabase(db, clippings, { format: "kindle" });
  expect(imported).toMatchObject({ format: "kindle", importedCount: 1, deduplicatedCount: 0 });
  const book = db.getBook(imported.bookIds[0]!)!;
  const again = db.addHighlight({ bookId: book.id, quote });
  expect(again.deduplicated).toBe(true);
  expect(db.listHighlights(book.id)).toHaveLength(1);

  // 2. An AI first draft, then a human revision: both stay in the chain, in order.
  const draft = db.createDraft({ bookId: book.id, title: "关于十年", kind: "note", authorKind: "ai", content: "AI 初稿：时间会放大选择。" });
  const revised = db.appendDraftRevision({ draftId: draft.id, authorKind: "human", content: "我的修改：时间会放大习惯。" });
  expect(revised.revisions?.map(r => [r.revisionNo, r.authorKind, r.content])).toEqual([
    [1, "ai", "AI 初稿：时间会放大选择。"],
    [2, "human", "我的修改：时间会放大习惯。"],
  ]);
  expect(revised.latestContent).toBe("我的修改：时间会放大习惯。");

  // 3. The share card escapes the imported text instead of executing it.
  const html = renderReadingCardHtml({ templateId: "editorial-paper", quote, bookTitle: book.title, author: "", tag: "读书笔记", comment: "<img src=x onerror=alert(1)>" });
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("&lt;script&gt;");

  // 4. Export, edit the note in Obsidian, export again: the edit survives and a conflict copy appears.
  const first = exportBookToObsidian(db, vault, book.id);
  expect(first.status).toBe("written");
  const notePath = path.join(vault, first.writtenRelativePath);
  fs.appendFileSync(notePath, "\n我在 Obsidian 里补充的想法\n");
  db.addHighlight({ bookId: book.id, quote: "第二条划线，促使再次导出" });
  const second = exportBookToObsidian(db, vault, book.id);
  expect(second.status).toBe("conflict");
  expect(second.writtenRelativePath.endsWith(".diandian-conflict.md")).toBe(true);
  expect(fs.readFileSync(notePath, "utf8")).toContain("我在 Obsidian 里补充的想法");
  expect(fs.readFileSync(path.join(vault, second.writtenRelativePath), "utf8")).toContain("第二条划线");

  // The draft exports its latest human revision.
  const draftExport = exportDraftToObsidian(db, vault, draft.id);
  expect(fs.readFileSync(path.join(vault, draftExport.writtenRelativePath), "utf8")).toContain("我的修改：时间会放大习惯。");
});
