import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zipSync, strToU8 } from "fflate";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DownloadedBookCovers } from "../electron/router/downloadedBookCovers";
import { listDownloadedBooks } from "../electron/router/downloadedBooks";
import { updateReaderMetadata } from "../electron/router/localReader";
import { BookCoverCache } from "../electron/storage/bookCoverCache";
import { KnowledgeDatabase } from "../electron/storage/database";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 101, 0, 70, 0, 0xff, 0xd9]);
vi.mock("electron", () => ({
  nativeImage: { createFromBuffer: (data: Buffer) => ({
    isEmpty: () => !data.equals(jpeg), getSize: () => ({ width: 70, height: 101 }), toJPEG: () => jpeg,
  }) },
}));

const url = "https://covers.openlibrary.org/b/id/123-M.jpg";
const image = "data:image/jpeg;base64," + jpeg.toString("base64");
let root: string;
let downloads: string;
let dbFile: string;
let db: KnowledgeDatabase;
const fetcher = vi.fn(() => Promise.resolve(new Response(new Uint8Array(jpeg))));

function services() {
  const cli = {
    getDownloadDir: () => downloads,
    download: async (_ref: string, destination?: string) => {
      const filePath = path.join(destination!, "本地书.txt");
      await fs.writeFile(filePath, "edition A");
      return { directory: destination!, filePath, output: filePath };
    },
    readLocalBookMeta: async () => { throw new Error("no metadata"); },
    embedEpubCover: async () => { throw new Error("no embedded cover"); },
    extractBookCover: async () => null,
  };
  return new DownloadedBookCovers(cli, new BookCoverCache(root), db);
}

function epub(title: string) {
  return zipSync({
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'),
    "book.opf": strToU8(`<package><metadata><title>${title}</title></metadata></package>`),
  });
}

async function prepareLegacyHint(file: string) {
  const stat = await fs.stat(file);
  const revision = [stat.dev, stat.ino, stat.size, stat.mtimeMs].join(":");
  const key = "download.cover." + createHash("sha256").update(await fs.realpath(file)).digest("hex");
  db.setSetting(key, JSON.stringify({ revision, hint: { coverUrl: url } }));
  expect(await new BookCoverCache(root).get(url, true)).toBe(image);
  db.close();
  const old = new DatabaseSync(dbFile);
  old.prepare("DELETE FROM app_kv WHERE key = ?").run("schema.download-cover-hints.v2");
  old.close();
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cover-identity-"));
  downloads = path.join(root, "downloads");
  await fs.mkdir(downloads);
  dbFile = path.join(root, "state.db");
  db = new KnowledgeDatabase(dbFile);
  fetcher.mockClear().mockImplementation(() => Promise.resolve(new Response(new Uint8Array(jpeg))));
  vi.stubGlobal("fetch", fetcher);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  db.close();
  await fs.rm(root, { recursive: true, force: true });
});

it("finds a saved cover offline after rename, move and copy across restarts, without giving it to a replacement", async () => {
  const service = services();
  const { filePath } = await service.download("1:abc", { coverUrl: url });
  expect(await service.preview(filePath)).toBe(image);
  await fs.utimes(filePath, 100, 100);
  const [before] = await listDownloadedBooks(downloads);
  const shelf = path.join(downloads, "分类");
  await fs.mkdir(shelf);
  const moved = path.join(shelf, "改名.txt");
  await fs.rename(filePath, moved);
  await fs.writeFile(filePath, "edition B");
  await fs.utimes(filePath, 100, 100);
  const replacement = (await listDownloadedBooks(downloads)).find(file => file.filePath === filePath)!;
  expect(replacement.modifiedAt).toBe(before!.modifiedAt);
  expect(replacement.sizeBytes).toBe(before!.sizeBytes);
  expect(replacement.fileRevision).not.toBe(before!.fileRevision);
  const copy = path.join(shelf, "副本.txt");
  await fs.copyFile(moved, copy);
  db.close();
  db = new KnowledgeDatabase(dbFile);
  fetcher.mockRejectedValue(new Error("offline"));
  const restarted = services();
  expect(await restarted.preview(moved)).toBe(image);
  expect(await restarted.preview(copy)).toBe(image);
  expect(await restarted.preview(filePath)).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("recovers a legacy path-only hint even when its file was renamed before upgrade", async () => {
  const file = path.join(downloads, "原名.txt");
  await fs.writeFile(file, "edition A");
  await prepareLegacyHint(file);
  const moved = path.join(downloads, "现在的名字.txt");
  await fs.rename(file, moved);
  await fs.writeFile(file, "edition B");
  db = new KnowledgeDatabase(dbFile);
  fetcher.mockRejectedValue(new Error("offline"));
  expect(await services().preview(moved)).toBe(image);
  expect(await services().preview(file)).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("retains a legacy cached cover across the first controlled metadata edit, rename and restart", async () => {
  const original = path.join(downloads, "旧名.epub");
  await fs.writeFile(original, epub("旧书名"));
  await prepareLegacyHint(original);
  db = new KnowledgeDatabase(dbFile);
  fetcher.mockRejectedValue(new Error("offline"));
  const service = services();
  const updated = await updateReaderMetadata(db, downloads, original, async staged => {
    const filePath = path.join(path.dirname(staged), "新名.epub");
    await fs.writeFile(filePath, epub("更正后的书名"));
    return { filePath, output: filePath };
  }, (file, id) => service.rememberCoverBeforeMetadataEdit(file, id));
  db.close();
  db = new KnowledgeDatabase(dbFile);
  expect(await services().preview(updated.filePath)).toBe(image);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("removes cover hint keys that the revision index superseded, keeping path keys for filesystems without inodes", () => {
  db.close();
  const raw = new DatabaseSync(dbFile);
  const put = raw.prepare("INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, '')");
  put.run("download.cover.with-inode", JSON.stringify({ revision: "1:42:10:5", hint: { coverUrl: url } }));
  put.run("download.cover.no-inode", JSON.stringify({ revision: "1:0:10:5", hint: { coverUrl: url } }));
  put.run("download.cover-legacy.1:7:10:5", "");
  put.run("download.cover-legacy.1:8:10:5", JSON.stringify({ coverUrl: url }));
  raw.prepare("DELETE FROM app_kv WHERE key = 'schema.download-cover-hints.v3'").run();
  raw.close();
  db = new KnowledgeDatabase(dbFile);
  expect(db.getSetting("download.cover.with-inode")).toBeNull();
  expect(db.getSetting("download.cover-legacy.1:7:10:5")).toBeNull();
  expect(db.getSetting("download.cover.no-inode")).not.toBeNull();
  expect(db.getSetting("download.cover-legacy.1:8:10:5")).not.toBeNull();
});
