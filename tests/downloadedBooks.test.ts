import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { listDownloadedBooks, resolveDownloadedBook } from "../electron/router/downloadedBooks";

let dir: string;
let root: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "diandian-downloads-"));
  root = path.join(dir, "downloads");
});

afterEach(() => fs.rm(dir, { recursive: true, force: true }));

it("reads existing books from disk, including nested files and renames, without the CLI", async () => {
  expect(await listDownloadedBooks(root)).toEqual([]);
  const sub = path.join(root, "文学");
  await fs.mkdir(sub, { recursive: true });
  const first = path.join(root, "书 A.EPUB");
  const second = path.join(sub, "书 B.fb2");
  await fs.writeFile(first, "A");
  await fs.writeFile(second, "BB");
  await fs.utimes(first, 100, 100);
  await fs.utimes(second, 200, 200);
  expect(await listDownloadedBooks(root)).toEqual([
    { filePath: second, fileName: "书 B.fb2", format: "fb2", sizeBytes: 2, modifiedAt: 200_000, fileRevision: expect.any(String) },
    { filePath: first, fileName: "书 A.EPUB", format: "epub", sizeBytes: 1, modifiedAt: 100_000, fileRevision: expect.any(String) },
  ]);
  expect(await resolveDownloadedBook(root, second)).toBe(await fs.realpath(second));
  const renamed = path.join(sub, "改名.EPUB");
  await fs.rename(first, renamed);
  await fs.rm(second);
  expect((await listDownloadedBooks(root)).map(book => book.filePath)).toEqual([renamed]);
  await expect(resolveDownloadedBook(root, first)).rejects.toThrow("已移动");
});

it("omits incomplete, hidden, unsupported and linked files, and opens only listed regular files", async () => {
  const hidden = path.join(root, ".staging");
  await fs.mkdir(hidden, { recursive: true });
  await fs.mkdir(path.join(root, "pending.epub.download"));
  const outside = path.join(dir, "outside");
  await fs.mkdir(outside);
  const outsideBook = path.join(outside, "elsewhere.pdf");
  await fs.writeFile(outsideBook, "book");
  await fs.symlink(outsideBook, path.join(root, "link.pdf"));
  await fs.symlink(outside, path.join(root, "alias"), "dir");
  for (const name of ["sample.epub.part", ".temp.pdf", "~$example.docx", "helper.sh", ".staging/temp.epub", "pending.epub.download/book.epub"]) {
    await fs.writeFile(path.join(root, name), "skip");
  }
  await fs.writeFile(path.join(root, "incomplete.epub"), "");
  expect(await listDownloadedBooks(root)).toEqual([]);
  for (const name of ["link.pdf", "alias/elsewhere.pdf", ".temp.pdf", ".staging/temp.epub", "pending.epub.download/book.epub",
    "~$example.docx", "helper.sh", "incomplete.epub", "../outside/elsewhere.pdf"]) {
    await expect(resolveDownloadedBook(root, path.join(root, name))).rejects.toThrow();
  }
  await expect(resolveDownloadedBook(root, "relative.epub")).rejects.toThrow();
});
