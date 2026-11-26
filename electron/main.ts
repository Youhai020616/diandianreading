import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, clipboard, globalShortcut, Menu, safeStorage, shell } from "electron";
import { BridgeRejection, LocalBridgeServer } from "./agent/bridgeServer";
import { AgentSupervisor } from "./agent/supervisor";
import { APP_REPO_URL, buildAppMenuTemplate, type AppMenuAction } from "./appMenu";
import { BrowserMenuWindowController } from "./browser/browserMenuWindow";
import { BrowserService } from "./browser/browserService";
import type { BrowserSelectionActionEvent } from "./browser/selectionOverlay";
import { DEFAULT_READING_URL } from "./browser/startPage";
import { CardBakerService, registerCardPrivilegedSchemes } from "./cards/cardBaker";
import { exportBookToObsidian, exportDraftToObsidian } from "./export/obsidianExporter";
import { PetWindowController, resolvePetPreloadPath } from "./pet/petWindow";
import { KindleSettingsStore } from "./router/kindleSmtpService";
import { DownloadedBookCovers } from "./router/downloadedBookCovers";
import { ReaderTranslationService } from "./router/readerTranslation";
import { ZlibCliService } from "./router/zlibCliService";
import { SafetyModeStore } from "./security/safetyPolicy";
import { ModelSettingsStore } from "./security/secretStore";
import { ReaderTranslationSettingsStore } from "./security/readerTranslationSettings";
import { matchesTrustedAppUrl } from "./security/urlMatch";
import { revealWhenActivated, shouldStartHidden, watchAgentSources } from "./devReload";
import { BookCoverCache } from "./storage/bookCoverCache";
import { KnowledgeDatabase, type BookSource, type DraftKind } from "./storage/database";
import { TwinStore } from "./twin/twinStore";

import { registerAppIpc } from "./ipc/appIpc";
import { registerSettingsIpc } from "./ipc/settingsIpc";
import { registerTwinIpc } from "./ipc/twinIpc";
import { registerBrowserIpc } from "./ipc/browserIpc";
import { registerAgentIpc } from "./ipc/agentIpc";
import { registerLibraryIpc } from "./ipc/libraryIpc";
import { registerNotebookIpc } from "./ipc/notebookIpc";
import { registerStudioIpc } from "./ipc/studioIpc";
import { registerCardsIpc } from "./ipc/cardsIpc";
import { registerObsidianIpc } from "./ipc/obsidianIpc";
import { registerRouterIpc } from "./ipc/routerIpc";
import { registerPetIpc } from "./ipc/petIpc";
import {
  hooks,
  state,
  syncPetMainContext,
  scheduleAppFocusCheck,
  ipc,
  resolveAppEntryUrl,
  resolveProjectRoot,
  sendToMain,
  sendToAll,
  cleanPageBookTitle,
  requireDb,
  requireObsidianVault,
} from "./appState";

// Must run synchronously before app.whenReady().
registerCardPrivilegedSchemes();
hooks.createMainWindow = createMainWindow;

