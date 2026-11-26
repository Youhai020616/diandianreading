/** Shared types and helpers for the Discover (book search) view. */
import type { ZlibBookItem } from "../../types/desktop";

export type FeedTab = "recommended" | "popular" | "favorites";

export interface DownloadedEntry {
  bookRef: string;
  title: string;
  directory: string;
  filePath?: string;
  metaFixed?: boolean;
  wereadUploaded?: boolean;
  kindleSent?: boolean;
}

export const RECENT_SEARCHES_KEY = "diandian.discover.recentQueries.v1";
export const INITIAL_FEED_COUNT = 5;

export const COVER_PALETTES = [
  "linear-gradient(155deg, #689cf2 0%, #3b6fd8 100%)",
  "linear-gradient(155deg, #5e8de6 0%, #2d55b8 100%)",
  "linear-gradient(155deg, #5ea5c9 0%, #2c6f94 100%)",
  "linear-gradient(155deg, #6b88c9 0%, #3f558f 100%)",
  "linear-gradient(155deg, #5c9e8d 0%, #2d6c5d 100%)",
  "linear-gradient(155deg, #7c84d6 0%, #4d54a3 100%)",
];

export function hashTitleToPalette(title: string): string {
  let h = 0;
  for (let i = 0; i < title.length; i++) {
    h = (h * 31 + title.charCodeAt(i)) | 0;
  }
  return COVER_PALETTES[Math.abs(h) % COVER_PALETTES.length] ?? "linear-gradient(155deg, #689cf2 0%, #3b6fd8 100%)";
}

export function cleanShortTitle(raw: string): string {
  const split = raw.split(/\s*[=:：]\s*/)[0]?.trim() || raw.trim();
  return split.length >= 2 ? split : raw.trim();
}

export function buildDoubanBookUrl(book: ZlibBookItem): { url: string; directIsbn: boolean } {
  const rawIsbn = (book.isbn ?? "").replace(/[-\s]/g, "");
  const cnIsbnMatch = rawIsbn.match(/9787\d{9}/);
  if (cnIsbnMatch) {
    return {
      url: `https://book.douban.com/isbn/${cnIsbnMatch[0]}/`,
      directIsbn: true,
    };
  }
  const keyword = cleanShortTitle(book.title);
  return {
    url: `https://search.douban.com/book/subject_search?search_text=${encodeURIComponent(keyword)}&cat=1001`,
    directIsbn: false,
  };
}

export function loadRecentQueries(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_SEARCHES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .slice(0, 6);
  } catch {
    return [];
  }
}

export function saveRecentQueries(list: string[]): void {
  try {
    window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(list.slice(0, 6)));
  } catch {
    // Ignore storage errors.
  }
}
