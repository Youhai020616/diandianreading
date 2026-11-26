/** Deduplication keys for highlights. */
import crypto from "node:crypto";

export function computeHighlightFingerprint(bookKey: string, quote: string, note: string): string {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return crypto
    .createHash("sha256")
    .update(`${norm(bookKey)}\n${norm(quote)}\n${norm(note)}`)
    .digest("hex");
}

/** Current scheme: scoped to the book id so renamed books keep their highlights deduplicated. */
export function bookHighlightFingerprint(bookId: string, quote: string, note: string): string {
  return "v2:" + computeHighlightFingerprint(bookId, quote, note);
}
