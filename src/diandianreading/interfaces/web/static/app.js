"use strict";

let pendingBootstrapNonce = takeBootstrapNonce();

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const JOB_STATUSES = new Set(["queued", "running", "blocked", "completed", "failed", "cancelled"]);
const JOB_STEPS = new Set([
  "acquiring",
  "storing",
  "preparing",
  "creating_workspace",
  "uploading",
  "processing",
  "verifying",
]);
const CHAT_STATUSES = new Set(["queued", "running", "completed", "failed", "cancelled"]);
const CHAT_PHASES = new Set([
  "resolving_scope",
  "waiting_for_provider",
  "reconciling",
  "finalizing",
]);
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);
const TERMINAL_CHAT_STATUSES = new Set(["completed", "failed", "cancelled"]);
const READY_BOOK_STATUSES = new Set(["ready", "reading", "completed"]);
const RIGHTS_BASES = new Set([
  "owned_copy",
  "public_domain",
  "open_license",
]);
const LICENSE_IDENTIFIER_BASES = new Set(["public_domain", "open_license"]);

const ERROR_TEXT = Object.freeze({
  AUTH_REQUIRED: "Authentication is required / 需要重新认证。",
  VALIDATION: "Some values are invalid. Review the highlighted fields / 请检查输入内容。",
  PAYLOAD_TOO_LARGE: "The request is too large. Choose a smaller file or shorten the question / 请求过大。",
  NOT_FOUND: "The requested local resource is no longer available / 本地资源不存在或已删除。",
  SOURCE_NOT_READY: "The book source is still processing. Check its import job / 书籍来源尚未就绪。",
  REMOTE_RATE_LIMITED: "The remote service is rate-limited. Wait before retrying / 远程服务限流，请稍后重试。",
  REMOTE_UNAVAILABLE: "The remote service is temporarily unavailable / 远程服务暂时不可用。",
  REMOTE_PROTOCOL_DRIFT: "The provider integration needs an update / Provider 集成需要升级。",
  SOURCE_PROCESSING_FAILED: "Source processing failed. Review the related import job / 来源处理失败。",
  CONVERSATION_BUSY: "This conversation already has an active answer run / 当前对话已有回答正在运行。",
  IDEMPOTENCY_CONFLICT: "The saved command no longer matches this request. Refresh before continuing / 幂等请求冲突，请刷新。",
  AMBIGUOUS_PROVIDER_OUTCOME: "The provider outcome is uncertain. Do not retry until reconciliation finishes / 结果仍在核对，暂不可重试。",
  UNEXPECTED: "An unexpected local service error occurred / 本地服务出现意外错误。",
  NETWORK_UNAVAILABLE: "The local API could not be reached / 无法连接本地 API。",
  INVALID_RESPONSE: "The local API returned an unreadable response / 本地 API 返回了无法读取的响应。",
  CSRF_MISSING: "The security token is missing. Refresh or relaunch the local workspace / 缺少安全令牌，请刷新或重新启动。",
});

class ApiError extends Error {
  constructor(status, code, payload) {
    super(code || "API_ERROR");
    this.name = "ApiError";
    this.status = status;
    this.code = code || "API_ERROR";
    this.payload = payload;
  }
}

class UiError extends Error {
  constructor(code) {
    super(code);
    this.name = "UiError";
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unwrapData(payload) {
  if (isRecord(payload) && Object.prototype.hasOwnProperty.call(payload, "data")) {
    return payload.data;
  }
  return payload;
}

function internalIdentifier(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    return null;
  }
  return normalized;
}

function displayText(value, fallback, maxLength) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").trim();
  if (!normalized) {
    return fallback;
  }
  const limit = Number.isInteger(maxLength) ? maxLength : 500;
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

function headerText(value, maxLength) {
  return displayText(value, "", maxLength).replace(/[\r\n]/gu, " ");
}

function knownCode(value) {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/u.test(value)) {
    return null;
  }
  return value;
}

function safeApiUrl(path) {
  const url = new URL(path, window.location.href);
  if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) {
    throw new UiError("INVALID_API_PATH");
  }
  return url;
}

function readCookie(name) {
  const entries = document.cookie ? document.cookie.split(";") : [];
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    const rawName = separator >= 0 ? entry.slice(0, separator) : entry;
    if (rawName.trim() !== name) {
      continue;
    }
    const rawValue = separator >= 0 ? entry.slice(separator + 1) : "";
    try {
      return decodeURIComponent(rawValue);
    } catch (_error) {
      return rawValue;
    }
  }
  return "";
}

function responseError(payload) {
  if (!isRecord(payload)) {
    return null;
  }
  if (isRecord(payload.error)) {
    return payload.error;
  }
  const data = unwrapData(payload);
  if (isRecord(data) && isRecord(data.error)) {
    return data.error;
  }
  return null;
}

async function apiRequest(path, options) {
  const requestOptions = options || {};
  const method = String(requestOptions.method || "GET").toUpperCase();
  const url = safeApiUrl(path);
  const headers = new Headers(requestOptions.headers || {});
  const requireCsrf = requestOptions.requireCsrf !== false;

  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }

  if (MUTATING_METHODS.has(method)) {
    const csrfToken = readCookie("diandian_csrf");
    if (!csrfToken && requireCsrf) {
      throw new UiError("CSRF_MISSING");
    }
    if (csrfToken) {
      headers.set("X-CSRF-Token", csrfToken);
    }
  }

  let response;
  try {
    response = await fetch(url.pathname + url.search, {
      method,
      headers,
      body: requestOptions.body,
      signal: requestOptions.signal,
      credentials: "include",
      mode: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  } catch (_error) {
    throw new ApiError(0, "NETWORK_UNAVAILABLE", null);
  }

  let payload = null;
  if (response.status !== 204) {
    const contentType = response.headers.get("Content-Type") || "";
    if (contentType.toLowerCase().includes("application/json")) {
      try {
        payload = await response.json();
      } catch (_error) {
        if (response.ok) {
          throw new ApiError(response.status, "INVALID_RESPONSE", null);
        }
      }
    }
  }

  if (!response.ok) {
    const error = responseError(payload);
    const code = knownCode(error && error.code) || httpStatusCode(response.status);
    throw new ApiError(response.status, code, payload);
  }

  return payload;
}

function httpStatusCode(status) {
  if (status === 401) {
    return "AUTH_REQUIRED";
  }
  if (status === 404) {
    return "NOT_FOUND";
  }
  if (status === 413) {
    return "PAYLOAD_TOO_LARGE";
  }
  if (status === 422) {
    return "VALIDATION";
  }
  return "API_ERROR";
}

function takeBootstrapNonce() {
  const fragment = window.location.hash;
  let nonce = null;

  if (fragment) {
    try {
      const parameters = new URLSearchParams(fragment.slice(1));
      const candidate = parameters.get("bootstrap");
      if (candidate && candidate.length <= 4096) {
        nonce = candidate;
      }
    } finally {
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname + window.location.search,
      );
    }
  }

  return nonce;
}

async function exchangeBootstrapNonce(nonceValue) {
  let nonce = nonceValue;
  try {
    await apiRequest("/api/session/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce }),
      requireCsrf: false,
    });
    return { attempted: true, ok: true, error: null };
  } catch (error) {
    return { attempted: true, ok: false, error };
  } finally {
    nonce = "";
  }
}

const bootstrapTask = (() => {
  let nonce = pendingBootstrapNonce;
  pendingBootstrapNonce = "";
  if (!nonce) {
    return Promise.resolve({ attempted: false, ok: true, error: null });
  }
  const exchange = exchangeBootstrapNonce(nonce);
  nonce = "";
  return exchange;
})();

function byId(id) {
  return document.getElementById(id);
}

function createNode(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) {
    node.className = className;
  }
  if (text !== undefined && text !== null) {
    node.textContent = String(text);
  }
  return node;
}

function appendText(parent, tagName, className, text) {
  const node = createNode(tagName, className, text);
  parent.append(node);
  return node;
}

const elements = {
  appShell: byId("app-shell"),
  workspace: byId("workspace-shell"),
  main: byId("main-content"),
  navButtons: Array.from(document.querySelectorAll("[data-view]")),
  viewPanels: Array.from(document.querySelectorAll("[data-view-panel]")),
  navChatButton: byId("nav-chat-button"),
  openChatButton: byId("open-chat-button"),
  closeChatButton: byId("close-chat-button"),
  chatBackdrop: byId("chat-backdrop"),
  chatPanel: byId("chat-panel"),
  connectivityBanner: byId("connectivity-banner"),
  connectivityTitle: byId("connectivity-title"),
  connectivityMessage: byId("connectivity-message"),
  sessionPill: byId("session-pill"),
  sessionPillText: byId("session-pill-text"),
  sessionDetail: byId("session-detail"),
  logoutButton: byId("logout-button"),
  refreshConnectionsButton: byId("refresh-connections-button"),
  notebooklmStatus: byId("notebooklm-status"),
  notebooklmDescription: byId("notebooklm-description"),
  zlibraryStatus: byId("zlibrary-status"),
  zlibraryDescription: byId("zlibrary-description"),
  localImportTab: byId("local-import-tab"),
  zlibraryImportTab: byId("zlibrary-import-tab"),
  localImportPanel: byId("local-import-panel"),
  zlibraryImportPanel: byId("zlibrary-import-panel"),
  localImportForm: byId("local-import-form"),
  zlibraryImportForm: byId("zlibrary-import-form"),
  localImportStatus: byId("local-import-status"),
  zlibraryImportStatus: byId("zlibrary-import-status"),
  refreshJobsButton: byId("refresh-jobs-button"),
  jobsStatus: byId("jobs-status"),
  jobList: byId("job-list"),
  jobDetailEmpty: byId("job-detail-empty"),
  jobDetailContent: byId("job-detail-content"),
  lastRefreshText: byId("last-refresh-text"),
  chatBookSelect: byId("chat-book-select"),
  loadConversationButton: byId("load-conversation-button"),
  bookPickerHelp: byId("book-picker-help"),
  chatState: byId("chat-state"),
  messageLog: byId("message-log"),
  chatForm: byId("chat-form"),
  chatQuestion: byId("chat-question"),
  sendChatButton: byId("send-chat-button"),
  runActions: byId("run-actions"),
  retryChatButton: byId("retry-chat-button"),
  cancelChatButton: byId("cancel-chat-button"),
  globalLive: byId("global-live"),
};

