import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BookIdentityIndex } from "./bookIdentity";
import type { ReaderAnnotation, ReaderAnnotationInput } from "../../src/types/desktop";
import { isReaderHighlightColor, type ReaderHighlightColor } from "./highlightColors";

export type BookSource = "weread" | "kindle" | "local" | "zlib" | "manual";
export type DraftKind = "review" | "card_copy" | "thread" | "script" | "note";
export type RevisionAuthorKind = "ai" | "human";

export interface BookRecord {
  id: string;
  title: string;
  author: string;
  isbn: string;
  publisher: string;
  publishedYear: string;
  description: string;
  tags: string[];
  coverUrl: string;
  source: BookSource;
  sourceLocator: string;
  createdAt: string;
  updatedAt: string;
  highlightCount: number;
  draftCount: number;
}

type BookPatch = Partial<Pick<BookRecord,
  "title" | "author" | "isbn" | "publisher" | "publishedYear" | "description" | "tags" | "coverUrl"
>>;
type NewBook = BookPatch & { title: string; source?: BookSource; sourceLocator?: string };

export interface HighlightRecord {
  id: string;
  bookId: string;
  chapter: string;
  quote: string;
  note: string;
  source: BookSource;
  fingerprint: string;
  cfi?: string;
  isHighlighted?: boolean;
  color?: ReaderHighlightColor;
  createdAt: string;
}

type NewHighlight = Pick<HighlightRecord, "bookId" | "quote"> &
  Partial<Pick<HighlightRecord, "chapter" | "note" | "source" | "createdAt">>;

export interface DraftRevisionRecord {
  id: string;
  draftId: string;
  revisionNo: number;
  authorKind: RevisionAuthorKind;
  content: string;
  sourceHighlightIds: string[];
  promptSummary: string;
  createdAt: string;
}

export interface DraftRecord {
  id: string;
  bookId: string | null;
  bookTitle: string;
  title: string;
  kind: DraftKind;
  createdAt: string;
  updatedAt: string;
  latestRevisionNo: number;
  latestAuthorKind: RevisionAuthorKind;
  latestContent: string;
  revisions?: DraftRevisionRecord[];
}

export interface ObsidianExportMapping {
  stableId: string;
  vaultPath: string;
  relativePath: string;
  lastExportedSha256: string;
  updatedAt: string;
}

export interface RecallHighlightItem extends HighlightRecord {
  bookTitle: string;
  bookAuthor: string;
  daysAgo: number;
}

export interface RelatedHighlightItem extends HighlightRecord {
  bookTitle: string;
  bookAuthor: string;
  matchedTerms: string[];
}

export type NotebookItemKind = "book" | "draft" | "web";

export interface NotebookItemRecord {
  id: string;
  notebookId: string;
  itemKind: NotebookItemKind;
  itemRef: string;
  title: string;
  meta: string;
  createdAt: string;
}

export interface NotebookRecord {
  id: string;
  name: string;
  icon: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  items: NotebookItemRecord[];
}

export interface ChatMessageToolState {
  name: string;
  status: "running" | "done";
}

export interface ChatMessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  text: string;
  reasoning: string;
  contexts: string[];
  tools: ChatMessageToolState[];
  createdAt: string;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  harnessSessionId: string;
  messageCount: number;
  preview: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSessionDetail extends ChatSessionSummary {
  messages: ChatMessageRecord[];
}

export interface ReadingStatsSummary {
  monthKey: string;
  totalBooks: number;
  totalHighlights: number;
  totalDrafts: number;
  monthBooksCount: number;
  monthHighlightsCount: number;
  monthBooks: Array<{ id: string; title: string; author: string; highlightCount: number }>;
  featuredQuotes: Array<{ quote: string; note: string; bookTitle: string; bookAuthor: string }>;
  suggestedKeywords: string[];
}

export function computeHighlightFingerprint(bookKey: string, quote: string, note: string): string {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return crypto
    .createHash("sha256")
    .update(`${norm(bookKey)}\n${norm(quote)}\n${norm(note)}`)
    .digest("hex");
}

function bookHighlightFingerprint(bookId: string, quote: string, note: string): string {
  return "v2:" + computeHighlightFingerprint(bookId, quote, note);
}

function requireReaderCfi(value: string): string {
  if (typeof value !== "string" || value.length > 16_384 || !/^epubcfi\(\/[\s\S]+\)$/.test(value)) {
    throw new Error("无法识别这段文字在 EPUB 中的位置。");
  }
  return value;
}

/** Roughly 20 MB of paragraph translations. */
export const READER_TRANSLATION_CACHE_LIMIT = 40_000;

function nowIso(): string {
  return new Date().toISOString();
}

const RELATED_STOPWORDS = new Set([
  "我们", "你们", "他们", "自己", "这个", "那个", "什么", "怎么", "为什么", "因为", "所以", "但是", "如果", "可以",
  "应该", "需要", "已经", "还是", "或者", "以及", "一个", "一些", "这种", "那种", "时候", "地方", "东西", "问题",
  "觉得", "认为", "发现", "感觉", "其实", "就是", "不是", "没有", "不要", "不能", "不会", "这里", "那里", "现在",
  "以前", "以后", "通过", "关于", "对于", "进行", "开始", "使用", "非常", "比较", "可能", "一定", "很多", "大家",
  "the", "and", "for", "that", "this", "with", "from", "have", "your", "about", "into", "more", "some", "what",
]);

