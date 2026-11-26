import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  globalShortcut,
  Menu,
  nativeTheme,
  safeStorage,
  shell,
} from "electron";
import { BridgeRejection, LocalBridgeServer } from "./agent/bridgeServer";
import { AgentSupervisor } from "./agent/supervisor";
import { APP_REPO_URL, buildAppMenuTemplate, type AppMenuAction } from "./appMenu";
import { BrowserMenuWindowController } from "./browser/browserMenuWindow";
import { BrowserService, type BrowserBounds } from "./browser/browserService";
import {
  filterCookiesByDomains,
  parseCookieInput,
  type ParsedCookieBundle,
} from "./browser/cookieCodec";
import {
  extractLocalBrowserCookies,
  inspectLocalBrowserProfile,
  listLocalBrowserProfiles,
  type ReadingSiteGroupId,
} from "./browser/localBrowserImporter";
import type { BrowserSelectionActionEvent } from "./browser/selectionOverlay";
import { DEFAULT_READING_URL } from "./browser/startPage";
import { CardBakerService, registerCardPrivilegedSchemes } from "./cards/cardBaker";
import { CARD_TEMPLATES, renderReadingCardHtml, type ReadingCardPayload } from "./cards/cardTemplates";
import { splitTextIntoCarouselSlides, type CarouselDeckPayload } from "./cards/carouselTemplates";
import {
  extractConceptVisualFromDraft,
  renderConceptVisualHtml,
  type ConceptVisualPayload,
} from "./cards/conceptVisualTemplates";
import type { MonthlyPosterPayload } from "./cards/posterTemplates";
import { exportBookToObsidian, exportDraftToObsidian } from "./export/obsidianExporter";
import { availableObsidianVault, listObsidianVaults, resolveObsidianVaultRoot } from "./export/obsidianVaults";
import { importNotesIntoDatabase } from "./importers/notesImporter";
import {
  listWeReadNotebooks,
  syncWeReadBooksIntoDatabase,
  type WeReadNotebookBook,
} from "./importers/wereadSyncService";
import { PetWindowController, resolvePetPreloadPath, type PetWindowMode } from "./pet/petWindow";
import {
  KindleSettingsStore,
  sendBookViaKindleSmtp,
  verifyKindleSmtp,
  type KindleSmtpSecurity,
} from "./router/kindleSmtpService";
import { searchOnlineBookMetadata, type BookMetadataCandidate } from "./router/metadataService";
import { importBookText, importResult, importSelectedBooks } from "./router/localBookImport";
import { ROUTER_EBOOK_EXTENSIONS, BOOK_FILE_EXTENSIONS, listDownloadedBooks, resolveDownloadedBook } from "./router/downloadedBooks";
import { DownloadedBookCovers } from "./router/downloadedBookCovers";
import { openReaderBook, resolveReaderHighlight, updateReaderMetadata } from "./router/localReader";
import { ReaderTranslationService } from "./router/readerTranslation";
import type { ReaderTranslationInput, ReaderTranslationSettingsInput } from "../src/types/desktop";
import type { DownloadCoverHint, ReaderAnnotationInput } from "../src/types/desktop";
import { ZlibCliService, type ConnectionsSnapshot } from "./router/zlibCliService";
import { SafetyModeStore, normalizeSafetyMode, type SafetyMode } from "./security/safetyPolicy";
import { fetchAvailableModels } from "./security/modelCatalog";
import { ModelSettingsStore, normalizeBaseUrl } from "./security/secretStore";
import { ReaderTranslationSettingsStore } from "./security/readerTranslationSettings";
import { TrustedIpcRegistry } from "./security/trustedIpc";
import { matchesTrustedAppUrl } from "./security/urlMatch";
import { BookCoverCache } from "./storage/bookCoverCache";
import {
  KnowledgeDatabase,
  type BookSource,
  type DraftKind,
  type NotebookItemKind,
  type RevisionAuthorKind,
} from "./storage/database";
import { distillStyleFromRevisionDiff } from "./twin/styleDistiller";
import { TwinStore } from "./twin/twinStore";

// Must run synchronously before app.whenReady().
registerCardPrivilegedSchemes();

let mainWindow: BrowserWindow | null = null;
let browserService: BrowserService | null = null;
let browserMenuController: BrowserMenuWindowController | null = null;
let currentAppTheme: "light" | "dark" = "light";
let mainWindowActiveForPet = true;
let blurCheckTimer: NodeJS.Timeout | null = null;

function syncPetMainContext(): void {
  if (!petController) return;
  const win = mainWindow;
  if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) {
    mainWindowActiveForPet = false;
    petController.setMainWindowContext({ active: false, bounds: null });
    return;
  }
  petController.setMainWindowContext({
    active: mainWindowActiveForPet,
    bounds: win.getBounds(),
  });
}

function scheduleAppFocusCheck(): void {
  if (blurCheckTimer) clearTimeout(blurCheckTimer);
  blurCheckTimer = setTimeout(() => {
    blurCheckTimer = null;
    const focused = BrowserWindow.getFocusedWindow();
    if (!focused) {
      mainWindowActiveForPet = false;
      syncPetMainContext();
    }
  }, 90);
}
let bridgeServer: LocalBridgeServer | null = null;
let supervisor: AgentSupervisor | null = null;
let settingsStore: ModelSettingsStore | null = null;
let kindleStore: KindleSettingsStore | null = null;
let safetyStore: SafetyModeStore | null = null;
let knowledgeDb: KnowledgeDatabase | null = null;
let readerTranslations: ReaderTranslationService;
let readerTranslationSettings: ReaderTranslationSettingsStore;
let bookCovers: BookCoverCache;
let downloadedCovers: DownloadedBookCovers;
let twinStore: TwinStore | null = null;
let cardBaker: CardBakerService | null = null;
let zlibService: ZlibCliService | null = null;
let petController: PetWindowController | null = null;

const ipc = new TrustedIpcRegistry();
const metadataLookups = new WeakMap<BrowserWindow, { id: string; bookId: string; candidates: BookMetadataCandidate[] }>();
const pendingCookieImports = new Map<string, ParsedCookieBundle>();

function stashPendingCookieImport(bundle: ParsedCookieBundle): string {
  if (pendingCookieImports.size >= 5) {
    const oldest = pendingCookieImports.keys().next().value;
    if (oldest) pendingCookieImports.delete(oldest);
  }
  const token = crypto.randomUUID();
  pendingCookieImports.set(token, bundle);
  return token;
}

function resolveAppEntryUrl(): string {
  const devUrl = !app.isPackaged ? process.env.DIANDIAN_DEV_SERVER_URL : undefined;
  if (devUrl) return devUrl;
  return pathToFileURL(path.join(__dirname, "../dist/index.html")).href;
}

function resolveProjectRoot(): string {
  return path.resolve(__dirname, "..");
}

