import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DownloadedBookCovers } from "../electron/router/downloadedBookCovers";
import { listDownloadedBooks } from "../electron/router/downloadedBooks";
import { importBookText, importSelectedBooks } from "../electron/router/localBookImport";
import { openReaderBook, updateReaderMetadata } from "../electron/router/localReader";
import { pastedTextEpub } from "../electron/router/pastedTextEpub";
import { KnowledgeDatabase } from "../electron/storage/database";

vi.mock("electron", () => ({ nativeImage: {} }));
let root: string, shelf: string, source: string, db: KnowledgeDatabase, publisher: DownloadedBookCovers;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "shelf-import-"));
  shelf = path.join(root, "书库");
  source = path.join(root, "外部");
  await fs.mkdir(source);
  db = new KnowledgeDatabase(path.join(root, "db.sqlite"));
  publisher = new DownloadedBookCovers({
    getDownloadDir: () => shelf, download: vi.fn(), readLocalBookMeta: vi.fn(),
    embedEpubCover: vi.fn(), extractBookCover: vi.fn(),
  }, { get: vi.fn() }, db);
});
afterEach(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });

it("imports a folder recursively, preserves the originals and continues past unreadable books", async () => {
  const sub = path.join(source, "笔记");
  await fs.mkdir(sub);
  await fs.writeFile(path.join(source, "书.pdf"), "PDF A");
  await fs.writeFile(path.join(sub, "书.pdf"), "PDF B");
  await fs.writeFile(path.join(sub, "空白.pdf"), "");
  await fs.writeFile(path.join(sub, ".hidden.pdf"), "hidden");
  await fs.writeFile(path.join(sub, "未完成.pdf.part"), "temporary");
  await fs.symlink(source, path.join(sub, "循环"));
  await fs.symlink(path.join(sub, "书.pdf"), path.join(sub, "链接.pdf"));
  const result = await importSelectedBooks(shelf, "directory", [source], publisher);
  expect(result).toMatchObject({ added: 2, existing: 0, canceled: false, failures: [{ name: "空白.pdf" }] });
  const files = await listDownloadedBooks(shelf);
  expect(files.map(f => f.fileName).sort()).toEqual(["书 (2).pdf", "书.pdf"]);
  expect((await Promise.all(files.map(f => fs.readFile(f.filePath, "utf8")))).sort()).toEqual(["PDF A", "PDF B"]);
  await fs.writeFile(path.join(source, "书.pdf"), "new content");
  expect((await Promise.all(files.map(f => fs.readFile(f.filePath, "utf8")))).sort()).toEqual(["PDF A", "PDF B"]);
  expect(await importSelectedBooks(shelf, "directory", [shelf], publisher)).toMatchObject({ added: 0, existing: 2, failures: [] });
});

it("deduplicates concurrent multiselects by contents and reports individual invalid selections", async () => {
  const a = path.join(source, "First.pdf"), b = path.join(source, "Second.PDF");
  await Promise.all([fs.writeFile(a, "same"), fs.writeFile(b, "same")]);
  const outcomes = await Promise.all([a, b].map(file => importSelectedBooks(shelf, "files", [file], publisher)));
  expect(outcomes.reduce((n, r) => n + r.added, 0)).toBe(1);
  expect(outcomes.reduce((n, r) => n + r.existing, 0)).toBe(1);
  const missing = path.join(source, "Missing.pdf"), sym = path.join(source, "Alias.pdf");
  await fs.symlink(a, sym);
  expect(await importSelectedBooks(shelf, "files", [a, missing, sym, b], publisher)).toMatchObject({
    added: 0, existing: 2, failures: [{ name: "Missing.pdf" }, { name: "Alias.pdf" }],
  });
  expect(await listDownloadedBooks(shelf)).toHaveLength(1);
  expect((await fs.readdir(shelf)).some(n => n.startsWith(".import-"))).toBe(false);
});

