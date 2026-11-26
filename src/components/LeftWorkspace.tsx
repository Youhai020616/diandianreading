import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  AgentEvent,
  BookRecord,
  BrowserStateSnapshot,
  ChatSessionSummary,
  DraftRecord,
  PublicModelSettings,
  SafetyMode,
} from "../types/desktop";
import { DockedAskBar, type ContextAttachment } from "./DockedAskBar";
import { IconArrowUp, IconHistory, IconPanelRight, IconSquarePen } from "./Icons";
import {
  cleanReadablePageTitle, deriveSessionTitle, STARTERS, type ChatMessage, type PendingPromptPayload,
} from "./askPanel/askPanelShared";
import { ChatHistoryPopover } from "./askPanel/ChatHistoryPopover";
import { ChatMessageItem } from "./askPanel/ChatMessageItem";
import { ContextZone } from "./askPanel/ContextZone";
import { contextSubject } from "../lib/chatSessions";

export type { PendingPromptPayload };

interface LeftWorkspaceProps {
  books: BookRecord[];
  drafts: DraftRecord[];
  browserState: BrowserStateSnapshot | null;
  modelSettings: PublicModelSettings | null;
  safetyMode: SafetyMode;
  autoContext: ContextAttachment | null;
  pendingPrompt: PendingPromptPayload | null;
  onConsumePendingPrompt: () => void;
  onClose: () => void;
  onOpenSettings: () => void;
  onSelectModel: (modelId: string) => Promise<void> | void;
  onSelectSafety: (mode: SafetyMode) => void;
  onSaveAsDraft: (content: string) => Promise<string | null> | void;
  onOpenDraft?: (draftId: string) => void;
  onNotify: (msg: string, tone?: "info" | "success" | "error") => void;
}