function sendToMain(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function sendToAll(channel: string, payload: unknown): void {
  sendToMain(channel, payload);
  const petWin = petController?.getWindow();
  if (petWin && !petWin.isDestroyed() && !petWin.webContents.isDestroyed()) {
    petWin.webContents.send(channel, payload);
  }
}

function cleanPageBookTitle(rawTitle: string): string {
  return (
    rawTitle
      .replace(/\s*[-–—|]\s*(微信读书|WeRead|豆瓣读书|豆瓣|小红书).*$/i, "")
      .replace(/^《|》$/g, "")
      .trim() || "网页摘录"
  );
}

function requireDb(): KnowledgeDatabase {
  if (!knowledgeDb) throw new Error("本地知识库尚未初始化");
  return knowledgeDb;
}

function getObsidianVault(): string {
  return availableObsidianVault(requireDb().getSetting("obsidian.vaultPath") ?? "");
}

function setObsidianVault(selected: string): string {
  const vaultPath = selected ? resolveObsidianVaultRoot(selected) : "";
  requireDb().setSetting("obsidian.vaultPath", vaultPath);
  return vaultPath;
}

function requireObsidianVault(): string {
  const vault = getObsidianVault();
  if (!vault) {
    // The renderer offers a "去设置" shortcut when it sees this message; keep the two in sync.
    throw new Error("请先在「连接与偏好 → Obsidian 联动」中连接一个可用的 Obsidian 笔记库。");
  }
  return vault;
}

function wireIpcHandlers(): void {
  ipc.handle("app:take-menu-action", () => {
    const action = pendingMenuAction;
    pendingMenuAction = null;
    return action ? { action } : null;
  });

  ipc.handle("app:info", () => ({
    name: app.getName(),
    version: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
  }));

  ipc.handle("app:set-theme", (win, mode: "light" | "dark") => {
    const clean = mode === "dark" ? "dark" : "light";
    currentAppTheme = clean;
    nativeTheme.themeSource = clean;
    if (!win.isDestroyed()) {
      win.setBackgroundColor(clean === "dark" ? "#12161f" : "#ffffff");
    }
    sendToAll("app:theme-changed", { theme: clean });
    browserMenuController?.updateData({ theme: clean });
    browserService?.syncThemeBackground(clean === "dark");
    return { theme: clean };
  });

  // ---------- Model & Safety Settings ----------

  ipc.handle("settings:get-model", () => {
    if (!settingsStore) throw new Error("Settings store not initialized");
    return settingsStore.readPublic();
  });

  ipc.handle("settings:list-models", async () => {
    if (!settingsStore) throw new Error("Settings store not initialized");
    return fetchAvailableModels(settingsStore.readRaw());
  });

  ipc.handle(
    "settings:save-model",
    async (
      _win,
      input: {
        provider: "deepseek" | "openai-compatible";
        model: string;
        baseUrl: string;
        apiKey?: string;
        clearApiKey?: boolean;
        allowPlaintextKey?: boolean;
      },
    ) => {
      if (!settingsStore) throw new Error("Settings store not initialized");
      const saved = settingsStore.save(input);
      await supervisor?.reloadForSettingsChange();
      return saved;
    },
  );

  ipc.handle(
    "settings:test-model",
    async (
      _win,
      input: {
        baseUrl: string;
        model: string;
        apiKey?: string;
        useSavedKey?: boolean;
      },
    ) => {
      if (!settingsStore) throw new Error("Settings store not initialized");
      let cleanBaseUrl: string;
      try {
        cleanBaseUrl = normalizeBaseUrl(String(input?.baseUrl ?? ""));
      } catch (err) {
        return { ok: false as const, message: err instanceof Error ? err.message : "接口地址格式不正确" };
      }
      const cleanModel = String(input?.model ?? "").trim();
      if (!cleanModel) {
        return { ok: false as const, message: "请先选择或填写模型名称" };
      }
      const typedKey = String(input?.apiKey ?? "").trim();
      const effectiveKey = typedKey || (input?.useSavedKey ? settingsStore.readRaw().apiKey : "");
      const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(cleanBaseUrl);
      if (!effectiveKey && !isLocalhost) {
        return { ok: false as const, message: "请先输入 API 密钥再测试连接" };
      }

      const started = Date.now();
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (effectiveKey) headers.Authorization = `Bearer ${effectiveKey}`;
        const res = await fetch(`${cleanBaseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: cleanModel,
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 1,
          }),
          signal: AbortSignal.timeout(12_000),
        });
        const latencyMs = Date.now() - started;
        if (res.ok) {
          return { ok: true as const, latencyMs };
        }
        if (res.status === 401 || res.status === 403) {
          return { ok: false as const, message: "API 密钥无效或无权访问，请检查是否复制完整" };
        }
        if (res.status === 402) {
          return { ok: false as const, message: "账户余额不足，请前往服务商平台充值后再试" };
        }
        if (res.status === 404) {
          return { ok: false as const, message: `接口地址或模型「${cleanModel}」不可用，请检查高级设置` };
        }
        if (res.status === 429) {
          return { ok: false as const, message: "请求频率受限或额度已用完，请稍后重试" };
        }
        let detail = "";
        try {
          const body = (await res.json()) as { error?: { message?: string }; message?: string };
          detail = String(body?.error?.message || body?.message || "").slice(0, 120);
        } catch {
          // Ignore non-JSON error body
        }
        return {
          ok: false as const,
          message: detail ? `接口返回错误 (${res.status})：${detail}` : `接口返回异常状态 (${res.status})`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (/timeout|abort/i.test(msg)) {
          return { ok: false as const, message: "连接超时（12 秒无响应），请检查网络或接口地址" };
        }
        return { ok: false as const, message: "无法连接到接口地址，请检查网络、代理或 Base URL" };
      }
    },
  );

  ipc.handle("settings:open-key-portal", async (_win, presetId: string) => {
    const portals: Record<string, string> = {
      deepseek: "https://platform.deepseek.com/api_keys",
      kimi: "https://platform.moonshot.cn/console/api-keys",
      qwen: "https://bailian.console.aliyun.com/",
      glm: "https://open.bigmodel.cn/usercenter/apikeys",
      openai: "https://platform.openai.com/api-keys",
    };
    const url = portals[String(presetId ?? "")];
    if (!url) return { opened: false };
    await shell.openExternal(url);
    return { opened: true };
  });

  ipc.handle("safety:get-mode", () => {
    if (!safetyStore) throw new Error("Safety store not initialized");
    return { mode: safetyStore.read() };
  });

  ipc.handle("safety:set-mode", (_win, mode: SafetyMode) => {
    if (!safetyStore) throw new Error("Safety store not initialized");
    const saved = safetyStore.write(normalizeSafetyMode(mode));
    return { mode: saved };
  });

  // ---------- Twin Profile (PROFILE.md / STYLE.md) ----------

  ipc.handle("twin:get", () => {
    if (!twinStore) throw new Error("Twin store not initialized");
    return twinStore.read();
  });

  ipc.handle("twin:save", (_win, input: { profileMd?: string; styleMd?: string }) => {
    if (!twinStore) throw new Error("Twin store not initialized");
    return twinStore.save(input);
  });

  ipc.handle("twin:distill-diff", async (_win, input: { draftId: string }) => {
    if (!twinStore) throw new Error("Twin store not initialized");
    const draft = requireDb().getDraft(String(input?.draftId ?? ""));
    if (!draft?.revisions || draft.revisions.length < 2) {
      return { suggestions: [] };
    }
    const aiRev = draft.revisions.find((r) => r.authorKind === "ai");
    const humanRev = [...draft.revisions].reverse().find((r) => r.authorKind === "human");
    if (!aiRev || !humanRev) return { suggestions: [] };
    const twin = twinStore.read();
    const modelSettings = settingsStore ? settingsStore.readRaw() : null;
    const suggestions = await distillStyleFromRevisionDiff({
      aiOriginal: aiRev.content,
      humanRevision: humanRev.content,
      currentStyleMd: twin.styleMd,
      modelSettings,
    });
    return { suggestions };
  });

  ipc.handle("twin:accept-style-rules", (_win, rules: string[]) => {
    if (!twinStore) throw new Error("Twin store not initialized");
    const clean = Array.isArray(rules) ? rules.map((r) => String(r)) : [];
    return twinStore.appendLearnedStyleRules(clean);
  });

  // ---------- Native Embedded Browser ----------

  ipc.handle("browser:get-state", () => browserService?.getState());

  ipc.handle("browser:open-url", async (_win, input: { url?: string; newTab?: boolean }) => {
    if (!browserService) throw new Error("Browser service unavailable");
    return browserService.openUrl(input?.url, { newTab: input?.newTab === true });
  });

  ipc.handle(
    "browser:navigate",
    async (_win, action: "back" | "forward" | "reload" | "stop" | "home" | "weread") => {
      if (!browserService) throw new Error("Browser service unavailable");
      return browserService.navigate(action);
    },
  );

  ipc.handle("browser:select-tab", (_win, tabId: string) => {
    if (!browserService) throw new Error("Browser service unavailable");
    return browserService.selectTab(tabId);
  });

  ipc.handle("browser:close-tab", (_win, tabId: string) => {
    if (!browserService) throw new Error("Browser service unavailable");
    return browserService.closeTab(tabId);
  });

  ipc.handle("browser:add-account", (_win, label: string) => {
    if (!browserService) throw new Error("Browser service unavailable");
    return browserService.addAccount(label);
  });

  ipc.handle("browser:switch-account", (_win, accountId: string) => {
    if (!browserService) throw new Error("Browser service unavailable");
    return browserService.switchAccount(accountId);
  });

  ipc.handle("browser:read-page", async (_win, input?: { maxChars?: number }) => {
    if (!browserService) throw new Error("Browser service unavailable");
    return browserService.readPageContent({ maxChars: input?.maxChars });
  });

  ipc.on("browser:set-bounds", (_win, rect: BrowserBounds) => {
    browserService?.setBounds(rect);
  });

  ipc.handle("browser:set-visible", (_win, visible: boolean) => {
    if (!browserService) throw new Error("Browser service unavailable");
    return browserService.setVisible(Boolean(visible));
  });

  ipc.on("browser:set-suppressed", (_win, suppressed: boolean) => {
    browserService?.setSuppressed(Boolean(suppressed));
  });

  ipc.handle("browser:show-more-menu", async (_win, pos: { x?: number; y?: number }) => {
    if (!browserService || !browserMenuController) throw new Error("Browser menu unavailable");
    const state = browserService.getState();
    const activeTab = state.tabs.find((t) => t.id === state.activeTabId) ?? null;
    const x = typeof pos?.x === "number" && Number.isFinite(pos.x) ? pos.x : 1120;
    const y = typeof pos?.y === "number" && Number.isFinite(pos.y) ? pos.y : 40;
    await browserMenuController.openAt(x, y, {
      url: activeTab?.url ?? "",
      zoomPercent: browserService.getZoomPercent(),
      theme: currentAppTheme,
    });
    return { opened: true };
  });

  ipc.handle("browser-menu:zoom", (_win, action: "in" | "out" | "reset") => {
    if (!browserService) throw new Error("Browser service unavailable");
    const zoomPercent = browserService.adjustZoom(action);
    return { zoomPercent };
  });

  ipc.handle(
    "browser-menu:action",
    async (
      _win,
      action: "copy-url" | "open-external" | "import-cookie" | "open-downloads" | "open-settings",
    ) => {
      browserMenuController?.hide();
      const activeUrl = browserService?.getActiveTabUrl() ?? "";
      if (action === "copy-url") {
        if (/^https?:\/\//i.test(activeUrl)) {
          clipboard.writeText(activeUrl);
          browserMenuController?.dispatchToMain({ kind: "notified", message: "已复制当前页面网址" });
        }
        return { ok: true };
      }
      if (action === "open-external") {
        if (/^https?:\/\//i.test(activeUrl)) {
          await shell.openExternal(activeUrl);
        }
        return { ok: true };
      }
      if (action === "open-downloads") {
        if (zlibService) {
          const dir = path.resolve(zlibService.getDownloadDir());
          fs.mkdirSync(dir, { recursive: true });
          await shell.openPath(dir);
        }
        return { ok: true };
      }
      if (action === "import-cookie") {
        browserMenuController?.dispatchToMain({ kind: "import-cookie" });
        return { ok: true };
      }
      if (action === "open-settings") {
        browserMenuController?.dispatchToMain({ kind: "open-settings" });
        return { ok: true };
      }
      return { ok: false };
    },
  );

  ipc.handle("browser-menu:close", () => {
    browserMenuController?.hide();
    return { closed: true };
  });

  ipc.handle("browser:pick-cookie-file", async (win) => {
    const res = await dialog.showOpenDialog(win, {
      title: "选择外部浏览器导出的单站点 Cookie 文件（Netscape .txt 或 JSON）",
      properties: ["openFile"],
      filters: [
        { name: "Cookie 文件 (TXT / JSON)", extensions: ["txt", "json"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    if (res.canceled || !res.filePaths[0]) {
      return { canceled: true as const };
    }
    const raw = fs.readFileSync(res.filePaths[0], "utf8");
    const bundle = parseCookieInput(raw);
    const importToken = stashPendingCookieImport(bundle);
    return {
      canceled: false as const,
      fileName: path.basename(res.filePaths[0]),
      importToken,
      format: bundle.format,
      totalCount: bundle.cookies.length,
      domains: bundle.domains,
    };
  });

  ipc.handle("browser:parse-cookie-text", (_win, rawText: string) => {
    const bundle = parseCookieInput(String(rawText ?? ""));
    const importToken = stashPendingCookieImport(bundle);
    return {
      importToken,
      format: bundle.format,
      totalCount: bundle.cookies.length,
      domains: bundle.domains,
    };
  });

  ipc.handle(
    "browser:apply-cookie-import",
    async (_win, input: { importToken: string; selectedDomains: string[] }) => {
      if (!browserService) throw new Error("Browser service unavailable");
      const bundle = pendingCookieImports.get(input.importToken);
      if (!bundle) throw new Error("导入会话已过期，请重新选择或粘贴 Cookie");
      const selected = filterCookiesByDomains(bundle.cookies, input.selectedDomains ?? []);
      if (selected.length === 0) {
        throw new Error("请至少勾选一个要导入的站点域名");
      }
      pendingCookieImports.delete(input.importToken);
      return browserService.importCookiesIntoActiveAccount(selected);
    },
  );

  ipc.handle("browser:discard-cookie-import", (_win, importToken: string) => {
    pendingCookieImports.delete(importToken);
    return { discarded: true };
  });

  ipc.handle("browser:list-local-browsers", () => {
    return listLocalBrowserProfiles();
  });

  ipc.handle("browser:inspect-local-browser", (_win, profileId: string) => {
    return inspectLocalBrowserProfile(String(profileId ?? ""));
  });

  ipc.handle(
    "browser:import-local-browser",
    async (_win, input: { profileId: string; groups: ReadingSiteGroupId[] }) => {
      if (!browserService) throw new Error("Browser service unavailable");
      const allowed = new Set<ReadingSiteGroupId>([
        "weread",
        "douban",
        "xiaohongshu",
        "wechat_mp",
        "zlib",
        "other",
      ]);
      const safeGroups = Array.isArray(input?.groups)
        ? input.groups.filter((g): g is ReadingSiteGroupId => allowed.has(g))
        : [];
      const extracted = await extractLocalBrowserCookies(String(input?.profileId ?? ""), safeGroups);
      if (extracted.cookies.length === 0) {
        return {
          browserName: extracted.profile.browserName,
          profileName: extracted.profile.profileName,
          accountId: browserService.getState().activeAccountId,
          imported: 0,
          failed: 0,
          domains: [] as string[],
        };
      }
      const res = await browserService.importCookiesIntoActiveAccount(extracted.cookies);
      return {
        browserName: extracted.profile.browserName,
        profileName: extracted.profile.profileName,
        ...res,
      };
    },
  );

  // ---------- DeepSeek Harness Agent ----------

  ipc.handle(
    "agent:send",
    async (_win, input: { prompt: string; newSession?: boolean; sessionId?: string | null }) => {
      if (!supervisor) throw new Error("Agent supervisor unavailable");
      await supervisor.send(input.prompt, {
        newSession: input.newSession === true,
        sessionId: input.sessionId ?? undefined,
      });
      return { accepted: true };
    },
  );

  ipc.handle("agent:stop", async () => {
    await supervisor?.stopCurrentTurn();
    return { stopped: true };
  });

  ipc.handle("agent:reset", () => {
    supervisor?.resetSession();
    return { reset: true };
  });

  ipc.handle("agent:select-session", (_win, sessionId?: string | null) => {
    supervisor?.selectSession(sessionId ?? null);
    return { selected: true };
  });

  ipc.handle("agent:list-sessions", (_win, limit?: number) =>
    requireDb().listChatSessions(typeof limit === "number" ? limit : 40),
  );

  ipc.handle("agent:get-session", (_win, id: string) => requireDb().getChatSession(id));

  ipc.handle(
    "agent:save-session",
    (
      _win,
      input: {
        id: string;
        title: string;
        harnessSessionId?: string;
        messages: Array<{
          id: string;
          role: "user" | "assistant" | "system";
          text: string;
          reasoning?: string;
          contexts?: string[];
          tools?: Array<{ name: string; status: "running" | "done" }>;
          createdAt?: string;
        }>;
      },
    ) => requireDb().upsertChatSession(input),
  );

  ipc.handle("agent:delete-session", (_win, id: string) => {
    requireDb().deleteChatSession(id);
    return { deleted: true };
  });

  // ---------- Local SQLite Library & Notes ----------

  ipc.handle("library:list-books", (_win, query?: string) => requireDb().listBooks(query ?? ""));

  ipc.handle("library:get-book", (_win, id: string) => requireDb().getBook(id));

  ipc.handle(
    "library:create-book",
    (
      _win,
      input: {
        title: string;
        author?: string;
        isbn?: string;
        publisher?: string;
        publishedYear?: string;
        description?: string;
        tags?: string[];
        coverUrl?: string;
        source?: BookSource;
      },
    ) => requireDb().findOrCreateBook(input),
  );

  ipc.handle(
    "library:update-book",
    (
      _win,
      input: {
        id: string;
        title?: string;
        author?: string;
        isbn?: string;
        publisher?: string;
        publishedYear?: string;
        description?: string;
        tags?: string[];
        coverUrl?: string;
      },
    ) => {
      const { id, ...patch } = input;
      return requireDb().updateBook(id, patch);
    },
  );

  ipc.handle("library:delete-book", (_win, id: string) => {
    requireDb().deleteBook(id);
    return { deleted: true };
  });

  ipc.handle("library:list-highlights", (_win, input: { bookId: string; query?: string }) =>
    requireDb().listHighlights(input.bookId, input.query ?? ""),
  );

  ipc.handle("library:search-highlights", (_win, input: { query: string; limit?: number }) =>
    requireDb().searchAllHighlights(input.query ?? "", input.limit ?? 40),
  );

  ipc.handle(
    "library:add-highlight",
    (
      _win,
      input: {
        bookId: string;
        chapter?: string;
        quote: string;
        note?: string;
        source?: BookSource;
      },
    ) => requireDb().addHighlight(input),
  );

  ipc.handle("library:update-highlight-note", (_win, input: { id: string; note: string }) =>
    requireDb().updateHighlightNote(input.id, input.note),
  );

  ipc.handle("library:delete-highlight", (_win, id: string) => {
    requireDb().deleteHighlight(id);
    return { deleted: true };
  });

  ipc.handle(
    "library:import-notes-text",
    (
      _win,
      input: {
        rawText: string;
        format?: "auto" | "kindle" | "weread";
        fallbackTitle?: string;
        fallbackAuthor?: string;
      },
    ) =>
      importNotesIntoDatabase(requireDb(), input.rawText, {
        format: input.format,
        fallbackTitle: input.fallbackTitle,
        fallbackAuthor: input.fallbackAuthor,
      }),
  );

  ipc.handle(
    "library:import-notes-file",
    async (win, input?: { format?: "auto" | "kindle" | "weread"; fallbackTitle?: string }) => {
      const result = await dialog.showOpenDialog(win, {
        title: "选择 Kindle My Clippings.txt 或微信读书导出的笔记文件",
        properties: ["openFile"],
        filters: [
          { name: "文本与 Markdown 笔记", extensions: ["txt", "md", "markdown"] },
          { name: "所有文件", extensions: ["*"] },
        ],
      });
      if (result.canceled || !result.filePaths[0]) {
        return { canceled: true as const };
      }
      const filePath = result.filePaths[0];
      const rawText = fs.readFileSync(filePath, "utf8");
      const stem = path.basename(filePath, path.extname(filePath));
      const outcome = importNotesIntoDatabase(requireDb(), rawText, {
        format: input?.format ?? "auto",
        fallbackTitle: input?.fallbackTitle,
        fileTitle: stem.toLowerCase() === "my clippings" ? undefined : stem,
      });
      return { canceled: false as const, fileName: path.basename(filePath), ...outcome };
    },
  );

  ipc.handle("library:capture-from-browser", async (_win, input?: { bookId?: string; note?: string }) => {
    if (!browserService) throw new Error("内置浏览器未就绪");
    const snap = await browserService.readPageContent({ maxChars: 6000 });
    const quote = (snap.selection || "").trim() || snap.text.trim().slice(0, 600);
    if (!quote) {
      throw new Error(
        snap.likelyCanvasReader
          ? "右侧页面似乎为画布渲染，未能读取到文本。请先在页面中选中文字，或切换到微信读书「笔记/划线」页面后再采集。"
          : "右侧当前页面暂无可采集的选中文本或正文内容。",
      );
    }
    const db = requireDb();
    let book = input?.bookId ? db.getBook(input.bookId) : null;
    if (!book) {
      const source: BookSource = snap.url.includes("weread.qq.com") ? "weread" : "manual";
      book = db.findOrCreateBook({
        title: cleanPageBookTitle(snap.title),
        source,
        sourceLocator: snap.url,
      });
    }
    const added = db.addHighlight({
      bookId: book.id,
      chapter: snap.title,
      quote,
      note: input?.note ?? "",
      source: book.source,
    });
    return {
      book,
      highlight: added.record,
      deduplicated: added.deduplicated,
      usedSelection: Boolean(snap.selection.trim()),
    };
  });

  ipc.handle("library:lookup-metadata", async (win, query: string, bookId?: string) => {
    if (!bookId) return searchOnlineBookMetadata(query);
    const book = requireDb().getBook(bookId);
    if (!book) throw new Error("找不到这本书，请重新打开书库。");
    const lookup = { id: crypto.randomUUID(), bookId, candidates: [] as BookMetadataCandidate[] };
    metadataLookups.set(win, lookup);
    const result = await searchOnlineBookMetadata(query, book);
    lookup.candidates = result.candidates;
    return { ...result, lookupId: lookup.id };
  });

  ipc.handle("library:apply-metadata", async (win, bookId: string, lookupId: string, index: number) => {
    const lookup = metadataLookups.get(win);
    const edition = lookup?.candidates[index];
    if (!lookup || lookup.id !== lookupId || lookup.bookId !== bookId || !Number.isInteger(index) || !edition) {
      throw new Error("查询结果已更新，请重新查询并选择版本。");
    }
    const coverReady = edition.coverUrl ? await bookCovers.get(edition.coverUrl) : null;
    if (metadataLookups.get(win) !== lookup) throw new Error("查询结果已更新，请重新选择版本。");
    const db = requireDb();
    const book = db.getBook(bookId);
    if (!book) throw new Error("找不到这本书，请重新打开书库。");
    db.updateBook(bookId, {
      author: book.author || edition.author,
      isbn: edition.isbn || undefined,
      publisher: edition.publisher || undefined,
      publishedYear: edition.publishedYear || undefined,
      description: edition.description || undefined,
      coverUrl: coverReady ? edition.coverUrl : undefined,
    }, edition.title);
    metadataLookups.delete(win);
    return { coverUnavailable: Boolean(edition.coverUrl && !coverReady) };
  });

  ipc.handle("library:get-book-cover", (_win, bookId: string) => {
    const coverUrl = requireDb().getBook(bookId)?.coverUrl;
    return coverUrl ? bookCovers.get(coverUrl) : null;
  });

  ipc.handle("library:weread-list-notebooks", async () => {
    if (!browserService) throw new Error("内置浏览器未就绪");
    const cookies = await browserService.exportCookiesForOrigin("https://weread.qq.com");
    return listWeReadNotebooks(cookies);
  });

  ipc.handle("library:weread-sync-books", async (_win, books: WeReadNotebookBook[]) => {
    if (!browserService) throw new Error("内置浏览器未就绪");
    if (!Array.isArray(books) || books.length === 0) {
      throw new Error("请至少选择一本书进行同步");
    }
    const cookies = await browserService.exportCookiesForOrigin("https://weread.qq.com");
    return syncWeReadBooksIntoDatabase(requireDb(), cookies, books, (url) => bookCovers.get(url));
  });

  ipc.handle("library:random-recall", (_win, excludeId?: string) =>
    requireDb().getRandomRecallHighlight(excludeId),
  );

  ipc.handle("library:reading-stats", (_win, monthKey?: string) =>
    requireDb().getReadingStats(monthKey),
  );

  ipc.handle("library:find-related-highlights", (_win, input: { text: string; limit?: number }) =>
    requireDb().findRelatedHighlights(String(input?.text ?? ""), input?.limit ?? 4),
  );

  // ---------- Surf-Style Topic Notebooks ----------

  ipc.handle("notebooks:list", () => requireDb().listNotebooks());

  ipc.handle("notebooks:create", (_win, input: { name: string; icon?: string; description?: string }) =>
    requireDb().createNotebook(input),
  );

  ipc.handle("notebooks:delete", (_win, id: string) => {
    requireDb().deleteNotebook(String(id ?? ""));
    return { deleted: true };
  });

  ipc.handle(
    "notebooks:add-item",
    (
      _win,
      input: { notebookId: string; itemKind: NotebookItemKind; itemRef: string; title: string; meta?: string },
    ) =>
      requireDb().addNotebookItem(input.notebookId, {
        itemKind: input.itemKind,
        itemRef: input.itemRef,
        title: input.title,
        meta: input.meta,
      }),
  );

  ipc.handle("notebooks:remove-item", (_win, input: { notebookId: string; itemId: string }) =>
    requireDb().removeNotebookItem(input.notebookId, input.itemId),
  );

  // ---------- Creation Studio (Immutable AI vs Human Revisions) ----------

  ipc.handle("drafts:list", (_win, bookId?: string) => requireDb().listDrafts(bookId));

  ipc.handle("drafts:get", (_win, id: string) => requireDb().getDraft(id));

  ipc.handle(
    "drafts:create",
    (
      _win,
      input: {
        bookId?: string | null;
        title: string;
        kind: DraftKind;
        authorKind: RevisionAuthorKind;
        content: string;
        sourceHighlightIds?: string[];
        promptSummary?: string;
      },
    ) => requireDb().createDraft(input),
  );

  ipc.handle(
    "drafts:append-revision",
    (
      _win,
      input: {
        draftId: string;
        title?: string;
        authorKind: RevisionAuthorKind;
        content: string;
        sourceHighlightIds?: string[];
        promptSummary?: string;
      },
    ) => requireDb().appendDraftRevision(input),
  );

  ipc.handle("drafts:delete", (_win, id: string) => {
    requireDb().deleteDraft(id);
    return { deleted: true };
  });

  // ---------- Sandboxed Offline Reading Card Baker ----------

  ipc.handle("cards:templates", () => CARD_TEMPLATES);

  ipc.handle("cards:preview-html", (_win, payload: ReadingCardPayload) => ({
    html: renderReadingCardHtml(payload),
  }));

  ipc.handle("cards:bake-copy-png", async (_win, payload: ReadingCardPayload) => {
    if (!cardBaker) throw new Error("卡片渲染服务未就绪");
    const baked = await cardBaker.bakeCardToPng(payload);
    await clipboard.write([
      new ClipboardItem({
        "image/png": new Blob([new Uint8Array(baked.png)], { type: "image/png" }),
      }),
    ]);
    return {
      copied: true,
      width: baked.width,
      height: baked.height,
      bytes: baked.png.length,
    };
  });

  ipc.handle("cards:bake-save-png", async (win, payload: ReadingCardPayload) => {
    if (!cardBaker) throw new Error("卡片渲染服务未就绪");
    const baked = await cardBaker.bakeCardToPng(payload);
    const safeName = (payload.bookTitle || "reading-card")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
      .trim()
      .slice(0, 48);
    const saveRes = await dialog.showSaveDialog(win, {
      title: "保存高清书摘卡片 (PNG)",
      defaultPath: `${safeName || "reading-card"}-${payload.templateId}.png`,
      filters: [{ name: "PNG 图像", extensions: ["png"] }],
    });
    if (saveRes.canceled || !saveRes.filePath) {
      return { canceled: true as const };
    }
    fs.writeFileSync(saveRes.filePath, baked.png);
    return {
      canceled: false as const,
      filePath: saveRes.filePath,
      width: baked.width,
      height: baked.height,
      bytes: baked.png.length,
    };
  });

  ipc.handle(
    "cards:split-carousel",
    (
      _win,
      input: { title: string; bookTitle: string; author?: string; content: string; maxBodySlides?: number },
    ) => splitTextIntoCarouselSlides(input),
  );

  ipc.handle(
    "cards:bake-copy-carousel-slide",
    async (_win, input: { deck: CarouselDeckPayload; slideIndex: number }) => {
      if (!cardBaker) throw new Error("卡片渲染服务未就绪");
      const baked = await cardBaker.bakeCarouselSlideToPng(input.deck, input.slideIndex);
      await clipboard.write([
        new ClipboardItem({
          "image/png": new Blob([new Uint8Array(baked.png)], { type: "image/png" }),
        }),
      ]);
      return { copied: true, width: baked.width, height: baked.height, bytes: baked.png.length };
    },
  );

  ipc.handle("cards:bake-export-carousel-folder", async (win, deck: CarouselDeckPayload) => {
    if (!cardBaker) throw new Error("卡片渲染服务未就绪");
    if (!Array.isArray(deck.slides) || deck.slides.length === 0) {
      throw new Error("套卡内容为空");
    }
    const pick = await dialog.showOpenDialog(win, {
      title: "选择小红书多页套卡 PNG 批量导出目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (pick.canceled || !pick.filePaths[0]) {
      return { canceled: true as const };
    }
    const safeTitle = (deck.bookTitle || deck.slides[0]?.heading || "reading-deck")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
      .trim()
      .slice(0, 36);
    const outDir = path.join(pick.filePaths[0], `${safeTitle || "reading-deck"}-套卡`);
    fs.mkdirSync(outDir, { recursive: true });

    const files: string[] = [];
    for (let idx = 0; idx < deck.slides.length; idx++) {
      const slide = deck.slides[idx]!;
      const baked = await cardBaker.bakeCarouselSlideToPng(deck, idx);
      const label = slide.kind === "cover" ? "封面" : slide.kind === "outro" ? "尾页" : `正文${idx}`;
      const fileName = `${String(idx + 1).padStart(2, "0")}-${label}.png`;
      const fullPath = path.join(outDir, fileName);
      fs.writeFileSync(fullPath, baked.png);
      files.push(fileName);
    }
    return { canceled: false as const, folderPath: outDir, files };
  });

  ipc.handle("cards:bake-copy-poster", async (_win, payload: MonthlyPosterPayload) => {
    if (!cardBaker) throw new Error("卡片渲染服务未就绪");
    const baked = await cardBaker.bakePosterToPng(payload);
    await clipboard.write([
      new ClipboardItem({
        "image/png": new Blob([new Uint8Array(baked.png)], { type: "image/png" }),
      }),
    ]);
    return { copied: true, width: baked.width, height: baked.height, bytes: baked.png.length };
  });

  ipc.handle("cards:bake-save-poster", async (win, payload: MonthlyPosterPayload) => {
    if (!cardBaker) throw new Error("卡片渲染服务未就绪");
    const baked = await cardBaker.bakePosterToPng(payload);
    const safeMonth = (payload.monthLabel || "monthly").replace(/[^0-9a-zA-Z_-]+/g, "-");
    const saveRes = await dialog.showSaveDialog(win, {
      title: "保存高清阅读月报海报 (PNG)",
      defaultPath: `diandian-reading-poster-${safeMonth}.png`,
      filters: [{ name: "PNG 图像", extensions: ["png"] }],
    });
    if (saveRes.canceled || !saveRes.filePath) {
      return { canceled: true as const };
    }
    fs.writeFileSync(saveRes.filePath, baked.png);
    return {
      canceled: false as const,
      filePath: saveRes.filePath,
      width: baked.width,
      height: baked.height,
      bytes: baked.png.length,
    };
  });

  ipc.handle(
    "cards:extract-concept",
    (_win, input: { title: string; content: string; bookTitle?: string }) =>
      extractConceptVisualFromDraft(
        String(input?.title ?? ""),
        String(input?.content ?? ""),
        input?.bookTitle,
      ),
  );

  ipc.handle("cards:preview-concept-html", (_win, payload: ConceptVisualPayload) => ({
    html: renderConceptVisualHtml(payload),
  }));

  ipc.handle("cards:bake-copy-concept", async (_win, payload: ConceptVisualPayload) => {
    if (!cardBaker) throw new Error("视觉渲染服务未就绪");
    const baked = await cardBaker.bakeConceptVisualToPng(payload);
    await clipboard.write([
      new ClipboardItem({
        "image/png": new Blob([new Uint8Array(baked.png)], { type: "image/png" }),
      }),
    ]);
    return { copied: true, width: baked.width, height: baked.height, bytes: baked.png.length };
  });

  ipc.handle("cards:bake-save-concept", async (win, payload: ConceptVisualPayload) => {
    if (!cardBaker) throw new Error("视觉渲染服务未就绪");
    const baked = await cardBaker.bakeConceptVisualToPng(payload);
    const safeName = (payload.title || "visual").replace(/[^0-9a-zA-Z\u4e00-\u9fff_-]+/g, "-").slice(0, 28);
    const saveRes = await dialog.showSaveDialog(win, {
      title: "保存高清概念图 / 思维导图 (PNG)",
      defaultPath: `diandian-${payload.layout}-${safeName}.png`,
      filters: [{ name: "PNG 图像", extensions: ["png"] }],
    });
    if (saveRes.canceled || !saveRes.filePath) {
      return { canceled: true as const };
    }
    fs.writeFileSync(saveRes.filePath, baked.png);
    return {
      canceled: false as const,
      filePath: saveRes.filePath,
      width: baked.width,
      height: baked.height,
      bytes: baked.png.length,
    };
  });

  // ---------- Obsidian Vault Export & Deep Link ----------

  ipc.handle("obsidian:get-vault", () => ({ vaultPath: getObsidianVault() }));
  ipc.handle("obsidian:list-vaults", () => listObsidianVaults(app.getPath("appData")));

  ipc.handle("obsidian:set-vault", (_win, vaultPath: string) => {
    return { vaultPath: setObsidianVault(vaultPath) };
  });

  ipc.handle("obsidian:pick-vault", async (win) => {
    const res = await dialog.showOpenDialog(win, {
      title: "选择 Obsidian 笔记库文件夹",
      defaultPath: getObsidianVault() || app.getPath("documents"),
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || !res.filePaths[0]) {
      return { canceled: true as const, vaultPath: getObsidianVault() };
    }
    return { canceled: false as const, vaultPath: setObsidianVault(res.filePaths[0]) };
  });

  ipc.handle("obsidian:export-book", (_win, bookId: string) =>
    exportBookToObsidian(requireDb(), requireObsidianVault(), bookId),
  );

  ipc.handle("obsidian:export-draft", (_win, draftId: string) =>
    exportDraftToObsidian(requireDb(), requireObsidianVault(), draftId),
  );

  ipc.handle("obsidian:open-deep-link", async (_win, deepLink: string) => {
    const trimmed = String(deepLink ?? "").trim();
    if (!trimmed.startsWith("obsidian://open?")) {
      throw new Error("仅允许打开安全的 obsidian://open 深链接");
    }
    await shell.openExternal(trimmed);
    return { opened: true };
  });

  // ---------- Optional Book Router (heartleo/zlib CLI adapter) ----------

  const enrichConnectionsWithKindle = (snapshot: ConnectionsSnapshot): ConnectionsSnapshot => {
    const appKindle = kindleStore?.readPublic();
    if (appKindle?.configured) {
      return {
        ...snapshot,
        kindle: {
          configured: true,
          to: appKindle.to,
          from: appKindle.from,
          smtpHost: appKindle.smtpHost,
          smtpPort: String(appKindle.smtpPort),
          smtpSecurity: appKindle.smtpSecurity,
        },
      };
    }
    return snapshot;
  };

  ipc.handle("router:status", async () => {
    if (!zlibService) throw new Error("Router service unavailable");
    return zlibService.getStatus();
  });

  ipc.handle("router:connections", async () => {
    if (!zlibService) throw new Error("Router service unavailable");
    return enrichConnectionsWithKindle(await zlibService.getConnectionsSnapshot());
  });

  ipc.handle("router:set-domain", (_win, domain: string) => {
    if (!zlibService) throw new Error("Router service unavailable");
    const clean = zlibService.setPreferredDomain(domain);
    requireDb().setSetting("router.zlibDomain", clean);
    return { domain: clean };
  });

  ipc.handle("router:doctor", async () => {
    if (!zlibService) throw new Error("Router service unavailable");
    return zlibService.runDoctor();
  });

  ipc.handle("router:open-zlib-login", async (_win, domain?: string) => {
    if (!browserService || !zlibService) throw new Error("服务未就绪");
    let target = (domain ?? "").trim() || zlibService.getPreferredDomain();
    if (!target) {
      const domains = await zlibService.listHealthyDomains().catch(() => []);
      target = domains.find((d) => d.status === "healthy")?.domain || "https://z-lib.by";
    }
    const clean = zlibService.setPreferredDomain(target);
    requireDb().setSetting("router.zlibDomain", clean);
    await browserService.openUrl(clean, { newTab: false });
    return { openedUrl: clean };
  });

  ipc.handle("router:sync-zlib-from-browser", async (_win, preferredDomain?: string) => {
    if (!browserService || !zlibService) throw new Error("服务未就绪");
    const activeUrl = browserService.getActiveTabUrl();
    const candidateUrl = (preferredDomain ?? "").trim() || activeUrl || zlibService.getPreferredDomain();
    if (!candidateUrl || !/^https?:\/\//i.test(candidateUrl)) {
      throw new Error("请先在右侧浏览器打开并登录一个 Z-Library 镜像站点");
    }
    const origin = new URL(candidateUrl).origin;
    const cookies = await browserService.exportCookiesForOrigin(origin);
    const snapshot = enrichConnectionsWithKindle(await zlibService.loginZlibWithCookies(cookies, origin));
    requireDb().setSetting("router.zlibDomain", origin);
    return { origin, cookieCount: cookies.length, snapshot };
  });

  ipc.handle("router:login-zlib-cookie-file", async (win, domain?: string) => {
    if (!zlibService) throw new Error("Router service unavailable");
    const res = await dialog.showOpenDialog(win, {
      title: "选择 Z-Library Netscape cookies.txt 文件",
      properties: ["openFile"],
      filters: [{ name: "Netscape Cookie 文件", extensions: ["txt"] }],
    });
    if (res.canceled || !res.filePaths[0]) {
      return { canceled: true as const };
    }
    const snapshot = enrichConnectionsWithKindle(await zlibService.loginZlibWithCookieFile(res.filePaths[0], domain));
    if (snapshot.zlib.currentDomain) {
      requireDb().setSetting("router.zlibDomain", snapshot.zlib.currentDomain);
    }
    return { canceled: false as const, snapshot };
  });

  ipc.handle("router:start-weread-qr", () => {
    if (!zlibService) throw new Error("Router service unavailable");
    zlibService.startWeReadQrLogin((ev) => sendToMain("router:weread-qr", ev));
    return { started: true };
  });

  ipc.handle("router:cancel-weread-qr", () => {
    zlibService?.cancelWeReadQrLogin();
    return { canceled: true };
  });

  ipc.handle("router:logout-zlib", async () => {
    if (!zlibService) throw new Error("Router service unavailable");
    const snapshot = enrichConnectionsWithKindle(await zlibService.logoutZlib());
    return { snapshot };
  });

  ipc.handle("router:logout-weread", async () => {
    if (!zlibService) throw new Error("Router service unavailable");
    const snapshot = enrichConnectionsWithKindle(await zlibService.logoutWeRead());
    return { snapshot };
  });

  ipc.handle("router:get-kindle-config", async () => {
    if (!kindleStore) throw new Error("Kindle settings unavailable");
    const appCfg = kindleStore.readPublic();
    if (appCfg.to || appCfg.from || appCfg.smtpHost || appCfg.hasPassword) {
      return appCfg;
    }
    // Pre-populate non-secret defaults from zlib CLI if user previously ran terminal wizard
    if (zlibService) {
      try {
        const snap = await zlibService.getConnectionsSnapshot();
        if (snap.kindle.to || snap.kindle.from) {
          return {
            configured: false,
            to: snap.kindle.to,
            from: snap.kindle.from,
            smtpHost: snap.kindle.smtpHost || "smtp.qq.com",
            smtpPort: Number(snap.kindle.smtpPort) || 465,
            smtpSecurity: snap.kindle.smtpSecurity === "starttls" ? ("starttls" as const) : ("tls" as const),
            hasPassword: false,
          };
        }
      } catch {
        // Non-fatal
      }
    }
    return appCfg;
  });

  ipc.handle(
    "router:save-kindle-config",
    async (
      _win,
      input: {
        to?: string;
        from?: string;
        smtpHost?: string;
        smtpPort?: number;
        smtpSecurity?: KindleSmtpSecurity;
        password?: string;
        clearPassword?: boolean;
        clearAll?: boolean;
      },
    ) => {
      if (!kindleStore) throw new Error("Kindle settings unavailable");
      const config = input.clearAll
        ? kindleStore.clear()
        : kindleStore.save({
            to: String(input.to ?? ""),
            from: String(input.from ?? ""),
            smtpHost: String(input.smtpHost ?? ""),
            smtpPort: Number(input.smtpPort ?? 465),
            smtpSecurity: input.smtpSecurity === "starttls" ? "starttls" : "tls",
            password: typeof input.password === "string" ? input.password : undefined,
            clearPassword: input.clearPassword === true,
          });
      const snapshot = zlibService
        ? enrichConnectionsWithKindle(await zlibService.getConnectionsSnapshot())
        : null;
      return { config, snapshot };
    },
  );

  ipc.handle(
    "router:test-kindle-config",
    async (
      _win,
      input: {
        from: string;
        smtpHost: string;
        smtpPort: number;
        smtpSecurity: KindleSmtpSecurity;
        password?: string;
        useSavedPassword?: boolean;
      },
    ) => {
      const savedPass = input.useSavedPassword ? kindleStore?.readRaw().password ?? "" : "";
      const pass = (input.password ?? "").trim() || savedPass;
      return verifyKindleSmtp({
        from: String(input.from ?? ""),
        smtpHost: String(input.smtpHost ?? ""),
        smtpPort: Number(input.smtpPort ?? 465),
        smtpSecurity: input.smtpSecurity === "starttls" ? "starttls" : "tls",
        password: pass,
      });
    },
  );

  ipc.handle("router:open-kindle-config", async () => {
    if (!zlibService) throw new Error("Router service unavailable");
    return zlibService.openKindleConfigInTerminal();
  });

  ipc.handle(
    "router:search",
    async (_win, input: { query: string; format?: string; limit?: number; page?: number; order?: string }) => {
      if (!zlibService) throw new Error("Router service unavailable");
      return zlibService.search(input.query, {
        format: input.format,
        limit: input.limit,
        page: input.page,
        order: input.order,
      });
    },
  );

  ipc.handle("router:recommended", async (_win, input?: { forceRefresh?: boolean }) => {
    if (!zlibService) throw new Error("Router service unavailable");
    return zlibService.getRecommended(input?.forceRefresh === true);
  });

  ipc.handle("router:most-popular", async (_win, input?: { forceRefresh?: boolean }) => {
    if (!zlibService) throw new Error("Router service unavailable");
    return zlibService.getMostPopular(input?.forceRefresh === true);
  });

  ipc.handle("router:favorites", async (_win, input?: { forceRefresh?: boolean }) => {
    if (!zlibService) throw new Error("Router service unavailable");
    return zlibService.getFavorites(input?.forceRefresh === true);
  });

  ipc.handle("router:history", async (_win, input?: { forceRefresh?: boolean }) => {
    if (!zlibService) throw new Error("Router service unavailable");
    return zlibService.getHistory(input?.forceRefresh === true);
  });

  ipc.handle("router:download-history-page", async (_win, input: { page: number; forceRefresh?: boolean }) => {
    if (!zlibService) throw new Error("书源服务尚未就绪。");
    const history = await zlibService.getDownloadHistoryPage(input.page, input.forceRefresh === true);
    const localRefs = await downloadedCovers.localHistoryRefs(history.books);
    const books = history.books.map(book => {
      const format = book.extension.trim().toLowerCase().replace(/^\./, "");
      if (format && !BOOK_FILE_EXTENSIONS.includes(format)) {
        return { ...book, unavailableReason: `书库暂不支持 ${format.toUpperCase()} 格式` };
      }
      return book;
    });
    return { books, hasMore: history.hasMore, localRefs };
  });

  ipc.handle("router:download-history-book", (_win, input: { bookRef: string; hint?: DownloadCoverHint }) =>
    downloadedCovers.downloadHistoryBook(input.bookRef, input.hint));

  ipc.handle("router:download", async (_win, input: { bookRef: string; hint?: DownloadCoverHint }) => {
    return downloadedCovers.download(input.bookRef, input.hint);
  });

  ipc.handle("router:import-local-books", async (win, mode: "files" | "directory") => {
    if (!zlibService) throw new Error("本地书库尚未就绪。");
    if (mode !== "files" && mode !== "directory") throw new Error("无效的导入方式。");
    const choice = await dialog.showOpenDialog(win, mode === "files" ? {
      title: "选择要导入的电子书", buttonLabel: "导入", properties: ["openFile", "multiSelections"],
      filters: [{ name: "电子书", extensions: BOOK_FILE_EXTENSIONS }],
    } : { title: "选择包含电子书的文件夹", buttonLabel: "导入文件夹", properties: ["openDirectory"] });
    if (choice.canceled || !choice.filePaths.length) return importResult(true);
    return importSelectedBooks(zlibService.getDownloadDir(), mode, choice.filePaths, downloadedCovers);
  });

  ipc.handle("router:import-book-text", (_win, input: { title: string; text: string }) => {
    if (!zlibService) throw new Error("本地书库尚未就绪。");
    return importBookText(zlibService.getDownloadDir(), input, downloadedCovers);
  });

  ipc.handle("router:list-downloaded-books", () => {
    if (!zlibService) throw new Error("下载目录尚未就绪。");
    return listDownloadedBooks(zlibService.getDownloadDir());
  });

  ipc.handle("reader:open", (_win, filePath: string) => {
    if (!zlibService) throw new Error("下载目录尚未就绪。");
    return openReaderBook(requireDb(), zlibService.getDownloadDir(), filePath);
  });

  ipc.handle("reader:get-translation-settings", () => readerTranslationSettings.readPublic());
  ipc.handle("reader:save-translation-settings", (_win, input: ReaderTranslationSettingsInput) => readerTranslationSettings.save(input));
  ipc.handle("reader:open-deepl-portal", () => shell.openExternal("https://www.deepl.com/your-account/keys"));
  ipc.handle("reader:translate", (win, input: ReaderTranslationInput) => readerTranslations.translate(win.id, input));
  ipc.handle("reader:cached-translations", (_win, input: ReaderTranslationInput) => readerTranslations.readCached(input));
  ipc.handle("reader:cancel-translation", (win, requestId: string) => readerTranslations.cancel(win.id, requestId));

  ipc.handle("reader:save-location", (_win, documentId: string, cfi: string) =>
    requireDb().saveReaderLocation(documentId, cfi));

  ipc.handle("reader:add-annotation", (_win, input: ReaderAnnotationInput) =>
    requireDb().addReaderAnnotation(input));

  ipc.handle("reader:remove-annotation", (_win, documentId: string, highlightId: string) =>
    requireDb().removeReaderAnnotation(documentId, highlightId));

  ipc.handle("reader:resolve-highlight", (_win, id: string) => {
    if (!zlibService) throw new Error("下载目录尚未就绪。");
    return resolveReaderHighlight(requireDb(), zlibService.getDownloadDir(), id);
  });

  ipc.handle("router:get-downloaded-book-cover", async (_win, filePath: string) => {
    return downloadedCovers.preview(filePath);
  });

  ipc.handle("router:open-downloaded-book", async (_win, filePath: string) => {
    if (!zlibService) throw new Error("下载目录尚未就绪。");
    const book = await resolveDownloadedBook(zlibService.getDownloadDir(), filePath);
    const error = await shell.openPath(book);
    if (error) throw new Error(`打开电子书失败：${error}`);
  });

  ipc.handle("router:open-download-dir", async (_win, filePath?: string) => {
    if (!zlibService) throw new Error("Router service unavailable");
    const rootDir = path.resolve(zlibService.getDownloadDir());
    fs.mkdirSync(rootDir, { recursive: true });
    if (typeof filePath === "string" && filePath.trim()) {
      const candidate = path.resolve(filePath.trim());
      if (candidate.startsWith(rootDir + path.sep) && fs.existsSync(candidate)) {
        shell.showItemInFolder(candidate);
        return { opened: true, path: candidate };
      }
    }
    const err = await shell.openPath(rootDir);
    if (err) throw new Error(err);
    return { opened: true, path: rootDir };
  });

  ipc.handle("router:pick-ebook-file", async (win) => {
    const res = await dialog.showOpenDialog(win, {
      title: "选择本地电子书文件（EPUB / PDF / MOBI / AZW3）",
      properties: ["openFile"],
      filters: [{ name: "电子书文件", extensions: ROUTER_EBOOK_EXTENSIONS }],
    });
    if (res.canceled || !res.filePaths[0]) {
      return { canceled: true as const, filePath: "" };
    }
    return { canceled: false as const, filePath: res.filePaths[0] };
  });

  ipc.handle("router:send-kindle", async (_win, filePath: string) => {
    if (kindleStore?.readPublic().configured) {
      return sendBookViaKindleSmtp(kindleStore.readRaw(), filePath);
    }
    if (!zlibService) throw new Error("请先在「连接与偏好」完成 Kindle 推送配置");
    return zlibService.sendToKindle(filePath);
  });

  ipc.handle("router:import-weread", async (_win, filePath: string, options?: { fromLibrary?: boolean }) => {
    if (!zlibService) throw new Error("微信读书导入尚未就绪，请稍后重试。");
    return zlibService.importToWeRead(filePath, options);
  });

  ipc.handle("router:meta-read", async (_win, filePath: string) => {
    if (!zlibService) throw new Error("Router service unavailable");
    return zlibService.readLocalBookMeta(filePath);
  });

  ipc.handle("router:meta-fetch", async (_win, input: { filePath: string; sources?: string[] }) => {
    if (!zlibService) throw new Error("Router service unavailable");
    return zlibService.fetchLocalBookMetaMatches(input.filePath, input.sources);
  });

  ipc.handle(
    "router:meta-apply",
    async (
      _win,
      input: {
        filePath: string;
        title?: string;
        authors?: string;
        publisher?: string;
        isbn?: string;
        date?: string;
        language?: string;
        tags?: string;
        comments?: string;
        rename?: boolean;
      },
    ) => {
      if (!zlibService) throw new Error("Router service unavailable");
      const { filePath, ...patch } = input;
      const service = zlibService;
      return updateReaderMetadata(requireDb(), service.getDownloadDir(), filePath, file => service.applyLocalBookMeta(file, patch),
        (file, hash) => downloadedCovers.rememberCoverBeforeMetadataEdit(file, hash));
    },
  );

  // ---------- Floating Desktop Golden Retriever Pet ----------

  ipc.handle("pet:get-state", () =>
    petController?.getState() ?? { visible: false, expanded: false, mode: "collapsed", showJumpToMain: false },
  );

  ipc.handle("pet:toggle", async () => {
    if (!petController) throw new Error("Pet controller unavailable");
    const next = await petController.toggle();
    requireDb().setSetting("pet.enabled", next.visible ? "true" : "false");
    return next;
  });

  ipc.handle("pet:show", async () => {
    if (!petController) throw new Error("Pet controller unavailable");
    const next = await petController.show();
    requireDb().setSetting("pet.enabled", "true");
    return next;
  });

  ipc.handle("pet:hide", () => {
    if (!petController) throw new Error("Pet controller unavailable");
    const next = petController.hide();
    requireDb().setSetting("pet.enabled", "false");
    return next;
  });

  ipc.handle("pet:set-expanded", (_win, expanded: boolean) => {
    if (!petController) throw new Error("Pet controller unavailable");
    return petController.setExpanded(Boolean(expanded));
  });

  ipc.handle("pet:set-mode", (_win, mode: PetWindowMode) => {
    if (!petController) throw new Error("Pet controller unavailable");
    if (mode !== "collapsed" && mode !== "nudge" && mode !== "expanded") {
      throw new Error("不支持的桌宠窗口模式");
    }
    return petController.setMode(mode);
  });

  ipc.handle("pet:get-recall-muted-today", () => {
    const today = new Date().toISOString().slice(0, 10);
    return { muted: requireDb().getSetting("pet.recallMutedDate") === today };
  });

  ipc.handle("pet:mute-recall-today", () => {
    const today = new Date().toISOString().slice(0, 10);
    requireDb().setSetting("pet.recallMutedDate", today);
    return { muted: true };
  });

  ipc.handle(
    "pet:send-to-draft",
    async (_win, payload: { quote: string; comment?: string; bookTitle?: string; author?: string }) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      } else {
        await createMainWindow();
      }
      sendToMain("app:quick-action", {
        kind: "draft",
        text: payload.quote,
        comment: payload.comment ?? "",
        title: payload.bookTitle ?? "",
        author: payload.author ?? "",
      });
      return { sent: true };
    },
  );

  ipc.on("pet:move-by", (_win, delta: { dx: number; dy: number }) => {
    petController?.moveBy(Number(delta?.dx ?? 0), Number(delta?.dy ?? 0));
  });

  ipc.on("pet:drag-start", (_win, pos: { screenX: number; screenY: number }) => {
    petController?.startDrag(Number(pos?.screenX), Number(pos?.screenY));
  });

  ipc.on("pet:drag-move", (_win, pos: { screenX: number; screenY: number }) => {
    petController?.dragTo(Number(pos?.screenX), Number(pos?.screenY));
  });

  ipc.on("pet:drag-end", () => {
    petController?.endDrag();
  });

  ipc.handle("pet:focus-main", async () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      return { focused: true };
    }
    await createMainWindow();
    return { focused: true };
  });
}

function resolveAppIconPath(): string | undefined {
  const candidates = [
    path.join(__dirname, "assets", "icon.png"),
    path.resolve(__dirname, "..", "build", "icons", "icon.png"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

const APP_DISPLAY_NAME = "点点读书";
/** A menu command chosen while no renderer was listening; the renderer takes it once it subscribes. */
let pendingMenuAction: AppMenuAction | null = null;

function installAppMenu(): void {
  const iconPath = resolveAppIconPath();
  app.setAboutPanelOptions({
    applicationName: APP_DISPLAY_NAME,
    applicationVersion: app.getVersion(),
    website: APP_REPO_URL,
    ...(iconPath ? { iconPath } : {}),
  });
  const template = buildAppMenuTemplate({
    appName: APP_DISPLAY_NAME,
    isMac: process.platform === "darwin",
    developerTools: !app.isPackaged,
    sendAction: (action: AppMenuAction) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
        // A window that is still loading has not subscribed yet; hand the command over later.
        if (mainWindow.webContents.isLoading()) pendingMenuAction = action;
        else sendToMain("app:menu-action", { action });
      } else {
        pendingMenuAction = action;
        void createMainWindow();
      }
    },
    openExternal: (url) => {
      void shell.openExternal(url);
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createMainWindow(): Promise<void> {
  const entryUrl = resolveAppEntryUrl();
  const appIconPath = resolveAppIconPath();
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1020,
    minHeight: 680,
    title: "点点读书 · diandianreading",
    ...(appIconPath ? { icon: appIconPath } : {}),
    backgroundColor: "#f7f4ee",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow = win;
  const windowId = win.id;
  win.webContents.on("did-start-navigation", (event) => {
    if (event.isMainFrame && !event.isSameDocument) readerTranslations.cancelWindow(windowId);
  });
  win.once("closed", () => readerTranslations.cancelWindow(windowId));
  ipc.registerWindow(win, entryUrl);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // The workspace page never navigates away; external pages open in the embedded browser instead.
  win.webContents.on("will-navigate", (event) => {
    if (!matchesTrustedAppUrl(event.url, entryUrl)) event.preventDefault();
  });

  win.on("focus", () => {
    if (blurCheckTimer) {
      clearTimeout(blurCheckTimer);
      blurCheckTimer = null;
    }
    mainWindowActiveForPet = true;
    syncPetMainContext();
  });
  win.on("blur", () => scheduleAppFocusCheck());
  win.on("show", () => {
    mainWindowActiveForPet = true;
    syncPetMainContext();
  });
  win.on("restore", () => {
    mainWindowActiveForPet = true;
    syncPetMainContext();
  });
  win.on("minimize", () => {
    mainWindowActiveForPet = false;
    syncPetMainContext();
  });
  win.on("hide", () => {
    mainWindowActiveForPet = false;
    syncPetMainContext();
  });
  win.on("move", () => syncPetMainContext());
  win.on("resize", () => syncPetMainContext());

  win.on("closed", () => {
    browserMenuController?.dispose();
    browserService?.dispose();
    mainWindow = null;
    mainWindowActiveForPet = false;
    syncPetMainContext();
    if (process.platform !== "darwin") {
      petController?.dispose();
    }
  });

  await win.loadURL(entryUrl);
  browserService?.initialize(DEFAULT_READING_URL);
  mainWindowActiveForPet = true;
  syncPetMainContext();
}

async function handleBridgeRequest(req: { path: string; body: Record<string, unknown> }): Promise<unknown> {
  // Real-time token streaming channel from diandian-live-stream Cordis plugin
  if (req.path === "/agent/stream") {
    const streamRole = req.body.streamRole === "reasoning" ? "reasoning" : "assistant";
    const text = typeof req.body.text === "string" ? req.body.text : "";
    const sessionId = typeof req.body.sessionId === "string" ? req.body.sessionId : null;
    if (text) {
      sendToAll("agent:event", {
        kind: "stream",
        streamRole,
        text,
        sessionId,
      });
    }
    return { accepted: true };
  }

  // Browser routes
  if (req.path === "/browser/state") {
    if (!browserService) throw new BridgeRejection("内置浏览器服务未就绪", 503);
    return browserService.getState();
  }
  if (req.path === "/browser/read") {
    if (!browserService) throw new BridgeRejection("内置浏览器服务未就绪", 503);
    const maxChars = typeof req.body.maxChars === "number" ? req.body.maxChars : undefined;
    const tabId = typeof req.body.tabId === "string" ? req.body.tabId : undefined;
    return browserService.readPageContent({ maxChars, tabId });
  }
  if (req.path === "/browser/open") {
    if (!browserService) throw new BridgeRejection("内置浏览器服务未就绪", 503);
    const url = typeof req.body.url === "string" ? req.body.url : undefined;
    const newTab = req.body.newTab === true;
    return browserService.openUrl(url, { newTab });
  }
  if (req.path === "/browser/navigate") {
    if (!browserService) throw new BridgeRejection("内置浏览器服务未就绪", 503);
    const action = req.body.action;
    if (
      action !== "back"
      && action !== "forward"
      && action !== "reload"
      && action !== "home"
      && action !== "weread"
    ) {
      throw new BridgeRejection("不支持的浏览器导航动作", 400);
    }
    return browserService.navigate(action);
  }

  // Library routes
  const db = requireDb();
  if (req.path === "/library/books/list") {
    const query = typeof req.body.query === "string" ? req.body.query : "";
    return { books: db.listBooks(query) };
  }
  if (req.path === "/library/highlights/list") {
    const bookId = typeof req.body.bookId === "string" ? req.body.bookId : "";
    if (!bookId) throw new BridgeRejection("缺少 bookId", 400);
    const query = typeof req.body.query === "string" ? req.body.query : "";
    return { book: db.getBook(bookId), highlights: db.listHighlights(bookId, query) };
  }
  if (req.path === "/library/highlights/search") {
    const query = typeof req.body.query === "string" ? req.body.query : "";
    const limit = typeof req.body.limit === "number" ? req.body.limit : 20;
    return { results: db.searchAllHighlights(query, Math.min(50, Math.max(1, limit))) };
  }
  if (req.path === "/library/highlights/save") {
    const bookTitle = typeof req.body.bookTitle === "string" ? req.body.bookTitle.trim() : "";
    const quote = typeof req.body.quote === "string" ? req.body.quote.trim() : "";
    if (!bookTitle || !quote) throw new BridgeRejection("bookTitle 与 quote 不能为空", 400);
    const book = db.findOrCreateBook({
      title: bookTitle,
      author: typeof req.body.author === "string" ? req.body.author : "",
      source: "manual",
    });
    const added = db.addHighlight({
      bookId: book.id,
      chapter: typeof req.body.chapter === "string" ? req.body.chapter : "",
      quote,
      note: typeof req.body.note === "string" ? req.body.note : "",
      source: "manual",
    });
    return { book, highlight: added.record, deduplicated: added.deduplicated };
  }

  // Draft routes (AI always creates or appends an immutable 'ai' revision)
  if (req.path === "/drafts/list") {
    const bookId = typeof req.body.bookId === "string" && req.body.bookId ? req.body.bookId : undefined;
    return { drafts: db.listDrafts(bookId) };
  }
  if (req.path === "/drafts/ai-save") {
    const draftId = typeof req.body.draftId === "string" && req.body.draftId.trim() ? req.body.draftId.trim() : "";
    const title = typeof req.body.title === "string" ? req.body.title.trim() : "";
    const content = typeof req.body.content === "string" ? req.body.content.trim() : "";
    const promptSummary = typeof req.body.promptSummary === "string" ? req.body.promptSummary : "";
    if (!content) throw new BridgeRejection("草稿内容不能为空", 400);
    if (draftId) {
      const updated = db.appendDraftRevision({
        draftId,
        title: title || undefined,
        authorKind: "ai",
        content,
        promptSummary,
      });
      return { action: "revised", draft: updated };
    }
    if (!title) throw new BridgeRejection("新建草稿必须提供 title", 400);
    const rawKind = req.body.kind;
    const kind: DraftKind =
      rawKind === "review" || rawKind === "card_copy" || rawKind === "thread" || rawKind === "script" || rawKind === "note"
        ? rawKind
        : "review";
    const bookId = typeof req.body.bookId === "string" && req.body.bookId.trim() ? req.body.bookId.trim() : null;
    const created = db.createDraft({
      bookId,
      title,
      kind,
      authorKind: "ai",
      content,
      promptSummary,
    });
    return { action: "created", draft: created };
  }

  // Obsidian export routes
  if (req.path === "/obsidian/export-book") {
    const bookId = typeof req.body.bookId === "string" ? req.body.bookId.trim() : "";
    if (!bookId) throw new BridgeRejection("缺少 bookId", 400);
    return exportBookToObsidian(db, requireObsidianVault(), bookId);
  }
  if (req.path === "/obsidian/export-draft") {
    const draftId = typeof req.body.draftId === "string" ? req.body.draftId.trim() : "";
    if (!draftId) throw new BridgeRejection("缺少 draftId", 400);
    return exportDraftToObsidian(db, requireObsidianVault(), draftId);
  }

  // Optional router routes
  if (req.path === "/router/status") {
    if (!zlibService) throw new BridgeRejection("电子书路由服务未就绪", 503);
    return zlibService.getStatus();
  }
  if (req.path === "/router/search") {
    if (!zlibService) throw new BridgeRejection("电子书路由服务未就绪", 503);
    const query = typeof req.body.query === "string" ? req.body.query : "";
    const format = typeof req.body.format === "string" ? req.body.format : undefined;
    const limit = typeof req.body.limit === "number" ? req.body.limit : 8;
    return { items: await zlibService.search(query, { format, limit }) };
  }

  throw new BridgeRejection(`未注册的桥接路由: ${req.path}`, 404);
}

async function handleBrowserSelectionAction(ev: BrowserSelectionActionEvent): Promise<void> {
  const cleanTitle = cleanPageBookTitle(ev.title);
  if (ev.action === "save") {
    const db = requireDb();
    const source: BookSource = ev.url.includes("weread.qq.com") ? "weread" : "manual";
    const book = db.findOrCreateBook({ title: cleanTitle, source, sourceLocator: ev.url });
    const added = db.addHighlight({
      bookId: book.id,
      chapter: ev.title,
      quote: ev.text,
      source,
    });
    sendToMain("app:quick-action", {
      kind: "saved",
      text: ev.text,
      title: book.title,
      deduplicated: added.deduplicated,
    });
    return;
  }

  if (ev.action === "draft") {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
    sendToMain("app:quick-action", {
      kind: "draft",
      text: ev.text,
      title: cleanTitle,
      url: ev.url,
    });
    return;
  }

  if (ev.action === "ask") {
    if (petController) {
      await petController.show();
      petController.setMode("expanded");
      const petWin = petController.getWindow();
      if (petWin && !petWin.isDestroyed()) {
        petWin.webContents.send("pet:quick-quote", {
          text: ev.text,
          title: cleanTitle,
          url: ev.url,
          source: "selection",
        });
      }
    } else {
      sendToMain("app:quick-action", {
        kind: "ask",
        text: ev.text,
        title: cleanTitle,
        url: ev.url,
      });
    }
  }
}

async function handleGlobalShortcutSummon(): Promise<void> {
  let quoteText = "";
  let sourceTitle = "剪贴板摘录";

  // Prefer active selection inside our right-hand browser if available.
  if (browserService) {
    try {
      const snap = await browserService.readPageContent({ maxChars: 1200 });
      if (snap.selection && snap.selection.trim().length >= 3) {
        quoteText = snap.selection.trim();
        sourceTitle = cleanPageBookTitle(snap.title);
      }
    } catch {
      // Fallback to OS clipboard.
    }
  }

  if (!quoteText) {
    try {
      quoteText = (await clipboard.readText()).trim().slice(0, 3000);
    } catch {
      quoteText = "";
    }
  }

  if (petController) {
    await petController.show();
    petController.setMode("expanded");
    const petWin = petController.getWindow();
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send("pet:quick-quote", {
        text: quoteText,
        title: sourceTitle,
        source: "shortcut",
      });
    }
  }
}

async function bootstrap(): Promise<void> {
  const userDataDir = process.env.DIANDIAN_USER_DATA_DIR || app.getPath("userData");
  settingsStore = new ModelSettingsStore(userDataDir, safeStorage);
  kindleStore = new KindleSettingsStore(userDataDir, safeStorage);
  safetyStore = new SafetyModeStore(userDataDir);
  knowledgeDb = new KnowledgeDatabase(path.join(userDataDir, "state", "diandian.sqlite3"));
  readerTranslationSettings = new ReaderTranslationSettingsStore(knowledgeDb, safeStorage);
  readerTranslations = new ReaderTranslationService(knowledgeDb, () => settingsStore!.readRaw(), fetch, () => readerTranslationSettings.readDeepLKey());
  bookCovers = new BookCoverCache(userDataDir);
  twinStore = new TwinStore(userDataDir);
  cardBaker = new CardBakerService();
  cardBaker.installProtocol();
  zlibService = new ZlibCliService(path.join(app.getPath("downloads"), "diandianreading"));
  downloadedCovers = new DownloadedBookCovers(zlibService, bookCovers, knowledgeDb);
  const savedZlibDomain = knowledgeDb.getSetting("router.zlibDomain");
  if (savedZlibDomain) {
    try {
      zlibService.setPreferredDomain(savedZlibDomain);
    } catch {
      // Ignore stale invalid domain.
    }
  }

  browserService = new BrowserService(
    () => mainWindow,
    (snapshot) => sendToMain("browser:state", snapshot),
    userDataDir,
    (selectionEv) => {
      void handleBrowserSelectionAction(selectionEv);
    },
  );

  browserMenuController = new BrowserMenuWindowController({
    preloadPath: resolvePetPreloadPath(__dirname),
    getEntryUrl: resolveAppEntryUrl,
    getParentWindow: () => mainWindow,
    ipc,
    onAction: (action) => sendToMain("browser-menu:main-action", action),
  });

  bridgeServer = new LocalBridgeServer((req) => handleBridgeRequest(req));
  const endpoint = await bridgeServer.start();

  supervisor = new AgentSupervisor({
    userDataDir,
    projectRoot: resolveProjectRoot(),
    bridgeEndpoint: endpoint,
    bridgeToken: bridgeServer.token,
    twinDir: twinStore.twinDir,
    safetyStateFile: safetyStore.stateFilePath,
    getSettings: () => settingsStore!.readRaw(),
    onEvent: (event) => sendToAll("agent:event", event),
  });

  petController = new PetWindowController({
    preloadPath: resolvePetPreloadPath(__dirname),
    getEntryUrl: resolveAppEntryUrl,
    ipc,
    getSavedAnchor: () => {
      const raw = knowledgeDb?.getSetting("pet.anchor");
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as { right?: unknown; bottom?: unknown };
        if (typeof parsed.right === "number" && typeof parsed.bottom === "number") {
          return { right: parsed.right, bottom: parsed.bottom };
        }
      } catch {
        // Ignore malformed saved anchor.
      }
      return null;
    },
    saveAnchor: (anchor) => {
      knowledgeDb?.setSetting("pet.anchor", JSON.stringify(anchor));
    },
    onStateChanged: (state) => sendToAll("pet:state", state),
  });

  wireIpcHandlers();
  await createMainWindow();

  app.on("browser-window-blur", () => {
    scheduleAppFocusCheck();
  });

  const petEnabled = knowledgeDb.getSetting("pet.enabled");
  if (petEnabled !== "false") {
    void petController.show().then(() => syncPetMainContext());
  }

  // Global shortcut: Cmd+Shift+D summons the floating golden retriever with active selection / clipboard.
  try {
    globalShortcut.register("CommandOrControl+Shift+D", () => {
      void handleGlobalShortcutSummon();
    });
  } catch {
    // Non-fatal if another app owns the shortcut.
  }
}

app.whenReady().then(() => {
  // A packaged app already carries its icns; only the development Electron needs the brand icon.
  if (process.platform === "darwin" && app.dock && !app.isPackaged) {
    const dockIcon = resolveAppIconPath();
    if (dockIcon) app.dock.setIcon(dockIcon);
  }
  installAppMenu();
  void bootstrap();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("before-quit", () => {
  browserMenuController?.dispose();
  petController?.dispose();
  browserService?.dispose();
  zlibService?.dispose();
  knowledgeDb?.close();
  void supervisor?.dispose();
  void bridgeServer?.stop();
});
