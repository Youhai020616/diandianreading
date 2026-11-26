/** One-time data migrations, each guarded by a schema.* marker in app_kv. */
import type { BookIdentityIndex } from "./bookIdentity";
import { bookHighlightFingerprint, computeHighlightFingerprint } from "./fingerprints";
import type { SqlContext } from "./sqlite";

export function migrateDownloadCoverHints(ctx: SqlContext): void {
  ctx.transaction(() => {
    const version = "schema.download-cover-hints.v2";
    if (ctx.getSetting(version)) return;
    // The old key was a one-way hash of the path. Its value includes the
    // filesystem revision, which survives a rename even before the upgrade.
    const rows = ctx.db.prepare("SELECT value FROM app_kv WHERE key GLOB 'download.cover.*' ORDER BY updated_at").all();
    for (const row of rows) {
      let saved;
      try { saved = JSON.parse(String(row.value)); } catch { continue; }
      if (typeof saved?.revision === "string" && saved.hint && saved.revision.split(":")[1] !== "0") {
        ctx.setSetting("download.cover-legacy." + saved.revision, JSON.stringify(saved.hint));
      }
    }
    ctx.setSetting(version, "1");
  });
  ctx.transaction(() => {
    const version = "schema.download-cover-hints.v3";
    if (ctx.getSetting(version)) return;
    // Path keys with an inode were copied to revision keys above and are no longer read.
    // Consumed revision keys used to be blanked instead of removed.
    const remove = ctx.db.prepare("DELETE FROM app_kv WHERE key = ?");
    for (const row of ctx.db.prepare("SELECT key, value FROM app_kv WHERE key GLOB 'download.cover.*'").all()) {
      let saved;
      try { saved = JSON.parse(String(row.value)); } catch { continue; }
      if (typeof saved?.revision === "string" && saved.revision.split(":")[1] !== "0") remove.run(String(row.key));
    }
    ctx.db.exec("DELETE FROM app_kv WHERE key GLOB 'download.cover-legacy.*' AND value = ''");
    ctx.setSetting(version, "1");
  });
}

export function migrateBookIdentities(ctx: SqlContext, identities: BookIdentityIndex): void {
  const versionKey = "schema.book-identity.v1";
  ctx.transaction(() => {
    if (ctx.getSetting(versionKey)) return;
    const books = ctx.db.prepare("SELECT id, title, isbn, source_locator AS sourceLocator FROM books").all() as
      Array<{ id: string; title: string; isbn: string; sourceLocator: string }>;
    const readHighlights = ctx.db.prepare("SELECT id, quote, note, fingerprint FROM highlights WHERE book_id = ? AND reader_document_id IS NULL ORDER BY created_at, id");
    const writeFingerprint = ctx.db.prepare("UPDATE highlights SET fingerprint = ? WHERE id = ?");
    for (const book of books) {
      identities.indexLegacyBook(book.id, book);
      // Old digests can prove a previous title, e.g. before an edition label or subtitle was added.
      const prefixes = [...book.title.matchAll(/[:：(（]/g)].map(match => book.title.slice(0, match.index).trim()).filter(Boolean);
      const seen = new Set<string>();
      for (const row of readHighlights.all(book.id) as Array<{ id: string; quote: string; note: string; fingerprint: string }>) {
        for (const title of prefixes) {
          if (computeHighlightFingerprint(title, row.quote, row.note) === row.fingerprint) {
            identities.remember(book.id, { title });
          }
        }
        const key = bookHighlightFingerprint(book.id, row.quote, row.note);
        // Preserve separately referenced legacy duplicates while deduplicating future imports.
        writeFingerprint.run(seen.has(key) ? key + ":" + row.id : key, row.id);
        seen.add(key);
      }
    }
    ctx.setSetting(versionKey, "1");
  });
}