export const LeftWorkspace: React.FC<LeftWorkspaceProps> = ({
  books,
  drafts,
  browserState,
  modelSettings,
  safetyMode,
  autoContext,
  pendingPrompt,
  onConsumePendingPrompt,
  onClose,
  onOpenSettings,
  onSelectModel,
  onSelectSafety,
  onSaveAsDraft,
  onOpenDraft,
  onNotify,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [savingDraftMsgId, setSavingDraftMsgId] = useState<string | null>(null);
  const [savedDraftByMsgId, setSavedDraftByMsgId] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<ContextAttachment[]>([]);
  const [dismissedAutoId, setDismissedAutoId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  // The book / page / draft the current conversation started from (its history group).
  const [sessionContext, setSessionContext] = useState("");
  const sessionContextRef = useRef("");
  const [dismissedSuggestion, setDismissedSuggestion] = useState("");
  const historyRef = useRef<HTMLDivElement | null>(null);
  const currentSessionIdRef = useRef<string | null>(null);
  const harnessSessionIdRef = useRef<string | null>(null);
  const activeAssistantIdRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Follow new output only while the reader is at the bottom; sending a message always returns there.
  const stickToBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  // React may call state updaters twice in development, so saving happens after the render instead.
  const pendingPersistRef = useRef<{ sid: string | null; hid?: string | null; exclude?: string } | null>(null);
  // Blocks a second Enter before the engine reports that it started.
  const sendingRef = useRef(false);
  // Bumped when a prompt is prefilled from elsewhere so the composer takes focus (Enter then sends).
  const [composerFocusTick, setComposerFocusTick] = useState(0);

  currentSessionIdRef.current = currentSessionId;
  const changeSessionContext = useCallback((label: string) => {
    sessionContextRef.current = label;
    setSessionContext(label);
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      const list = await window.diandian.agent.listSessions(40);
      setSessions(list);
    } catch {
      // Non-fatal
    }
  }, []);

  const persistMessages = useCallback(
    (nextMessages: ChatMessage[], explicitSessionId?: string | null, explicitHarnessId?: string | null) => {
      if (nextMessages.length === 0) return;
      const sid = explicitSessionId ?? currentSessionIdRef.current ?? `chat_${Date.now()}`;
      if (sid !== currentSessionIdRef.current) {
        currentSessionIdRef.current = sid;
        setCurrentSessionId(sid);
      }
      const hid =
        explicitHarnessId !== undefined
          ? explicitHarnessId ?? ""
          : harnessSessionIdRef.current ?? "";
      const title = deriveSessionTitle(nextMessages);
      void window.diandian.agent
        .saveSession({
          id: sid,
          title,
          harnessSessionId: hid,
          contextLabel: sessionContextRef.current,
          messages: nextMessages.map((m) => ({
            id: m.id,
            role: m.role,
            text: m.text,
            reasoning: m.reasoning ?? "",
            contexts: m.contexts ?? [],
            tools: m.tools ?? [],
          })),
        })
        .then(() => refreshSessions())
        .catch(() => undefined);
    },
    [refreshSessions],
  );

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  const activeAutoContext =
    autoContext && autoContext.id !== dismissedAutoId && !attachments.some((a) => a.id === autoContext.id)
      ? autoContext
      : null;

  useEffect(() => {
    if (!historyOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setHistoryOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHistoryOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [historyOpen]);

  const sendPrompt = useCallback(
    async (overridePrompt?: string, displayText?: string, contextLabels?: string[], subject = "") => {
      const prompt = (overridePrompt ?? input).trim();
      if (!prompt || running || sendingRef.current) return;
      if (!modelSettings?.hasApiKey) {
        onOpenSettings();
        onNotify("请先配置 DeepSeek 或 OpenAI 兼容 API Key", "error");
        return;
      }

      const sid = currentSessionIdRef.current ?? `chat_${Date.now()}`;
      const isFreshSession = !currentSessionIdRef.current;
      if (isFreshSession) {
        currentSessionIdRef.current = sid;
        setCurrentSessionId(sid);
        harnessSessionIdRef.current = null;
        changeSessionContext(subject);
      }

      const shown = (displayText ?? prompt).trim();
      const userMsg: ChatMessage = {
        id: `u_${Date.now()}`,
        role: "user",
        text: shown,
        ...(contextLabels && contextLabels.length > 0 ? { contexts: contextLabels } : {}),
      };
      const assistantId = `a_${Date.now() + 1}`;
      activeAssistantIdRef.current = assistantId;
      sendingRef.current = true;
      setRunning(true);
      stickToBottomRef.current = true;
      setAtBottom(true);

      pendingPersistRef.current = { sid, exclude: assistantId };
      setMessages((prev) => [
        ...prev,
        userMsg,
        { id: assistantId, role: "assistant" as const, text: "", reasoning: "", tools: [], streaming: true },
      ]);
      if (!overridePrompt) setInput("");

      try {
        await window.diandian.agent.send(prompt, {
          newSession: isFreshSession,
          sessionId: isFreshSession ? null : harnessSessionIdRef.current,
        });
      } catch (error) {
        activeAssistantIdRef.current = null;
        sendingRef.current = false;
        setRunning(false);
        const message = error instanceof Error ? error.message : String(error);
        pendingPersistRef.current = { sid };
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== assistantId),
          { id: `sys_${Date.now()}`, role: "system" as const, text: message },
        ]);
      }
    },
    [input, running, modelSettings?.hasApiKey, onOpenSettings, onNotify, changeSessionContext],
  );

  useEffect(() => {
    if (!pendingPrompt) return;
    const { text, autoSend, standalone } = pendingPrompt;
    onConsumePendingPrompt();
    // A self-contained prompt hides the automatic context chip; the user can still add it back.
    if (standalone && autoContext) setDismissedAutoId(autoContext.id);
    if (autoSend && modelSettings?.hasApiKey && !running) {
      void sendPrompt(text, undefined, undefined, standalone ? "" : contextSubject(autoContext));
    } else {
      setInput(text);
      setComposerFocusTick((n) => n + 1);
    }
  }, [pendingPrompt, onConsumePendingPrompt, modelSettings?.hasApiKey, running, sendPrompt, autoContext]);

  useEffect(() => {
    const job = pendingPersistRef.current;
    if (!job) return;
    pendingPersistRef.current = null;
    persistMessages(job.exclude ? messages.filter((m) => m.id !== job.exclude) : messages, job.sid, job.hid);
  }, [messages, persistMessages]);

  // Measure "at bottom" before new content lands; measuring afterwards counts the new message as distance.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stickToBottomRef.current = bottom;
    setAtBottom(bottom);
  };

  const scrollToLatest = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  useEffect(() => {
    const off = window.diandian.agent.onEvent((ev: AgentEvent) => {
      if (ev.kind === "status") {
        setRunning(ev.running);
        if (ev.running) sendingRef.current = false;
        if (!ev.running) {
          sendingRef.current = false;
          activeAssistantIdRef.current = null;
          setMessages((prev) =>
            prev.some((m) => m.streaming || m.tools?.some((t) => t.status === "running"))
              ? prev.map((m) =>
                  m.streaming || m.tools?.some((t) => t.status === "running")
                    ? {
                        ...m,
                        streaming: false,
                        ...(m.tools ? { tools: m.tools.map((t) => ({ ...t, status: "done" as const })) } : {}),
                      }
                    : m,
                )
              : prev,
          );
        }
        return;
      }
      if (ev.kind === "session-reset") {
        activeAssistantIdRef.current = null;
        return;
      }
      if (ev.kind === "stream") {
        const targetId = activeAssistantIdRef.current;
        if (!targetId) return;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== targetId) return m;
            if (ev.streamRole === "reasoning") {
              return { ...m, reasoning: `${m.reasoning ?? ""}${ev.text}` };
            }
            return { ...m, text: `${m.text}${ev.text}` };
          }),
        );
        return;
      }
      if (ev.kind === "tool") {
        const targetId = activeAssistantIdRef.current;
        if (!targetId) return;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== targetId) return m;
            const tools = [...(m.tools ?? [])];
            let nextText = m.text;
            let nextReasoning = m.reasoning;

            if (ev.phase === "start") {
              // If the model emitted brief pre-tool narration ("我先读取…"), fold it into reasoning
              // so the final answer stays spotless without stacked step monologues.
              const trimmedDraft = nextText.trim();
              if (trimmedDraft.length > 0 && trimmedDraft.length <= 240) {
                nextReasoning = nextReasoning
                  ? `${nextReasoning.trimEnd()}\n\n${trimmedDraft}`
                  : trimmedDraft;
                nextText = "";
              }
              tools.push({
                ...(ev.callId ? { callId: ev.callId } : {}),
                name: ev.name,
                status: "running",
              });
            } else {
              let idx = -1;
              if (ev.callId) {
                idx = tools.findIndex((t) => t.callId === ev.callId && t.status === "running");
              }
              if (idx < 0 && ev.name && ev.name !== "tool") {
                idx = tools.findIndex((t) => t.name === ev.name && t.status === "running");
              }
              if (idx < 0) {
                idx = tools.findIndex((t) => t.status === "running");
              }
              if (idx >= 0) {
                const existing = tools[idx]!;
                tools[idx] = {
                  ...existing,
                  name: existing.name && existing.name !== "tool" ? existing.name : ev.name,
                  status: "done",
                };
              } else if (ev.name && ev.name !== "tool") {
                tools.push({
                  ...(ev.callId ? { callId: ev.callId } : {}),
                  name: ev.name,
                  status: "done",
                });
              }
            }
            return { ...m, text: nextText, reasoning: nextReasoning, tools };
          }),
        );
        return;
      }
      if (ev.kind === "final") {
        const targetId = activeAssistantIdRef.current;
        activeAssistantIdRef.current = null;
        if (ev.sessionId) {
          harnessSessionIdRef.current = ev.sessionId;
        }
        pendingPersistRef.current = { sid: currentSessionIdRef.current, hid: ev.sessionId ?? harnessSessionIdRef.current };
        setMessages((prev) => {
          const next: ChatMessage[] = !targetId
            ? ev.finalResponse
              ? [...prev, { id: `a_${Date.now()}`, role: "assistant", text: ev.finalResponse, streaming: false }]
              : prev
            : prev.map((m) => {
                if (m.id !== targetId) return m;
                const finalText = (ev.finalResponse || "").trim();
                const streamed = m.text.trim();
                // Prefer harness's clean finalResponse whenever it represents the final assistant reply
                // (avoids keeping concatenated pre-tool narration paragraphs).
                const useFinal =
                  Boolean(finalText)
                  && (!streamed
                    || finalText.startsWith(streamed)
                    || streamed.endsWith(finalText)
                    || finalText.length >= streamed.length * 0.55);
                const nextText = useFinal ? finalText : m.text || finalText;
                const doneTools = m.tools?.map((t) => ({ ...t, status: "done" as const }));
                return {
                  ...m,
                  text: nextText,
                  ...(doneTools ? { tools: doneTools } : {}),
                  streaming: false,
                };
              });
          return next;
        });
        return;
      }
      if (ev.kind === "error") {
        setRunning(false);
        sendingRef.current = false;
        activeAssistantIdRef.current = null;
        if (ev.sessionId) {
          harnessSessionIdRef.current = ev.sessionId;
        }
        pendingPersistRef.current = { sid: currentSessionIdRef.current, hid: ev.sessionId ?? harnessSessionIdRef.current };
        setMessages((prev) => [
          ...prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
          { id: `sys_${Date.now()}`, role: "system", text: ev.message },
        ]);
      }
    });
    return off;
  }, []);

  const handleCapturePagePrompt = async () => {
    try {
      const snap = await window.diandian.browser.readPage(4000);
      const cleanTitle = cleanReadablePageTitle(snap.title);
      if (snap.selection) {
        setInput(
          `关于右侧《${cleanTitle}》里我选中的这段话：\n\n「${snap.selection}」\n\n请帮我拆解它的核心观点，并给一个能落地的反问或延伸。`,
        );
        onNotify("已将右侧选中段落填入输入框", "success");
      } else if (snap.extractionMethod === "canvas-ocr" && snap.textLength >= 30) {
        setInput(
          `请读取右侧页面《${cleanTitle}》当前屏幕的内容，帮我提炼值得存入阅读笔记的 2-3 条金句与个人思考。`,
        );
        onNotify(`已本地识别当前阅读页正文（约 ${snap.textLength} 字），可直接发送`, "success");
      } else if (!snap.likelyCanvasReader && snap.textLength > 40) {
        setInput(
          `请读取右侧页面《${cleanTitle}》的内容，帮我提炼值得存入阅读笔记的 2-3 条金句与个人思考。`,
        );
        onNotify("已关联右侧当前页面", "success");
      } else {
        onNotify(
          snap.likelyCanvasReader
            ? "未能识别当前 Canvas 页面正文，请翻到正文页重试，或先选中段落/切到「笔记」页"
            : "右侧页面暂无可读正文",
          "info",
        );
      }
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "读取右侧页面失败", "error");
    }
  };

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((curr) => (curr === id ? null : curr)), 1600);
    } catch {
      onNotify("复制失败", "error");
    }
  };

  const handleReset = async () => {
    if (messages.length > 0 && currentSessionIdRef.current) {
      persistMessages(messages, currentSessionIdRef.current, harnessSessionIdRef.current);
    }
    await window.diandian.agent.reset();
    activeAssistantIdRef.current = null;
    currentSessionIdRef.current = null;
    harnessSessionIdRef.current = null;
    setCurrentSessionId(null);
    changeSessionContext("");
    setDismissedSuggestion("");
    setMessages([]);
    setAttachments([]);
    setDismissedAutoId(null);
    setHistoryOpen(false);
  };

  const handleOpenSession = async (sessionId: string) => {
    if (running) {
      onNotify("正在回复中，请稍候或先停止后再切换历史会话", "info");
      return;
    }
    try {
      const detail = await window.diandian.agent.getSession(sessionId);
      if (!detail) {
        onNotify("该历史对话已不存在", "info");
        void refreshSessions();
        return;
      }
      currentSessionIdRef.current = detail.id;
      harnessSessionIdRef.current = detail.harnessSessionId || null;
      activeAssistantIdRef.current = null;
      setCurrentSessionId(detail.id);
      changeSessionContext(detail.contextLabel);
      setDismissedSuggestion("");
      setMessages(
        detail.messages.map((m) => ({
          id: m.id,
          role: m.role,
          text: m.text,
          reasoning: m.reasoning || undefined,
          contexts: m.contexts.length > 0 ? m.contexts : undefined,
          tools: m.tools.length > 0 ? m.tools : undefined,
          streaming: false,
        })),
      );
      await window.diandian.agent.selectSession(detail.harnessSessionId || null);
      setHistoryOpen(false);
      stickToBottomRef.current = true;
      setAtBottom(true);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "加载历史对话失败", "error");
    }
  };

  const handleDeleteSession = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    try {
      await window.diandian.agent.deleteSession(sessionId);
      if (currentSessionIdRef.current === sessionId) {
        await window.diandian.agent.reset();
        currentSessionIdRef.current = null;
        harnessSessionIdRef.current = null;
        setCurrentSessionId(null);
        changeSessionContext("");
        setMessages([]);
      }
      await refreshSessions();
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "删除历史对话失败", "error");
    }
  };

  const isEmpty = messages.length === 0;
  // Suggest (never force) a new conversation when the reader moves to another book or page subject.
  const activeSubject = contextSubject(activeAutoContext);
  const suggestedSubject = !isEmpty && !running && sessionContext && activeSubject
    && activeSubject !== sessionContext && activeSubject !== dismissedSuggestion ? activeSubject : "";

  const contextZoneNode = (
    <ContextZone
      docked={!isEmpty}
      autoContext={autoContext}
      activeAutoContext={activeAutoContext}
      attachments={attachments}
      books={books}
      drafts={drafts}
      browserState={browserState}
      onDismissAuto={setDismissedAutoId}
      onToggle={(item) =>
        setAttachments((prev) => (prev.some((x) => x.id === item.id) ? prev.filter((x) => x.id !== item.id) : [...prev, item]))}
      onRemove={(id) => setAttachments((prev) => prev.filter((x) => x.id !== id))}
    />
  );

  const askBarNode = (
    <DockedAskBar
      compact
      surfDrawer
      value={input}
      onChange={setInput}
      focusSignal={composerFocusTick}
      placeholder="问点点任何跨书思考与写作问题，输入 @ 挂载上下文…"
      running={running}
      autoContext={autoContext}
      attachments={attachments}
      onAttachmentsChange={setAttachments}
      dismissedAutoId={dismissedAutoId}
      onDismissAutoId={setDismissedAutoId}
      books={books}
      drafts={drafts}
      browserState={browserState}
      modelSettings={modelSettings}
      safetyMode={safetyMode}
      onOpenSettings={onOpenSettings}
      onSelectModel={onSelectModel}
      onSelectSafety={onSelectSafety}
      onStop={() => void window.diandian.agent.stop()}
      onCapturePage={() => void handleCapturePagePrompt()}
      onSubmit={(composed, rawText, atts) =>
        void sendPrompt(
          composed,
          rawText,
          atts.map((a) => a.label),
          contextSubject(atts[0]),
        )
      }
    />
  );

  return (
    <div className="chat-view ai-drawer-inner">
      {/* Deta Surf Minimalist Borderless Drawer Header */}
      <header className="ai-drawer-header">
        <div className="ai-drawer-header-left" ref={historyRef}>
          <button
            type="button"
            className="ai-header-icon-btn ai-header-new-chat"
            onClick={() => void handleReset()}
            disabled={running}
            title="开启新对话（当前记录会自动保存在历史中）"
          >
            <IconSquarePen size={15} />
            <span>新对话</span>
          </button>
          <button
            type="button"
            className={`ai-header-icon-btn ${historyOpen ? "active" : ""}`}
            onClick={() => {
              if (!historyOpen) void refreshSessions();
              setHistoryOpen((v) => !v);
            }}
            title={sessions.length > 0 ? `历史对话（${sessions.length} 条）` : "历史对话"}
          >
            <IconHistory size={15} />
          </button>
          <button
            type="button"
            className="ai-header-icon-btn"
            onClick={onClose}
            title="收起问点点（快捷键 ⌘L）"
          >
            <IconPanelRight size={15} />
          </button>

          {historyOpen && (
            <ChatHistoryPopover
              sessions={sessions}
              currentSessionId={currentSessionId}
              running={running}
              onNewChat={() => void handleReset()}
              onOpen={(id) => void handleOpenSession(id)}
              onDelete={(e, id) => void handleDeleteSession(e, id)}
            />
          )}
        </div>

        <span className="ai-drawer-brand-whisper">问点点</span>
        <div className="ai-drawer-header-spacer" />
      </header>

      {isEmpty ? (
        /* New Chat Centered Stage: Active Context + Centered Composer + Recommended Cards Below */
        <div className="ai-empty-stage">
          <div className="ai-empty-center-stack">
            <div className="ai-empty-composer-block">
              {contextZoneNode}
              {askBarNode}
            </div>

            <div className="ai-empty-below">
              {sessions.length > 0 && (
                <button
                  type="button"
                  className="ai-resume-last-pill"
                  onClick={() => void handleOpenSession(sessions[0]!.id)}
                  title="点击恢复上次对话继续聊"
                >
                  <IconHistory size={12} />
                  <span className="ai-resume-last-label">继续上次：</span>
                  <span className="ai-resume-last-title">{sessions[0]!.title}</span>
                </button>
              )}

              <div className="ai-drawer-starters">
                {STARTERS.map((s) => (
                  <button
                    key={s.title}
                    type="button"
                    className="ai-starter-item"
                    onClick={() => void sendPrompt(s.prompt, s.title, undefined, contextSubject(activeAutoContext))}
                  >
                    <div className="ai-starter-title">{s.title}</div>
                    <div className="ai-starter-desc">{s.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* Active Chat Mode: Scrollable Messages + Bottom Composer with its attached context */
        <>
          <div className="chat-messages ai-drawer-messages" ref={listRef} onScroll={handleListScroll}>
            {messages.map((m) => (
              <ChatMessageItem
                key={m.id}
                message={m}
                savedDraftId={savedDraftByMsgId[m.id]}
                savingDraft={savingDraftMsgId === m.id}
                copied={copiedId === m.id}
                onOpenDraft={onOpenDraft}
                onCopy={() => void handleCopy(m.id, m.text)}
                onSaveAsDraft={async () => {
                  setSavingDraftMsgId(m.id);
                  try {
                    const draftId = await onSaveAsDraft(m.text);
                    if (typeof draftId === "string" && draftId) {
                      setSavedDraftByMsgId((prev) => ({ ...prev, [m.id]: draftId }));
                    }
                  } finally {
                    setSavingDraftMsgId((curr) => (curr === m.id ? null : curr));
                  }
                }}
              />
            ))}
          </div>

          <div className="ai-docked-composer">
            {!atBottom && (
              <button type="button" className="ai-jump-latest" onClick={scrollToLatest} aria-label="回到最新消息">
                <IconArrowUp size={14} style={{ transform: "rotate(180deg)" }} />
                <span>{running ? "查看最新回复" : "回到底部"}</span>
              </button>
            )}
            {suggestedSubject && (
              <div className="ai-context-switch" role="status">
                <span>正在看<strong>{suggestedSubject}</strong>，要为它开一个新对话吗？</span>
                <button type="button" onClick={() => void handleReset()}>新对话</button>
                <button type="button" className="ghost" onClick={() => setDismissedSuggestion(suggestedSubject)}>继续当前</button>
              </div>
            )}
            {contextZoneNode}
            {askBarNode}
          </div>
        </>
      )}
    </div>
  );
};
