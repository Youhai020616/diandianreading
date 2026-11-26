import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { nativeImage } from "electron";
import type { DownloadCoverHint } from "../../src/types/desktop";
import { canonicalIsbn } from "../isbn";
import { makeCoverThumbnail, type BookCoverCache } from "../storage/bookCoverCache";
import { fileDigest as digest, findDownloadedCopy, publishDownload, readReceipt, writeReceipt, type DownloadIndex, type DownloadReceipt } from "./downloadReceipts";
import { DownloadHistoryShelf, remoteReceiptKey, type HistoryBookRef } from "./downloadHistoryShelf";
import { isBookFileName, resolveDownloadedBook } from "./downloadedBooks";
import { findLegacyCoveredEpub } from "./legacyCoveredEpub";
import { readEpubCover } from "./epubCover";
import { searchOnlineBookMetadata } from "./metadataService";
import { isValidHistoryOnlyRef, isValidZlibBookRef, type ZlibCliService } from "./zlibCliService";

type Cover = { image: string; url?: string };
type Cli = Pick<ZlibCliService, "getDownloadDir" | "download" | "readLocalBookMeta" | "embedEpubCover" | "extractBookCover">;

async function revision(file: string): Promise<string> {
  const stat = await fs.stat(file);
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

type DownloadResult = { directory: string; filePath: string; output: string };
type HistoryDownloadResult = DownloadResult & { alreadyLocal: boolean };
const publishing = new Map<string, Promise<DownloadReceipt & { added: boolean }>>();

function requireShelfFormat(file: string) {
  if (!isBookFileName(path.basename(file))) throw new Error("下载文件的实际格式不受本地书库支持。");
}

async function shareInFlight<T>(pending: Map<string, Promise<T>>, key: string, start: () => Promise<T>): Promise<T> {
  const current = pending.get(key);
  if (current) return current;
  const task = start();
  pending.set(key, task);
  try { return await task; }
  finally { pending.delete(key); }
}

async function localCover(file: string, cli: Cli): Promise<string | null> {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".epub") return readEpubCover(file);
  if ([".mobi", ".azw", ".azw3", ".fb2"].includes(ext)) {
    const bytes = await cli.extractBookCover(file).catch(() => null);
    const jpeg = bytes && await makeCoverThumbnail(bytes);
    if (jpeg) return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  }
  if (ext === ".pdf" && (process.platform === "darwin" || process.platform === "win32")) {
    const preview = await nativeImage.createThumbnailFromPath(file, { width: 180, height: 260 }).catch(() => null);
    if (preview && !preview.isEmpty()) return preview.toDataURL();
  }
  return null;
}

export class DownloadedBookCovers {
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly downloading = new Map<string, Promise<HistoryDownloadResult>>();
  private readonly importingHistory = new Map<string, Promise<HistoryDownloadResult>>();
  private readonly historyShelf: DownloadHistoryShelf;
  // Limit concurrent catalogue lookups while a large shelf is being opened.
  private readonly previewSlots: Promise<unknown>[] = Array.from({ length: 3 }, () => Promise.resolve());

  constructor(private readonly cli: Cli, private readonly images: Pick<BookCoverCache, "get">,
    private readonly settings: DownloadIndex) {
    this.historyShelf = new DownloadHistoryShelf(settings, async file => (await cli.readLocalBookMeta(file)).zlibBookRef ?? null);
  }

  private async findCover(file: string, hint: DownloadCoverHint, embed: boolean): Promise<Cover | null> {
    const local = await localCover(file, this.cli);
    if (local) return { image: local };
    return this.findFallbackCover(file, hint, embed);
  }

