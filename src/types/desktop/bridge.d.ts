/** The window.diandian API exposed by electron/preload.ts. */
import type { AgentEvent, AppInfo, AvailableModelsResult, ChatSessionDetail, ChatSessionSummary, PublicModelSettings, SafetyMode, StyleDistillSuggestion, TwinProfileState } from "./agent";
import type { AppMenuActionEvent, AppQuickActionEvent, PetQuickQuoteEvent, PetWindowMode, PetWindowState } from "./app";
import type { BrowserStateSnapshot, CookieImportPreview, PageContentSnapshot, PublicLocalBrowserProfile, ReadingSiteGroupId, ReadingSiteGroupSummary } from "./browser";
import type { CardTemplateMeta, CarouselDeckPayload, CarouselSlide, ConceptVisualPayload, MonthlyPosterPayload, ReadingCardPayload } from "./cards";
import type { BookMetadataSearchResult, BookRecord, BookSource, DraftKind, DraftRecord, HighlightRecord, ImportNotesResult, NotebookItemKind, NotebookRecord, ObsidianExportOutcome, ObsidianVaultCandidate, ReadingStatsSummary, RecallHighlightItem, RelatedHighlightItem, RevisionAuthorKind, WeReadNotebookBook, WeReadSyncOutcome } from "./library";
import type { OpenReaderBook, ReaderAnnotation, ReaderAnnotationInput, ReaderTranslationInput, ReaderTranslationSettings, ReaderTranslationSettingsInput } from "./reader";
import type { ConnectionsSnapshot, DownloadCoverHint, DownloadedBookFile, LocalBookImportResult, LocalBookMetadata, PublicKindleSettings, WeReadImportResult, WeReadQrEvent, ZlibBookItem, ZlibDomainHealth, ZlibDownloadHistoryPage, ZlibStatus } from "./router";