const desktopMedia = window.matchMedia("(min-width: 1100px)");
const mobileMedia = window.matchMedia("(max-width: 719px)");

const state = {
  currentView: "connections",
  session: { status: "loading" },
  providers: {
    notebooklm: { status: "loading" },
    zlibrary: { status: "loading" },
  },
  jobs: [],
  selectedJobId: null,
  jobStream: null,
  jobStreamId: null,
  jobPollTimer: null,
  jobRefreshTimer: null,
  books: [],
  selectedBookId: null,
  conversation: null,
  messages: [],
  referencesByMessageId: new Map(),
  activeRun: null,
  runStream: null,
  runStreamId: null,
  runPollTimer: null,
  runRefreshTimer: null,
  retryTimer: null,
  retryAvailableAt: 0,
  submittingQuestion: false,
  pendingSubmission: null,
  composing: false,
  panelMode: null,
  chatOpen: false,
  chatReturnFocus: null,
  mobileHistoryOwned: false,
  bootstrapResult: null,
};

function announce(message) {
  elements.globalLive.textContent = "";
  window.setTimeout(() => {
    elements.globalLive.textContent = message;
  }, 20);
}

function friendlyError(error, fallback) {
  const code = error && typeof error.code === "string" ? error.code : "";
  if (Object.prototype.hasOwnProperty.call(ERROR_TEXT, code)) {
    return ERROR_TEXT[code];
  }
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return ERROR_TEXT.AUTH_REQUIRED;
    }
    if (error.status === 403) {
      return "The local security check rejected this request / 本地安全校验拒绝了请求。";
    }
    if (error.status >= 500) {
      return "The local service is temporarily unavailable / 本地服务暂时不可用。";
    }
  }
  return fallback;
}

function markRefresh() {
  const formatter = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  elements.lastRefreshText.textContent = `Last refresh / 最近刷新：${formatter.format(new Date())}`;
}

function setView(viewName, focusHeading) {
  if (!new Set(["connections", "import", "jobs"]).has(viewName)) {
    return;
  }
  state.currentView = viewName;

  for (const panel of elements.viewPanels) {
    panel.hidden = panel.dataset.viewPanel !== viewName;
  }

  for (const button of elements.navButtons) {
    const active = button.dataset.view === viewName;
    button.classList.toggle("is-active", active);
    if (active) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  }

  if (focusHeading) {
    const panel = elements.viewPanels.find((candidate) => candidate.dataset.viewPanel === viewName);
    const heading = panel ? panel.querySelector("h1") : null;
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: false });
    }
  }
}

function wireNavigation() {
  for (const button of elements.navButtons) {
    button.addEventListener("click", () => {
      setView(button.dataset.view, true);
      if (button.dataset.view === "jobs") {
        void refreshJobs();
      }
    });
  }

  elements.navChatButton.addEventListener("click", () => openChat(elements.navChatButton));
  elements.openChatButton.addEventListener("click", () => openChat(elements.openChatButton));
  elements.closeChatButton.addEventListener("click", () => closeChat());
  elements.chatBackdrop.addEventListener("click", () => closeChat());
}

function providerSource(data, providerName) {
  if (Array.isArray(data)) {
    return data.find((item) => {
      if (!isRecord(item)) {
        return false;
      }
      return item.provider === providerName || item.name === providerName;
    }) || null;
  }
  if (!isRecord(data)) {
    return null;
  }
  if (isRecord(data.providers)) {
    return data.providers[providerName] || null;
  }
  return data[providerName] || null;
}

function normalizeProviderStatus(value) {
  if (!isRecord(value)) {
    return { status: "unknown" };
  }

  if (value.authenticated === true || value.connected === true || value.healthy === true) {
    return { status: "connected" };
  }
  if (value.enabled === false || value.available === false) {
    return { status: "unavailable" };
  }
  if (value.authenticated === false || value.connected === false) {
    return { status: "required" };
  }

  const rawStatus = typeof value.status === "string"
    ? value.status.toLowerCase()
    : typeof value.state === "string"
      ? value.state.toLowerCase()
      : "";

  if (["ok", "ready", "healthy", "authenticated", "connected"].includes(rawStatus)) {
    return { status: "connected" };
  }
  if (["auth_required", "expired", "unauthenticated", "disconnected", "missing"].includes(rawStatus)) {
    return { status: "required" };
  }
  if (["disabled", "unavailable", "not_configured"].includes(rawStatus)) {
    return { status: "unavailable" };
  }
  if (["error", "failed", "unhealthy"].includes(rawStatus)) {
    return { status: "error" };
  }
  return { status: "unknown" };
}

function renderProvider(providerName, normalized) {
  const isNotebook = providerName === "notebooklm";
  const statusElement = isNotebook ? elements.notebooklmStatus : elements.zlibraryStatus;
  const descriptionElement = isNotebook
    ? elements.notebooklmDescription
    : elements.zlibraryDescription;

  const copy = {
    connected: {
      badge: "Connected / 已连接",
      description: "Authentication is available for local jobs / 本地任务可使用认证连接。",
    },
    required: {
      badge: "Authentication required / 需要认证",
      description: "Run the local login command, then refresh this page / 请先在本机完成登录。",
    },
    unavailable: {
      badge: "Unavailable or disabled / 不可用或未启用",
      description: "This optional connection is not currently available / 当前连接未配置或已禁用。",
    },
    error: {
      badge: "Connection error / 连接错误",
      description: "The local service could not verify this connection / 本地服务无法验证连接。",
    },
    unknown: {
      badge: "Status unknown / 状态未知",
      description: "The API did not provide a recognized authentication state / API 未返回可识别状态。",
    },
    loading: {
      badge: "Checking / 检查中",
      description: "Reading local authentication health / 正在读取本地认证状态。",
    },
  };

  const selected = copy[normalized.status] || copy.unknown;
  statusElement.dataset.state = normalized.status;
  statusElement.textContent = selected.badge;
  descriptionElement.textContent = selected.description;
}

function normalizeSession(payload) {
  const data = unwrapData(payload);
  if (!isRecord(data)) {
    return { status: "active" };
  }
  if (data.authenticated === false || data.active === false) {
    return { status: "required" };
  }
  const rawStatus = typeof data.status === "string" ? data.status.toLowerCase() : "";
  if (["expired", "revoked"].includes(rawStatus)) {
    return { status: "expired" };
  }
  if (["required", "unauthenticated", "missing"].includes(rawStatus)) {
    return { status: "required" };
  }
  return { status: "active" };
}

function renderSession() {
  const copy = {
    loading: {
      pill: "Checking session / 检查会话",
      detail: "正在验证本地浏览器会话。",
    },
    active: {
      pill: "Session active / 会话有效",
      detail: "Browser session is active and protected by same-origin cookies / 浏览器会话有效。",
    },
    required: {
      pill: "Session required / 需要会话",
      detail: "Launch this workspace from the local application to establish a secure session / 请从本地应用重新打开工作区。",
    },
    expired: {
      pill: "Session expired / 会话过期",
      detail: "The browser session has expired or was revoked. Relaunch the local workspace / 会话已过期或撤销。",
    },
    unavailable: {
      pill: "API unavailable / API 不可用",
      detail: "The local API could not be reached. The interface remains available for retry / 暂时无法连接本地 API。",
    },
    error: {
      pill: "Session error / 会话错误",
      detail: "The local service rejected the session check / 本地服务拒绝了会话检查。",
    },
  };
  const selected = copy[state.session.status] || copy.error;
  elements.sessionPill.dataset.state = state.session.status;
  elements.sessionPillText.textContent = selected.pill;
  elements.sessionDetail.textContent = selected.detail;
  elements.logoutButton.disabled = state.session.status !== "active";
}

async function refreshSession() {
  state.session = { status: "loading" };
  renderSession();
  try {
    const payload = await apiRequest("/api/session");
    state.session = normalizeSession(payload);
    markRefresh();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      state.session = { status: "required" };
    } else if (error instanceof ApiError && error.status === 0) {
      state.session = { status: "unavailable" };
    } else {
      state.session = { status: "error" };
    }
  }
  renderSession();
}

