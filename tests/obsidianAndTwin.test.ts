import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CARD_TEMPLATES, renderReadingCardHtml } from "../electron/cards/cardTemplates";
import { exportBookToObsidian, exportDraftToObsidian } from "../electron/export/obsidianExporter";
import { KnowledgeDatabase } from "../electron/storage/database";
import { TwinStore } from "../electron/twin/twinStore";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Obsidian incremental exporter", () => {
  it("tracks user renames via diandian_id and protects manual edits with conflict copy", () => {
    const dir = makeTempDir("diandian-obs-");
    const vault = path.join(dir, "MyVault");
    fs.mkdirSync(vault, { recursive: true });
    const db = new KnowledgeDatabase(path.join(dir, "db.sqlite3"));

    try {
      const book = db.findOrCreateBook({
        title: "思考，快与慢: 双系统",
        author: "丹尼尔·卡尼曼",
      });
      db.addHighlight({
        bookId: book.id,
        quote: "系统一运转得既快又自动，几乎不费力气。",
        note: "直觉陷阱",
      });

      // 1. Initial write
      const r1 = exportBookToObsidian(db, vault, book.id);
      expect(r1.status).toBe("written");
      expect(r1.deepLink.startsWith("obsidian://open?vault=MyVault&file=")).toBe(true);

      // 2. Unchanged skip
      const r2 = exportBookToObsidian(db, vault, book.id);
      expect(r2.status).toBe("unchanged");

      // 3. Simulate user renaming/moving the note inside Obsidian (without changing content)
      const oldAbs = path.join(vault, r1.writtenRelativePath);
      const renamedRel = "ReadingArchive/Kahneman-Fast-Slow.md";
      const renamedAbs = path.join(vault, renamedRel);
      fs.mkdirSync(path.dirname(renamedAbs), { recursive: true });
      fs.renameSync(oldAbs, renamedAbs);

      // Add a new highlight and export again -> should update renamed file in place!
      db.addHighlight({ bookId: book.id, quote: "眼见即为全部（WYSIATI）。" });
      const r3 = exportBookToObsidian(db, vault, book.id);
      expect(r3.status).toBe("written");
      expect(r3.writtenRelativePath).toBe(renamedRel);
      expect(fs.existsSync(oldAbs)).toBe(false);

      // 4. Simulate user manually editing the file in Obsidian -> must write conflict copy!
      fs.appendFileSync(renamedAbs, "\n## 我在 Obsidian 里手工补充的段落\n", "utf8");
      db.addHighlight({ bookId: book.id, quote: "锚定效应无处不在。" });
      const r4 = exportBookToObsidian(db, vault, book.id);
      expect(r4.status).toBe("conflict");
      expect(r4.writtenRelativePath.endsWith(".diandian-conflict.md")).toBe(true);
      expect(fs.readFileSync(renamedAbs, "utf8")).toContain("我在 Obsidian 里手工补充的段落");
    } finally {
      db.close();
    }
  });

  it("rejects symlink vaults and YAML injection safely", () => {
    const dir = makeTempDir("diandian-obs-sec-");
    const realVault = path.join(dir, "RealVault");
    const symVault = path.join(dir, "SymVault");
    fs.mkdirSync(realVault, { recursive: true });
    fs.symlinkSync(realVault, symVault);

    const db = new KnowledgeDatabase(path.join(dir, "db.sqlite3"));
    try {
      const draft = db.createDraft({
        title: "Test\n---\ninjected: true",
        kind: "review",
        authorKind: "human",
        content: "Safe body",
      });

      expect(() => exportDraftToObsidian(db, symVault, draft.id)).toThrow(/符号链接/);

      const ok = exportDraftToObsidian(db, realVault, draft.id);
      const written = fs.readFileSync(path.join(realVault, ok.writtenRelativePath), "utf8");
      expect(written).toContain('title: "Test\\n---\\ninjected: true"');
    } finally {
      db.close();
    }
  });
});

describe("TwinStore & Card Templates", () => {
  it("seeds and atomically persists PROFILE.md and STYLE.md with digest", () => {
    const dir = makeTempDir("diandian-twin-");
    const store = new TwinStore(dir);
    const initial = store.read();
    expect(initial.profileMd).toContain("PROFILE");
    expect(initial.styleMd).toContain("STYLE");

    const updated = store.save({ styleMd: "# My Custom Voice\nShort sentences only." });
    expect(updated.sha256).not.toBe(initial.sha256);
    expect(updated.styleMd).toContain("Short sentences only.");
  });

  it("renders all 5 editorial templates and strictly escapes HTML/XSS payloads", () => {
    expect(CARD_TEMPLATES).toHaveLength(5);
    for (const tpl of CARD_TEMPLATES) {
      const html = renderReadingCardHtml({
        templateId: tpl.id,
        quote: '<script>alert("xss")</script> & 读书',
        comment: '<img src=x onerror=alert(1)>',
        bookTitle: "测试<书名>",
        author: '作者"引号"',
        tag: "书摘",
      });
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("<img ");
      expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    }
  });
});
