import { apiRequest, eventSourceFor, safeApiUrl, responseError } from "../lib/api";
import type { BootstrapResult } from "../lib/bootstrap";
import { ApiError, ERROR_TEXT, friendlyError } from "../lib/errors";
import { newClientIdentifier } from "../lib/ids";
import { chatRunStatusText, jobTypeLabel } from "../lib/labels";
import {
  chatRunEnvelope,
  extractBooks,
  extractJobs,
  extractMessageEnvelope,
  importResponseJob,
  LICENSE_IDENTIFIER_BASES,
  normalizeChatRun,
  normalizeConversation,
  normalizeJob,
  normalizeMessage,
  READY_BOOK_STATUSES,
  RIGHTS_BASES,
  TERMINAL_CHAT_STATUSES,
  TERMINAL_JOB_STATUSES,
} from "../lib/normalize";
import { isRecord, unwrapData } from "../lib/records";
import { normalizeProviderStatus, normalizeSession, providerSource } from "../lib/session";
import { displayText, headerText, internalIdentifier } from "../lib/text";
import type {
  BookSnapshot,
  ChatMessageView,
  ChatReferenceView,
  ChatRunView,
  ImportTabName,
  JobSnapshot,
  PanelMode,
  ViewName,
} from "../lib/types";
import { Store } from "./store";

interface PendingSubmission {
  conversationId: string;
  question: string;
  clientMessageId: string;
}

export interface ControllerRefs {
  chatPanel: HTMLElement | null;
  chatForm: HTMLFormElement | null;
  chatQuestion: HTMLTextAreaElement | null;
  chatBookSelect: HTMLSelectElement | null;
  closeChatButton: HTMLButtonElement | null;
  localImportTab: HTMLButtonElement | null;
  zlibraryImportTab: HTMLButtonElement | null;
}

const VIEW_NAMES: ReadonlySet<string> = new Set([
  "connections",
  "import",
  "jobs",
  "library",
  "reader",
]);

function validRightsBasis(value: string): string | null {
  return RIGHTS_BASES.has(value) ? value : null;
}

export function mergedSubmissionRun(payload: unknown): {
  messages: ChatMessageView[];
  run: ChatRunView | null;
} | null {
  const data = unwrapData(payload);
  if (!isRecord(data)) {
    return null;
  }
  const messages: ChatMessageView[] = [];
  if (isRecord(data["user_message"])) {
    const userMessage = normalizeMessage(data["user_message"], null);
    if (userMessage) {
      messages.push(userMessage);
    }
  }
  if (isRecord(data["assistant_message"])) {
    const assistantMessage = normalizeMessage(data["assistant_message"], data["references"]);
    if (assistantMessage) {
      messages.push(assistantMessage);
    }
  }
  return { messages, run: normalizeChatRun(data["chat_run"]) };
}

export function activeRunPathFromError(error: unknown): string | null {
  if (!(error instanceof ApiError) || !isRecord(error.payload)) {
    return null;
  }
  const topError = responseError(error.payload);
  const data = unwrapData(error.payload);
  const details = isRecord(topError) ? topError["details"] : null;
  const candidates: unknown[] = [
    isRecord(topError) ? topError["active_run_url"] : null,
    isRecord(details) ? details["active_run_url"] : null,
    isRecord(data) ? data["active_run_url"] : null,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    try {
      const url = safeApiUrl(candidate);
      const match = /^\/api\/chat-runs\/([^/]+)$/u.exec(url.pathname);
      if (match && match[1] !== undefined) {
        return decodeURIComponent(match[1]);
      }
    } catch {
      continue;
    }
  }
  return null;
}

export class AppController {
  readonly store: Store;

  readonly refs: ControllerRefs = {
    chatPanel: null,
    chatForm: null,
    chatQuestion: null,
    chatBookSelect: null,
    closeChatButton: null,
    localImportTab: null,
    zlibraryImportTab: null,
  };

  private initialized = false;
  private references = new Map<string, ChatReferenceView[]>();

  private jobStream: EventSource | null = null;
  private jobStreamId: string | null = null;
  private jobPollTimer: number | null = null;
  private jobRefreshTimer: number | null = null;

  private runStream: EventSource | null = null;
  private runStreamId: string | null = null;
  private runPollTimer: number | null = null;
  private runRefreshTimer: number | null = null;
  private retryTimer: number | null = null;
  private retryAvailableAt = 0;

  private submittingQuestion = false;
  private pendingSubmission: PendingSubmission | null = null;
  private composing = false;

  private chatReturnFocus: HTMLElement | null = null;
  private mobileHistoryOwned = false;
  bootstrapResult: BootstrapResult | null = null;

  private desktopMedia: MediaQueryList | null = null;
  private mobileMedia: MediaQueryList | null = null;

  private readonly windowCleanups: Array<() => void> = [];

  constructor(store: Store = new Store()) {
    this.store = store;
  }

  registerRef<K extends keyof ControllerRefs>(key: K, node: ControllerRefs[K]): void {
    this.refs[key] = node;
  }

  // ----- announcements and shared status -------------------------------------

  announce(message: string): void {
    this.store.setState({ liveMessage: "" });
    window.setTimeout(() => {
      this.store.setState({ liveMessage: message });
    }, 20);
  }

  private markRefresh(): void {
    const formatter = new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    this.store.setState({
      lastRefreshText: `Last refresh / 最近刷新：${formatter.format(new Date())}`,
    });
  }

  private setChatState(message: string, status?: string): void {
    this.store.setState({ chatState: { text: message, state: status || "ready" } });
  }

  private renderSession(): void {
    this.store.setState({ sessionDetailOverride: null });
  }

  // ----- navigation ----------------------------------------------------------

  setView(viewName: string, focusHeading: boolean): void {
    if (!VIEW_NAMES.has(viewName)) {
      return;
    }
    const state = this.store.getState();
    this.store.setState({
      currentView: viewName as ViewName,
      viewFocusToken: focusHeading ? state.viewFocusToken + 1 : state.viewFocusToken,
    });
  }

