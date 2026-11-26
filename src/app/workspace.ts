/** Workspace-level constants and pure helpers shared by App and its layout pieces. */
import type { NotebookRecord } from "../types/desktop";

export type StudioTab = "discover" | "library" | "notes" | "studio" | "notebook" | "router";

export const TAB_LABELS: Record<StudioTab, string> = {
  discover: "搜书发现",
  library: "本地书库",
  notes: "阅读笔记",
  studio: "创作草稿",
  notebook: "主题空间",
  router: "连接与偏好",
};

export const DEFAULT_RAIL_WIDTH = 196;
export const MIN_RAIL_WIDTH = 160;
export const MAX_RAIL_WIDTH = 340;
export const DEFAULT_AI_WIDTH = 396;
export const MIN_AI_WIDTH = 320;
export const MAX_AI_WIDTH = 560;
export const SPLIT_HANDLE_WIDTH = 5;
export const MIN_LEFT_WIDTH = 440;
export const MIN_LEFT_WIDTH_TRIPLE = 360;
export const MIN_BROWSER_WIDTH = 340;
export const MIN_BROWSER_WIDTH_TRIPLE = 290;

export const QUICK_WEB_LINKS = [
  { label: "微信读书", url: "https://weread.qq.com", matchHosts: ["weread.qq.com"] },
  { label: "豆瓣", url: "https://book.douban.com", matchHosts: ["douban.com"] },
  { label: "小红书", url: "https://creator.xiaohongshu.com/publish/publish", matchHosts: ["xiaohongshu.com"] },
  { label: "公众号", url: "https://mp.weixin.qq.com", matchHosts: ["mp.weixin.qq.com"] },
] as const;

export type QuickWebLink = (typeof QUICK_WEB_LINKS)[number];

export function isStartPageTabUrl(url?: string | null): boolean {
  return typeof url === "string" && url.startsWith("data:text/html");
}

export function tabMatchesSite(tabUrl: string, matchHosts: readonly string[]): boolean {
  try {
    const host = new URL(tabUrl).hostname.toLowerCase();
    return matchHosts.some((target) => host === target || host.endsWith(`.${target}`));
  } catch {
    return false;
  }
}

/** Width of the left workspace column, keeping room for the rail, the browser and the AI drawer. */
export function clampLeftWidth(
  desired: number,
  viewportWidth: number,
  railOpen: boolean,
  railWidth: number,
  aiOpen = false,
  aiWidth = DEFAULT_AI_WIDTH,
): number {
  const railW = railOpen ? railWidth : 0;
  const aiReserved = aiOpen ? aiWidth + SPLIT_HANDLE_WIDTH : 0;
  const minLeft = aiOpen ? MIN_LEFT_WIDTH_TRIPLE : MIN_LEFT_WIDTH;
  const minBrowser = aiOpen ? MIN_BROWSER_WIDTH_TRIPLE : MIN_BROWSER_WIDTH;
  const usable = Math.max(minLeft + minBrowser, viewportWidth - railW - aiReserved - SPLIT_HANDLE_WIDTH);
  const maxLeft = Math.max(minLeft, usable - minBrowser);
  return Math.max(minLeft, Math.min(maxLeft, desired));
}

/** One context line telling the agent which books, drafts and pages a topic notebook gathers. */
export function buildNotebookPromptSummary(nb: NotebookRecord): string {
  const bList = nb.items
    .filter((i) => i.itemKind === "book")
    .map((i) => `《${i.title}》(bookId: ${i.itemRef})`);
  const dList = nb.items
    .filter((i) => i.itemKind === "draft")
    .map((i) => `「${i.title}」(draftId: ${i.itemRef})`);
  const wList = nb.items
    .filter((i) => i.itemKind === "web")
    .map((i) => `${i.title} (${i.itemRef})`);
  const parts = [
    bList.length ? `关联书目：${bList.join("、")}` : "",
    dList.length ? `关联草稿：${dList.join("、")}` : "",
    wList.length ? `收录网页：${wList.join("、")}` : "",
  ].filter(Boolean);
  return `- [主题空间] 「${nb.name}」${parts.length ? `（${parts.join("；")}，请综合调取这些书的划线与草稿上下文回答）` : ""}`;
}
