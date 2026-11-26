export type SafetyMode = "plan" | "confirm" | "auto";
export type BookSource = "weread" | "kindle" | "local" | "zlib" | "manual";
export type DraftKind = "review" | "card_copy" | "thread" | "script" | "note";
export type RevisionAuthorKind = "ai" | "human";
export type CardTemplateId =
  | "editorial-paper"
  | "swiss-grid"
  | "nocturne-ink"
  | "botanical-green"
  | "magazine-glass";

export interface AppInfo {
  name: string;
  version: string;
  electronVersion: string;
  nodeVersion: string;
}

export interface PublicModelSettings {
  provider: "deepseek" | "openai-compatible";
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeySource: "saved" | "env" | "none";
}

export interface TwinProfileState {
  profileMd: string;
  styleMd: string;
  sha256: string;
  twinDir: string;
  updatedAt: string;
}

export interface StyleDistillSuggestion {
  id: string;
  rule: string;
  reason: string;
  source: "llm" | "heuristic";
}

export interface RelatedHighlightItem extends HighlightRecord {
  bookTitle: string;
  bookAuthor: string;
  matchedTerms: string[];
}

export type NotebookItemKind = "book" | "draft" | "web";

export interface NotebookItemRecord {
  id: string;
  notebookId: string;
  itemKind: NotebookItemKind;
  itemRef: string;
  title: string;
  meta: string;
  createdAt: string;
}

export interface NotebookRecord {
  id: string;
  name: string;
  icon: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  items: NotebookItemRecord[];
}

export interface ChatMessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  text: string;
  reasoning: string;
  contexts: string[];
  tools: Array<{ name: string; status: "running" | "done" }>;
  createdAt: string;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  harnessSessionId: string;
  messageCount: number;
  preview: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSessionDetail extends ChatSessionSummary {
  messages: ChatMessageRecord[];
}

export type ConceptVisualLayout = "cover" | "mindmap" | "infographic";
export type ConceptVisualTheme =
  | "editorial-paper"
  | "memo-grid"
  | "botanical-mist"
  | "nocturne-ink"
  | "cloud-blue";

export interface ConceptBranch {
  heading: string;
  points: string[];
}

export interface ConceptVisualPayload {
  layout: ConceptVisualLayout;
  theme: ConceptVisualTheme;
  title: string;
  subtitle: string;
  callout?: string;
  branches: ConceptBranch[];
  showColophon?: boolean;
}

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

export type AgentEvent =
  | { kind: "engine-state"; state: "idle" | "booting" | "ready" | "error"; detail?: string }
  | { kind: "status"; running: boolean }
  | { kind: "stream"; streamRole: "assistant" | "reasoning"; text: string; sessionId: string | null }
  | { kind: "tool"; phase: "start" | "done"; name: string; callId?: string; sessionId: string | null }
  | { kind: "final"; sessionId: string | null; finalResponse: string; finishReason: string | null }
  | { kind: "session-reset" }
  | { kind: "error"; message: string; sessionId?: string | null };

export interface BookRecord {
  id: string;
  title: string;
  author: string;
  isbn: string;
  publisher: string;
  publishedYear: string;
  description: string;
  tags: string[];
  coverUrl: string;
  source: BookSource;
  sourceLocator: string;
  createdAt: string;
  updatedAt: string;
  highlightCount: number;
  draftCount: number;
}

export interface HighlightRecord {
  id: string;
  bookId: string;
  chapter: string;
  quote: string;
  note: string;
  source: BookSource;
  fingerprint: string;
  cfi?: string;
  isHighlighted?: boolean;
  color?: ReaderHighlightColor;
  createdAt: string;
}

export interface DraftRevisionRecord {
  id: string;
  draftId: string;
  revisionNo: number;
  authorKind: RevisionAuthorKind;
  content: string;
  sourceHighlightIds: string[];
  promptSummary: string;
  createdAt: string;
}

export interface DraftRecord {
  id: string;
  bookId: string | null;
  bookTitle: string;
  title: string;
  kind: DraftKind;
  createdAt: string;
  updatedAt: string;
  latestRevisionNo: number;
  latestAuthorKind: RevisionAuthorKind;
  latestContent: string;
  revisions?: DraftRevisionRecord[];
}

