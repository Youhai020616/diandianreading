import { execFile, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ROUTER_EBOOK_EXTENSIONS, resolveDownloadedBook } from "./downloadedBooks";
import { supportsWeReadImport } from "./wereadFormats";
import type { WeReadImportResult } from "../../src/types/desktop";
import { canonicalIsbn } from "../isbn";
import {
  parseHalfBlockQrToMatrix,
  serializeToNetscapeCookies,
  type NormalizedCookie,
  type QrMatrix,
} from "../browser/cookieCodec";

const execFileAsync = promisify(execFile);

export interface ZlibStatus {
  installed: boolean;
  binaryPath: string | null;
  version: string | null;
  supportsMeta: boolean;
  installHint: string;
}

export interface ZlibDomainHealth {
  domain: string;
  status: string;
  httpStatus: number;
}

export interface ConnectionsSnapshot {
  status: ZlibStatus;
  zlib: {
    loggedIn: boolean;
    userName: string;
    dailyRemaining: number | null;
    dailyAllowed: number | null;
    currentDomain: string;
    error?: string;
  };
  weread: {
    loggedIn: boolean;
    name: string;
    vid: string;
    error?: string;
  };
  kindle: {
    configured: boolean;
    to: string;
    from: string;
    smtpHost: string;
    smtpPort: string;
    smtpSecurity: string;
  };
}

export type WeReadQrEvent =
  | { kind: "starting" }
  | { kind: "qr"; qr: QrMatrix; hint: string }
  | { kind: "success"; name: string; vid: string }
  | { kind: "error"; message: string }
  | { kind: "canceled" };

export interface ZlibBookItem {
  bookRef: string;
  id: string;
  hash: string;
  title: string;
  author: string;
  publisher: string;
  coverUrl: string;
  extension: string;
  size: string;
  year: string;
  language: string;
  isbn?: string;
  url?: string;
  rating?: string;
  description?: string;
}

export interface LocalBookMetadata {
  title: string;
  authors: string;
  publisher: string;
  date: string;
  isbn: string;
  zlibBookRef?: string;
  language: string;
  tags: string;
  comments: string;
  source?: string;
  embeddedCover?: string;
}

const BOOK_REF_RE = /^\d+:[a-zA-Z0-9_-]{3,40}$/;

export function isValidZlibBookRef(ref: string): boolean {
  return BOOK_REF_RE.test(ref.trim());
}

export function isValidHistoryOnlyRef(ref: string): boolean {
  return /^history:[a-zA-Z0-9]{1,80}$/.test(ref);
}

export function normalizeZlibDomainUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("无效的 Z-Library 镜像域名");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("镜像地址必须是 http:// 或 https://");
  }
  return `${parsed.protocol}//${parsed.host}`;
}

export function locateZlibBinary(): string | null {
  const candidates = [
    process.env.DIANDIAN_ZLIB_BIN,
    "/opt/homebrew/bin/zlib",
    "/usr/local/bin/zlib",
    "/usr/bin/zlib",
  ].filter((p): p is string => Boolean(p && p.trim()));

  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // Continue scanning.
    }
  }

  const envPath = process.env.PATH ?? "";
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, process.platform === "win32" ? "zlib.exe" : "zlib");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue.
    }
  }
  return null;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatAuthors(raw: unknown): string {
  if (Array.isArray(raw)) {
    return raw
      .map((a) => decodeHtmlEntities(String(a ?? "")))
      .filter(Boolean)
      .join(" / ");
  }
  return decodeHtmlEntities(String(raw ?? ""));
}

export function parseZlibSearchJson(stdout: string): ZlibBookItem[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const rows: unknown[] = Array.isArray(parsed)
    ? parsed
    : obj && Array.isArray(obj.books)
      ? (obj.books as unknown[])
      : obj && Array.isArray(obj.results)
        ? (obj.results as unknown[])
        : obj && Array.isArray(obj.items)
          ? (obj.items as unknown[])
          : [];
  return rows.map(parseBookItem).filter((book): book is ZlibBookItem => book !== null);
}

function parseBookItem(raw: unknown): ZlibBookItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rawId = String(r.id ?? r.book_id ?? "").trim();
  const rawHash = String(r.hash ?? r.book_hash ?? "").trim();

  let bookRef = "";
  if (typeof r.ref === "string" && r.ref.trim()) {
    bookRef = r.ref.trim();
  } else if (rawId.includes(":")) {
    bookRef = rawId;
  } else if (rawId && rawHash) {
    bookRef = `${rawId}:${rawHash}`;
  }

  const title = decodeHtmlEntities(String(r.name ?? r.title ?? ""));
  if (!title) return null;
  const rawCover = String(r.cover ?? "").trim();
  const coverUrl =
    /^https:\/\//i.test(rawCover) && !/cover-not-exists/i.test(rawCover) ? rawCover : "";
  const rawYear = String(r.year ?? "").trim();
  const year = rawYear && rawYear !== "0" ? rawYear : "";
  const rawUrl = String(r.url ?? "").trim();
  const safeUrl = /^https:\/\//i.test(rawUrl) ? rawUrl : "";
  const rawRating = String(r.rating ?? "").trim();
  const rating = rawRating && rawRating !== "0" && rawRating !== "0.0" ? rawRating : "";
  const rawDesc = decodeHtmlEntities(String(r.description ?? ""));

  return {
    bookRef,
    id: rawId,
    hash: rawHash,
    title,
    author: formatAuthors(r.authors ?? r.author),
    publisher: decodeHtmlEntities(String(r.publisher ?? "")),
    coverUrl,
    extension: String(r.extension ?? r.format ?? "").trim().toLowerCase(),
    size: String(r.filesizeString ?? r.filesize ?? r.size ?? "").trim(),
    year,
    language: String(r.language ?? "").trim(),
    ...(typeof r.isbn === "string" && r.isbn.trim() ? { isbn: r.isbn.trim() } : {}),
    ...(safeUrl ? { url: safeUrl } : {}),
    ...(rating ? { rating } : {}),
    ...(rawDesc ? { description: rawDesc } : {}),
  };
}

