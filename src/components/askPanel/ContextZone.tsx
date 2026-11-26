import React, { useEffect, useMemo, useRef, useState } from "react";
import type { BookRecord, BrowserStateSnapshot, DraftRecord } from "../../types/desktop";
import type { ContextAttachment } from "../DockedAskBar";
import { IconBookOpen, IconClose, IconFileText, IconGlobe, IconPlus, IconSparkles } from "../Icons";

interface ContextZoneProps {
  /** Beside the composer in a conversation; above it on the empty stage. */
  docked: boolean;
  autoContext: ContextAttachment | null;
  activeAutoContext: ContextAttachment | null;
  attachments: ContextAttachment[];
  books: BookRecord[];
  drafts: DraftRecord[];
  browserState: BrowserStateSnapshot | null;
  onDismissAuto(id: string | null): void;
  onToggle(item: ContextAttachment): void;
  onRemove(id: string): void;
}

/** Context chips for the next question (the page or book in front, plus attached items) and the picker. */
export const ContextZone: React.FC<ContextZoneProps> = ({
  docked, autoContext, activeAutoContext, attachments, books, drafts, browserState, onDismissAuto, onToggle, onRemove,
}) => {
  const [pickerOpen, setPickerOpen] = useState(false);
  const zoneRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (zoneRef.current && !zoneRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [pickerOpen]);

  const pickerOptions = useMemo(() => {
    const webItems: ContextAttachment[] = (browserState?.tabs ?? []).slice(0, 4).map((t) => ({
      id: `web:${t.id}`,
      kind: "web",
      label: t.title || "当前网页",
      meta: t.url,
    }));
    const bookItems: ContextAttachment[] = books.slice(0, 8).map((b) => ({
      id: `book:${b.id}`,
      kind: "book",
      label: `《${b.title}》`,
      meta: `${b.highlightCount} 条划线`,
    }));
    const draftItems: ContextAttachment[] = drafts.slice(0, 5).map((d) => ({
      id: `draft:${d.id}`,
      kind: "draft",
      label: d.title,
      meta: `v${d.latestRevisionNo}`,
    }));
    return { webItems, bookItems, draftItems };
  }, [browserState?.tabs, books, drafts]);

  const toggle = (item: ContextAttachment) => {
    onToggle(item);
    setPickerOpen(false);
  };

  return (
  <div className={`ai-surf-context-zone ${docked ? "docked" : "in-empty"}`} ref={zoneRef}>
    <div className="ai-surf-context-pills">
      {activeAutoContext ? (
        <span
          className="ai-surf-active-pill"
          title="已自动感知当前阅读 / 工作上下文，点击 × 可取消关联"
        >
          <IconSparkles size={13} />
          <span className="ai-surf-pill-text">{activeAutoContext.label}</span>
          <button
            type="button"
            className="ai-surf-pill-x"
            onClick={() => onDismissAuto(activeAutoContext.id)}
            aria-label="取消自动关联当前上下文"
          >
            <IconClose size={11} />
          </button>
        </span>
      ) : autoContext ? (
        <button
          type="button"
          className="ai-surf-active-pill restored"
          onClick={() => onDismissAuto(null)}
          title="点击重新关联当前上下文"
        >
          <IconSparkles size={13} />
          <span className="ai-surf-pill-text">关联当前上下文</span>
        </button>
      ) : null}

      {attachments.map((att) => (
        <span key={att.id} className="ai-surf-attached-pill">
          {att.kind === "web" ? (
            <IconGlobe size={12} />
          ) : att.kind === "draft" ? (
            <IconFileText size={12} />
          ) : (
            <IconBookOpen size={12} />
          )}
          <span className="ai-surf-pill-text">{att.label}</span>
          <button
            type="button"
            className="ai-surf-pill-x"
            onClick={() => onRemove(att.id)}
            aria-label="移除上下文"
          >
            <IconClose size={11} />
          </button>
        </span>
      ))}
    </div>

    <div className="ai-surf-add-row">
      <button
        type="button"
        className={`ai-surf-add-btn ${pickerOpen ? "open" : ""}`}
        onClick={() => setPickerOpen((v) => !v)}
      >
        <IconPlus size={13} />
        <span>添加上下文</span>
      </button>

      {pickerOpen && (
        <div className="ai-ctx-popover" role="listbox" aria-label="选择要挂载的上下文">
          {pickerOptions.webItems.length > 0 && (
            <>
              <div className="surf-mention-section">已打开网页</div>
              {pickerOptions.webItems.map((item) => {
                const added = attachments.some((a) => a.id === item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="surf-mention-item"
                    onClick={() => toggle(item)}
                  >
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                      <IconGlobe size={13} style={{ flexShrink: 0, color: "#4a78f0" }} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.label}
                      </span>
                    </span>
                    <span className="surf-mention-item-sub">{added ? "已添加" : "网页"}</span>
                  </button>
                );
              })}
            </>
          )}

          {pickerOptions.bookItems.length > 0 && (
            <>
              <div className="surf-mention-section">阅读笔记</div>
              {pickerOptions.bookItems.map((item) => {
                const added = attachments.some((a) => a.id === item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="surf-mention-item"
                    onClick={() => toggle(item)}
                  >
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                      <IconBookOpen size={13} style={{ flexShrink: 0, color: "var(--accent)" }} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.label}
                      </span>
                    </span>
                    <span className="surf-mention-item-sub">{added ? "已添加" : item.meta}</span>
                  </button>
                );
              })}
            </>
          )}

          {pickerOptions.draftItems.length > 0 && (
            <>
              <div className="surf-mention-section">创作草稿</div>
              {pickerOptions.draftItems.map((item) => {
                const added = attachments.some((a) => a.id === item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="surf-mention-item"
                    onClick={() => toggle(item)}
                  >
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                      <IconFileText size={13} style={{ flexShrink: 0, color: "#be123c" }} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.label}
                      </span>
                    </span>
                    <span className="surf-mention-item-sub">{added ? "已添加" : item.meta}</span>
                  </button>
                );
              })}
            </>
          )}

          {pickerOptions.webItems.length === 0
            && pickerOptions.bookItems.length === 0
            && pickerOptions.draftItems.length === 0 && (
              <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--ink-muted)", textAlign: "center" }}>
                暂无可挂载的网页、书目或草稿
              </div>
            )}
        </div>
      )}
    </div>
  </div>
  );
};
