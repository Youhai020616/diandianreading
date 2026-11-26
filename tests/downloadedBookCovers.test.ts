import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { DownloadedBookCovers } from "../electron/router/downloadedBookCovers";
import { listDownloadedBooks } from "../electron/router/downloadedBooks";
import { readEpubCover } from "../electron/router/epubCover";
import { searchOnlineBookMetadata } from "../electron/router/metadataService";
import { parseMetaMatches } from "../electron/router/zlibCliService";
import type { BookMetadataCandidate } from "../src/types/desktop";

vi.mock("electron", () => ({ nativeImage: {} }));
vi.mock("../electron/router/epubCover", () => ({ readEpubCover: vi.fn() }));
vi.mock("../electron/router/metadataService", () => ({ searchOnlineBookMetadata: vi.fn() }));

let root: string;
const image = "data:image/jpeg;base64,Y292ZXI=";
const url = "https://covers.openlibrary.org/b/id/17-M.jpg";
const metadata = { title: "Test", authors: "Author", publisher: "", date: "", isbn: "", language: "", tags: "", comments: "" };
const edition: BookMetadataCandidate = {
  source: "openlibrary", title: "Test", author: "Author", isbn: "9780441172719", publisher: "Ace",
  publishedYear: "1990", description: "", coverUrl: url,
};
function fixture(fileName = "test.epub") {
  const db = new Map<string, string>();
  const settings = {
    getSetting: (k: string) => db.get(k) ?? null,
    setSetting: (k: string, v: string) => { db.set(k, v); },
    deleteSetting: (k: string) => { db.delete(k); },
  };
  const cli = {
    getDownloadDir: () => root,
    download: vi.fn(async (_ref: string, destDir?: string) => {
      const filePath = path.join(destDir!, fileName);
      await fs.writeFile(filePath, "original");
      return { output: filePath, directory: destDir!, filePath };
    }),
    readLocalBookMeta: vi.fn(async (_file: string) => ({ ...metadata, embeddedCover: "" })),
    embedEpubCover: vi.fn(async (file: string, bytes: Buffer) => { await fs.appendFile(file, bytes); }),
    extractBookCover: vi.fn(async () => null),
  };
  const images = { get: vi.fn(async (): Promise<string | null> => image) };
  return { cli, settings, images, service: new DownloadedBookCovers(cli, images, settings) };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "download-cover-"));
  vi.mocked(readEpubCover).mockReset().mockResolvedValue(null);
  vi.mocked(searchOnlineBookMetadata).mockReset().mockResolvedValue({ candidates: [edition], issues: [] });
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

it("adds the selected cover to a new EPUB before publishing it, and retains different existing files", async () => {
  const { cli, service } = fixture();
  await fs.writeFile(path.join(root, "test.epub"), "previous edition");
  let visible: string[] = [];
  cli.embedEpubCover.mockImplementation(async (file, bytes) => {
    visible = (await listDownloadedBooks(root)).map(book => book.fileName);
    await fs.appendFile(file, bytes);
  });
  const result = await service.download("1:abc", { coverUrl: url });
  expect(visible).toEqual(["test.epub"]);
  expect(await fs.readFile(result.filePath, "utf8")).toBe("originalcover");
  expect(await fs.readFile(path.join(root, "test.epub"), "utf8")).toBe("previous edition");
  expect(result.output).toBe(result.filePath);
  expect((await service.download("1:abc", { coverUrl: url })).filePath).toBe(result.filePath);
  expect(searchOnlineBookMetadata).not.toHaveBeenCalled();
});

it("keeps an existing cover offline, and preserves covers that another reader can decode", async () => {
  const { cli, service, images } = fixture();
  vi.mocked(readEpubCover).mockResolvedValueOnce(image);
  await service.download("1:abc", { coverUrl: url });
  expect(images.get).not.toHaveBeenCalled();
  cli.readLocalBookMeta.mockResolvedValue({ ...metadata, embeddedCover: "image/webp" });
  await service.download("1:abc", { coverUrl: url });
  expect(cli.embedEpubCover).not.toHaveBeenCalled();
});

it("publishes offline, retries on the shelf, and does not change an older book's bytes", async () => {
  const { cli, service, settings, images } = fixture();
  vi.mocked(searchOnlineBookMetadata).mockRejectedValueOnce(new Error("offline"));
  const { filePath } = await service.download("1:abc", { isbn: edition.isbn });
  expect(await fs.readFile(filePath, "utf8")).toBe("original");
  expect(await Promise.all([service.preview(filePath), service.preview(filePath)])).toEqual([image, image]);
  expect(searchOnlineBookMetadata).toHaveBeenCalledTimes(2);
  expect(cli.embedEpubCover).not.toHaveBeenCalled();
  vi.mocked(searchOnlineBookMetadata).mockRejectedValue(new Error("offline"));
  const restarted = new DownloadedBookCovers(cli, images, settings);
  expect(await restarted.preview(filePath)).toBe(image);
  expect(await fs.readFile(filePath, "utf8")).toBe("original");
});