export interface ImportNotesResult {
  format: "kindle" | "weread" | "generic";
  booksTouched: number;
  importedCount: number;
  deduplicatedCount: number;
  bookIds: string[];
}

export type BookMetadataSource = "openlibrary" | "google-books" | "weread";

export interface BookMetadataCandidate {
  source: BookMetadataSource;
  title: string;
  author: string;
  isbn: string;
  publisher: string;
  publishedYear: string;
  description: string;
  coverUrl: string;
}

export interface BookMetadataSearchResult {
  candidates: BookMetadataCandidate[];
  issues: Array<{ source: BookMetadataSource; reason: "rate-limited" | "unavailable" }>;
  invalidIsbn?: true;
}

export interface CardTemplateMeta {
  id: CardTemplateId;
  name: string;
  subtitle: string;
  aspect: "3:4";
  width: number;
  height: number;
  swatchBg: string;
  swatchAccent: string;
}

export interface ReadingCardPayload {
  templateId: CardTemplateId;
  quote: string;
  comment: string;
  bookTitle: string;
  author: string;
  tag: string;
  dateLabel?: string;
}

export interface ObsidianVaultCandidate {
  name: string;
  path: string;
  lastOpened: number;
}

export interface ObsidianExportOutcome {
  status: "written" | "unchanged" | "conflict";
  stableId: string;
  targetRelativePath: string;
  writtenRelativePath: string;
  deepLink: string;
  message: string;
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

export interface ZlibStatus {
  installed: boolean;
  binaryPath: string | null;
  version: string | null;
  supportsMeta: boolean;
  installHint: string;
}

export interface ZlibDomainHealth {
  domain: string;
  status: string;
  httpStatus: number;
}

export interface PublicKindleSettings {
  configured: boolean;
  to: string;
  from: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: "tls" | "starttls";
  hasPassword: boolean;
}

export interface ConnectionsSnapshot {
  status: ZlibStatus;
  zlib: {
    loggedIn: boolean;
    userName: string;
    dailyRemaining: number | null;
    dailyAllowed: number | null;
    currentDomain: string;
    error?: string;
  };
  weread: {
    loggedIn: boolean;
    name: string;
    vid: string;
    error?: string;
  };
  kindle: {
    configured: boolean;
    to: string;
    from: string;
    smtpHost: string;
    smtpPort: string;
    smtpSecurity: string;
  };
}

export interface QrMatrix {
  size: number;
  rows: boolean[][];
}

export type WeReadQrEvent =
  | { kind: "starting" }
  | { kind: "qr"; qr: QrMatrix; hint: string }
  | { kind: "success"; name: string; vid: string }
  | { kind: "error"; message: string }
  | { kind: "canceled" };

export interface ZlibBookItem {
  bookRef: string;
  id: string;
  hash: string;
  title: string;
  author: string;
  publisher: string;
  coverUrl: string;
  extension: string;
  size: string;
  year: string;
  language: string;
  isbn?: string;
  url?: string;
  rating?: string;
  description?: string;
}

export interface LocalBookImportResult {
  added: number;
  existing: number;
  failures: { name: string; message: string }[];
  canceled: boolean;
}

export interface ZlibDownloadHistoryPage {
  books: (ZlibBookItem & { unavailableReason?: string })[];
  localRefs: string[];
  hasMore: boolean;
}

export interface DownloadedBookFile {
  filePath: string;
  fileName: string;
  format: string;
  sizeBytes: number;
  modifiedAt: number;
  fileRevision?: string;
}

export type DownloadCoverHint = Partial<Pick<ZlibBookItem, "title" | "author" | "isbn" | "publisher" | "year" | "coverUrl">>;

export interface WeReadImportResult {
  output: string;
  alreadyExisted: boolean;
}

export type ReaderHighlightColor = import("../../electron/storage/highlightColors").ReaderHighlightColor;
export type ReaderAnnotation = HighlightRecord & { cfi: string; isHighlighted: boolean; color: ReaderHighlightColor };

export type ReaderTranslationProvider = "deepl" | "model";

export interface ReaderTranslationSettings {
  provider: ReaderTranslationProvider;
  hasDeepLKey: boolean;
}

export interface ReaderTranslationSettingsInput {
  provider: ReaderTranslationProvider;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface ReaderTranslationInput {
  provider?: ReaderTranslationProvider;
  target: "en" | "zh";
  texts: string[];
  requestId?: string;
}

export interface ReaderAnnotationInput {
  documentId: string;
  title: string;
  author?: string;
  isbn?: string;
  chapter: string;
  quote: string;
  note?: string;
  cfi: string;
  color?: ReaderHighlightColor;
}

export interface OpenReaderBook {
  bytes: Uint8Array;
  documentId: string;
  location: string;
  annotations: ReaderAnnotation[];
}

export interface LocalBookMetadata {
  title: string;
  authors: string;
  publisher: string;
  date: string;
  isbn: string;
  language: string;
  tags: string;
  comments: string;
  source?: string;
}

export type PetWindowMode = "collapsed" | "nudge" | "expanded";

export interface PetWindowState {
  visible: boolean;
  expanded: boolean;
  mode: PetWindowMode;
  showJumpToMain?: boolean;
}

export interface WeReadNotebookBook {
  bookId: string;
  title: string;
  author: string;
  coverUrl: string;
  publisher: string;
  isbn: string;
  intro: string;
  publishedYear: string;
  noteCount: number;
  reviewCount: number;
  bookmarkCount: number;
  sortTime: number;
}

export interface WeReadSyncOutcome {
  booksSynced: number;
  importedCount: number;
  deduplicatedCount: number;
  details: Array<{
    bookId: string;
    localBookId: string;
    title: string;
    importedCount: number;
    deduplicatedCount: number;
  }>;
}

export interface RecallHighlightItem extends HighlightRecord {
  bookTitle: string;
  bookAuthor: string;
  daysAgo: number;
}

export interface ReadingStatsSummary {
  monthKey: string;
  totalBooks: number;
  totalHighlights: number;
  totalDrafts: number;
  monthBooksCount: number;
  monthHighlightsCount: number;
  monthBooks: Array<{ id: string; title: string; author: string; highlightCount: number }>;
  featuredQuotes: Array<{ quote: string; note: string; bookTitle: string; bookAuthor: string }>;
  suggestedKeywords: string[];
}

export type CarouselSlideKind = "cover" | "body" | "outro";

export interface CarouselSlide {
  id: string;
  kind: CarouselSlideKind;
  heading: string;
  body: string;
  accentNote?: string;
}

export interface CarouselDeckPayload {
  templateId: CardTemplateId;
  bookTitle: string;
  author: string;
  tag: string;
  slides: CarouselSlide[];
}

export type PosterThemeId = "editorial-paper" | "nocturne-ink" | "botanical-green";

export interface MonthlyPosterPayload {
  themeId: PosterThemeId;
  monthLabel: string;
  headline: string;
  booksCount: number;
  highlightsCount: number;
  draftsCount: number;
  books: Array<{ title: string; author: string }>;
  quotes: Array<{ quote: string; bookTitle: string }>;
  keywords: string[];
  showWatermark?: boolean;
}

export interface AppQuickActionEvent {
  kind: "saved" | "draft" | "ask";
  text: string;
  title: string;
  comment?: string;
  author?: string;
  url?: string;
  deduplicated?: boolean;
}

export interface AppMenuActionEvent {
  action: "preferences" | "new-book" | "import-notes" | "sync-obsidian" | "open-downloads";
}

export interface PetQuickQuoteEvent {
  text: string;
  title: string;
  url?: string;
  source: "selection" | "shortcut";
}

export interface AvailableModelOption {
  id: string;
  label: string;
  tag?: string;
  desc?: string;
  source: "api" | "preset" | "current";
}

export interface AvailableModelsResult {
  models: AvailableModelOption[];
  source: "api" | "preset";
  providerLabel: string;
  error?: string;
}

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
    getRecallMutedToday(): Promise<{ muted: boolean }>;
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

declare global {
  interface Window {
    diandian: DesktopBridgeApi;
  }
}
