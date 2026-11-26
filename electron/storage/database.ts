import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BookIdentityIndex } from "./bookIdentity";
import type { ReaderAnnotation, ReaderAnnotationInput } from "../../src/types/desktop";
import { isReaderHighlightColor, type ReaderHighlightColor } from "./highlightColors";
import * as chatHistory from "./chatHistory";
import * as notebooks from "./notebooks";
import type {
  BookPatch, BookRecord, BookSource, DraftKind, DraftRecord, DraftRevisionRecord, HighlightRecord, NewBook, NewHighlight,
  ObsidianExportMapping, ReadingStatsSummary, RecallHighlightItem, RelatedHighlightItem, RevisionAuthorKind,
} from "./records";
import { escapeFtsPhrase, extractSearchTermsFromDraft } from "./searchTerms";
import { bookHighlightFingerprint, computeHighlightFingerprint } from "./fingerprints";
import { migrateBookIdentities, migrateDownloadCoverHints } from "./migrations";
import { applySchema, installHighlightsSearch } from "./schema";
import { nowIso, type BoundToDb, type SqlContext } from "./sqlite";
import {
  migrateTranslationCache, READER_TRANSLATION_CACHE_LIMIT, readReaderTranslations, saveReaderTranslations,
} from "./translationCache";

export { computeHighlightFingerprint, READER_TRANSLATION_CACHE_LIMIT };

export { extractSearchTermsFromDraft };

export * from "./records";


function requireReaderCfi(value: string): string {
  if (typeof value !== "string" || value.length > 16_384 || !/^epubcfi\(\/[\s\S]+\)$/.test(value)) {
    throw new Error("无法识别这段文字在 EPUB 中的位置。");
  }
  return value;
}



export class KnowledgeDatabase {
  private readonly db: DatabaseSync;
  private readonly identities: BookIdentityIndex;
  readonly dbPath: string;
  private ftsAvailable = false;
  private readonly translationCacheLimit: number;
  /** What the schema, migration and cache modules use to reach this connection. */
  private readonly sql: SqlContext;

  constructor(dbPath: string, options: { translationCacheLimit?: number } = {}) {
    this.dbPath = dbPath;
    this.translationCacheLimit = options.translationCacheLimit ?? READER_TRANSLATION_CACHE_LIMIT;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.identities = new BookIdentityIndex(this.db);
    this.sql = {
      db: this.db,
      transaction: (work) => this.transaction(work),
      getSetting: (key) => this.getSetting(key),
      setSetting: (key, value) => this.setSetting(key, value),
      deleteSetting: (key) => this.deleteSetting(key),
    };
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  /** Expose a storage-module function as a method on this connection. */
  private bindDb<F extends (db: DatabaseSync, ...args: never[]) => unknown>(fn: F): BoundToDb<F> {
    return ((...args: never[]) => fn(this.db, ...args)) as BoundToDb<F>;
  }


  private migrate(): void {
    applySchema(this.sql);
    migrateBookIdentities(this.sql, this.identities);
    migrateDownloadCoverHints(this.sql);
    migrateTranslationCache(this.sql, this.translationCacheLimit);
    this.ftsAvailable = installHighlightsSearch(this.sql);
  }

  readReaderTranslations(keys: readonly string[]): (string | null)[] {
    return readReaderTranslations(this.sql, keys);
  }

  saveReaderTranslations(entries: ReadonlyArray<readonly [key: string, translation: string]>): void {
    saveReaderTranslations(this.sql, this.translationCacheLimit, entries);
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
    // Highlights cascade with the book; the delete trigger removes their index rows.
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
    const nextFp = row.reader_document_id ? String(row.fingerprint) : bookHighlightFingerprint(String(row.book_id), String(row.quote), nextNote);
    this.db.prepare("UPDATE highlights SET note = ?, fingerprint = ? WHERE id = ?").run(nextNote, nextFp, id);
    const updated = this.db.prepare("SELECT * FROM highlights WHERE id = ?").get(id) as Record<string, unknown>;
    return this.mapHighlightRow(updated);
  }

  deleteHighlight(id: string): void {
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

  // ---------- Topic notebooks (electron/storage/notebooks.ts) ----------

  readonly listNotebooks = this.bindDb(notebooks.listNotebooks);
  readonly createNotebook = this.bindDb(notebooks.createNotebook);
  readonly deleteNotebook = this.bindDb(notebooks.deleteNotebook);
  readonly addNotebookItem = this.bindDb(notebooks.addNotebookItem);
  readonly removeNotebookItem = this.bindDb(notebooks.removeNotebookItem);

  // ---------- Conversation history (electron/storage/chatHistory.ts) ----------

  readonly listChatSessions = this.bindDb(chatHistory.listChatSessions);
  readonly getChatSession = this.bindDb(chatHistory.getChatSession);
  readonly upsertChatSession = this.bindDb(chatHistory.upsertChatSession);
  readonly deleteChatSession = this.bindDb(chatHistory.deleteChatSession);
}
