/**
 * The "@filter" being typed at the end of the composer, or null when no mention is open.
 * Chinese text has no space before "@", so any preceding character works except those of an
 * address such as name@host.
 */
export function trailingMentionQuery(text: string): string | null {
  const match = text.match(/(?:^|[^A-Za-z0-9._%+-])@([^\s@]{0,20})$/);
  return match ? match[1] ?? "" : null;
}
