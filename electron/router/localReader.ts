import { createHash } from "node:crypto";
import { closeSync, constants, createReadStream, lstatSync, openSync, renameSync, unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fromBufferPromise } from "yauzl";
import type { DownloadedBookFile, OpenReaderBook } from "../../src/types/desktop";
import type { KnowledgeDatabase } from "../storage/database";
import { listDownloadedBooks, resolveDownloadedBook } from "./downloadedBooks";
import { EPUB_LIMITS, isEpubTextEntry } from "./epubLimits";

async function validateEpub(bytes: Buffer): Promise<void> {
  const invalid = () => new Error("无法读取 EPUB 的书籍目录。文件可能不完整，请尝试用系统阅读器打开。");
  const archive = await fromBufferPromise(bytes, { strictFileNames: true }).catch(() => { throw invalid(); });
  try {
    if (archive.entryCount > EPUB_LIMITS.entries) throw new Error("电子书内的资源过多，请用系统阅读器打开。");
    let hasContainer = false;
    let uncompressed = 0;
    for await (const entry of archive.eachEntry()) {
      uncompressed += entry.uncompressedSize;
      const entryLimit = isEpubTextEntry(entry.fileName) ? EPUB_LIMITS.textBytes : EPUB_LIMITS.entryBytes;
      if (entry.uncompressedSize > entryLimit || uncompressed > EPUB_LIMITS.totalBytes) {
        throw new Error("电子书解压后的资源过大，请用系统阅读器打开。");
      }
      if (entry.fileName === "META-INF/container.xml") hasContainer = entry.canDecodeFileData() && entry.uncompressedSize > 0;
    }
    if (!hasContainer) throw invalid();
  } finally {
    archive.close();
  }
}

async function readScopedFile(downloadDir: string, filePath: string) {
  const realPath = await resolveDownloadedBook(downloadDir, filePath);
  if (path.extname(realPath).toLowerCase() !== ".epub") throw new Error("工作台阅读目前支持 EPUB 文件。");
  const handle = await fs.open(realPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size) throw new Error("电子书已移动或为空，请刷新书库。");
    if (stat.size > EPUB_LIMITS.fileBytes) {
      throw new Error(`这本书超过 ${EPUB_LIMITS.fileBytes / 1024 / 1024} MB，请用系统阅读器打开。`);
    }
    const verified = await fs.stat(await resolveDownloadedBook(downloadDir, filePath));
    const changed = () => new Error("读取时文件已改变，请重新打开。");
    if (stat.dev !== verified.dev || stat.ino !== verified.ino) throw changed();
    const bytes = Buffer.allocUnsafe(stat.size);
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw changed();
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw changed();
    const file: DownloadedBookFile = {
      filePath, fileName: path.basename(filePath), format: "epub", sizeBytes: stat.size, modifiedAt: stat.mtimeMs,
    };
    return { bytes, file, contentHash: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    await handle.close();
  }
}

export async function openReaderBook(db: KnowledgeDatabase, downloadDir: string, filePath: string): Promise<OpenReaderBook> {
  const { bytes, file, contentHash } = await readScopedFile(downloadDir, filePath);
  await validateEpub(bytes);
  const documentId = db.readerDocumentId(contentHash);
  const state = db.openReaderDocument(documentId, file.filePath, file.sizeBytes);
  return { bytes, documentId, ...state };
}

export async function resolveReaderHighlight(db: KnowledgeDatabase, downloadDir: string, highlightId: string) {
  const target = db.readerHighlightTarget(highlightId);
  async function match(candidate: string) {
    try {
      const { file, contentHash } = await readScopedFile(downloadDir, candidate);
      if (db.readerDocumentId(contentHash) === target.documentId) return { file, cfi: target.cfi };
    } catch {
      // A download can be removed or replaced while resolving a saved passage.
    }
    return null;
  }
  const previous = await match(target.filePath);
  if (previous) return previous;
  const sizes = new Set(db.readerRevisionSizes(target.documentId));
  for (const file of await listDownloadedBooks(downloadDir)) {
    if (file.format === "epub" && sizes.has(file.sizeBytes) && file.filePath !== target.filePath) {
      const moved = await match(file.filePath);
      if (moved) return moved;
    }
  }
  throw new Error("下载目录里找不到这条划线对应的 EPUB。将原文件放回下载目录后即可跳回原文。");
}

async function hashRevision(file: string) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { hash: hash.digest("hex"), size };
}

/** Record both known byte revisions before making the edited EPUB visible to readers. */
export async function updateReaderMetadata<T extends { filePath: string; output: string }>(
  db: KnowledgeDatabase, downloadDir: string, filePath: string, write: (file: string) => Promise<T>,
  beforeEdit?: (file: string, beforeSha256: string) => Promise<void>,
): Promise<T> {
  if (!path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== ".epub") return write(filePath);
  const root = await fs.realpath(downloadDir).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  });
  if (!root) return write(filePath);
  const displayDir = path.dirname(filePath);
  const candidate = path.join(await fs.realpath(displayDir), path.basename(filePath));
  const relative = path.relative(root, candidate);
  if (relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return write(filePath);
  const original = await resolveDownloadedBook(root, candidate);
  const directory = path.dirname(original);
  const stat = await fs.lstat(original, { bigint: true });
  const staging = await fs.mkdtemp(path.join(directory, ".reader-meta-"));
  try {
    const staged = path.join(staging, path.basename(original));
    await fs.copyFile(original, staged);
    const before = await hashRevision(staged);
    const result = await write(staged);
    if (path.dirname(result.filePath) !== staging || path.extname(result.filePath).toLowerCase() !== ".epub"
      || !(await fs.lstat(result.filePath)).isFile()) throw new Error("无法定位元数据写回后的 EPUB。");
    const after = await hashRevision(result.filePath);
    const destination = path.join(directory, path.basename(result.filePath));
    await beforeEdit?.(original, before.hash).catch(() => undefined);
    // Check and publish without yielding so overlapping edits cannot overwrite each other.
    const current = lstatSync(original, { bigint: true });
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.ctimeNs !== stat.ctimeNs || current.size !== stat.size) {
      throw new Error("写回期间文件已改变，请重新读取书目信息。");
    }
    const renaming = destination !== original;
    if (renaming) {
      try { closeSync(openSync(destination, "wx", 0o600)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("目标文件名已存在，请更换书名或取消重命名。");
        throw error;
      }
    }
    try {
      db.registerReaderRevision(filePath, before, after);
      renameSync(result.filePath, destination);
      if (renaming) unlinkSync(original);
    } catch (error) {
      if (renaming) unlinkSync(destination);
      throw error;
    }
    return { ...result, filePath: path.join(displayDir, path.basename(destination)), output: result.output.replaceAll(staging, displayDir) };
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