function wireIpcHandlers(): void {
  registerAppIpc();
  registerSettingsIpc();
  registerTwinIpc();
  registerBrowserIpc();
  registerAgentIpc();
  registerLibraryIpc();
  registerNotebookIpc();
  registerStudioIpc();
  registerCardsIpc();
  registerObsidianIpc();
  registerRouterIpc();
  registerPetIpc();
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
      if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        if (state.mainWindow.isMinimized()) state.mainWindow.restore();
        state.mainWindow.show();
        state.mainWindow.focus();
        // A window that is still loading has not subscribed yet; hand the command over later.
        if (state.mainWindow.webContents.isLoading()) state.pendingMenuAction = action;
        else sendToMain("app:menu-action", { action });
      } else {
        state.pendingMenuAction = action;
        void createMainWindow();
      }
    },
    openExternal: (url) => {
      void shell.openExternal(url);
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createMainWindow(options: { hidden?: boolean } = {}): Promise<void> {
  const entryUrl = resolveAppEntryUrl();
  const appIconPath = resolveAppIconPath();
  const win = new BrowserWindow({
    show: !options.hidden,
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

  state.mainWindow = win;
  const windowId = win.id;
  win.webContents.on("did-start-navigation", (event) => {
    if (event.isMainFrame && !event.isSameDocument) state.readerTranslations.cancelWindow(windowId);
  });
  win.once("closed", () => state.readerTranslations.cancelWindow(windowId));
  ipc.registerWindow(win, entryUrl);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // The workspace page never navigates away; external pages open in the embedded browser instead.
  win.webContents.on("will-navigate", (event) => {
    if (!matchesTrustedAppUrl(event.url, entryUrl)) event.preventDefault();
  });

  win.on("focus", () => {
    if (state.blurCheckTimer) {
      clearTimeout(state.blurCheckTimer);
      state.blurCheckTimer = null;
    }
    state.mainWindowActiveForPet = true;
    syncPetMainContext();
  });
  win.on("blur", () => scheduleAppFocusCheck());
  win.on("show", () => {
    state.mainWindowActiveForPet = true;
    syncPetMainContext();
  });
  win.on("restore", () => {
    state.mainWindowActiveForPet = true;
    syncPetMainContext();
  });
  win.on("minimize", () => {
    state.mainWindowActiveForPet = false;
    syncPetMainContext();
  });
  win.on("hide", () => {
    state.mainWindowActiveForPet = false;
    syncPetMainContext();
  });
  win.on("move", () => syncPetMainContext());
  win.on("resize", () => syncPetMainContext());

  win.on("closed", () => {
    state.browserMenuController?.dispose();
    state.browserService?.dispose();
    state.mainWindow = null;
    state.mainWindowActiveForPet = false;
    syncPetMainContext();
    if (process.platform !== "darwin") {
      state.petController?.dispose();
    }
  });

  await win.loadURL(entryUrl);
  state.browserService?.initialize(DEFAULT_READING_URL);
  state.mainWindowActiveForPet = true;
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
    if (!state.browserService) throw new BridgeRejection("内置浏览器服务未就绪", 503);
    return state.browserService.getState();
  }
  if (req.path === "/browser/read") {
    if (!state.browserService) throw new BridgeRejection("内置浏览器服务未就绪", 503);
    const maxChars = typeof req.body.maxChars === "number" ? req.body.maxChars : undefined;
    const tabId = typeof req.body.tabId === "string" ? req.body.tabId : undefined;
    return state.browserService.readPageContent({ maxChars, tabId });
  }
  if (req.path === "/browser/open") {
    if (!state.browserService) throw new BridgeRejection("内置浏览器服务未就绪", 503);
    const url = typeof req.body.url === "string" ? req.body.url : undefined;
    const newTab = req.body.newTab === true;
    return state.browserService.openUrl(url, { newTab });
  }
  if (req.path === "/browser/navigate") {
    if (!state.browserService) throw new BridgeRejection("内置浏览器服务未就绪", 503);
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
    return state.browserService.navigate(action);
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
    if (!state.zlibService) throw new BridgeRejection("电子书路由服务未就绪", 503);
    return state.zlibService.getStatus();
  }
  if (req.path === "/router/search") {
    if (!state.zlibService) throw new BridgeRejection("电子书路由服务未就绪", 503);
    const query = typeof req.body.query === "string" ? req.body.query : "";
    const format = typeof req.body.format === "string" ? req.body.format : undefined;
    const limit = typeof req.body.limit === "number" ? req.body.limit : 8;
    return { items: await state.zlibService.search(query, { format, limit }) };
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
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.show();
      state.mainWindow.focus();
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
    if (state.petController) {
      await state.petController.show();
      state.petController.setMode("expanded");
      const petWin = state.petController.getWindow();
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
  if (state.browserService) {
    try {
      const snap = await state.browserService.readPageContent({ maxChars: 1200 });
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

  if (state.petController) {
    await state.petController.show();
    state.petController.setMode("expanded");
    const petWin = state.petController.getWindow();
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
  state.settingsStore = new ModelSettingsStore(userDataDir, safeStorage);
  state.kindleStore = new KindleSettingsStore(userDataDir, safeStorage);
  state.safetyStore = new SafetyModeStore(userDataDir);
  state.knowledgeDb = new KnowledgeDatabase(path.join(userDataDir, "state", "diandian.sqlite3"));
  state.readerTranslationSettings = new ReaderTranslationSettingsStore(state.knowledgeDb, safeStorage);
  state.readerTranslations = new ReaderTranslationService(state.knowledgeDb, () => state.settingsStore!.readRaw(), fetch, () => state.readerTranslationSettings.readDeepLKey());
  state.bookCovers = new BookCoverCache(userDataDir);
  state.twinStore = new TwinStore(userDataDir);
  state.cardBaker = new CardBakerService();
  state.cardBaker.installProtocol();
  state.zlibService = new ZlibCliService(path.join(app.getPath("downloads"), "diandianreading"));
  state.downloadedCovers = new DownloadedBookCovers(state.zlibService, state.bookCovers, state.knowledgeDb);
  const savedZlibDomain = state.knowledgeDb.getSetting("router.zlibDomain");
  if (savedZlibDomain) {
    try {
      state.zlibService.setPreferredDomain(savedZlibDomain);
    } catch {
      // Ignore stale invalid domain.
    }
  }

  state.browserService = new BrowserService(
    () => state.mainWindow,
    (snapshot) => sendToMain("browser:state", snapshot),
    userDataDir,
    (selectionEv) => {
      void handleBrowserSelectionAction(selectionEv);
    },
  );

  state.browserMenuController = new BrowserMenuWindowController({
    preloadPath: resolvePetPreloadPath(__dirname),
    getEntryUrl: resolveAppEntryUrl,
    getParentWindow: () => state.mainWindow,
    ipc,
    onAction: (action) => sendToMain("browser-menu:main-action", action),
  });

  state.bridgeServer = new LocalBridgeServer((req) => handleBridgeRequest(req));
  const endpoint = await state.bridgeServer.start();

  state.supervisor = new AgentSupervisor({
    userDataDir,
    projectRoot: resolveProjectRoot(),
    packaged: app.isPackaged,
    bridgeEndpoint: endpoint,
    bridgeToken: state.bridgeServer.token,
    twinDir: state.twinStore.twinDir,
    safetyStateFile: state.safetyStore.stateFilePath,
    getSettings: () => state.settingsStore!.readRaw(),
    onEvent: (event) => sendToAll("agent:event", event),
  });

  state.petController = new PetWindowController({
    preloadPath: resolvePetPreloadPath(__dirname),
    getEntryUrl: resolveAppEntryUrl,
    ipc,
    getSavedAnchor: () => {
      const raw = state.knowledgeDb?.getSetting("pet.anchor");
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
      state.knowledgeDb?.setSetting("pet.anchor", JSON.stringify(anchor));
    },
    onStateChanged: (state) => sendToAll("pet:state", state),
  });

  wireIpcHandlers();
  const startHidden = shouldStartHidden();
  await createMainWindow({ hidden: startHidden });
  if (!app.isPackaged) {
    watchAgentSources(resolveProjectRoot(), () => {
      console.log("[dev] agent plugins changed; the agent engine reloads in place");
      state.supervisor?.reloadForCodeChange();
    });
  }

  app.on("browser-window-blur", () => {
    scheduleAppFocusCheck();
  });

  const petEnabled = state.knowledgeDb.getSetting("pet.enabled");
  const showPet = () => {
    if (petEnabled !== "false") void state.petController?.show().then(() => syncPetMainContext());
  };
  if (startHidden) {
    revealWhenActivated(() => {
      state.mainWindow?.show();
      showPet();
    });
  } else {
    showPet();
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
  state.browserMenuController?.dispose();
  state.petController?.dispose();
  state.browserService?.dispose();
  state.zlibService?.dispose();
  state.knowledgeDb?.close();
  void state.supervisor?.dispose();
  void state.bridgeServer?.stop();
});