interface DownloadHistoryPage {
  books: ZlibBookItem[];
  hasMore: boolean;
}

function parseHistoryPage(stdout: string, requestedPage: number): DownloadHistoryPage {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error("下载历史数据无法解析，请刷新后重试。");
  }
  if (!Array.isArray(data?.items) || !Number.isSafeInteger(data.page) || data.page < 1
    || !Number.isSafeInteger(data.total_pages) || data.total_pages < 0) {
    throw new Error("下载历史的数据格式异常，请检查 zlib CLI 版本后重试。");
  }
  // Some mirrors return the last real page when a page beyond the end is requested.
  if (data.page < requestedPage) return { books: [], hasMore: false };
  if (data.page !== requestedPage) throw new Error("下载历史页码不符，请刷新后重试。");
  const books = [];
  for (const item of data.items) {
    const book = parseBookItem(item);
    if (!book) continue;
    if (!isValidZlibBookRef(book.bookRef)) {
      // history --download looks up the /book/<id>/ entry on its first 20 pages.
      // Pass the CLI its ID; the private download URL stays out of the renderer.
      const idFromUrl = typeof item.url === "string" ? item.url.match(/\/book\/([^/]+)(?:\/|$)/)?.[1] : "";
      const historyRef = `history:${book.id}`;
      book.bookRef = requestedPage <= 20 && typeof item.download_url === "string" && item.download_url.trim()
        && book.id === idFromUrl && isValidHistoryOnlyRef(historyRef) ? historyRef : "";
    }
    if (!book.isbn) book.isbn = canonicalIsbn(item.isbn_13) || canonicalIsbn(item.isbn_10) || undefined;
    books.push(book);
  }
  return { books, hasMore: data.total_pages > 0 ? data.page < data.total_pages : data.items.length > 0 };
}

export function extractDownloadedFilePath(stdout: string, targetDir: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const resolvedRoot = path.resolve(targetDir);
  const acceptCandidate = (candidate: unknown): string | undefined => {
    if (typeof candidate !== "string") return undefined;
    const cleaned = candidate.trim();
    if (!cleaned) return undefined;
    const abs = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(resolvedRoot, cleaned);
    if (abs !== resolvedRoot && !abs.startsWith(resolvedRoot + path.sep)) return undefined;
    try {
      if (fs.lstatSync(abs).isFile()) return abs;
    } catch {
      // File may not exist yet or path wasn't a file.
    }
    return undefined;
  };

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      for (const key of ["path", "file", "filePath", "file_path", "saved_path", "output_path", "filename"]) {
        const found = acceptCandidate(parsed[key]);
        if (found) return found;
      }
    }
  } catch {
    // Fallback to plain-text line inspection.
    for (const line of trimmed.split(/\r?\n/)) {
      const found = acceptCandidate(line);
      if (found) return found;
    }
  }
  return undefined;
}

function normalizeMetaRecord(raw: unknown): LocalBookMetadata {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const authorsVal = Array.isArray(r.authors)
    ? r.authors.map((a) => String(a ?? "").trim()).filter(Boolean).join(" & ")
    : String(r.authors ?? r.author ?? "").trim();
  const tagsVal = Array.isArray(r.tags)
    ? r.tags.map((t) => String(t ?? "").trim()).filter(Boolean).join(", ")
    : String(r.tags ?? "").trim();
  const langVal = Array.isArray(r.languages)
    ? r.languages.map((l) => String(l ?? "").trim()).filter(Boolean).join(", ")
    : String(r.language ?? r.languages ?? "").trim();
  const isbnId = Array.isArray(r.identifiers)
    ? r.identifiers.find(id => id?.scheme === "isbn")?.value
    : undefined;
  const zlibBookRef = Array.isArray(r.identifiers)
    ? r.identifiers.find(id => id?.scheme === "zlib-id" && typeof id.value === "string" && isValidZlibBookRef(id.value))?.value.trim()
    : undefined;
  const isbnVal =
    String(r.isbn ?? "").trim()
    || canonicalIsbn(isbnId)
    || (r.identifiers && typeof r.identifiers === "object"
      ? String((r.identifiers as Record<string, unknown>).isbn ?? "").trim()
      : "");

  return {
    title: String(r.title ?? r.name ?? "").trim(),
    authors: authorsVal,
    publisher: String(r.publisher ?? "").trim(),
    date: String(r.date ?? r.year ?? r.published ?? "").trim(),
    isbn: isbnVal,
    ...(zlibBookRef ? { zlibBookRef } : {}),
    language: langVal,
    tags: tagsVal,
    comments: String(r.comments ?? r.description ?? "").trim(),
    source: Array.isArray(r.sources) ? r.sources.join(" / ") : String(r.source ?? ""),
    embeddedCover: typeof r.cover === "string" ? r.cover : undefined,
  };
}

