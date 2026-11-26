import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zipSync, strToU8 } from "fflate";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openReaderBook, resolveReaderHighlight, updateReaderMetadata } from "../electron/router/localReader";
import { KnowledgeDatabase } from "../electron/storage/database";

let temp: string;
let downloads: string;
let file: string;
let db: KnowledgeDatabase;

function epub(title: string) {
  return zipSync({
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'),
    "book.opf": strToU8(`<package><metadata><title>${title}</title></metadata></package>`),
  });
}

beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "reader-"));
  downloads = path.join(temp, "书库");
  await fs.mkdir(downloads);
  file = path.join(downloads, "书名.epub");
  await fs.writeFile(file, epub("甲"));
  db = new KnowledgeDatabase(path.join(temp, "notes.db"));
});
afterEach(async () => {
  db.close();
  await fs.rm(temp, { recursive: true, force: true });
});

const location = "epubcfi(/6/2!/4/2:0)";
const cfi = "epubcfi(/6/2!/4,/2:0,/2:3)";

function editMetadata(title: string, newName?: string) {
  return async (staged: string) => {
    await fs.writeFile(staged, epub(title));
    const filePath = newName ? path.join(path.dirname(staged), newName) : staged;
    if (filePath !== staged) await fs.rename(staged, filePath);
    return { filePath, output: filePath };
  };
}

it("keeps the original progress and highlights after successive metadata writes, rename, and restart", async () => {
  const { documentId } = await openReaderBook(db, downloads, file);
  const mark = db.addReaderAnnotation({ documentId, cfi, quote: "原文", title: "甲", chapter: "一" });
  db.saveReaderLocation(documentId, location);
  await updateReaderMetadata(db, downloads, file, editMetadata("第一版补全"));
  expect(await openReaderBook(db, downloads, file)).toMatchObject({ documentId, location, annotations: [mark] });
  const result = await updateReaderMetadata(db, downloads, file, editMetadata("第二次更正书籍信息", "规范名称.epub"));
  expect(result).toEqual({ filePath: path.join(downloads, "规范名称.epub"), output: path.join(downloads, "规范名称.epub") });
  // A window that was opened before both writes continues using this document ID.
  const laterLocation = "epubcfi(/6/4!/4/2:1)";
  db.saveReaderLocation(documentId, laterLocation);
  const laterMark = db.addReaderAnnotation({ documentId, cfi: laterLocation, quote: "另一句", title: "甲", chapter: "二" });
  const moved = path.join(downloads, "再改名.epub");
  await fs.rename(result.filePath, moved);
  await fs.writeFile(file, epub("原路径已换成其他书"));
  db.close();
  db = new KnowledgeDatabase(path.join(temp, "notes.db"));
  expect((await resolveReaderHighlight(db, downloads, laterMark.id)).file.filePath).toBe(moved);
  expect((await resolveReaderHighlight(db, downloads, mark.id)).file.filePath).toBe(moved);
  const reopened = await openReaderBook(db, downloads, moved);
  expect(reopened).toMatchObject({ documentId, location: laterLocation });
  expect(reopened.annotations.map(entry => entry.id).sort()).toEqual([mark.id, laterMark.id].sort());
  expect(await openReaderBook(db, downloads, file)).toMatchObject({ location: "", annotations: [] });
});

it("does not publish failed or conflicting metadata writes over the original or an existing edition", async () => {
  const original = await fs.readFile(file);
  const { documentId } = await openReaderBook(db, downloads, file);
  db.saveReaderLocation(documentId, location);
  await expect(updateReaderMetadata(db, downloads, file, async staged => {
    await fs.writeFile(staged, "partial");
    throw new Error("写回失败");
  })).rejects.toThrow("写回失败");
  const other = path.join(downloads, "现有版本.epub");
  const otherBytes = epub("独立版本");
  await fs.writeFile(other, otherBytes);
  await expect(updateReaderMetadata(db, downloads, file, editMetadata("修改", path.basename(other)))).rejects.toThrow("已存在");
  expect(await fs.readFile(other)).toEqual(Buffer.from(otherBytes));
  expect(await fs.readFile(file)).toEqual(original);
  expect(await openReaderBook(db, downloads, file)).toMatchObject({ documentId, location });
  expect((await fs.readdir(downloads)).sort()).toEqual([path.basename(file), path.basename(other)].sort());
});

