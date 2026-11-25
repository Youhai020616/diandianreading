/**
 * Strip Electron IPC wrapper noise (`Error invoking remote method '...': Error: `)
 * and CLI glyph prefixes so toasts always read cleanly.
 */
export function formatUserError(error: unknown, fallback = "操作失败"): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .replace(/^[✗×]\s*Error:\s*/i, "")
    .trim();
  return cleaned || fallback;
}
