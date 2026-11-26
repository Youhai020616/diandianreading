import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { KnowledgeDatabase } from "../storage/database";
import { listDownloadedBooks, resolveDownloadedBook } from "./downloadedBooks";

export type DownloadIndex = Pick<KnowledgeDatabase, "getSetting" | "setSetting" | "deleteSetting"> &
  Partial<Pick<KnowledgeDatabase, "readerDocumentId" | "readerRevisionSizes">>;

export type DownloadReceipt = { file: string; hash: string; size: number };

export async function fileDigest(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export function readReceipt(store: DownloadIndex, key: string): DownloadReceipt | undefined {
  try {
    const value = JSON.parse(store.getSetting("download.receipt." + key) || "null");
    if (typeof value?.file === "string" && /^[a-f0-9]{64}$/.test(value.hash) && Number.isSafeInteger(value.size)) return value;
  } catch { /* Missing or stale receipts are rebuilt from a completed download. */ }
}

export function writeReceipt(store: DownloadIndex, key: string, receipt: DownloadReceipt) {
  try { store.setSetting("download.receipt." + key, JSON.stringify(receipt)); }
  catch { /* The book is already published. A later import can compare the files directly. */ }
}

/** Verify bytes, including known app-authored revisions; filenames alone cannot establish identity. */
export async function findDownloadedCopy(root: string, receipt: DownloadReceipt, store: DownloadIndex): Promise<DownloadReceipt | undefined> {
  const document = store.readerDocumentId?.(receipt.hash) ?? receipt.hash;
  const sizes = new Set([receipt.size, ...(store.readerRevisionSizes?.(document) ?? [])]);
  const format = path.extname(receipt.file).slice(1).toLowerCase();
  async function check(file: string) {
    // Shelf entries may be moved, deleted or replaced while matching.
    const scoped = await resolveDownloadedBook(root, file).catch(() => null);
    if (!scoped) return;
    const stat = await fs.stat(scoped).catch(() => null);
    if (!stat || !sizes.has(stat.size)) return;
    const hash = await fileDigest(scoped).catch(() => null);
    if (!hash) return;
    const current = await fs.stat(scoped).catch(() => null);
    if (!current || stat.dev !== current.dev || stat.ino !== current.ino || stat.size !== current.size || stat.mtimeMs !== current.mtimeMs) return;
    if (hash === receipt.hash || store.readerDocumentId?.(hash) === document) {
      return { file, size: stat.size, hash };
    }
  }
  const original = await check(receipt.file);
  if (original) return original;
  for (const file of await listDownloadedBooks(root)) {
    if (file.filePath === receipt.file || file.format !== format || !sizes.has(file.sizeBytes)) continue;
    const match = await check(file.filePath);
    if (match) return match;
  }
}

/** Publish without replacing an existing edition. The caller serializes selection and receipt creation. */
export async function publishDownload(staged: string, root: string, hash: string): Promise<DownloadReceipt> {
  const { name, ext } = path.parse(staged);
  const size = (await fs.stat(staged)).size;
  for (let n = 1; ; n++) {
    const file = path.join(root, n === 1 ? name + ext : `${name} (${n})${ext}`);
    try {
      // Publish the already finished file atomically on filesystems supporting hard links.
      try { await fs.link(staged, file); }
      catch (error) {
        if (!["EPERM", "ENOSYS", "EOPNOTSUPP", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        const reservation = await fs.open(file, "wx", 0o600);
        await reservation.close();
        try { await fs.rename(staged, file); }
        catch (cause) { await fs.unlink(file).catch(() => undefined); throw cause; }
      }
      return { file, hash, size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const other = await fs.lstat(file).catch(() => undefined);
      if (other?.isFile() && other.size === size && await fileDigest(file) === hash) return { file, hash, size };
    }
  }
}