async function refreshAuthStatus() {
  state.providers.notebooklm = { status: "loading" };
  state.providers.zlibrary = { status: "loading" };
  renderProvider("notebooklm", state.providers.notebooklm);
  renderProvider("zlibrary", state.providers.zlibrary);
  elements.refreshConnectionsButton.disabled = true;

  try {
    const payload = await apiRequest("/api/auth/status");
    const data = unwrapData(payload);
    state.providers.notebooklm = normalizeProviderStatus(providerSource(data, "notebooklm"));
    state.providers.zlibrary = normalizeProviderStatus(providerSource(data, "zlibrary"));
    markRefresh();
  } catch (error) {
    const status = error instanceof ApiError && error.status === 0 ? "unavailable" : "error";
    state.providers.notebooklm = { status };
    state.providers.zlibrary = { status };
    if (error instanceof ApiError && error.status === 401) {
      state.session = { status: "required" };
      renderSession();
    }
  } finally {
    elements.refreshConnectionsButton.disabled = false;
    renderProvider("notebooklm", state.providers.notebooklm);
    renderProvider("zlibrary", state.providers.zlibrary);
  }
}

async function refreshConnections() {
  await Promise.allSettled([refreshSession(), refreshAuthStatus()]);
  announce("Connection status refreshed / 连接状态已刷新。");
}

async function logout() {
  elements.logoutButton.disabled = true;
  elements.sessionDetail.textContent = "正在退出本地会话 / Signing out…";
  try {
    await apiRequest("/api/session/logout", { method: "POST" });
    stopJobTracking();
    stopRunTracking();
    state.session = { status: "required" };
    state.jobs = [];
    state.books = [];
    resetConversation();
    renderSession();
    renderJobs();
    renderBooks();
    announce("Signed out / 已退出本地会话。");
  } catch (error) {
    renderSession();
    elements.sessionDetail.textContent = friendlyError(
      error,
      "Could not end the local session / 无法退出本地会话。",
    );
  }
}

function setImportTab(tabName, focusTab) {
  const localActive = tabName === "local";
  elements.localImportTab.classList.toggle("is-active", localActive);
  elements.localImportTab.setAttribute("aria-selected", String(localActive));
  elements.localImportTab.tabIndex = localActive ? 0 : -1;
  elements.zlibraryImportTab.classList.toggle("is-active", !localActive);
  elements.zlibraryImportTab.setAttribute("aria-selected", String(!localActive));
  elements.zlibraryImportTab.tabIndex = localActive ? -1 : 0;
  elements.localImportPanel.hidden = !localActive;
  elements.zlibraryImportPanel.hidden = localActive;
  if (focusTab) {
    (localActive ? elements.localImportTab : elements.zlibraryImportTab).focus();
  }
}

function handleImportTabKeydown(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    return;
  }
  event.preventDefault();
  if (event.key === "ArrowLeft" || event.key === "Home") {
    setImportTab("local", true);
  } else {
    setImportTab("zlibrary", true);
  }
}

function setFormBusy(form, busy) {
  form.setAttribute("aria-busy", String(busy));
  const controls = Array.from(form.elements);
  for (const control of controls) {
    control.disabled = busy;
  }
}

function validRightsBasis(value) {
  return RIGHTS_BASES.has(value) ? value : null;
}

function importResponseJob(payload) {
  const data = unwrapData(payload);
  if (!isRecord(data)) {
    return null;
  }
  if (isRecord(data.job)) {
    return normalizeJob(data.job);
  }
  const direct = normalizeJob(data);
  if (direct) {
    return direct;
  }
  const jobId = internalIdentifier(data.job_id);
  if (!jobId) {
    return null;
  }
  return normalizeJob({ id: jobId, status: "queued", job_type: "import_book" });
}

async function moveToImportedJob(job) {
  setView("jobs", false);
  await refreshJobs();
  if (job && job.id) {
    state.selectedJobId = job.id;
    if (!state.jobs.some((candidate) => candidate.id === job.id)) {
      state.jobs.unshift(job);
    }
    renderJobs();
    await selectJob(job.id, false);
  }
}

