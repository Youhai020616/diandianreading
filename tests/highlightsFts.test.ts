import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { KnowledgeDatabase } from "../electron/storage/database";

let dir: string;
let file: string;
let db: KnowledgeDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "diandian-fts-"));
  file = path.join(dir, "notes.sqlite");
  db = new KnowledgeDatabase(file);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** What the search index holds, read through a separate connection. */
function indexed(): Array<{ highlight_id: string; quote: string; note: string; book_title: string }> {
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    return raw.prepare("SELECT highlight_id, quote, note, book_title FROM highlights_fts ORDER BY highlight_id").all() as never;
  } finally {
    raw.close();
  }
}

function matches(term: string): string[] {
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    return (raw.prepare("SELECT highlight_id FROM highlights_fts WHERE highlights_fts MATCH ?").all(`"${term}"`) as Array<{ highlight_id: string }>)
      .map(row => row.highlight_id);
  } finally {
    raw.close();
  }
}

it("indexes inserts, note edits, deletions and book renames without manual syncing", () => {
  const book = db.findOrCreateBook({ title: "悉达多" });
  const a = db.addHighlight({ bookId: book.id, quote: "智慧是无法言传的", note: "旧的想法" }).record;
  const b = db.addHighlight({ bookId: book.id, quote: "河流从不停歇地流淌" }).record;
  expect(indexed().map(row => row.highlight_id).sort()).toEqual([a.id, b.id].sort());

  db.updateHighlightNote(a.id, "新的批注内容");
  expect(matches("新的批注")).toEqual([a.id]);
  expect(matches("旧的想法")).toEqual([]);

  db.updateBook(book.id, { title: "悉达多（新译本）" });
  expect(new Set(indexed().map(row => row.book_title))).toEqual(new Set(["悉达多（新译本）"]));
  expect(matches("新译本").sort()).toEqual([a.id, b.id].sort());

  db.deleteHighlight(b.id);
  expect(indexed().map(row => row.highlight_id)).toEqual([a.id]);

  db.deleteBook(book.id);
  expect(indexed()).toEqual([]);
});

it("repairs an index that drifted while the app was closed", () => {
  const book = db.findOrCreateBook({ title: "瓦尔登湖" });
  const kept = db.addHighlight({ bookId: book.id, quote: "我愿意深深地扎入生活" }).record;
  db.close();
  const raw = new DatabaseSync(file);
  raw.exec("DELETE FROM highlights_fts");
  raw.close();
  db = new KnowledgeDatabase(file);
  expect(indexed().map(row => row.highlight_id)).toEqual([kept.id]);
});

it("rebuilds an index created before the triggers, including stale book titles", () => {
  const book = db.findOrCreateBook({ title: "旧书名" });
  const mark = db.addHighlight({ bookId: book.id, quote: "一段需要检索的原文" }).record;
  db.close();
  // Simulate an older database: no triggers, a stale title in the index, no schema marker.
  const raw = new DatabaseSync(file);
  for (const name of ["highlights_fts_after_insert", "highlights_fts_after_update", "highlights_fts_after_delete", "books_title_fts_after_update"]) {
    raw.exec(`DROP TRIGGER IF EXISTS ${name}`);
  }
  raw.prepare("UPDATE books SET title = '新书名' WHERE id = ?").run(book.id);
  raw.prepare("DELETE FROM app_kv WHERE key = 'schema.highlights-fts-triggers.v1'").run();
  raw.close();
  db = new KnowledgeDatabase(file);
  expect(indexed()).toEqual([{ highlight_id: mark.id, quote: "一段需要检索的原文", note: "", book_title: "新书名" }]);
});
