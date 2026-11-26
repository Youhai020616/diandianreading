import React, { useState } from "react";
import type { BrowserStateSnapshot, DownloadedBookFile, NotebookRecord } from "../types/desktop";
import { isStartPageTabUrl, QUICK_WEB_LINKS, tabMatchesSite, type QuickWebLink, type StudioTab } from "../app/workspace";
import type { usePaneDrag } from "../hooks/usePaneDrag";
import { IconBookOpen, IconClose, IconPaw, IconPlus, IconSettings, SiteBrandIcon } from "./Icons";
import brandLogoUrl from "../assets/brand/logo-small.svg";

export interface SurfRailNavItem {
  id: StudioTab;
  label: string;
  icon: React.ReactNode;
  count?: number;
}

type ReaderTab = DownloadedBookFile & { title?: string };

interface SurfRailProps {
  width: number;
  drag: ReturnType<typeof usePaneDrag>;
  onResetWidth(): void;
  navItems: SurfRailNavItem[];
  /** The highlighted workspace tab, or null while a book or a collapsed workspace is in front. */
  activeTab: StudioTab | null;
  onOpenTab(tab: StudioTab): void;
  notebooks: NotebookRecord[];
  activeNotebookId: string | null;
  onSelectNotebook(id: string): void;
  onCreateNotebook(name: string): Promise<boolean>;
  readerTabs: ReaderTab[];
  currentReaderPath: string | null;
  onReadBook(file: DownloadedBookFile): void;
  onCloseReaderTab(file: ReaderTab): void;
  browserState: BrowserStateSnapshot | null;
  /** The browser tab shown on the right, or null while it is hidden or a book is open. */
  currentBrowserTabId: string | null;
  onSelectBrowserTab(id: string): void;
  onCloseBrowserTab(id: string): void;
  onNewBrowserTab(): void;
  onOpenQuickSite(site: QuickWebLink): void;
  petVisible: boolean;
  onTogglePet(): void;
  onOpenModelSettings(): void;
}

