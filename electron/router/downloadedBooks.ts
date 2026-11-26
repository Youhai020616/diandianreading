import fs from "node:fs/promises";
import path from "node:path";
import type { DownloadedBookFile } from "../../src/types/desktop";
import { WEREAD_IMPORT_FORMATS } from "./wereadFormats";

export const ROUTER_EBOOK_EXTENSIONS = [...WEREAD_IMPORT_FORMATS, "docx"];
export const BOOK_FILE_EXTENSIONS = [...ROUTER_EBOOK_EXTENSIONS, "azw", "azw4", "kfx", "fb2", "djvu", "djv", "cbz", "cbr"];
const readableFormats = new Set(BOOK_FILE_EXTENSIONS);

export function isBookFileName(name: string): boolean {
  return visible(name) && readableFormats.has(path.extname(name).slice(1).toLowerCase());
}

function visible(name: string): boolean {
  return !name.startsWith(".") && !name.startsWith("~$");
}

export function bookDirectory(name: string): boolean {
  // Finder packages and temporary download directories can contain embedded .txt or .epub files.
  return visible(name) && !/\.(?:app|epub|download|crdownload|part|tmp)$/i.test(name);
}

async function statIfPresent(filePath: string) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function listDownloadedBooks(downloadDir: string): Promise<DownloadedBookFile[]> {
  const root = path.resolve(downloadDir);
  const rootStat = await statIfPresent(root);
  if (!rootStat) return [];
  if (!rootStat.isDirectory()) throw new Error("下载目录不是有效的文件夹。");

  const books: DownloadedBookFile[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!visible(entry.name)) continue;
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (bookDirectory(entry.name)) await visit(filePath);
        continue;
      }
      const format = path.extname(entry.name).slice(1).toLowerCase();
      if (!entry.isFile() || !readableFormats.has(format)) continue;
      const stat = await statIfPresent(filePath);
      if (stat?.isFile() && stat.size > 0) {
        books.push({ filePath, fileName: entry.name, format, sizeBytes: stat.size, modifiedAt: stat.mtimeMs,
          fileRevision: [stat.dev, stat.ino, stat.ctimeMs].join(":") });
      }
    }
  }
  await visit(root);
  return books.sort((a, b) => b.modifiedAt - a.modifiedAt || a.filePath.localeCompare(b.filePath));
}

export async function resolveDownloadedBook(downloadDir: string, filePath: string): Promise<string> {
  const root = path.resolve(downloadDir);
  const invalid = () => new Error("该电子书已移动或不在下载目录中，请刷新书库。");
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw invalid();
  const candidate = path.resolve(filePath);
  const relative = path.relative(root, candidate);
  const segments = relative.split(path.sep);
  const format = path.extname(candidate).slice(1).toLowerCase();
  if (!relative || path.isAbsolute(relative) || !segments.slice(0, -1).every(bookDirectory)
      || !visible(path.basename(candidate)) || !readableFormats.has(format)) {
    throw invalid();
  }
  const rootStat = await statIfPresent(root);
  if (!rootStat?.isDirectory()) throw invalid();
  const stat = await statIfPresent(candidate);
  if (!stat?.isFile() || stat.size === 0) throw invalid();
  // The resolved relative path must agree, including when a parent directory is a symlink.
  const realRoot = await fs.realpath(root);
  const realFile = await fs.realpath(candidate);
  if (path.relative(realRoot, realFile) !== relative) throw invalid();
  return realFile;
}
