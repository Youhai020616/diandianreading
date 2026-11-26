import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isValidHistoryOnlyRef, parseMetaMatches, ZlibCliService } from "../electron/router/zlibCliService";

const runCli = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async importOriginal => {
  const child = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return { ...child, execFile: Object.assign(vi.fn(), { [promisify.custom]: runCli }) };
});

let service: ZlibCliService;
let directory: string;
const book = { id: "123:fed123", hash: "fed123", name: "Book &amp; Author", authors: ["A"], extension: "EPUB", size: "3 MB" };
const legacy = { id: "AB123", name: "Old book", url: "https://books.example/book/AB123/title", download_url: "/dl/file" };
const page = (items: unknown[], current = 1, total = 2) => ({
  stdout: JSON.stringify({ items, page: current, total_pages: total }), stderr: "",
});

beforeEach(async () => {
  vi.stubEnv("DIANDIAN_ZLIB_BIN", process.execPath);
  runCli.mockReset();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "diandian-zlib-history-"));
  service = new ZlibCliService(directory);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(directory, { recursive: true, force: true });
});

it("paginates the CLI history envelope, separates cached pages, and refreshes after account or download changes", async () => {
  runCli.mockResolvedValueOnce(page([book])).mockResolvedValueOnce(page([legacy], 2));
  expect(await service.getDownloadHistoryPage(1)).toMatchObject({
    books: [{ title: "Book & Author", bookRef: "123:fed123", author: "A", extension: "epub", size: "3 MB" }], hasMore: true,
  });
  expect(await service.getDownloadHistoryPage(2)).toMatchObject({ books: [{ bookRef: "history:AB123" }], hasMore: false });
  expect(await service.getHistory()).toHaveLength(1);
  expect(runCli.mock.calls.map(call => call[1])).toEqual([["history", "--json", "--page", "1"], ["history", "--json", "--page", "2"]]);
  service.invalidateFeedCache();
  runCli.mockResolvedValueOnce(page([], 1, 0));
  expect(await service.getDownloadHistoryPage(1)).toEqual({ books: [], hasMore: false });
  runCli.mockResolvedValueOnce({ stdout: "{}", stderr: "" }).mockResolvedValueOnce(page([book], 1, 0));
  await service.download(book.id);
  expect(await service.getDownloadHistoryPage(1)).toMatchObject({ hasMore: true, books: [{ bookRef: book.id }] });
  runCli.mockResolvedValueOnce(page([], 1, 0));
  expect(await service.getDownloadHistoryPage(1, true)).toEqual({ books: [], hasMore: false });
});

it("only offers legacy downloads the CLI can resolve and keeps the direct URL inside the CLI", async () => {
  runCli.mockResolvedValueOnce(page([
    legacy, { ...legacy, id: "--delete" }, { ...legacy, download_url: "" }, { ...legacy, url: "" },
    { id: "999", name: "Numeric", url: "/book/999/name", download_url: "/dl/file" },
  ]));
  const result = await service.getDownloadHistoryPage(1);
  expect(result.books.map(item => item.bookRef)).toEqual(["history:AB123", "", "", "", "history:999"]);
  expect(JSON.stringify(result)).not.toContain("/dl/file");
  runCli.mockResolvedValueOnce(page([legacy, book], 21, 30));
  expect((await service.getDownloadHistoryPage(21)).books.map(item => item.bookRef)).toEqual(["", book.id]);

  const file = path.join(directory, "Book.epub");
  await fs.writeFile(file, "book fixture");
  runCli.mockResolvedValueOnce({ stdout: JSON.stringify({ path: file }), stderr: "" });
  expect(await service.download("history:AB123")).toMatchObject({ filePath: file });
  expect(runCli.mock.lastCall?.[1]).toEqual(["history", "--download", "AB123", "--dir", directory, "--json"]);
  for (const ref of ["history:--delete", "history:../../book", "https://books.example/book/1", "history:12:abc"]) {
    expect(isValidHistoryOnlyRef(ref)).toBe(false);
    await expect(service.download(ref)).rejects.toThrow("无效");
  }
});

it("distinguishes failures from empty history and allows the same page to be retried", async () => {
  runCli.mockRejectedValueOnce({ code: 3, stderr: "not logged in" });
  await expect(service.getDownloadHistoryPage(1)).rejects.toThrow("连接与偏好");
  runCli.mockResolvedValueOnce({ stdout: "{}" });
  await expect(service.getDownloadHistoryPage(1)).rejects.toThrow("格式异常");
  runCli.mockResolvedValueOnce({ stdout: "please sign in" });
  await expect(service.getDownloadHistoryPage(1)).rejects.toThrow("无法解析");
  await expect(service.getDownloadHistoryPage(1.5)).rejects.toThrow("正整数");
  runCli.mockResolvedValueOnce(page([book], 1, 1));
  await expect(service.getDownloadHistoryPage(2)).resolves.toEqual({ books: [], hasMore: false });
});

it("uses an embedded Z-Library ID independently of ISBN and ignores invalid embedded references", () => {
  const metadata = (value: string) => parseMetaMatches(JSON.stringify({
    title: "Book", identifiers: [{ scheme: "isbn", value: "9780743273565" }, { scheme: "zlib-id", value }],
  }))[0];
  expect(metadata("42:fed123")).toMatchObject({ isbn: "9780743273565", zlibBookRef: "42:fed123" });
  expect(metadata("https://books.example/dl/file")).not.toHaveProperty("zlibBookRef");
});
