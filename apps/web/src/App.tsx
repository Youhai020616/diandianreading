import { useEffect, useRef, useSyncExternalStore, type ReactElement } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { ConnectionsView } from "./components/ConnectionsView";
import { ImportView } from "./components/ImportView";
import { JobsView } from "./components/JobsView";
import type { BootstrapResult } from "./lib/bootstrap";
import type { SessionStatus, ViewName } from "./lib/types";
import type { AppController } from "./state/controller";

const SESSION_PILL_COPY: Record<SessionStatus, string> = {
  loading: "Checking session / 检查会话",
  active: "Session active / 会话有效",
  required: "Session required / 需要会话",
  expired: "Session expired / 会话过期",
  unavailable: "API unavailable / API 不可用",
  error: "Session error / 会话错误",
};

const NAV_ITEMS: Array<{ view: ViewName; ordinal: string; label: string }> = [
  { view: "connections", ordinal: "01", label: "Connections / 连接" },
  { view: "import", ordinal: "02", label: "Import / 导入" },
  { view: "jobs", ordinal: "03", label: "Jobs / 任务" },
];

export interface AppProps {
  controller: AppController;
  bootstrapTask: Promise<BootstrapResult>;
}

export function App({ controller, bootstrapTask }: AppProps): ReactElement {
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.getState);

  useEffect(() => {
    void controller.initialize(bootstrapTask);
  }, [controller, bootstrapTask]);

  const focusedTokenRef = useRef(0);
  useEffect(() => {
    if (state.viewFocusToken === 0 || state.viewFocusToken === focusedTokenRef.current) {
      return;
    }
    focusedTokenRef.current = state.viewFocusToken;
    const panel = document.querySelector(`[data-view-panel="${state.currentView}"]`);
    const heading = panel ? panel.querySelector("h1") : null;
    if (heading instanceof HTMLElement) {
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: false });
    }
  }, [state.viewFocusToken, state.currentView]);

  const sessionPill =
    SESSION_PILL_COPY[state.session.status] || SESSION_PILL_COPY.error;
  const workspaceInert = state.panelMode !== "desktop" && state.chatOpen;
  const backdropHidden = !(state.panelMode === "drawer" && state.chatOpen);

  return (
    <>
      <a className="skip-link" href="#main-content">
        跳到主要内容 / Skip to content
      </a>

      <div className="app-shell" id="app-shell">
        <div className="workspace-shell" id="workspace-shell" inert={workspaceInert}>
          <header className="topbar">
            <a className="brand" href="./" aria-label="diandianreading 首页">
              <span className="brand-mark" aria-hidden="true">
                d
              </span>
              <span className="brand-copy">
                <strong>diandianreading</strong>
                <span>local reading workspace</span>
              </span>
            </a>
            <div className="topbar-actions">
              <p className="session-pill" id="session-pill" data-state={state.session.status}>
                <span className="status-dot" aria-hidden="true"></span>
                <span id="session-pill-text">{sessionPill}</span>
              </p>
              <button
                className="button button-secondary compact-only"
                id="open-chat-button"
                type="button"
                aria-controls="chat-panel"
                aria-expanded={state.chatOpen}
                onClick={(event) => controller.openChat(event.currentTarget)}
              >
                AI Chat / 对话
              </button>
            </div>
          </header>

          <nav className="primary-nav" aria-label="工作区 / Workspace">
            {NAV_ITEMS.map((item) => {
              const active = state.currentView === item.view;
              return (
                <button
                  className={active ? "nav-button is-active" : "nav-button"}
                  type="button"
                  data-view={item.view}
                  aria-current={active ? "page" : undefined}
                  key={item.view}
                  onClick={() => controller.handleNavView(item.view)}
                >
                  <span aria-hidden="true">{item.ordinal}</span>
                  {item.label}
                </button>
              );
            })}
            <button
              className="nav-button"
              id="nav-chat-button"
              type="button"
              aria-controls="chat-panel"
              aria-expanded={state.chatOpen}
              onClick={(event) => controller.openChat(event.currentTarget)}
            >
              <span aria-hidden="true">04</span>AI Chat / 对话
            </button>
          </nav>

          <div
            className="connectivity-banner"
            id="connectivity-banner"
            role="status"
            aria-live="polite"
            hidden={state.online}
          >
            <strong id="connectivity-title">Offline / 离线</strong>
            <span id="connectivity-message">
              浏览器报告网络不可用；本地 API 刷新与实时事件可能暂停。
            </span>
          </div>

          <main className="main-content" id="main-content" tabIndex={-1}>
            <ConnectionsView state={state} controller={controller} />
            <ImportView state={state} controller={controller} />
            <JobsView state={state} controller={controller} />
          </main>

          <footer className="workspace-footer">
            <p>Local-first · Same-origin · No credential persistence in browser storage</p>
            <p id="last-refresh-text">{state.lastRefreshText}</p>
          </footer>
        </div>

        <button
          className="chat-backdrop"
          id="chat-backdrop"
          type="button"
          aria-label="关闭 AI 对话 / Close AI chat"
          hidden={backdropHidden}
          onClick={() => controller.closeChat()}
        ></button>

        <ChatPanel state={state} controller={controller} />
      </div>

      <p className="sr-only" id="global-live" role="status" aria-live="polite" aria-atomic="true">
        {state.liveMessage}
      </p>
    </>
  );
}
