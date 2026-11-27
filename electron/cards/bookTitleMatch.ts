/** Lowercase and drop brackets, punctuation and whitespace so titles compare by their words. */
export function normalizeBookTitleKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s《》「」『』"'“”‘’:：·•・,，.。!！?？、;；()（）[\]【】{}<>〈〉\-–—_/|]/g, "");
}

/** The part before a subtitle, edition or author suffix: "认知觉醒：开启…" / "认知觉醒 (周岭)" -> "认知觉醒". */
function mainTitleKey(raw: string): string {
  const head = raw.replace(/^[《「『]/, "").split(/[：:()（）[\]【】|—–]|\s-\s|\s+by\s+/i)[0] ?? "";
  return normalizeBookTitleKey(head);
}

/**
 * Whether two strings name the same book: equal once normalized, or equal main titles when one
 * side carries a subtitle/author suffix. Substring overlap alone ("认知" vs "认知觉醒") is not enough.
 */
export function isSameBookTitle(a: string, b: string): boolean {
  const ka = normalizeBookTitleKey(a);
  const kb = normalizeBookTitleKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const ma = mainTitleKey(a);
  const mb = mainTitleKey(b);
  return ma.length >= 2 && ma === mb;
}

/** Strip the extension from a downloaded file name before comparing it with a title. */
export function fileNameTitle(fileName: string): string {
  return fileName.replace(/\.[a-z0-9]{2,5}$/i, "");
}