it("never attaches progress to an unrelated replacement during metadata editing", async () => {
  const { documentId } = await openReaderBook(db, downloads, file);
  db.saveReaderLocation(documentId, location);
  const incoming = epub("另一本书");
  await expect(updateReaderMetadata(db, downloads, file, async staged => {
    const result = await editMetadata("修改后的名称")(staged);
    await fs.writeFile(file, incoming);
    return result;
  })).rejects.toThrow("文件已改变");
  expect(await fs.readFile(file)).toEqual(Buffer.from(incoming));
  expect(await openReaderBook(db, downloads, file)).toMatchObject({ location: "", annotations: [] });
});

it("saves progress without creating a note book and keeps the right edition across renames and restarts", async () => {
  const first = await openReaderBook(db, downloads, file);
  expect(first.bytes.byteLength).toBe((await fs.stat(file)).size);
  expect(first.annotations).toEqual([]);
  expect(first.location).toBe("");
  db.saveReaderLocation(first.documentId, location);
  expect(db.listBooks()).toEqual([]);
  const note = db.addReaderAnnotation({ documentId: first.documentId, title: "甲", chapter: "一", quote: "同一句", cfi });
  const renamed = path.join(downloads, "新书名.EPUB");
  await fs.rename(file, renamed);
  await fs.writeFile(file, epub("乙"));
  db.close();
  db = new KnowledgeDatabase(path.join(temp, "notes.db"));
  expect((await resolveReaderHighlight(db, downloads, note.id)).file.filePath).toBe(renamed);
  const reopened = await openReaderBook(db, downloads, renamed);
  expect(reopened).toMatchObject({ documentId: first.documentId, location, annotations: [{ id: note.id, cfi }] });
  const other = await openReaderBook(db, downloads, file);
  expect(other.documentId).not.toBe(first.documentId);
  expect(other).toMatchObject({ location: "", annotations: [] });
  await fs.rm(renamed);
  await expect(resolveReaderHighlight(db, downloads, note.id)).rejects.toThrow("找不到");
});

it("reuses a matching note book and keeps identical quotes at different positions distinct", async () => {
  const existing = db.findOrCreateBook({ title: "甲", author: "作者", source: "weread" });
  const { documentId } = await openReaderBook(db, downloads, file);
  const input = { documentId, title: "甲", author: "作者", chapter: "一", quote: "同一句", cfi };
  const first = db.addReaderAnnotation(input);
  const second = db.addReaderAnnotation({ ...input, cfi: "epubcfi(/6/4!/4,/2:0,/2:3)" });
  expect(first.bookId).toBe(existing.id);
  expect(second.id).not.toBe(first.id);
  db.updateBook(existing.id, { title: "书名已编辑" });
  db.updateHighlightNote(first.id, "笔记面板的编辑");
  expect(db.addReaderAnnotation(input)).toMatchObject({ id: first.id, note: "笔记面板的编辑" });
  expect(db.addReaderAnnotation({ ...input, note: "新想法" })).toMatchObject({ id: first.id, note: "新想法" });
  expect(db.listBooks()).toHaveLength(1);
  expect(db.listHighlights(existing.id)).toHaveLength(2);
  expect(db.searchAllHighlights("新想法")[0]).toMatchObject({ id: first.id, cfi });
  db.deleteHighlight(second.id);
  expect((await openReaderBook(db, downloads, file)).annotations).toHaveLength(1);
  db.deleteBook(existing.id);
  expect((await openReaderBook(db, downloads, file)).annotations).toEqual([]);
  expect(db.addReaderAnnotation(input).bookId).not.toBe(existing.id);
});

