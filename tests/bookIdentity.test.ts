import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { importNotesIntoDatabase } from "../electron/importers/notesImporter";
import { computeHighlightFingerprint, KnowledgeDatabase } from "../electron/storage/database";

const files: string[] = [];
const open: KnowledgeDatabase[] = [];
const title = "克林索尔的最后夏天";
const editionTitle = title + "（果麦经典）";
const author = "赫尔曼·黑塞";
const locator = "https://weread.qq.com/web/reader/24941";

function create(file?: string) {
  if (!file) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diandian-identity-"));
    files.push(dir);
    file = path.join(dir, "books.db");
  }
  const db = new KnowledgeDatabase(file);
  open.push(db);
  return db;
}

afterEach(() => {
  while (open.length) open.pop()!.close();
  while (files.length) fs.rmSync(files.pop()!, { recursive: true, force: true });
});

function clipping(name: string, writer: string, quote: string) {
  return [writer ? `${name} (${writer})` : name, "- Your Highlight on page 1", "", quote, "==========", ""].join("\n");
}

it("keeps both titles attached to the same book across restarts and reimports", () => {
  const db = create();
  const original = clipping(title, author, "旧划线");
  const id = importNotesIntoDatabase(db, original).bookIds[0]!;
  const old = db.listHighlights(id)[0]!;
  db.updateBook(id, { coverUrl: "https://example.com/cover.jpg" }, editionTitle);
  const file = db.dbPath;
  open.pop()!.close();
  const reopened = create(file);

  for (const name of [title, editionTitle]) {
    const text = clipping(name, author, "旧划线") + clipping(name, author, "新划线");
    const outcome = importNotesIntoDatabase(reopened, text);
    expect(outcome.bookIds).toEqual([id]);
  }
  expect(reopened.listBooks()).toHaveLength(1);
  expect(reopened.getBook(id)).toMatchObject({ title, highlightCount: 2, coverUrl: "https://example.com/cover.jpg" });
  expect(reopened.listHighlights(id).map(h => h.id)).toContain(old.id);
});

it("uses platform IDs across renames and separates two explicit WeRead editions and ISBNs", () => {
  const db = create();
  const manual = db.findOrCreateBook({ title, author });
  const first = db.findOrCreateBook({ title, author, sourceLocator: locator, isbn: "9780743273565" });
  expect(first.id).toBe(manual.id);
  db.updateBook(first.id, { title: editionTitle });
  expect(db.findOrCreateBook({ title: "书源也改了标题", sourceLocator: locator + "?chapter=1#anchor" }).id).toBe(first.id);
  expect(db.findOrCreateBook({ title: "另一种标题写法", isbn: "0-7432-7356-7" }).id).toBe(first.id);

  const second = db.findOrCreateBook({ title, author, sourceLocator: locator + "2", isbn: "9780306406157" });
  expect(second.id).not.toBe(first.id);
  expect(db.findOrCreateBook({ title, author, sourceLocator: locator + "2" }).id).toBe(second.id);
  expect(() => db.findOrCreateBook({ title, author })).toThrow("多个版本");
  expect(db.listBooks()).toHaveLength(2);
});

it("separates same-title authors and identical quotes within one Kindle file, and rolls back an ambiguous batch", () => {
  const db = create();
  const text = clipping("原则", "作者甲", "相同原文") + clipping("原则", "作者乙", "相同原文");
  const result = importNotesIntoDatabase(db, text);
  expect(result.importedCount).toBe(2);
  expect(result.booksTouched).toBe(2);
  expect(importNotesIntoDatabase(db, text).deduplicatedCount).toBe(2);
  expect(db.listBooks().map(b => b.highlightCount)).toEqual([1, 1]);
  const ambiguous = clipping("另一部书", "作者甲", "不应留下部分导入") + clipping("原则", "", "未提供作者");
  expect(() => importNotesIntoDatabase(db, ambiguous)).toThrow("多个版本");
  expect(db.listBooks()).toHaveLength(2);
});

it("migrates an already renamed library and duplicate old highlights without losing their IDs", () => {
  const db = create();
  const book = db.findOrCreateBook({ title: editionTitle, author: "[德]" + author });
  const hl = db.addHighlight({ bookId: book.id, quote: "旧摘录" }).record;
  const file = db.dbPath;
  open.pop()!.close();

  const old = new DatabaseSync(file);
  try {
    old.exec("DROP TABLE book_identity; DELETE FROM app_kv WHERE key = 'schema.book-identity.v1'");
    old.prepare("UPDATE highlights SET fingerprint = ? WHERE id = ?")
      .run(computeHighlightFingerprint(title, hl.quote, ""), hl.id);
    // Before the fix, the title change alone could create a second ID for the exact same quote.
    old.prepare(`INSERT INTO highlights(id, book_id, quote, fingerprint, created_at) VALUES (?,?,?,?,?)`)
      .run("legacy-duplicate", book.id, hl.quote, computeHighlightFingerprint(editionTitle, hl.quote, ""), hl.createdAt);
  } finally {
    old.close();
  }

  const upgraded = create(file);
  expect(importNotesIntoDatabase(upgraded, clipping(title, author, "旧摘录") + clipping(title, author, "新摘录")))
    .toMatchObject({ importedCount: 1, deduplicatedCount: 1, bookIds: [book.id] });
  expect(upgraded.getBook(book.id)?.highlightCount).toBe(3);
  expect(upgraded.listHighlights(book.id).map(h => h.id)).toEqual(expect.arrayContaining([hl.id, "legacy-duplicate"]));
  expect(upgraded.listBooks()).toHaveLength(1);
});

it("uses an exported book title across file and paste imports, and a filename only for untitled notes", () => {
  const db = create();
  const file = { fileTitle: "微信摘录-11月" };
  const text = [title, author, "1个笔记", "◆ 第一章", ">> 书摘"].join("\n");
  const id = importNotesIntoDatabase(db, text, file).bookIds[0]!;
  db.updateBook(id, { title: editionTitle });
  expect(importNotesIntoDatabase(db, "# " + text).bookIds).toEqual([id]);
  expect(db.getBook(id)?.highlightCount).toBe(1);
  const unnamed = importNotesIntoDatabase(db, "◆ 第一章\n>> 另一条摘录", file);
  expect(db.getBook(unnamed.bookIds[0]!)?.title).toBe(file.fileTitle);
});