function cliErrorMessage(error: unknown, fallback: string): string {
  const err = error as { stdout?: string; stderr?: string; message?: string };
  const raw = [err.stderr?.trim(), err.stdout?.trim()].filter(Boolean).join("\n").trim() || err.message || fallback;
  return raw.replace(/^[✗×]\s*Error:\s*/i, "").trim();
}

function extractCliError(error: unknown, fallback: string): Error {
  const cleaned = cliErrorMessage(error, fallback);
  if (/EAPI search failed:\s*Access denied/i.test(cleaned) || /Access denied/i.test(cleaned)) {
    return new Error(
      "Z-Library 搜索返回 Access denied：请先点击上方「1. 右侧打开登录 → 2. 同步右侧登录态」刷新 Cookie，或切换代理节点 / 执行 `zlib update` 升级到新版后再试。",
    );
  }
  if (/not logged in|login required|unauthorized/i.test(cleaned)) {
    return new Error("尚未登录 Z-Library 账号：请点击上方「1. 右侧打开登录 → 2. 同步右侧登录态」完成绑定。");
  }
  if (/ETIMEDOUT|timeout|deadline exceeded/i.test(cleaned)) {
    return new Error("请求超时：请点击上方「检测健康镜像」切换可用镜像，或检查当前网络/代理设置。");
  }
  return new Error(cleaned || fallback);
}

const unconfirmedWeReadImport = "微信读书尚未确认导入结果，请先查看微信读书书架再决定是否重试。";

function weReadImportError(error: unknown): Error {
  const message = cliErrorMessage(error, "导入微信读书失败");
  if (/did not confirm the import|timed? ?out|deadline exceeded/i.test(message) || (error as { killed?: boolean }).killed) {
    return new Error(unconfirmedWeReadImport);
  }
  if (/not logged in|session expired|unauthorized|weread login/i.test(message)) {
    return new Error("请在「连接与偏好」中连接微信读书账号，再回到书库重试。");
  }
  if (/requires verification/i.test(message)) return new Error("请打开手机微信读书完成验证，然后再试。");
  if (/unreachable|connection (?:refused|reset)|no such host|ENETUNREACH|ENOTFOUND|network is unreachable/i.test(message)) {
    return new Error("连接微信读书失败，请检查网络后重试。");
  }
  if (/file is too large for WeRead/i.test(message)) return new Error("文件超过微信读书允许的大小。");
  if (/could not read the file as a book/i.test(message)) return new Error("微信读书无法解析这份电子书，请检查文件或更换版本。");
  if (/WeRead is limiting requests/i.test(message)) return new Error("微信读书暂时限制了导入频率，请稍后再试。");
  const limit = message.match(/WeRead import limit reached(?:: ([^\n]+))?/i);
  if (limit) return new Error(limit[1] ? `已达到微信读书导入上限：${limit[1]}` : "已达到微信读书导入上限。");
  return new Error(message);
}

export function parseMetaMatches(stdout: string): LocalBookMetadata[] {
  const parsed: unknown = JSON.parse(stdout);
  const record = (parsed ?? {}) as Record<string, unknown>;
  const list = [parsed, record.candidates, record.matches, record.results].find(Array.isArray) ?? [record];
  return list.map(normalizeMetaRecord).filter(m => Boolean(m.title));
}

type FeedCacheKey = "recommended" | "most-popular" | "favorites";

const ALLOWED_SEARCH_ORDERS = new Set([
  "popular",
  "bestmatch",
  "date",
  "titleA",
  "title",
  "year",
  "filesize",
  "filesizeA",
]);

export class ZlibCliService {
  private readonly defaultDownloadDir: string;
  private preferredDomain = "";
  private activeWeReadLoginProc: ChildProcess | null = null;
  private readonly activeWeReadImports = new Map<string, Promise<WeReadImportResult>>();
  private readonly feedCache = new Map<FeedCacheKey, { items: ZlibBookItem[]; fetchedAt: number }>();
  private readonly historyPages = new Map<number, { fetchedAt: number; result: Promise<DownloadHistoryPage> }>();

  constructor(downloadDir: string) {
    this.defaultDownloadDir = downloadDir;
  }

  getDownloadDir(): string {
    return this.defaultDownloadDir;
  }

  invalidateFeedCache(): void {
    this.feedCache.clear();
    this.historyPages.clear();
  }