it("removes the selected mark from the right EPUB, its note list and search across restarts", async () => {
  const { documentId } = await openReaderBook(db, downloads, file);
  const input = { documentId, title: "甲", chapter: "一", quote: "共同的原句", cfi };
  const target = db.addReaderAnnotation(input);
  const otherPlace = db.addReaderAnnotation({ ...input, cfi: "epubcfi(/6/4!/4,/2:0,/2:3)" });
  const imported = db.addHighlight({ bookId: target.bookId, quote: "微信读书的划线", source: "weread" }).record;
  db.saveReaderLocation(documentId, location);

  expect(db.removeReaderAnnotation("different-document", target.id)).toBeNull();
  expect(db.removeReaderAnnotation(documentId, imported.id)).toBeNull();
  expect(db.listHighlights(target.bookId)).toHaveLength(3);
  expect(db.removeReaderAnnotation(documentId, target.id)).toBeNull();
  expect(db.removeReaderAnnotation(documentId, target.id)).toBeNull();
  db.close();
  db = new KnowledgeDatabase(path.join(temp, "notes.db"));
  expect(await openReaderBook(db, downloads, file)).toMatchObject({ location, annotations: [otherPlace] });
  expect(db.searchAllHighlights(input.quote).map(h => h.id)).toEqual([otherPlace.id]);
  expect(db.getBook(target.bookId)?.highlightCount).toBe(2);
  expect(() => db.readerHighlightTarget(target.id)).toThrow();
});

it("keeps an unmarked thought searchable and anchored, and re-highlights it without duplicating it", async () => {
  const { documentId } = await openReaderBook(db, downloads, file);
  const input = { documentId, title: "甲", chapter: "一", quote: "一处原文", cfi };
  const mark = db.addReaderAnnotation({ ...input, note: "我的想法" });
  expect(mark.isHighlighted).toBe(true);
  const retained = { ...mark, isHighlighted: false };
  expect(db.removeReaderAnnotation(documentId, mark.id)).toEqual(retained);
  expect(db.removeReaderAnnotation(documentId, mark.id)).toEqual(retained);
  expect((await resolveReaderHighlight(db, downloads, mark.id)).cfi).toBe(cfi);
  expect(db.searchAllHighlights("我的想法")[0]).toMatchObject(retained);
  const edited = db.addReaderAnnotation({ ...input, note: "修改后的想法" });
  expect(edited).toEqual({ ...retained, note: "修改后的想法" });
  db.close();
  db = new KnowledgeDatabase(path.join(temp, "notes.db"));
  expect((await openReaderBook(db, downloads, file)).annotations).toEqual([edited]);
  expect(db.addReaderAnnotation(input)).toEqual({ ...edited, isHighlighted: true });
  expect(db.listHighlights(mark.bookId)).toHaveLength(1);
  expect(db.updateHighlightNote(mark.id, "")).toMatchObject({ id: mark.id, isHighlighted: true });
  db.updateHighlightNote(mark.id, "准备清空的想法");
  db.removeReaderAnnotation(documentId, mark.id);
  expect(db.updateHighlightNote(mark.id, "  ")).toBeNull();
  expect((await openReaderBook(db, downloads, file)).annotations).toEqual([]);
  expect(db.searchAllHighlights("准备清空的想法")).toEqual([]);
});

it("treats all previously saved EPUB annotations as highlighted when upgrading", async () => {
  const { documentId } = await openReaderBook(db, downloads, file);
  const mark = db.addReaderAnnotation({ documentId, title: "旧书", chapter: "", quote: "旧划线", cfi });
  const dbPath = db.dbPath;
  db.close();
  const legacy = new DatabaseSync(dbPath);
  legacy.exec("ALTER TABLE highlights DROP COLUMN reader_highlighted");
  legacy.close();
  db = new KnowledgeDatabase(dbPath);
  expect((await openReaderBook(db, downloads, file)).annotations).toEqual([mark]);
});

