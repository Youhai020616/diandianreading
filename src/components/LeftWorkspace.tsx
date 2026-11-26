import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import {
  IconArrowUp,
  IconBookOpen,
  IconCheck,
  IconClose,
  IconCopy,
  IconFileText,
  IconGlobe,
  IconHistory,
  IconPanelRight,
  IconPenLine,
  IconPlus,
  IconSparkles,
  IconSquarePen,
  IconTrash,
} from "./Icons";
import { MarkdownText } from "./MarkdownText";
import { contextSubject, groupSessionsByContext } from "../lib/chatSessions";

export interface PendingPromptPayload {
  text: string;
  autoSend?: boolean;
}

interface ToolTraceEntry {
  callId?: string;
  name: string;
  status: "running" | "done";
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  contexts?: string[];
  reasoning?: string;
  tools?: ToolTraceEntry[];
  streaming?: boolean;
}

const TOOL_LABEL_MAP: Record<string, string> = {
  browser_read_page: "读取当前阅读页",
  browser_read_content: "读取当前阅读页",
  browser_state: "查看浏览器标签",
  browser_open: "打开网页",
  browser_navigate: "控制浏览器页面",
  library_list_books: "查看阅读笔记书目",
  library_search_highlights: "检索历史划线",
  library_get_book_notes: "读取书籍笔记",
  library_save_highlight: "存入本地划线",
  library_import_highlights: "导入读书划线",
  draft_list: "查看创作草稿",
  draft_read: "读取草稿内容",
  draft_create_or_revise: "写入创作草稿",
  obsidian_status: "检查 Obsidian 状态",
  obsidian_sync_book: "同步到 Obsidian",
  web_fetch: "查阅网页资料",
  web_search: "搜索公开资料",
  read: "读取本地资料",
  grep: "检索本地资料",
  glob: "查找本地文件",
};

function formatToolLabel(rawName: string): string {
  const clean = rawName.trim();
  if (!clean || clean === "tool") return "执行操作";
  return TOOL_LABEL_MAP[clean] ?? clean.replace(/[_-]+/g, " ");
}

function cleanReadablePageTitle(rawTitle: string): string {
  const stripped = rawTitle
    .replace(/\s*[-–—|]\s*(微信读书|WeRead|豆瓣读书|豆瓣|小红书|知乎|哔哩哔哩).*$/i, "")
    .replace(/^《|》$/g, "")
    .trim();
  const parts = stripped.split(/\s+[-–—]\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    // e.g. ["人类简史：从动物到上帝", "推荐序", "尤瓦尔·赫拉利"] -> "人类简史：从动物到上帝 · 推荐序"
    return `${parts[0]} · ${parts[1]}`;
  }
  return stripped || "当前阅读页";
}

function normalizeDisplayTools(
  rawTools: ToolTraceEntry[] | undefined,
  isStreaming: boolean,
): ToolTraceEntry[] {
  if (!rawTools || rawTools.length === 0) return [];
  const hasNamed = rawTools.some((t) => t.name && t.name !== "tool");
  const filtered = hasNamed ? rawTools.filter((t) => t.name && t.name !== "tool") : rawTools;
  return filtered.map((t) => (isStreaming ? t : { ...t, status: "done" }));
}

