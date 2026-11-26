import { contextBridge, ipcRenderer } from "electron";
import type { ReaderTranslationInput, ReaderTranslationSettingsInput } from "../src/types/desktop";
import type { DownloadCoverHint, ReaderAnnotationInput } from "../src/types/desktop";
import type {
  AgentEvent, AppMenuActionEvent, AppQuickActionEvent, BrowserStateSnapshot, CarouselDeckPayload, ConceptVisualPayload,
  DesktopBridgeApi, MonthlyPosterPayload, PetQuickQuoteEvent, PetWindowState, ReadingCardPayload, WeReadQrEvent,
} from "../src/types/desktop";

const desktopApi = {
  app: {
    info: () => ipcRenderer.invoke("app:info"),
    setTheme: (theme: "light" | "dark") => ipcRenderer.invoke("app:set-theme", theme),
    onThemeChanged: (callback: (payload: { theme: "light" | "dark" }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { theme: "light" | "dark" }) => callback(payload);
      ipcRenderer.on("app:theme-changed", listener);
      return () => {
        ipcRenderer.removeListener("app:theme-changed", listener);
      };
    },
    onQuickAction: (callback: (payload: AppQuickActionEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: AppQuickActionEvent) => callback(payload);
      ipcRenderer.on("app:quick-action", listener);
      return () => {
        ipcRenderer.removeListener("app:quick-action", listener);
      };
    },
    onMenuAction: (callback: (payload: AppMenuActionEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: AppMenuActionEvent) => callback(payload);
      ipcRenderer.on("app:menu-action", listener);
      // Deliver a command chosen while this window was still opening or loading.
      void ipcRenderer.invoke("app:take-menu-action").then((payload) => {
        if (payload) callback(payload);
      }).catch(() => undefined);
      return () => {
        ipcRenderer.removeListener("app:menu-action", listener);
      };
    },
  },
  settings: {
    getModel: () => ipcRenderer.invoke("settings:get-model"),
    listModels: () => ipcRenderer.invoke("settings:list-models"),
    saveModel: (input: {
      provider: "deepseek" | "openai-compatible";
      model: string;
      baseUrl: string;
      apiKey?: string;
      clearApiKey?: boolean;
      allowPlaintextKey?: boolean;
    }) => ipcRenderer.invoke("settings:save-model", input),
    testModel: (input: {
      baseUrl: string;
      model: string;
      apiKey?: string;
      useSavedKey?: boolean;
    }) => ipcRenderer.invoke("settings:test-model", input),
    openKeyPortal: (presetId: string) => ipcRenderer.invoke("settings:open-key-portal", presetId),
  },
  safety: {
    getMode: () => ipcRenderer.invoke("safety:get-mode"),
    setMode: (mode: "plan" | "confirm" | "auto") => ipcRenderer.invoke("safety:set-mode", mode),
  },
  twin: {
    get: () => ipcRenderer.invoke("twin:get"),
    save: (input: { profileMd?: string; styleMd?: string }) => ipcRenderer.invoke("twin:save", input),
    distillDiff: (draftId: string) => ipcRenderer.invoke("twin:distill-diff", { draftId }),
    acceptStyleRules: (rules: string[]) => ipcRenderer.invoke("twin:accept-style-rules", rules),
  },
  browser: {
    getState: () => ipcRenderer.invoke("browser:get-state"),
    openUrl: (url?: string, newTab?: boolean) => ipcRenderer.invoke("browser:open-url", { url, newTab }),
    navigate: (action: "back" | "forward" | "reload" | "stop" | "home" | "weread") =>
      ipcRenderer.invoke("browser:navigate", action),
    selectTab: (tabId: string) => ipcRenderer.invoke("browser:select-tab", tabId),
    closeTab: (tabId: string) => ipcRenderer.invoke("browser:close-tab", tabId),
    addAccount: (label: string) => ipcRenderer.invoke("browser:add-account", label),
    switchAccount: (accountId: string) => ipcRenderer.invoke("browser:switch-account", accountId),
    readPage: (maxChars?: number) => ipcRenderer.invoke("browser:read-page", { maxChars }),
    setBounds: (rect: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.send("browser:set-bounds", rect),
    setVisible: (visible: boolean) => ipcRenderer.invoke("browser:set-visible", visible),
    setSuppressed: (suppressed: boolean) => ipcRenderer.send("browser:set-suppressed", suppressed),
    showMoreMenu: (pos: { x: number; y: number }) => ipcRenderer.invoke("browser:show-more-menu", pos),
    pickCookieFile: () => ipcRenderer.invoke("browser:pick-cookie-file"),
    parseCookieText: (rawText: string) => ipcRenderer.invoke("browser:parse-cookie-text", rawText),
    applyCookieImport: (input: { importToken: string; selectedDomains: string[] }) =>
      ipcRenderer.invoke("browser:apply-cookie-import", input),
    discardCookieImport: (importToken: string) =>
      ipcRenderer.invoke("browser:discard-cookie-import", importToken),
    listLocalBrowsers: () => ipcRenderer.invoke("browser:list-local-browsers"),
    inspectLocalBrowser: (profileId: string) =>
      ipcRenderer.invoke("browser:inspect-local-browser", profileId),
    importLocalBrowser: (input: { profileId: string; groups: string[] }) =>
      ipcRenderer.invoke("browser:import-local-browser", input),
    onStateChanged: (callback: (snapshot: BrowserStateSnapshot) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: BrowserStateSnapshot) => callback(snapshot);
      ipcRenderer.on("browser:state", listener);
      return () => {
        ipcRenderer.removeListener("browser:state", listener);
      };
    },
  },
  browserMenu: {
    zoom: (action: "in" | "out" | "reset") => ipcRenderer.invoke("browser-menu:zoom", action),
    runAction: (action: "copy-url" | "open-external" | "import-cookie" | "open-downloads" | "open-settings") =>
      ipcRenderer.invoke("browser-menu:action", action),
    close: () => ipcRenderer.invoke("browser-menu:close"),
    onData: (callback: (data: { url?: string; zoomPercent?: number; theme?: "light" | "dark" }) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { url?: string; zoomPercent?: number; theme?: "light" | "dark" },
      ) => callback(data);
      ipcRenderer.on("browser-menu:data", listener);
      return () => {
        ipcRenderer.removeListener("browser-menu:data", listener);
      };
    },
    onMainAction: (
      callback: (action: { kind: "import-cookie" | "open-settings" | "notified"; message?: string }) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        action: { kind: "import-cookie" | "open-settings" | "notified"; message?: string },
      ) => callback(action);
      ipcRenderer.on("browser-menu:main-action", listener);
      return () => {
        ipcRenderer.removeListener("browser-menu:main-action", listener);
      };
    },
  },
  agent: {
    send: (prompt: string, opts?: boolean | { newSession?: boolean; sessionId?: string | null }) =>
      ipcRenderer.invoke(
        "agent:send",
        typeof opts === "boolean"
          ? { prompt, newSession: opts }
          : {
              prompt,
              newSession: opts?.newSession === true,
              sessionId: opts?.sessionId ?? null,
            },
      ),
    stop: () => ipcRenderer.invoke("agent:stop"),
    reset: () => ipcRenderer.invoke("agent:reset"),
    selectSession: (harnessSessionId: string | null) =>
      ipcRenderer.invoke("agent:select-session", harnessSessionId),
    listSessions: (limit?: number) => ipcRenderer.invoke("agent:list-sessions", limit),
    getSession: (id: string) => ipcRenderer.invoke("agent:get-session", id),
    saveSession: (input: Record<string, unknown>) => ipcRenderer.invoke("agent:save-session", input),
    deleteSession: (id: string) => ipcRenderer.invoke("agent:delete-session", id),
    onEvent: (callback: (event: AgentEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: AgentEvent) => callback(payload);
      ipcRenderer.on("agent:event", listener);
      return () => {
        ipcRenderer.removeListener("agent:event", listener);
      };
    },
  },
  reader: {
    open: (filePath: string) => ipcRenderer.invoke("reader:open", filePath),
    getTranslationSettings: () => ipcRenderer.invoke("reader:get-translation-settings"),
    saveTranslationSettings: (input: ReaderTranslationSettingsInput) => ipcRenderer.invoke("reader:save-translation-settings", input),
    openDeepLPortal: () => ipcRenderer.invoke("reader:open-deepl-portal"),
    translate: (input: ReaderTranslationInput) => ipcRenderer.invoke("reader:translate", input),
    readCachedTranslations: (input: Omit<ReaderTranslationInput, "requestId">) => ipcRenderer.invoke("reader:cached-translations", input),
    cancelTranslation: (requestId: string) => ipcRenderer.invoke("reader:cancel-translation", requestId),
    saveLocation: (documentId: string, cfi: string) => ipcRenderer.invoke("reader:save-location", documentId, cfi),
    addAnnotation: (input: ReaderAnnotationInput) => ipcRenderer.invoke("reader:add-annotation", input),
    removeAnnotation: (documentId: string, highlightId: string) =>
      ipcRenderer.invoke("reader:remove-annotation", documentId, highlightId),
    resolveHighlight: (id: string) => ipcRenderer.invoke("reader:resolve-highlight", id),
  },
  library: {
    listBooks: (query?: string) => ipcRenderer.invoke("library:list-books", query),
    getBook: (id: string) => ipcRenderer.invoke("library:get-book", id),
    createBook: (input: Record<string, unknown>) => ipcRenderer.invoke("library:create-book", input),
    updateBook: (input: Record<string, unknown>) => ipcRenderer.invoke("library:update-book", input),
    deleteBook: (id: string) => ipcRenderer.invoke("library:delete-book", id),
    listHighlights: (bookId: string, query?: string) =>
      ipcRenderer.invoke("library:list-highlights", { bookId, query }),
    searchHighlights: (query: string, limit?: number) =>
      ipcRenderer.invoke("library:search-highlights", { query, limit }),
    addHighlight: (input: Record<string, unknown>) => ipcRenderer.invoke("library:add-highlight", input),
    updateHighlightNote: (id: string, note: string) =>
      ipcRenderer.invoke("library:update-highlight-note", { id, note }),
    deleteHighlight: (id: string) => ipcRenderer.invoke("library:delete-highlight", id),
    importNotesText: (input: Record<string, unknown>) => ipcRenderer.invoke("library:import-notes-text", input),
    importNotesFile: (input?: Record<string, unknown>) => ipcRenderer.invoke("library:import-notes-file", input),
    captureFromBrowser: (input?: Record<string, unknown>) =>
      ipcRenderer.invoke("library:capture-from-browser", input),
    lookupMetadata: (query: string, bookId?: string) => ipcRenderer.invoke("library:lookup-metadata", query, bookId),
    applyMetadata: (bookId: string, lookupId: string, index: number) =>
      ipcRenderer.invoke("library:apply-metadata", bookId, lookupId, index),
    getBookCover: (bookId: string) => ipcRenderer.invoke("library:get-book-cover", bookId),
    listWeReadNotebooks: () => ipcRenderer.invoke("library:weread-list-notebooks"),
    syncWeReadBooks: (books: unknown[]) => ipcRenderer.invoke("library:weread-sync-books", books),
    randomRecall: (excludeId?: string) => ipcRenderer.invoke("library:random-recall", excludeId),
    readingStats: (monthKey?: string) => ipcRenderer.invoke("library:reading-stats", monthKey),
    findRelatedHighlights: (text: string, limit?: number) =>
      ipcRenderer.invoke("library:find-related-highlights", { text, limit }),
  },
  notebooks: {
    list: () => ipcRenderer.invoke("notebooks:list"),
    create: (input: { name: string; icon?: string; description?: string }) =>
      ipcRenderer.invoke("notebooks:create", input),
    delete: (id: string) => ipcRenderer.invoke("notebooks:delete", id),
    addItem: (input: { notebookId: string; itemKind: string; itemRef: string; title: string; meta?: string }) =>
      ipcRenderer.invoke("notebooks:add-item", input),
    removeItem: (notebookId: string, itemId: string) =>
      ipcRenderer.invoke("notebooks:remove-item", { notebookId, itemId }),
  },
  drafts: {
    list: (bookId?: string) => ipcRenderer.invoke("drafts:list", bookId),
    get: (id: string) => ipcRenderer.invoke("drafts:get", id),
    create: (input: Record<string, unknown>) => ipcRenderer.invoke("drafts:create", input),
    appendRevision: (input: Record<string, unknown>) => ipcRenderer.invoke("drafts:append-revision", input),
    delete: (id: string) => ipcRenderer.invoke("drafts:delete", id),
  },
  cards: {
    templates: () => ipcRenderer.invoke("cards:templates"),
    previewHtml: (payload: ReadingCardPayload) => ipcRenderer.invoke("cards:preview-html", payload),
    bakeCopyPng: (payload: ReadingCardPayload) => ipcRenderer.invoke("cards:bake-copy-png", payload),
    bakeSavePng: (payload: ReadingCardPayload) => ipcRenderer.invoke("cards:bake-save-png", payload),
    splitCarousel: (input: Record<string, unknown>) => ipcRenderer.invoke("cards:split-carousel", input),
    bakeCopyCarouselSlide: (input: Record<string, unknown>) =>
      ipcRenderer.invoke("cards:bake-copy-carousel-slide", input),
    bakeExportCarouselFolder: (deck: CarouselDeckPayload) =>
      ipcRenderer.invoke("cards:bake-export-carousel-folder", deck),
    bakeCopyPoster: (payload: MonthlyPosterPayload) => ipcRenderer.invoke("cards:bake-copy-poster", payload),
    bakeSavePoster: (payload: MonthlyPosterPayload) => ipcRenderer.invoke("cards:bake-save-poster", payload),
    extractConcept: (input: { title: string; content: string; bookTitle?: string }) =>
      ipcRenderer.invoke("cards:extract-concept", input),
    previewConceptHtml: (payload: ConceptVisualPayload) =>
      ipcRenderer.invoke("cards:preview-concept-html", payload),
    bakeCopyConcept: (payload: ConceptVisualPayload) => ipcRenderer.invoke("cards:bake-copy-concept", payload),
    bakeSaveConcept: (payload: ConceptVisualPayload) => ipcRenderer.invoke("cards:bake-save-concept", payload),
  },
  obsidian: {
    getVault: () => ipcRenderer.invoke("obsidian:get-vault"),
    listVaults: () => ipcRenderer.invoke("obsidian:list-vaults"),
    setVault: (vaultPath: string) => ipcRenderer.invoke("obsidian:set-vault", vaultPath),
    pickVault: () => ipcRenderer.invoke("obsidian:pick-vault"),
    exportBook: (bookId: string) => ipcRenderer.invoke("obsidian:export-book", bookId),
    exportDraft: (draftId: string) => ipcRenderer.invoke("obsidian:export-draft", draftId),
    openDeepLink: (deepLink: string) => ipcRenderer.invoke("obsidian:open-deep-link", deepLink),
  },
  router: {
    status: () => ipcRenderer.invoke("router:status"),
    connections: () => ipcRenderer.invoke("router:connections"),
    setDomain: (domain: string) => ipcRenderer.invoke("router:set-domain", domain),
    doctor: () => ipcRenderer.invoke("router:doctor"),
    openZlibLogin: (domain?: string) => ipcRenderer.invoke("router:open-zlib-login", domain),
    syncZlibFromBrowser: (preferredDomain?: string) =>
      ipcRenderer.invoke("router:sync-zlib-from-browser", preferredDomain),
    loginZlibCookieFile: (domain?: string) => ipcRenderer.invoke("router:login-zlib-cookie-file", domain),
    logoutZlib: () => ipcRenderer.invoke("router:logout-zlib"),
    startWeReadQr: () => ipcRenderer.invoke("router:start-weread-qr"),
    cancelWeReadQr: () => ipcRenderer.invoke("router:cancel-weread-qr"),
    logoutWeRead: () => ipcRenderer.invoke("router:logout-weread"),
    onWeReadQrEvent: (callback: (event: WeReadQrEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: WeReadQrEvent) => callback(payload);
      ipcRenderer.on("router:weread-qr", listener);
      return () => {
        ipcRenderer.removeListener("router:weread-qr", listener);
      };
    },
    openKindleConfig: () => ipcRenderer.invoke("router:open-kindle-config"),
    getKindleConfig: () => ipcRenderer.invoke("router:get-kindle-config"),
    saveKindleConfig: (input: Record<string, unknown>) =>
      ipcRenderer.invoke("router:save-kindle-config", input),
    testKindleConfig: (input: Record<string, unknown>) =>
      ipcRenderer.invoke("router:test-kindle-config", input),
    search: (input: { query: string; format?: string; limit?: number; page?: number; order?: string }) =>
      ipcRenderer.invoke("router:search", input),
    recommended: (forceRefresh?: boolean) => ipcRenderer.invoke("router:recommended", { forceRefresh }),
    mostPopular: (forceRefresh?: boolean) => ipcRenderer.invoke("router:most-popular", { forceRefresh }),
    favorites: (forceRefresh?: boolean) => ipcRenderer.invoke("router:favorites", { forceRefresh }),
    history: (forceRefresh?: boolean) => ipcRenderer.invoke("router:history", { forceRefresh }),
    downloadHistoryPage: (page: number, forceRefresh?: boolean) =>
      ipcRenderer.invoke("router:download-history-page", { page, forceRefresh }),
    downloadHistoryBook: (bookRef: string, hint?: DownloadCoverHint) =>
      ipcRenderer.invoke("router:download-history-book", { bookRef, hint }),
    download: (bookRef: string, hint?: DownloadCoverHint) =>
      ipcRenderer.invoke("router:download", { bookRef, hint }),
    importLocalBooks: (mode: "files" | "directory") => ipcRenderer.invoke("router:import-local-books", mode),
    importBookText: (input: { title: string; text: string }) => ipcRenderer.invoke("router:import-book-text", input),
    listDownloadedBooks: () => ipcRenderer.invoke("router:list-downloaded-books"),
    getDownloadedBookCover: (filePath: string) => ipcRenderer.invoke("router:get-downloaded-book-cover", filePath),
    openDownloadedBook: (filePath: string) => ipcRenderer.invoke("router:open-downloaded-book", filePath),
    openDownloadDir: (filePath?: string) => ipcRenderer.invoke("router:open-download-dir", filePath),
    pickEbookFile: () => ipcRenderer.invoke("router:pick-ebook-file"),
    sendKindle: (filePath: string) => ipcRenderer.invoke("router:send-kindle", filePath),
    importWeRead: (filePath: string, options?: { fromLibrary?: boolean }) =>
      ipcRenderer.invoke("router:import-weread", filePath, options),
    readBookMeta: (filePath: string) => ipcRenderer.invoke("router:meta-read", filePath),
    fetchBookMetaMatches: (filePath: string, sources?: string[]) =>
      ipcRenderer.invoke("router:meta-fetch", { filePath, sources }),
    applyBookMeta: (input: Record<string, unknown>) => ipcRenderer.invoke("router:meta-apply", input),
  },
  pet: {
    getState: () => ipcRenderer.invoke("pet:get-state"),
    toggle: () => ipcRenderer.invoke("pet:toggle"),
    show: () => ipcRenderer.invoke("pet:show"),
    hide: () => ipcRenderer.invoke("pet:hide"),
    setExpanded: (expanded: boolean) => ipcRenderer.invoke("pet:set-expanded", expanded),
    setMode: (mode: "collapsed" | "nudge" | "expanded") => ipcRenderer.invoke("pet:set-mode", mode),
    getRecallMutedToday: () => ipcRenderer.invoke("pet:get-recall-muted-today"),
    muteRecallToday: () => ipcRenderer.invoke("pet:mute-recall-today"),
    sendToDraft: (payload: Record<string, unknown>) => ipcRenderer.invoke("pet:send-to-draft", payload),
    moveBy: (dx: number, dy: number) => ipcRenderer.send("pet:move-by", { dx, dy }),
    dragStart: (screenX: number, screenY: number) => ipcRenderer.send("pet:drag-start", { screenX, screenY }),
    dragMove: (screenX: number, screenY: number) => ipcRenderer.send("pet:drag-move", { screenX, screenY }),
    dragEnd: () => ipcRenderer.send("pet:drag-end"),
    focusMain: () => ipcRenderer.invoke("pet:focus-main"),
    onStateChanged: (callback: (state: PetWindowState) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: PetWindowState) => callback(state);
      ipcRenderer.on("pet:state", listener);
      return () => {
        ipcRenderer.removeListener("pet:state", listener);
      };
    },
    onQuickQuote: (callback: (payload: PetQuickQuoteEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: PetQuickQuoteEvent) => callback(payload);
      ipcRenderer.on("pet:quick-quote", listener);
      return () => {
        ipcRenderer.removeListener("pet:quick-quote", listener);
      };
    },
  },
} satisfies DesktopBridgeApi;

contextBridge.exposeInMainWorld("diandian", desktopApi);