/** Left sidebar: navigation, topic notebooks, open books and web tabs, quick sites and footer actions. */
export const SurfRail: React.FC<SurfRailProps> = ({
  width, drag, onResetWidth, navItems, activeTab, onOpenTab, notebooks, activeNotebookId, onSelectNotebook,
  onCreateNotebook, readerTabs, currentReaderPath, onReadBook, onCloseReaderTab, browserState, currentBrowserTabId,
  onSelectBrowserTab, onCloseBrowserTab, onNewBrowserTab, onOpenQuickSite, petVisible, onTogglePet, onOpenModelSettings,
}) => {
  const [creatingNotebook, setCreatingNotebook] = useState(false);
  const [newNotebookName, setNewNotebookName] = useState("");
  const browserTabs = browserState?.tabs ?? [];
  const activeBrowserTab = browserTabs.find((t) => t.id === browserState?.activeTabId) ?? null;

  const submitNotebook = async () => {
    const clean = newNotebookName.trim();
    if (!clean) {
      setCreatingNotebook(false);
      return;
    }
    if (await onCreateNotebook(clean)) {
      setNewNotebookName("");
      setCreatingNotebook(false);
    }
  };

  return (
    <>
      <aside
        className="surf-rail"
        aria-label="主导航与网页标签"
        style={{ width: `${width}px`, minWidth: `${width}px` }}
      >
        <div className="surf-brand-row">
          <div className="surf-brand-left">
            <img className="surf-brand-mark" src={brandLogoUrl} alt="" aria-hidden="true" />
            <span className="surf-brand-name">点点读书</span>
          </div>
        </div>

        <nav className="surf-nav-list">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`surf-nav-item ${activeTab === item.id ? "active" : ""}`}
              onClick={() => onOpenTab(item.id)}
            >
              {item.icon}
              <span className="surf-nav-label">{item.label}</span>
              {item.count !== undefined && <span className="surf-nav-count">{item.count}</span>}
            </button>
          ))}
        </nav>

        <div className="surf-rail-divider" />

        {/* Deta Surf-Style Topic Notebooks */}
        <div className="surf-section-head">
          <span>主题空间</span>
          <button
            type="button"
            className="btn icon-only ghost"
            style={{ width: 22, height: 22 }}
            onClick={() => setCreatingNotebook((v) => !v)}
            title="新建主题空间（把书目、草稿与网页打包共读）"
          >
            <IconPlus size={12} />
          </button>
        </div>

        {creatingNotebook && (
          <form
            className="surf-nb-create"
            onSubmit={(e) => {
              e.preventDefault();
              void submitNotebook();
            }}
          >
            <input
              className="surf-nb-input"
              autoFocus
              value={newNotebookName}
              onChange={(e) => setNewNotebookName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setCreatingNotebook(false);
                  setNewNotebookName("");
                }
              }}
              placeholder="输入主题名，回车创建…"
            />
          </form>
        )}

        {notebooks.length > 0 && (
          <div className="surf-nb-list">
            {notebooks.map((nb) => (
              <button
                key={nb.id}
                type="button"
                className={`surf-tab-item ${activeNotebookId === nb.id ? "active" : ""}`}
                onClick={() => onSelectNotebook(nb.id)}
                title={`${nb.name}（${nb.items.length} 项素材）`}
              >
                <span className="surf-nb-icon">{nb.icon || "✦"}</span>
                <span className="surf-nav-label">{nb.name}</span>
                {nb.items.length > 0 && <span className="surf-nav-count">{nb.items.length}</span>}
              </button>
            ))}
          </div>
        )}

        <div className="surf-rail-divider" />

        {/* Vertical Browser Tabs unified into Left Surf Sidebar */}
        <div className="surf-section-head">
          <span>阅读标签</span>
          <button
            type="button"
            className="btn icon-only ghost"
            style={{ width: 22, height: 22 }}
            onClick={onNewBrowserTab}
            title="新建空白标签页（可选择站点或输入网址）"
          >
            <IconPlus size={12} />
          </button>
        </div>

        <div className="surf-rail-tabs">
          {readerTabs.map(file => {
            const title = file.title || file.fileName.replace(/\.epub$/i, "");
            const current = currentReaderPath === file.filePath;
            return (
              <div key={file.filePath} className={`surf-tab-item local-book-tab ${current ? "active" : ""}`}>
                <button type="button" className="local-book-tab-select" aria-pressed={current}
                  title={title} aria-label={`阅读《${title}》`} onClick={() => onReadBook(file)}>
                  <IconBookOpen size={14} /><span className="surf-nav-label">{title}</span>
                </button>
                <button type="button" className="surf-tab-close" aria-label={`关闭《${title}》标签`}
                  onClick={() => onCloseReaderTab(file)}><IconClose size={11} /></button>
              </div>
            );
          })}
          {browserTabs.map((tab) => {
            const isCurrent = tab.id === currentBrowserTabId;
            const isStart = isStartPageTabUrl(tab.url);
            const displayTitle = isStart ? "新标签页" : tab.title || "加载中…";
            return (
              <div
                key={tab.id}
                className={`surf-tab-item ${isCurrent ? "active" : ""}`}
                onClick={() => onSelectBrowserTab(tab.id)}
                title={isStart ? "新标签页" : tab.title || tab.url}
              >
                <SiteBrandIcon url={tab.url} faviconUrl={tab.faviconUrl} size={14} />
                <span className="surf-nav-label">{displayTitle}</span>
                {browserTabs.length > 1 && (
                  <button
                    type="button"
                    className="surf-tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseBrowserTab(tab.id);
                    }}
                    title="关闭标签页"
                  >
                    <IconClose size={11} />
                  </button>
                )}
              </div>
            );
          })}

          <div className="surf-quick-links">
            {QUICK_WEB_LINKS.map((site) => {
              const alreadyOpen = browserTabs.some((t) => tabMatchesSite(t.url, site.matchHosts));
              const onStartPage = Boolean(activeBrowserTab && isStartPageTabUrl(activeBrowserTab.url));
              const tooltip = onStartPage
                ? `在当前新标签页打开${site.label}`
                : alreadyOpen
                  ? `切换到已打开的${site.label}标签页`
                  : `在新标签页打开${site.label}`;
              return (
                <button
                  key={site.label}
                  type="button"
                  className="surf-quick-pill"
                  onClick={() => onOpenQuickSite(site)}
                  title={tooltip}
                >
                  <SiteBrandIcon url={site.url} size={14} />
                  <span>{site.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="surf-rail-footer">
          <button
            type="button"
            className="surf-footer-btn"
            onClick={onTogglePet}
            title={petVisible ? "隐藏桌面伴读小金毛" : "召唤桌面伴读小金毛"}
          >
            <IconPaw size={14} />
            <span>小金毛</span>
            {petVisible && <span className="surf-status-dot" />}
          </button>

          <button
            type="button"
            className="surf-footer-btn"
            onClick={onOpenModelSettings}
            title="模型与 API Key 设置"
          >
            <IconSettings size={14} />
            <span>模型</span>
          </button>
        </div>
      </aside>
      <div
        {...drag.handleProps(width)}
        className={`rail-resize-handle ${drag.dragging ? "dragging" : ""}`}
        onDoubleClick={onResetWidth}
        title="拖动调整左侧栏宽度（拖至最左自动收起，双击重置）"
      />
    </>
  );
};
