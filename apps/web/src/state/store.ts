import type {
  BookSnapshot,
  ChatMessageView,
  ChatReferenceView,
  ChatRunView,
  ConversationSnapshot,
  ImportTabName,
  JobSnapshot,
  PanelMode,
  ProviderStatus,
  SessionStatus,
  StatusLine,
  ViewName,
} from "../lib/types";

export interface AppState {
  currentView: ViewName;
  viewFocusToken: number;
  session: { status: SessionStatus };
  sessionDetailOverride: string | null;
  logoutBusy: boolean;
  providers: {
    notebooklm: { status: ProviderStatus };
    zlibrary: { status: ProviderStatus };
  };
  authRefreshBusy: boolean;
  importTab: ImportTabName;
  localImportBusy: boolean;
  localImportStatus: StatusLine;
  zlibraryImportBusy: boolean;
  zlibraryImportStatus: StatusLine;
  jobs: JobSnapshot[];
  selectedJobId: string | null;
  jobsStatus: StatusLine;
  jobsRefreshBusy: boolean;
  jobRetryBusy: boolean;
  lastRefreshText: string;
  books: BookSnapshot[];
  booksRendered: boolean;
  selectedBookId: string | null;
  bookSelectDisabled: boolean;
  bookPickerHelp: string;
  loadConversationDisabled: boolean;
  conversation: ConversationSnapshot | null;
  messages: ChatMessageView[];
  referencesByMessageId: ReadonlyMap<string, ChatReferenceView[]>;
  activeRun: ChatRunView | null;
  chatState: StatusLine;
  questionValue: string;
  questionDisabled: boolean;
  questionPlaceholder: string;
  sendDisabled: boolean;
  showRetryChat: boolean;
  showCancelChat: boolean;
  retryChatDisabled: boolean;
  cancelChatDisabled: boolean;
  panelMode: PanelMode | null;
  chatOpen: boolean;
  online: boolean;
  liveMessage: string;
}

export function initialAppState(): AppState {
  return {
    currentView: "connections",
    viewFocusToken: 0,
    session: { status: "loading" },
    sessionDetailOverride: null,
    logoutBusy: false,
    providers: {
      notebooklm: { status: "loading" },
      zlibrary: { status: "loading" },
    },
    authRefreshBusy: false,
    importTab: "local",
    localImportBusy: false,
    localImportStatus: { text: "", state: "" },
    zlibraryImportBusy: false,
    zlibraryImportStatus: { text: "", state: "" },
    jobs: [],
    selectedJobId: null,
    jobsStatus: { text: "等待加载任务。", state: "" },
    jobsRefreshBusy: false,
    jobRetryBusy: false,
    lastRefreshText: "尚未刷新 / Not refreshed yet",
    books: [],
    booksRendered: false,
    selectedBookId: null,
    bookSelectDisabled: true,
    bookPickerHelp: "选择已完成处理的书籍，建立或恢复唯一活跃对话。",
    loadConversationDisabled: true,
    conversation: null,
    messages: [],
    referencesByMessageId: new Map(),
    activeRun: null,
    chatState: { text: "请选择一本可用书籍开始对话。", state: "" },
    questionValue: "",
    questionDisabled: true,
    questionPlaceholder: "先选择一本书…",
    sendDisabled: true,
    showRetryChat: false,
    showCancelChat: false,
    retryChatDisabled: false,
    cancelChatDisabled: false,
    panelMode: null,
    chatOpen: false,
    online: true,
    liveMessage: "",
  };
}

export type StoreListener = () => void;

export class Store {
  private state: AppState;
  private readonly listeners = new Set<StoreListener>();

  constructor(state: AppState = initialAppState()) {
    this.state = state;
  }

  getState = (): AppState => this.state;

  setState = (partial: Partial<AppState>): void => {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) {
      listener();
    }
  };

  subscribe = (listener: StoreListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}
