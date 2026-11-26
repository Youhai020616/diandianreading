import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DownloadedBookCovers } from "../electron/router/downloadedBookCovers";
import { listDownloadedBooks } from "../electron/router/downloadedBooks";
import { importSelectedBooks } from "../electron/router/localBookImport";
import { openReaderBook, updateReaderMetadata } from "../electron/router/localReader";
import { KnowledgeDatabase } from "../electron/storage/database";

vi.mock("electron", () => ({ nativeImage: {} }));
vi.mock("../electron/router/epubCover", () => ({ readEpubCover: async () => null }));
vi.mock("../electron/router/metadataService", () => ({ searchOnlineBookMetadata: async () => ({ candidates: [], issues: [] }) }));

let root: string;
let shelf: string;
let db: KnowledgeDatabase;
const cover = "data:image/jpeg;base64,Y292ZXI=";
const hint = { coverUrl: "https://covers.openlibrary.org/b/id/17-M.jpg" };
const locator = "epubcfi(/6/2!/4/2:0)";

function book(title = "书名", withCover = false, body = "正文") {
  const meta = withCover ? '<meta name="cover" content="cover-image"/>' : "";
  const modified = withCover ? '<meta property="dcterms:modified">2024-02-03T17:00:00Z</meta>' : "";
  const manifest = withCover ? '<item id="cover-image" href="cover-image.jpg" media-type="image/jpeg" properties="cover-image"/>' : "";
  return zipSync({
    "META-INF/container.xml": strToU8('<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'),
    "OPS/book.opf": strToU8(`<package><metadata>${meta}<dc:title>${title}</dc:title>${modified}</metadata><manifest>${manifest}</manifest></package>`),
    "OPS/chapter.xhtml": strToU8(body),
    ...(withCover ? { "OPS/cover-image.jpg": strToU8("cover") } : {}),
  }, { mtime: new Date(withCover ? "2024-02-03" : "2020-01-01") });
}

function fixture() {
  let bytes: Uint8Array = book();
  const cli = {
    getDownloadDir: () => shelf,
    download: vi.fn(async (_ref: string, stage?: string) => {
      const filePath = path.join(stage!, "书名.epub");
      await fs.writeFile(filePath, bytes);
      return { output: filePath, directory: stage!, filePath };
    }),
    readLocalBookMeta: async () => ({ title: "", authors: "", isbn: "", publisher: "", date: "", tags: "", language: "", comments: "" }),
    embedEpubCover: vi.fn(async (file: string) => { await fs.writeFile(file, book("书名", true)); }),
    extractBookCover: async () => null,
  };
  const images = { get: vi.fn(async (): Promise<string | null> => cover) };
  return { cli, images, service: () => new DownloadedBookCovers(cli, images, db), source: (value: Uint8Array) => { bytes = value; } };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "download-editions-"));
  shelf = path.join(root, "books");
  await fs.mkdir(shelf);
  db = new KnowledgeDatabase(path.join(root, "db.sqlite"));
});
afterEach(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });

it("reuses an offline download after a cover becomes available, preserving progress, highlight and local bytes", async () => {
  const { service, cli, images } = fixture();
  images.get.mockResolvedValueOnce(null);
  const first = await service().download("1:abc", hint);
  const opened = await openReaderBook(db, shelf, first.filePath);
  db.saveReaderLocation(opened.documentId, locator);
  const mark = db.addReaderAnnotation({ documentId: opened.documentId, cfi: locator, title: "书名", chapter: "", quote: "正文" });
  db.close();
  db = new KnowledgeDatabase(path.join(root, "db.sqlite"));
  const online = service();
  const next = await online.download("1:abc", hint);
  expect(next.filePath).toBe(first.filePath);
  expect(await online.preview(next.filePath)).toBe(cover);
  expect(await openReaderBook(db, shelf, next.filePath)).toMatchObject({ documentId: opened.documentId, location: locator, annotations: [mark] });
  expect(cli.embedEpubCover).not.toHaveBeenCalled();
  expect(await fs.readFile(next.filePath)).toEqual(Buffer.from(book()));
  expect(await listDownloadedBooks(shelf)).toHaveLength(1);
});

