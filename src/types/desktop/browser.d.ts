/** Embedded browser tabs, accounts and cookie import. */

export interface BrowserAccount {
  id: string;
  label: string;
  createdAt: string;
}

export interface BrowserTabSummary {
  id: string;
  accountId: string;
  url: string;
  title: string;
  faviconUrl?: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface BrowserStateSnapshot {
  visible: boolean;
  suppressed: boolean;
  activeAccountId: string;
  activeTabId: string | null;
  accounts: BrowserAccount[];
  tabs: BrowserTabSummary[];
}

export interface PageContentSnapshot {
  tabId: string;
  accountId: string;
  title: string;
  url: string;
  selection: string;
  text: string;
  textLength: number;
  truncated: boolean;
  likelyCanvasReader: boolean;
  extractionMethod?: "dom" | "canvas-ocr";
  capturedAt: string;
}

export interface CookieDomainSummary {
  domain: string;
  count: number;
  recommended: boolean;
}

export interface CookieImportPreview {
  importToken: string;
  format: "netscape" | "json";
  totalCount: number;
  domains: CookieDomainSummary[];
}

export type SupportedBrowserId =
  | "chrome"
  | "arc"
  | "brave"
  | "edge"
  | "dia"
  | "chromium"
  | "vivaldi"
  | "firefox";

export type ReadingSiteGroupId = "weread" | "douban" | "xiaohongshu" | "wechat_mp" | "zlib" | "other";

export interface ReadingSiteGroupSummary {
  id: ReadingSiteGroupId;
  label: string;
  subtitle: string;
  cookieCount: number;
  domainCount: number;
  defaultEnabled: boolean;
}

export interface PublicLocalBrowserProfile {
  id: string;
  browserId: SupportedBrowserId;
  browserName: string;
  profileName: string;
  profileEmail?: string;
  requiresKeychain: boolean;
}
