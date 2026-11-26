import React from "react";
import { TAB_LABELS, type StudioTab } from "../app/workspace";
import { IconChevronRight, IconPanelLeft, IconPanelRight, IconSparkles } from "./Icons";

interface WorkspaceTopbarProps {
  railOpen: boolean;
  browserOpen: boolean;
  aiOpen: boolean;
  activeTab: StudioTab;
  breadcrumbDetail: string | null;
  onToggleRail(): void;
  onSelectTab(tab: StudioTab): void;
  onCollapseWorkspace(): void;
  onOpenBrowser(): void;
  onOpenAi(): void;
}

/** Breadcrumbs and pane toggles above the left workspace. */
export const WorkspaceTopbar: React.FC<WorkspaceTopbarProps> = ({
  railOpen, browserOpen, aiOpen, activeTab, breadcrumbDetail, onToggleRail, onSelectTab, onCollapseWorkspace,
  onOpenBrowser, onOpenAi,
}) => (
  <div className={`surf-topbar ${railOpen ? "" : "rail-collapsed"}`}>
    <div className="surf-topbar-left">
      <button
        type="button"
        className="btn icon-only ghost"
        onClick={onToggleRail}
        title={railOpen ? "收起左侧栏（⌘B）" : "展开左侧栏（⌘B）"}
      >
        <IconPanelLeft size={14} />
      </button>

      <div className="surf-breadcrumbs">
        <span className="surf-crumb-root">点点读书</span>
        <span className="surf-crumb-sep">
          <IconChevronRight size={12} />
        </span>
        <span className="surf-crumb-mid" onClick={() => onSelectTab(activeTab)}>
          {TAB_LABELS[activeTab]}
        </span>
        {breadcrumbDetail && (
          <>
            <span className="surf-crumb-sep">
              <IconChevronRight size={12} />
            </span>
            <span className="surf-crumb-current">{breadcrumbDetail}</span>
          </>
        )}
      </div>
    </div>

    <div className="surf-topbar-drag" />

    <div className="surf-topbar-right">
      {browserOpen && (
        <button
          type="button"
          className="btn sm ghost"
          style={{ height: 25, padding: "0 8px", fontSize: 11.5 }}
          onClick={onCollapseWorkspace}
          title="收起左侧工作台，专注大视野阅读右侧网页（快捷键 ⌘⇧B）"
        >
          <IconPanelLeft size={12} />
          <span>收起</span>
        </button>
      )}
      {!browserOpen && (
        <button
          type="button"
          className="btn sm soft"
          onClick={onOpenBrowser}
          title="展开右侧阅读浏览器（快捷键 ⌘\）"
        >
          <IconPanelRight size={13} />
          <span>展开阅读窗</span>
        </button>
      )}
      {!browserOpen && !aiOpen && (
        <button
          type="button"
          className="surf-ask-pill"
          onClick={onOpenAi}
          title="打开右侧「问点点」AI 共读面板（快捷键 ⌘L）"
        >
          <span className="surf-ask-pill-badge">
            <IconSparkles size={12} />
          </span>
          <span>问点点</span>
        </button>
      )}
    </div>
  </div>
);