it("upgrades an existing notes database and leaves ordinary highlights and failed annotations intact", async () => {
  const oldBook = db.findOrCreateBook({ title: "旧笔记" });
  const oldHighlight = db.addHighlight({ bookId: oldBook.id, quote: "一条旧划线" }).record;
  const dbPath = db.dbPath;
  db.close();
  const legacy = new DatabaseSync(dbPath);
  legacy.exec("DROP INDEX idx_reader_highlight_location; ALTER TABLE highlights DROP COLUMN reader_document_id; ALTER TABLE highlights DROP COLUMN reader_cfi; ALTER TABLE highlights DROP COLUMN reader_highlighted; DROP TABLE reader_documents");
  legacy.close();
  db = new KnowledgeDatabase(dbPath);
  expect(db.listHighlights(oldBook.id)).toEqual([oldHighlight]);
  const { documentId } = await openReaderBook(db, downloads, file);
  expect(() => db.addReaderAnnotation({ documentId, title: "不应新建", chapter: "", quote: "", cfi })).toThrow();
  expect(() => db.saveReaderLocation(documentId, "bad")).toThrow();
  expect(() => db.saveReaderLocation("missing", location)).toThrow();
  expect(db.listBooks()).toHaveLength(1);
});

it("opens only bounded EPUBs in the download directory", async () => {
  const outside = path.join(temp, "outside.epub");
  await fs.copyFile(file, outside);
  await fs.symlink(outside, path.join(downloads, "link.epub"));
  await fs.writeFile(path.join(downloads, "fake.epub"), "not an archive");
  await fs.writeFile(path.join(downloads, "wrong.epub"), zipSync({ "book.xml": strToU8("zip") }));
  await fs.copyFile(file, path.join(downloads, "other.pdf"));
  for (const bad of [outside, ...["link.epub", "fake.epub", "wrong.epub", "other.pdf"].map(name => path.join(downloads, name))]) {
    await expect(openReaderBook(db, downloads, bad)).rejects.toThrow();
  }
  await fs.truncate(file, 128 * 1024 * 1024 + 1);
  await expect(openReaderBook(db, downloads, file)).rejects.toThrow("128 MB");
  expect(db.listBooks()).toEqual([]);
});

it("rejects EPUBs the renderer could not read, using the shared archive limits", async () => {
  const { EPUB_LIMITS } = await import("../electron/router/epubLimits");
  const oversizedChapter = new Uint8Array(EPUB_LIMITS.textBytes + 1).fill(0x61);
  await fs.writeFile(file, zipSync({
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'),
    "book.opf": strToU8("<package/>"),
    "chapter.xhtml": oversizedChapter,
  }));
  await expect(openReaderBook(db, downloads, file)).rejects.toThrow("资源过大");
  // The same size is acceptable for a binary resource such as an image.
  await fs.writeFile(file, zipSync({
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'),
    "book.opf": strToU8("<package/>"),
    "image.jpg": oversizedChapter,
  }));
  await expect(openReaderBook(db, downloads, file)).resolves.toMatchObject({ documentId: expect.any(String) });
});

it("stores a highlight color, recolors on a repeat highlight, and keeps it across reopen", async () => {
  const { documentId } = await openReaderBook(db, downloads, file);
  const first = db.addReaderAnnotation({ documentId, cfi, quote: "原文", title: "甲", chapter: "一", color: "red" });
  expect(first).toMatchObject({ color: "red", isHighlighted: true });
  const plain = db.addReaderAnnotation({ documentId, cfi: location, quote: "另一句", title: "甲", chapter: "一" });
  expect(plain.color).toBe("yellow");
  const recolored = db.addReaderAnnotation({ documentId, cfi, quote: "原文", title: "甲", chapter: "一", color: "blue" });
  expect(recolored).toMatchObject({ id: first.id, color: "blue" });
  expect(() => db.addReaderAnnotation({ documentId, cfi, quote: "原文", title: "甲", chapter: "一", color: "pink" as never }))
    .toThrow("划线颜色");
  const reopened = await openReaderBook(db, downloads, file);
  expect(reopened.annotations.find(item => item.id === first.id)?.color).toBe("blue");
});