  handleNavView(viewName: ViewName): void {
    this.setView(viewName, true);
    if (viewName === "jobs") {
      void this.refreshJobs();
    }
    if (viewName === "library") {
      void this.refreshBooks();
    }
  }

  // ----- session -------------------------------------------------------------

  async refreshSession(): Promise<void> {
    this.store.setState({ session: { status: "loading" } });
    this.renderSession();
    try {
      const payload = await apiRequest("/api/session");
      this.store.setState({ session: normalizeSession(payload) });
      this.markRefresh();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        this.store.setState({ session: { status: "required" } });
      } else if (error instanceof ApiError && error.status === 0) {
        this.store.setState({ session: { status: "unavailable" } });
      } else {
        this.store.setState({ session: { status: "error" } });
      }
    }
    this.renderSession();
  }

  async refreshAuthStatus(): Promise<void> {
    this.store.setState({
      providers: { notebooklm: { status: "loading" }, zlibrary: { status: "loading" } },
      authRefreshBusy: true,
    });

    try {
      const payload = await apiRequest("/api/auth/status");
      const data = unwrapData(payload);
      this.store.setState({
        providers: {
          notebooklm: normalizeProviderStatus(providerSource(data, "notebooklm")),
          zlibrary: normalizeProviderStatus(providerSource(data, "zlibrary")),
        },
      });
      this.markRefresh();
    } catch (error) {
      const status = error instanceof ApiError && error.status === 0 ? "unavailable" : "error";
      this.store.setState({
        providers: { notebooklm: { status }, zlibrary: { status } },
      });
      if (error instanceof ApiError && error.status === 401) {
        this.store.setState({ session: { status: "required" } });
        this.renderSession();
      }
    } finally {
      this.store.setState({ authRefreshBusy: false });
    }
  }

  async refreshConnections(): Promise<void> {
    await Promise.allSettled([this.refreshSession(), this.refreshAuthStatus()]);
    this.announce("Connection status refreshed / 连接状态已刷新。");
  }

  async logout(): Promise<void> {
    this.store.setState({
      logoutBusy: true,
      sessionDetailOverride: "正在退出本地会话 / Signing out…",
    });
    try {
      await apiRequest("/api/session/logout", { method: "POST" });
      this.stopJobTracking();
      this.stopRunTracking();
      this.store.setState({
        session: { status: "required" },
        jobs: [],
        books: [],
        logoutBusy: false,
      });
      this.resetConversation();
      this.renderSession();
      this.renderBooks();
      this.announce("Signed out / 已退出本地会话。");
    } catch (error) {
      this.renderSession();
      this.store.setState({
        logoutBusy: false,
        sessionDetailOverride: friendlyError(
          error,
          "Could not end the local session / 无法退出本地会话。",
        ),
      });
    }
  }

  // ----- import --------------------------------------------------------------

  setImportTab(tabName: ImportTabName, focusTab: boolean): void {
    this.store.setState({ importTab: tabName });
    if (focusTab) {
      const target = tabName === "local" ? this.refs.localImportTab : this.refs.zlibraryImportTab;
      target?.focus();
    }
  }

  handleImportTabKeydown(event: { key: string; preventDefault: () => void }): void {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    if (event.key === "ArrowLeft" || event.key === "Home") {
      this.setImportTab("local", true);
    } else {
      this.setImportTab("zlibrary", true);
    }
  }

  private byId<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) {
      throw new Error(`Missing element: ${id}`);
    }
    return node as T;
  }

  async submitLocalImport(): Promise<void> {
    const form = this.byId<HTMLFormElement>("local-import-form");
    if (!form.reportValidity()) {
      this.store.setState({
        localImportStatus: { text: ERROR_TEXT["VALIDATION"] as string, state: "error" },
      });
      return;
    }

    const fileInput = this.byId<HTMLInputElement>("local-file");
    const file = fileInput.files && fileInput.files[0];
    const rightsBasis = validRightsBasis(this.byId<HTMLSelectElement>("local-rights-basis").value);
    const profile = headerText(this.byId<HTMLInputElement>("local-notebooklm-profile").value, 128);
    const licenseIdentifier = headerText(
      this.byId<HTMLInputElement>("local-license-identifier").value,
      256,
    );
    const confirmed = this.byId<HTMLInputElement>("local-rights-confirmed").checked;

    if (
      !file
      || !rightsBasis
      || !profile
      || !confirmed
      || (LICENSE_IDENTIFIER_BASES.has(rightsBasis) && !licenseIdentifier)
    ) {
      this.store.setState({
        localImportStatus: { text: ERROR_TEXT["VALIDATION"] as string, state: "error" },
      });
      return;
    }

    const filename = headerText(file.name, 512);
    if (!filename) {
      this.store.setState({
        localImportStatus: {
          text: "The selected file has no usable filename / 文件名无效。",
          state: "error",
        },
      });
      return;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "X-Diandian-Provider": "local",
      "X-Diandian-Filename": filename,
      "X-Diandian-Rights-Basis": rightsBasis,
      "X-Diandian-Rights-Confirmed": "true",
      "X-Diandian-NotebookLM-Profile": profile,
    };
    if (licenseIdentifier) {
      headers["X-Diandian-License-Identifier"] = licenseIdentifier;
    }

    this.store.setState({
      localImportBusy: true,
      localImportStatus: {
        text: "Submitting bytes to the local import queue / 正在提交本地导入任务…",
        state: "working",
      },
    });

    try {
      const payload = await apiRequest("/api/imports", {
        method: "POST",
        headers,
        body: file,
      });
      const job = importResponseJob(payload);
      this.store.setState({
        localImportStatus: {
          text: "Import accepted. Opening the saved job snapshot / 导入已受理。",
          state: "success",
        },
      });
      form.reset();
      this.announce("Local import accepted / 本地导入已受理。");
      await this.moveToImportedJob(job);
    } catch (error) {
      this.store.setState({
        localImportStatus: {
          text: friendlyError(
            error,
            "The local import could not be submitted / 无法提交本地导入。",
          ),
          state: "error",
        },
      });
    } finally {
      this.store.setState({ localImportBusy: false });
    }
  }

  async submitZlibraryImport(): Promise<void> {
    const form = this.byId<HTMLFormElement>("zlibrary-import-form");
    if (!form.reportValidity()) {
      this.store.setState({
        zlibraryImportStatus: { text: ERROR_TEXT["VALIDATION"] as string, state: "error" },
      });
      return;
    }

    const locationValue = this.byId<HTMLInputElement>("zlibrary-location").value.trim();
    const rightsBasis = validRightsBasis(
      this.byId<HTMLSelectElement>("zlibrary-rights-basis").value,
    );
    const title = displayText(this.byId<HTMLInputElement>("zlibrary-title").value, "", 200);
    const author = displayText(this.byId<HTMLInputElement>("zlibrary-author").value, "", 200);
    const zlibraryProfile = displayText(
      this.byId<HTMLInputElement>("zlibrary-profile").value,
      "",
      128,
    );
    const notebooklmProfile = displayText(
      this.byId<HTMLInputElement>("zlibrary-notebooklm-profile").value,
      "",
      128,
    );
    const licenseIdentifier = displayText(
      this.byId<HTMLInputElement>("zlibrary-license-identifier").value,
      "",
      256,
    );
    const confirmed = this.byId<HTMLInputElement>("zlibrary-rights-confirmed").checked;

    let parsedLocation: URL | null;
    try {
      parsedLocation = new URL(locationValue);
    } catch {
      parsedLocation = null;
    }

    if (
      !parsedLocation
      || parsedLocation.protocol !== "https:"
      || Boolean(parsedLocation.username)
      || Boolean(parsedLocation.password)
      || !rightsBasis
      || !title
      || !zlibraryProfile
      || !notebooklmProfile
      || !confirmed
      || (LICENSE_IDENTIFIER_BASES.has(rightsBasis) && !licenseIdentifier)
    ) {
      this.store.setState({
        zlibraryImportStatus: {
          text: "Use an HTTPS location without URL credentials and complete every required attestation field / 请填写不含用户名或密码的 HTTPS 地址并完成确认。",
          state: "error",
        },
      });
      return;
    }

    const body = {
      provider: "zlibrary",
      location: parsedLocation.href,
      zlibrary_profile: zlibraryProfile,
      notebooklm_profile: notebooklmProfile,
      rights_basis: rightsBasis,
      license_identifier: licenseIdentifier || null,
      rights_confirmed: true,
      attestation_version: "zlibrary-rights-v1",
      title,
      author: author || null,
    };

    this.store.setState({
      zlibraryImportBusy: true,
      zlibraryImportStatus: {
        text: "Submitting the attested acquisition / 正在提交已确认的获取任务…",
        state: "working",
      },
    });

    try {
      const payload = await apiRequest("/api/imports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const job = importResponseJob(payload);
      this.store.setState({
        zlibraryImportStatus: {
          text: "Import accepted. Opening the saved job snapshot / 导入已受理。",
          state: "success",
        },
      });
      form.reset();
      this.announce("Z-Library import accepted / 可选连接导入已受理。");
      await this.moveToImportedJob(job);
    } catch (error) {
      this.store.setState({
        zlibraryImportStatus: {
          text: friendlyError(
            error,
            "The acquisition could not be submitted / 无法提交获取任务。",
          ),
          state: "error",
        },
      });
    } finally {
      this.store.setState({ zlibraryImportBusy: false });
    }
  }

  private async moveToImportedJob(job: JobSnapshot | null): Promise<void> {
    this.setView("jobs", false);
    await this.refreshJobs();
    if (job && job.id) {
      const state = this.store.getState();
      const jobs = state.jobs.some((candidate) => candidate.id === job.id)
        ? state.jobs
        : [job, ...state.jobs];
      this.store.setState({ selectedJobId: job.id, jobs });
      await this.selectJob(job.id, false);
    }
  }

  // ----- jobs ----------------------------------------------------------------

  async refreshJobs(): Promise<void> {
    this.store.setState({
      jobsRefreshBusy: true,
      jobsStatus: { text: "Loading saved job snapshots / 正在加载任务快照…", state: "loading" },
    });

    try {
      const payload = await apiRequest("/api/jobs?limit=50");
      const jobs = extractJobs(payload);
      const state = this.store.getState();
      let selectedJobId = state.selectedJobId;
      if (selectedJobId && !jobs.some((job) => job.id === selectedJobId)) {
        selectedJobId = null;
        this.stopJobTracking();
      }
      this.store.setState({
        jobs,
        selectedJobId,
        jobsStatus: {
          text: jobs.length
            ? `${jobs.length} saved job snapshots / 已加载 ${jobs.length} 条任务快照。`
            : "No jobs yet / 暂无任务。",
          state: "ready",
        },
      });
      this.markRefresh();
    } catch (error) {
      this.store.setState({
        jobsStatus: {
          text: friendlyError(error, "Jobs are temporarily unavailable / 任务列表暂时不可用。"),
          state: "error",
        },
      });
      if (error instanceof ApiError && error.status === 401) {
        this.store.setState({ session: { status: "required" } });
        this.renderSession();
      }
    } finally {
      this.store.setState({ jobsRefreshBusy: false });
    }
  }

  private updateJobSnapshot(job: JobSnapshot): void {
    const state = this.store.getState();
    const index = state.jobs.findIndex((candidate) => candidate.id === job.id);
    const jobs = [...state.jobs];
    if (index >= 0) {
      jobs.splice(index, 1, job);
    } else {
      jobs.unshift(job);
    }
    this.store.setState({ jobs });
  }

  async selectJob(jobId: string, announceSelection: boolean): Promise<void> {
    const normalizedId = internalIdentifier(jobId);
    if (!normalizedId) {
      return;
    }
    this.store.setState({
      selectedJobId: normalizedId,
      jobsStatus: {
        text: "Refreshing the selected snapshot / 正在刷新所选任务…",
        state: "loading",
      },
    });

    try {
      const payload = await apiRequest(`/api/jobs/${encodeURIComponent(normalizedId)}`);
      const data = unwrapData(payload);
      const job = normalizeJob(isRecord(data) && isRecord(data["job"]) ? data["job"] : data);
      if (!job) {
        throw new ApiError(200, "INVALID_RESPONSE", null);
      }
      this.updateJobSnapshot(job);
      this.store.setState({
        jobsStatus: {
          text: "Selected job snapshot is current / 所选任务快照已更新。",
          state: "ready",
        },
      });
      this.markRefresh();
      if (TERMINAL_JOB_STATUSES.has(job.status)) {
        this.stopJobTracking();
      } else {
        this.startJobTracking(job.id);
      }
      if (announceSelection) {
        this.announce(`${jobTypeLabel(job)} selected / 已选择任务。`);
      }
    } catch (error) {
      this.store.setState({
        jobsStatus: {
          text: friendlyError(
            error,
            "The selected job snapshot is unavailable / 无法读取所选任务。",
          ),
          state: "error",
        },
      });
    }
  }

  async retryJob(jobId: string): Promise<void> {
    this.store.setState({
      jobRetryBusy: true,
      jobsStatus: { text: "Submitting an explicit retry / 正在提交显式重试…", state: "loading" },
    });
    try {
      await apiRequest(`/api/jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST" });
      this.announce("Job retry accepted / 任务重试已受理。");
      await this.selectJob(jobId, false);
    } catch (error) {
      this.store.setState({
        jobsStatus: {
          text: friendlyError(error, "This job could not be retried / 无法重试该任务。"),
          state: "error",
        },
      });
    } finally {
      this.store.setState({ jobRetryBusy: false });
    }
  }

  private scheduleJobSnapshot(): void {
    if (this.jobRefreshTimer !== null) {
      window.clearTimeout(this.jobRefreshTimer);
    }
    this.jobRefreshTimer = window.setTimeout(() => {
      this.jobRefreshTimer = null;
      const selected = this.store.getState().selectedJobId;
      if (selected) {
        void this.selectJob(selected, false);
      }
    }, 180);
  }

  startJobTracking(jobId: string): void {
    if (this.jobStream && this.jobStreamId === jobId) {
      return;
    }
    this.stopJobTracking();

    let source: EventSource | null;
    try {
      source = eventSourceFor(`/api/jobs/${encodeURIComponent(jobId)}/events`);
    } catch {
      source = null;
    }

    if (source) {
      const invalidate = (): void => this.scheduleJobSnapshot();
      source.addEventListener("message", invalidate);
      for (const eventName of [
        "job.updated",
        "job.snapshot",
        "job.completed",
        "job.failed",
        "job.blocked",
        "job.cancelled",
      ]) {
        source.addEventListener(eventName, invalidate);
      }
      source.addEventListener("error", () => {
        if (this.store.getState().selectedJobId === jobId) {
          this.store.setState({
            jobsStatus: {
              text: "Live updates disconnected; saved snapshots will continue to refresh / 实时连接中断，将继续刷新持久快照。",
              state: "error",
            },
          });
        }
      });
      this.jobStream = source;
      this.jobStreamId = jobId;
    }

    this.jobPollTimer = window.setInterval(() => {
      if (this.store.getState().selectedJobId === jobId) {
        void this.selectJob(jobId, false);
      }
    }, 8000);
  }

  stopJobTracking(): void {
    if (this.jobStream) {
      this.jobStream.close();
      this.jobStream = null;
    }
    this.jobStreamId = null;
    if (this.jobPollTimer !== null) {
      window.clearInterval(this.jobPollTimer);
      this.jobPollTimer = null;
    }
    if (this.jobRefreshTimer !== null) {
      window.clearTimeout(this.jobRefreshTimer);
      this.jobRefreshTimer = null;
    }
  }

  // ----- books ---------------------------------------------------------------

  private renderBooks(): void {
    const state = this.store.getState();
    const previous = state.selectedBookId;
    this.store.setState({ booksRendered: true });

    if (state.books.length === 0) {
      this.store.setState({
        bookSelectDisabled: true,
        loadConversationDisabled: true,
        bookPickerHelp: "Import a book first, then refresh / 请先导入书籍。",
      });
      return;
    }

    const selectable = state.books.filter((book) => READY_BOOK_STATUSES.has(book.status));
    let selectedBookId: string | null;
    if (previous && selectable.some((book) => book.id === previous)) {
      selectedBookId = previous;
    } else if (selectable.length === 1 && selectable[0] !== undefined) {
      selectedBookId = selectable[0].id;
    } else {
      selectedBookId = null;
    }

    this.store.setState({
      selectedBookId,
      bookSelectDisabled: selectable.length === 0,
      loadConversationDisabled: !selectedBookId,
      bookPickerHelp: selectable.length
        ? "Open a ready book to establish or restore its active conversation / 打开已就绪书籍以恢复对话。"
        : "Books exist, but none are ready for chat / 当前没有可对话的已就绪书籍。",
    });
  }

  async refreshBooks(): Promise<void> {
    try {
      const payload = await apiRequest("/api/books?limit=100");
      this.store.setState({ books: extractBooks(payload) });
      this.renderBooks();
      this.markRefresh();
    } catch (error) {
      this.store.setState({ books: [] });
      this.renderBooks();
      this.store.setState({
        bookPickerHelp: friendlyError(
          error,
          "The book list is temporarily unavailable / 书籍列表暂时不可用。",
        ),
      });
    }
  }

  private currentBook(): BookSnapshot | null {
    const state = this.store.getState();
    return state.books.find((book) => book.id === state.selectedBookId) || null;
  }

  onBookSelectionChange(value: string): void {
    const selectedId = internalIdentifier(value);
    this.store.setState({ selectedBookId: selectedId });
    this.resetConversation();
    this.store.setState({
      selectedBookId: selectedId,
      loadConversationDisabled: !selectedId,
    });
    if (selectedId) {
      const book = this.currentBook();
      this.setChatState(
        book ? `Ready to open “${book.title}” / 可打开该书对话。` : "Ready to open / 可打开对话。",
        "ready",
      );
    }
  }

  // ----- conversation --------------------------------------------------------

  resetConversation(): void {
    this.stopRunTracking();
    this.references = new Map();
    this.pendingSubmission = null;
    this.submittingQuestion = false;
    this.retryAvailableAt = 0;
    const state = this.store.getState();
    this.store.setState({
      conversation: null,
      messages: [],
      referencesByMessageId: this.references,
      activeRun: null,
      questionValue: "",
      questionDisabled: true,
      questionPlaceholder: "先选择一本书…",
      sendDisabled: true,
      loadConversationDisabled: !state.selectedBookId,
    });
    this.renderRunActions();
    this.setChatState("请选择一本可用书籍开始对话。", "ready");
  }

  async openConversation(): Promise<void> {
    const book = this.currentBook();
    if (!book || !READY_BOOK_STATUSES.has(book.status)) {
      this.setChatState("Select a ready book first / 请先选择已就绪书籍。", "error");
      return;
    }

    this.store.setState({ loadConversationDisabled: true });
    this.setChatState("Loading the saved conversation / 正在加载对话…", "working");
    this.resetConversation();
    this.store.setState({ selectedBookId: book.id, loadConversationDisabled: true });

    try {
      let payload: unknown;
      try {
        payload = await apiRequest(`/api/books/${encodeURIComponent(book.id)}/conversation`);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) {
          throw error;
        }
        const titlePrefix = "Discuss / 讨论：";
        const title = `${titlePrefix}${book.title}`.slice(0, 180);
        payload = await apiRequest(`/api/books/${encodeURIComponent(book.id)}/conversation`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title,
            default_query_scope: { type: "book" },
          }),
        });
      }

      const conversation = normalizeConversation(payload, this.store.getState().selectedBookId);
      if (!conversation) {
        throw new ApiError(200, "INVALID_RESPONSE", null);
      }
      this.store.setState({
        conversation,
        questionDisabled: false,
        questionPlaceholder: "从这本书里提问…",
        sendDisabled: false,
      });
      this.setChatState(`Conversation ready for “${book.title}” / 对话已就绪。`, "complete");
      await this.loadMessages();
      this.refs.chatQuestion?.focus({ preventScroll: true });
    } catch (error) {
      this.setChatState(
        friendlyError(error, "The conversation could not be opened / 无法打开对话。"),
        "error",
      );
      this.store.setState({ loadConversationDisabled: false });
    }
  }

  private mergeMessages(messages: ChatMessageView[]): void {
    const state = this.store.getState();
    const byMessageId = new Map(state.messages.map((message) => [message.id, message]));
    for (const message of messages) {
      byMessageId.set(message.id, message);
      if (message.references.length) {
        this.references.set(message.id, message.references);
      }
    }
    const sorted = Array.from(byMessageId.values()).sort((left, right) => {
      const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
      const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return left.id.localeCompare(right.id);
    });
    this.store.setState({ messages: sorted, referencesByMessageId: this.references });
  }

  async loadMessages(): Promise<void> {
    const conversation = this.store.getState().conversation;
    if (!conversation) {
      return;
    }
    const conversationId = conversation.id;
    try {
      const payload = await apiRequest(
        `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=50`,
      );
      const current = this.store.getState().conversation;
      if (!current || current.id !== conversationId) {
        return;
      }
      const envelope = extractMessageEnvelope(payload);
      for (const { messageId, reference } of envelope.looseReferences) {
        const existing = this.references.get(messageId) || [];
        existing.push(reference);
        this.references.set(messageId, existing);
      }
      this.mergeMessages(envelope.messages);
      if (envelope.activeRun && !TERMINAL_CHAT_STATUSES.has(envelope.activeRun.status)) {
        this.store.setState({ activeRun: envelope.activeRun });
        this.renderChatRun();
        this.startRunTracking(envelope.activeRun.id);
      }
    } catch (error) {
      this.setChatState(
        friendlyError(error, "Message history is temporarily unavailable / 消息历史暂时不可用。"),
        "error",
      );
    }
  }

  // ----- chat runs -----------------------------------------------------------

  private renderChatRun(): void {
    const state = this.store.getState();
    const run = state.activeRun;
    if (!run) {
      if (state.conversation) {
        this.setChatState("Conversation ready / 对话已就绪。", "complete");
      }
      this.renderRunActions();
      return;
    }
    const status =
      run.status === "failed"
        ? "error"
        : run.status === "completed"
          ? "complete"
          : run.status === "cancelled"
            ? "ready"
            : "working";
    this.setChatState(chatRunStatusText(run), status);
    this.renderRunActions();
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private renderRunActions(): void {
    this.clearRetryTimer();
    const run = this.store.getState().activeRun;
    let showRetry = false;
    let showCancel = false;

    if (run) {
      showCancel = run.status === "queued" || run.status === "running";
      const ambiguous = run.error !== null && run.error.code === "AMBIGUOUS_PROVIDER_OUTCOME";
      showRetry = run.status === "failed" && Boolean(run.error && run.error.retriable) && !ambiguous;
    }

    let retryDisabled = false;
    if (showRetry) {
      const delay = Math.max(0, this.retryAvailableAt - Date.now());
      retryDisabled = delay > 0;
      if (delay > 0) {
        this.retryTimer = window.setTimeout(() => {
          this.retryTimer = null;
          this.renderRunActions();
        }, delay);
      }
    }

    this.store.setState({
      showRetryChat: showRetry,
      showCancelChat: showCancel,
      retryChatDisabled: retryDisabled,
      cancelChatDisabled: false,
    });
  }

  setComposing(composing: boolean): void {
    this.composing = composing;
  }

  handleQuestionKeydown(event: {
    key: string;
    shiftKey: boolean;
    isComposing?: boolean;
    keyCode?: number;
    preventDefault: () => void;
  }): void {
    const composing = this.composing || event.isComposing === true || event.keyCode === 229;
    if (event.key === "Enter" && !event.shiftKey && !composing) {
      event.preventDefault();
      this.refs.chatForm?.requestSubmit();
    }
  }

  async submitQuestion(): Promise<void> {
    const state = this.store.getState();
    if (this.composing || this.submittingQuestion || !state.conversation) {
      return;
    }
    const question = state.questionValue.trim();
    if (!question) {
      const textarea = this.refs.chatQuestion;
      textarea?.setCustomValidity("Please enter a question / 请输入问题。");
      textarea?.reportValidity();
      textarea?.setCustomValidity("");
      return;
    }

    const existing = this.pendingSubmission;
    const clientMessageId =
      existing
      && existing.conversationId === state.conversation.id
      && existing.question === question
        ? existing.clientMessageId
        : newClientIdentifier("msg");
    this.pendingSubmission = {
      conversationId: state.conversation.id,
      question,
      clientMessageId,
    };
    this.submittingQuestion = true;
    this.store.setState({ questionDisabled: true, sendDisabled: true });
    this.setChatState("Submitting the saved command / 正在提交问题…", "working");

    try {
      const payload = await apiRequest(
        `/api/conversations/${encodeURIComponent(state.conversation.id)}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": clientMessageId,
          },
          body: JSON.stringify({
            client_message_id: clientMessageId,
            question,
            query_scope: { type: "book" },
          }),
        },
      );
      const merged = mergedSubmissionRun(payload);
      if (merged) {
        this.mergeMessages(merged.messages);
      }
      const run = merged ? merged.run : null;
      this.pendingSubmission = null;
      this.store.setState({ questionValue: "" });
      if (run) {
        this.store.setState({ activeRun: run });
        this.renderChatRun();
        this.startRunTracking(run.id);
      } else {
        this.setChatState(
          "Question accepted; refreshing saved messages / 问题已受理，正在刷新消息。",
          "working",
        );
      }
      await this.loadMessages();
    } catch (error) {
      const activeRunId = activeRunPathFromError(error);
      if (activeRunId) {
        await this.refreshChatRun(activeRunId);
        this.setChatState(ERROR_TEXT["CONVERSATION_BUSY"] as string, "working");
      } else {
        this.setChatState(
          friendlyError(error, "The question could not be submitted / 无法提交问题。"),
          "error",
        );
        if (!(error instanceof ApiError) || (error.status > 0 && error.status < 500)) {
          this.pendingSubmission = null;
        }
      }
    } finally {
      this.submittingQuestion = false;
      const conversation = this.store.getState().conversation;
      this.store.setState({
        questionDisabled: !conversation,
        sendDisabled: !conversation,
      });
      if (conversation) {
        this.refs.chatQuestion?.focus({ preventScroll: true });
      }
    }
  }

  setQuestionValue(value: string): void {
    this.store.setState({ questionValue: value });
  }

  private scheduleRunSnapshot(): void {
    if (this.runRefreshTimer !== null) {
      window.clearTimeout(this.runRefreshTimer);
    }
    this.runRefreshTimer = window.setTimeout(() => {
      this.runRefreshTimer = null;
      const run = this.store.getState().activeRun;
      if (run) {
        void this.refreshChatRun(run.id);
      }
    }, 180);
  }

  async refreshChatRun(runId: string): Promise<void> {
    const normalizedId = internalIdentifier(runId);
    if (!normalizedId) {
      return;
    }
    try {
      const payload = await apiRequest(`/api/chat-runs/${encodeURIComponent(normalizedId)}`);
      const envelope = chatRunEnvelope(payload);
      if (!envelope.run) {
        throw new ApiError(200, "INVALID_RESPONSE", null);
      }
      this.store.setState({ activeRun: envelope.run });
      if (envelope.assistantMessage) {
        if (envelope.references.length) {
          envelope.assistantMessage.references = envelope.references;
          this.references.set(envelope.assistantMessage.id, envelope.references);
        }
        this.mergeMessages([envelope.assistantMessage]);
      }
      if (envelope.run.error && envelope.run.error.retryAfterMs > 0) {
        this.retryAvailableAt = Date.now() + envelope.run.error.retryAfterMs;
      } else {
        this.retryAvailableAt = 0;
      }
      this.renderChatRun();
      this.markRefresh();

      if (TERMINAL_CHAT_STATUSES.has(envelope.run.status)) {
        this.stopRunTracking(false);
        if (envelope.run.status === "completed") {
          await this.loadMessages();
        }
      }
    } catch (error) {
      this.setChatState(
        friendlyError(error, "The answer snapshot is temporarily unavailable / 回答快照暂时不可用。"),
        "error",
      );
    }
  }

  startRunTracking(runId: string): void {
    if (this.runStream && this.runStreamId === runId) {
      return;
    }
    this.stopRunTracking(false);

    let source: EventSource | null;
    try {
      source = eventSourceFor(`/api/chat-runs/${encodeURIComponent(runId)}/events`);
    } catch {
      source = null;
    }

    if (source) {
      const invalidate = (): void => this.scheduleRunSnapshot();
      source.addEventListener("message", invalidate);
      for (const eventName of [
        "chat_run.updated",
        "chat_run.snapshot",
        "chat_run.completed",
        "chat_run.failed",
        "chat_run.cancelled",
      ]) {
        source.addEventListener(eventName, invalidate);
      }
      source.addEventListener("error", () => {
        const run = this.store.getState().activeRun;
        if (run && run.id === runId && !TERMINAL_CHAT_STATUSES.has(run.status)) {
          this.setChatState(
            "Live updates disconnected; checking saved snapshots / 实时连接中断，将继续读取持久快照。",
            "working",
          );
        }
      });
      this.runStream = source;
      this.runStreamId = runId;
    }

    this.runPollTimer = window.setInterval(() => {
      const run = this.store.getState().activeRun;
      if (run && run.id === runId) {
        void this.refreshChatRun(runId);
      }
    }, 6500);
  }

  stopRunTracking(clearRun?: boolean): void {
    if (this.runStream) {
      this.runStream.close();
      this.runStream = null;
    }
    this.runStreamId = null;
    if (this.runPollTimer !== null) {
      window.clearInterval(this.runPollTimer);
      this.runPollTimer = null;
    }
    if (this.runRefreshTimer !== null) {
      window.clearTimeout(this.runRefreshTimer);
      this.runRefreshTimer = null;
    }
    if (clearRun !== false) {
      this.clearRetryTimer();
      this.store.setState({ activeRun: null });
    }
  }

  async cancelChatRun(): Promise<void> {
    const run = this.store.getState().activeRun;
    if (!run || !["queued", "running"].includes(run.status)) {
      return;
    }
    this.store.setState({ cancelChatDisabled: true });
    this.setChatState(
      "Cancellation requested; the run is not yet claimed cancelled / 已请求取消，尚未确认停止。",
      "working",
    );
    try {
      await apiRequest(`/api/chat-runs/${encodeURIComponent(run.id)}/cancel`, { method: "POST" });
      this.announce("Cancellation request saved / 取消请求已保存。");
      await this.refreshChatRun(run.id);
    } catch (error) {
      this.setChatState(
        friendlyError(error, "The cancellation request was not accepted / 无法提交取消请求。"),
        "error",
      );
      this.store.setState({ cancelChatDisabled: false });
    }
  }

  async retryChatRun(): Promise<void> {
    const run = this.store.getState().activeRun;
    const ambiguous = Boolean(run && run.error && run.error.code === "AMBIGUOUS_PROVIDER_OUTCOME");
    if (!run || run.status !== "failed" || !run.error || !run.error.retriable || ambiguous) {
      return;
    }
    if (Date.now() < this.retryAvailableAt) {
      this.renderRunActions();
      return;
    }

    const clientRetryId = newClientIdentifier("retry");
    this.store.setState({ retryChatDisabled: true });
    this.setChatState("Submitting an explicit answer retry / 正在提交显式重试…", "working");
    try {
      const payload = await apiRequest(`/api/chat-runs/${encodeURIComponent(run.id)}/retry`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": clientRetryId,
        },
        body: JSON.stringify({ client_retry_id: clientRetryId }),
      });
      const envelope = chatRunEnvelope(payload);
      if (envelope.run) {
        this.store.setState({ activeRun: envelope.run });
        this.renderChatRun();
      } else {
        this.setChatState(
          "Answer retry accepted; refreshing the saved snapshot / 回答重试已受理，正在刷新持久快照。",
          "working",
        );
      }
      this.retryAvailableAt = 0;
      const activeRun = this.store.getState().activeRun;
      this.startRunTracking(activeRun ? activeRun.id : run.id);
      await this.refreshChatRun(activeRun ? activeRun.id : run.id);
      this.announce("Answer retry accepted / 回答重试已受理。");
    } catch (error) {
      this.setChatState(
        friendlyError(error, "The answer could not be retried / 无法重试回答。"),
        "error",
      );
      this.store.setState({ retryChatDisabled: false });
    }
  }

  // ----- chat panel layout ---------------------------------------------------

  private currentPanelMode(): PanelMode {
    if (this.desktopMedia?.matches) {
      return "desktop";
    }
    if (this.mobileMedia?.matches) {
      return "mobile";
    }
    return "drawer";
  }

  private currentHistoryIsChat(): boolean {
    const historyState: unknown = window.history.state;
    return isRecord(historyState) && historyState["diandianChat"] === true;
  }

  private applyChatOpenState(open: boolean): void {
    const state = this.store.getState();
    const desktop = state.panelMode === "desktop";
    const effectiveOpen = desktop || open;
    this.store.setState({ chatOpen: effectiveOpen });
    document.body.classList.toggle("chat-open", !desktop && effectiveOpen);
  }

  private pushMobileChatHistory(): void {
    if (this.store.getState().panelMode !== "mobile" || this.currentHistoryIsChat()) {
      return;
    }
    window.history.pushState(
      { diandianChat: true },
      "",
      window.location.pathname + window.location.search,
    );
    this.mobileHistoryOwned = true;
  }

  openChat(trigger?: HTMLElement | null): void {
    if (this.store.getState().panelMode === "desktop") {
      this.refs.chatPanel?.focus({ preventScroll: false });
      return;
    }
    this.chatReturnFocus = trigger || (document.activeElement as HTMLElement | null);
    if (this.store.getState().panelMode === "mobile") {
      this.pushMobileChatHistory();
    }
    this.applyChatOpenState(true);
    window.requestAnimationFrame(() => {
      const select = this.refs.chatBookSelect;
      if (select && !select.disabled) {
        select.focus({ preventScroll: true });
      } else {
        this.refs.closeChatButton?.focus({ preventScroll: true });
      }
    });
  }

  private finishCloseChat(restoreFocus: boolean): void {
    this.applyChatOpenState(false);
    this.mobileHistoryOwned = false;
    if (
      restoreFocus
      && this.chatReturnFocus
      && this.chatReturnFocus.isConnected
      && typeof this.chatReturnFocus.focus === "function"
    ) {
      this.chatReturnFocus.focus({ preventScroll: true });
    }
    this.chatReturnFocus = null;
  }

  closeChat(): void {
    const state = this.store.getState();
    if (state.panelMode === "desktop" || !state.chatOpen) {
      return;
    }
    if (state.panelMode === "mobile" && this.mobileHistoryOwned && this.currentHistoryIsChat()) {
      window.history.back();
      return;
    }
    this.finishCloseChat(true);
  }

  syncPanelMode(): void {
    const nextMode = this.currentPanelMode();
    const previousMode = this.store.getState().panelMode;
    this.store.setState({ panelMode: nextMode });

    if (nextMode !== "mobile" && this.mobileHistoryOwned) {
      if (this.currentHistoryIsChat()) {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
      this.mobileHistoryOwned = false;
    }

    if (nextMode === "desktop") {
      this.applyChatOpenState(true);
      return;
    }

    if (previousMode === "desktop" || previousMode === null) {
      this.finishCloseChat(false);
      return;
    }

    if (nextMode === "mobile" && this.store.getState().chatOpen) {
      this.pushMobileChatHistory();
    }
    this.applyChatOpenState(this.store.getState().chatOpen);
  }

  private focusableInChat(): HTMLElement[] {
    const panel = this.refs.chatPanel;
    if (!panel) {
      return [];
    }
    return Array.from(
      panel.querySelectorAll<HTMLElement>(
        "button:not([disabled]):not([hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ),
    ).filter((node) => !node.hidden && node.getClientRects().length > 0);
  }

  handleChatPanelKeydown(event: {
    key: string;
    shiftKey: boolean;
    preventDefault: () => void;
  }): void {
    const state = this.store.getState();
    if (state.panelMode === "desktop" || !state.chatOpen) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.closeChat();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const focusable = this.focusableInChat();
    if (focusable.length === 0) {
      event.preventDefault();
      this.refs.chatPanel?.focus();
      return;
    }
    const first = focusable[0] as HTMLElement;
    const last = focusable[focusable.length - 1] as HTMLElement;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private handleHistoryChange = (event: PopStateEvent): void => {
    if (this.store.getState().panelMode !== "mobile") {
      return;
    }
    const eventState: unknown = event.state;
    const isChatEntry = isRecord(eventState) && eventState["diandianChat"] === true;
    if (isChatEntry && !this.store.getState().chatOpen) {
      this.mobileHistoryOwned = true;
      this.applyChatOpenState(true);
      this.refs.closeChatButton?.focus({ preventScroll: true });
    } else if (!isChatEntry && this.store.getState().chatOpen) {
      this.finishCloseChat(true);
    }
  };

  // ----- connectivity --------------------------------------------------------

  renderConnectivity(): void {
    this.store.setState({ online: navigator.onLine });
  }

  private handleOnline = async (): Promise<void> => {
    this.renderConnectivity();
    await Promise.allSettled([
      this.refreshSession(),
      this.refreshAuthStatus(),
      this.refreshJobs(),
      this.refreshBooks(),
    ]);
    this.announce("Connection restored; local snapshots refreshed / 连接恢复，已刷新本地快照。");
  };

  private handleOffline = (): void => {
    this.renderConnectivity();
  };

  private handlePageHide = (): void => {
    this.stopJobTracking();
    this.stopRunTracking(false);
  };

  // ----- lifecycle -----------------------------------------------------------

  private wireWindowEvents(): void {
    const onOnline = (): void => {
      void this.handleOnline();
    };
    window.addEventListener("online", onOnline);
    this.windowCleanups.push(() => window.removeEventListener("online", onOnline));

    window.addEventListener("offline", this.handleOffline);
    this.windowCleanups.push(() => window.removeEventListener("offline", this.handleOffline));

    window.addEventListener("popstate", this.handleHistoryChange);
    this.windowCleanups.push(() => window.removeEventListener("popstate", this.handleHistoryChange));

    window.addEventListener("pagehide", this.handlePageHide);
    this.windowCleanups.push(() => window.removeEventListener("pagehide", this.handlePageHide));

    this.desktopMedia = window.matchMedia("(min-width: 1100px)");
    this.mobileMedia = window.matchMedia("(max-width: 719px)");
    const onMediaChange = (): void => this.syncPanelMode();
    for (const media of [this.desktopMedia, this.mobileMedia]) {
      if (typeof media.addEventListener === "function") {
        media.addEventListener("change", onMediaChange);
        this.windowCleanups.push(() => media.removeEventListener("change", onMediaChange));
      } else {
        const legacy = media as MediaQueryList & {
          addListener?: (listener: () => void) => void;
          removeListener?: (listener: () => void) => void;
        };
        legacy.addListener?.(onMediaChange);
        this.windowCleanups.push(() => legacy.removeListener?.(onMediaChange));
      }
    }
  }

  async initialize(bootstrapTask: Promise<BootstrapResult>): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    try {
      this.wireWindowEvents();
      this.setImportTab("local", false);
      this.renderBooks();
      this.syncPanelMode();
      this.renderConnectivity();

      this.bootstrapResult = await bootstrapTask;
      if (this.bootstrapResult.attempted && !this.bootstrapResult.ok) {
        const message = friendlyError(
          this.bootstrapResult.error,
          "Secure session bootstrap failed. Relaunch the local workspace / 安全会话初始化失败，请重新打开。",
        );
        this.store.setState({ sessionDetailOverride: message });
        this.announce(message);
      }

      await Promise.allSettled([
        this.refreshSession(),
        this.refreshAuthStatus(),
        this.refreshJobs(),
        this.refreshBooks(),
      ]);

      if (
        this.bootstrapResult.attempted
        && this.bootstrapResult.ok
        && this.store.getState().session.status === "active"
      ) {
        this.announce("Secure local session established / 安全本地会话已建立。");
      }
    } catch {
      this.store.setState({ session: { status: "error" } });
      this.renderSession();
      this.setChatState("The interface could not finish initialization / 界面初始化失败。", "error");
      this.announce("Interface initialization failed / 界面初始化失败。");
    }
  }

  dispose(): void {
    for (const cleanup of this.windowCleanups.splice(0)) {
      cleanup();
    }
    this.stopJobTracking();
    this.stopRunTracking(false);
    this.clearRetryTimer();
  }
}