  private async findFallbackCover(file: string, hint: DownloadCoverHint, embed: boolean): Promise<Cover | null> {
    const fromUrl = async (url: string): Promise<Cover | null> => {
      const image = await this.images.get(url, true);
      return image ? { image, url } : null;
    };
    let cover = hint.coverUrl ? await fromUrl(hint.coverUrl) : null;
    const meta = (!cover || embed) ? await this.cli.readLocalBookMeta(file).catch(() => null) : null;
    // Keep embedded artwork even when we cannot generate its preview (for example, a standalone SVG).
    const mayEmbed = embed && meta !== null && !meta.embeddedCover;
    if (!cover) {
      const name = path.parse(file).name;
      const isbn = canonicalIsbn(meta?.isbn) || canonicalIsbn(hint.isbn)
        || canonicalIsbn(name.match(/(?<!\d)97[89][\d-]{10,17}(?!\d)/)?.[0]);
      const named = /^(.+?)\s+-\s+(.+)$/.exec(name);
      const title = hint.title?.trim() || meta?.title || named?.[1] || "";
      const author = hint.author?.trim() || meta?.authors || named?.[2] || "";
      if (!isbn && !(title && author)) return null;
      const { candidates } = await searchOnlineBookMetadata(isbn || title, { title, author, isbn });
      const publisher = hint.publisher?.trim() || meta?.publisher;
      const year = hint.year?.trim() || meta?.date?.slice(0, 4);
      const editions = candidates.filter(item => {
        if (isbn) return canonicalIsbn(item.isbn) === isbn;
        return (!publisher || item.publisher === publisher) && (!year || item.publishedYear === year);
      });
      // Different editions often have different artwork. Leave an ambiguous result alone.
      const identities = editions.map(item => item.isbn || (item.publisher && item.publishedYear
        ? JSON.stringify([item.publisher, item.publishedYear]) : item.coverUrl));
      if (!isbn && new Set(identities).size > 1) return null;
      const urls = [...new Set(editions.map(item => item.coverUrl).filter(Boolean))];
      for (const url of urls.slice(0, 2)) {
        cover = await fromUrl(url);
        if (cover) break;
      }
    }
    if (cover && mayEmbed) {
      const jpeg = Buffer.from(cover.image.slice("data:image/jpeg;base64,".length), "base64");
      await this.cli.embedEpubCover(file, jpeg).catch(() => undefined);
    }
    return cover;
  }

  download(ref: string, hint: DownloadCoverHint = {}): Promise<DownloadResult> {
    return shareInFlight(this.downloading, ref.trim(), () => this.fetchDownload(ref, hint, false));
  }

  async localHistoryRefs(items: readonly HistoryBookRef[]): Promise<string[]> {
    return [...(await this.historyShelf.find(this.cli.getDownloadDir(), items)).keys()];
  }

  async downloadHistoryBook(bookRef: string, hint: DownloadCoverHint = {}): Promise<HistoryDownloadResult> {
    const ref = typeof bookRef === "string" ? bookRef.trim() : "";
    if (!isValidZlibBookRef(ref) && !isValidHistoryOnlyRef(ref)) throw new Error("该历史记录缺少有效的下载标识。");
    return shareInFlight(this.importingHistory, ref, async () => {
      const directory = this.cli.getDownloadDir();
      const existing = (await this.historyShelf.find(directory, [{ bookRef: ref }])).get(ref);
      if (existing) return { directory, filePath: existing, output: "已在本地书库", alreadyLocal: true };
      const result = await shareInFlight(this.downloading, ref, () => this.fetchDownload(ref, hint, true));
      // A simultaneous discovery-page download may already have been in flight.
      requireShelfFormat(result.filePath);
      return result;
    });
  }

