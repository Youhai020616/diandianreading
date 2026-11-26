import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WebContentsView, nativeTheme, session, type BrowserWindow } from "electron";
import {
  buildElectronCookieUrl,
  normalizeDomainKey,
  type NormalizedCookie,
} from "./cookieCodec";
import { buildReadPageScript } from "./pageScripts";
import { recognizeCanvasPngLocally } from "./canvasOcr";
import {
  buildSelectionToolbarScript,
  SELECTION_SIGNAL_PREFIX,
  type BrowserSelectionActionEvent,
  type BrowserSelectionActionKind,
} from "./selectionOverlay";
import {
  buildStartPageUrl,
  DEFAULT_READING_URL,
  isStartPageUrl,
  START_PAGE_TITLE,
} from "./startPage";
import { normalizeAllowedWebUrl } from "./urlPolicy";

export { normalizeAllowedWebUrl };

const DESKTOP_LAYOUT_WIDTH = 1120;
const DEFAULT_ACCOUNT_ID = "default";
/** After the new document commits, reveal the tab at most this long later (dom-ready may come sooner). */
const TAB_REVEAL_AFTER_COMMIT_MS = 450;
/** Safety net if a navigation never commits (hung network); keeps the stale page hidden meanwhile. */
const TAB_REVEAL_SAFETY_MS = 8000;

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

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
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

interface InternalTab {
  id: string;
  accountId: string;
  view: WebContentsView;
  title: string;
  url: string;
  faviconUrl?: string;
  isLoading: boolean;
  readyToShow: boolean;
  /** True between starting a deferred navigation and the new document committing (did-navigate). */
  awaitingCommit: boolean;
  revealTimer?: NodeJS.Timeout;
}