export interface DesktopBridgeApi {
  app: {
    info(): Promise<AppInfo>;
    setTheme(theme: "light" | "dark"): Promise<{ theme: "light" | "dark" }>;
    onThemeChanged(callback: (payload: { theme: "light" | "dark" }) => void): () => void;
    onQuickAction(callback: (payload: AppQuickActionEvent) => void): () => void;
    onMenuAction(callback: (payload: AppMenuActionEvent) => void): () => void;
  };
  settings: {
    getModel(): Promise<PublicModelSettings>;
    listModels(): Promise<AvailableModelsResult>;
    saveModel(input: {
      provider: "deepseek" | "openai-compatible";
      model: string;
      baseUrl: string;
      apiKey?: string;
      clearApiKey?: boolean;
      /** Required to store a new key while the system keychain is unavailable. */
      allowPlaintextKey?: boolean;
    }): Promise<PublicModelSettings>;
    testModel(input: {
      baseUrl: string;
      model: string;
      apiKey?: string;
      useSavedKey?: boolean;
    }): Promise<{ ok: true; latencyMs: number } | { ok: false; message: string }>;
    openKeyPortal(presetId: string): Promise<{ opened: boolean }>;
  };
  safety: {
    getMode(): Promise<{ mode: SafetyMode }>;
    setMode(mode: SafetyMode): Promise<{ mode: SafetyMode }>;
  };
  twin: {
    get(): Promise<TwinProfileState>;
    save(input: { profileMd?: string; styleMd?: string }): Promise<TwinProfileState>;
    distillDiff(draftId: string): Promise<{ suggestions: StyleDistillSuggestion[] }>;
    acceptStyleRules(rules: string[]): Promise<{ state: TwinProfileState; addedCount: number }>;
  };
  browser: {
    getState(): Promise<BrowserStateSnapshot>;
    openUrl(url?: string, newTab?: boolean): Promise<BrowserStateSnapshot>;
    navigate(action: "back" | "forward" | "reload" | "stop" | "home" | "weread"): Promise<BrowserStateSnapshot>;
    selectTab(tabId: string): Promise<BrowserStateSnapshot>;
    closeTab(tabId: string): Promise<BrowserStateSnapshot>;
    addAccount(label: string): Promise<BrowserStateSnapshot>;
    switchAccount(accountId: string): Promise<BrowserStateSnapshot>;
    readPage(maxChars?: number): Promise<PageContentSnapshot>;
    setBounds(rect: { x: number; y: number; width: number; height: number }): void;
    setVisible(visible: boolean): Promise<BrowserStateSnapshot>;
    setSuppressed(suppressed: boolean): void;
    showMoreMenu(pos: { x: number; y: number }): Promise<{ opened: boolean }>;
    pickCookieFile(): Promise<
      | { canceled: true }
      | ({ canceled: false; fileName: string } & CookieImportPreview)
    >;
    parseCookieText(rawText: string): Promise<CookieImportPreview>;
    applyCookieImport(input: {
      importToken: string;
      selectedDomains: string[];
    }): Promise<{ accountId: string; imported: number; failed: number; domains: string[] }>;
    discardCookieImport(importToken: string): Promise<{ discarded: boolean }>;
    listLocalBrowsers(): Promise<PublicLocalBrowserProfile[]>;
    inspectLocalBrowser(profileId: string): Promise<{
      profile: PublicLocalBrowserProfile;
      groups: ReadingSiteGroupSummary[];
      totalCookies: number;
    }>;
    importLocalBrowser(input: {
      profileId: string;
      groups: ReadingSiteGroupId[];
    }): Promise<{
      browserName: string;
      profileName: string;
      accountId: string;
      imported: number;
      failed: number;
      domains: string[];
    }>;
    onStateChanged(callback: (snapshot: BrowserStateSnapshot) => void): () => void;
  };
  browserMenu: {
    zoom(action: "in" | "out" | "reset"): Promise<{ zoomPercent: number }>;
    runAction(
      action: "copy-url" | "open-external" | "import-cookie" | "open-downloads" | "open-settings",
    ): Promise<{ ok: boolean }>;
    close(): Promise<{ closed: boolean }>;
    onData(callback: (data: { url?: string; zoomPercent?: number; theme?: "light" | "dark" }) => void): () => void;
    onMainAction(
      callback: (action: { kind: "import-cookie" | "open-settings" | "notified"; message?: string }) => void,
    ): () => void;
  };
  agent: {
    send(prompt: string, opts?: { newSession?: boolean; sessionId?: string | null }): Promise<{ accepted: boolean }>;
    stop(): Promise<{ stopped: boolean }>;
    reset(): Promise<{ reset: boolean }>;
    selectSession(harnessSessionId: string | null): Promise<{ selected: boolean }>;
    listSessions(limit?: number): Promise<ChatSessionSummary[]>;
    getSession(id: string): Promise<ChatSessionDetail | null>;
    saveSession(input: {
      id: string;
      title: string;
      harnessSessionId?: string;
      contextLabel?: string;
      messages: Array<{
        id: string;
        role: "user" | "assistant" | "system";
        text: string;
        reasoning?: string;
        contexts?: string[];
        tools?: Array<{ name: string; status: "running" | "done" }>;
        createdAt?: string;
      }>;
    }): Promise<ChatSessionSummary>;
    deleteSession(id: string): Promise<{ deleted: boolean }>;
    onEvent(callback: (event: AgentEvent) => void): () => void;
  };
  reader: {
    open(filePath: string): Promise<OpenReaderBook>;
    getTranslationSettings(): Promise<ReaderTranslationSettings>;
    saveTranslationSettings(input: ReaderTranslationSettingsInput): Promise<ReaderTranslationSettings>;
    openDeepLPortal(): Promise<void>;
    translate(input: ReaderTranslationInput): Promise<string[]>;
    readCachedTranslations(input: Omit<ReaderTranslationInput, "requestId">): Promise<(string | null)[]>;
    cancelTranslation(requestId: string): Promise<void>;
    saveLocation(documentId: string, cfi: string): Promise<void>;
    addAnnotation(input: ReaderAnnotationInput): Promise<ReaderAnnotation>;
    removeAnnotation(documentId: string, highlightId: string): Promise<ReaderAnnotation | null>;
    resolveHighlight(highlightId: string): Promise<{ file: DownloadedBookFile; cfi: string }>;
  };
  library: {
    listBooks(query?: string): Promise<BookRecord[]>;
    getBook(id: string): Promise<BookRecord | null>;
    createBook(input: {
      title: string;
      author?: string;
      isbn?: string;
      publisher?: string;
      publishedYear?: string;
      description?: string;
      tags?: string[];
      coverUrl?: string;
      source?: BookSource;
    }): Promise<BookRecord>;
    updateBook(input: {
      id: string;
      title?: string;
      author?: string;
      isbn?: string;
      publisher?: string;
      publishedYear?: string;
      description?: string;
      tags?: string[];
      coverUrl?: string;
    }): Promise<BookRecord>;
    deleteBook(id: string): Promise<{ deleted: boolean }>;
    listHighlights(bookId: string, query?: string): Promise<HighlightRecord[]>;
    searchHighlights(
      query: string,
      limit?: number,
    ): Promise<Array<HighlightRecord & { bookTitle: string; bookAuthor: string }>>;
    addHighlight(input: {
      bookId: string;
      chapter?: string;
      quote: string;
      note?: string;
      source?: BookSource;
    }): Promise<{ record: HighlightRecord; deduplicated: boolean }>;
    updateHighlightNote(id: string, note: string): Promise<HighlightRecord | null>;
    deleteHighlight(id: string): Promise<{ deleted: boolean }>;
    importNotesText(input: {
      rawText: string;
      format?: "auto" | "kindle" | "weread";
      fallbackTitle?: string;
      fallbackAuthor?: string;
    }): Promise<ImportNotesResult>;
    importNotesFile(input?: {
      format?: "auto" | "kindle" | "weread";
      fallbackTitle?: string;
    }): Promise<({ canceled: true } | ({ canceled: false; fileName: string } & ImportNotesResult))>;
    captureFromBrowser(input?: {
      bookId?: string;
      note?: string;
    }): Promise<{
      book: BookRecord;
      highlight: HighlightRecord;
      deduplicated: boolean;
      usedSelection: boolean;
    }>;
    lookupMetadata(query: string, bookId?: string): Promise<BookMetadataSearchResult & { lookupId?: string }>;
    applyMetadata(bookId: string, lookupId: string, index: number): Promise<{ coverUnavailable: boolean }>;
    getBookCover(bookId: string): Promise<string | null>;
    listWeReadNotebooks(): Promise<WeReadNotebookBook[]>;
    syncWeReadBooks(books: WeReadNotebookBook[]): Promise<WeReadSyncOutcome>;
    randomRecall(excludeId?: string): Promise<RecallHighlightItem | null>;
    readingStats(monthKey?: string): Promise<ReadingStatsSummary>;
    findRelatedHighlights(text: string, limit?: number): Promise<RelatedHighlightItem[]>;
  };
  notebooks: {
    list(): Promise<NotebookRecord[]>;
    create(input: { name: string; icon?: string; description?: string }): Promise<NotebookRecord>;
    delete(id: string): Promise<{ deleted: boolean }>;
    addItem(input: {
      notebookId: string;
      itemKind: NotebookItemKind;
      itemRef: string;
      title: string;
      meta?: string;
    }): Promise<NotebookRecord>;
    removeItem(notebookId: string, itemId: string): Promise<NotebookRecord | null>;
  };
  drafts: {
    list(bookId?: string): Promise<DraftRecord[]>;
    get(id: string): Promise<DraftRecord | null>;
    create(input: {
      bookId?: string | null;
      title: string;
      kind: DraftKind;
      authorKind: RevisionAuthorKind;
      content: string;
      sourceHighlightIds?: string[];
      promptSummary?: string;
    }): Promise<DraftRecord>;
    appendRevision(input: {
      draftId: string;
      title?: string;
      authorKind: RevisionAuthorKind;
      content: string;
      sourceHighlightIds?: string[];
      promptSummary?: string;
    }): Promise<DraftRecord>;
    delete(id: string): Promise<{ deleted: boolean }>;
  };
  cards: {
    templates(): Promise<CardTemplateMeta[]>;
    previewHtml(payload: ReadingCardPayload): Promise<{ html: string }>;
    bakeCopyPng(payload: ReadingCardPayload): Promise<{
      copied: boolean;
      width: number;
      height: number;
      bytes: number;
    }>;
    bakeSavePng(payload: ReadingCardPayload): Promise<
      | { canceled: true }
      | { canceled: false; filePath: string; width: number; height: number; bytes: number }
    >;
    splitCarousel(input: {
      title: string;
      bookTitle: string;
      author?: string;
      content: string;
      maxBodySlides?: number;
    }): Promise<CarouselSlide[]>;
    bakeCopyCarouselSlide(input: {
      deck: CarouselDeckPayload;
      slideIndex: number;
    }): Promise<{ copied: boolean; width: number; height: number; bytes: number }>;
    bakeExportCarouselFolder(deck: CarouselDeckPayload): Promise<
      | { canceled: true }
      | { canceled: false; folderPath: string; files: string[] }
    >;
    bakeCopyPoster(payload: MonthlyPosterPayload): Promise<{
      copied: boolean;
      width: number;
      height: number;
      bytes: number;
    }>;
    bakeSavePoster(payload: MonthlyPosterPayload): Promise<
      | { canceled: true }
      | { canceled: false; filePath: string; width: number; height: number; bytes: number }
    >;
    extractConcept(input: {
      title: string;
      content: string;
      bookTitle?: string;
    }): Promise<Omit<ConceptVisualPayload, "layout" | "theme">>;
    previewConceptHtml(payload: ConceptVisualPayload): Promise<{ html: string }>;
    bakeCopyConcept(payload: ConceptVisualPayload): Promise<{
      copied: boolean;
      width: number;
      height: number;
      bytes: number;
    }>;
    bakeSaveConcept(payload: ConceptVisualPayload): Promise<
      | { canceled: true }
      | { canceled: false; filePath: string; width: number; height: number; bytes: number }
    >;
  };
  obsidian: {
    getVault(): Promise<{ vaultPath: string }>;
    listVaults(): Promise<ObsidianVaultCandidate[]>;
    setVault(vaultPath: string): Promise<{ vaultPath: string }>;
    pickVault(): Promise<{ canceled: boolean; vaultPath: string }>;
    exportBook(bookId: string): Promise<ObsidianExportOutcome>;
    exportDraft(draftId: string): Promise<ObsidianExportOutcome>;
    openDeepLink(deepLink: string): Promise<{ opened: boolean }>;
  };
  router: {
    status(): Promise<ZlibStatus>;
    connections(): Promise<ConnectionsSnapshot>;
    setDomain(domain: string): Promise<{ domain: string }>;
    doctor(): Promise<{ ok: boolean; output: string; domains: ZlibDomainHealth[] }>;
    openZlibLogin(domain?: string): Promise<{ openedUrl: string }>;
    syncZlibFromBrowser(preferredDomain?: string): Promise<{
      origin: string;
      cookieCount: number;
      snapshot: ConnectionsSnapshot;
    }>;
    loginZlibCookieFile(domain?: string): Promise<
      | { canceled: true }
      | { canceled: false; snapshot: ConnectionsSnapshot }
    >;
    logoutZlib(): Promise<{ snapshot: ConnectionsSnapshot }>;
    startWeReadQr(): Promise<{ started: boolean }>;
    cancelWeReadQr(): Promise<{ canceled: boolean }>;
    logoutWeRead(): Promise<{ snapshot: ConnectionsSnapshot }>;
    onWeReadQrEvent(callback: (event: WeReadQrEvent) => void): () => void;
    openKindleConfig(): Promise<{ launched: boolean; command: string }>;
    getKindleConfig(): Promise<PublicKindleSettings>;
    saveKindleConfig(input: {
      to?: string;
      from?: string;
      smtpHost?: string;
      smtpPort?: number;
      smtpSecurity?: "tls" | "starttls";
      password?: string;
      clearPassword?: boolean;
      clearAll?: boolean;
    }): Promise<{ config: PublicKindleSettings; snapshot: ConnectionsSnapshot | null }>;
    testKindleConfig(input: {
      from: string;
      smtpHost: string;
      smtpPort: number;
      smtpSecurity: "tls" | "starttls";
      password?: string;
      useSavedPassword?: boolean;
    }): Promise<{ ok: true; latencyMs: number } | { ok: false; message: string }>;
    search(input: {
      query: string;
      format?: string;
      limit?: number;
      page?: number;
      order?: string;
    }): Promise<ZlibBookItem[]>;
    recommended(forceRefresh?: boolean): Promise<ZlibBookItem[]>;
    mostPopular(forceRefresh?: boolean): Promise<ZlibBookItem[]>;
    favorites(forceRefresh?: boolean): Promise<ZlibBookItem[]>;
    history(forceRefresh?: boolean): Promise<ZlibBookItem[]>;
    downloadHistoryPage(page: number, forceRefresh?: boolean): Promise<ZlibDownloadHistoryPage>;
    downloadHistoryBook(bookRef: string, hint?: DownloadCoverHint):
      Promise<{ filePath: string; directory: string; output: string; alreadyLocal: boolean }>;
    download(bookRef: string, hint?: DownloadCoverHint):
      Promise<{ output: string; directory: string; filePath?: string }>;
    listDownloadedBooks(): Promise<DownloadedBookFile[]>;
    importLocalBooks(mode: "files" | "directory"): Promise<LocalBookImportResult>;
    importBookText(input: { title: string; text: string }): Promise<LocalBookImportResult>;
    getDownloadedBookCover(filePath: string): Promise<string | null>;
    openDownloadedBook(filePath: string): Promise<void>;
    openDownloadDir(filePath?: string): Promise<{ opened: boolean; path: string }>;
    pickEbookFile(): Promise<{ canceled: boolean; filePath: string }>;
    sendKindle(filePath: string): Promise<{ output: string }>;
    importWeRead(filePath: string, options?: { fromLibrary?: boolean }): Promise<WeReadImportResult>;
    readBookMeta(filePath: string): Promise<LocalBookMetadata>;
    fetchBookMetaMatches(filePath: string, sources?: string[]): Promise<LocalBookMetadata[]>;
    applyBookMeta(
      input: Partial<LocalBookMetadata> & { filePath: string; rename?: boolean },
    ): Promise<{ metadata: LocalBookMetadata; filePath: string; output: string }>;
  };
  pet: {
    getState(): Promise<PetWindowState>;
    toggle(): Promise<PetWindowState>;
    show(): Promise<PetWindowState>;
    hide(): Promise<PetWindowState>;
    setExpanded(expanded: boolean): Promise<PetWindowState>;
    setMode(mode: PetWindowMode): Promise<PetWindowState>;
    /** Whether today's automatic recall nudge may show; claiming it uses up the day. */
    claimDailyRecall(): Promise<{ allowed: boolean }>;
    muteRecallToday(): Promise<{ muted: boolean }>;
    sendToDraft(payload: {
      quote: string;
      comment?: string;
      bookTitle?: string;
      author?: string;
    }): Promise<{ sent: boolean }>;
    moveBy(dx: number, dy: number): void;
    dragStart(screenX: number, screenY: number): void;
    dragMove(screenX: number, screenY: number): void;
    dragEnd(): void;
    focusMain(): Promise<{ focused: boolean }>;
    onStateChanged(callback: (state: PetWindowState) => void): () => void;
    onQuickQuote(callback: (payload: PetQuickQuoteEvent) => void): () => void;
  };
}