  private async fetchDownload(ref: string, hint: DownloadCoverHint, shelfOnly: boolean): Promise<HistoryDownloadResult> {
    const root = this.cli.getDownloadDir();
    await fs.mkdir(root, { recursive: true });
    const staging = await fs.mkdtemp(path.join(root, ".download-"));
    try {
      const result = await this.cli.download(ref, staging);
      let staged = result.filePath;
      if (!staged) {
        // Older CLI versions sometimes return a successful plain-text result without a usable path.
        const files = (await fs.readdir(staging, { withFileTypes: true })).filter(entry => entry.isFile() && !entry.name.startsWith("."));
        if (files.length !== 1) throw new Error("无法定位已下载的电子书。");
        staged = path.join(staging, files[0]!.name);
      }
      if (shelfOnly) requireShelfFormat(staged);
      const published = await this.publishStagedBook(root, staged, hint);
      writeReceipt(this.settings, remoteReceiptKey(ref), { file: published.file, size: published.size, hash: published.hash });
      return { directory: root, filePath: published.file, alreadyLocal: !published.added,
        output: result.output.replaceAll(staged, published.file).replaceAll(staging, root) };
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async publishStagedBook(root: string, staged: string, hint?: DownloadCoverHint) {
    const size = (await fs.stat(staged)).size;
    if (!size) throw new Error("电子书文件为空。");
    const raw = { size, file: path.join(root, path.basename(staged)), hash: await digest(staged) };
    const sourceKey = raw.hash + path.extname(staged).toLowerCase();
    const flightKey = JSON.stringify([root, sourceKey]);
    const shared = publishing.has(flightKey);
    const result = await shareInFlight(publishing, flightKey, () =>
      this.finishDownload(root, staged, raw, sourceKey, hint));
    return { ...result, added: result.added && !shared };
  }

  private coverHintKey(contentHash: string) {
    const id = this.settings.readerDocumentId?.(contentHash) ?? contentHash;
    return "download.cover-sha256." + id;
  }

  async rememberCoverBeforeMetadataEdit(file: string, contentHash: string): Promise<void> {
    // Promote a legacy path-bound hint while its original file still exists.
    this.loadHint(file, await revision(file), contentHash);
  }

  private async finishDownload(root: string, staged: string, raw: DownloadReceipt, sourceKey: string, hint?: DownloadCoverHint) {
    // Cover embedding may change the bytes (even ZIP timestamps). Keep a receipt keyed by the source bytes.
    const receipt = readReceipt(this.settings, sourceKey);
    const epub = path.extname(staged).toLowerCase() === ".epub";
    const existing = (receipt && await findDownloadedCopy(root, receipt, this.settings))
      ?? await findDownloadedCopy(root, raw, this.settings)
      ?? (epub ? await findLegacyCoveredEpub(staged, root) : undefined);
    let published = existing;
    // Never rewrite an existing file just to improve its shelf cover.
    let cover: Cover | null = null;
    if (existing && hint) {
      const before = await revision(existing.file).catch(() => null);
      cover = await this.findCover(existing.file, hint, false).catch(() => null);
      // Recheck if a file was moved or edited during a slow online cover request.
      if (!before || before !== await revision(existing.file).catch(() => null)) {
        published = await findDownloadedCopy(root, existing, this.settings);
      }
    }
    const added = !published;
    if (!published) {
      if (hint) cover = await this.findCover(staged, hint, epub).catch(() => null);
      const hash = epub && cover?.url ? await digest(staged) : raw.hash;
      published = await publishDownload(staged, root, hash);
    }
    writeReceipt(this.settings, sourceKey, published);
    if (hint) await this.saveHint(published.file, await revision(published.file), { ...hint, coverUrl: cover?.url || hint.coverUrl }, published.hash);
    return { ...published, added };
  }

  private loadHint(file: string, stamp: string, contentId: string): DownloadCoverHint {
    try {
      const key = this.coverHintKey(contentId);
      const cached = this.settings.getSetting(key);
      if (cached) {
        const hint = JSON.parse(cached);
        if (hint && typeof hint === "object") return hint;
      }
      // Some filesystems provide no inode. Their old records can only be
      // associated safely at the original path; new records always use a hash.
      const parts = stamp.split(":");
      const legacyStamp = parts.slice(0, 4).join(":");
      const hasInode = parts[1] !== "0";
      const legacyKey = hasInode ? "download.cover-legacy." + legacyStamp
        : "download.cover." + createHash("sha256").update(file).digest("hex");
      const legacy = JSON.parse(this.settings.getSetting(legacyKey) || "null");
      const hint = hasInode ? legacy : legacy?.revision === legacyStamp ? legacy.hint : null;
      if (hint && typeof hint === "object") {
        this.settings.setSetting(key, JSON.stringify(hint));
        this.settings.deleteSetting(legacyKey);
        return hint;
      }
    } catch { /* A missing or corrupt index can be rebuilt by normal cover lookup. */ }
    return {};
  }

  private async saveHint(file: string, stamp: string, hint: DownloadCoverHint, contentId: string) {
    try {
      const knownFields = Object.fromEntries(Object.entries(hint).filter(([, value]) => value?.trim()));
      if (!Object.keys(knownFields).length) return;
      if (await revision(file) !== stamp) return;
      const previous = this.loadHint(file, stamp, contentId);
      this.settings.setSetting(this.coverHintKey(contentId), JSON.stringify({ ...previous, ...knownFields }));
    } catch {
      // An unavailable cover index must not turn a completed download into an error.
    }
  }

  async preview(filePath: string): Promise<string | null> {
    const file = await resolveDownloadedBook(this.cli.getDownloadDir(), filePath);
    const stamp = await revision(file);
    const key = JSON.stringify([file, stamp]);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const slot = this.previewSlots.shift()!;
    const task = slot.then(async () => {
      if (await resolveDownloadedBook(this.cli.getDownloadDir(), filePath) !== file) return null;
      const local = await localCover(file, this.cli);
      if (local) return await revision(file) === stamp ? local : null;
      const contentId = await digest(file);
      if (await revision(file) !== stamp) return null;
      const hint = this.loadHint(file, stamp, contentId);
      const cover = await this.findFallbackCover(file, hint, false);
      if (await revision(file) !== stamp) return null;
      if (cover?.url && cover.url !== hint.coverUrl) await this.saveHint(file, stamp, { ...hint, coverUrl: cover.url }, contentId);
      return cover?.image ?? null;
    }).finally(() => this.pending.delete(key));
    this.previewSlots.push(task.catch(() => undefined));
    this.pending.set(key, task);
    return task;
  }
}
