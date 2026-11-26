import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookCoverCache } from "../electron/storage/bookCoverCache";
import { KnowledgeDatabase } from "../electron/storage/database";
import { parseWeReadNotebooksResponse, syncWeReadBooksIntoDatabase } from "../electron/importers/wereadSyncService";

// Keep the Node test suite independent of a graphical Electron session.
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 101, 0, 70, 0, 0xff, 0xd9]);
vi.mock("electron", () => ({
  nativeImage: {
    createFromBuffer: (bytes: Buffer) => ({
      isEmpty: () => !bytes.equals(jpeg),
      getSize: () => ({ width: 70, height: 101 }),
      toJPEG: () => jpeg,
    }),
  },
}));

const url = "https://cdn.weread.qq.com/cover/example.jpg";
const picture = () => new Response(new Uint8Array(jpeg));
let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "book-covers-")); });
afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("library cover cache", () => {
  it("coalesces concurrent downloads, persists the result across restarts, and repairs a truncated file", async () => {
    const fetcher = vi.fn(async () => picture());
    vi.stubGlobal("fetch", fetcher);
    const cache = new BookCoverCache(directory);
    const [first, second] = await Promise.all([cache.get(url), cache.get(url)]);
    expect(first).toBe(`data:image/jpeg;base64,${jpeg.toString("base64")}`);
    expect(second).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const reopened = new BookCoverCache(directory);
    expect(await reopened.get(url)).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const cacheDir = path.join(directory, "state", "book-covers");
    const [name] = await fs.readdir(cacheDir);
    await fs.writeFile(path.join(cacheDir, name!), jpeg.subarray(0, 3));
    expect(await reopened.get(url)).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects missing, unreadable and oversized responses, and can retry the same URL", async () => {
    const huge = Buffer.from(jpeg);
    huge.writeUInt16BE(30_000, 7);
    huge.writeUInt16BE(30_000, 9);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response("not an image"))
      .mockResolvedValueOnce(new Response(new Uint8Array(huge)))
      .mockResolvedValueOnce(new Response(new Uint8Array(4 * 1024 * 1024 + 1)))
      .mockResolvedValueOnce(picture());
    vi.stubGlobal("fetch", fetcher);
    const cache = new BookCoverCache(directory);
    for (let i = 0; i < 4; i++) expect(await cache.get(url)).toBeNull();
    expect(await fs.readdir(directory)).toEqual([]);
    expect(await cache.get(url)).toContain("data:image/jpeg;base64,");
  });

  it("checks the destination of each redirect, including Open Library's archive image hosts", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.redirect("https://example.org/image"))
      .mockResolvedValueOnce(Response.redirect("https://archive.org/download/cover.jpg"))
      .mockResolvedValueOnce(Response.redirect("https://ia800000.us.archive.org/cover.jpg"))
      .mockResolvedValueOnce(picture());
    vi.stubGlobal("fetch", fetcher);
    const cache = new BookCoverCache(directory);
    expect(await cache.get("https://example.org/image")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await cache.get(url)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await cache.get("https://covers.openlibrary.org/b/id/7-M.jpg")).toContain("data:image/jpeg");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("imports notes during cover outages, keeps a working cover, and replaces a broken one on resync", async () => {
    const db = new KnowledgeDatabase(path.join(directory, "library.db"));
    const cookies = [{ name: "wr_vid", value: "test", domain: "weread.qq.com", path: "/", secure: true, httpOnly: true }];
    const [shelfBook] = parseWeReadNotebooksResponse({ books: [{ bookId: "1001", book: { title: "试读", cover: url } }] });
    const old = "https://cdn.weread.qq.com/old-cover.jpg";
    vi.stubGlobal("fetch", async (target: string) => Response.json(target.includes("bookmarklist")
      ? { updated: [{ markText: "第一条划线" }] } : { reviews: [] }));
    try {
      const first = await syncWeReadBooksIntoDatabase(db, cookies, [shelfBook!], async () => { throw new Error("offline"); });
      const id = first.details[0]!.localBookId;
      expect(first.importedCount).toBe(1);
      expect(db.getBook(id)?.coverUrl).toBe("");
      await syncWeReadBooksIntoDatabase(db, cookies, [shelfBook!], async () => "cached");
      expect(db.getBook(id)?.coverUrl).toBe(url);

      db.updateBook(id, { coverUrl: old });
      await syncWeReadBooksIntoDatabase(db, cookies, [shelfBook!], async () => "cached");
      expect(db.getBook(id)?.coverUrl).toBe(old);
      const resync = await syncWeReadBooksIntoDatabase(db, cookies, [shelfBook!], async (target) => target === old ? null : "cached");
      expect(db.getBook(id)?.coverUrl).toBe(url);
      expect(resync.deduplicatedCount).toBe(1);
      expect(db.listHighlights(id)).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