it("leaves a title with competing editions alone and keeps a download if embedding fails", async () => {
  const { cli, service } = fixture();
  vi.mocked(searchOnlineBookMetadata).mockResolvedValueOnce({ candidates: [edition, { ...edition, isbn: "9780441013593" }], issues: [] });
  const first = await service.download("1:abc", { title: "Test", author: "Author" });
  expect(cli.embedEpubCover).not.toHaveBeenCalled();
  cli.embedEpubCover.mockRejectedValueOnce(new Error("write failed"));
  const second = await service.download("1:abc", { coverUrl: url });
  expect(second.filePath).toBe(first.filePath);
  expect(await fs.readFile(second.filePath, "utf8")).toBe("original");
});

it("uses the downloaded edition's cover on the shelf for other formats", async () => {
  const { cli, service } = fixture("test.txt");
  const { filePath } = await service.download("1:abc", { coverUrl: url });
  expect(await service.preview(filePath)).toBe(image);
  expect(cli.embedEpubCover).not.toHaveBeenCalled();
  expect(searchOnlineBookMetadata).not.toHaveBeenCalled();
});

it("reuses history downloads across restarts and moves, without mistaking a same-size replacement for the book", async () => {
  const { cli, service, images, settings } = fixture("旧书.txt");
  const ref = "history:missingHash";
  const [first, concurrent] = await Promise.all([service.downloadHistoryBook(ref), service.downloadHistoryBook(ref)]);
  expect(first).toEqual(concurrent);
  expect(first.alreadyLocal).toBe(false);
  expect(cli.download).toHaveBeenCalledTimes(1);
  const moved = path.join(root, "改名.txt");
  await fs.rename(first.filePath, moved);
  await fs.writeFile(first.filePath, "new copy");
  const restarted = new DownloadedBookCovers(cli, images, settings);
  expect(await restarted.localHistoryRefs([{ bookRef: ref }, { bookRef: "history:other" }])).toEqual([ref]);
  expect(await restarted.downloadHistoryBook(ref)).toMatchObject({ alreadyLocal: true, filePath: moved });
  expect(cli.download).toHaveBeenCalledTimes(1);
  await fs.unlink(moved);
  expect(await restarted.localHistoryRefs([{ bookRef: ref }])).toEqual([]);
  expect(cli.readLocalBookMeta).not.toHaveBeenCalledWith(moved);
});

it("recognizes imported EPUBs by their embedded edition ref and reuses metadata until the file changes", async () => {
  const { cli, service } = fixture();
  const file = path.join(root, "Test.epub");
  const first = { bookRef: "11:aaa", extension: "epub" }, other = { bookRef: "12:bbb", extension: "epub" };
  await fs.writeFile(file, first.bookRef);
  cli.readLocalBookMeta.mockImplementation(async file => ({
    ...metadata, embeddedCover: "", zlibBookRef: await fs.readFile(file, "utf8"),
  }));
  expect(await service.localHistoryRefs([first, other])).toEqual([first.bookRef]);
  expect(await service.downloadHistoryBook(first.bookRef)).toMatchObject({ alreadyLocal: true, filePath: file });
  expect(cli.download).not.toHaveBeenCalled();
  expect(cli.readLocalBookMeta).toHaveBeenCalledTimes(1);
  await fs.unlink(file);
  await fs.writeFile(file, other.bookRef);
  expect(await service.localHistoryRefs([first, other])).toEqual([other.bookRef]);
  expect(cli.readLocalBookMeta).toHaveBeenCalledTimes(2);
});

it("reports a pre-existing book when only the downloaded bytes establish identity", async () => {
  const { cli, service } = fixture("test.txt");
  const file = path.join(root, "从其他设备导入.txt");
  await fs.writeFile(file, "original");
  const book = { bookRef: "17:abc", extension: "txt" };
  expect(await service.localHistoryRefs([book])).toEqual([]);
  expect(await service.downloadHistoryBook(book.bookRef)).toMatchObject({ alreadyLocal: true, filePath: file });
  expect(await service.localHistoryRefs([book])).toEqual([book.bookRef]);
  expect(cli.download).toHaveBeenCalledOnce();
  expect(await fs.readdir(root)).toEqual(["从其他设备导入.txt"]);
});

it("rejects an unsupported history download in staging while allowing the original discovery download", async () => {
  const { service } = fixture("test.zip");
  await expect(service.downloadHistoryBook("18:abc")).rejects.toThrow("实际格式");
  expect(await fs.readdir(root)).toEqual([]);
  expect(await service.localHistoryRefs([{ bookRef: "18:abc" }])).toEqual([]);
  expect(await service.download("18:abc")).toMatchObject({ filePath: path.join(root, "test.zip") });
});

it("reads v0.0.16 metadata candidates, their source names and embedded ISBN records", () => {
  const row = { title: "Test", sources: ["Douban"], identifiers: [{ scheme: "isbn", value: "0441172717" }] };
  expect(parseMetaMatches(JSON.stringify({ current: { title: "Old" }, candidates: [row] }))).toMatchObject([
    { title: "Test", source: "Douban", isbn: "9780441172719" },
  ]);
  expect(parseMetaMatches(JSON.stringify({ results: [row] }))).toHaveLength(1);
});