  setPreferredDomain(domain: string): string {
    const clean = domain.trim() ? normalizeZlibDomainUrl(domain) : "";
    if (clean !== this.preferredDomain) {
      this.invalidateFeedCache();
    }
    this.preferredDomain = clean;
    return clean;
  }

  getPreferredDomain(): string {
    return this.preferredDomain;
  }

  private buildEnv(): NodeJS.ProcessEnv {
    if (!this.preferredDomain) return process.env;
    return {
      ...process.env,
      ZLIB_DOMAIN: this.preferredDomain,
    };
  }

  async getStatus(): Promise<ZlibStatus> {
    const binaryPath = locateZlibBinary();
    const installHint = "brew install heartleo/tap/zlib-cli  （可选外部组件，未安装不影响阅读、笔记与创作核心功能）";
    if (!binaryPath) {
      return {
        installed: false,
        binaryPath: null,
        version: null,
        supportsMeta: false,
        installHint,
      };
    }

    let version: string | null = null;
    let supportsMeta = false;
    try {
      const { stdout } = await execFileAsync(binaryPath, ["--version"], { timeout: 6_000 });
      version = stdout.trim().split(/\r?\n/)[0] || null;
    } catch {
      version = "unknown";
    }

    try {
      const { stdout } = await execFileAsync(binaryPath, ["--help"], { timeout: 6_000 });
      supportsMeta = /\bmeta\b/.test(stdout);
    } catch {
      supportsMeta = false;
    }

    return {
      installed: true,
      binaryPath,
      version,
      supportsMeta,
      installHint,
    };
  }

  async getConnectionsSnapshot(): Promise<ConnectionsSnapshot> {
    const status = await this.getStatus();
    const empty: ConnectionsSnapshot = {
      status,
      zlib: {
        loggedIn: false,
        userName: "",
        dailyRemaining: null,
        dailyAllowed: null,
        currentDomain: this.preferredDomain,
      },
      weread: {
        loggedIn: false,
        name: "",
        vid: "",
      },
      kindle: {
        configured: false,
        to: "",
        from: "",
        smtpHost: "smtp.gmail.com",
        smtpPort: "587",
        smtpSecurity: "starttls",
      },
    };
    if (!status.installed || !status.binaryPath) return empty;
    const bin = status.binaryPath;
    const env = this.buildEnv();

    const [cfgRes, profRes, wrRes] = await Promise.allSettled([
      execFileAsync(bin, ["config", "--json"], { timeout: 8_000, env }),
      execFileAsync(bin, ["profile", "--json"], { timeout: 10_000, env }),
      execFileAsync(bin, ["weread", "whoami", "--json"], { timeout: 10_000, env }),
    ]);

    if (cfgRes.status === "fulfilled") {
      try {
        const rows = JSON.parse(cfgRes.value.stdout.trim()) as Array<{ key?: string; value?: string; saved?: string }>;
        const byKey = new Map<string, string>();
        for (const row of rows) {
          if (row.key) byKey.set(row.key, String(row.value ?? row.saved ?? "").trim());
        }
        empty.zlib.currentDomain = this.preferredDomain || byKey.get("ZLIB_DOMAIN") || "";
        const to = byKey.get("KINDLE_TO") || "";
        const from = byKey.get("KINDLE_FROM") || "";
        empty.kindle = {
          configured: Boolean(to && from),
          to,
          from,
          smtpHost: byKey.get("KINDLE_SMTP_HOST") || "smtp.gmail.com",
          smtpPort: byKey.get("KINDLE_SMTP_PORT") || "587",
          smtpSecurity: byKey.get("KINDLE_SMTP_SECURITY") || "starttls",
        };
      } catch {
        // Ignore parse issues.
      }
    }

    if (profRes.status === "fulfilled") {
      try {
        const prof = JSON.parse(profRes.value.stdout.trim()) as {
          name?: string;
          daily_remaining?: number;
          daily_allowed?: number;
        };
        empty.zlib.loggedIn = true;
        empty.zlib.userName = String(prof.name ?? "已登录用户").trim();
        empty.zlib.dailyRemaining = typeof prof.daily_remaining === "number" ? prof.daily_remaining : null;
        empty.zlib.dailyAllowed = typeof prof.daily_allowed === "number" ? prof.daily_allowed : null;
      } catch {
        empty.zlib.loggedIn = false;
      }
    } else {
      const msg = extractCliError(profRes.reason, "").message;
      if (msg && !/not logged in/i.test(msg)) {
        empty.zlib.error = msg;
      }
    }

    if (wrRes.status === "fulfilled") {
      try {
        const wr = JSON.parse(wrRes.value.stdout.trim()) as { vid?: string; name?: string };
        if (wr.vid || wr.name) {
          empty.weread.loggedIn = true;
          empty.weread.vid = String(wr.vid ?? "");
          empty.weread.name = String(wr.name ?? "微信读书用户");
        }
      } catch {
        empty.weread.loggedIn = false;
      }
    }

    return empty;
  }

  private requireBinary(): string {
    const bin = locateZlibBinary();
    if (!bin) {
      throw new Error("本机尚未安装可选组件 heartleo/zlib CLI。请先执行 `brew install heartleo/tap/zlib-cli` 并自行登录配置。");
    }
    return bin;
  }