it("recognizes a cover-enriched file after a metadata edit, move and restart, keeping replacements and new source editions separate", async () => {
  const { source, service } = fixture();
  const first = await service().download("1:abc", hint);
  const { documentId } = await openReaderBook(db, shelf, first.filePath);
  await updateReaderMetadata(db, shelf, first.filePath, async (filePath) => {
    await fs.writeFile(filePath, book("本地修订", true));
    return { filePath, output: filePath };
  });
  const moved = path.join(shelf, "移动后.epub");
  await fs.rename(first.filePath, moved);
  await fs.writeFile(first.filePath, book("原址另一份书稿"));
  expect(await service().localHistoryRefs([{ bookRef: "1:abc" }])).toEqual(["1:abc"]);
  expect(await service().downloadHistoryBook("1:abc")).toMatchObject({ alreadyLocal: true, filePath: moved });
  expect((await service().download("2:def")).filePath).toBe(moved);
  expect((await openReaderBook(db, shelf, moved)).documentId).toBe(documentId);
  source(book("全新版次"));
  const changed = await service().download("1:abc");
  expect(changed.filePath).toBe(path.join(shelf, "书名 (2).epub"));
  expect(await fs.readFile(first.filePath)).toEqual(Buffer.from(book("原址另一份书稿")));
  expect(await listDownloadedBooks(shelf)).toHaveLength(3);
});

it("coalesces concurrent clicks and matches identical source bytes from different refs", async () => {
  const { cli, service } = fixture();
  const a = service(), b = service();
  const results = await Promise.all([a.download("1:abc"), a.download("1:abc"), b.download("3:ghi", hint)]);
  expect(cli.download).toHaveBeenCalledTimes(2);
  expect(new Set(results.map(item => item.filePath)).size).toBe(1);
  expect(await listDownloadedBooks(shelf)).toHaveLength(1);
});

it("recognizes moved legacy zlib-enriched EPUBs without receipts, but preserves changed book matter and differing editions", async () => {
  const { service, source } = fixture();
  await fs.mkdir(path.join(shelf, "已整理"));
  const old = path.join(shelf, "已整理", "已重命名.epub");
  await fs.writeFile(old, book("书名", true));
  vi.spyOn(db, "setSetting").mockImplementation(() => { throw new Error("busy"); });
  const first = await service().download("1:abc");
  expect(first.filePath).toBe(old);
  expect(await fs.readFile(old)).toEqual(Buffer.from(book("书名", true)));
  source(book("书名", false, "修改正文"));
  expect((await service().download("1:abc")).filePath).toBe(path.join(shelf, "书名.epub"));
  source(book("另一版"));
  expect((await service().download("2:bbb")).filePath).toBe(path.join(shelf, "书名 (2).epub"));
  expect(await listDownloadedBooks(shelf)).toHaveLength(3);
});

it("imports the original of a cover-enriched download into its existing shelf entry", async () => {
  const { service } = fixture();
  const original = path.join(root, "从外部导入.epub");
  await fs.writeFile(original, book());
  const downloaded = await service().download("1:abc", hint);
  expect(await fs.readFile(downloaded.filePath)).not.toEqual(Buffer.from(book()));
  const opened = await openReaderBook(db, shelf, downloaded.filePath);
  db.saveReaderLocation(opened.documentId, locator);
  const mark = db.addReaderAnnotation({ documentId: opened.documentId, cfi: locator, title: "书名", chapter: "", quote: "正文" });
  expect(await importSelectedBooks(shelf, "files", [original], service())).toMatchObject({ added: 0, existing: 1, failures: [] });
  expect(await listDownloadedBooks(shelf)).toHaveLength(1);
  expect(await openReaderBook(db, shelf, downloaded.filePath)).toMatchObject({ location: locator, annotations: [mark] });
  expect(await fs.readFile(original)).toEqual(Buffer.from(book()));
});
