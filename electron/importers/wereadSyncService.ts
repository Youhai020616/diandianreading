import type { NormalizedCookie } from "../browser/cookieCodec";
import type { KnowledgeDatabase } from "../storage/database";

export interface WeReadNotebookBook {
  bookId: string;
  title: string;
  author: string;
  coverUrl: string;
  publisher: string;
  isbn: string;
  intro: string;
  publishedYear: string;
  noteCount: number;
  reviewCount: number;
  bookmarkCount: number;
  sortTime: number;
}

export interface WeReadSyncBookResult {
  bookId: string;
  localBookId: string;
  title: string;
  importedCount: number;
  deduplicatedCount: number;
}

export interface WeReadSyncOutcome {
  booksSynced: number;
  importedCount: number;
  deduplicatedCount: number;
  details: WeReadSyncBookResult[];
}

const WEREAD_ORIGIN = "https://weread.qq.com";
const WEREAD_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

function buildCookieHeader(cookies: NormalizedCookie[]): string {
  const seen = new Map<string, string>();
  for (const c of cookies) {
    if (!c.name) continue;
    seen.set(c.name, c.value);
  }
  return [...seen.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function assertLoggedInCookies(cookies: NormalizedCookie[]): string {
  const header = buildCookieHeader(cookies);
  if (!header || (!header.includes("wr_skey") && !header.includes("wr_vid"))) {
    throw new Error("尚未检测到微信读书登录态，请先在右侧内置阅读浏览器打开微信读书并扫码登录。");
  }
  return header;
}

async function fetchWeReadJson(endpointPath: string, cookieHeader: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${WEREAD_ORIGIN}${endpointPath}`, {
    method: "GET",
    headers: {
      cookie: cookieHeader,
      referer: `${WEREAD_ORIGIN}/`,
      origin: WEREAD_ORIGIN,
      accept: "application/json, text/plain, */*",
      "user-agent": WEREAD_UA,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error("微信读书网页登录态已失效，请在右侧内置浏览器刷新或重新扫码登录。");
  }
  if (!res.ok) {
    throw new Error(`微信读书接口请求失败 (HTTP ${res.status})`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const errcode = typeof data.errcode === "number" ? data.errcode : 0;
  if (errcode === -2012 || errcode === -2010) {
    throw new Error("微信读书网页会话已过期，请在右侧内置浏览器刷新页面或重新扫码登录。");
  }
  if (errcode !== 0) {
    const errMsg = typeof data.errmsg === "string" && data.errmsg ? data.errmsg : `errcode=${errcode}`;
    throw new Error(`微信读书接口返回异常：${errMsg}`);
  }
  return data;
}

export function parseWeReadNotebooksResponse(data: Record<string, unknown>): WeReadNotebookBook[] {
  const rawBooks = Array.isArray(data.books) ? data.books : [];
  const out: WeReadNotebookBook[] = [];

  for (const entry of rawBooks) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const book = (item.book && typeof item.book === "object" ? item.book : item) as Record<string, unknown>;
    const bookId = String(item.bookId ?? book.bookId ?? "").trim();
    const title = String(book.title ?? "").trim();
    if (!bookId || !title) continue;

    const rawCover = String(book.cover ?? "").trim().replace(/^http:\/\//i, "https://");
    const coverUrl = /^https:\/\//i.test(rawCover) ? rawCover : "";
    const publishMatch = /^(\d{4})/.exec(String(book.publishTime ?? ""));

    out.push({
      bookId,
      title,
      author: String(book.author ?? "").trim(),
      coverUrl,
      publisher: String(book.publisher ?? "").trim(),
      isbn: String(book.isbn ?? "").trim(),
      intro: String(book.intro ?? "").trim().slice(0, 600),
      publishedYear: publishMatch?.[1] ?? "",
      noteCount: Number(item.noteCount ?? 0),
      reviewCount: Number(item.reviewCount ?? 0),
      bookmarkCount: Number(item.bookmarkCount ?? item.noteCount ?? 0),
      sortTime: Number(item.sort ?? 0),
    });
  }

  return out.sort((a, b) => b.sortTime - a.sortTime);
}

export interface ParsedWeReadBookEntry {
  chapter: string;
  quote: string;
  note: string;
  createdAt: string;
}

export function mergeWeReadBookmarksAndReviews(
  bookmarksData: Record<string, unknown>,
  reviewsData: Record<string, unknown>,
): ParsedWeReadBookEntry[] {
  const chapterMap = new Map<number, string>();
  if (Array.isArray(bookmarksData.chapters)) {
    for (const ch of bookmarksData.chapters) {
      if (!ch || typeof ch !== "object") continue;
      const rec = ch as Record<string, unknown>;
      const uid = Number(rec.chapterUid ?? -1);
      const title = String(rec.title ?? "").trim();
      if (uid >= 0 && title) chapterMap.set(uid, title);
    }
  }

  // Index reviews/thoughts by normalized abstract quote so we attach user thoughts to matching highlights.
  const reviewByQuote = new Map<
    string,
    { abstract: string; note: string; chapter: string; createdAt: string; used: boolean }
  >();
  const standaloneReviews: ParsedWeReadBookEntry[] = [];

  if (Array.isArray(reviewsData.reviews)) {
    for (const wrapper of reviewsData.reviews) {
      if (!wrapper || typeof wrapper !== "object") continue;
      const rev = (
        (wrapper as Record<string, unknown>).review && typeof (wrapper as Record<string, unknown>).review === "object"
          ? (wrapper as Record<string, unknown>).review
          : wrapper
      ) as Record<string, unknown>;
      const content = String(rev.content ?? "").trim();
      const abstract = String(rev.abstract ?? "").trim();
      const chapter = String(rev.chapterTitle ?? "").trim();
      const createTime = Number(rev.createTime ?? 0);
      const createdAt = createTime > 0 ? new Date(createTime * 1000).toISOString() : new Date().toISOString();

      if (abstract && content) {
        const key = abstract.replace(/\s+/g, " ").toLowerCase();
        const prev = reviewByQuote.get(key);
        reviewByQuote.set(key, {
          abstract: prev?.abstract || abstract,
          note: prev ? `${prev.note}\n${content}` : content,
          chapter: chapter || prev?.chapter || "",
          createdAt,
          used: false,
        });
      } else if (content) {
        standaloneReviews.push({
          chapter: chapter || "书评与想法",
          quote: content,
          note: "",
          createdAt,
        });
      }
    }
  }

  const out: ParsedWeReadBookEntry[] = [];
  const rawBookmarks = Array.isArray(bookmarksData.updated) ? bookmarksData.updated : [];
  for (const bm of rawBookmarks) {
    if (!bm || typeof bm !== "object") continue;
    const rec = bm as Record<string, unknown>;
    const quote = String(rec.markText ?? "").trim();
    if (!quote) continue;
    const chapterUid = Number(rec.chapterUid ?? -1);
    const chapter = chapterMap.get(chapterUid) ?? "";
    const createTime = Number(rec.createTime ?? 0);
    const createdAt = createTime > 0 ? new Date(createTime * 1000).toISOString() : new Date().toISOString();

    const key = quote.replace(/\s+/g, " ").toLowerCase();
    const matchedReview = reviewByQuote.get(key);
    let note = "";
    if (matchedReview) {
      note = matchedReview.note;
      matchedReview.used = true;
    }

    out.push({
      chapter: chapter || matchedReview?.chapter || "",
      quote,
      note,
      createdAt,
    });
  }

  // Append any thoughts attached to quotes not present in bookmarklist.
  for (const rev of reviewByQuote.values()) {
    if (rev.used) continue;
    out.push({
      chapter: rev.chapter,
      quote: rev.abstract,
      note: rev.note,
      createdAt: rev.createdAt,
    });
  }
  out.push(...standaloneReviews);

  return out;
}

export async function listWeReadNotebooks(cookies: NormalizedCookie[]): Promise<WeReadNotebookBook[]> {
  const cookieHeader = assertLoggedInCookies(cookies);
  const data = await fetchWeReadJson("/api/user/notebook", cookieHeader);
  return parseWeReadNotebooksResponse(data);
}

export async function syncWeReadBooksIntoDatabase(
  db: KnowledgeDatabase,
  cookies: NormalizedCookie[],
  books: WeReadNotebookBook[],
): Promise<WeReadSyncOutcome> {
  const cookieHeader = assertLoggedInCookies(cookies);
  const details: WeReadSyncBookResult[] = [];
  let totalImported = 0;
  let totalDedup = 0;

  for (const book of books) {
    const encodedId = encodeURIComponent(book.bookId);
    const [bmRes, revRes] = await Promise.all([
      fetchWeReadJson(`/web/book/bookmarklist?bookId=${encodedId}`, cookieHeader),
      fetchWeReadJson(`/web/review/list?bookId=${encodedId}&listType=11&mine=1&synckey=0`, cookieHeader).catch(
        () => ({ reviews: [] }),
      ),
    ]);

    const entries = mergeWeReadBookmarksAndReviews(bmRes, revRes);
    const localBook = db.findOrCreateBook({
      title: book.title,
      author: book.author,
      isbn: book.isbn,
      publisher: book.publisher,
      publishedYear: book.publishedYear,
      description: book.intro,
      coverUrl: book.coverUrl,
      source: "weread",
      sourceLocator: `https://weread.qq.com/web/reader/${book.bookId}`,
    });

    // Enrich missing metadata on existing books.
    if (
      (book.coverUrl && !localBook.coverUrl)
      || (book.publisher && !localBook.publisher)
      || (book.intro && !localBook.description)
      || (book.isbn && !localBook.isbn)
    ) {
      db.updateBook(localBook.id, {
        coverUrl: localBook.coverUrl || book.coverUrl,
        publisher: localBook.publisher || book.publisher,
        description: localBook.description || book.intro,
        isbn: localBook.isbn || book.isbn,
        publishedYear: localBook.publishedYear || book.publishedYear,
      });
    }

    let importedCount = 0;
    let deduplicatedCount = 0;
    for (const entry of entries) {
      const added = db.addHighlight({
        bookId: localBook.id,
        chapter: entry.chapter,
        quote: entry.quote,
        note: entry.note,
        source: "weread",
        createdAt: entry.createdAt,
      });
      if (added.deduplicated) deduplicatedCount++;
      else importedCount++;
    }

    totalImported += importedCount;
    totalDedup += deduplicatedCount;
    details.push({
      bookId: book.bookId,
      localBookId: localBook.id,
      title: book.title,
      importedCount,
      deduplicatedCount,
    });
  }

  return {
    booksSynced: details.length,
    importedCount: totalImported,
    deduplicatedCount: totalDedup,
    details,
  };
}
