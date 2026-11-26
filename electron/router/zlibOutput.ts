/** Validation of CLI arguments and parsing of heartleo/zlib CLI output and errors. */
import fs from "node:fs";
import path from "node:path";
import { canonicalIsbn } from "../isbn";
import type { LocalBookMetadata, ZlibBookItem } from "./zlibTypes";

export const BOOK_REF_RE = /^\d+:[a-zA-Z0-9_-]{3,40}$/;

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

export function decodeHtmlEntities(input: string): string {
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

export function formatAuthors(raw: unknown): string {
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

export function parseBookItem(raw: unknown): ZlibBookItem | null {
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

export interface DownloadHistoryPage {
  books: ZlibBookItem[];
  hasMore: boolean;
}

export function parseHistoryPage(stdout: string, requestedPage: number): DownloadHistoryPage {
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

export function normalizeMetaRecord(raw: unknown): LocalBookMetadata {
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

export function cliErrorMessage(error: unknown, fallback: string): string {
  const err = error as { stdout?: string; stderr?: string; message?: string };
  const raw = [err.stderr?.trim(), err.stdout?.trim()].filter(Boolean).join("\n").trim() || err.message || fallback;
  return raw.replace(/^[✗×]\s*Error:\s*/i, "").trim();
}

export function extractCliError(error: unknown, fallback: string): Error {
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

export const unconfirmedWeReadImport = "微信读书尚未确认导入结果，请先查看微信读书书架再决定是否重试。";

export function weReadImportError(error: unknown): Error {
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
