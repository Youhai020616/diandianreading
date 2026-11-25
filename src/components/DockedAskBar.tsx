import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AvailableModelsResult,
  BookRecord,
  BrowserStateSnapshot,
  DraftRecord,
  PublicModelSettings,
  SafetyMode,
} from "../types/desktop";
import {
  IconArrowUp,
  IconBookOpen,
  IconCheck,
  IconChevronDown,
  IconClose,
  IconEye,
  IconFileText,
  IconGlobe,
  IconPlus,
  IconRefresh,
  IconSend,
  IconSettings,
  IconShield,
  IconSparkles,
  IconStop,
  IconZap,
  ModelBrandIcon,
} from "./Icons";

export interface ContextAttachment {
  id: string;
  kind: "web" | "book" | "draft" | "notebook";
  label: string;
  meta?: string;
  promptSummary?: string;
}

const SAFETY_OPTIONS: Array<{
  mode: SafetyMode;
  title: string;
  badge?: string;
  desc: string;
}> = [
  {
    mode: "plan",
    title: "只读规划",
    badge: "plan",
    desc: "仅读页面与检索书库，拦截写入、新建草稿与导出",
  },
  {
    mode: "confirm",
    title: "安全确认",
    badge: "推荐",
    desc: "允许本地划线与 AI 草稿，拦截写盘与书源下载",
  },
  {
    mode: "auto",
    title: "全自动工作流",
    badge: "auto",
    desc: "放行全部工作台工具（仍禁底层任意 Shell）",
  },
];

interface DockedAskBarProps {
  value?: string;
  onChange?: (val: string) => void;
  placeholder?: string;
  running?: boolean;
  compact?: boolean;
  surfDrawer?: boolean;
  autoContext?: ContextAttachment | null;
  attachments?: ContextAttachment[];
  onAttachmentsChange?: (next: ContextAttachment[]) => void;
  dismissedAutoId?: string | null;
  onDismissAutoId?: (id: string | null) => void;
  books: BookRecord[];
  drafts: DraftRecord[];
  browserState: BrowserStateSnapshot | null;
  modelSettings: PublicModelSettings | null;
  safetyMode: SafetyMode;
  onOpenSettings: () => void;
  onSelectModel?: (modelId: string) => Promise<void> | void;
  onSelectSafety: (mode: SafetyMode) => void;
  onStop?: () => void;
  onCapturePage?: () => void;
  onSubmit: (composedPrompt: string, rawText: string, attachments: ContextAttachment[]) => void;
}