export function extractSearchTermsFromDraft(rawText: string): { ftsTerms: string[]; shortTerms: string[] } {
  const cleaned = rawText
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^>\s*.*$/gm, " ") // Skip already-quoted lines so we surface fresh highlights
    .replace(/[#*_`~>\[\]()（）《》「」『』“”"'，。！？、：；,.!?;:|/\\+-]/g, " ")
    .trim();

  const ftsCounts = new Map<string, number>();
  const shortCounts = new Map<string, number>();

  // 1. English / alphanumeric tokens (>= 3 chars)
  for (const m of cleaned.matchAll(/[A-Za-z][A-Za-z0-9_-]{2,20}/g)) {
    const token = m[0].toLowerCase();
    if (RELATED_STOPWORDS.has(token)) continue;
    ftsCounts.set(token, (ftsCounts.get(token) ?? 0) + 2);
  }

  // 2. Chinese runs: extract clean 2-4 char candidate spans
  for (const m of cleaned.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const run = m[0];
    if (run.length <= 4) {
      if (!RELATED_STOPWORDS.has(run)) {
        if (run.length >= 3) ftsCounts.set(run, (ftsCounts.get(run) ?? 0) + 3);
        else shortCounts.set(run, (shortCounts.get(run) ?? 0) + 2);
      }
      continue;
    }
    // Extract 2-char and 3-char sliding tokens along longer Chinese phrases
    for (let i = 0; i <= run.length - 3; i++) {
      const tri = run.slice(i, i + 3);
      if (!RELATED_STOPWORDS.has(tri)) {
        ftsCounts.set(tri, (ftsCounts.get(tri) ?? 0) + 1);
      }
    }
    for (let i = 0; i <= run.length - 2; i += 2) {
      const bi = run.slice(i, i + 2);
      if (!RELATED_STOPWORDS.has(bi)) {
        shortCounts.set(bi, (shortCounts.get(bi) ?? 0) + 1);
      }
    }
  }

  const ftsTerms = [...ftsCounts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 10)
    .map(([t]) => t);

  const shortTerms = [...shortCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([t]) => t);

  return { ftsTerms, shortTerms };
}

function escapeFtsPhrase(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

export class KnowledgeDatabase {
  private readonly db: DatabaseSync;
  private readonly identities: BookIdentityIndex;
  readonly dbPath: string;
  private ftsAvailable = false;
  private readonly translationCacheLimit: number;

  constructor(dbPath: string, options: { translationCacheLimit?: number } = {}) {
    this.dbPath = dbPath;
    this.translationCacheLimit = options.translationCacheLimit ?? READER_TRANSLATION_CACHE_LIMIT;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.identities = new BookIdentityIndex(this.db);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS books (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        isbn TEXT NOT NULL DEFAULT '',
        publisher TEXT NOT NULL DEFAULT '',
        published_year TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        cover_url TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual',
        source_locator TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS book_identity (
        book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (book_id, kind, value)
      );
      CREATE INDEX IF NOT EXISTS idx_book_identity_lookup ON book_identity(kind, value);

      CREATE TABLE IF NOT EXISTS highlights (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        chapter TEXT NOT NULL DEFAULT '',
        quote TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual',
        fingerprint TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_highlights_book ON highlights(book_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS reader_documents (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        location TEXT NOT NULL DEFAULT '',
        book_id TEXT REFERENCES books(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS reader_file_revisions (
        content_hash TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES reader_documents(id) ON DELETE CASCADE,
        byte_length INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reader_revisions_document ON reader_file_revisions(document_id, byte_length);

      CREATE TABLE IF NOT EXISTS reader_translation_cache (
        cache_key TEXT PRIMARY KEY,
        translation TEXT NOT NULL,
        used_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reader_translation_used ON reader_translation_cache(used_at);

      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY,
        book_id TEXT REFERENCES books(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'review',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_drafts_updated ON drafts(updated_at DESC);

      CREATE TABLE IF NOT EXISTS draft_revisions (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
        revision_no INTEGER NOT NULL,
        author_kind TEXT NOT NULL CHECK (author_kind IN ('ai', 'human')),
        content TEXT NOT NULL,
        source_highlight_ids_json TEXT NOT NULL DEFAULT '[]',
        prompt_summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE(draft_id, revision_no)
      );

      CREATE TABLE IF NOT EXISTS obsidian_export_map (
        stable_id TEXT NOT NULL,
        vault_path TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        last_exported_sha256 TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (stable_id, vault_path)
      );

      CREATE TABLE IF NOT EXISTS notebooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        icon TEXT NOT NULL DEFAULT '✦',
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notebook_items (
        id TEXT PRIMARY KEY,
        notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
        item_kind TEXT NOT NULL CHECK (item_kind IN ('book', 'draft', 'web')),
        item_ref TEXT NOT NULL,
        title TEXT NOT NULL,
        meta TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE(notebook_id, item_kind, item_ref)
      );
      CREATE INDEX IF NOT EXISTS idx_notebook_items_nb ON notebook_items(notebook_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        harness_session_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at DESC);

      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL DEFAULT 0,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        text TEXT NOT NULL,
        reasoning TEXT NOT NULL DEFAULT '',
        contexts_json TEXT NOT NULL DEFAULT '[]',
        tools_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, seq ASC);
    `);

    this.transaction(() => {
      const columns = this.db.prepare("PRAGMA table_info(highlights)").all();
      if (!columns.some(column => column.name === "reader_document_id")) {
        this.db.exec("ALTER TABLE highlights ADD COLUMN reader_document_id TEXT REFERENCES reader_documents(id)");
        this.db.exec("ALTER TABLE highlights ADD COLUMN reader_cfi TEXT");
      }
      if (!columns.some(column => column.name === "reader_highlighted")) {
        this.db.exec("ALTER TABLE highlights ADD COLUMN reader_highlighted INTEGER NOT NULL DEFAULT 1 CHECK (reader_highlighted IN (0, 1))");
      }
      if (!columns.some(column => column.name === "reader_color")) {
        this.db.exec("ALTER TABLE highlights ADD COLUMN reader_color TEXT");
      }
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_reader_highlight_location
        ON highlights(reader_document_id, reader_cfi) WHERE reader_document_id IS NOT NULL`);
    });
    this.migrateBookIdentities();
    this.migrateDownloadCoverHints();
    this.migrateTranslationCache();

    // SQLite FTS5 trigram full-text index for fast Chinese substring search (inspired by MoreCut)
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS highlights_fts USING fts5(
          highlight_id UNINDEXED,
          quote,
          note,
          book_title,
          tokenize='trigram'
        );
      `);
      this.ftsAvailable = true;
      this.backfillHighlightsFts();
    } catch {
      this.ftsAvailable = false;
    }
  }

  transaction<T>(work: () => T): T {
    if (this.db.isTransaction) return work();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateDownloadCoverHints(): void {
    this.transaction(() => {
      const version = "schema.download-cover-hints.v2";
      if (this.getSetting(version)) return;
      // The old key was a one-way hash of the path. Its value includes the
      // filesystem revision, which survives a rename even before the upgrade.
      const rows = this.db.prepare("SELECT value FROM app_kv WHERE key GLOB 'download.cover.*' ORDER BY updated_at").all();
      for (const row of rows) {
        let saved;
        try { saved = JSON.parse(String(row.value)); } catch { continue; }
        if (typeof saved?.revision === "string" && saved.hint && saved.revision.split(":")[1] !== "0") {
          this.setSetting("download.cover-legacy." + saved.revision, JSON.stringify(saved.hint));
        }
      }
      this.setSetting(version, "1");
    });
    this.transaction(() => {
      const version = "schema.download-cover-hints.v3";
      if (this.getSetting(version)) return;
      // Path keys with an inode were copied to revision keys above and are no longer read.
      // Consumed revision keys used to be blanked instead of removed.
      const remove = this.db.prepare("DELETE FROM app_kv WHERE key = ?");
      for (const row of this.db.prepare("SELECT key, value FROM app_kv WHERE key GLOB 'download.cover.*'").all()) {
        let saved;
        try { saved = JSON.parse(String(row.value)); } catch { continue; }
        if (typeof saved?.revision === "string" && saved.revision.split(":")[1] !== "0") remove.run(String(row.key));
      }
      this.db.exec("DELETE FROM app_kv WHERE key GLOB 'download.cover-legacy.*' AND value = ''");
      this.setSetting(version, "1");
    });
  }

  /** Move per-paragraph translations out of the settings table into the bounded cache. */
  private migrateTranslationCache(): void {
    this.transaction(() => {
      this.db.exec(`INSERT OR IGNORE INTO reader_translation_cache (cache_key, translation, used_at)
        SELECT key, value, COALESCE(CAST(strftime('%s', updated_at) AS INTEGER) * 1000, 0)
        FROM app_kv WHERE key GLOB 'reader.translation.v1.*'`);
      this.db.exec("DELETE FROM app_kv WHERE key GLOB 'reader.translation.v1.*'");
      this.pruneReaderTranslations();
    });
  }

  readReaderTranslations(keys: readonly string[]): (string | null)[] {
    return this.transaction(() => {
      const read = this.db.prepare("SELECT translation FROM reader_translation_cache WHERE cache_key = ?");
      const touch = this.db.prepare("UPDATE reader_translation_cache SET used_at = ? WHERE cache_key = ?");
      const now = Date.now();
      return keys.map(key => {
        const row = read.get(key) as { translation: string } | undefined;
        if (!row) return null;
        touch.run(now, key);
        return row.translation;
      });
    });
  }

  saveReaderTranslations(entries: ReadonlyArray<readonly [key: string, translation: string]>): void {
    this.transaction(() => {
      const write = this.db.prepare(`INSERT INTO reader_translation_cache (cache_key, translation, used_at) VALUES (?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET translation = excluded.translation, used_at = excluded.used_at`);
      const now = Date.now();
      for (const [key, translation] of entries) write.run(key, translation, now);
      this.pruneReaderTranslations();
    });
  }

  /** Keep the most recently read translations; older paragraphs can be translated again on demand. */
  private pruneReaderTranslations(): void {
    this.db.prepare(`DELETE FROM reader_translation_cache WHERE cache_key IN (
      SELECT cache_key FROM reader_translation_cache ORDER BY used_at DESC LIMIT -1 OFFSET ?)`)
      .run(this.translationCacheLimit);
  }

  private migrateBookIdentities(): void {
    const versionKey = "schema.book-identity.v1";
    this.transaction(() => {
      if (this.getSetting(versionKey)) return;
      const books = this.db.prepare("SELECT id, title, isbn, source_locator AS sourceLocator FROM books").all() as
        Array<{ id: string; title: string; isbn: string; sourceLocator: string }>;
      const readHighlights = this.db.prepare("SELECT id, quote, note, fingerprint FROM highlights WHERE book_id = ? AND reader_document_id IS NULL ORDER BY created_at, id");
      const writeFingerprint = this.db.prepare("UPDATE highlights SET fingerprint = ? WHERE id = ?");
      for (const book of books) {
        this.identities.indexLegacyBook(book.id, book);
        // Old digests can prove a previous title, e.g. before an edition label or subtitle was added.
        const prefixes = [...book.title.matchAll(/[:：(（]/g)].map(match => book.title.slice(0, match.index).trim()).filter(Boolean);
        const seen = new Set<string>();
        for (const row of readHighlights.all(book.id) as Array<{ id: string; quote: string; note: string; fingerprint: string }>) {
          for (const title of prefixes) {
            if (computeHighlightFingerprint(title, row.quote, row.note) === row.fingerprint) {
              this.identities.remember(book.id, { title });
            }
          }
          const key = bookHighlightFingerprint(book.id, row.quote, row.note);
          // Preserve separately referenced legacy duplicates while deduplicating future imports.
          writeFingerprint.run(seen.has(key) ? key + ":" + row.id : key, row.id);
          seen.add(key);
        }
      }
      this.setSetting(versionKey, "1");
    });
  }

  private backfillHighlightsFts(): void {
    if (!this.ftsAvailable) return;
    const totalHighlights = Number(
      ((this.db.prepare("SELECT COUNT(*) AS c FROM highlights").get() as { c: number } | undefined)?.c) ?? 0,
    );
    const totalIndexed = Number(
      ((this.db.prepare("SELECT COUNT(*) AS c FROM highlights_fts").get() as { c: number } | undefined)?.c) ?? 0,
    );
    if (totalHighlights === totalIndexed) return;

    this.db.exec("DELETE FROM highlights_fts");
    const rows = this.db
      .prepare(
        `SELECT h.id, h.quote, h.note, b.title AS book_title
         FROM highlights h JOIN books b ON b.id = h.book_id`,
      )
      .all() as Array<{ id: string; quote: string; note: string; book_title: string }>;
    const ins = this.db.prepare(
      "INSERT INTO highlights_fts (highlight_id, quote, note, book_title) VALUES (?, ?, ?, ?)",
    );
    for (const r of rows) {
      ins.run(r.id, r.quote, r.note, r.book_title);
    }
  }

  private upsertHighlightFts(highlightId: string, quote: string, note: string, bookTitle: string): void {
    if (!this.ftsAvailable) return;
    try {
      this.db.prepare("DELETE FROM highlights_fts WHERE highlight_id = ?").run(highlightId);
      this.db
        .prepare("INSERT INTO highlights_fts (highlight_id, quote, note, book_title) VALUES (?, ?, ?, ?)")
        .run(highlightId, quote, note, bookTitle);
    } catch {
      // Non-fatal index sync error
    }
  }

  private deleteHighlightFts(highlightId: string): void {
    if (!this.ftsAvailable) return;
    try {
      this.db.prepare("DELETE FROM highlights_fts WHERE highlight_id = ?").run(highlightId);
    } catch {
      // Non-fatal
    }
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM app_kv WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  deleteSetting(key: string): void {
    this.db.prepare("DELETE FROM app_kv WHERE key = ?").run(key);
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, nowIso());
  }

  // ---------- Books ----------

  listBooks(query = ""): BookRecord[] {
    const q = query.trim();
    const sql = q
      ? `SELECT b.*,
            (SELECT COUNT(*) FROM highlights h WHERE h.book_id = b.id) AS highlight_count,
            (SELECT COUNT(*) FROM drafts d WHERE d.book_id = b.id) AS draft_count
         FROM books b
         WHERE b.title LIKE ? OR b.author LIKE ? OR b.isbn LIKE ? OR b.tags_json LIKE ?
         ORDER BY b.updated_at DESC`
      : `SELECT b.*,
            (SELECT COUNT(*) FROM highlights h WHERE h.book_id = b.id) AS highlight_count,
            (SELECT COUNT(*) FROM drafts d WHERE d.book_id = b.id) AS draft_count
         FROM books b
         ORDER BY b.updated_at DESC`;
    const rows = (
      q
        ? this.db.prepare(sql).all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
        : this.db.prepare(sql).all()
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapBookRow(r));
  }

  getBook(id: string): BookRecord | null {
    const row = this.db
      .prepare(
        `SELECT b.*,
            (SELECT COUNT(*) FROM highlights h WHERE h.book_id = b.id) AS highlight_count,
            (SELECT COUNT(*) FROM drafts d WHERE d.book_id = b.id) AS draft_count
         FROM books b WHERE b.id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapBookRow(row) : null;
  }

  findOrCreateBook(input: NewBook): BookRecord {
    return this.transaction(() => this.findOrInsertBook(input));
  }

  private findOrInsertBook(input: NewBook): BookRecord {
    const title = input.title.trim();
    if (!title) throw new Error("书名不能为空");
    const author = (input.author ?? "").trim();

    const existingId = this.identities.find(input);
    if (existingId) {
      const current = this.getBook(existingId)!;
      this.identities.remember(existingId, { title, sourceLocator: input.sourceLocator });
      if ((author && !current.author) || (input.isbn && !current.isbn)) {
        return this.updateBook(existingId, { author: current.author || author, isbn: current.isbn || input.isbn });
      }
      return current;
    }

    const id = `bk_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO books (id, title, author, isbn, publisher, published_year, description, tags_json, cover_url, source, source_locator, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        title,
        author,
        (input.isbn ?? "").trim(),
        (input.publisher ?? "").trim(),
        (input.publishedYear ?? "").trim(),
        (input.description ?? "").trim(),
        JSON.stringify(input.tags ?? []),
        (input.coverUrl ?? "").trim(),
        input.source ?? "manual",
        (input.sourceLocator ?? "").trim(),
        ts,
        ts,
      );
    this.identities.remember(id, input);
    return this.getBook(id)!;
  }

  updateBook(id: string, patch: BookPatch, editionTitle?: string): BookRecord {
    return this.transaction(() => this.updateBookRecord(id, patch, editionTitle));
  }

  private updateBookRecord(id: string, patch: BookPatch, editionTitle?: string): BookRecord {
    const existing = this.getBook(id);
    if (!existing) throw new Error(`未找到书籍: ${id}`);
    const nextTitle = patch.title !== undefined ? patch.title.trim() : existing.title;
    if (!nextTitle) throw new Error("书名不能为空");

    this.db
      .prepare(
        `UPDATE books
         SET title = ?, author = ?, isbn = ?, publisher = ?, published_year = ?, description = ?, tags_json = ?, cover_url = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        nextTitle,
        patch.author !== undefined ? patch.author.trim() : existing.author,
        patch.isbn !== undefined ? patch.isbn.trim() : existing.isbn,
        patch.publisher !== undefined ? patch.publisher.trim() : existing.publisher,
        patch.publishedYear !== undefined ? patch.publishedYear.trim() : existing.publishedYear,
        patch.description !== undefined ? patch.description.trim() : existing.description,
        JSON.stringify(patch.tags !== undefined ? patch.tags : existing.tags),
        patch.coverUrl !== undefined ? patch.coverUrl.trim() : existing.coverUrl,
        nowIso(),
        id,
      );
    if (patch.title !== undefined) this.identities.remember(id, { title: nextTitle });
    if (editionTitle) this.identities.remember(id, { title: editionTitle });
    if (patch.isbn !== undefined) this.identities.replaceIsbn(id, patch.isbn);
    return this.getBook(id)!;
  }

  deleteBook(id: string): void {
    if (this.ftsAvailable) {
      try {
        const hlIds = this.db
          .prepare("SELECT id FROM highlights WHERE book_id = ?")
          .all(id) as Array<{ id: string }>;
        for (const r of hlIds) {
          this.deleteHighlightFts(r.id);
        }
      } catch {
        // Non-fatal
      }
    }
    this.db.prepare("DELETE FROM notebook_items WHERE item_kind = 'book' AND item_ref = ?").run(id);
    this.db.prepare("DELETE FROM books WHERE id = ?").run(id);
  }

  // ---------- Local EPUB reading ----------

  readerDocumentId(contentHash: string): string {
    const row = this.db.prepare("SELECT document_id FROM reader_file_revisions WHERE content_hash = ?").get(contentHash);
    return row ? String(row.document_id) : contentHash;
  }

  readerRevisionSizes(documentId: string): number[] {
    return this.db.prepare(`SELECT byte_length FROM reader_documents WHERE id = ?
      UNION SELECT byte_length FROM reader_file_revisions WHERE document_id = ?`)
      .all(documentId, documentId).map(row => Number(row.byte_length));
  }

  registerReaderRevision(filePath: string, before: { hash: string; size: number }, after: { hash: string; size: number }): void {
    this.transaction(() => {
      const id = this.readerDocumentId(before.hash);
      const known = this.readerDocumentId(after.hash);
      if (known !== id && (known !== after.hash || this.db.prepare("SELECT id FROM reader_documents WHERE id = ?").get(known))) {
        throw new Error("修改后的文件已关联另一本书的阅读记录，无法覆盖。");
      }
      this.db.prepare("INSERT OR IGNORE INTO reader_documents (id, file_path, byte_length) VALUES (?, ?, ?)")
        .run(id, filePath, before.size);
      const insert = this.db.prepare("INSERT OR IGNORE INTO reader_file_revisions (content_hash, document_id, byte_length) VALUES (?, ?, ?)");
      insert.run(before.hash, id, before.size);
      insert.run(after.hash, id, after.size);
    });
  }

  openReaderDocument(id: string, filePath: string, size: number): { location: string; annotations: ReaderAnnotation[] } {
    return this.transaction(() => {
      const row = this.db.prepare(`INSERT INTO reader_documents (id, file_path, byte_length) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET file_path = excluded.file_path, byte_length = excluded.byte_length RETURNING location`)
        .get(id, filePath, size)!;
      const rows = this.db.prepare("SELECT * FROM highlights WHERE reader_document_id = ? ORDER BY created_at")
        .all(id);
      return { location: String(row.location), annotations: rows.map(r => this.mapReaderAnnotation(r)) };
    });
  }

  saveReaderLocation(id: string, cfi: string): void {
    const changes = this.db.prepare("UPDATE reader_documents SET location = ? WHERE id = ?")
      .run(requireReaderCfi(cfi), id).changes;
    if (!changes) throw new Error("请重新打开这本电子书。");
  }

  addReaderAnnotation(input: ReaderAnnotationInput): ReaderAnnotation {
    const cfi = requireReaderCfi(input.cfi);
    if (input.color !== undefined && !isReaderHighlightColor(input.color)) throw new Error("不支持这种划线颜色。");
    const color = input.color;
    return this.transaction(() => {
      const doc = this.db.prepare("SELECT book_id FROM reader_documents WHERE id = ?").get(input.documentId);
      if (!doc) throw new Error("请重新打开这本电子书。");
      let bookId = String(doc.book_id ?? "");
      if (!bookId) {
        bookId = this.findOrCreateBook({
          title: input.title, author: input.author, isbn: input.isbn, source: "local",
          sourceLocator: "urn:sha256:" + input.documentId,
        }).id;
        this.db.prepare("UPDATE reader_documents SET book_id = ? WHERE id = ?").run(bookId, input.documentId);
      }
      const result = this.insertHighlight({
        bookId, chapter: input.chapter, quote: input.quote, note: input.note, source: "local",
      }, { documentId: input.documentId, cfi, color: color ?? "yellow" });
      const id = result.record.id;
      if (result.deduplicated && input.note !== undefined) {
        const updated = this.updateHighlightNote(id, input.note);
        if (!updated) throw new Error("请在「阅读笔记」中删除这条想法。");
      } else {
        this.db.prepare("UPDATE highlights SET reader_highlighted = 1 WHERE id = ?").run(id);
      }
      if (color) this.db.prepare("UPDATE highlights SET reader_color = ? WHERE id = ?").run(color, id);
      return this.mapReaderAnnotation(this.db.prepare("SELECT * FROM highlights WHERE id = ?").get(id)!);
    });
  }

  removeReaderAnnotation(documentId: string, highlightId: string): ReaderAnnotation | null {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM highlights WHERE reader_document_id = ? AND id = ?")
        .get(documentId, highlightId);
      if (!row) return null;
      if (!row.note) {
        this.deleteHighlight(highlightId);
        return null;
      }
      this.db.prepare("UPDATE highlights SET reader_highlighted = 0 WHERE id = ?").run(highlightId);
      return this.mapReaderAnnotation({ ...row, reader_highlighted: 0 });
    });
  }

  readerHighlightTarget(highlightId: string) {
    const row = this.db.prepare(`SELECT h.reader_cfi, d.id, d.file_path, d.byte_length FROM highlights h
      JOIN reader_documents d ON h.reader_document_id = d.id WHERE h.id = ?`).get(highlightId);
    if (!row) throw new Error("这条划线没有本地原文位置。");
    return { documentId: String(row.id), filePath: String(row.file_path), size: Number(row.byte_length), cfi: String(row.reader_cfi) };
  }

  // ---------- Highlights ----------

  listHighlights(bookId: string, query = ""): HighlightRecord[] {
    const q = query.trim();
    const rows = (
      q
        ? this.db
            .prepare(
              `SELECT * FROM highlights
               WHERE book_id = ? AND (quote LIKE ? OR note LIKE ? OR chapter LIKE ?)
               ORDER BY created_at DESC`,
            )
            .all(bookId, `%${q}%`, `%${q}%`, `%${q}%`)
        : this.db
            .prepare("SELECT * FROM highlights WHERE book_id = ? ORDER BY created_at DESC")
            .all(bookId)
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapHighlightRow(r));
  }

  searchAllHighlights(query: string, limit = 30): Array<HighlightRecord & { bookTitle: string; bookAuthor: string }> {
    const q = query.trim();
    const safeLimit = Math.max(1, Math.min(100, limit));
    if (q && this.ftsAvailable && q.length >= 3) {
      try {
        const rows = this.db
          .prepare(
            `SELECT h.*, b.title AS book_title, b.author AS book_author
             FROM highlights_fts f
             JOIN highlights h ON h.id = f.highlight_id
             JOIN books b ON b.id = h.book_id
             WHERE highlights_fts MATCH ?
             ORDER BY bm25(highlights_fts), h.created_at DESC
             LIMIT ?`,
          )
          .all(escapeFtsPhrase(q), safeLimit) as Array<Record<string, unknown>>;
        if (rows.length > 0) {
          return rows.map((r) => ({
            ...this.mapHighlightRow(r),
            bookTitle: String(r.book_title ?? ""),
            bookAuthor: String(r.book_author ?? ""),
          }));
        }
      } catch {
        // Fall through to LIKE search below
      }
    }
    const rows = (
      q
        ? this.db
            .prepare(
              `SELECT h.*, b.title AS book_title, b.author AS book_author
               FROM highlights h JOIN books b ON b.id = h.book_id
               WHERE h.quote LIKE ? OR h.note LIKE ? OR b.title LIKE ?
               ORDER BY h.created_at DESC LIMIT ?`,
            )
            .all(`%${q}%`, `%${q}%`, `%${q}%`, safeLimit)
        : this.db
            .prepare(
              `SELECT h.*, b.title AS book_title, b.author AS book_author
               FROM highlights h JOIN books b ON b.id = h.book_id
               ORDER BY h.created_at DESC LIMIT ?`,
            )
            .all(safeLimit)
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      ...this.mapHighlightRow(r),
      bookTitle: String(r.book_title ?? ""),
      bookAuthor: String(r.book_author ?? ""),
    }));
  }

  /**
   * Surface related past highlights automatically while the user writes a draft,
   * powered by SQLite FTS5 trigram matching with 2-char Chinese fallback.
   */
  findRelatedHighlights(rawText: string, limit = 4): RelatedHighlightItem[] {
    const trimmed = rawText.trim();
    if (trimmed.length < 6) return [];
    const safeLimit = Math.max(1, Math.min(10, limit));
    const { ftsTerms, shortTerms } = extractSearchTermsFromDraft(trimmed);
    if (ftsTerms.length === 0 && shortTerms.length === 0) return [];

    const scored = new Map<
      string,
      { row: Record<string, unknown>; score: number; terms: Set<string> }
    >();

    const recordHit = (r: Record<string, unknown>, term: string, weight: number) => {
      const id = String(r.id ?? "");
      if (!id) return;
      const quote = String(r.quote ?? "").trim();
      // Skip highlights already pasted verbatim into the active draft
      if (quote.length >= 12 && trimmed.includes(quote.slice(0, Math.min(24, quote.length)))) {
        return;
      }
      const existing = scored.get(id);
      if (existing) {
        existing.score += weight;
        existing.terms.add(term);
      } else {
        scored.set(id, { row: r, score: weight, terms: new Set([term]) });
      }
    };

    if (this.ftsAvailable && ftsTerms.length > 0) {
      const ftsStmt = this.db.prepare(
        `SELECT h.*, b.title AS book_title, b.author AS book_author
         FROM highlights_fts f
         JOIN highlights h ON h.id = f.highlight_id
         JOIN books b ON b.id = h.book_id
         WHERE highlights_fts MATCH ?
         ORDER BY bm25(highlights_fts)
         LIMIT 8`,
      );
      for (const term of ftsTerms) {
        try {
          const hits = ftsStmt.all(escapeFtsPhrase(term)) as Array<Record<string, unknown>>;
          for (const h of hits) {
            recordHit(h, term, 3);
          }
        } catch {
          // Ignore malformed FTS query term
        }
      }
    }

    if (scored.size < safeLimit && shortTerms.length > 0) {
      const likeStmt = this.db.prepare(
        `SELECT h.*, b.title AS book_title, b.author AS book_author
         FROM highlights h JOIN books b ON b.id = h.book_id
         WHERE h.quote LIKE ? OR h.note LIKE ?
         ORDER BY h.created_at DESC
         LIMIT 8`,
      );
      for (const term of shortTerms) {
        const hits = likeStmt.all(`%${term}%`, `%${term}%`) as Array<Record<string, unknown>>;
        for (const h of hits) {
          recordHit(h, term, 1.5);
        }
      }
    }

    return [...scored.values()]
      .sort((a, b) => b.score - a.score || b.terms.size - a.terms.size)
      .slice(0, safeLimit)
      .map(({ row, terms }) => ({
        ...this.mapHighlightRow(row),
        bookTitle: String(row.book_title ?? ""),
        bookAuthor: String(row.book_author ?? ""),
        matchedTerms: [...terms].slice(0, 3),
      }));
  }

  addHighlight(input: NewHighlight): { record: HighlightRecord; deduplicated: boolean } {
    return this.transaction(() => this.insertHighlight(input));
  }

  private insertHighlight(input: NewHighlight, anchor?: { documentId: string; cfi: string; color: ReaderHighlightColor }): { record: HighlightRecord; deduplicated: boolean } {
    const book = this.getBook(input.bookId);
    if (!book) throw new Error(`书籍不存在: ${input.bookId}`);
    const quote = input.quote.trim();
    if (!quote) throw new Error("划线内容不能为空");
    const note = (input.note ?? "").trim();
    const fingerprint = anchor
      ? "reader:" + crypto.createHash("sha256").update(anchor.documentId + "\n" + anchor.cfi).digest("hex")
      : bookHighlightFingerprint(book.id, quote, note);

    const existing = this.db
      .prepare("SELECT * FROM highlights WHERE book_id = ? AND (fingerprint = ? OR fingerprint GLOB ?) ORDER BY fingerprint LIMIT 1")
      .get(book.id, fingerprint, fingerprint + ":*") as Record<string, unknown> | undefined;
    if (existing) {
      return { record: this.mapHighlightRow(existing), deduplicated: true };
    }

    const id = `hl_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const ts = input.createdAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO highlights (id, book_id, chapter, quote, note, source, fingerprint, created_at, reader_document_id, reader_cfi, reader_color)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, book.id, (input.chapter ?? "").trim(), quote, note, input.source ?? book.source, fingerprint, ts,
        anchor?.documentId ?? null, anchor?.cfi ?? null, anchor?.color ?? null);
    this.db.prepare("UPDATE books SET updated_at = ? WHERE id = ?").run(nowIso(), book.id);
    this.upsertHighlightFts(id, quote, note, book.title);

    const inserted = this.db.prepare("SELECT * FROM highlights WHERE id = ?").get(id) as Record<string, unknown>;
    return { record: this.mapHighlightRow(inserted), deduplicated: false };
  }

  updateHighlightNote(id: string, note: string): HighlightRecord | null {
    return this.transaction(() => this.editHighlightNote(id, note.trim()));
  }

  private editHighlightNote(id: string, nextNote: string): HighlightRecord | null {
    const row = this.db.prepare("SELECT * FROM highlights WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error(`划线不存在: ${id}`);
    if (!nextNote && row.reader_document_id && !row.reader_highlighted) {
      this.deleteHighlight(id);
      return null;
    }
    if (nextNote === row.note) return this.mapHighlightRow(row);
    const book = this.getBook(String(row.book_id));
    const nextFp = row.reader_document_id ? String(row.fingerprint) : bookHighlightFingerprint(String(row.book_id), String(row.quote), nextNote);
    this.db.prepare("UPDATE highlights SET note = ?, fingerprint = ? WHERE id = ?").run(nextNote, nextFp, id);
    this.upsertHighlightFts(id, String(row.quote), nextNote, book?.title ?? "");
    const updated = this.db.prepare("SELECT * FROM highlights WHERE id = ?").get(id) as Record<string, unknown>;
    return this.mapHighlightRow(updated);
  }

  deleteHighlight(id: string): void {
    this.deleteHighlightFts(id);
    this.db.prepare("DELETE FROM highlights WHERE id = ?").run(id);
  }

  /**
   * Pick a random highlight for the Golden Retriever pet's spaced-recall nudge,
   * preferring older highlights or ones with personal thoughts.
   */
  getRandomRecallHighlight(excludeId?: string): RecallHighlightItem | null {
    const rows = this.db
      .prepare(
        `SELECT h.*, b.title AS book_title, b.author AS book_author
         FROM highlights h
         JOIN books b ON b.id = h.book_id
         ORDER BY h.created_at ASC
         LIMIT 200`,
      )
      .all() as Array<Record<string, unknown>>;

    if (rows.length === 0) return null;
    const pool = excludeId && rows.length > 1 ? rows.filter((r) => String(r.id) !== excludeId) : rows;
    if (pool.length === 0) return null;

    // Weight highlights with personal notes 2x higher for richer recall.
    const weighted: Array<Record<string, unknown>> = [];
    for (const row of pool) {
      weighted.push(row);
      if (String(row.note ?? "").trim().length > 0) {
        weighted.push(row);
      }
    }
    const chosen = weighted[Math.floor(Math.random() * weighted.length)]!;
    const mapped = this.mapHighlightRow(chosen);
    const createdMs = Date.parse(mapped.createdAt);
    const daysAgo = Number.isFinite(createdMs)
      ? Math.max(0, Math.floor((Date.now() - createdMs) / 86_400_000))
      : 0;

    return {
      ...mapped,
      bookTitle: String(chosen.book_title ?? ""),
      bookAuthor: String(chosen.book_author ?? ""),
      daysAgo,
    };
  }

  /**
   * Compute reading summary statistics (total + target month YYYY-MM) for
   * the Monthly Reading Poster and companion pet milestones.
   */
  getReadingStats(monthKey?: string): ReadingStatsSummary {
    const now = new Date();
    const key =
      monthKey && /^\d{4}-\d{2}$/.test(monthKey)
        ? monthKey
        : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    const totalBooks = Number(
      ((this.db.prepare("SELECT COUNT(*) AS c FROM books").get() as { c: number } | undefined)?.c) ?? 0,
    );
    const totalHighlights = Number(
      ((this.db.prepare("SELECT COUNT(*) AS c FROM highlights").get() as { c: number } | undefined)?.c) ?? 0,
    );
    const totalDrafts = Number(
      ((this.db.prepare("SELECT COUNT(*) AS c FROM drafts").get() as { c: number } | undefined)?.c) ?? 0,
    );

    const monthPrefix = `${key}%`;
    const monthHighlightsCount = Number(
      (
        this.db.prepare("SELECT COUNT(*) AS c FROM highlights WHERE created_at LIKE ?").get(monthPrefix) as
          | { c: number }
          | undefined
      )?.c ?? 0,
    );

    const monthBookRows = this.db
      .prepare(
        `SELECT b.id, b.title, b.author,
            (SELECT COUNT(*) FROM highlights h WHERE h.book_id = b.id AND h.created_at LIKE ?) AS month_hl,
            (SELECT COUNT(*) FROM highlights h WHERE h.book_id = b.id) AS total_hl
         FROM books b
         WHERE b.updated_at LIKE ? OR EXISTS (SELECT 1 FROM highlights h WHERE h.book_id = b.id AND h.created_at LIKE ?)
         ORDER BY month_hl DESC, b.updated_at DESC
         LIMIT 8`,
      )
      .all(monthPrefix, monthPrefix, monthPrefix) as Array<Record<string, unknown>>;

    const fallbackBooks =
      monthBookRows.length > 0
        ? monthBookRows
        : (this.db
            .prepare(
              `SELECT b.id, b.title, b.author,
                  (SELECT COUNT(*) FROM highlights h WHERE h.book_id = b.id) AS total_hl
               FROM books b
               ORDER BY total_hl DESC, b.updated_at DESC
               LIMIT 6`,
            )
            .all() as Array<Record<string, unknown>>);

    const monthBooks = fallbackBooks.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      author: String(r.author ?? ""),
      highlightCount: Number(r.month_hl ?? r.total_hl ?? 0),
    }));

    const monthQuotes = this.db
      .prepare(
        `SELECT h.quote, h.note, b.title AS book_title, b.author AS book_author
         FROM highlights h JOIN books b ON b.id = h.book_id
         WHERE h.created_at LIKE ?
         ORDER BY length(h.note) DESC, h.created_at DESC
         LIMIT 5`,
      )
      .all(monthPrefix) as Array<Record<string, unknown>>;

    const quoteRows =
      monthQuotes.length > 0
        ? monthQuotes
        : (this.db
            .prepare(
              `SELECT h.quote, h.note, b.title AS book_title, b.author AS book_author
               FROM highlights h JOIN books b ON b.id = h.book_id
               ORDER BY length(h.note) DESC, h.created_at DESC
               LIMIT 5`,
            )
            .all() as Array<Record<string, unknown>>);

    const featuredQuotes = quoteRows.slice(0, 3).map((r) => ({
      quote: String(r.quote ?? ""),
      note: String(r.note ?? ""),
      bookTitle: String(r.book_title ?? ""),
      bookAuthor: String(r.book_author ?? ""),
    }));

    // Collect distinct book tags as suggested poster keywords.
    const tagSet = new Set<string>();
    const allBookTags = this.db.prepare("SELECT tags_json FROM books ORDER BY updated_at DESC LIMIT 30").all() as Array<{
      tags_json: string;
    }>;
    for (const row of allBookTags) {
      try {
        const parsed = JSON.parse(row.tags_json) as unknown;
        if (Array.isArray(parsed)) {
          for (const t of parsed) {
            const clean = String(t ?? "").trim();
            if (clean && clean !== "diandian" && clean !== "reading") tagSet.add(clean);
          }
        }
      } catch {
        // Ignore.
      }
    }

    return {
      monthKey: key,
      totalBooks,
      totalHighlights,
      totalDrafts,
      monthBooksCount: monthBookRows.length,
      monthHighlightsCount,
      monthBooks,
      featuredQuotes,
      suggestedKeywords: [...tagSet].slice(0, 6),
    };
  }

  // ---------- Drafts & Immutable Revisions ----------

  listDrafts(bookId?: string): DraftRecord[] {
    const sql = bookId
      ? `SELECT d.*, COALESCE(b.title, '') AS book_title,
            r.revision_no AS latest_revision_no, r.author_kind AS latest_author_kind, r.content AS latest_content
         FROM drafts d
         LEFT JOIN books b ON b.id = d.book_id
         JOIN draft_revisions r ON r.draft_id = d.id
           AND r.revision_no = (SELECT MAX(revision_no) FROM draft_revisions WHERE draft_id = d.id)
         WHERE d.book_id = ?
         ORDER BY d.updated_at DESC`
      : `SELECT d.*, COALESCE(b.title, '') AS book_title,
            r.revision_no AS latest_revision_no, r.author_kind AS latest_author_kind, r.content AS latest_content
         FROM drafts d
         LEFT JOIN books b ON b.id = d.book_id
         JOIN draft_revisions r ON r.draft_id = d.id
           AND r.revision_no = (SELECT MAX(revision_no) FROM draft_revisions WHERE draft_id = d.id)
         ORDER BY d.updated_at DESC`;
    const rows = (bookId ? this.db.prepare(sql).all(bookId) : this.db.prepare(sql).all()) as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => this.mapDraftRow(r));
  }

  getDraft(id: string): DraftRecord | null {
    const row = this.db
      .prepare(
        `SELECT d.*, COALESCE(b.title, '') AS book_title,
            r.revision_no AS latest_revision_no, r.author_kind AS latest_author_kind, r.content AS latest_content
         FROM drafts d
         LEFT JOIN books b ON b.id = d.book_id
         JOIN draft_revisions r ON r.draft_id = d.id
           AND r.revision_no = (SELECT MAX(revision_no) FROM draft_revisions WHERE draft_id = d.id)
         WHERE d.id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const revRows = this.db
      .prepare("SELECT * FROM draft_revisions WHERE draft_id = ? ORDER BY revision_no ASC")
      .all(id) as Array<Record<string, unknown>>;
    return {
      ...this.mapDraftRow(row),
      revisions: revRows.map((rr) => this.mapRevisionRow(rr)),
    };
  }

  createDraft(input: {
    bookId?: string | null;
    title: string;
    kind: DraftKind;
    authorKind: RevisionAuthorKind;
    content: string;
    sourceHighlightIds?: string[];
    promptSummary?: string;
  }): DraftRecord {
    const title = input.title.trim();
    if (!title) throw new Error("草稿标题不能为空");
    const content = input.content.trim();
    if (!content) throw new Error("草稿内容不能为空");

    const draftId = `dr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const revId = `rv_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const ts = nowIso();

    this.db
      .prepare("INSERT INTO drafts (id, book_id, title, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(draftId, input.bookId ?? null, title, input.kind, ts, ts);

    this.db
      .prepare(
        `INSERT INTO draft_revisions (id, draft_id, revision_no, author_kind, content, source_highlight_ids_json, prompt_summary, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        revId,
        draftId,
        input.authorKind,
        content,
        JSON.stringify(input.sourceHighlightIds ?? []),
        (input.promptSummary ?? "").trim(),
        ts,
      );

    return this.getDraft(draftId)!;
  }

  /**
   * Append an immutable revision — AI originals are NEVER overwritten.
   */
  appendDraftRevision(input: {
    draftId: string;
    title?: string;
    authorKind: RevisionAuthorKind;
    content: string;
    sourceHighlightIds?: string[];
    promptSummary?: string;
  }): DraftRecord {
    const existing = this.getDraft(input.draftId);
    if (!existing) throw new Error(`草稿不存在: ${input.draftId}`);
    const content = input.content.trim();
    if (!content) throw new Error("修订内容不能为空");

    const nextRevNo = existing.latestRevisionNo + 1;
    const revId = `rv_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const ts = nowIso();

    this.db
      .prepare(
        `INSERT INTO draft_revisions (id, draft_id, revision_no, author_kind, content, source_highlight_ids_json, prompt_summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        revId,
        input.draftId,
        nextRevNo,
        input.authorKind,
        content,
        JSON.stringify(input.sourceHighlightIds ?? []),
        (input.promptSummary ?? "").trim(),
        ts,
      );

    const nextTitle = input.title !== undefined && input.title.trim() ? input.title.trim() : existing.title;
    this.db.prepare("UPDATE drafts SET title = ?, updated_at = ? WHERE id = ?").run(nextTitle, ts, input.draftId);
    return this.getDraft(input.draftId)!;
  }

  deleteDraft(id: string): void {
    this.db.prepare("DELETE FROM drafts WHERE id = ?").run(id);
  }

  // ---------- Obsidian Export Map ----------

  getObsidianMapping(stableId: string, vaultPath: string): ObsidianExportMapping | null {
    const row = this.db
      .prepare("SELECT * FROM obsidian_export_map WHERE stable_id = ? AND vault_path = ?")
      .get(stableId, vaultPath) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      stableId: String(row.stable_id),
      vaultPath: String(row.vault_path),
      relativePath: String(row.relative_path),
      lastExportedSha256: String(row.last_exported_sha256),
      updatedAt: String(row.updated_at),
    };
  }

  saveObsidianMapping(mapping: Omit<ObsidianExportMapping, "updatedAt">): void {
    this.db
      .prepare(
        `INSERT INTO obsidian_export_map (stable_id, vault_path, relative_path, last_exported_sha256, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(stable_id, vault_path) DO UPDATE SET
           relative_path = excluded.relative_path,
           last_exported_sha256 = excluded.last_exported_sha256,
           updated_at = excluded.updated_at`,
      )
      .run(mapping.stableId, mapping.vaultPath, mapping.relativePath, mapping.lastExportedSha256, nowIso());
  }

  private mapBookRow(r: Record<string, unknown>): BookRecord {
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(String(r.tags_json ?? "[]")) as unknown;
      if (Array.isArray(parsed)) tags = parsed.map((v) => String(v));
    } catch {
      tags = [];
    }
    return {
      id: String(r.id),
      title: String(r.title),
      author: String(r.author ?? ""),
      isbn: String(r.isbn ?? ""),
      publisher: String(r.publisher ?? ""),
      publishedYear: String(r.published_year ?? ""),
      description: String(r.description ?? ""),
      tags,
      coverUrl: String(r.cover_url ?? ""),
      source: String(r.source ?? "manual") as BookSource,
      sourceLocator: String(r.source_locator ?? ""),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      highlightCount: Number(r.highlight_count ?? 0),
      draftCount: Number(r.draft_count ?? 0),
    };
  }

  private mapHighlightRow(r: Record<string, unknown>): HighlightRecord {
    return {
      id: String(r.id),
      bookId: String(r.book_id),
      chapter: String(r.chapter ?? ""),
      quote: String(r.quote),
      note: String(r.note ?? ""),
      source: String(r.source ?? "manual") as BookSource,
      fingerprint: String(r.fingerprint),
      ...(r.reader_cfi ? {
        cfi: String(r.reader_cfi),
        isHighlighted: Boolean(r.reader_highlighted),
        color: isReaderHighlightColor(r.reader_color) ? r.reader_color : "yellow",
      } : {}),
      createdAt: String(r.created_at),
    };
  }

  private mapReaderAnnotation(row: Record<string, unknown>): ReaderAnnotation {
    return {
      ...this.mapHighlightRow(row),
      cfi: String(row.reader_cfi),
      isHighlighted: Boolean(row.reader_highlighted),
      color: isReaderHighlightColor(row.reader_color) ? row.reader_color : "yellow",
    };
  }

  private mapDraftRow(r: Record<string, unknown>): DraftRecord {
    return {
      id: String(r.id),
      bookId: r.book_id ? String(r.book_id) : null,
      bookTitle: String(r.book_title ?? ""),
      title: String(r.title),
      kind: String(r.kind ?? "review") as DraftKind,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      latestRevisionNo: Number(r.latest_revision_no ?? 1),
      latestAuthorKind: String(r.latest_author_kind ?? "ai") as RevisionAuthorKind,
      latestContent: String(r.latest_content ?? ""),
    };
  }

  private mapRevisionRow(r: Record<string, unknown>): DraftRevisionRecord {
    let sourceIds: string[] = [];
    try {
      const parsed = JSON.parse(String(r.source_highlight_ids_json ?? "[]")) as unknown;
      if (Array.isArray(parsed)) sourceIds = parsed.map((v) => String(v));
    } catch {
      sourceIds = [];
    }
    return {
      id: String(r.id),
      draftId: String(r.draft_id),
      revisionNo: Number(r.revision_no),
      authorKind: String(r.author_kind) as RevisionAuthorKind,
      content: String(r.content),
      sourceHighlightIds: sourceIds,
      promptSummary: String(r.prompt_summary ?? ""),
      createdAt: String(r.created_at),
    };
  }

  // ---------- Surf-Style Topic Notebooks ----------

  listNotebooks(): NotebookRecord[] {
    const nbs = this.db
      .prepare("SELECT * FROM notebooks ORDER BY updated_at DESC")
      .all() as Array<Record<string, unknown>>;
    const allItems = this.db
      .prepare("SELECT * FROM notebook_items ORDER BY created_at DESC")
      .all() as Array<Record<string, unknown>>;

    const byNb = new Map<string, NotebookItemRecord[]>();
    for (const r of allItems) {
      const nbId = String(r.notebook_id);
      const list = byNb.get(nbId) ?? [];
      list.push({
        id: String(r.id),
        notebookId: nbId,
        itemKind: String(r.item_kind) as NotebookItemKind,
        itemRef: String(r.item_ref),
        title: String(r.title),
        meta: String(r.meta ?? ""),
        createdAt: String(r.created_at),
      });
      byNb.set(nbId, list);
    }

    return nbs.map((r) => {
      const id = String(r.id);
      return {
        id,
        name: String(r.name),
        icon: String(r.icon ?? "✦"),
        description: String(r.description ?? ""),
        createdAt: String(r.created_at),
        updatedAt: String(r.updated_at),
        items: byNb.get(id) ?? [],
      };
    });
  }

  createNotebook(input: { name: string; icon?: string; description?: string }): NotebookRecord {
    const name = input.name.trim();
    if (!name) throw new Error("主题空间名称不能为空");
    const id = `nb_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
    const ts = nowIso();
    this.db
      .prepare(
        "INSERT INTO notebooks (id, name, icon, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, name, (input.icon || "✦").trim().slice(0, 4), (input.description ?? "").trim(), ts, ts);
    return this.listNotebooks().find((n) => n.id === id)!;
  }

  deleteNotebook(id: string): void {
    this.db.prepare("DELETE FROM notebooks WHERE id = ?").run(id);
  }

  addNotebookItem(
    notebookId: string,
    input: { itemKind: NotebookItemKind; itemRef: string; title: string; meta?: string },
  ): NotebookRecord {
    const exists = this.db.prepare("SELECT id FROM notebooks WHERE id = ?").get(notebookId);
    if (!exists) throw new Error("主题空间不存在");
    const ref = input.itemRef.trim();
    const title = input.title.trim();
    if (!ref || !title) throw new Error("条目标识与标题不能为空");
    const id = `nbi_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO notebook_items (id, notebook_id, item_kind, item_ref, title, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(notebook_id, item_kind, item_ref) DO UPDATE SET title = excluded.title, meta = excluded.meta`,
      )
      .run(id, notebookId, input.itemKind, ref, title, (input.meta ?? "").trim(), ts);
    this.db.prepare("UPDATE notebooks SET updated_at = ? WHERE id = ?").run(ts, notebookId);
    return this.listNotebooks().find((n) => n.id === notebookId)!;
  }

  removeNotebookItem(notebookId: string, itemId: string): NotebookRecord | null {
    this.db
      .prepare("DELETE FROM notebook_items WHERE id = ? AND notebook_id = ?")
      .run(itemId, notebookId);
    this.db.prepare("UPDATE notebooks SET updated_at = ? WHERE id = ?").run(nowIso(), notebookId);
    return this.listNotebooks().find((n) => n.id === notebookId) ?? null;
  }

  // ---------- Persistent Agent Chat History ----------

  listChatSessions(limit = 40): ChatSessionSummary[] {
    const cap = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `SELECT s.id, s.title, s.harness_session_id, s.created_at, s.updated_at,
                (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS message_count,
                COALESCE(
                  (SELECT m.text FROM chat_messages m WHERE m.session_id = s.id AND m.role = 'assistant' AND length(trim(m.text)) > 0 ORDER BY m.seq DESC LIMIT 1),
                  (SELECT m.text FROM chat_messages m WHERE m.session_id = s.id ORDER BY m.seq DESC LIMIT 1),
                  ''
                ) AS preview
         FROM chat_sessions s
         ORDER BY s.updated_at DESC
         LIMIT ?`,
      )
      .all(cap) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title || "未命名对话"),
      harnessSessionId: String(r.harness_session_id ?? ""),
      messageCount: Number(r.message_count ?? 0),
      preview: String(r.preview ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
  }

  getChatSession(id: string): ChatSessionDetail | null {
    const row = this.db
      .prepare(
        `SELECT id, title, harness_session_id, created_at, updated_at
         FROM chat_sessions WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    const msgRows = this.db
      .prepare(
        `SELECT id, session_id, role, text, reasoning, contexts_json, tools_json, created_at
         FROM chat_messages
         WHERE session_id = ?
         ORDER BY seq ASC`,
      )
      .all(id) as Array<Record<string, unknown>>;

    const messages: ChatMessageRecord[] = msgRows.map((m) => {
      let contexts: string[] = [];
      let tools: ChatMessageToolState[] = [];
      try {
        const parsed = JSON.parse(String(m.contexts_json ?? "[]"));
        if (Array.isArray(parsed)) contexts = parsed.map(String);
      } catch {
        contexts = [];
      }
      try {
        const parsed = JSON.parse(String(m.tools_json ?? "[]"));
        if (Array.isArray(parsed)) {
          tools = parsed
            .filter((t): t is Record<string, unknown> => Boolean(t && typeof t === "object"))
            .map((t) => ({
              name: String(t.name ?? "tool"),
              status: t.status === "running" ? "running" : "done",
            }));
        }
      } catch {
        tools = [];
      }
      const rawRole = String(m.role ?? "user");
      const role: ChatMessageRecord["role"] =
        rawRole === "assistant" || rawRole === "system" ? rawRole : "user";
      return {
        id: String(m.id),
        sessionId: String(m.session_id),
        role,
        text: String(m.text ?? ""),
        reasoning: String(m.reasoning ?? ""),
        contexts,
        tools,
        createdAt: String(m.created_at),
      };
    });

    const lastPreview =
      [...messages].reverse().find((m) => m.role === "assistant" && m.text.trim())?.text
      ?? messages[messages.length - 1]?.text
      ?? "";

    return {
      id: String(row.id),
      title: String(row.title || "未命名对话"),
      harnessSessionId: String(row.harness_session_id ?? ""),
      messageCount: messages.length,
      preview: lastPreview.replace(/\s+/g, " ").trim().slice(0, 120),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      messages,
    };
  }

  upsertChatSession(input: {
    id: string;
    title: string;
    harnessSessionId?: string;
    messages: Array<{
      id: string;
      role: "user" | "assistant" | "system";
      text: string;
      reasoning?: string;
      contexts?: string[];
      tools?: ChatMessageToolState[];
      createdAt?: string;
    }>;
  }): ChatSessionSummary {
    const id = input.id.trim() || `chat_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
    const title = (input.title || "新对话").replace(/\s+/g, " ").trim().slice(0, 48) || "新对话";
    const ts = nowIso();
    const incomingHarnessId = (input.harnessSessionId ?? "").trim();

    this.db.exec("BEGIN");
    try {
      const existing = this.db
        .prepare("SELECT harness_session_id, created_at FROM chat_sessions WHERE id = ?")
        .get(id) as Record<string, unknown> | undefined;

      const harnessId = incomingHarnessId || String(existing?.harness_session_id ?? "");
      const createdAt = existing ? String(existing.created_at) : ts;

      this.db
        .prepare(
          `INSERT INTO chat_sessions (id, title, harness_session_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             harness_session_id = CASE WHEN excluded.harness_session_id != '' THEN excluded.harness_session_id ELSE chat_sessions.harness_session_id END,
             updated_at = excluded.updated_at`,
        )
        .run(id, title, harnessId, createdAt, ts);

      this.db.prepare("DELETE FROM chat_messages WHERE session_id = ?").run(id);
      const insertMsg = this.db.prepare(
        `INSERT INTO chat_messages (id, session_id, seq, role, text, reasoning, contexts_json, tools_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (let seq = 0; seq < input.messages.length; seq += 1) {
        const m = input.messages[seq]!;
        const msgId = (m.id || `m_${crypto.randomUUID().slice(0, 10)}`).trim();
        const role = m.role === "assistant" || m.role === "system" ? m.role : "user";
        insertMsg.run(
          msgId,
          id,
          seq,
          role,
          String(m.text ?? ""),
          String(m.reasoning ?? ""),
          JSON.stringify(Array.isArray(m.contexts) ? m.contexts.map(String) : []),
          JSON.stringify(Array.isArray(m.tools) ? m.tools : []),
          m.createdAt || ts,
        );
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return this.listChatSessions(100).find((s) => s.id === id)!;
  }

  deleteChatSession(id: string): void {
    this.db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(id);
  }
}
