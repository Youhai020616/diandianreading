const MiB = 1024 * 1024;

/**
 * Shared by the main-process validator and the renderer's archive reader,
 * so an EPUB accepted when opening does not fail later while rendering.
 */
export const EPUB_LIMITS = {
  fileBytes: 128 * MiB,
  entries: 16_000,
  entryBytes: 48 * MiB,
  textBytes: 8 * MiB,
  totalBytes: 512 * MiB,
} as const;

/** Entries the reader decodes as text (markup, styles, package documents); identified by extension. */
export function isEpubTextEntry(name: string): boolean {
  return /\.(?:xhtml|html?|xml|opf|ncx|css|svg)$/i.test(name);
}
