import React from "react";
import { IconCheck, IconCopy, IconPenLine, IconSparkles } from "../Icons";
import { MarkdownText } from "../MarkdownText";
import { normalizeDisplayTools, summarizeToolTrace, type ChatMessage } from "./askPanelShared";

interface ChatMessageItemProps {
  message: ChatMessage;
  /** Draft created from this reply, if it was saved. */
  savedDraftId?: string;
  savingDraft: boolean;
  copied: boolean;
  onSaveAsDraft(): void;
  onOpenDraft?(draftId: string): void;
  onCopy(): void;
}

/** One message: context tags, tool trace, collapsed reasoning, the text and reply actions. */
export const ChatMessageItem: React.FC<ChatMessageItemProps> = ({
  message, savedDraftId, savingDraft, copied, onSaveAsDraft, onOpenDraft, onCopy,
}) => (
  <div className={`msg-row ${message.role}`}>
    <div className="msg-bubble">
      {message.role === "assistant" && (
        <div className="msg-assistant-head">
          <span className="msg-assistant-seal">点</span>
          <span>点点共读</span>
        </div>
      )}

      {message.role === "user" && message.contexts && message.contexts.length > 0 && (
        <div className="msg-context-tags">
          {message.contexts.map((c, idx) => (
            <span key={`${c}-${idx}`} className="msg-context-tag">
              <IconSparkles size={10} />
              <span>{c}</span>
            </span>
          ))}
        </div>
      )}

      {(() => {
        const displayTools = normalizeDisplayTools(message.tools, Boolean(message.streaming));
        if (displayTools.length === 0) return null;
        const trace = summarizeToolTrace(displayTools, Boolean(message.streaming));
        return (
          <details className={`tool-trace-box ${trace.isActive ? "is-active" : ""}`}>
            <summary className="tool-trace-summary">
              <span className={`tool-trace-icon ${trace.isActive ? "active" : "done"}`}>
                {trace.isActive ? <IconSparkles size={12} /> : <IconCheck size={12} />}
              </span>
              <span className="tool-trace-headline">{trace.headline}</span>
            </summary>
            <div className="tool-trace-steps">
              {trace.grouped.map((step, idx) => (
                <div
                  key={`${step.rawName}-${idx}`}
                  className={`tool-trace-step ${step.status}`}
                  title={step.rawName}
                >
                  <span className="tool-trace-step-dot">
                    {step.status === "done" ? <IconCheck size={11} /> : <IconSparkles size={11} />}
                  </span>
                  <span className="tool-trace-step-label">{step.label}</span>
                  {step.count > 1 && <span className="tool-trace-step-count">×{step.count}</span>}
                </div>
              ))}
            </div>
          </details>
        );
      })()}

      {message.reasoning && (
        // Collapsed by default; the reader opens it on demand and it stays as they left it.
        <details className="reasoning-box">
          <summary>
            <span className={message.streaming && !message.text ? "shimmer-status-text" : undefined}>
              {message.streaming && !message.text ? "正在深度思考…" : "深度思考过程"}
            </span>
          </summary>
          <pre>{message.reasoning}</pre>
        </details>
      )}

      {message.role === "assistant" ? (
        message.text ? (
          <div className={message.streaming ? "streaming-prose" : undefined}>
            <MarkdownText content={message.text} />
            {message.streaming && <span className="stream-cursor" aria-hidden="true" />}
          </div>
        ) : (
          <span className="shimmer-status-text" style={{ fontSize: 13 }}>
            {message.streaming ? "正在阅读上下文并组织思路…" : ""}
          </span>
        )
      ) : (
        message.text
      )}

      {message.role === "assistant" && !message.streaming && message.text.trim() && (
        <div className="msg-actions">
          {savedDraftId ? (
            <button
              type="button"
              className="btn sm soft"
              onClick={() => onOpenDraft?.(savedDraftId)}
              title="已保存到创作工作台，点击直接查看"
            >
              <IconCheck size={12} />
              <span>已存初稿 · 查看</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn sm ghost"
              disabled={savingDraft}
              onClick={onSaveAsDraft}
            >
              <IconPenLine size={12} />
              <span>{savingDraft ? "保存中…" : "存为初稿"}</span>
            </button>
          )}
          <button type="button" className="btn sm ghost" onClick={onCopy}>
            {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
            <span>{copied ? "已复制" : "复制"}</span>
          </button>
        </div>
      )}
    </div>
  </div>
);
