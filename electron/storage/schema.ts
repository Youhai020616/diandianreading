/** Tables, additive column migrations and the highlight search index. */
import type { SqlContext } from "./sqlite";

export function applySchema(ctx: SqlContext): void {
  ctx.db.exec(`
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

  ctx.transaction(() => {
    const columns = ctx.db.prepare("PRAGMA table_info(highlights)").all();
    if (!columns.some(column => column.name === "reader_document_id")) {
      ctx.db.exec("ALTER TABLE highlights ADD COLUMN reader_document_id TEXT REFERENCES reader_documents(id)");
      ctx.db.exec("ALTER TABLE highlights ADD COLUMN reader_cfi TEXT");
    }
    if (!columns.some(column => column.name === "reader_highlighted")) {
      ctx.db.exec("ALTER TABLE highlights ADD COLUMN reader_highlighted INTEGER NOT NULL DEFAULT 1 CHECK (reader_highlighted IN (0, 1))");
    }
    if (!columns.some(column => column.name === "reader_color")) {
      ctx.db.exec("ALTER TABLE highlights ADD COLUMN reader_color TEXT");
    }
    const sessionColumns = ctx.db.prepare("PRAGMA table_info(chat_sessions)").all();
    if (!sessionColumns.some(column => column.name === "context_label")) {
      ctx.db.exec("ALTER TABLE chat_sessions ADD COLUMN context_label TEXT NOT NULL DEFAULT ''");
    }
    ctx.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_reader_highlight_location
      ON highlights(reader_document_id, reader_cfi) WHERE reader_document_id IS NOT NULL`);
  });
}

/** Create the FTS5 trigram index for highlights; returns false when SQLite lacks FTS5 (search falls back to LIKE). */
export function installHighlightsSearch(ctx: SqlContext): boolean {
  let available = false;
  // SQLite FTS5 trigram full-text index for fast Chinese substring search (inspired by MoreCut)
  try {
    ctx.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS highlights_fts USING fts5(
        highlight_id UNINDEXED,
        quote,
        note,
        book_title,
        tokenize='trigram'
      );
    `);
    available = true;
  } catch {
    available = false;
  }
  if (!available) return false;
  installHighlightsFtsTriggers(ctx);
  return true;
}

/**
 * Keep highlights_fts in step with highlights and book titles inside the same statement, so a
 * failed index write fails the change itself instead of leaving the search index silently stale.
 */
function installHighlightsFtsTriggers(ctx: SqlContext): void {
  const titleOf = "COALESCE((SELECT title FROM books WHERE id = new.book_id), '')";
  ctx.transaction(() => {
    ctx.db.exec(`
      CREATE TRIGGER IF NOT EXISTS highlights_fts_after_insert AFTER INSERT ON highlights BEGIN
        INSERT INTO highlights_fts (highlight_id, quote, note, book_title)
        VALUES (new.id, new.quote, new.note, ${titleOf});
      END;
      CREATE TRIGGER IF NOT EXISTS highlights_fts_after_update AFTER UPDATE OF quote, note, book_id ON highlights BEGIN
        DELETE FROM highlights_fts WHERE highlight_id = old.id;
        INSERT INTO highlights_fts (highlight_id, quote, note, book_title)
        VALUES (new.id, new.quote, new.note, ${titleOf});
      END;
      CREATE TRIGGER IF NOT EXISTS highlights_fts_after_delete AFTER DELETE ON highlights BEGIN
        DELETE FROM highlights_fts WHERE highlight_id = old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS books_title_fts_after_update AFTER UPDATE OF title ON books BEGIN
        UPDATE highlights_fts SET book_title = new.title
        WHERE highlight_id IN (SELECT id FROM highlights WHERE book_id = new.id);
      END;
    `);
    const version = "schema.highlights-fts-triggers.v1";
    // Indexes built before the triggers may be stale (e.g. book titles were never updated).
    if (!ctx.getSetting(version) || !highlightsFtsCountsMatch(ctx)) {
      if (ctx.getSetting(version)) console.warn("[diandian] highlights_fts was out of step; rebuilding the search index.");
      rebuildHighlightsFts(ctx);
      ctx.setSetting(version, "1");
    }
  });
}

function highlightsFtsCountsMatch(ctx: SqlContext): boolean {
  const count = (table: string) => Number((ctx.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);
  return count("highlights") === count("highlights_fts");
}

function rebuildHighlightsFts(ctx: SqlContext): void {
  ctx.db.exec("DELETE FROM highlights_fts");
  ctx.db.exec(`INSERT INTO highlights_fts (highlight_id, quote, note, book_title)
    SELECT h.id, h.quote, h.note, COALESCE(b.title, '') FROM highlights h LEFT JOIN books b ON b.id = h.book_id`);
}
