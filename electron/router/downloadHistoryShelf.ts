import fs from "node:fs/promises";
import path from "node:path";
import type { DownloadedBookFile } from "../../src/types/desktop";
import { fileDigest, readReceipt, type DownloadIndex } from "./downloadReceipts";
import { listDownloadedBooks, resolveDownloadedBook } from "./downloadedBooks";
import { isValidZlibBookRef, type ZlibBookItem } from "./zlibCliService";

export type HistoryBookRef = Pick<ZlibBookItem, "bookRef"> & Partial<Pick<ZlibBookItem, "extension">>;
type CachedIdentity = { stamp: string; digest?: Promise<string | null>; embeddedRef?: Promise<string | null> };

export function remoteReceiptKey(ref: string): string {
  return "zlib." + ref.trim();
}

/** Resolve an account record to a current, readable local file, including renamed and app-edited copies. */
export class DownloadHistoryShelf {
  private readonly identities = new Map<string, CachedIdentity>();

  constructor(private readonly store: DownloadIndex, private readonly readEpubRef: (file: string) => Promise<string | null>) {}

  private readIdentity(root: string, book: DownloadedBookFile, field: "digest" | "embeddedRef") {
    const { filePath, fileRevision, sizeBytes, modifiedAt } = book;
    const stamp = [fileRevision, sizeBytes, modifiedAt].join(":");
    let entry = this.identities.get(filePath);
    if (!entry || entry.stamp !== stamp) {
      entry = { stamp };
      this.identities.set(filePath, entry);
    }
    entry[field] ??= (async () => {
      const file = await resolveDownloadedBook(root, filePath);
      const value = field === "digest" ? await fileDigest(file) : await this.readEpubRef(file);
      const stat = await fs.lstat(file);
      const current = [stat.dev, stat.ino, stat.ctimeMs, stat.size, stat.mtimeMs].join(":");
      return current === stamp && stat.isFile() ? value : null;
    })().catch(() => {
      if (this.identities.get(filePath) === entry) delete entry[field];
      return null;
    });
    return entry[field];
  }

  async find(root: string, books: readonly HistoryBookRef[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    if (!books.length) return found;
    const files = await listDownloadedBooks(root);
    const paths = new Set(files.map(file => file.filePath));
    for (const file of this.identities.keys()) if (!paths.has(file)) this.identities.delete(file);
    if (!files.length) return found;

    const refsByDocument = new Map<string, string[]>();
    const sizes = new Set<string>();
    for (const { bookRef } of books) {
      const receipt = readReceipt(this.store, remoteReceiptKey(bookRef));
      if (!receipt) continue;
      const format = path.extname(receipt.file).slice(1).toLowerCase();
      const document = this.store.readerDocumentId?.(receipt.hash) ?? receipt.hash;
      const key = format + ":" + document;
      const refs = refsByDocument.get(key) ?? [];
      refs.push(bookRef);
      refsByDocument.set(key, refs);
      sizes.add(format + ":" + receipt.size);
      for (const size of this.store.readerRevisionSizes?.(document) ?? []) sizes.add(format + ":" + size);
    }
    for (const file of files) {
      if (!sizes.has(file.format + ":" + file.sizeBytes)) continue;
      const digest = await this.readIdentity(root, file, "digest");
      if (!digest) continue;
      const document = this.store.readerDocumentId?.(digest) ?? digest;
      for (const ref of refsByDocument.get(file.format + ":" + document) ?? []) found.set(ref, file.filePath);
    }

    // Older and externally imported EPUBs can carry the CLI's edition-specific zlib-id.
    // Only inspect packages while an unresolved EPUB is wanted; never infer identity from a title alone.
    const needed = new Set(books.filter(({ bookRef, extension }) => !found.has(bookRef)
      && isValidZlibBookRef(bookRef) && (!extension || extension.toLowerCase() === "epub")).map(book => book.bookRef));
    const epubs = files.filter(file => file.format === "epub");
    for (let i = 0; needed.size && i < epubs.length; i += 4) {
      await Promise.all(epubs.slice(i, i + 4).map(async file => {
        const ref = await this.readIdentity(root, file, "embeddedRef");
        if (ref && needed.delete(ref)) found.set(ref, file.filePath);
      }));
    }
    return found;
  }
}