async function submitLocalImport(event) {
  event.preventDefault();
  const form = elements.localImportForm;
  if (!form.reportValidity()) {
    elements.localImportStatus.dataset.state = "error";
    elements.localImportStatus.textContent = ERROR_TEXT.VALIDATION;
    return;
  }

  const fileInput = byId("local-file");
  const file = fileInput.files && fileInput.files[0];
  const rightsBasis = validRightsBasis(byId("local-rights-basis").value);
  const profile = headerText(byId("local-notebooklm-profile").value, 128);
  const licenseIdentifier = headerText(byId("local-license-identifier").value, 256);
  const confirmed = byId("local-rights-confirmed").checked;

  if (
    !file
    || !rightsBasis
    || !profile
    || !confirmed
    || (LICENSE_IDENTIFIER_BASES.has(rightsBasis) && !licenseIdentifier)
  ) {
    elements.localImportStatus.dataset.state = "error";
    elements.localImportStatus.textContent = ERROR_TEXT.VALIDATION;
    return;
  }

  const filename = headerText(file.name, 512);
  if (!filename) {
    elements.localImportStatus.dataset.state = "error";
    elements.localImportStatus.textContent = "The selected file has no usable filename / 文件名无效。";
    return;
  }

  const headers = {
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

  setFormBusy(form, true);
  elements.localImportStatus.dataset.state = "working";
  elements.localImportStatus.textContent = "Submitting bytes to the local import queue / 正在提交本地导入任务…";

  try {
    const payload = await apiRequest("/api/imports", {
      method: "POST",
      headers,
      body: file,
    });
    const job = importResponseJob(payload);
    elements.localImportStatus.dataset.state = "success";
    elements.localImportStatus.textContent = "Import accepted. Opening the saved job snapshot / 导入已受理。";
    form.reset();
    announce("Local import accepted / 本地导入已受理。");
    await moveToImportedJob(job);
  } catch (error) {
    elements.localImportStatus.dataset.state = "error";
    elements.localImportStatus.textContent = friendlyError(
      error,
      "The local import could not be submitted / 无法提交本地导入。",
    );
  } finally {
    setFormBusy(form, false);
  }
}

async function submitZlibraryImport(event) {
  event.preventDefault();
  const form = elements.zlibraryImportForm;
  if (!form.reportValidity()) {
    elements.zlibraryImportStatus.dataset.state = "error";
    elements.zlibraryImportStatus.textContent = ERROR_TEXT.VALIDATION;
    return;
  }

  const locationValue = byId("zlibrary-location").value.trim();
  const rightsBasis = validRightsBasis(byId("zlibrary-rights-basis").value);
  const title = displayText(byId("zlibrary-title").value, "", 200);
  const author = displayText(byId("zlibrary-author").value, "", 200);
  const zlibraryProfile = displayText(byId("zlibrary-profile").value, "", 128);
  const notebooklmProfile = displayText(byId("zlibrary-notebooklm-profile").value, "", 128);
  const licenseIdentifier = displayText(byId("zlibrary-license-identifier").value, "", 256);
  const confirmed = byId("zlibrary-rights-confirmed").checked;

  let parsedLocation;
  try {
    parsedLocation = new URL(locationValue);
  } catch (_error) {
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
    elements.zlibraryImportStatus.dataset.state = "error";
    elements.zlibraryImportStatus.textContent = "Use an HTTPS location without URL credentials and complete every required attestation field / 请填写不含用户名或密码的 HTTPS 地址并完成确认。";
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

  setFormBusy(form, true);
  elements.zlibraryImportStatus.dataset.state = "working";
  elements.zlibraryImportStatus.textContent = "Submitting the attested acquisition / 正在提交已确认的获取任务…";

  try {
    const payload = await apiRequest("/api/imports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const job = importResponseJob(payload);
    elements.zlibraryImportStatus.dataset.state = "success";
    elements.zlibraryImportStatus.textContent = "Import accepted. Opening the saved job snapshot / 导入已受理。";
    form.reset();
    announce("Z-Library import accepted / 可选连接导入已受理。");
    await moveToImportedJob(job);
  } catch (error) {
    elements.zlibraryImportStatus.dataset.state = "error";
    elements.zlibraryImportStatus.textContent = friendlyError(
      error,
      "The acquisition could not be submitted / 无法提交获取任务。",
    );
  } finally {
    setFormBusy(form, false);
  }
}

function firstArray(value, keys) {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return [];
  }
  for (const key of keys) {
    if (Array.isArray(value[key])) {
      return value[key];
    }
  }
  return [];
}

function normalizeJob(raw) {
  if (!isRecord(raw)) {
    return null;
  }
  const id = internalIdentifier(raw.id || raw.job_id);
  if (!id) {
    return null;
  }
  const rawStatus = typeof raw.status === "string" ? raw.status.toLowerCase() : "unknown";
  const status = JOB_STATUSES.has(rawStatus) ? rawStatus : "unknown";
  const rawStep = typeof raw.current_step === "string" ? raw.current_step.toLowerCase() : null;
  const currentStep = rawStep && JOB_STEPS.has(rawStep) ? rawStep : null;
  const blockedReason = ["AUTH_REQUIRED", "REMOTE_OUTCOME_AMBIGUOUS"].includes(raw.blocked_reason)
    ? raw.blocked_reason
    : null;
  const errorCode = knownCode(raw.last_error_code || (isRecord(raw.error) && raw.error.code));
  const progressCurrent = Number.isInteger(raw.progress_current) && raw.progress_current >= 0
    ? raw.progress_current
    : null;
  const progressTotal = Number.isInteger(raw.progress_total) && raw.progress_total > 0
    ? raw.progress_total
    : null;
  const attempt = Number.isInteger(raw.attempt) && raw.attempt > 0 ? raw.attempt : null;

  return {
    id,
    title: displayText(raw.book_title || raw.title, "", 180),
    jobType: typeof raw.job_type === "string" ? raw.job_type : "",
    status,
    currentStep,
    blockedReason,
    errorCode,
    retriable: raw.retriable === true || (isRecord(raw.error) && raw.error.retriable === true),
    cancelRequestedAt: typeof raw.cancel_requested_at === "string" ? raw.cancel_requested_at : null,
    createdAt: typeof raw.created_at === "string" ? raw.created_at : null,
    updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : null,
    completedAt: typeof raw.completed_at === "string" ? raw.completed_at : null,
    progressCurrent: progressTotal !== null ? progressCurrent : null,
    progressTotal: progressCurrent !== null ? progressTotal : null,
    attempt,
  };
}

function extractJobs(payload) {
  const data = unwrapData(payload);
  return firstArray(data, ["jobs", "items", "results"])
    .map(normalizeJob)
    .filter(Boolean);
}

function jobTypeLabel(job) {
  if (job.title) {
    return job.title;
  }
  const labels = {
    import_book: "Book import / 书籍导入",
    local_import: "Local book import / 本地书籍导入",
    zlibrary_import: "Connected book import / 连接书籍导入",
    acquire_zlibrary: "Connected acquisition / 连接资料获取",
    generate_content: "Content generation / 内容生成",
  };
  return labels[job.jobType] || "Background job / 后台任务";
}

function jobStatusLabel(status) {
  const labels = {
    queued: "Queued / 已排队",
    running: "Running / 运行中",
    blocked: "Blocked / 已阻塞",
    completed: "Completed / 已完成",
    failed: "Failed / 失败",
    cancelled: "Cancelled / 已取消",
    unknown: "Unknown / 未知",
  };
  return labels[status] || labels.unknown;
}

function jobStepLabel(step) {
  const labels = {
    acquiring: "Acquiring source / 获取资料",
    storing: "Storing verified bytes / 保存已验证文件",
    preparing: "Preparing document / 处理文档",
    creating_workspace: "Creating knowledge workspace / 创建知识空间",
    uploading: "Uploading prepared source / 上传处理后来源",
    processing: "Waiting for source processing / 等待来源处理",
    verifying: "Verifying completion / 验证完成状态",
  };
  return step ? labels[step] || "Working / 处理中" : "Waiting to start / 等待开始";
}

function formatTime(value) {
  if (!value) {
    return "Not reported / 未提供";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Not reported / 未提供";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function renderJobs() {
  elements.jobList.replaceChildren();

  if (state.jobs.length === 0) {
    const empty = createNode("li", "job-list-empty", "No jobs found / 暂无任务。导入书籍后会在这里显示持久状态。");
    elements.jobList.append(empty);
  } else {
    const fragment = document.createDocumentFragment();
    for (const job of state.jobs) {
      const item = createNode("li", "job-list-item");
      const button = createNode("button", "job-card-button");
      button.type = "button";
      button.setAttribute("aria-pressed", String(job.id === state.selectedJobId));
      button.addEventListener("click", () => void selectJob(job.id, true));

      appendText(button, "span", "job-card-title", jobTypeLabel(job));
      const badge = appendText(button, "span", "status-badge", jobStatusLabel(job.status));
      badge.dataset.state = job.status;
      appendText(button, "span", "job-card-meta", `Updated / 更新：${formatTime(job.updatedAt || job.createdAt)}`);
      appendText(button, "span", "job-card-step", jobStepLabel(job.currentStep));
      item.append(button);
      fragment.append(item);
    }
    elements.jobList.append(fragment);
  }

  const selected = state.jobs.find((job) => job.id === state.selectedJobId) || null;
  renderJobDetail(selected);
}

function addFact(list, term, description) {
  appendText(list, "dt", "", term);
  appendText(list, "dd", "", description);
}

function jobBlockedText(reason) {
  if (reason === "AUTH_REQUIRED") {
    return "Authentication is required. Reconnect the affected provider, then refresh this job / 需要重新认证后再刷新任务。";
  }
  if (reason === "REMOTE_OUTCOME_AMBIGUOUS") {
    return "The remote outcome is being reconciled. Do not retry blindly / 远程结果不确定，完成核对前不要重试。";
  }
  return "This job is blocked and needs an external action / 任务需要外部操作后才能继续。";
}

function jobErrorText(job) {
  if (job.errorCode && Object.prototype.hasOwnProperty.call(ERROR_TEXT, job.errorCode)) {
    return ERROR_TEXT[job.errorCode];
  }
  return "The job failed. Review authentication and retry eligibility / 任务失败，请检查认证与重试条件。";
}

function renderJobDetail(job) {
  elements.jobDetailContent.replaceChildren();
  elements.jobDetailEmpty.hidden = Boolean(job);
  elements.jobDetailContent.hidden = !job;

  if (!job) {
    return;
  }

  const article = createNode("article", "job-detail");
  const heading = createNode("div", "job-detail-heading");
  const headingCopy = createNode("div");
  appendText(headingCopy, "h2", "", jobTypeLabel(job));
  appendText(headingCopy, "p", "", `Saved snapshot · Updated ${formatTime(job.updatedAt || job.createdAt)}`);
  const badge = appendText(heading, "span", "status-badge", jobStatusLabel(job.status));
  badge.dataset.state = job.status;
  heading.prepend(headingCopy);
  article.append(heading);

  const facts = createNode("dl", "job-facts");
  addFact(facts, "Status / 状态", jobStatusLabel(job.status));
  addFact(facts, "Current step / 当前步骤", jobStepLabel(job.currentStep));
  if (job.attempt !== null) {
    addFact(facts, "Attempt / 尝试次数", String(job.attempt));
  }
  if (job.progressCurrent !== null && job.progressTotal !== null) {
    addFact(
      facts,
      "Reported work / 已报告处理量",
      `${job.progressCurrent} of ${job.progressTotal} units / ${job.progressCurrent} / ${job.progressTotal} 个单元`,
    );
  }
  addFact(facts, "Created / 创建", formatTime(job.createdAt));
  if (job.completedAt) {
    addFact(facts, "Finished / 结束", formatTime(job.completedAt));
  }
  if (job.cancelRequestedAt) {
    addFact(
      facts,
      "Cancellation / 取消",
      `Requested at ${formatTime(job.cancelRequestedAt)}; this does not claim the remote work already stopped / 已请求取消，不代表远程操作已停止`,
    );
  }
  article.append(facts);

  if (job.status === "blocked") {
    const callout = appendText(article, "p", "job-callout", jobBlockedText(job.blockedReason));
    callout.dataset.state = "warning";
  }
  if (job.status === "failed") {
    const callout = appendText(article, "p", "job-callout", jobErrorText(job));
    callout.dataset.state = "error";
  }

  const actions = createNode("div", "job-detail-actions");
  const refreshButton = createNode("button", "button button-secondary", "Refresh snapshot / 刷新快照");
  refreshButton.type = "button";
  refreshButton.addEventListener("click", () => void selectJob(job.id, false));
  actions.append(refreshButton);

  if (job.status === "failed" && job.retriable) {
    const retryButton = createNode("button", "button button-primary", "Retry job / 重试任务");
    retryButton.type = "button";
    retryButton.addEventListener("click", () => void retryJob(job.id, retryButton));
    actions.append(retryButton);
  }
  article.append(actions);
  elements.jobDetailContent.append(article);
}

async function refreshJobs() {
  elements.refreshJobsButton.disabled = true;
  elements.jobsStatus.dataset.state = "loading";
  elements.jobsStatus.textContent = "Loading saved job snapshots / 正在加载任务快照…";

  try {
    const payload = await apiRequest("/api/jobs?limit=50");
    state.jobs = extractJobs(payload);
    if (state.selectedJobId && !state.jobs.some((job) => job.id === state.selectedJobId)) {
      state.selectedJobId = null;
      stopJobTracking();
    }
    elements.jobsStatus.dataset.state = "ready";
    elements.jobsStatus.textContent = state.jobs.length
      ? `${state.jobs.length} saved job snapshots / 已加载 ${state.jobs.length} 条任务快照。`
      : "No jobs yet / 暂无任务。";
    renderJobs();
    markRefresh();
  } catch (error) {
    elements.jobsStatus.dataset.state = "error";
    elements.jobsStatus.textContent = friendlyError(
      error,
      "Jobs are temporarily unavailable / 任务列表暂时不可用。",
    );
    if (error instanceof ApiError && error.status === 401) {
      state.session = { status: "required" };
      renderSession();
    }
    if (state.jobs.length === 0) {
      renderJobs();
    }
  } finally {
    elements.refreshJobsButton.disabled = false;
  }
}

function updateJobSnapshot(job) {
  const index = state.jobs.findIndex((candidate) => candidate.id === job.id);
  if (index >= 0) {
    state.jobs.splice(index, 1, job);
  } else {
    state.jobs.unshift(job);
  }
  renderJobs();
}

async function selectJob(jobId, announceSelection) {
  const normalizedId = internalIdentifier(jobId);
  if (!normalizedId) {
    return;
  }
  state.selectedJobId = normalizedId;
  renderJobs();
  elements.jobsStatus.dataset.state = "loading";
  elements.jobsStatus.textContent = "Refreshing the selected snapshot / 正在刷新所选任务…";

  try {
    const payload = await apiRequest(`/api/jobs/${encodeURIComponent(normalizedId)}`);
    const data = unwrapData(payload);
    const job = normalizeJob(isRecord(data) && isRecord(data.job) ? data.job : data);
    if (!job) {
      throw new ApiError(200, "INVALID_RESPONSE", null);
    }
    updateJobSnapshot(job);
    elements.jobsStatus.dataset.state = "ready";
    elements.jobsStatus.textContent = "Selected job snapshot is current / 所选任务快照已更新。";
    markRefresh();
    if (TERMINAL_JOB_STATUSES.has(job.status)) {
      stopJobTracking();
    } else {
      startJobTracking(job.id);
    }
    if (announceSelection) {
      announce(`${jobTypeLabel(job)} selected / 已选择任务。`);
    }
  } catch (error) {
    elements.jobsStatus.dataset.state = "error";
    elements.jobsStatus.textContent = friendlyError(
      error,
      "The selected job snapshot is unavailable / 无法读取所选任务。",
    );
  }
}

async function retryJob(jobId, button) {
  button.disabled = true;
  elements.jobsStatus.dataset.state = "loading";
  elements.jobsStatus.textContent = "Submitting an explicit retry / 正在提交显式重试…";
  try {
    await apiRequest(`/api/jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST" });
    announce("Job retry accepted / 任务重试已受理。");
    await selectJob(jobId, false);
  } catch (error) {
    elements.jobsStatus.dataset.state = "error";
    elements.jobsStatus.textContent = friendlyError(
      error,
      "This job could not be retried / 无法重试该任务。",
    );
    button.disabled = false;
  }
}

function eventSourceFor(path) {
  const url = safeApiUrl(path);
  return new EventSource(url.pathname + url.search, { withCredentials: true });
}

function scheduleJobSnapshot() {
  if (state.jobRefreshTimer !== null) {
    window.clearTimeout(state.jobRefreshTimer);
  }
  state.jobRefreshTimer = window.setTimeout(() => {
    state.jobRefreshTimer = null;
    if (state.selectedJobId) {
      void selectJob(state.selectedJobId, false);
    }
  }, 180);
}

function startJobTracking(jobId) {
  if (state.jobStream && state.jobStreamId === jobId) {
    return;
  }
  stopJobTracking();

  let source;
  try {
    source = eventSourceFor(`/api/jobs/${encodeURIComponent(jobId)}/events`);
  } catch (_error) {
    source = null;
  }

  if (source) {
    const invalidate = () => scheduleJobSnapshot();
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
      if (state.selectedJobId === jobId) {
        elements.jobsStatus.dataset.state = "error";
        elements.jobsStatus.textContent = "Live updates disconnected; saved snapshots will continue to refresh / 实时连接中断，将继续刷新持久快照。";
      }
    });
    state.jobStream = source;
    state.jobStreamId = jobId;
  }

  state.jobPollTimer = window.setInterval(() => {
    if (state.selectedJobId === jobId) {
      void selectJob(jobId, false);
    }
  }, 8000);
}

function stopJobTracking() {
  if (state.jobStream) {
    state.jobStream.close();
    state.jobStream = null;
  }
  state.jobStreamId = null;
  if (state.jobPollTimer !== null) {
    window.clearInterval(state.jobPollTimer);
    state.jobPollTimer = null;
  }
  if (state.jobRefreshTimer !== null) {
    window.clearTimeout(state.jobRefreshTimer);
    state.jobRefreshTimer = null;
  }
}

function normalizeBook(raw) {
  if (!isRecord(raw)) {
    return null;
  }
  const id = internalIdentifier(raw.id || raw.book_id);
  const title = displayText(raw.title, "Untitled book / 未命名书籍", 200);
  if (!id) {
    return null;
  }
  const rawStatus = typeof raw.status === "string" ? raw.status.toLowerCase() : "unknown";
  return {
    id,
    title,
    author: displayText(raw.author, "", 160),
    status: rawStatus,
  };
}

function extractBooks(payload) {
  const data = unwrapData(payload);
  return firstArray(data, ["books", "items", "results"])
    .map(normalizeBook)
    .filter(Boolean);
}

function bookOptionText(book) {
  const author = book.author ? ` · ${book.author}` : "";
  const readiness = READY_BOOK_STATUSES.has(book.status) ? "" : " · Not ready / 未就绪";
  return `${book.title}${author}${readiness}`;
}

function renderBooks() {
  const previous = state.selectedBookId;
  elements.chatBookSelect.replaceChildren();

  if (state.books.length === 0) {
    const option = createNode("option", "", "No books available / 暂无书籍");
    option.value = "";
    elements.chatBookSelect.append(option);
    elements.chatBookSelect.disabled = true;
    elements.loadConversationButton.disabled = true;
    elements.bookPickerHelp.textContent = "Import a book first, then refresh / 请先导入书籍。";
    return;
  }

  const prompt = createNode("option", "", "Select a ready book / 选择已就绪书籍");
  prompt.value = "";
  elements.chatBookSelect.append(prompt);

  for (const book of state.books) {
    const option = createNode("option", "", bookOptionText(book));
    option.value = book.id;
    option.disabled = !READY_BOOK_STATUSES.has(book.status);
    elements.chatBookSelect.append(option);
  }

  const selectable = state.books.filter((book) => READY_BOOK_STATUSES.has(book.status));
  if (previous && selectable.some((book) => book.id === previous)) {
    elements.chatBookSelect.value = previous;
    state.selectedBookId = previous;
  } else if (selectable.length === 1) {
    state.selectedBookId = selectable[0].id;
    elements.chatBookSelect.value = selectable[0].id;
  } else {
    state.selectedBookId = null;
    elements.chatBookSelect.value = "";
  }

  elements.chatBookSelect.disabled = selectable.length === 0;
  elements.loadConversationButton.disabled = !state.selectedBookId;
  elements.bookPickerHelp.textContent = selectable.length
    ? "Open a ready book to establish or restore its active conversation / 打开已就绪书籍以恢复对话。"
    : "Books exist, but none are ready for chat / 当前没有可对话的已就绪书籍。";
}

async function refreshBooks() {
  try {
    const payload = await apiRequest("/api/books?limit=100");
    state.books = extractBooks(payload);
    renderBooks();
    markRefresh();
  } catch (error) {
    state.books = [];
    renderBooks();
    elements.bookPickerHelp.textContent = friendlyError(
      error,
      "The book list is temporarily unavailable / 书籍列表暂时不可用。",
    );
  }
}

function normalizeConversation(payload) {
  const data = unwrapData(payload);
  const raw = isRecord(data) && isRecord(data.conversation) ? data.conversation : data;
  if (!isRecord(raw)) {
    return null;
  }
  const id = internalIdentifier(raw.id || raw.conversation_id);
  const bookId = internalIdentifier(raw.book_id) || state.selectedBookId;
  if (!id || !bookId) {
    return null;
  }
  return {
    id,
    bookId,
    title: displayText(raw.title, "Book conversation / 书籍对话", 180),
    status: typeof raw.status === "string" ? raw.status.toLowerCase() : "active",
  };
}

function currentBook() {
  return state.books.find((book) => book.id === state.selectedBookId) || null;
}

function setChatState(message, status) {
  elements.chatState.textContent = message;
  elements.chatState.dataset.state = status || "ready";
}

function resetConversation() {
  stopRunTracking();
  state.conversation = null;
  state.messages = [];
  state.referencesByMessageId = new Map();
  state.activeRun = null;
  state.pendingSubmission = null;
  state.submittingQuestion = false;
  state.retryAvailableAt = 0;
  elements.chatQuestion.value = "";
  elements.chatQuestion.disabled = true;
  elements.chatQuestion.placeholder = "先选择一本书…";
  elements.sendChatButton.disabled = true;
  elements.loadConversationButton.disabled = !state.selectedBookId;
  renderMessages();
  renderRunActions();
  setChatState("请选择一本可用书籍开始对话。", "ready");
}

async function openConversation() {
  const book = currentBook();
  if (!book || !READY_BOOK_STATUSES.has(book.status)) {
    setChatState("Select a ready book first / 请先选择已就绪书籍。", "error");
    return;
  }

  elements.loadConversationButton.disabled = true;
  setChatState("Loading the saved conversation / 正在加载对话…", "working");
  resetConversation();
  state.selectedBookId = book.id;
  elements.loadConversationButton.disabled = true;

  try {
    let payload;
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

    const conversation = normalizeConversation(payload);
    if (!conversation) {
      throw new ApiError(200, "INVALID_RESPONSE", null);
    }
    state.conversation = conversation;
    elements.chatQuestion.disabled = false;
    elements.chatQuestion.placeholder = "从这本书里提问…";
    elements.sendChatButton.disabled = false;
    setChatState(`Conversation ready for “${book.title}” / 对话已就绪。`, "complete");
    await loadMessages();
    elements.chatQuestion.focus({ preventScroll: true });
  } catch (error) {
    setChatState(
      friendlyError(error, "The conversation could not be opened / 无法打开对话。"),
      "error",
    );
    elements.loadConversationButton.disabled = false;
  }
}

function normalizeReference(raw) {
  if (!isRecord(raw)) {
    return null;
  }
  const citationNumber = Number.isInteger(raw.citation_number) && raw.citation_number > 0
    ? raw.citation_number
    : null;
  return {
    citationNumber,
    label: displayText(raw.label, "Local source / 本地来源", 180),
    passage: displayText(raw.passage, "No excerpt was provided / API 未提供摘录。", 4000),
    hasLocation: raw.location !== null && raw.location !== undefined,
  };
}

function normalizeReferences(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(normalizeReference).filter(Boolean);
}

function normalizeMessage(raw, wrapperReferences) {
  const source = isRecord(raw) && isRecord(raw.message) ? raw.message : raw;
  if (!isRecord(source)) {
    return null;
  }
  const id = internalIdentifier(source.id || source.message_id);
  const role = source.role === "user" || source.role === "assistant" ? source.role : null;
  if (!id || !role) {
    return null;
  }
  const references = normalizeReferences(
    Array.isArray(wrapperReferences)
      ? wrapperReferences
      : Array.isArray(raw.references)
        ? raw.references
        : source.references,
  );
  return {
    id,
    role,
    content: typeof source.content === "string" ? source.content : null,
    createdAt: typeof source.created_at === "string" ? source.created_at : null,
    references,
  };
}

function mergeMessages(messages) {
  const byMessageId = new Map(state.messages.map((message) => [message.id, message]));
  for (const message of messages) {
    byMessageId.set(message.id, message);
    if (message.references.length) {
      state.referencesByMessageId.set(message.id, message.references);
    }
  }
  state.messages = Array.from(byMessageId.values()).sort((left, right) => {
    const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
    const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.id.localeCompare(right.id);
  });
}

function extractMessageEnvelope(payload) {
  const data = unwrapData(payload);
  const rawMessages = firstArray(data, ["messages", "items", "results"]);
  const messages = rawMessages
    .map((raw) => normalizeMessage(raw, isRecord(raw) ? raw.references : null))
    .filter(Boolean);

  if (isRecord(data) && Array.isArray(data.references)) {
    for (const rawReference of data.references) {
      if (!isRecord(rawReference)) {
        continue;
      }
      const messageId = internalIdentifier(rawReference.message_id || rawReference.assistant_message_id);
      const reference = normalizeReference(rawReference);
      if (messageId && reference) {
        const existing = state.referencesByMessageId.get(messageId) || [];
        existing.push(reference);
        state.referencesByMessageId.set(messageId, existing);
      }
    }
  }

  const activeRunRaw = isRecord(data)
    ? data.active_chat_run || data.chat_run || null
    : null;
  return {
    messages,
    activeRun: activeRunRaw ? normalizeChatRun(activeRunRaw) : null,
  };
}

async function loadMessages() {
  if (!state.conversation) {
    return;
  }
  const conversationId = state.conversation.id;
  try {
    const payload = await apiRequest(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=50`,
    );
    if (!state.conversation || state.conversation.id !== conversationId) {
      return;
    }
    const envelope = extractMessageEnvelope(payload);
    mergeMessages(envelope.messages);
    renderMessages();
    if (envelope.activeRun && !TERMINAL_CHAT_STATUSES.has(envelope.activeRun.status)) {
      state.activeRun = envelope.activeRun;
      renderChatRun();
      startRunTracking(envelope.activeRun.id);
    }
  } catch (error) {
    setChatState(
      friendlyError(error, "Message history is temporarily unavailable / 消息历史暂时不可用。"),
      "error",
    );
  }
}

let citationSequence = 0;

function renderCitation(reference, index) {
  citationSequence += 1;
  const wrapper = createNode("div", "citation-list");
  const sourceNumber = reference.citationNumber || index + 1;
  const button = createNode(
    "button",
    "citation-button",
    `Source ${sourceNumber} / 来源 ${sourceNumber} · ${reference.label}`,
  );
  button.type = "button";
  button.setAttribute("aria-expanded", "false");
  const detailId = `citation-detail-${citationSequence}`;
  button.setAttribute("aria-controls", detailId);
  button.setAttribute(
    "aria-label",
    `来源 ${sourceNumber}，${reference.label}${reference.hasLocation ? "，来源位置可用" : ""}`,
  );

  const detail = createNode("div", "citation-detail");
  detail.id = detailId;
  detail.hidden = true;
  appendText(detail, "h3", "", `Source ${sourceNumber} / 来源 ${sourceNumber} · ${reference.label}`);
  appendText(detail, "p", "", reference.passage);
  appendText(
    detail,
    "p",
    "",
    reference.hasLocation
      ? "A local source location is available; no provider identifier or physical path is shown / 可定位本地来源，但不显示 Provider ID 或物理路径。"
      : "No local source location was provided / API 未提供本地定位信息。",
  );

  button.addEventListener("click", () => {
    const expanded = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", String(!expanded));
    detail.hidden = expanded;
  });

  wrapper.append(button, detail);
  return wrapper;
}

function renderMessages() {
  const nearBottom = elements.messageLog.scrollHeight
    - elements.messageLog.scrollTop
    - elements.messageLog.clientHeight < 90;
  const firstRender = elements.messageLog.childElementCount === 0
    || Boolean(elements.messageLog.querySelector(".empty-chat"));
  elements.messageLog.replaceChildren();

  if (state.messages.length === 0) {
    const empty = createNode("div", "empty-chat");
    appendText(empty, "span", "", "✦").setAttribute("aria-hidden", "true");
    appendText(empty, "h2", "", "Ask from the book / 从书中提问");
    appendText(empty, "p", "", "回答只以纯文本显示；来源按钮只使用 API references。暂不支持的端点会显示明确错误。 ");
    elements.messageLog.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const message of state.messages) {
    const article = createNode("article", "chat-message");
    article.dataset.role = message.role;
    const meta = createNode("div", "message-meta");
    appendText(meta, "strong", "", message.role === "user" ? "You / 你" : "Reading assistant / 阅读助手");
    appendText(meta, "span", "", formatTime(message.createdAt));
    article.append(meta);

    const bubble = createNode("p", "message-bubble");
    if (message.content === null || message.content === "") {
      bubble.classList.add("message-pending");
      bubble.textContent = message.role === "assistant"
        ? "Answer pending / 回答等待处理中。"
        : "Message content unavailable / 消息内容不可用。";
    } else {
      bubble.textContent = message.content;
    }
    article.append(bubble);

    if (message.role === "assistant") {
      const references = message.references.length
        ? message.references
        : state.referencesByMessageId.get(message.id) || [];
      references.forEach((reference, index) => {
        article.append(renderCitation(reference, index));
      });
    }
    fragment.append(article);
  }
  elements.messageLog.append(fragment);

  if (nearBottom || firstRender) {
    window.requestAnimationFrame(() => {
      elements.messageLog.scrollTop = elements.messageLog.scrollHeight;
    });
  }
}

function normalizeChatError(raw) {
  if (!isRecord(raw)) {
    return null;
  }
  const code = knownCode(raw.code) || "UNEXPECTED";
  const retryAfterMs = Number.isFinite(raw.retry_after_ms) && raw.retry_after_ms > 0
    ? Math.min(Math.floor(raw.retry_after_ms), 2147483647)
    : 0;
  return {
    code,
    retriable: raw.retriable === true,
    retryAfterMs,
  };
}

function normalizeChatRun(raw) {
  if (!isRecord(raw)) {
    return null;
  }
  const id = internalIdentifier(raw.id || raw.run_id);
  const rawStatus = typeof raw.status === "string" ? raw.status.toLowerCase() : "";
  if (!id || !CHAT_STATUSES.has(rawStatus)) {
    return null;
  }
  const rawPhase = typeof raw.phase === "string" ? raw.phase.toLowerCase() : null;
  return {
    id,
    status: rawStatus,
    phase: rawPhase && CHAT_PHASES.has(rawPhase) ? rawPhase : null,
    error: normalizeChatError(raw.error),
    updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : null,
  };
}

function chatRunEnvelope(payload) {
  const data = unwrapData(payload);
  if (!isRecord(data)) {
    return { run: null, assistantMessage: null, references: [] };
  }
  const runRaw = isRecord(data.chat_run) ? data.chat_run : data;
  const assistantRaw = isRecord(data.assistant_message) ? data.assistant_message : null;
  return {
    run: normalizeChatRun(runRaw),
    assistantMessage: assistantRaw ? normalizeMessage(assistantRaw, data.references) : null,
    references: normalizeReferences(data.references),
  };
}

function chatRunStatusText(run) {
  if (!run) {
    return "Conversation ready / 对话已就绪。";
  }
  if (run.status === "queued") {
    return "Question saved; waiting for the worker / 问题已保存，等待处理。";
  }
  if (run.status === "running") {
    const phaseCopy = {
      resolving_scope: "Confirming the source scope / 正在确认来源范围。",
      waiting_for_provider: "Reading sources and organizing a complete answer / 正在读取来源并组织回答。",
      reconciling: "Confirming whether the provider completed the answer / 正在核对 Provider 是否已完成回答。",
      finalizing: "Saving the answer and references / 正在保存回答与引用。",
    };
    return phaseCopy[run.phase] || "The saved answer run is active / 回答任务正在运行。";
  }
  if (run.status === "completed") {
    return "Answer completed and saved / 回答已完成并保存。";
  }
  if (run.status === "cancelled") {
    return "Answer run cancelled at a safe point / 回答任务已在安全点取消。";
  }
  if (run.status === "failed") {
    const code = run.error ? run.error.code : "UNEXPECTED";
    return Object.prototype.hasOwnProperty.call(ERROR_TEXT, code)
      ? ERROR_TEXT[code]
      : ERROR_TEXT.UNEXPECTED;
  }
  return "Conversation ready / 对话已就绪。";
}

function renderChatRun() {
  const run = state.activeRun;
  if (!run) {
    if (state.conversation) {
      setChatState("Conversation ready / 对话已就绪。", "complete");
    }
    renderRunActions();
    return;
  }
  const status = run.status === "failed"
    ? "error"
    : run.status === "completed"
      ? "complete"
      : run.status === "cancelled"
        ? "ready"
        : "working";
  setChatState(chatRunStatusText(run), status);
  renderRunActions();
}

function clearRetryTimer() {
  if (state.retryTimer !== null) {
    window.clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
}

function renderRunActions() {
  clearRetryTimer();
  const run = state.activeRun;
  let showRetry = false;
  let showCancel = false;

  if (run) {
    showCancel = run.status === "queued" || run.status === "running";
    const ambiguous = run.error && run.error.code === "AMBIGUOUS_PROVIDER_OUTCOME";
    showRetry = run.status === "failed" && Boolean(run.error && run.error.retriable) && !ambiguous;
  }

  elements.retryChatButton.hidden = !showRetry;
  elements.cancelChatButton.hidden = !showCancel;
  elements.runActions.hidden = !showRetry && !showCancel;

  if (showRetry) {
    const delay = Math.max(0, state.retryAvailableAt - Date.now());
    elements.retryChatButton.disabled = delay > 0;
    if (delay > 0) {
      state.retryTimer = window.setTimeout(() => {
        state.retryTimer = null;
        renderRunActions();
      }, delay);
    }
  } else {
    elements.retryChatButton.disabled = false;
  }
  elements.cancelChatButton.disabled = false;
}

function newClientIdentifier(prefix) {
  if (typeof window.crypto.randomUUID === "function") {
    return `${prefix}-${window.crypto.randomUUID()}`;
  }
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${value}`;
}

function mergeSubmissionPayload(payload) {
  const data = unwrapData(payload);
  if (!isRecord(data)) {
    return null;
  }
  const messages = [];
  if (isRecord(data.user_message)) {
    const userMessage = normalizeMessage(data.user_message, null);
    if (userMessage) {
      messages.push(userMessage);
    }
  }
  if (isRecord(data.assistant_message)) {
    const assistantMessage = normalizeMessage(data.assistant_message, data.references);
    if (assistantMessage) {
      messages.push(assistantMessage);
    }
  }
  mergeMessages(messages);
  return normalizeChatRun(data.chat_run);
}

function activeRunPathFromError(error) {
  if (!(error instanceof ApiError) || !isRecord(error.payload)) {
    return null;
  }
  const topError = responseError(error.payload);
  const data = unwrapData(error.payload);
  const candidates = [
    isRecord(topError) ? topError.active_run_url : null,
    isRecord(topError) && isRecord(topError.details) ? topError.details.active_run_url : null,
    isRecord(data) ? data.active_run_url : null,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    try {
      const url = safeApiUrl(candidate);
      const match = /^\/api\/chat-runs\/([^/]+)$/u.exec(url.pathname);
      if (match) {
        return decodeURIComponent(match[1]);
      }
    } catch (_ignored) {
      continue;
    }
  }
  return null;
}

async function submitQuestion(event) {
  event.preventDefault();
  if (state.composing || state.submittingQuestion || !state.conversation) {
    return;
  }
  const question = elements.chatQuestion.value.trim();
  if (!question) {
    elements.chatQuestion.setCustomValidity("Please enter a question / 请输入问题。");
    elements.chatQuestion.reportValidity();
    elements.chatQuestion.setCustomValidity("");
    return;
  }

  const existing = state.pendingSubmission;
  const clientMessageId = existing
    && existing.conversationId === state.conversation.id
    && existing.question === question
    ? existing.clientMessageId
    : newClientIdentifier("msg");
  state.pendingSubmission = {
    conversationId: state.conversation.id,
    question,
    clientMessageId,
  };
  state.submittingQuestion = true;
  elements.chatQuestion.disabled = true;
  elements.sendChatButton.disabled = true;
  setChatState("Submitting the saved command / 正在提交问题…", "working");

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
    const run = mergeSubmissionPayload(payload);
    state.pendingSubmission = null;
    elements.chatQuestion.value = "";
    renderMessages();
    if (run) {
      state.activeRun = run;
      renderChatRun();
      startRunTracking(run.id);
    } else {
      setChatState("Question accepted; refreshing saved messages / 问题已受理，正在刷新消息。", "working");
    }
    await loadMessages();
  } catch (error) {
    const activeRunId = activeRunPathFromError(error);
    if (activeRunId) {
      await refreshChatRun(activeRunId);
      setChatState(ERROR_TEXT.CONVERSATION_BUSY, "working");
    } else {
      setChatState(
        friendlyError(error, "The question could not be submitted / 无法提交问题。"),
        "error",
      );
      if (!(error instanceof ApiError) || (error.status > 0 && error.status < 500)) {
        state.pendingSubmission = null;
      }
    }
  } finally {
    state.submittingQuestion = false;
    elements.chatQuestion.disabled = !state.conversation;
    elements.sendChatButton.disabled = !state.conversation;
    if (state.conversation) {
      elements.chatQuestion.focus({ preventScroll: true });
    }
  }
}

function scheduleRunSnapshot() {
  if (state.runRefreshTimer !== null) {
    window.clearTimeout(state.runRefreshTimer);
  }
  state.runRefreshTimer = window.setTimeout(() => {
    state.runRefreshTimer = null;
    if (state.activeRun) {
      void refreshChatRun(state.activeRun.id);
    }
  }, 180);
}

async function refreshChatRun(runId) {
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
    state.activeRun = envelope.run;
    if (envelope.assistantMessage) {
      if (envelope.references.length) {
        envelope.assistantMessage.references = envelope.references;
        state.referencesByMessageId.set(envelope.assistantMessage.id, envelope.references);
      }
      mergeMessages([envelope.assistantMessage]);
      renderMessages();
    }
    if (envelope.run.error && envelope.run.error.retryAfterMs > 0) {
      state.retryAvailableAt = Date.now() + envelope.run.error.retryAfterMs;
    } else {
      state.retryAvailableAt = 0;
    }
    renderChatRun();
    markRefresh();

    if (TERMINAL_CHAT_STATUSES.has(envelope.run.status)) {
      stopRunTracking(false);
      if (envelope.run.status === "completed") {
        await loadMessages();
      }
    }
  } catch (error) {
    setChatState(
      friendlyError(error, "The answer snapshot is temporarily unavailable / 回答快照暂时不可用。"),
      "error",
    );
  }
}

function startRunTracking(runId) {
  if (state.runStream && state.runStreamId === runId) {
    return;
  }
  stopRunTracking(false);

  let source;
  try {
    source = eventSourceFor(`/api/chat-runs/${encodeURIComponent(runId)}/events`);
  } catch (_error) {
    source = null;
  }

  if (source) {
    const invalidate = () => scheduleRunSnapshot();
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
      if (state.activeRun && state.activeRun.id === runId && !TERMINAL_CHAT_STATUSES.has(state.activeRun.status)) {
        setChatState("Live updates disconnected; checking saved snapshots / 实时连接中断，将继续读取持久快照。", "working");
      }
    });
    state.runStream = source;
    state.runStreamId = runId;
  }

  state.runPollTimer = window.setInterval(() => {
    if (state.activeRun && state.activeRun.id === runId) {
      void refreshChatRun(runId);
    }
  }, 6500);
}

function stopRunTracking(clearRun) {
  if (state.runStream) {
    state.runStream.close();
    state.runStream = null;
  }
  state.runStreamId = null;
  if (state.runPollTimer !== null) {
    window.clearInterval(state.runPollTimer);
    state.runPollTimer = null;
  }
  if (state.runRefreshTimer !== null) {
    window.clearTimeout(state.runRefreshTimer);
    state.runRefreshTimer = null;
  }
  if (clearRun !== false) {
    clearRetryTimer();
    state.activeRun = null;
  }
}

async function cancelChatRun() {
  const run = state.activeRun;
  if (!run || !["queued", "running"].includes(run.status)) {
    return;
  }
  elements.cancelChatButton.disabled = true;
  setChatState("Cancellation requested; the run is not yet claimed cancelled / 已请求取消，尚未确认停止。", "working");
  try {
    await apiRequest(`/api/chat-runs/${encodeURIComponent(run.id)}/cancel`, { method: "POST" });
    announce("Cancellation request saved / 取消请求已保存。");
    await refreshChatRun(run.id);
  } catch (error) {
    setChatState(
      friendlyError(error, "The cancellation request was not accepted / 无法提交取消请求。"),
      "error",
    );
    elements.cancelChatButton.disabled = false;
  }
}

async function retryChatRun() {
  const run = state.activeRun;
  const ambiguous = run && run.error && run.error.code === "AMBIGUOUS_PROVIDER_OUTCOME";
  if (!run || run.status !== "failed" || !run.error || !run.error.retriable || ambiguous) {
    return;
  }
  if (Date.now() < state.retryAvailableAt) {
    renderRunActions();
    return;
  }

  const clientRetryId = newClientIdentifier("retry");
  elements.retryChatButton.disabled = true;
  setChatState("Submitting an explicit answer retry / 正在提交显式重试…", "working");
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
      state.activeRun = envelope.run;
      renderChatRun();
    } else {
      setChatState("Answer retry accepted; refreshing the saved snapshot / 回答重试已受理，正在刷新持久快照。", "working");
    }
    state.retryAvailableAt = 0;
    startRunTracking(state.activeRun ? state.activeRun.id : run.id);
    await refreshChatRun(state.activeRun ? state.activeRun.id : run.id);
    announce("Answer retry accepted / 回答重试已受理。");
  } catch (error) {
    setChatState(
      friendlyError(error, "The answer could not be retried / 无法重试回答。"),
      "error",
    );
    elements.retryChatButton.disabled = false;
  }
}

function onBookSelectionChange() {
  const selectedId = internalIdentifier(elements.chatBookSelect.value);
  state.selectedBookId = selectedId;
  resetConversation();
  state.selectedBookId = selectedId;
  elements.loadConversationButton.disabled = !selectedId;
  if (selectedId) {
    const book = currentBook();
    setChatState(
      book ? `Ready to open “${book.title}” / 可打开该书对话。` : "Ready to open / 可打开对话。",
      "ready",
    );
  }
}

function onQuestionKeydown(event) {
  const composing = state.composing || event.isComposing || event.keyCode === 229;
  if (event.key === "Enter" && !event.shiftKey && !composing) {
    event.preventDefault();
    elements.chatForm.requestSubmit();
  }
}

function currentPanelMode() {
  if (desktopMedia.matches) {
    return "desktop";
  }
  if (mobileMedia.matches) {
    return "mobile";
  }
  return "drawer";
}

function currentHistoryIsChat() {
  return isRecord(window.history.state) && window.history.state.diandianChat === true;
}

function setWorkspaceInert(inert) {
  elements.workspace.inert = inert;
  if (inert) {
    elements.workspace.setAttribute("inert", "");
  } else {
    elements.workspace.removeAttribute("inert");
  }
}

function applyChatOpenState(open) {
  const desktop = state.panelMode === "desktop";
  const effectiveOpen = desktop || open;
  state.chatOpen = effectiveOpen;
  elements.chatPanel.dataset.open = String(effectiveOpen);
  elements.navChatButton.setAttribute("aria-expanded", String(effectiveOpen));
  elements.openChatButton.setAttribute("aria-expanded", String(effectiveOpen));
  elements.chatBackdrop.hidden = !(state.panelMode === "drawer" && effectiveOpen);
  document.body.classList.toggle("chat-open", !desktop && effectiveOpen);
  setWorkspaceInert(!desktop && effectiveOpen);

  if (desktop) {
    elements.chatPanel.removeAttribute("role");
    elements.chatPanel.removeAttribute("aria-modal");
    elements.chatPanel.removeAttribute("aria-hidden");
  } else if (state.panelMode === "drawer") {
    elements.chatPanel.setAttribute("role", "dialog");
    elements.chatPanel.setAttribute("aria-modal", "true");
    elements.chatPanel.setAttribute("aria-hidden", String(!effectiveOpen));
  } else {
    elements.chatPanel.setAttribute("role", "region");
    elements.chatPanel.removeAttribute("aria-modal");
    elements.chatPanel.setAttribute("aria-hidden", String(!effectiveOpen));
  }
}

function pushMobileChatHistory() {
  if (state.panelMode !== "mobile" || currentHistoryIsChat()) {
    return;
  }
  window.history.pushState(
    { diandianChat: true },
    "",
    window.location.pathname + window.location.search,
  );
  state.mobileHistoryOwned = true;
}

function openChat(trigger) {
  if (state.panelMode === "desktop") {
    elements.chatPanel.focus({ preventScroll: false });
    return;
  }
  state.chatReturnFocus = trigger || document.activeElement;
  if (state.panelMode === "mobile") {
    pushMobileChatHistory();
  }
  applyChatOpenState(true);
  window.requestAnimationFrame(() => {
    if (!elements.chatBookSelect.disabled) {
      elements.chatBookSelect.focus({ preventScroll: true });
    } else {
      elements.closeChatButton.focus({ preventScroll: true });
    }
  });
}

function finishCloseChat(restoreFocus) {
  applyChatOpenState(false);
  state.mobileHistoryOwned = false;
  if (
    restoreFocus
    && state.chatReturnFocus
    && state.chatReturnFocus.isConnected
    && typeof state.chatReturnFocus.focus === "function"
  ) {
    state.chatReturnFocus.focus({ preventScroll: true });
  }
  state.chatReturnFocus = null;
}

function closeChat() {
  if (state.panelMode === "desktop" || !state.chatOpen) {
    return;
  }
  if (state.panelMode === "mobile" && state.mobileHistoryOwned && currentHistoryIsChat()) {
    window.history.back();
    return;
  }
  finishCloseChat(true);
}

function syncPanelMode() {
  const nextMode = currentPanelMode();
  const previousMode = state.panelMode;
  state.panelMode = nextMode;

  if (nextMode !== "mobile" && state.mobileHistoryOwned) {
    if (currentHistoryIsChat()) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    state.mobileHistoryOwned = false;
  }

  if (nextMode === "desktop") {
    applyChatOpenState(true);
    return;
  }

  if (previousMode === "desktop" || previousMode === null) {
    finishCloseChat(false);
    return;
  }

  if (nextMode === "mobile" && state.chatOpen) {
    pushMobileChatHistory();
  }
  applyChatOpenState(state.chatOpen);
}

function focusableInChat() {
  return Array.from(
    elements.chatPanel.querySelectorAll(
      "button:not([disabled]):not([hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    ),
  ).filter((node) => !node.hidden && node.getClientRects().length > 0);
}

function handleChatPanelKeydown(event) {
  if (state.panelMode === "desktop" || !state.chatOpen) {
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeChat();
    return;
  }
  if (event.key !== "Tab") {
    return;
  }
  const focusable = focusableInChat();
  if (focusable.length === 0) {
    event.preventDefault();
    elements.chatPanel.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function handleHistoryChange(event) {
  if (state.panelMode !== "mobile") {
    return;
  }
  const isChatEntry = isRecord(event.state) && event.state.diandianChat === true;
  if (isChatEntry && !state.chatOpen) {
    state.mobileHistoryOwned = true;
    applyChatOpenState(true);
    elements.closeChatButton.focus({ preventScroll: true });
  } else if (!isChatEntry && state.chatOpen) {
    finishCloseChat(true);
  }
}

function addMediaListener(media, listener) {
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", listener);
  } else {
    media.addListener(listener);
  }
}

function renderConnectivity() {
  const online = navigator.onLine;
  elements.connectivityBanner.hidden = online;
  if (!online) {
    elements.connectivityTitle.textContent = "Offline / 离线";
    elements.connectivityMessage.textContent = "浏览器报告网络不可用；本地 API 刷新与实时事件可能暂停。";
  }
}

async function handleOnline() {
  renderConnectivity();
  await Promise.allSettled([
    refreshSession(),
    refreshAuthStatus(),
    refreshJobs(),
    refreshBooks(),
  ]);
  announce("Connection restored; local snapshots refreshed / 连接恢复，已刷新本地快照。");
}

function wireEvents() {
  wireNavigation();
  elements.refreshConnectionsButton.addEventListener("click", () => void refreshConnections());
  elements.logoutButton.addEventListener("click", () => void logout());
  elements.localImportTab.addEventListener("click", () => setImportTab("local", false));
  elements.zlibraryImportTab.addEventListener("click", () => setImportTab("zlibrary", false));
  elements.localImportTab.addEventListener("keydown", handleImportTabKeydown);
  elements.zlibraryImportTab.addEventListener("keydown", handleImportTabKeydown);
  elements.localImportForm.addEventListener("submit", (event) => void submitLocalImport(event));
  elements.zlibraryImportForm.addEventListener("submit", (event) => void submitZlibraryImport(event));
  elements.refreshJobsButton.addEventListener("click", () => void refreshJobs());
  elements.chatBookSelect.addEventListener("change", onBookSelectionChange);
  elements.loadConversationButton.addEventListener("click", () => void openConversation());
  elements.chatForm.addEventListener("submit", (event) => void submitQuestion(event));
  elements.chatQuestion.addEventListener("keydown", onQuestionKeydown);
  elements.chatQuestion.addEventListener("compositionstart", () => {
    state.composing = true;
  });
  elements.chatQuestion.addEventListener("compositionend", () => {
    state.composing = false;
  });
  elements.retryChatButton.addEventListener("click", () => void retryChatRun());
  elements.cancelChatButton.addEventListener("click", () => void cancelChatRun());
  elements.chatPanel.addEventListener("keydown", handleChatPanelKeydown);
  window.addEventListener("online", () => void handleOnline());
  window.addEventListener("offline", renderConnectivity);
  window.addEventListener("popstate", handleHistoryChange);
  window.addEventListener("pagehide", () => {
    stopJobTracking();
    stopRunTracking(false);
  });
  addMediaListener(desktopMedia, syncPanelMode);
  addMediaListener(mobileMedia, syncPanelMode);
}

async function initialize() {
  wireEvents();
  setImportTab("local", false);
  renderSession();
  renderProvider("notebooklm", state.providers.notebooklm);
  renderProvider("zlibrary", state.providers.zlibrary);
  renderJobs();
  renderBooks();
  renderMessages();
  syncPanelMode();
  renderConnectivity();

  state.bootstrapResult = await bootstrapTask;
  if (state.bootstrapResult.attempted && !state.bootstrapResult.ok) {
    const message = friendlyError(
      state.bootstrapResult.error,
      "Secure session bootstrap failed. Relaunch the local workspace / 安全会话初始化失败，请重新打开。",
    );
    elements.sessionDetail.textContent = message;
    announce(message);
  }

  await Promise.allSettled([
    refreshSession(),
    refreshAuthStatus(),
    refreshJobs(),
    refreshBooks(),
  ]);

  if (state.bootstrapResult.attempted && state.bootstrapResult.ok && state.session.status === "active") {
    announce("Secure local session established / 安全本地会话已建立。");
  }
}

void initialize().catch(() => {
  state.session = { status: "error" };
  renderSession();
  setChatState("The interface could not finish initialization / 界面初始化失败。", "error");
  announce("Interface initialization failed / 界面初始化失败。");
});
