import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectAndParseNotes,
  importNotesIntoDatabase,
  kindleLocationLabel,
  parseKindleClippings,
  parseWeReadNotes,
} from "../electron/importers/notesImporter";
import { KnowledgeDatabase } from "../electron/storage/database";

const tempDirs: string[] = [];

function createTempDb(): KnowledgeDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diandian-db-test-"));
  tempDirs.push(dir);
  return new KnowledgeDatabase(path.join(dir, "diandian.sqlite3"));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("KnowledgeDatabase (node:sqlite)", () => {
  it("deduplicates highlights by normalized fingerprint and tracks counts", () => {
    const db = createTempDb();
    try {
      const book = db.findOrCreateBook({ title: "置身事内", author: "兰小欢", source: "weread" });
      const first = db.addHighlight({
        bookId: book.id,
        chapter: "第一章",
        quote: "事权划分的三大原则：外部性、信息复杂性和激励相容。",
        note: "极简框架",
      });
      const dup = db.addHighlight({
        bookId: book.id,
        chapter: "第一章",
        quote: "  事权划分的三大原则：外部性、信息复杂性和激励相容。  ",
        note: "极简框架",
      });

      expect(first.deduplicated).toBe(false);
      expect(dup.deduplicated).toBe(true);
      expect(dup.record.id).toBe(first.record.id);

      const refreshed = db.getBook(book.id);
      expect(refreshed?.highlightCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it("preserves immutable AI original revisions when appending human edits", () => {
    const db = createTempDb();
    try {
      const book = db.findOrCreateBook({ title: "反脆弱", author: "塔勒布" });
      const created = db.createDraft({
        bookId: book.id,
        title: "读《反脆弱》随笔",
        kind: "review",
        authorKind: "ai",
        content: "AI 初稿：脆弱的反面不是强韧，而是反脆弱。",
        promptSummary: "首版生成",
      });
      expect(created.latestRevisionNo).toBe(1);
      expect(created.latestAuthorKind).toBe("ai");

      const revised = db.appendDraftRevision({
        draftId: created.id,
        authorKind: "human",
        content: "人工修订：真正的反脆弱是把波动当成养料，而不是躲进温室。",
        promptSummary: "手工去 AI 味",
      });

      expect(revised.latestRevisionNo).toBe(2);
      expect(revised.latestAuthorKind).toBe("human");
      expect(revised.revisions).toHaveLength(2);
      expect(revised.revisions?.[0]?.authorKind).toBe("ai");
      expect(revised.revisions?.[0]?.content).toContain("AI 初稿");
      expect(revised.revisions?.[1]?.authorKind).toBe("human");
      expect(revised.revisions?.[1]?.content).toContain("人工修订");
    } finally {
      db.close();
    }
  });
});

describe("Kindle & WeRead notes importers", () => {
  it("parses English and Chinese Kindle My Clippings.txt and attaches notes to previous highlight", () => {
    const sample = [
      "The Timeless Way of Building (Christopher Alexander)",
      "- Your Highlight on page 19 | Added on Monday, January 1, 2024",
      "",
      "There is one timeless way of building.",
      "==========",
      "The Timeless Way of Building (Christopher Alexander)",
      "- Your Note on page 19 | Added on Monday, January 1, 2024",
      "",
      "软件架构同样如此",
      "==========",
      "置身事内 (兰小欢)",
      "- 您在位置 #123 的标注 | 添加于 2024年5月1日",
      "",
      "生活过得好一点，比大多数宏伟更宏伟。",
      "==========",
    ].join("\n");

    const parsed = parseKindleClippings(sample);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.bookTitle).toBe("The Timeless Way of Building");
    expect(parsed[0]?.bookAuthor).toBe("Christopher Alexander");
    expect(parsed[0]?.note).toBe("软件架构同样如此");
    expect(parsed[1]?.bookTitle).toBe("置身事内");
  });

  it("parses WeRead exported notes and imports idempotently into SQLite", () => {
    const weread = [
      "原则",
      "瑞·达利欧",
      "2个笔记",
      "",
      "◆ 第一章 拥抱现实",
      "这条非常一针见血",
      ">> 痛苦 + 反思 = 进步。",
      ">> 不要把愿望当成事实。",
    ].join("\n");

    const detected = detectAndParseNotes(weread);
    expect(detected.format).toBe("weread");
    expect(parseWeReadNotes(weread)).toHaveLength(2);

    const db = createTempDb();
    try {
      const r1 = importNotesIntoDatabase(db, weread);
      const r2 = importNotesIntoDatabase(db, weread);
      expect(r1.importedCount).toBe(2);
      expect(r1.deduplicatedCount).toBe(0);
      expect(r2.importedCount).toBe(0);
      expect(r2.deduplicatedCount).toBe(2);
    } finally {
      db.close();
    }
  });
});

describe("Kindle location labels", () => {
  it("keeps page and location and drops the import date", () => {
    expect(kindleLocationLabel("- Your Highlight on page 19 | Location 280-282 | Added on Monday, January 1, 2024 10:00:00 AM")).toBe("第 19 页 · 位置 280-282");
    expect(kindleLocationLabel("- Your Highlight at location 1234-1235 | Added on Tuesday, 2 January 2024")).toBe("位置 1234-1235");
    expect(kindleLocationLabel("- 您在位置 #123-125的标注 | 添加于 2024年5月1日星期三 下午9:12:00")).toBe("位置 123-125");
    expect(kindleLocationLabel("- 您在第 12 页（位置 #170-171）的标注 | 添加于 2024年5月1日")).toBe("第 12 页 · 位置 170-171");
    expect(kindleLocationLabel("- Something unexpected | Added on today")).toBe("Something unexpected");
  });

  it("labels parsed clippings and fixes highlights imported before", () => {
    const parsed = parseKindleClippings("活着 (余华)\n- 您在位置 #123-125的标注 | 添加于 2024年5月1日\n\n人是为活着本身而活着。\n==========\n");
    expect(parsed[0]?.chapter).toBe("位置 123-125");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dd-kindle-labels-"));
    const file = path.join(dir, "diandian.sqlite3");
    let db = new KnowledgeDatabase(file);
    const book = db.findOrCreateBook({ title: "活着", author: "余华", source: "kindle" });
    const { record } = db.addHighlight({ bookId: book.id, quote: "少年去游荡。", chapter: "您在位置 #300-301的标注 | 添加于 2024年5月2日", source: "kindle" });
    db.setSetting("schema.kindle-chapter-labels.v1", ""); // as before this release
    db.close();
    db = new KnowledgeDatabase(file);
    try {
      expect(db.listHighlights(book.id).find((h) => h.id === record.id)?.chapter).toBe("位置 300-301");
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
