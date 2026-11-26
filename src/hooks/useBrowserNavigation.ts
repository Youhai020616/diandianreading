import type { BrowserStateSnapshot } from "../types/desktop";
import { isStartPageTabUrl, QUICK_WEB_LINKS, tabMatchesSite, type QuickWebLink } from "../app/workspace";

type Notify = (message: string, tone?: "info" | "success" | "error") => void;

interface BrowserNavigationDeps {
  browserState: BrowserStateSnapshot | null;
  /** Leave the local reader and show the browser pane. */
  showBrowser(): void;
  notify: Notify;
}

/** Opening pages in the right-hand browser without overwriting the tab the user is reading. */
export function useBrowserNavigation({ browserState, showBrowser, notify }: BrowserNavigationDeps) {
  const tabs = browserState?.tabs ?? [];
  const current = tabs.find((t) => t.id === browserState?.activeTabId) ?? null;

  const openUrl = async (url?: string, newTab = false) => {
    showBrowser();
    try {
      await window.diandian.browser.openUrl(url, newTab);
    } catch (error) {
      notify(error instanceof Error ? error.message : "打开网页失败", "error");
    }
  };

  const selectTab = async (id: string): Promise<boolean> => {
    try {
      await window.diandian.browser.selectTab(id);
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "切换标签页失败", "error");
      return false;
    }
  };

  // Open a URL in a tab dedicated to its site (reuse the blank tab, an existing tab of that site,
  // or a fresh one) instead of overwriting whatever the user is currently reading.
  const openSiteUrl = async (url: string) => {
    showBrowser();
    const site = QUICK_WEB_LINKS.find((s) => tabMatchesSite(url, s.matchHosts));
    if (!site || !current || isStartPageTabUrl(current.url) || tabMatchesSite(current.url, site.matchHosts)) {
      await openUrl(url, false);
      return;
    }
    const existing = tabs.find((t) => tabMatchesSite(t.url, site.matchHosts));
    if (existing) {
      if (await selectTab(existing.id)) await openUrl(url, false);
      return;
    }
    await openUrl(url, true);
  };

  const openQuickSite = async (site: QuickWebLink) => {
    showBrowser();
    // 1. If currently sitting on a blank "新标签页", open directly inside it without leaving an empty tab behind.
    if (current && isStartPageTabUrl(current.url)) {
      await openUrl(site.url, false);
      return;
    }
    // 2. If this site is already open in a tab, switch straight to it instead of duplicating or overwriting.
    const existing = tabs.find((t) => tabMatchesSite(t.url, site.matchHosts));
    if (existing) {
      await selectTab(existing.id);
      return;
    }
    // 3. Otherwise open in a fresh tab so the current reading page stays intact.
    await openUrl(site.url, true);
  };

  return { openUrl, openSiteUrl, openQuickSite };
}