  async listHealthyDomains(): Promise<ZlibDomainHealth[]> {
    const bin = this.requireBinary();
    const { stdout } = await execFileAsync(bin, ["doctor", "--json"], { timeout: 25_000 });
    const parsed = JSON.parse(stdout.trim()) as Array<{
      domain?: string;
      status?: string;
      http_status?: number;
    }>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((d) => typeof d.domain === "string" && d.domain.trim())
      .map((d) => ({
        domain: String(d.domain),
        status: String(d.status ?? "unknown"),
        httpStatus: Number(d.http_status ?? 0),
      }));
  }

  async runDoctor(): Promise<{ ok: boolean; output: string; domains: ZlibDomainHealth[] }> {
    const bin = this.requireBinary();
    try {
      const { stdout, stderr } = await execFileAsync(bin, ["doctor", "--json"], { timeout: 25_000 });
      const raw = stdout.trim();
      let domains: ZlibDomainHealth[] = [];
      try {
        const list = JSON.parse(raw) as Array<{ domain?: string; status?: string; http_status?: number }>;
        if (Array.isArray(list)) {
          domains = list
            .filter((d) => typeof d.domain === "string" && d.domain.trim())
            .map((d) => ({
              domain: String(d.domain),
              status: String(d.status ?? "unknown"),
              httpStatus: Number(d.http_status ?? 0),
            }));
          const summary = domains
            .map((d) => `${d.status === "healthy" ? "✓" : "✗"} ${d.domain} (${d.status} ${d.httpStatus})`)
            .join("\n");
          return { ok: true, output: summary || raw, domains };
        }
      } catch {
        // Fallback to raw text.
      }
      return { ok: true, output: [raw, stderr.trim()].filter(Boolean).join("\n"), domains };
    } catch (error: unknown) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      return {
        ok: false,
        output: [err.stdout?.trim(), err.stderr?.trim(), err.message].filter(Boolean).join("\n"),
        domains: [],
      };
    }
  }

  /**
   * Bridge right-hand WebContentsView cookies into `zlib login --cookies` using a
   * mode-0600 temp file that is unconditionally deleted in `finally`.
   */
  async loginZlibWithCookies(cookies: NormalizedCookie[], domainUrl: string): Promise<ConnectionsSnapshot> {
    const bin = this.requireBinary();
    const cleanDomain = normalizeZlibDomainUrl(domainUrl);
    if (!cleanDomain) throw new Error("请提供有效的 Z-Library 镜像域名");
    if (cookies.length === 0) {
      throw new Error("未在右侧当前页面读取到该域名的登录 Cookie，请先确认已在右侧网页登录成功。");
    }

    const tmpFile = path.join(os.tmpdir(), `diandian-zlib-sync-${crypto.randomBytes(8).toString("hex")}.txt`);
    try {
      const netscape = serializeToNetscapeCookies(cookies);
      fs.writeFileSync(tmpFile, netscape, { encoding: "utf8", mode: 0o600 });
      await execFileAsync(bin, ["login", "--cookies", tmpFile, "--domain", cleanDomain], {
        timeout: 25_000,
      });
      this.preferredDomain = cleanDomain;
      this.invalidateFeedCache();
      return await this.getConnectionsSnapshot();
    } catch (error) {
      throw extractCliError(error, "同步 Z-Library 登录态失败");
    } finally {
      try {
        fs.rmSync(tmpFile, { force: true });
      } catch {
        // Ignore cleanup failure.
      }
    }
  }

  async loginZlibWithCookieFile(filePath: string, domainUrl?: string): Promise<ConnectionsSnapshot> {
    const bin = this.requireBinary();
    const trimmed = filePath.trim();
    if (!trimmed || !path.isAbsolute(trimmed) || !fs.lstatSync(trimmed).isFile()) {
      throw new Error("请选择有效的 Netscape cookies.txt 文件");
    }
    const args = ["login", "--cookies", trimmed];
    if (domainUrl && domainUrl.trim()) {
      const clean = normalizeZlibDomainUrl(domainUrl);
      args.push("--domain", clean);
      this.preferredDomain = clean;
    }
    try {
      await execFileAsync(bin, args, { timeout: 25_000 });
      this.invalidateFeedCache();
      return await this.getConnectionsSnapshot();
    } catch (error) {
      throw extractCliError(error, "导入 Cookie 登录 Z-Library 失败");
    }
  }

  async logoutZlib(): Promise<ConnectionsSnapshot> {
    const bin = this.requireBinary();
    try {
      await execFileAsync(bin, ["logout"], { timeout: 15_000, env: this.buildEnv() });
      this.invalidateFeedCache();
      return await this.getConnectionsSnapshot();
    } catch (error) {
      throw extractCliError(error, "退出 Z-Library 登录失败");
    }
  }

  async logoutWeRead(): Promise<ConnectionsSnapshot> {
    this.cancelWeReadQrLogin();
    const bin = this.requireBinary();
    try {
      await execFileAsync(bin, ["weread", "logout"], { timeout: 15_000, env: this.buildEnv() });
      return await this.getConnectionsSnapshot();
    } catch (error) {
      throw extractCliError(error, "解除微信读书书架绑定失败");
    }
  }

  startWeReadQrLogin(onEvent: (event: WeReadQrEvent) => void): void {
    this.cancelWeReadQrLogin();
    const bin = this.requireBinary();
    onEvent({ kind: "starting" });

    const child = spawn(bin, ["weread", "login"], {
      env: this.buildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.activeWeReadLoginProc = child;

    let stdoutBuf = "";
    let stderrBuf = "";
    let qrSent = false;

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      if (!qrSent) {
        const matrix = parseHalfBlockQrToMatrix(stdoutBuf);
        if (matrix) {
          qrSent = true;
          onEvent({
            kind: "qr",
            qr: matrix,
            hint: "请使用微信扫一扫上方二维码，并在手机上确认登录微信读书书架通道",
          });
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });

    child.once("error", (err) => {
      if (this.activeWeReadLoginProc === child) this.activeWeReadLoginProc = null;
      onEvent({ kind: "error", message: `无法启动微信读书扫码登录: ${err.message}` });
    });

    child.once("exit", (code, signal) => {
      const wasActive = this.activeWeReadLoginProc === child;
      if (wasActive) this.activeWeReadLoginProc = null;
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        onEvent({ kind: "canceled" });
        return;
      }
      if (code === 0) {
        void execFileAsync(bin, ["weread", "whoami", "--json"], { timeout: 10_000 })
          .then(({ stdout }) => {
            const parsed = JSON.parse(stdout.trim()) as { name?: string; vid?: string };
            onEvent({
              kind: "success",
              name: String(parsed.name ?? "微信读书用户"),
              vid: String(parsed.vid ?? ""),
            });
          })
          .catch(() => {
            onEvent({ kind: "success", name: "微信读书用户", vid: "" });
          });
      } else {
        const detail = [stderrBuf.trim(), stdoutBuf.trim().split("\n").slice(-3).join(" ")].filter(Boolean).join(" ");
        onEvent({
          kind: "error",
          message: detail || `微信读书扫码登录未完成 (code=${code ?? "unknown"})`,
        });
      }
    });
  }

  cancelWeReadQrLogin(): void {
    const proc = this.activeWeReadLoginProc;
    this.activeWeReadLoginProc = null;
    if (proc && !proc.killed) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // Ignore.
      }
    }
  }

  async openKindleConfigInTerminal(): Promise<{ launched: boolean; command: string }> {
    const bin = this.requireBinary();
    const command = `${bin} kindle config`;
    if (process.platform === "darwin" && /^[a-zA-Z0-9/._-]+$/.test(bin)) {
      await execFileAsync("osascript", [
        "-e",
        'tell application "Terminal" to activate',
        "-e",
        `tell application "Terminal" to do script "${bin} kindle config"`,
      ]);
      return { launched: true, command };
    }
    return { launched: false, command };
  }

  private async fetchCachedFeed(
    key: FeedCacheKey,
    ttlMs: number,
    forceRefresh = false,
  ): Promise<ZlibBookItem[]> {
    const now = Date.now();
    if (!forceRefresh) {
      const cached = this.feedCache.get(key);
      if (cached && now - cached.fetchedAt < ttlMs) {
        return cached.items;
      }
    }
    const bin = this.requireBinary();
    try {
      const { stdout } = await execFileAsync(bin, [key, "--json"], {
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        env: this.buildEnv(),
      });
      const items = parseZlibSearchJson(stdout);
      this.feedCache.set(key, { items, fetchedAt: now });
      return items;
    } catch (error) {
      throw extractCliError(error, `获取 Z-Library ${key} 书单失败`);
    }
  }

  async getRecommended(forceRefresh = false): Promise<ZlibBookItem[]> {
    return this.fetchCachedFeed("recommended", 5 * 60_000, forceRefresh);
  }

  async getMostPopular(forceRefresh = false): Promise<ZlibBookItem[]> {
    return this.fetchCachedFeed("most-popular", 10 * 60_000, forceRefresh);
  }

  async getFavorites(forceRefresh = false): Promise<ZlibBookItem[]> {
    return this.fetchCachedFeed("favorites", 3 * 60_000, forceRefresh);
  }

  async getHistory(forceRefresh = false): Promise<ZlibBookItem[]> {
    return (await this.getDownloadHistoryPage(1, forceRefresh)).books;
  }

  async getDownloadHistoryPage(page: number, forceRefresh = false): Promise<DownloadHistoryPage> {
    if (!Number.isSafeInteger(page) || page < 1) throw new Error("下载历史页码须为正整数。");
    const cached = this.historyPages.get(page);
    if (!forceRefresh && cached && Date.now() - cached.fetchedAt < 120_000) return cached.result;
    const bin = this.requireBinary();
    const result = execFileAsync(bin, ["history", "--json", "--page", String(page)], {
      timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: this.buildEnv(),
    }).then(({ stdout }) => parseHistoryPage(stdout, page));
    this.historyPages.set(page, { fetchedAt: Date.now(), result });
    try {
      return await result;
    } catch (error) {
      if (this.historyPages.get(page)?.result === result) this.historyPages.delete(page);
      const message = cliErrorMessage(error, "读取 Z-Library 下载历史失败");
      if ((error as { code?: number }).code === 3 || /not logged in|log ?in (?:first|required)|unauthorized|no saved session/i.test(message)) {
        throw new Error("请在「连接与偏好」连接 Z-Library 账号，再回到书库重试。");
      }
      throw extractCliError(error, "读取 Z-Library 下载历史失败");
    }
  }

  async search(
    query: string,
    opts: { format?: string; limit?: number; page?: number; order?: string } = {},
  ): Promise<ZlibBookItem[]> {
    const bin = this.requireBinary();
    const q = query.trim();
    if (!q) return [];
    const args = ["search", q, "--json"];
    if (opts.format && /^[a-z0-9]{2,8}$/i.test(opts.format.trim())) {
      args.push("--ext", opts.format.trim().toLowerCase());
    }
    if (opts.order && ALLOWED_SEARCH_ORDERS.has(opts.order.trim())) {
      args.push("--order", opts.order.trim());
    }
    if (typeof opts.page === "number" && Number.isFinite(opts.page) && opts.page > 1) {
      args.push("--page", String(Math.min(50, Math.floor(opts.page))));
    }
    const count = Math.max(1, Math.min(30, opts.limit ?? 15));
    args.push("--count", String(count));

    try {
      const { stdout } = await execFileAsync(bin, args, {
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        env: this.buildEnv(),
      });
      return parseZlibSearchJson(stdout);
    } catch (error) {
      throw extractCliError(error, "zlib 检索失败");
    }
  }

  async download(
    bookRef: string,
    destDir?: string,
  ): Promise<{ output: string; directory: string; filePath?: string }> {
    const bin = this.requireBinary();
    const cleanRef = bookRef.trim();
    const historyOnly = isValidHistoryOnlyRef(cleanRef);
    if (!historyOnly && !isValidZlibBookRef(cleanRef)) {
      throw new Error("无效的书籍标识，格式应为 `<id>:<hash>`");
    }
    const targetDir = destDir && path.isAbsolute(destDir) ? destDir : this.defaultDownloadDir;
    fs.mkdirSync(targetDir, { recursive: true });
    try {
      const args = historyOnly ? ["history", "--download", cleanRef.slice("history:".length)] : ["download", cleanRef];
      const { stdout, stderr } = await execFileAsync(bin, [...args, "--dir", targetDir, "--json"], {
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
        env: this.buildEnv(),
      });
      const filePath = extractDownloadedFilePath(stdout, targetDir);
      this.historyPages.clear();
      return {
        directory: targetDir,
        ...(filePath ? { filePath } : {}),
        output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || `已下载到 ${targetDir}`,
      };
    } catch (error) {
      throw extractCliError(error, "zlib 下载失败");
    }
  }

  async sendToKindle(filePath: string): Promise<{ output: string }> {
    const bin = this.requireBinary();
    const cleanPath = this.assertReadableBookFile(filePath);
    try {
      const { stdout, stderr } = await execFileAsync(bin, ["kindle", "send", cleanPath], {
        timeout: 90_000,
        maxBuffer: 2 * 1024 * 1024,
        env: this.buildEnv(),
      });
      return {
        output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || "已触发发送到 Kindle",
      };
    } catch (error) {
      throw extractCliError(error, "发送到 Kindle 失败");
    }
  }

  async importToWeRead(filePath: string, options?: { fromLibrary?: boolean }): Promise<WeReadImportResult> {
    const cleanPath = options?.fromLibrary
      ? await resolveDownloadedBook(this.defaultDownloadDir, filePath)
      : await fs.promises.realpath(this.assertReadableBookFile(filePath));
    if (!supportsWeReadImport(path.extname(cleanPath).slice(1))) {
      throw new Error("微信读书支持导入 EPUB、PDF、MOBI、AZW3 和 TXT 文件。");
    }
    const pending = this.activeWeReadImports.get(cleanPath);
    if (pending) return pending;
    const bin = locateZlibBinary();
    if (!bin) throw new Error("请先在「连接与偏好」安装传书组件并连接微信读书。");
    const transfer = this.uploadToWeRead(bin, cleanPath);
    this.activeWeReadImports.set(cleanPath, transfer);
    try { return await transfer; }
    finally { this.activeWeReadImports.delete(cleanPath); }
  }

  private async uploadToWeRead(bin: string, filePath: string): Promise<WeReadImportResult> {
    // WeRead can spend up to three minutes processing after the upload finishes.
    const { stdout, stderr } = await execFileAsync(bin, ["weread", "import", filePath, "--json"], {
      timeout: 15 * 60_000, maxBuffer: 2 * 1024 * 1024, env: this.buildEnv(),
    }).catch(error => { throw weReadImportError(error); });
    let result;
    try { result = JSON.parse(stdout); } catch { throw new Error(unconfirmedWeReadImport); }
    if (typeof result?.book_id !== "string" || !result.book_id.trim()
      || (result.already_existed !== undefined && typeof result.already_existed !== "boolean")) {
      throw new Error(unconfirmedWeReadImport);
    }
    return { output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n"), alreadyExisted: result.already_existed === true };
  }

  async readLocalBookMeta(filePath: string): Promise<LocalBookMetadata> {
    const bin = this.requireBinary();
    const cleanPath = this.assertReadableBookFile(filePath);
    try {
      const { stdout } = await execFileAsync(bin, ["meta", cleanPath, "--json"], {
        timeout: 20_000,
        maxBuffer: 2 * 1024 * 1024,
        env: this.buildEnv(),
      });
      return normalizeMetaRecord(JSON.parse(stdout.trim()));
    } catch (error) {
      throw extractCliError(error, "读取电子书元数据失败（需要 zlib v0.0.16+）");
    }
  }

  async fetchLocalBookMetaMatches(
    filePath: string,
    sources: string[] = ["douban", "weread", "openlibrary", "google"],
  ): Promise<LocalBookMetadata[]> {
    const bin = this.requireBinary();
    const cleanPath = this.assertReadableBookFile(filePath);
    const allowedSources = new Set(["douban", "weread", "openlibrary", "google", "goodreads"]);
    const safeSources = sources.map((s) => s.trim().toLowerCase()).filter((s) => allowedSources.has(s));
    const args = ["meta", cleanPath, "--fetch", "--json"];
    if (safeSources.length > 0) {
      args.push("--source", safeSources.join(","));
    }

    try {
      const { stdout } = await execFileAsync(bin, args, {
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        env: this.buildEnv(),
      });
      return parseMetaMatches(stdout);
    } catch (error) {
      throw extractCliError(error, "在线抓取元数据失败");
    }
  }

  async applyLocalBookMeta(
    filePath: string,
    patch: Partial<LocalBookMetadata> & { rename?: boolean },
  ): Promise<{ metadata: LocalBookMetadata; filePath: string; output: string }> {
    const bin = this.requireBinary();
    const cleanPath = this.assertReadableBookFile(filePath);
    const args = ["meta", cleanPath];
    if (patch.title !== undefined && patch.title.trim()) args.push("-t", patch.title.trim());
    if (patch.authors !== undefined && patch.authors.trim()) args.push("-a", patch.authors.trim());
    if (patch.publisher !== undefined && patch.publisher.trim()) args.push("-p", patch.publisher.trim());
    if (patch.isbn !== undefined && patch.isbn.trim()) args.push("--isbn", patch.isbn.trim());
    if (patch.date !== undefined && patch.date.trim()) args.push("-d", patch.date.trim());
    if (patch.language !== undefined && patch.language.trim()) args.push("-l", patch.language.trim());
    if (patch.tags !== undefined && patch.tags.trim()) args.push("--tags", patch.tags.trim());
    if (patch.comments !== undefined && patch.comments.trim()) args.push("-c", patch.comments.trim());
    if (patch.rename) args.push("--rename");
    args.push("--json");

    try {
      const { stdout, stderr } = await execFileAsync(bin, args, {
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        env: this.buildEnv(),
      });
      let metadata = normalizeMetaRecord({});
      try {
        metadata = normalizeMetaRecord(JSON.parse(stdout.trim()));
      } catch {
        // Keep fallback.
      }
      return {
        metadata,
        filePath: extractDownloadedFilePath(stdout, path.dirname(cleanPath)) ?? cleanPath,
        output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || "元数据已原子写回电子书文件",
      };
    } catch (error) {
      throw extractCliError(error, "写回电子书元数据失败");
    }
  }

  async embedEpubCover(filePath: string, jpeg: Buffer): Promise<void> {
    const bin = this.requireBinary();
    const book = this.assertReadableBookFile(filePath);
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "diandian-cover-"));
    try {
      const cover = path.join(directory, "cover.jpg");
      await fs.promises.writeFile(cover, jpeg, { mode: 0o600 });
      await execFileAsync(bin, ["meta", book, "--cover", cover, "--json"], {
        timeout: 30_000, env: this.buildEnv(),
      });
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  }

  async extractBookCover(filePath: string): Promise<Buffer | null> {
    const bin = this.requireBinary();
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "diandian-preview-"));
    try {
      const file = path.join(dir, "cover");
      await execFileAsync(bin, ["meta", filePath, "--get-cover", file], { timeout: 15_000, env: this.buildEnv() });
      return (await fs.promises.stat(file)).size <= 8 * 1024 * 1024 ? await fs.promises.readFile(file) : null;
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  }

  dispose(): void {
    this.cancelWeReadQrLogin();
  }

  private assertReadableBookFile(filePath: string): string {
    const trimmed = filePath.trim();
    if (!trimmed || !path.isAbsolute(trimmed)) {
      throw new Error("请选择本机有效的电子书文件（绝对路径）");
    }
    const stat = fs.lstatSync(trimmed);
    if (!stat.isFile()) {
      throw new Error("目标不是有效的电子书文件");
    }
    const ext = path.extname(trimmed).toLowerCase();
    if (!ROUTER_EBOOK_EXTENSIONS.includes(ext.slice(1))) {
      throw new Error(`不支持的电子书格式: ${ext || "未知"}`);
    }
    return trimmed;
  }
}