export const DockedAskBar: React.FC<DockedAskBarProps> = ({
  value,
  onChange,
  placeholder = "问点点任何关于书里的问题，输入 @ 引用网页、书目或草稿…",
  running = false,
  compact = false,
  surfDrawer = false,
  autoContext = null,
  attachments: controlledAttachments,
  onAttachmentsChange,
  dismissedAutoId: controlledDismissedAutoId,
  onDismissAutoId,
  books,
  drafts,
  browserState,
  modelSettings,
  safetyMode,
  onOpenSettings,
  onSelectModel,
  onSelectSafety,
  onStop,
  onCapturePage,
  onSubmit,
}) => {
  const [internalText, setInternalText] = useState("");
  const [internalAttachments, setInternalAttachments] = useState<ContextAttachment[]>([]);
  const [internalDismissedAutoId, setInternalDismissedAutoId] = useState<string | null>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [safetyMenuOpen, setSafetyMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuDirection, setModelMenuDirection] = useState<"up" | "down">("up");
  const [availableModels, setAvailableModels] = useState<AvailableModelsResult | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [switchingModelId, setSwitchingModelId] = useState<string | null>(null);
  const [modelFilter, setModelFilter] = useState("");
  const [mentionFilter, setMentionFilter] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const modelsCacheKeyRef = useRef<string>("");

  const attachments = controlledAttachments ?? internalAttachments;
  const setAttachments = (updater: ContextAttachment[] | ((prev: ContextAttachment[]) => ContextAttachment[])) => {
    const next = typeof updater === "function" ? updater(attachments) : updater;
    if (onAttachmentsChange) onAttachmentsChange(next);
    if (controlledAttachments === undefined) setInternalAttachments(next);
  };

  const dismissedAutoId = controlledDismissedAutoId !== undefined ? controlledDismissedAutoId : internalDismissedAutoId;
  const setDismissedAutoId = (id: string | null) => {
    if (onDismissAutoId) onDismissAutoId(id);
    if (controlledDismissedAutoId === undefined) setInternalDismissedAutoId(id);
  };

  const activeAutoContext =
    autoContext && autoContext.id !== dismissedAutoId && !attachments.some((a) => a.id === autoContext.id)
      ? autoContext
      : null;

  const isControlled = value !== undefined;
  const text = isControlled ? value : internalText;

  const setText = (next: string) => {
    if (onChange) onChange(next);
    if (!isControlled) setInternalText(next);
  };

  const modelsCacheKey = `${modelSettings?.baseUrl ?? ""}|${modelSettings?.provider ?? ""}|${modelSettings?.hasApiKey ? "1" : "0"}`;

  useEffect(() => {
    if (modelsCacheKeyRef.current && modelsCacheKeyRef.current !== modelsCacheKey) {
      modelsCacheKeyRef.current = "";
      setAvailableModels(null);
    }
  }, [modelsCacheKey]);

  const loadAvailableModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const res = await window.diandian.settings.listModels();
      setAvailableModels(res);
      modelsCacheKeyRef.current = modelsCacheKey;
    } catch {
      // Keep existing state on transient IPC failure
    } finally {
      setModelsLoading(false);
    }
  }, [modelsCacheKey]);

  const handleToggleModelMenu = () => {
    const nextOpen = !modelMenuOpen;
    setMentionOpen(false);
    setSafetyMenuOpen(false);
    if (nextOpen) {
      setModelFilter("");
      const rect = modelTriggerRef.current?.getBoundingClientRect();
      const spaceBelow = rect ? window.innerHeight - rect.bottom : 0;
      setModelMenuDirection(spaceBelow >= 260 ? "down" : "up");
      if (!availableModels || modelsCacheKeyRef.current !== modelsCacheKey) {
        void loadAvailableModels();
      }
    }
    setModelMenuOpen(nextOpen);
  };

  const handlePickModel = async (modelId: string) => {
    if (running || switchingModelId) return;
    if (modelId === modelSettings?.model) {
      setModelMenuOpen(false);
      return;
    }
    setSwitchingModelId(modelId);
    try {
      await onSelectModel?.(modelId);
      setModelMenuOpen(false);
    } finally {
      setSwitchingModelId(null);
    }
  };

  useEffect(() => {
    if (!mentionOpen && !safetyMenuOpen && !modelMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setMentionOpen(false);
        setSafetyMenuOpen(false);
        setModelMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMentionOpen(false);
        setSafetyMenuOpen(false);
        setModelMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [mentionOpen, safetyMenuOpen, modelMenuOpen]);

  const activeTab = browserState?.tabs.find((t) => t.id === browserState.activeTabId) ?? null;

  const mentionOptions = useMemo(() => {
    const q = mentionFilter.trim().toLowerCase();
    const webItems: ContextAttachment[] = (browserState?.tabs ?? [])
      .filter((t) => !q || `${t.title} ${t.url}`.toLowerCase().includes(q))
      .slice(0, 4)
      .map((t) => ({
        id: `web:${t.id}`,
        kind: "web",
        label: t.title || "当前网页",
        meta: t.url,
      }));

    const bookItems: ContextAttachment[] = books
      .filter((b) => !q || `${b.title} ${b.author}`.toLowerCase().includes(q))
      .slice(0, 6)
      .map((b) => ({
        id: `book:${b.id}`,
        kind: "book",
        label: `《${b.title}》`,
        meta: `${b.highlightCount} 条划线`,
      }));

    const draftItems: ContextAttachment[] = drafts
      .filter((d) => !q || d.title.toLowerCase().includes(q))
      .slice(0, 4)
      .map((d) => ({
        id: `draft:${d.id}`,
        kind: "draft",
        label: d.title,
        meta: `v${d.latestRevisionNo}`,
      }));

    return { webItems, bookItems, draftItems };
  }, [browserState?.tabs, books, drafts, mentionFilter]);

  const addAttachment = (item: ContextAttachment) => {
    setAttachments((prev) => (prev.some((x) => x.id === item.id) ? prev : [...prev, item]));
    // Strip trailing "@filter" if triggered by typing @
    if (text.endsWith(`@${mentionFilter}`)) {
      setText(text.slice(0, -(mentionFilter.length + 1)).trimEnd());
    }
    setMentionFilter("");
    setMentionOpen(false);
    textareaRef.current?.focus();
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((x) => x.id !== id));
  };

  const handleTextChange = (next: string) => {
    setText(next);
    const match = next.match(/(?:^|\s)@([^\s@]{0,20})$/);
    if (match) {
      setMentionFilter(match[1] ?? "");
      setMentionOpen(true);
    } else if (mentionOpen && !next.includes("@")) {
      setMentionOpen(false);
      setMentionFilter("");
    }
  };

  const buildComposedPrompt = (raw: string, list: ContextAttachment[]): string => {
    if (list.length === 0) return raw;
    const ctxLines = list.map((item) => {
      if (item.kind === "notebook") {
        return item.promptSummary || `- [主题空间] ${item.label}`;
      }
      if (item.kind === "web") {
        return `- [右侧网页] ${item.label}（请优先调用 browser_read_content 读取当前页面正文/选区）`;
      }
      if (item.kind === "book") {
        const bookId = item.id.replace(/^book:/, "");
        return `- [本地书库] ${item.label}（bookId: ${bookId}，请读取该书划线与我的批注）`;
      }
      const draftId = item.id.replace(/^draft:/, "");
      return `- [创作草稿] ${item.label}（draftId: ${draftId}）`;
    });
    return `请结合以下已挂载的上下文回答：\n${ctxLines.join("\n")}\n\n我的问题/指令：\n${raw}`;
  };

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || running) return;
    const effective = activeAutoContext ? [activeAutoContext, ...attachments] : attachments;
    const composed = buildComposedPrompt(trimmed, effective);
    onSubmit(composed, trimmed, effective);
    setText("");
    setAttachments([]);
    setMentionOpen(false);
  };

  const safetyLabel = safetyMode === "plan" ? "只读" : safetyMode === "auto" ? "自动" : "安全确认";
  const isLocalEndpoint = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(modelSettings?.baseUrl ?? "");
  const modelReady = Boolean(modelSettings?.hasApiKey || isLocalEndpoint);
  const modelLabel = modelReady ? modelSettings?.model || "DeepSeek" : "未配置模型";

  const filteredModels = useMemo(() => {
    const list = availableModels?.models ?? (modelSettings?.model
      ? [{ id: modelSettings.model, label: modelSettings.model, source: "current" as const }]
      : []);
    const q = modelFilter.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (m) => m.id.toLowerCase().includes(q) || (m.desc ?? "").toLowerCase().includes(q),
    );
  }, [availableModels?.models, modelSettings?.model, modelFilter]);

  return (
    <div className={`surf-ask-dock ${compact ? "compact" : ""} ${surfDrawer ? "surf-drawer" : ""}`} ref={containerRef}>
      <div className="surf-ask-inner">
        {mentionOpen && (
          <div className="surf-mention-popover" role="listbox" aria-label="添加引用上下文">
            {mentionOptions.webItems.length > 0 && (
              <>
                <div className="surf-mention-section">已打开网页</div>
                {mentionOptions.webItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="surf-mention-item"
                    onClick={() => addAttachment(item)}
                  >
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                      <IconGlobe size={13} style={{ flexShrink: 0, color: "#4338ca" }} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.label}
                      </span>
                    </span>
                    <span className="surf-mention-item-sub">右侧窗</span>
                  </button>
                ))}
              </>
            )}

            {mentionOptions.bookItems.length > 0 && (
              <>
                <div className="surf-mention-section">本地书库</div>
                {mentionOptions.bookItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="surf-mention-item"
                    onClick={() => addAttachment(item)}
                  >
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                      <IconBookOpen size={13} style={{ flexShrink: 0, color: "var(--accent)" }} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.label}
                      </span>
                    </span>
                    <span className="surf-mention-item-sub">{item.meta}</span>
                  </button>
                ))}
              </>
            )}

            {mentionOptions.draftItems.length > 0 && (
              <>
                <div className="surf-mention-section">创作草稿</div>
                {mentionOptions.draftItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="surf-mention-item"
                    onClick={() => addAttachment(item)}
                  >
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                      <IconFileText size={13} style={{ flexShrink: 0, color: "#be123c" }} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.label}
                      </span>
                    </span>
                    <span className="surf-mention-item-sub">{item.meta}</span>
                  </button>
                ))}
              </>
            )}

            {mentionOptions.webItems.length === 0
              && mentionOptions.bookItems.length === 0
              && mentionOptions.draftItems.length === 0 && (
                <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--ink-muted)", textAlign: "center" }}>
                  没有匹配的网页、书目或草稿
                </div>
              )}
          </div>
        )}

        {safetyMenuOpen && (
          <div className="surf-safety-popover" role="listbox" aria-label="AI 工具执行权限模式">
            <div className="surf-safety-popover-head">
              <IconShield size={13} />
              <span>工具执行守卫（实时生效）</span>
            </div>
            {SAFETY_OPTIONS.map((opt) => {
              const active = safetyMode === opt.mode;
              return (
                <button
                  key={opt.mode}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`surf-safety-item ${active ? "active" : ""}`}
                  onClick={() => {
                    onSelectSafety(opt.mode);
                    setSafetyMenuOpen(false);
                  }}
                >
                  <div className="surf-safety-item-top">
                    <span className={`safety-dot ${opt.mode}`} />
                    <span className="surf-safety-item-title">{opt.title}</span>
                    {opt.badge && <span className="surf-safety-item-badge">{opt.badge}</span>}
                    {active && (
                      <span className="surf-safety-item-check">
                        <IconCheck size={13} />
                      </span>
                    )}
                  </div>
                  <div className="surf-safety-item-desc">{opt.desc}</div>
                </button>
              );
            })}
          </div>
        )}

        {modelMenuOpen && (
          <div
            className={`surf-model-popover ${modelMenuDirection === "down" ? "dir-down" : "dir-up"}`}
            role="listbox"
            aria-label="切换可用模型"
          >
            <div className="surf-model-popover-head">
              <div className="surf-model-popover-head-left">
                <span className="surf-model-provider-name">
                  {availableModels?.providerLabel || "可用模型"}
                </span>
                <span
                  className={`surf-model-source-badge ${
                    availableModels?.source === "api" ? "live" : ""
                  }`}
                >
                  {modelsLoading
                    ? "拉取中…"
                    : availableModels?.source === "api"
                      ? "API 实时"
                      : "内置预设"}
                </span>
              </div>
              {modelReady && (
                <button
                  type="button"
                  className={`surf-model-refresh-btn ${modelsLoading ? "spinning" : ""}`}
                  onClick={() => void loadAvailableModels()}
                  disabled={modelsLoading}
                  title="重新从当前 API 拉取可用模型列表"
                  aria-label="刷新模型列表"
                >
                  <IconRefresh size={12} />
                </button>
              )}
            </div>

            {!modelReady && (
              <div className="surf-model-unconfigured">
                <span>尚未配置 API 密钥，配置后自动拉取可用模型</span>
                <button
                  type="button"
                  className="btn sm primary"
                  onClick={() => {
                    setModelMenuOpen(false);
                    onOpenSettings();
                  }}
                >
                  去配置
                </button>
              </div>
            )}

            {(availableModels?.models.length ?? 0) > 6 && (
              <div className="surf-model-search-wrap">
                <input
                  className="surf-model-search"
                  value={modelFilter}
                  onChange={(e) => setModelFilter(e.target.value)}
                  placeholder="筛选模型名称…"
                  autoFocus
                />
              </div>
            )}

            <div className="surf-model-list">
              {modelsLoading && !availableModels ? (
                <div className="surf-model-empty">正在从当前 API 拉取可用模型…</div>
              ) : filteredModels.length === 0 ? (
                <div className="surf-model-empty">没有匹配的模型</div>
              ) : (
                filteredModels.map((item) => {
                  const isActive = item.id === modelSettings?.model;
                  const isSwitching = switchingModelId === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      disabled={running || Boolean(switchingModelId) || !modelReady}
                      className={`surf-model-item ${isActive ? "active" : ""}`}
                      onClick={() => void handlePickModel(item.id)}
                      title={running ? "回复生成中，请稍后再切换模型" : `切换为 ${item.id}`}
                    >
                      <ModelBrandIcon
                        baseUrl={modelSettings?.baseUrl}
                        model={item.id}
                        size={15}
                      />
                      <div className="surf-model-item-main">
                        <div className="surf-model-item-top">
                          <span className="surf-model-item-id">{item.id}</span>
                          {item.tag && <span className="surf-model-item-tag">{item.tag}</span>}
                        </div>
                        {item.desc && <div className="surf-model-item-desc">{item.desc}</div>}
                      </div>
                      {isSwitching ? (
                        <span className="surf-model-item-status">切换中…</span>
                      ) : isActive ? (
                        <span className="surf-safety-item-check">
                          <IconCheck size={13} />
                        </span>
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>

            {availableModels?.error && availableModels.source === "preset" && modelReady && (
              <div className="surf-model-hint">{availableModels.error}</div>
            )}

            <div className="surf-model-popover-footer">
              <button
                type="button"
                className="surf-model-footer-btn"
                onClick={() => {
                  setModelMenuOpen(false);
                  onOpenSettings();
                }}
              >
                <IconSettings size={13} />
                <span>管理 API 密钥与服务商…</span>
              </button>
            </div>
          </div>
        )}

        <div className="surf-ask-box">
          {!surfDrawer && (activeAutoContext || attachments.length > 0) && (
            <div className="surf-context-chips">
              {activeAutoContext && (
                <span className="surf-ctx-chip auto" title="已自动关联当前正在阅读/编辑的上下文，点击 × 可取消关联">
                  <IconSparkles size={11} />
                  <span>{activeAutoContext.label}</span>
                  <button
                    type="button"
                    onClick={() => setDismissedAutoId(activeAutoContext.id)}
                    aria-label="取消自动关联当前上下文"
                  >
                    <IconClose size={11} />
                  </button>
                </span>
              )}
              {attachments.map((att) => (
                <span key={att.id} className={`surf-ctx-chip ${att.kind}`}>
                  {att.kind === "web" ? (
                    <IconGlobe size={11} />
                  ) : att.kind === "draft" ? (
                    <IconFileText size={11} />
                  ) : (
                    <IconBookOpen size={11} />
                  )}
                  <span>{att.label}</span>
                  <button type="button" onClick={() => removeAttachment(att.id)} aria-label="移除上下文">
                    <IconClose size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            className="surf-ask-textarea"
            rows={text.includes("\n") ? 3 : 1}
            value={text}
            onChange={(e) => handleTextChange(e.target.value)}
            placeholder={placeholder}
            onKeyDown={(e) => {
              if (e.key === "Escape" && mentionOpen) {
                setMentionOpen(false);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleSend();
              }
            }}
          />
        </div>

        {/* Exact Deta Surf quiet micro-toolbar directly underneath the ask input */}
        <div className="surf-ask-bar-footer">
          <div className="surf-ask-meta-left">
            {!surfDrawer && (
              <button
                type="button"
                className={`surf-micro-btn ${mentionOpen ? "active" : ""}`}
                onClick={() => {
                  setSafetyMenuOpen(false);
                  setModelMenuOpen(false);
                  setMentionFilter("");
                  setMentionOpen((v) => !v);
                }}
                title="挂载书目、草稿或右侧网页作为上下文（也可直接输入 @）"
              >
                <IconPlus size={12} />
                <span>{compact ? "上下文" : "引用上下文"}</span>
              </button>
            )}

            {onCapturePage && activeTab && (
              <button
                type="button"
                className="surf-micro-btn"
                onClick={onCapturePage}
                title={`抓取右侧「${activeTab.title || "当前页"}」选区或正文`}
              >
                <IconEye size={12} />
                <span>{compact ? "读当前页" : "读右侧页"}</span>
              </button>
            )}

            <button
              type="button"
              className={`surf-micro-btn ${safetyMenuOpen ? "active" : ""}`}
              onClick={() => {
                setMentionOpen(false);
                setModelMenuOpen(false);
                setSafetyMenuOpen((v) => !v);
              }}
              title="切换 AI 工具执行安全模式（只读规划 / 安全确认 / 全自动）"
            >
              <span className={`safety-dot ${safetyMode}`} />
              {!compact && <IconZap size={11} />}
              <span>{safetyLabel}</span>
            </button>
          </div>

          <div className="surf-ask-meta-right">
            <button
              ref={modelTriggerRef}
              type="button"
              className={`surf-micro-btn surf-model-trigger ${modelMenuOpen ? "active" : ""}`}
              onClick={handleToggleModelMenu}
              aria-haspopup="listbox"
              aria-expanded={modelMenuOpen}
              title={modelReady ? "切换当前 API 可用模型" : "配置模型与 API 密钥"}
            >
              <ModelBrandIcon
                baseUrl={modelSettings?.baseUrl}
                model={modelSettings?.model}
                size={14}
              />
              <span className="surf-model-trigger-label">{modelLabel}</span>
              <IconChevronDown
                size={11}
                className={`surf-model-chevron ${modelMenuOpen ? "open" : ""}`}
              />
            </button>

            {running && onStop ? (
              <button type="button" className="btn sm danger" onClick={onStop}>
                <IconStop size={11} />
                <span>停止</span>
              </button>
            ) : surfDrawer ? (
              <button
                type="button"
                className="surf-drawer-send-icon"
                onClick={handleSend}
                disabled={!text.trim()}
                title="发送（Enter）"
                aria-label="发送"
              >
                <IconArrowUp size={14} />
              </button>
            ) : (
              <button
                type="button"
                className="surf-ask-submit"
                onClick={handleSend}
                disabled={!text.trim()}
              >
                <IconSend size={11} />
                <span>提问</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
