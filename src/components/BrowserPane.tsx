import React, { useEffect, useRef, useState } from "react";
import type { BrowserStateSnapshot } from "../types/desktop";
import {
  IconArrowLeft,
  IconArrowRight,
  IconClose,
  IconMoreHorizontal,
  IconPanelLeft,
  IconPanelRight,
  IconRefresh,
  IconSparkles,
} from "./Icons";
import { OrbitalLoader } from "./OrbitalLoader";

interface BrowserPaneProps {
  browserState: BrowserStateSnapshot | null;
  layoutKey?: number;
  railOpen: boolean;
  workspaceOpen: boolean;
  aiOpen: boolean;
  onToggleRail: () => void;
  onToggleWorkspace: () => void;
  onToggleAi: () => void;
  onCollapse: () => void;
  onOpenCookieImport: () => void;
  onOpenRouterSettings: () => void;
  onNotify: (msg: string, tone?: "info" | "success" | "error") => void;
}

export const BrowserPane: React.FC<BrowserPaneProps> = ({
  browserState,
  layoutKey,
  railOpen,
  workspaceOpen,
  aiOpen,
  onToggleRail,
  onToggleWorkspace,
  onToggleAi,
  onCollapse,
  onOpenCookieImport,
  onOpenRouterSettings,
  onNotify,
}) => {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);
  const activeTab = browserState?.tabs.find((t) => t.id === browserState.activeTabId) ?? null;
  const formatAddressUrl = (raw?: string | null) =>
    !raw || raw.startsWith("data:") ? "" : raw;
  const [urlInput, setUrlInput] = useState(() => formatAddressUrl(activeTab?.url));

  useEffect(() => {
    setUrlInput(formatAddressUrl(activeTab?.url));
  }, [activeTab?.id, activeTab?.url]);

  useEffect(() => {
    const off = window.diandian.browserMenu.onMainAction((act) => {
      if (act.kind === "import-cookie") {
        onOpenCookieImport();
      } else if (act.kind === "open-settings") {
        onOpenRouterSettings();
      } else if (act.kind === "notified" && act.message) {
        onNotify(act.message, "info");
      }
    });
    return off;
  }, [onOpenCookieImport, onOpenRouterSettings, onNotify]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const syncBounds = () => {
      const rect = el.getBoundingClientRect();
      const x = Math.max(0, Math.round(rect.left));
      const y = Math.max(0, Math.round(rect.top));
      const width = Math.max(0, Math.min(Math.round(rect.width), window.innerWidth - x));
      const height = Math.max(0, Math.min(Math.round(rect.height), window.innerHeight - y));
      window.diandian.browser.setBounds({ x, y, width, height });
    };

    const rafId = requestAnimationFrame(syncBounds);
    const ro = new ResizeObserver(syncBounds);
    ro.observe(el);
    window.addEventListener("resize", syncBounds);
    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      window.removeEventListener("resize", syncBounds);
    };
  }, [layoutKey]);

  const handleOpenUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = urlInput.trim();
    if (!target) return;
    try {
      await window.diandian.browser.openUrl(target, false);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "网址格式受限", "error");
    }
  };

  const handleShowMoreMenu = async () => {
    const rect = moreBtnRef.current?.getBoundingClientRect();
    try {
      await window.diandian.browser.showMoreMenu({
        x: rect ? rect.right : window.innerWidth - 40,
        y: rect ? rect.bottom : 38,
      });
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "打开菜单失败", "error");
    }
  };

  return (
    <section className="browser-pane">
      {/* Ultra-clean Deta Surf / Chrome 38px toolbar: Optional restore workspace + Back / Forward / Reload + URL Pill + More (···) + Collapse + Ask */}
      <div className={`browser-toolbar ${!railOpen && !workspaceOpen ? "has-traffic-lights" : ""}`}>
        {!workspaceOpen && !railOpen && (
          <button
            type="button"
            className="btn icon-only ghost"
            onClick={onToggleRail}
            title="展开左侧导航栏（快捷键 ⌘B）"
          >
            <IconPanelLeft size={14} />
          </button>
        )}

        {!workspaceOpen && (
          <button
            type="button"
            className="browser-restore-workspace-btn"
            onClick={onToggleWorkspace}
            title="展开左侧点点工作台（快捷键 ⌘⇧B）"
          >
            <span className="browser-restore-mark">点</span>
            <span>工作台</span>
          </button>
        )}

        <button
          type="button"
          className="btn icon-only ghost"
          disabled={!activeTab?.canGoBack}
          onClick={() => void window.diandian.browser.navigate("back")}
          title="后退"
        >
          <IconArrowLeft size={14} />
        </button>
        <button
          type="button"
          className="btn icon-only ghost"
          disabled={!activeTab?.canGoForward}
          onClick={() => void window.diandian.browser.navigate("forward")}
          title="前进"
        >
          <IconArrowRight size={14} />
        </button>
        <button
          type="button"
          className="btn icon-only ghost"
          onClick={() => void window.diandian.browser.navigate(activeTab?.isLoading ? "stop" : "reload")}
          title={activeTab?.isLoading ? "停止加载" : "刷新"}
        >
          {activeTab?.isLoading ? <IconClose size={13} /> : <IconRefresh size={13} />}
        </button>

        <form className="browser-url-form" onSubmit={(e) => void handleOpenUrl(e)}>
          <input
            className="browser-url-input"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="输入网址（如 weread.qq.com）…"
          />
        </form>

        <button
          ref={moreBtnRef}
          type="button"
          className="btn icon-only ghost browser-more-btn"
          onClick={() => void handleShowMoreMenu()}
          title="页面缩放、登录态导入与更多"
        >
          <IconMoreHorizontal size={15} />
        </button>

        <button
          type="button"
          className="btn icon-only ghost"
          onClick={onCollapse}
          title="收起右侧阅读浏览器（快捷键 ⌘\）"
        >
          <IconPanelRight size={14} />
        </button>

        {!aiOpen && (
          <button
            type="button"
            className="surf-ask-pill"
            onClick={onToggleAi}
            title="打开右侧「问点点」AI 共读面板（快捷键 ⌘L）"
          >
            <span className="surf-ask-pill-badge">
              <IconSparkles size={12} />
            </span>
            <span>问点点</span>
          </button>
        )}

        {/* Sleek 2px 21st.dev Shimmer Progress Beam while loading */}
        {activeTab?.isLoading && <div className="browser-progress-beam" aria-hidden="true" />}
      </div>

      {/* Native WebContentsView Mount Viewport with 21st.dev Orbital Loader + Text Shimmer */}
      <div className="browser-viewport" ref={viewportRef}>
        <div className="browser-placeholder">
          <OrbitalLoader url={activeTab?.url || urlInput} suppressed={Boolean(browserState?.suppressed)} />
        </div>
      </div>
    </section>
  );
};
