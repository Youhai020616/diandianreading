/** Highlight colors a reader annotation may carry; the renderer maps each to a swatch. */
export const READER_HIGHLIGHT_COLORS = ["yellow", "red", "green", "blue", "violet"] as const;
export type ReaderHighlightColor = (typeof READER_HIGHLIGHT_COLORS)[number];

export function isReaderHighlightColor(value: unknown): value is ReaderHighlightColor {
  return typeof value === "string" && (READER_HIGHLIGHT_COLORS as readonly string[]).includes(value);
}
