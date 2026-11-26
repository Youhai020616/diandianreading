import React from "react";
import type { ChatSessionSummary } from "../../types/desktop";
import { groupSessionsByContext } from "../../lib/chatSessions";
import { IconPlus, IconTrash } from "../Icons";
import { formatSessionTime } from "./askPanelShared";

interface ChatHistoryPopoverProps {
  sessions: ChatSessionSummary[];
  currentSessionId: string | null;
  running: boolean;
  onNewChat(): void;
  onOpen(sessionId: string): void;
  onDelete(event: React.MouseEvent, sessionId: string): void;
}

/** Saved conversations grouped by the book or page they started from. */
export const ChatHistoryPopover: React.FC<ChatHistoryPopoverProps> = ({
  sessions, currentSessionId, running, onNewChat, onOpen, onDelete,
}) => (
<div className="ai-history-popover" role="dialog" aria-label="历史对话记录">
  <div className="ai-history-head">
    <span>历史对话{sessions.length > 0 ? ` · ${sessions.length}` : ""}</span>
    <button
      type="button"
      className="ai-history-new-btn"
      disabled={running}
      onClick={onNewChat}
    >
      <IconPlus size={12} />
      <span>新对话</span>
    </button>
  </div>
  {sessions.length === 0 ? (
    <div className="ai-history-empty">
      还没有历史对话，开始提问后会自动保存。
    </div>
  ) : (
    <div className="ai-history-list">
      {groupSessionsByContext(sessions).map((group) => (
        <div key={group.label} className="ai-history-group">
          <div className="ai-history-group-label">{group.label}</div>
      {group.sessions.map((s) => {
        const active = s.id === currentSessionId;
        return (
          <div
            key={s.id}
            role="button"
            tabIndex={0}
            className={`ai-history-item ${active ? "active" : ""}`}
            onClick={() => onOpen(s.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(s.id);
              }
            }}
          >
            <div className="ai-history-item-main">
              <div className="ai-history-item-top">
                <span className="ai-history-item-title">{s.title}</span>
                <span className="ai-history-item-time">{formatSessionTime(s.updatedAt)}</span>
              </div>
              {s.preview && (
                <div className="ai-history-item-preview">{s.preview}</div>
              )}
            </div>
            <button
              type="button"
              className="ai-history-del-btn"
              onClick={(e) => onDelete(e, s.id)}
              title="删除该条对话"
              aria-label="删除该条对话"
            >
              <IconTrash size={12} />
            </button>
          </div>
        );
      })}
        </div>
      ))}
    </div>
  )}
</div>
);