function writeJsonAtomic(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

export class BrowserService {
  private readonly getWindow: () => BrowserWindow | null;
  private readonly onStateChanged: (snapshot: BrowserStateSnapshot) => void;
  private readonly onSelectionAction?: (event: BrowserSelectionActionEvent) => void;
  private readonly userDataDir: string;

  private readonly accounts = new Map<string, BrowserAccount>();
  private readonly tabs = new Map<string, InternalTab>();
  private activeAccountId = DEFAULT_ACCOUNT_ID;
  private activeTabId: string | null = null;
  private attachedView: WebContentsView | null = null;
  private visible = true;
  private suppressed = false;
  private userZoomScale = 1;
  private bounds: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 };
  private tabSeq = 0;
  private accountsLoaded = false;

  constructor(
    getWindow: () => BrowserWindow | null,
    onStateChanged: (snapshot: BrowserStateSnapshot) => void,
    userDataDir: string,
    onSelectionAction?: (event: BrowserSelectionActionEvent) => void,
  ) {
    this.getWindow = getWindow;
    this.onStateChanged = onStateChanged;
    this.userDataDir = userDataDir;
    this.onSelectionAction = onSelectionAction;
  }

  initialize(initialUrl: string = DEFAULT_READING_URL): BrowserStateSnapshot {
    this.loadAccountsOnce();
    if (this.tabs.size === 0) {
      const tab = this.createTab(this.activeAccountId, initialUrl);
      this.activateTab(tab.id);
    }
    this.pushState();
    return this.getState();
  }

  getState(): BrowserStateSnapshot {
    this.loadAccountsOnce();
    const tabs: BrowserTabSummary[] = [];
    for (const tab of this.tabs.values()) {
      if (tab.view.webContents.isDestroyed()) continue;
      const wc = tab.view.webContents;
      const currentUrl = wc.getURL() || tab.url;
      const isStart = isStartPageUrl(currentUrl);
      const rawTitle = wc.getTitle() || tab.title;
      tabs.push({
        id: tab.id,
        accountId: tab.accountId,
        url: currentUrl,
        title: isStart
          ? START_PAGE_TITLE
          : rawTitle && !rawTitle.startsWith("data:text/html")
            ? rawTitle
            : "新标签页",
        ...(!isStart && tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}),
        isLoading: tab.isLoading,
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
      });
    }
    return {
      visible: this.visible,
      suppressed: this.suppressed,
      activeAccountId: this.activeAccountId,
      activeTabId: this.activeTabId,
      accounts: [...this.accounts.values()],
      tabs,
    };
  }

  setBounds(rect: BrowserBounds): boolean {
    if (
      ![rect.x, rect.y, rect.width, rect.height].every((n) => Number.isFinite(n))
      || rect.width <= 0
      || rect.height <= 0
    ) {
      return false;
    }
    const win = this.getWindow();
    const zoom = win && !win.isDestroyed() ? win.webContents.getZoomFactor() : 1;
    this.bounds = {
      x: Math.round(rect.x * zoom),
      y: Math.round(rect.y * zoom),
      width: Math.max(1, Math.round(rect.width * zoom)),
      height: Math.max(1, Math.round(rect.height * zoom)),
    };
    this.applyViewGeometry();
    return true;
  }

  setVisible(nextVisible: boolean): BrowserStateSnapshot {
    this.visible = nextVisible;
    this.applyViewVisibility();
    this.pushState();
    return this.getState();
  }

  /**
   * Temporarily hide the native WebContentsView while a DOM modal/drawer is open
   * (native views always paint above HTML DOM).
   */
  setSuppressed(suppressed: boolean): void {
    if (this.suppressed === suppressed) return;
    this.suppressed = suppressed;
    this.applyViewVisibility();
  }

  async openUrl(rawUrl?: string, options: { newTab?: boolean } = {}): Promise<BrowserStateSnapshot> {
    this.loadAccountsOnce();
    const targetUrl = rawUrl ? normalizeAllowedWebUrl(rawUrl) : buildStartPageUrl();
    const active = this.getActiveTab();
    if (!active || options.newTab) {
      const created = this.createTab(this.activeAccountId, targetUrl);
      this.activateTab(created.id);
    } else {
      const prevOrigin = (() => {
        try {
          return new URL(active.url).origin;
        } catch {
          return "";
        }
      })();
      const nextOrigin = (() => {
        try {
          return new URL(targetUrl).origin;
        } catch {
          return "";
        }
      })();
      if (
        (prevOrigin && nextOrigin && prevOrigin !== nextOrigin)
        || (isStartPageUrl(active.url) && !isStartPageUrl(targetUrl))
      ) {
        this.deferTabReveal(active, targetUrl);
      }
      await active.view.webContents.loadURL(targetUrl).catch(() => undefined);
    }
    this.visible = true;
    this.applyViewVisibility();
    this.pushState();
    return this.getState();
  }

  async navigate(action: "back" | "forward" | "reload" | "stop" | "home" | "weread"): Promise<BrowserStateSnapshot> {
    const active = this.getActiveTab();
    if (!active) {
      return this.openUrl(action === "weread" ? DEFAULT_READING_URL : undefined);
    }
    const wc = active.view.webContents;
    if (action === "back" && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (action === "forward" && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else if (action === "reload") wc.reload();
    else if (action === "stop") wc.stop();
    else if (action === "home") await wc.loadURL(buildStartPageUrl()).catch(() => undefined);
    else if (action === "weread") await wc.loadURL(DEFAULT_READING_URL).catch(() => undefined);
    this.pushState();
    return this.getState();
  }

  selectTab(tabId: string): BrowserStateSnapshot {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`标签页不存在: ${tabId}`);
    this.activeAccountId = tab.accountId;
    this.activateTab(tab.id);
    this.pushState();
    return this.getState();
  }

  closeTab(tabId: string): BrowserStateSnapshot {
    const tab = this.tabs.get(tabId);
    if (!tab) return this.getState();
    if (tab.revealTimer) {
      clearTimeout(tab.revealTimer);
      tab.revealTimer = undefined;
    }
    if (this.attachedView === tab.view) {
      this.detachCurrentView();
    }
    if (!tab.view.webContents.isDestroyed()) {
      tab.view.webContents.close();
    }
    this.tabs.delete(tabId);

    if (this.activeTabId === tabId) {
      const fallback = [...this.tabs.values()].find((t) => t.accountId === this.activeAccountId)
        ?? [...this.tabs.values()][0]
        ?? null;
      if (fallback) {
        this.activeAccountId = fallback.accountId;
        this.activateTab(fallback.id);
      } else {
        const fresh = this.createTab(this.activeAccountId, buildStartPageUrl());
        this.activateTab(fresh.id);
      }
    }
    this.pushState();
    return this.getState();
  }

  addAccount(label: string): BrowserStateSnapshot {
    this.loadAccountsOnce();
    const cleaned = label.trim().slice(0, 32);
    if (!cleaned) throw new Error("账号名称不能为空");
    let uniqueLabel = cleaned;
    let suffix = 2;
    while ([...this.accounts.values()].some((a) => a.label === uniqueLabel)) {
      uniqueLabel = `${cleaned} (${suffix++})`;
    }
    const id = `acc-${crypto.randomBytes(4).toString("hex")}`;
    this.accounts.set(id, {
      id,
      label: uniqueLabel,
      createdAt: new Date().toISOString(),
    });
    this.saveAccounts();
    return this.switchAccount(id);
  }

  switchAccount(accountId: string): BrowserStateSnapshot {
    this.loadAccountsOnce();
    if (!this.accounts.has(accountId)) {
      throw new Error(`账号不存在: ${accountId}`);
    }
    this.activeAccountId = accountId;
    const existing = [...this.tabs.values()].find((t) => t.accountId === accountId);
    if (existing) {
      this.activateTab(existing.id);
    } else {
      const created = this.createTab(accountId, DEFAULT_READING_URL);
      this.activateTab(created.id);
    }
    this.pushState();
    return this.getState();
  }

  async readPageContent(options: { maxChars?: number; tabId?: string } = {}): Promise<PageContentSnapshot> {
    const tab = options.tabId ? this.tabs.get(options.tabId) : this.getActiveTab();
    if (!tab || tab.view.webContents.isDestroyed()) {
      throw new Error("当前没有可读取的内置浏览器标签页");
    }
    const maxChars = options.maxChars ?? 14_000;
    const raw = (await tab.view.webContents.executeJavaScript(buildReadPageScript(maxChars), true)) as Omit<
      PageContentSnapshot,
      "tabId" | "accountId" | "extractionMethod"
    > & {
      canvasViewportRatio?: { rx: number; ry: number; rw: number; rh: number } | null;
    };

    let finalText = raw.text;
    let finalLength = raw.textLength;
    let finalTruncated = raw.truncated;
    let extractionMethod: "dom" | "canvas-ocr" = "dom";

    // For Canvas-rendered readers (e.g. WeRead Web Reader), automatically run local on-device Vision OCR
    // on the visible <canvas> snapshot so AI reads the exact text shown on screen without scraping third-party sites.
    if (raw.likelyCanvasReader && raw.selection.length < 20 && process.platform === "darwin") {
      try {
        const shot = await tab.view.webContents.capturePage();
        const size = shot.getSize();
        if (size.width > 0 && size.height > 0) {
          let targetImage = shot;
          const ratio = raw.canvasViewportRatio;
          if (ratio && ratio.rw >= 0.25 && ratio.rh >= 0.25) {
            const cropX = Math.max(0, Math.floor(ratio.rx * size.width));
            const cropY = Math.max(0, Math.floor(ratio.ry * size.height));
            const cropW = Math.min(size.width - cropX, Math.ceil(ratio.rw * size.width));
            const cropH = Math.min(size.height - cropY, Math.ceil(ratio.rh * size.height));
            if (cropW >= 120 && cropH >= 100) {
              targetImage = shot.crop({ x: cropX, y: cropY, width: cropW, height: cropH });
            }
          }

          let ocrText = await recognizeCanvasPngLocally(targetImage.toPNG());
          if (ocrText.length < 40 && targetImage !== shot) {
            ocrText = await recognizeCanvasPngLocally(shot.toPNG());
          }
          if (ocrText.length >= 30) {
            finalLength = ocrText.length;
            finalTruncated = ocrText.length > maxChars;
            finalText = finalTruncated ? ocrText.slice(0, maxChars) : ocrText;
            extractionMethod = "canvas-ocr";
          }
        }
      } catch {
        // Non-fatal: fall back to DOM snapshot
      }
    }

    return {
      tabId: tab.id,
      accountId: tab.accountId,
      title: raw.title,
      url: raw.url,
      selection: raw.selection,
      text: finalText,
      textLength: finalLength,
      truncated: finalTruncated,
      likelyCanvasReader: raw.likelyCanvasReader,
      extractionMethod,
      capturedAt: raw.capturedAt,
    };
  }

  getActiveTabUrl(): string {
    const tab = this.getActiveTab();
    if (!tab) return "";
    return tab.view.webContents.getURL() || tab.url || "";
  }

  /**
   * Inject parsed cookies into the currently active isolated account partition.
   * Cookie values stay strictly in main process memory.
   */
  async importCookiesIntoActiveAccount(
    cookies: NormalizedCookie[],
  ): Promise<{ accountId: string; imported: number; failed: number; domains: string[] }> {
    this.loadAccountsOnce();
    const partition = `persist:reading-browser-${this.activeAccountId}`;
    const ses = session.fromPartition(partition);

    let imported = 0;
    let failed = 0;
    const touchedDomains = new Set<string>();

    for (const c of cookies) {
      const host = normalizeDomainKey(c.domain);
      if (!host || !c.name) {
        failed++;
        continue;
      }
      try {
        const url = buildElectronCookieUrl(c);
        const isHostCookie = !c.domain.startsWith(".") || c.name.startsWith("__Host-");
        const isSecure = c.secure || c.name.startsWith("__Host-") || c.name.startsWith("__Secure-");
        const safeSameSite =
          c.sameSite === "no_restriction" && !isSecure ? undefined : c.sameSite;
        await ses.cookies.set({
          url,
          name: c.name,
          value: c.value,
          ...(isHostCookie ? {} : { domain: `.${host}` }),
          path: c.name.startsWith("__Host-") ? "/" : c.path || "/",
          secure: isSecure,
          httpOnly: c.httpOnly,
          ...(safeSameSite ? { sameSite: safeSameSite } : {}),
          ...(c.expirationDate ? { expirationDate: c.expirationDate } : {}),
        });
        imported++;
        touchedDomains.add(host);
      } catch {
        failed++;
      }
    }

    // Reload active tab if its host matches any imported domain.
    const activeTab = this.getActiveTab();
    if (activeTab && imported > 0) {
      try {
        const activeHost = normalizeDomainKey(new URL(activeTab.view.webContents.getURL() || activeTab.url).hostname);
        const matches = [...touchedDomains].some(
          (d) => activeHost === d || activeHost.endsWith(`.${d}`) || d.endsWith(`.${activeHost}`),
        );
        if (matches) {
          activeTab.view.webContents.reload();
        }
      } catch {
        // Ignore non-URL start pages.
      }
    }

    return {
      accountId: this.activeAccountId,
      imported,
      failed,
      domains: [...touchedDomains],
    };
  }

  /**
   * Export cookies strictly in main-process memory for a single target origin
   * (used to bridge right-hand WebContentsView login into local `zlib login --cookies`).
   */
  async exportCookiesForOrigin(originUrl: string): Promise<NormalizedCookie[]> {
    this.loadAccountsOnce();
    const parsed = new URL(originUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("仅支持同步 HTTP/HTTPS 站点的 Cookie");
    }
    const partition = `persist:reading-browser-${this.activeAccountId}`;
    const ses = session.fromPartition(partition);

    const host = normalizeDomainKey(parsed.hostname);
    const all = await ses.cookies.get({});
    const matched = all.filter((c) => {
      const dom = normalizeDomainKey(c.domain ?? "");
      if (!dom) return false;
      return host === dom || host.endsWith(`.${dom}`);
    });

    return matched.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain ?? host,
      path: c.path ?? "/",
      secure: Boolean(c.secure),
      httpOnly: Boolean(c.httpOnly),
      ...(c.expirationDate ? { expirationDate: c.expirationDate } : {}),
    }));
  }

  dispose(): void {
    this.detachCurrentView();
    for (const tab of this.tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) {
        tab.view.webContents.close();
      }
    }
    this.tabs.clear();
    this.activeTabId = null;
  }

  private getActiveTab(): InternalTab | null {
    if (!this.activeTabId) return null;
    const tab = this.tabs.get(this.activeTabId) ?? null;
    if (!tab || tab.view.webContents.isDestroyed()) return null;
    return tab;
  }

  syncThemeBackground(isDark: boolean): void {
    const bg = isDark ? "#131722" : "#ffffff";
    for (const tab of this.tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) {
        tab.view.setBackgroundColor(bg);
      }
    }
  }

  private createTab(accountId: string, initialUrl: string): InternalTab {
    const partition = `persist:reading-browser-${accountId}`;
    const ses = session.fromPartition(partition);
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#131722" : "#ffffff");

    const id = `tab-${++this.tabSeq}`;
    const startPage = isStartPageUrl(initialUrl);
    const record: InternalTab = {
      id,
      accountId,
      view,
      title: startPage ? START_PAGE_TITLE : "加载中…",
      url: initialUrl,
      isLoading: !startPage,
      readyToShow: startPage,
      awaitingCommit: !startPage,
    };
    if (!startPage) {
      this.scheduleTabRevealFallback(record, TAB_REVEAL_SAFETY_MS);
    }

    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      try {
        const safe = normalizeAllowedWebUrl(url);
        const child = this.createTab(accountId, safe);
        this.activateTab(child.id);
        this.pushState();
      } catch {
        // Deny non-HTTP(S) popups.
      }
      return { action: "deny" };
    });

    const sync = () => {
      if (wc.isDestroyed()) return;
      record.url = wc.getURL() || record.url;
      record.title = wc.getTitle() || record.title;
      this.pushState();
    };
    wc.on("did-start-loading", () => {
      record.isLoading = true;
      sync();
    });
    // Readiness signals only count once the *new* document has committed; otherwise the
    // old page's abort/stop events would briefly re-reveal it (e.g. WeRead flashing before Douban).
    wc.on("dom-ready", () => {
      if (!record.awaitingCommit) this.markTabReady(record);
    });
    wc.on("did-fail-load", (_e, errorCode, _desc, _url, isMainFrame) => {
      // ERR_ABORTED (-3) is the previous navigation being cancelled by the new one.
      if (!isMainFrame || errorCode === -3) return;
      record.awaitingCommit = false;
      this.markTabReady(record);
    });
    wc.on("did-stop-loading", () => {
      record.isLoading = false;
      if (!record.awaitingCommit) this.markTabReady(record);
      this.updateZoom(record);
      sync();
    });
    wc.on("did-navigate", (_e, nextUrl) => {
      try {
        const prevOrigin = record.url ? new URL(record.url).origin : "";
        const nextOrigin = nextUrl ? new URL(nextUrl).origin : "";
        if (prevOrigin && nextOrigin && prevOrigin !== nextOrigin) {
          record.faviconUrl = undefined;
        }
      } catch {
        record.faviconUrl = undefined;
      }
      record.url = nextUrl || record.url;
      if (record.awaitingCommit) {
        // New document committed: reveal shortly after (or sooner on dom-ready) instead of
        // waiting for the whole page to parse.
        record.awaitingCommit = false;
        if (!record.readyToShow) this.scheduleTabRevealFallback(record, TAB_REVEAL_AFTER_COMMIT_MS);
      }
      sync();
    });
    wc.on("page-title-updated", (_e, title) => {
      record.title = title;
      sync();
    });
    wc.on("page-favicon-updated", (_e, favicons) => {
      const valid = favicons.find((u) => /^https?:\/\//i.test(u));
      if (valid && valid !== record.faviconUrl) {
        record.faviconUrl = valid;
        sync();
      }
    });
    const tabNonce = crypto.randomBytes(12).toString("hex");
    const injectSelectionBar = () => {
      if (wc.isDestroyed()) return;
      const currentUrl = wc.getURL();
      if (!/^https?:\/\//i.test(currentUrl)) return;
      void wc.executeJavaScript(buildSelectionToolbarScript(tabNonce), true).catch(() => undefined);
    };

    wc.on("did-finish-load", injectSelectionBar);
    wc.on("console-message", (details) => {
      const msg = typeof details?.message === "string" ? details.message : "";
      if (!msg.startsWith(SELECTION_SIGNAL_PREFIX)) return;
      const rest = msg.slice(SELECTION_SIGNAL_PREFIX.length);
      const expectedPrefix = `${tabNonce}:`;
      if (!rest.startsWith(expectedPrefix)) return;
      const action = rest.slice(expectedPrefix.length) as BrowserSelectionActionKind;
      if (action !== "save" && action !== "ask" && action !== "draft") return;
      void wc
        .executeJavaScript(
          `(() => {
            const txt = String(window.__diandianLastSelection || (window.getSelection ? window.getSelection().toString() : "") || "").trim();
            window.__diandianLastSelection = "";
            return { text: txt.slice(0, 4000), title: document.title || "", url: location.href || "" };
          })()`,
          true,
        )
        .then((res: unknown) => {
          if (!res || typeof res !== "object") return;
          const rec = res as { text?: string; title?: string; url?: string };
          const text = String(rec.text ?? "").trim();
          if (!text) return;
          this.onSelectionAction?.({
            action,
            text,
            title: String(rec.title ?? record.title ?? ""),
            url: String(rec.url ?? record.url ?? ""),
          });
        })
        .catch(() => undefined);
    });

    wc.on("did-navigate", sync);
    wc.on("did-navigate-in-page", sync);

    this.tabs.set(id, record);
    void wc.loadURL(initialUrl).catch(() => undefined);
    return record;
  }

  private activateTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.view.webContents.isDestroyed()) return;
    const win = this.getWindow();
    if (this.attachedView && this.attachedView !== tab.view) {
      this.detachCurrentView();
    }
    this.activeTabId = tab.id;
    if (win && !win.isDestroyed()) {
      if (this.attachedView !== tab.view) {
        win.contentView.addChildView(tab.view);
        this.attachedView = tab.view;
      }
      this.applyViewGeometry();
      this.applyViewVisibility();
    }
  }

  private detachCurrentView(): void {
    const win = this.getWindow();
    if (win && !win.isDestroyed() && this.attachedView) {
      try {
        win.contentView.removeChildView(this.attachedView);
      } catch {
        // Ignore if already detached.
      }
    }
    this.attachedView = null;
  }

  private applyViewGeometry(): void {
    const active = this.getActiveTab();
    if (!active || this.bounds.width <= 0 || this.bounds.height <= 0) return;
    active.view.setBounds(this.bounds);
    this.updateZoom(active);
  }

  private scheduleTabRevealFallback(tab: InternalTab, delayMs: number): void {
    if (tab.revealTimer) clearTimeout(tab.revealTimer);
    tab.revealTimer = setTimeout(() => {
      tab.awaitingCommit = false;
      this.markTabReady(tab);
    }, delayMs);
  }

  private deferTabReveal(tab: InternalTab, nextUrl: string): void {
    tab.readyToShow = false;
    tab.awaitingCommit = true;
    tab.isLoading = true;
    tab.url = nextUrl;
    this.scheduleTabRevealFallback(tab, TAB_REVEAL_SAFETY_MS);
    this.applyViewVisibility();
    this.pushState();
  }

  private markTabReady(tab: InternalTab): void {
    if (tab.revealTimer) {
      clearTimeout(tab.revealTimer);
      tab.revealTimer = undefined;
    }
    if (tab.readyToShow) return;
    tab.readyToShow = true;
    this.applyViewVisibility();
  }

  private applyViewVisibility(): void {
    const active = this.getActiveTab();
    if (!active) return;
    const shouldShow =
      this.visible
      && !this.suppressed
      && active.readyToShow
      && this.bounds.width > 0
      && this.bounds.height > 0;
    active.view.setVisible(shouldShow);
  }

  getZoomPercent(): number {
    return Math.round(this.userZoomScale * 100);
  }

  adjustZoom(action: "in" | "out" | "reset"): number {
    if (action === "reset") {
      this.userZoomScale = 1;
    } else if (action === "in") {
      this.userZoomScale = Math.min(1.5, Math.round((this.userZoomScale + 0.1) * 10) / 10);
    } else {
      this.userZoomScale = Math.max(0.7, Math.round((this.userZoomScale - 0.1) * 10) / 10);
    }
    const active = this.getActiveTab();
    if (active) {
      this.updateZoom(active);
    }
    return this.getZoomPercent();
  }

  private updateZoom(tab: InternalTab): void {
    if (tab.view.webContents.isDestroyed() || this.bounds.width <= 0) return;
    const baseFactor =
      this.bounds.width < DESKTOP_LAYOUT_WIDTH
        ? Math.max(0.68, Math.min(1, this.bounds.width / DESKTOP_LAYOUT_WIDTH))
        : 1;
    const factor = Math.max(0.5, Math.min(2, baseFactor * this.userZoomScale));
    tab.view.webContents.setZoomFactor(factor);
  }

  private accountsFilePath(): string {
    return path.join(this.userDataDir, "browser", "accounts.json");
  }

  private loadAccountsOnce(): void {
    if (this.accountsLoaded) return;
    this.accountsLoaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.accountsFilePath(), "utf8")) as {
        accounts?: BrowserAccount[];
      };
      for (const acc of parsed.accounts ?? []) {
        if (acc && typeof acc.id === "string" && acc.id) {
          this.accounts.set(acc.id, acc);
        }
      }
    } catch {
      // Fresh profile.
    }
    if (!this.accounts.has(DEFAULT_ACCOUNT_ID)) {
      this.accounts.set(DEFAULT_ACCOUNT_ID, {
        id: DEFAULT_ACCOUNT_ID,
        label: "默认账号",
        createdAt: new Date().toISOString(),
      });
      this.saveAccounts();
    }
  }

  private saveAccounts(): void {
    writeJsonAtomic(this.accountsFilePath(), {
      version: 1,
      accounts: [...this.accounts.values()],
    });
  }

  private pushState(): void {
    this.onStateChanged(this.getState());
  }
}
