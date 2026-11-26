import { constants, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { LocalBookImportResult } from "../../src/types/desktop";
import { bookDirectory, isBookFileName, resolveDownloadedBook } from "./downloadedBooks";
import type { DownloadedBookCovers } from "./downloadedBookCovers";
import { pastedTextEpub } from "./pastedTextEpub";

type Publisher = Pick<DownloadedBookCovers, "publishStagedBook">;

/** Bounds a folder import so choosing a home or system folder cannot walk the whole disk. */
export const FOLDER_IMPORT_LIMITS = { depth: 8, entries: 20_000, books: 1_000 };

export function importResult(canceled = false): LocalBookImportResult {
  return { added: 0, existing: 0, failures: [], canceled };
}

function reason(error: unknown) {
  switch ((error as NodeJS.ErrnoException)?.code) {
    case "ENOENT": return "文件已移动或不存在";
    case "EACCES": case "EPERM": return "没有读取或写入权限";
    case "ENOSPC": return "磁盘空间不足";
    default: return error instanceof Error ? error.message : "文件读取失败";
  }
}

async function stageBook(root: string, name: string, write: (staged: string) => Promise<void>, publisher: Publisher) {
  const staging = await fs.mkdtemp(path.join(root, ".import-"));
  try {
    const staged = path.join(staging, name);
    await write(staged);
    return await publisher.publishStagedBook(root, staged);
  } finally {
    await fs.rm(staging, { force: true, recursive: true });
  }
}

export async function importBookText(root: string, input: { title: string; text: string }, publisher: Publisher) {
  const { bytes, fileName } = pastedTextEpub(input);
  await fs.mkdir(root, { recursive: true });
  const result = importResult();
  const file = await stageBook(root, fileName, staged => fs.writeFile(staged, bytes, { mode: 0o600 }), publisher);
  result[file.added ? "added" : "existing"]++;
  return result;
}

/** Accept only selections returned by the main process's native picker. */
export async function importSelectedBooks(
  root: string, mode: "files" | "directory", selected: string[], publisher: Publisher, limits = FOLDER_IMPORT_LIMITS,
) {
  const result = importResult();
  await fs.mkdir(root, { recursive: true });
  const shelf = await fs.realpath(root);
  let entries = 0;
  let books = 0;
  let stopped = false;
  let skippedDeep = false;
  let selectionName = "";

  async function importFile(file: string) {
    try {
      if (!isBookFileName(path.basename(file))) throw new Error("暂不支持这种文件格式");
      if (await fs.realpath(file) !== file) throw new Error("请直接选择原文件");
      if (await resolveDownloadedBook(shelf, file).catch(() => null)) {
        result.existing++;
        return;
      }
      const saved = await stageBook(root, path.basename(file), async staged => {
        // Read from one verified descriptor and copy in chunks, including large PDFs.
        const source = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        try {
          const initial = await source.stat();
          if (!initial.isFile() || !initial.size) throw new Error("文件为空或不是普通文件");
          if (await fs.realpath(file) !== file) throw new Error("文件位置已改变");
          const verified = await fs.lstat(file);
          if (initial.dev !== verified.dev || initial.ino !== verified.ino) throw new Error("文件已改变，请重试");
          await pipeline(source.createReadStream({ autoClose: false }), createWriteStream(staged, { flags: "wx", mode: 0o600 }));
          const after = await source.stat();
          if (after.size !== initial.size || after.mtimeMs !== initial.mtimeMs) throw new Error("复制时文件已改变，请重试");
        } finally { await source.close(); }
      }, publisher);
      result[saved.added ? "added" : "existing"]++;
    } catch (err) { result.failures.push({ name: path.basename(file), message: reason(err) }); }
  }

  function stop(name: string, message: string) {
    if (stopped) return;
    stopped = true;
    result.failures.push({ name, message });
  }

  async function scan(folder: string, depth: number) {
    try {
      if (await fs.realpath(folder) !== folder) throw new Error("文件夹位置已改变");
      const dir = await fs.opendir(folder);
      for await (const entry of dir) {
        if (stopped) break;
        if (++entries > limits.entries) {
          stop(selectionName, `文件夹内容过多，已在扫描 ${limits.entries} 项后停止。请选择存放电子书的具体文件夹。`);
          break;
        }
        const file = path.join(folder, entry.name);
        if (entry.isDirectory() && bookDirectory(entry.name) && file !== shelf) {
          if (depth < limits.depth) await scan(file, depth + 1);
          else if (!skippedDeep) {
            skippedDeep = true;
            result.failures.push({ name: entry.name, message: `已跳过超过 ${limits.depth} 层的子文件夹。` });
          }
        } else if (entry.isFile() && isBookFileName(entry.name)) {
          if (++books > limits.books) {
            stop(selectionName, `单次最多导入 ${limits.books} 本书，其余文件未导入。可分批导入剩余文件夹。`);
            break;
          }
          await importFile(file);
        }
      }
    } catch (err) { result.failures.push({ name: path.basename(folder), message: reason(err) }); }
  }

  for (const selection of selected) {
    try {
      const stat = await fs.lstat(selection);
      if (stat.isSymbolicLink()) throw new Error("请选择原文件或原文件夹");
      const file = await fs.realpath(selection);
      selectionName = path.basename(file);
      if (mode === "directory" && stat.isDirectory()) await scan(file, 1);
      else if (mode === "files" && stat.isFile()) await importFile(file);
      else throw new Error("选择的文件类型无效");
    } catch (err) { result.failures.push({ name: path.basename(selection), message: reason(err) }); }
  }
  return result;
}