function summarizeToolTrace(tools: ToolTraceEntry[], isStreaming: boolean): {
  headline: string;
  isActive: boolean;
  grouped: Array<{ label: string; rawName: string; count: number; status: "running" | "done" }>;
} {
  const runningTool = [...tools].reverse().find((t) => t.status === "running");
  const grouped: Array<{ label: string; rawName: string; count: number; status: "running" | "done" }> = [];
  for (const t of tools) {
    const label = formatToolLabel(t.name);
    const prev = grouped[grouped.length - 1];
    if (prev && prev.label === label) {
      prev.count += 1;
      if (t.status === "running") prev.status = "running";
    } else {
      grouped.push({ label, rawName: t.name, count: 1, status: t.status });
    }
  }

  if (isStreaming && runningTool) {
    return {
      headline: `正在${formatToolLabel(runningTool.name)}…（第 ${tools.length} 步）`,
      isActive: true,
      grouped,
    };
  }

  const labelCounts = new Map<string, number>();
  for (const t of tools) {
    const label = formatToolLabel(t.name);
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  const summaryParts = [...labelCounts.entries()]
    .slice(0, 3)
    .map(([label, count]) => (count > 1 ? `${label} ×${count}` : label));
  const extra = labelCounts.size > 3 ? "等" : "";
  return {
    headline: `已完成 ${tools.length} 步操作 · ${summaryParts.join("、")}${extra}`,
    isActive: false,
    grouped,
  };
}

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

const STARTERS = [
  {
    title: "和我读过的书碰一碰",
    desc: "把眼前观点与你阅读笔记里的历史划线做跨书对照、挑刺与印证",
    prompt:
      "请结合右侧当前页面或我最近读的书，检索我的阅读笔记里的历史划线与个人批注，找找我以前读过的书里有哪些观点能与它互相印证、又有哪些地方存在明显冲突，给我一份简洁的跨书对照思考。",
  },
  {
    title: "按我的口吻写小红书长文",
    desc: "结合阅读笔记中的划线与个人批注，按 STYLE.md 生成可一键排版的初稿",
    prompt:
      "请先查看我的阅读笔记里最近更新的书目、划线与个人批注，严格遵守我的 STYLE.md 去 AI 味要求，写一篇结构清晰（带 H2 小标题、原文引用与个人观点）的小红书读书长文初稿，并调用 draft_create_or_revise 存入创作工作台。",
  },
  {
    title: "给当前草稿加论据 & 去 AI 味",
    desc: "从阅读笔记中找出书摘支撑论点，并按你的个人风格打磨修订",
    prompt:
      "请先查看我创作工作台里最新的一篇草稿，再从我的阅读笔记里检索 2-3 条最能支撑或反转文章论点的历史划线，结合我的 STYLE.md 提出具体修改建议，并可追加一版更自然、更有个人锋芒的修订稿。",
  },
  {
    title: "把网页摘录存入阅读笔记",
    desc: "把豆瓣、微信读书或任意网页的选中灵感附点评直接存入本地知识库",
    prompt:
      "请读取右侧页面我刚刚选中的文字（若无选区则读取当前页核心段落），结合我的个人阅读画像写一句克制、有个人角度的短评，并帮我存入阅读笔记。",
  },
];

function deriveSessionTitle(msgs: ChatMessage[]): string {
  const firstUser = msgs.find((m) => m.role === "user" && m.text.trim());
  const raw = (firstUser?.text ?? "新对话").replace(/\s+/g, " ").trim();
  return raw.length > 26 ? `${raw.slice(0, 26)}…` : raw || "新对话";
}

function formatSessionTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diffMin = Math.floor((Date.now() - t) / 60_000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const d = new Date(t);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  ) {
    return "昨天";
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
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
  const [ctxPickerOpen, setCtxPickerOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  // The book / page / draft the current conversation started from (its history group).
  const [sessionContext, setSessionContext] = useState("");
  const sessionContextRef = useRef("");
  const [dismissedSuggestion, setDismissedSuggestion] = useState("");
  const ctxPickerRef = useRef<HTMLDivElement | null>(null);
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
    if (!ctxPickerOpen && !historyOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (ctxPickerOpen && ctxPickerRef.current && !ctxPickerRef.current.contains(e.target as Node)) {
        setCtxPickerOpen(false);
      }
      if (historyOpen && historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setHistoryOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setCtxPickerOpen(false);
        setHistoryOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [ctxPickerOpen, historyOpen]);

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

  const handleToggleContext = (item: ContextAttachment) => {
    setAttachments((prev) =>
      prev.some((x) => x.id === item.id) ? prev.filter((x) => x.id !== item.id) : [...prev, item],
    );
    setCtxPickerOpen(false);
  };

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
    const { text, autoSend } = pendingPrompt;
    onConsumePendingPrompt();
    if (autoSend && modelSettings?.hasApiKey && !running) {
      void sendPrompt(text, undefined, undefined, contextSubject(autoContext));
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
    <div className={`ai-surf-context-zone ${isEmpty ? "in-empty" : "docked"}`} ref={ctxPickerRef}>
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
              onClick={() => setDismissedAutoId(activeAutoContext.id)}
              aria-label="取消自动关联当前上下文"
            >
              <IconClose size={11} />
            </button>
          </span>
        ) : autoContext ? (
          <button
            type="button"
            className="ai-surf-active-pill restored"
            onClick={() => setDismissedAutoId(null)}
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
              onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== att.id))}
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
          className={`ai-surf-add-btn ${ctxPickerOpen ? "open" : ""}`}
          onClick={() => setCtxPickerOpen((v) => !v)}
        >
          <IconPlus size={13} />
          <span>添加上下文</span>
        </button>

        {ctxPickerOpen && (
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
                      onClick={() => handleToggleContext(item)}
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
                      onClick={() => handleToggleContext(item)}
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
                      onClick={() => handleToggleContext(item)}
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
            <div className="ai-history-popover" role="dialog" aria-label="历史对话记录">
              <div className="ai-history-head">
                <span>历史对话{sessions.length > 0 ? ` · ${sessions.length}` : ""}</span>
                <button
                  type="button"
                  className="ai-history-new-btn"
                  disabled={running}
                  onClick={() => void handleReset()}
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
                        onClick={() => void handleOpenSession(s.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            void handleOpenSession(s.id);
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
                          onClick={(e) => void handleDeleteSession(e, s.id)}
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
              <div key={m.id} className={`msg-row ${m.role}`}>
                <div className="msg-bubble">
                  {m.role === "assistant" && (
                    <div className="msg-assistant-head">
                      <span className="msg-assistant-seal">点</span>
                      <span>点点共读</span>
                    </div>
                  )}

                  {m.role === "user" && m.contexts && m.contexts.length > 0 && (
                    <div className="msg-context-tags">
                      {m.contexts.map((c, idx) => (
                        <span key={`${c}-${idx}`} className="msg-context-tag">
                          <IconSparkles size={10} />
                          <span>{c}</span>
                        </span>
                      ))}
                    </div>
                  )}

                  {(() => {
                    const displayTools = normalizeDisplayTools(m.tools, Boolean(m.streaming));
                    if (displayTools.length === 0) return null;
                    const trace = summarizeToolTrace(displayTools, Boolean(m.streaming));
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

                  {m.reasoning && (
                    // Collapsed by default; the reader opens it on demand and it stays as they left it.
                    <details className="reasoning-box">
                      <summary>
                        <span className={m.streaming && !m.text ? "shimmer-status-text" : undefined}>
                          {m.streaming && !m.text ? "正在深度思考…" : "深度思考过程"}
                        </span>
                      </summary>
                      <pre>{m.reasoning}</pre>
                    </details>
                  )}

                  {m.role === "assistant" ? (
                    m.text ? (
                      <div className={m.streaming ? "streaming-prose" : undefined}>
                        <MarkdownText content={m.text} />
                        {m.streaming && <span className="stream-cursor" aria-hidden="true" />}
                      </div>
                    ) : (
                      <span className="shimmer-status-text" style={{ fontSize: 13 }}>
                        {m.streaming ? "正在阅读上下文并组织思路…" : ""}
                      </span>
                    )
                  ) : (
                    m.text
                  )}

                  {m.role === "assistant" && !m.streaming && m.text.trim() && (
                    <div className="msg-actions">
                      {savedDraftByMsgId[m.id] ? (
                        <button
                          type="button"
                          className="btn sm soft"
                          onClick={() => onOpenDraft?.(savedDraftByMsgId[m.id]!)}
                          title="已保存到创作工作台，点击直接查看"
                        >
                          <IconCheck size={12} />
                          <span>已存初稿 · 查看</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn sm ghost"
                          disabled={savingDraftMsgId === m.id}
                          onClick={async () => {
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
                        >
                          <IconPenLine size={12} />
                          <span>{savingDraftMsgId === m.id ? "保存中…" : "存为初稿"}</span>
                        </button>
                      )}
                      <button type="button" className="btn sm ghost" onClick={() => void handleCopy(m.id, m.text)}>
                        {copiedId === m.id ? <IconCheck size={12} /> : <IconCopy size={12} />}
                        <span>{copiedId === m.id ? "已复制" : "复制"}</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
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
