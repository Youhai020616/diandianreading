import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentEvent,
  PetQuickQuoteEvent,
  PetWindowMode,
  PetWindowState,
  RecallHighlightItem,
} from "../types/desktop";
import { GoldenPet, type GoldenPetState } from "./GoldenPet";
import {
  IconArrowUp,
  IconBookOpen,
  IconChevronDown,
  IconClose,
  IconExternalLink,
  IconEye,
  IconPenLine,
  IconPlus,
  IconRefresh,
  IconSparkles,
  IconStop,
} from "./Icons";
import { MarkdownText } from "./MarkdownText";

interface MiniMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  tools?: string[];
  streaming?: boolean;
}

interface ActivePointerDrag {
  pointerId: number;
  startScreenX: number;
  startScreenY: number;
  lastScreenX: number;
  moved: boolean;
  toggleOnClick: boolean;
}

export const PetOverlayApp: React.FC = () => {
  const [mode, setMode] = useState<PetWindowMode>("collapsed");
  const [showJumpToMain, setShowJumpToMain] = useState(false);
  const [messages, setMessages] = useState<MiniMessage[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);

  // Companion stats & spaced-recall nudge
  const [totalHighlights, setTotalHighlights] = useState<number>(0);
  const [recallItem, setRecallItem] = useState<RecallHighlightItem | null>(null);
  const [quickQuote, setQuickQuote] = useState<PetQuickQuoteEvent | null>(null);

  // Live animation state machine
  const [dragDir, setDragDir] = useState<"left" | "right" | null>(null);
  const [hovered, setHovered] = useState(false);
  const [oneShot, setOneShot] = useState<"jumping" | "failed" | "waving" | null>("waving");

  const listRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeAssistantIdRef = useRef<string | null>(null);
  const dragRef = useRef<ActivePointerDrag | null>(null);

  const expanded = mode === "expanded";
  const showingNudge = mode === "nudge" && recallItem !== null;

  // Keep pet window light/dark theme synced in real time with main window pull-cord lamp
  useEffect(() => {
    const applyTheme = (next: "light" | "dark") => {
      document.documentElement.dataset.theme = next;
      document.documentElement.classList.toggle("dark", next === "dark");
      document.documentElement.classList.toggle("light", next === "light");
    };
    const offTheme = window.diandian.app.onThemeChanged(({ theme }) => applyTheme(theme));
    const onStorage = (e: StorageEvent) => {
      if (e.key === "diandian.theme") {
        applyTheme(e.newValue === "dark" ? "dark" : "light");
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      offTheme();
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // Auto-focus composer whenever the chat panel expands
  useEffect(() => {
    if (!expanded) return;
    const id = window.setTimeout(() => {
      textareaRef.current?.focus();
    }, 40);
    return () => window.clearTimeout(id);
  }, [expanded]);

  // Guard against stale oversized nudge window after HMR or empty recall state
  useEffect(() => {
    if (mode === "nudge" && recallItem === null) {
      setMode("collapsed");
      void window.diandian.pet.setMode("collapsed");
    }
  }, [mode, recallItem]);

  const refreshMilestone = useCallback(async () => {
    try {
      const stats = await window.diandian.library.readingStats();
      setTotalHighlights(stats.totalHighlights);
    } catch {
      // Non-critical.
    }
  }, []);

  useEffect(() => {
    void window.diandian.pet.getState().then((st) => {
      setMode(st.mode);
      setShowJumpToMain(Boolean(st.showJumpToMain));
    });
    void refreshMilestone();
    const offPet = window.diandian.pet.onStateChanged((st: PetWindowState) => {
      setMode(st.mode);
      setShowJumpToMain(Boolean(st.showJumpToMain));
    });
    const offQuick = window.diandian.pet.onQuickQuote((ev: PetQuickQuoteEvent) => {
      setQuickQuote(ev);
      setOneShot("jumping");
      if (ev.text) {
        setInput(`帮我解读这段话：「${ev.text.slice(0, 320)}」`);
      }
    });
    return () => {
      offPet();
      offQuick();
    };
  }, [refreshMilestone]);

  // Gentle daily spaced-recall nudge (once per day when library has highlights and chat is collapsed)
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const current = await window.diandian.pet.getState();
        if (current.mode !== "collapsed") return;
        const muted = await window.diandian.pet.getRecallMutedToday();
        if (muted.muted) return;
        const hit = await window.diandian.library.randomRecall();
        if (!hit) return;
        setRecallItem(hit);
        setOneShot("waving");
        await window.diandian.pet.setMode("nudge");
      } catch {
        // Ignore silently.
      }
    }, 5_000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, expanded]);

  useEffect(() => {
    const off = window.diandian.agent.onEvent((ev: AgentEvent) => {
      if (ev.kind === "status") {
        setRunning(ev.running);
        if (!ev.running) {
          activeAssistantIdRef.current = null;
          setMessages((prev) =>
            prev.some((m) => m.streaming)
              ? prev.map((m) => (m.streaming ? { ...m, streaming: false } : m))
              : prev,
          );
        }
        return;
      }
      if (ev.kind === "session-reset") {
        activeAssistantIdRef.current = null;
        return;
      }
      if (ev.kind === "stream" && ev.streamRole === "assistant") {
        setMessages((prev) => {
          const targetId = activeAssistantIdRef.current;
          if (!targetId) {
            const newId = `pa_${Date.now()}`;
            activeAssistantIdRef.current = newId;
            return [...prev, { id: newId, role: "assistant", text: ev.text, tools: [], streaming: true }];
          }
          return prev.map((m) => (m.id === targetId ? { ...m, text: m.text + ev.text } : m));
        });
        return;
      }
      if (ev.kind === "tool" && ev.phase === "start") {
        setMessages((prev) => {
          const targetId = activeAssistantIdRef.current;
          if (!targetId) return prev;
          return prev.map((m) =>
            m.id === targetId
              ? { ...m, tools: [...new Set([...(m.tools ?? []), ev.name])] }
              : m,
          );
        });
        return;
      }
      if (ev.kind === "final") {
        setRunning(false);
        setOneShot("jumping");
        void refreshMilestone();
        const targetId = activeAssistantIdRef.current;
        activeAssistantIdRef.current = null;
        setMessages((prev) => {
          if (!targetId) {
            return ev.finalResponse
              ? [...prev, { id: `pa_${Date.now()}`, role: "assistant", text: ev.finalResponse, streaming: false }]
              : prev;
          }
          return prev.map((m) => {
            if (m.id !== targetId) return m;
            const finalText = ev.finalResponse || "";
            const nextText =
              finalText && (!m.text || finalText.startsWith(m.text.trimStart()))
                ? finalText
                : m.text || finalText;
            return { ...m, text: nextText, streaming: false };
          });
        });
        return;
      }
      if (ev.kind === "error") {
        setRunning(false);
        setOneShot("failed");
        activeAssistantIdRef.current = null;
        setMessages((prev) => [
          ...prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
          { id: `ps_${Date.now()}`, role: "system", text: ev.message },
        ]);
      }
    });
    return off;
  }, [refreshMilestone]);

  const toggleExpanded = async () => {
    const nextMode: PetWindowMode = mode === "expanded" ? "collapsed" : "expanded";
    setMode(nextMode);
    if (nextMode === "expanded") {
      setOneShot("waving");
      void refreshMilestone();
    }
    await window.diandian.pet.setMode(nextMode);
  };

  const handleTriggerRandomRecall = async () => {
    const hit = await window.diandian.library.randomRecall(recallItem?.id);
    if (!hit) {
      setMessages((prev) => [
        ...prev,
        { id: `ps_${Date.now()}`, role: "system", text: "本地书库里还没有划线，去同步微信读书或划一句吧～" },
      ]);
      return;
    }
    setRecallItem(hit);
    setOneShot("jumping");
    if (expanded) {
      setInput(
        `我 ${hit.daysAgo > 0 ? `${hit.daysAgo} 天前` : "最近"}在《${hit.bookTitle}》里划过这句话：\n「${hit.quote}」${hit.note ? `\n当时的想法：${hit.note}` : ""}\n请帮我重温它，并给我一个今天能落地的反问。`,
      );
    } else {
      await window.diandian.pet.setMode("nudge");
    }
  };

  const handleDismissNudge = async (muteToday: boolean) => {
    if (muteToday) {
      await window.diandian.pet.muteRecallToday();
    }
    setRecallItem(null);
    setMode("collapsed");
    await window.diandian.pet.setMode("collapsed");
  };

  const sendPrompt = useCallback(
    async (rawText: string) => {
      const prompt = rawText.trim();
      if (!prompt || running) return;
      const userMsg: MiniMessage = { id: `pu_${Date.now()}`, role: "user", text: prompt };
      const assistantId = `pa_${Date.now() + 1}`;
      activeAssistantIdRef.current = assistantId;
      setMessages((prev) => [
        ...prev,
        userMsg,
        { id: assistantId, role: "assistant", text: "", tools: [], streaming: true },
      ]);
      setInput("");
      setQuickQuote(null);

      try {
        await window.diandian.agent.send(prompt);
      } catch (error) {
        activeAssistantIdRef.current = null;
        setRunning(false);
        setOneShot("failed");
        const msg = error instanceof Error ? error.message : String(error);
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== assistantId),
          { id: `ps_${Date.now()}`, role: "system", text: msg },
        ]);
      }
    },
    [running],
  );

  const handleChatAboutRecall = async () => {
    if (!recallItem) return;
    const prompt = `我 ${recallItem.daysAgo > 0 ? `${recallItem.daysAgo} 天前` : "最近"}在《${recallItem.bookTitle}》里划过这句：\n「${recallItem.quote}」${recallItem.note ? `\n我当时的想法：${recallItem.note}` : ""}\n现在回头重读，帮我聊聊怎么把它和当下的思考连起来？`;
    setMode("expanded");
    await window.diandian.pet.setMode("expanded");
    void sendPrompt(prompt);
  };

  const handleSaveQuickQuote = async () => {
    if (!quickQuote || !quickQuote.text.trim()) return;
    try {
      const book = await window.diandian.library.createBook({
        title: quickQuote.title || "随手摘录",
        source: "manual",
      });
      await window.diandian.library.addHighlight({
        bookId: book.id,
        quote: quickQuote.text.trim(),
        source: "manual",
      });
      setOneShot("jumping");
      void refreshMilestone();
      setMessages((prev) => [
        ...prev,
        { id: `ps_${Date.now()}`, role: "system", text: `汪！已收录到《${book.title}》本地书库。` },
      ]);
      setQuickQuote(null);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        { id: `ps_${Date.now()}`, role: "system", text: error instanceof Error ? error.message : "保存失败" },
      ]);
    }
  };

  const handleSend = async () => {
    await sendPrompt(input);
  };

  const handleReadRightPage = async () => {
    try {
      const snap = await window.diandian.browser.readPage(3000);
      if (snap.selection) {
        setInput(`帮我解读右侧这段划线：「${snap.selection.slice(0, 320)}」`);
      } else if (snap.title) {
        setInput(`帮我总结右侧《${snap.title}》这一页最核心的 2 个观点`);
      }
      setOneShot("jumping");
    } catch {
      setMessages((prev) => [
        ...prev,
        { id: `ps_${Date.now()}`, role: "system", text: "未能读取到右侧页面，请先打开主窗口阅读页。" },
      ]);
    }
  };

  const beginPointerDrag = (e: React.PointerEvent<HTMLElement>, toggleOnClick: boolean) => {
    if (e.button !== 0) return;
    if (!toggleOnClick && (e.target as HTMLElement).closest("button")) return;

    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore if pointer capture unavailable.
    }
    dragRef.current = {
      pointerId: e.pointerId,
      startScreenX: e.screenX,
      startScreenY: e.screenY,
      lastScreenX: e.screenX,
      moved: false,
      toggleOnClick,
    };
  };

  const forceEndDrag = useCallback(() => {
    const st = dragRef.current;
    if (!st) return;
    dragRef.current = null;
    setDragDir(null);
    if (st.moved) {
      window.diandian.pet.dragEnd();
    }
  }, []);

  // Bubble phase (NOT capture!) so React's onPointerUp={endPointerDrag} runs first and handles click-to-open chat cleanly.
  useEffect(() => {
    window.addEventListener("pointerup", forceEndDrag, false);
    window.addEventListener("mouseup", forceEndDrag, false);
    window.addEventListener("blur", forceEndDrag);
    return () => {
      window.removeEventListener("pointerup", forceEndDrag, false);
      window.removeEventListener("mouseup", forceEndDrag, false);
      window.removeEventListener("blur", forceEndDrag);
    };
  }, [forceEndDrag]);

  const handlePointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const st = dragRef.current;
    if (!st || st.pointerId !== e.pointerId) return;
    if ((e.buttons & 1) === 0) {
      endPointerDrag(e);
      return;
    }

    const totalDx = e.screenX - st.startScreenX;
    const totalDy = e.screenY - st.startScreenY;
    if (!st.moved && (Math.abs(totalDx) >= 4 || Math.abs(totalDy) >= 4)) {
      st.moved = true;
      window.diandian.pet.dragStart(e.screenX, e.screenY);
    }

    if (st.moved) {
      const stepDx = e.screenX - st.lastScreenX;
      if (Math.abs(stepDx) >= 1) {
        setDragDir(stepDx > 0 ? "right" : "left");
      }
      st.lastScreenX = e.screenX;
      window.diandian.pet.dragMove(e.screenX, e.screenY);
    }
  };

  const endPointerDrag = (e: React.PointerEvent<HTMLElement>) => {
    const st = dragRef.current;
    if (!st || st.pointerId !== e.pointerId) return;
    dragRef.current = null;

    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore.
    }

    setDragDir(null);
    if (st.moved) {
      window.diandian.pet.dragEnd();
    }

    if (!st.moved && st.toggleOnClick) {
      void toggleExpanded();
    } else if (st.moved) {
      setOneShot("waving");
    }
  };

  const petState: GoldenPetState = dragDir
    ? dragDir === "right"
      ? "run-right"
      : "run-left"
    : running
      ? "running"
      : oneShot
        ? oneShot
        : expanded && input.trim().length > 0
          ? "waiting"
          : hovered
            ? "waving"
            : "idle";

  const oneShotRepeat = oneShot ? (oneShot === "jumping" ? 2 : 1) : undefined;

  return (
    <div className={`pet-stage ${mode === "collapsed" ? "collapsed" : ""}`}>
      {/* Gentle Spaced-Recall Nudge Bubble (when collapsed & recall triggered) */}
      {showingNudge && recallItem && (
        <aside className="pet-nudge-card" aria-label="旧划线每日反刍">
          <div className="pet-nudge-head">
            <span>
              旧划线重逢 · {recallItem.daysAgo > 0 ? `${recallItem.daysAgo} 天前` : "近期"}
            </span>
            <button
              type="button"
              className="pet-icon-btn"
              onClick={() => void handleDismissNudge(false)}
              title="收起气泡"
            >
              <IconClose size={12} />
            </button>
          </div>
          <div className="pet-nudge-quote">
            “{recallItem.quote.slice(0, 96)}{recallItem.quote.length > 96 ? "…" : ""}”
          </div>
          <div className="pet-nudge-book">—— 《{recallItem.bookTitle}》</div>
          <div className="pet-nudge-actions">
            <button type="button" className="pet-nudge-btn primary" onClick={() => void handleChatAboutRecall()}>
              聊聊这句
            </button>
            <button
              type="button"
              className="pet-nudge-btn"
              onClick={() =>
                void window.diandian.pet.sendToDraft({
                  quote: recallItem.quote,
                  comment: recallItem.note,
                  bookTitle: recallItem.bookTitle,
                  author: recallItem.bookAuthor,
                })
              }
            >
              写草稿
            </button>
            <button type="button" className="pet-nudge-btn" onClick={() => void handleTriggerRandomRecall()}>
              换一条
            </button>
            <button type="button" className="pet-nudge-btn muted" onClick={() => void handleDismissNudge(true)}>
              今日免打扰
            </button>
          </div>
        </aside>
      )}

      {/* Floating Mini Dark Chat Drawer */}
      {expanded && (
        <section className="pet-chat-card" aria-label="小金毛快捷对话">
          <header
            className="pet-chat-header pet-drag-handle"
            onPointerDown={(e) => beginPointerDrag(e, false)}
            onPointerMove={handlePointerMove}
            onPointerUp={endPointerDrag}
            onPointerCancel={endPointerDrag}
            onLostPointerCapture={endPointerDrag}
            title="按住标题栏可自由拖动整个伴读窗口"
          >
            <div className="pet-chat-title">
              <strong>小金毛</strong>
              <span>{totalHighlights > 0 ? `已陪读 ${totalHighlights} 条划线` : "伴读搭档"}</span>
            </div>
            <div className="pet-chat-header-actions">
              <button
                type="button"
                className="pet-icon-btn"
                onClick={() => void handleTriggerRandomRecall()}
                title="随机翻一条旧划线回顾"
              >
                <IconRefresh size={13} />
              </button>
              <button
                type="button"
                className="pet-icon-btn"
                onClick={() => void handleReadRightPage()}
                title="引用右侧阅读页"
              >
                <IconEye size={14} />
              </button>
              {showJumpToMain && (
                <button
                  type="button"
                  className="pet-icon-btn"
                  onClick={() => void window.diandian.pet.focusMain()}
                  title="唤起点点读书主工作台"
                >
                  <IconExternalLink size={14} />
                </button>
              )}
              <button
                type="button"
                className="pet-icon-btn"
                onClick={() => void toggleExpanded()}
                title="收起对话窗"
              >
                <IconChevronDown size={15} />
              </button>
              <button
                type="button"
                className="pet-icon-btn"
                onClick={() => void window.diandian.pet.hide()}
                title="暂时隐藏桌宠（可在主窗口左侧栏重新召唤）"
              >
                <IconClose size={14} />
              </button>
            </div>
          </header>

          {/* Pinned Quick-Quote Bar (from Cmd+Shift+D or Browser Selection Overlay) */}
          {quickQuote && quickQuote.text && (
            <div className="pet-quick-quote-bar">
              <div className="pet-quick-quote-text">
                <strong>{quickQuote.source === "shortcut" ? "⌘⇧D 捕捉" : "划词摘录"}</strong>
                <span>「{quickQuote.text.slice(0, 72)}{quickQuote.text.length > 72 ? "…" : ""}」</span>
              </div>
              <div className="pet-quick-quote-btns">
                <button type="button" className="pet-nudge-btn" onClick={() => void handleSaveQuickQuote()}>
                  <IconBookOpen size={11} />
                  <span>存书库</span>
                </button>
                <button
                  type="button"
                  className="pet-nudge-btn"
                  onClick={() =>
                    void window.diandian.pet.sendToDraft({
                      quote: quickQuote.text,
                      bookTitle: quickQuote.title,
                    })
                  }
                >
                  <IconPenLine size={11} />
                  <span>写草稿</span>
                </button>
              </div>
            </div>
          )}

          <div className="pet-chat-body" ref={listRef}>
            {messages.length === 0 ? (
              <div className="pet-chat-empty">
                <div className="pet-chat-empty-badge">
                  <IconSparkles size={12} />
                  <span>全局快捷键 ⌘⇧D 随时呼出 · 已连书库</span>
                </div>
                <p>在任何地方复制一段好话按 ⌘⇧D，或在右侧划词点「问小金毛」，我都会立刻蹦出来陪你聊～</p>
              </div>
            ) : (
              messages.map((m) => (
                <div key={m.id} className={`pet-msg ${m.role}`}>
                  {m.tools && m.tools.length > 0 && (
                    <div className="pet-msg-tools">
                      {m.tools.map((t) => (
                        <span key={t} className="pet-tool-tag">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                  {m.role === "assistant" ? (
                    m.text ? (
                      <div className={m.streaming ? "streaming-prose" : undefined}>
                        <MarkdownText content={m.text} className="pet-md" />
                        {m.streaming && <span className="stream-cursor pet" aria-hidden="true" />}
                      </div>
                    ) : (
                      <span className="pet-thinking">汪！正在翻书查资料…</span>
                    )
                  ) : (
                    m.text
                  )}
                </div>
              ))
            )}
          </div>

          <div className="pet-composer">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="问小金毛任何书里的问题…"
              rows={2}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
            />
            <div className="pet-composer-bar">
              <button
                type="button"
                className="pet-composer-plus"
                onClick={() => void handleReadRightPage()}
                title="抓取右侧当前页面 / 选中段落"
              >
                <IconPlus size={14} />
                <span>引用右侧页</span>
              </button>
              {running ? (
                <button
                  type="button"
                  className="pet-send-circle stop"
                  onClick={() => void window.diandian.agent.stop()}
                  title="停止生成"
                >
                  <IconStop size={11} />
                </button>
              ) : (
                <button
                  type="button"
                  className="pet-send-circle"
                  disabled={!input.trim()}
                  onClick={() => void handleSend()}
                  title="发送（Enter）"
                >
                  <IconArrowUp size={15} />
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Golden Retriever Puppy + Sleek Pill Dock */}
      <div className="pet-dock">
        <div
          className="pet-sprite-hit"
          onPointerDown={(e) => beginPointerDrag(e, true)}
          onPointerMove={handlePointerMove}
          onPointerUp={endPointerDrag}
          onPointerCancel={endPointerDrag}
          onLostPointerCapture={endPointerDrag}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          title="按住可全屏自由拖动（会跟着跑哦）· 轻点打开/收起对话"
        >
          <GoldenPet
            state={petState}
            repeat={oneShotRepeat}
            onEnd={() => setOneShot(null)}
            height={102}
          />
        </div>

        <div className="pet-pill-row">
          <button
            type="button"
            className="pet-pill-main"
            onPointerDown={(e) => beginPointerDrag(e, true)}
            onPointerMove={handlePointerMove}
            onPointerUp={endPointerDrag}
            onPointerCancel={endPointerDrag}
            onLostPointerCapture={endPointerDrag}
            title="轻点展开/收起对话 · 按住拖动小金毛位置"
          >
            <span className={`pet-pill-dot ${running ? "busy" : ""}`} />
            <span>{running ? "小金毛思考中…" : "和小金毛聊聊"}</span>
          </button>
          {showJumpToMain && (
            <button
              type="button"
              className="pet-pill-sub"
              onClick={() => void window.diandian.pet.focusMain()}
              title="回到点点读书主窗口"
            >
              <IconExternalLink size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
