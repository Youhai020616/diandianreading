import type { ReactElement } from "react";
import type { ProviderStatus, SessionStatus } from "../lib/types";
import type { AppController } from "../state/controller";
import type { AppState } from "../state/store";

const SESSION_COPY: Record<SessionStatus, { pill: string; detail: string }> = {
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
    detail:
      "Launch this workspace from the local application to establish a secure session / 请从本地应用重新打开工作区。",
  },
  expired: {
    pill: "Session expired / 会话过期",
    detail:
      "The browser session has expired or was revoked. Relaunch the local workspace / 会话已过期或撤销。",
  },
  unavailable: {
    pill: "API unavailable / API 不可用",
    detail:
      "The local API could not be reached. The interface remains available for retry / 暂时无法连接本地 API。",
  },
  error: {
    pill: "Session error / 会话错误",
    detail: "The local service rejected the session check / 本地服务拒绝了会话检查。",
  },
};

const PROVIDER_COPY: Record<ProviderStatus, { badge: string; description: string }> = {
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

export function sessionCopy(status: SessionStatus): { pill: string; detail: string } {
  return SESSION_COPY[status] || SESSION_COPY.error;
}

function providerCopy(status: ProviderStatus): { badge: string; description: string } {
  return PROVIDER_COPY[status] || PROVIDER_COPY.unknown;
}

interface ConnectionsViewProps {
  state: AppState;
  controller: AppController;
}

export function ConnectionsView({ state, controller }: ConnectionsViewProps): ReactElement {
  const session = sessionCopy(state.session.status);
  const notebooklm = providerCopy(state.providers.notebooklm.status);
  const zlibrary = providerCopy(state.providers.zlibrary.status);

  return (
    <section
      className="view"
      id="view-connections"
      data-view-panel="connections"
      aria-labelledby="connections-title"
      hidden={state.currentView !== "connections"}
    >
      <div className="view-heading">
        <div>
          <p className="eyebrow">LOCAL-FIRST CONTROL CENTER</p>
          <h1 id="connections-title">
            Connections <span>/ 连接状态</span>
          </h1>
          <p>确认浏览器会话与本地 Provider 认证。状态会明确显示，不依赖颜色判断。</p>
        </div>
        <button
          className="button button-secondary"
          id="refresh-connections-button"
          type="button"
          disabled={state.authRefreshBusy}
          onClick={() => void controller.refreshConnections()}
        >
          Refresh / 刷新状态
        </button>
      </div>

      <section className="session-card" aria-labelledby="browser-session-title">
        <div>
          <p className="card-kicker">SECURE LOCAL SESSION</p>
          <h2 id="browser-session-title">Browser session / 浏览器会话</h2>
          <p className="status-copy" id="session-detail" role="status" aria-live="polite">
            {state.sessionDetailOverride ?? session.detail}
          </p>
        </div>
        <button
          className="button button-quiet"
          id="logout-button"
          type="button"
          disabled={state.logoutBusy || state.session.status !== "active"}
          onClick={() => void controller.logout()}
        >
          Log out / 退出
        </button>
      </section>

      <div className="provider-grid" aria-label="Provider authentication status">
        <article className="provider-card">
          <div className="provider-card-heading">
            <span className="provider-monogram" aria-hidden="true">
              N
            </span>
            <div>
              <p className="card-kicker">KNOWLEDGE CONNECTION</p>
              <h2>NotebookLM</h2>
            </div>
          </div>
          <p
            className="status-badge"
            id="notebooklm-status"
            data-state={state.providers.notebooklm.status}
          >
            {notebooklm.badge}
          </p>
          <p className="provider-description" id="notebooklm-description">
            {notebooklm.description}
          </p>
          <p className="command-hint">
            需要重新认证时运行 <code>diandian auth login notebooklm</code>
          </p>
        </article>

        <article className="provider-card">
          <div className="provider-card-heading">
            <span className="provider-monogram provider-monogram-lavender" aria-hidden="true">
              Z
            </span>
            <div>
              <p className="card-kicker">OPTIONAL ACQUISITION</p>
              <h2>Z-Library</h2>
            </div>
          </div>
          <p
            className="status-badge"
            id="zlibrary-status"
            data-state={state.providers.zlibrary.status}
          >
            {zlibrary.badge}
          </p>
          <p className="provider-description" id="zlibrary-description">
            {zlibrary.description}
          </p>
          <p className="command-hint">
            需要重新认证时运行 <code>diandian auth login zlibrary</code>
          </p>
        </article>
      </div>

      <aside className="privacy-note" aria-labelledby="privacy-title">
        <span className="privacy-icon" aria-hidden="true">
          ◎
        </span>
        <div>
          <h2 id="privacy-title">Credentials stay local / 凭据保留在本机</h2>
          <p>
            此页面不持久化 Bootstrap nonce、Session、CSRF token 或 Provider 凭据，也不会显示 Provider
            ID 与物理文件路径。
          </p>
        </div>
      </aside>
    </section>
  );
}