it("keeps one library entry and its reading position after an EPUB metadata edit and external reimport", async () => {
  const original = path.join(source, "Original.epub");
  const bytes = pastedTextEpub({ title: "第一版", text: "本地正文" }).bytes;
  await fs.writeFile(original, bytes);
  await importSelectedBooks(shelf, "files", [original], publisher);
  const stored = (await listDownloadedBooks(shelf))[0]!;
  const opened = await openReaderBook(db, shelf, stored.filePath);
  const location = "epubcfi(/6/2!/4/2:0)";
  db.saveReaderLocation(opened.documentId, location);
  await updateReaderMetadata(db, shelf, stored.filePath, async filePath => {
    await fs.writeFile(filePath, pastedTextEpub({ title: "新书名", text: "本地正文" }).bytes);
    return { filePath, output: filePath };
  });
  expect(await importSelectedBooks(shelf, "files", [original], publisher)).toMatchObject({ added: 0, existing: 1 });
  const files = await listDownloadedBooks(shelf);
  expect(files).toHaveLength(1);
  expect(await openReaderBook(db, shelf, files[0]!.filePath)).toMatchObject({ documentId: opened.documentId, location });
});

it("creates a readable EPUB with stable identity, escaped paragraphs, a navigation document and safe filename", async () => {
  const draft = { title: "../../<笔记> & A", text: "  Some & text.\r\n\r\n<script>只是正文</script>\u0001  " };
  expect(await importBookText(shelf, draft, publisher)).toMatchObject({ added: 1, failures: [] });
  expect(await importBookText(shelf, draft, publisher)).toMatchObject({ added: 0, existing: 1 });
  const file = (await listDownloadedBooks(shelf))[0]!;
  const { bytes } = await openReaderBook(db, shelf, file.filePath);
  expect(path.dirname(file.filePath)).toBe(shelf);
  const archive = unzipSync(new Uint8Array(bytes));
  expect(strFromU8(archive["mimetype"]!)).toBe("application/epub+zip");
  expect(strFromU8(archive["section-1.xhtml"]!)).toContain("<p>Some &amp; text.</p><p>&lt;script&gt;只是正文&lt;/script&gt;</p>");
  expect(strFromU8(archive["book.opf"]!)).toContain("&lt;笔记&gt; &amp; A");
  expect(strFromU8(archive["nav.xhtml"]!)).toContain('href="section-1.xhtml"');
  expect(() => pastedTextEpub({ title: "", text: " \n " })).toThrow("粘贴正文");
  expect(() => pastedTextEpub({ title: "", text: "字".repeat(750_000) })).toThrow("2 MB");
  expect(pastedTextEpub({ title: "", text: "标题\n下一段" }).fileName).toBe("标题.epub");
});

it("bounds folder imports by depth, scanned entries and imported books", async () => {
  let deep = source;
  for (const name of ["一", "二", "三"]) {
    deep = path.join(deep, name);
    await fs.mkdir(deep);
    await fs.writeFile(path.join(deep, `${name}.pdf`), `PDF ${name}`);
  }
  const shallow = await importSelectedBooks(shelf, "directory", [source], publisher, { depth: 2, entries: 100, books: 100 });
  expect(shallow).toMatchObject({ added: 1, failures: [{ name: "二", message: expect.stringContaining("2 层") }] });

  for (let i = 0; i < 5; i++) await fs.writeFile(path.join(source, `批量${i}.pdf`), `batch ${i}`);
  const capped = await importSelectedBooks(shelf, "directory", [source], publisher, { depth: 8, entries: 100, books: 3 });
  expect(capped.added + capped.existing).toBe(3);
  expect(capped.failures).toEqual([expect.objectContaining({ message: expect.stringContaining("最多导入 3 本") })]);

  const crowded = await importSelectedBooks(shelf, "directory", [source], publisher, { depth: 8, entries: 2, books: 100 });
  expect(crowded.added + crowded.existing).toBeLessThanOrEqual(2);
  expect(crowded.failures).toEqual([expect.objectContaining({ name: "外部", message: expect.stringContaining("扫描 2 项后停止") })]);
});
