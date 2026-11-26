/** Bounded cache of paragraph translations for the reader. */
import type { SqlContext } from "./sqlite";

/** Roughly 20 MB of paragraph translations. */
export const READER_TRANSLATION_CACHE_LIMIT = 40_000;

/** Move per-paragraph translations out of the settings table into the bounded cache. */
export function migrateTranslationCache(ctx: SqlContext, limit: number): void {
  ctx.transaction(() => {
    ctx.db.exec(`INSERT OR IGNORE INTO reader_translation_cache (cache_key, translation, used_at)
      SELECT key, value, COALESCE(CAST(strftime('%s', updated_at) AS INTEGER) * 1000, 0)
      FROM app_kv WHERE key GLOB 'reader.translation.v1.*'`);
    ctx.db.exec("DELETE FROM app_kv WHERE key GLOB 'reader.translation.v1.*'");
    pruneReaderTranslations(ctx, limit);
  });
}

export function readReaderTranslations(ctx: SqlContext, keys: readonly string[]): (string | null)[] {
  return ctx.transaction(() => {
    const read = ctx.db.prepare("SELECT translation FROM reader_translation_cache WHERE cache_key = ?");
    const touch = ctx.db.prepare("UPDATE reader_translation_cache SET used_at = ? WHERE cache_key = ?");
    const now = Date.now();
    return keys.map(key => {
      const row = read.get(key) as { translation: string } | undefined;
      if (!row) return null;
      touch.run(now, key);
      return row.translation;
    });
  });
}

export function saveReaderTranslations(ctx: SqlContext, limit: number, entries: ReadonlyArray<readonly [key: string, translation: string]>): void {
  ctx.transaction(() => {
    const write = ctx.db.prepare(`INSERT INTO reader_translation_cache (cache_key, translation, used_at) VALUES (?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET translation = excluded.translation, used_at = excluded.used_at`);
    const now = Date.now();
    for (const [key, translation] of entries) write.run(key, translation, now);
    pruneReaderTranslations(ctx, limit);
  });
}

/** Keep the most recently read translations; older paragraphs can be translated again on demand. */
function pruneReaderTranslations(ctx: SqlContext, limit: number): void {
  ctx.db.prepare(`DELETE FROM reader_translation_cache WHERE cache_key IN (
    SELECT cache_key FROM reader_translation_cache ORDER BY used_at DESC LIMIT -1 OFFSET ?)`)
    .run(limit);
}
