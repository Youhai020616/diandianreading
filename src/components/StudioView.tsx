import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  DraftKind,
  DraftRecord,
  ObsidianExportOutcome,
  RelatedHighlightItem,
  StyleDistillSuggestion,
} from "../types/desktop";
import { hasDraftChatter, prepareDraftFromAssistantReply } from "../lib/draftCleanup";
import { copyDraftForXiaohongshu, XHS_LONG_ARTICLE_URL } from "../lib/xhsFormat";
import { ConceptVisualModal } from "./ConceptVisualModal";
import { MarkdownText } from "./MarkdownText";
import {
  IconBookOpen,
  IconCheck,
  IconClose,
  IconExternalLink,
  IconFileText,
  IconGlobe,
  IconPlus,
  IconSearch,
  IconSparkles,
  IconSplit,
  IconTrash,
  IconWand,
} from "./Icons";

interface StudioViewProps {
  activeDraftId: string | null;
  onSelectDraftId: (id: string | null) => void;
  onDataChanged?: () => void;
  onModalToggle?: (open: boolean) => void;
  onSendToChat: (prompt: string) => void;
  onOpenBrowserUrl: (url: string) => void;
  onNotify: (msg: string, tone?: "info" | "success" | "error") => void;
}

const KIND_LABELS: Record<DraftKind, string> = {
  review: "深度书评",
  thread: "小红书 / 帖子",
  card_copy: "书摘文案",
  script: "口播脚本",
  note: "读书随笔",
};

export const StudioView: React.FC<StudioViewProps> = ({
  activeDraftId,
  onSelectDraftId,
  onDataChanged,
  onModalToggle,
  onSendToChat,
  onOpenBrowserUrl,
  onNotify,
}) => {
  const [drafts, setDrafts] = useState<DraftRecord[]>([]);
  const [draftQuery, setDraftQuery] = useState("");
  const [detail, setDetail] = useState<DraftRecord | null>(null);
  const [titleInput, setTitleInput] = useState("");
  const [contentInput, setContentInput] = useState("");
  const [editorMode, setEditorMode] = useState<"preview" | "edit">("preview");
  const [compareMode, setCompareMode] = useState(false);
  const [viewingRevNo, setViewingRevNo] = useState<number | null>(null);
  const [exportResult, setExportResult] = useState<ObsidianExportOutcome | null>(null);

  // Feature 1: Auto-evolving STYLE.md suggestions distilled from AI vs Human diff
  const [distilling, setDistilling] = useState(false);
  const [styleSuggestions, setStyleSuggestions] = useState<StyleDistillSuggestion[]>([]);
  const [acceptingStyle, setAcceptingStyle] = useState(false);

  // Feature 2: Live related highlights from SQLite FTS5 trigram while writing
  const [relatedHighlights, setRelatedHighlights] = useState<RelatedHighlightItem[]>([]);
  const [relatedExpanded, setRelatedExpanded] = useState(false);
  const relatedSeqRef = useRef(0);
  const pendingEditDraftIdRef = useRef<string | null>(null);

  // Feature 3: Draft Concept Visual / Mindmap modal
  const [visualModalOpen, setVisualModalOpen] = useState(false);

  useEffect(() => {
    onModalToggle?.(visualModalOpen);
    return () => {
      if (visualModalOpen) onModalToggle?.(false);
    };
  }, [visualModalOpen, onModalToggle]);

  const loadDrafts = useCallback(async () => {
    const list = await window.diandian.drafts.list();
    setDrafts(list);
    if (!activeDraftId && list[0]) {
      onSelectDraftId(list[0].id);
    }
  }, [activeDraftId, onSelectDraftId]);

  const loadDetail = useCallback(async (id: string | null) => {
    if (!id) {
      setDetail(null);
      setTitleInput("");
      setContentInput("");
      setStyleSuggestions([]);
      setRelatedHighlights([]);
      return;
    }
    const full = await window.diandian.drafts.get(id);
    setDetail(full);
    setTitleInput(full?.title ?? "");
    setContentInput(full?.latestContent ?? "");
    setViewingRevNo(full?.latestRevisionNo ?? null);
    if (pendingEditDraftIdRef.current === id) {
      pendingEditDraftIdRef.current = null;
      setEditorMode("edit");
    } else {
      setEditorMode("preview");
    }
    setExportResult(null);
    setStyleSuggestions([]);
  }, []);

  useEffect(() => {
    void loadDrafts();
  }, [loadDrafts]);

  useEffect(() => {
    void loadDetail(activeDraftId);
  }, [activeDraftId, loadDetail]);

  // Debounced live FTS5 trigram lookup surfacing related past highlights as you write
  useEffect(() => {
    const combined = `${titleInput}\n${contentInput}`.trim();
    if (!detail || combined.length < 10) {
      setRelatedHighlights([]);
      return;
    }
    const seq = ++relatedSeqRef.current;
    const timer = window.setTimeout(() => {
      void window.diandian.library
        .findRelatedHighlights(combined, 3)
        .then((hits) => {
          if (seq === relatedSeqRef.current) {
            setRelatedHighlights(hits);
          }
        })
        .catch(() => {});
    }, 450);
    return () => window.clearTimeout(timer);
  }, [detail, titleInput, contentInput]);

  const handleCreateBlank = async () => {
    const created = await window.diandian.drafts.create({
      title: `未命名随笔 ${new Date().toLocaleDateString("zh-CN")}`,
      kind: "review",
      authorKind: "human",
      content: "在这里写下你的第一版真实想法…",
    });
    pendingEditDraftIdRef.current = created.id;
    await loadDrafts();
    onDataChanged?.();
    onSelectDraftId(created.id);
    setEditorMode("edit");
    onNotify("已新建草稿", "success");
  };

  const handleSaveHumanRevision = async () => {
    if (!detail || !contentInput.trim()) return;
    const hadAiBaseline = Boolean(detail.revisions?.some((r) => r.authorKind === "ai"));
    try {
      const updated = await window.diandian.drafts.appendRevision({
        draftId: detail.id,
        title: titleInput.trim() || detail.title,
        authorKind: "human",
        content: contentInput.trim(),
        promptSummary: "人工手动修订",
      });
      setDetail(updated);
      setViewingRevNo(updated.latestRevisionNo);
      await loadDrafts();
      onDataChanged?.();
      onNotify(`已保存为不可变人工版本 v${updated.latestRevisionNo}（历史 AI 原稿完整保留）`, "success");

      // Automatically distill writing habits from AI v1 vs Human edit diff
      if (hadAiBaseline) {
        setDistilling(true);
        void window.diandian.twin
          .distillDiff(updated.id)
          .then((res) => {
            if (res.suggestions.length > 0) {
              setStyleSuggestions(res.suggestions);
            }
          })
          .catch(() => {})
          .finally(() => setDistilling(false));
      }
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "保存失败", "error");
    }
  };

  const handleAcceptStyleRule = async (item: StyleDistillSuggestion) => {
    setAcceptingStyle(true);
    try {
      const res = await window.diandian.twin.acceptStyleRules([item.rule]);
      setStyleSuggestions((prev) => prev.filter((s) => s.id !== item.id));
      onNotify(
        res.addedCount > 0
          ? "已写入 STYLE.md，下一轮 AI 写作会自动遵循这条习惯"
          : "STYLE.md 中已有类似规则",
        "success",
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "写入 STYLE.md 失败", "error");
    } finally {
      setAcceptingStyle(false);
    }
  };

  const handleAcceptAllStyleRules = async () => {
    if (styleSuggestions.length === 0) return;
    setAcceptingStyle(true);
    try {
      const res = await window.diandian.twin.acceptStyleRules(styleSuggestions.map((s) => s.rule));
      setStyleSuggestions([]);
      onNotify(
        res.addedCount > 0
          ? `已将 ${res.addedCount} 条个人写作习惯无损写入 STYLE.md`
          : "这些规则已在 STYLE.md 中",
        "success",
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "写入 STYLE.md 失败", "error");
    } finally {
      setAcceptingStyle(false);
    }
  };

  const handleInsertRelatedHighlight = (item: RelatedHighlightItem) => {
    const citation = `\n\n> ${item.quote}\n> —— 《${item.bookTitle}》${item.note ? `\n\n${item.note}` : ""}\n`;
    setContentInput((prev) => `${prev.trimEnd()}${citation}`);
    setEditorMode("edit");
    setRelatedHighlights((prev) => prev.filter((h) => h.id !== item.id));
    onNotify(`已将《${item.bookTitle}》旧划线插入草稿`, "success");
  };

  const handleExportObsidian = async () => {
    if (!detail) return;
    try {
      const res = await window.diandian.obsidian.exportDraft(detail.id);
      setExportResult(res);
      onNotify(res.message, res.status === "conflict" ? "info" : "success");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "导出失败", "error");
    }
  };

  const handleDelete = async () => {
    if (!detail) return;
    await window.diandian.drafts.delete(detail.id);
    onSelectDraftId(null);
    await loadDrafts();
    onDataChanged?.();
    onNotify("草稿已删除", "info");
  };

  const handlePublishXiaohongshu = async () => {
    if (!detail || !contentInput.trim()) return;
    try {
      await copyDraftForXiaohongshu(titleInput.trim() || detail.title, contentInput);
      onOpenBrowserUrl(XHS_LONG_ARTICLE_URL);
      onNotify("已按小红书长文结构复制，在右侧粘贴（⌘V）即可套用官方「一键排版」模板", "success");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "复制失败", "error");
    }
  };

  const handleCleanDraftChatter = async () => {
    if (!detail) return;
    const prepared = prepareDraftFromAssistantReply(contentInput, {
      bookHint: detail.bookTitle ?? null,
    });
    const nextTitle = hasDraftChatter(titleInput, "") ? prepared.title : titleInput.trim() || prepared.title;
    try {
      const updated = await window.diandian.drafts.appendRevision({
        draftId: detail.id,
        title: nextTitle,
        authorKind: "human",
        content: prepared.content,
        promptSummary: "一键净化 AI 对话寒暄与标题",
      });
      setDetail(updated);
      setTitleInput(updated.title);
      setContentInput(updated.latestContent);
      setViewingRevNo(updated.latestRevisionNo);
      await loadDrafts();
      onDataChanged?.();
      onNotify(`已净化草稿并更新标题为《${updated.title}》（v${updated.latestRevisionNo}）`, "success");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "净化草稿失败", "error");
    }
  };

  const firstAiRev = detail?.revisions?.find((r) => r.authorKind === "ai") ?? null;
  const dirty =
    detail !== null &&
    (contentInput.trim() !== detail.latestContent.trim() || titleInput.trim() !== detail.title.trim());
  const draftNeedsCleanup = detail !== null && hasDraftChatter(titleInput, contentInput);

  return (
    <div className="chat-view">
      <header className="view-header">
        <div className="view-header-left">
          <h1 className="view-title">创作工作台</h1>
          <span className="badge">{drafts.length} 篇草稿</span>
        </div>
        <div className="view-header-right">
          {detail && firstAiRev && (
            <button
              type="button"
              className={`btn sm ${compareMode ? "soft" : ""}`}
              onClick={() => setCompareMode((v) => !v)}
            >
              <IconSplit size={13} />
              <span>{compareMode ? "关闭对照" : "对照 AI 原稿"}</span>
            </button>
          )}
          <button type="button" className="btn sm primary" onClick={() => void handleCreateBlank()}>
            <IconPlus size={13} />
            <span>新建草稿</span>
          </button>
        </div>
      </header>

      <div className="studio-scroll">
        <div className="surf-doc-container">
          {drafts.length === 0 ? (
            <div className="muted-box" style={{ padding: "38px 20px" }}>
              <div style={{ fontWeight: 600, color: "var(--ink)", marginBottom: 8 }}>还没有创作草稿</div>
              <div style={{ marginBottom: 14 }}>
                你可以从「问点点」把 AI 回复一键存为初稿，或直接在这里新建。系统采用<strong>不可变版本链</strong>，AI 原稿与你的每一次人工修订都会清晰分层保留，还能自动从你的改稿差异里沉淀个人写作风格。
              </div>
              <button type="button" className="btn primary" onClick={() => void handleCreateBlank()}>
                <IconPlus size={14} />
                写第一篇草稿
              </button>
            </div>
          ) : (
            <>
              <div className="draft-switcher-bar">
                <div className="switcher-strip" role="tablist" aria-label="草稿切换">
                  {drafts
                    .filter((d) =>
                      draftQuery.trim()
                        ? d.title.toLowerCase().includes(draftQuery.trim().toLowerCase())
                        : true,
                    )
                    .map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        role="tab"
                        aria-selected={d.id === detail?.id}
                        className={`switcher-pill ${d.id === detail?.id ? "active" : ""}`}
                        onClick={() => onSelectDraftId(d.id)}
                        title={d.title}
                      >
                        <IconFileText size={12} style={{ flexShrink: 0, opacity: 0.72 }} />
                        <span className="switcher-pill-title">{d.title}</span>
                        <span className="switcher-pill-meta">v{d.latestRevisionNo}</span>
                      </button>
                    ))}
                </div>
                {drafts.length > 4 && (
                  <div className="inline-filter-box">
                    <IconSearch size={13} />
                    <input
                      value={draftQuery}
                      onChange={(e) => setDraftQuery(e.target.value)}
                      placeholder="筛选草稿…"
                    />
                    {draftQuery && (
                      <button
                        type="button"
                        className="inline-filter-clear"
                        onClick={() => setDraftQuery("")}
                        title="清空筛选"
                      >
                        <IconClose size={11} />
                      </button>
                    )}
                  </div>
                )}
              </div>

              {detail && (
                <section style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div className="studio-title-row">
                    {editorMode === "preview" && !compareMode ? (
                      <h1
                        className="studio-title-heading"
                        onClick={() => setEditorMode("edit")}
                      >
                        {titleInput || "未命名草稿"}
                      </h1>
                    ) : (
                      <input
                        className="studio-title-input"
                        value={titleInput}
                        onChange={(e) => setTitleInput(e.target.value)}
                        placeholder="输入标题…"
                      />
                    )}
                    <div className="studio-title-actions">
                      <span className="badge accent">{KIND_LABELS[detail.kind]}</span>
                      <button type="button" className="btn icon-only ghost" onClick={() => void handleDelete()} title="删除草稿">
                        <IconTrash size={14} />
                      </button>
                    </div>
                  </div>

                  {/* Immutable Revision Timeline + Preview/Edit Segmented Control */}
                  <div className="studio-meta-bar">
                    <div className="revision-bar">
                      {detail.revisions && detail.revisions.length > 0 && (
                        <>
                          <span style={{ fontSize: 11.5, color: "var(--ink-muted)", marginRight: 4 }}>版本链</span>
                          {detail.revisions.map((rev) => (
                            <button
                              key={rev.id}
                              type="button"
                              className={`rev-pill ${viewingRevNo === rev.revisionNo ? "active" : ""}`}
                              onClick={() => {
                                setViewingRevNo(rev.revisionNo);
                                setContentInput(rev.content);
                              }}
                              title={rev.promptSummary || new Date(rev.createdAt).toLocaleString("zh-CN")}
                            >
                              v{rev.revisionNo} · {rev.authorKind === "human" ? "人工修订" : "AI 原稿"}
                            </button>
                          ))}
                        </>
                      )}
                      <span className="studio-word-count">
                        {contentInput.replace(/\s+/g, "").length} 字
                      </span>
                    </div>

                    {!compareMode && (
                      <div className="cvis-seg" style={{ flexShrink: 0 }}>
                        <button
                          type="button"
                          className={`cvis-seg-btn ${editorMode === "preview" ? "active" : ""}`}
                          onClick={() => setEditorMode("preview")}
                        >
                          预览
                        </button>
                        <button
                          type="button"
                          className={`cvis-seg-btn ${editorMode === "edit" ? "active" : ""}`}
                          onClick={() => setEditorMode("edit")}
                        >
                          编辑
                        </button>
                      </div>
                    )}
                  </div>

                  {draftNeedsCleanup && !compareMode && (
                    <div className="studio-cleanup-banner">
                      <div className="studio-cleanup-text">
                        <IconSparkles size={13} />
                        <span>检测到这篇旧草稿包含 AI 对话寒暄或截断标题，可一键净化为干净正文</span>
                      </div>
                      <button
                        type="button"
                        className="btn sm soft"
                        onClick={() => void handleCleanDraftChatter()}
                      >
                        一键净化
                      </button>
                    </div>
                  )}

                  {compareMode && firstAiRev ? (
                    <div className="compare-grid">
                      <div className="compare-pane">
                        <div className="compare-label">
                          <span>只读基准 · AI 初稿 (v{firstAiRev.revisionNo})</span>
                          <span className="badge">不可变</span>
                        </div>
                        <div className="ai-readonly-box">{firstAiRev.content}</div>
                      </div>
                      <div className="compare-pane">
                        <div className="compare-label">
                          <span>当前编辑 · 你的版本</span>
                          {dirty && <span className="badge amber">未保存修订</span>}
                        </div>
                        <textarea
                          className="textarea"
                          rows={15}
                          value={contentInput}
                          onChange={(e) => setContentInput(e.target.value)}
                          style={{ minHeight: 300 }}
                        />
                      </div>
                    </div>
                  ) : editorMode === "preview" ? (
                    <div
                      className="studio-preview-surface"
                      onDoubleClick={() => setEditorMode("edit")}
                    >
                      {contentInput.trim() ? (
                        <MarkdownText content={contentInput} />
                      ) : (
                        <div className="studio-preview-empty">暂无正文，点击上方「编辑」开始写作…</div>
                      )}
                    </div>
                  ) : (
                    <textarea
                      className="studio-editor-textarea"
                      rows={14}
                      value={contentInput}
                      onChange={(e) => setContentInput(e.target.value)}
                      placeholder="在这里静下心打磨你的文字…"
                      autoFocus
                    />
                  )}

                  {/* Feature 1: Auto-Evolving STYLE.md Suggestions from Revision Diff */}
                  {(distilling || styleSuggestions.length > 0) && (
                    <div className="studio-distill-card">
                      <div className="studio-distill-head">
                        <div className="studio-distill-title">
                          <IconSparkles size={13} />
                          <span>
                            {distilling
                              ? "正在对比你的改稿差异，提炼个人写作习惯…"
                              : `从本次改稿发现 ${styleSuggestions.length} 条个人写作习惯，要记住进 STYLE.md 吗？`}
                          </span>
                        </div>
                        {!distilling && (
                          <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <button
                              type="button"
                              className="btn sm primary"
                              disabled={acceptingStyle}
                              onClick={() => void handleAcceptAllStyleRules()}
                            >
                              全部记住
                            </button>
                            <button
                              type="button"
                              className="btn icon-only ghost"
                              onClick={() => setStyleSuggestions([])}
                              title="暂不需要"
                            >
                              <IconClose size={13} />
                            </button>
                          </div>
                        )}
                      </div>
                      {!distilling && (
                        <div className="studio-distill-list">
                          {styleSuggestions.map((item) => (
                            <div key={item.id} className="studio-distill-row">
                              <div className="studio-distill-text">
                                <div className="studio-distill-rule">{item.rule}</div>
                                <div className="studio-distill-reason">{item.reason}</div>
                              </div>
                              <div className="studio-distill-btns">
                                <button
                                  type="button"
                                  className="btn sm soft"
                                  disabled={acceptingStyle}
                                  onClick={() => void handleAcceptStyleRule(item)}
                                >
                                  <IconCheck size={11} />
                                  <span>记住</span>
                                </button>
                                <button
                                  type="button"
                                  className="btn sm ghost"
                                  onClick={() =>
                                    setStyleSuggestions((prev) => prev.filter((s) => s.id !== item.id))
                                  }
                                >
                                  忽略
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Feature 2: Live FTS5 Related Past Highlights Auto-Surfacing while Writing */}
                  {relatedHighlights.length > 0 && (
                    <div className="studio-related-box">
                      <button
                        type="button"
                        className="studio-related-head"
                        onClick={() => setRelatedExpanded((v) => !v)}
                      >
                        <span className="studio-related-head-left">
                          <IconBookOpen size={13} />
                          <span>书库灵感自动浮现 · 找到 {relatedHighlights.length} 条相关旧划线</span>
                        </span>
                        <span className="studio-related-toggle">{relatedExpanded ? "收起" : "展开"}</span>
                      </button>

                      {relatedExpanded && (
                        <div className="studio-related-list">
                          {relatedHighlights.map((item) => (
                            <div key={item.id} className="studio-related-item">
                              <div className="studio-related-body">
                                <div className="studio-related-quote">
                                  “{item.quote.slice(0, 96)}{item.quote.length > 96 ? "…" : ""}”
                                </div>
                                <div className="studio-related-meta">
                                  <span>《{item.bookTitle}》</span>
                                  {item.matchedTerms.map((t) => (
                                    <span key={t} className="studio-related-term">
                                      #{t}
                                    </span>
                                  ))}
                                </div>
                              </div>
                              <button
                                type="button"
                                className="btn sm soft"
                                onClick={() => handleInsertRelatedHighlight(item)}
                              >
                                <IconPlus size={11} />
                                <span>插入引用</span>
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 8,
                      paddingTop: 12,
                      borderTop: "1px solid var(--border)",
                    }}
                  >
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                      <button
                        type="button"
                        className="btn sm soft"
                        onClick={() =>
                          onSendToChat(
                            `请帮我审阅并润色这篇草稿（draftId: ${detail.id}，标题：《${titleInput}》），严格遵守我的 STYLE.md 去 AI 味要求，修改后请调用 draft_create_or_revise 追加为一条新的 AI 修订版本：\n\n${contentInput}`,
                          )
                        }
                      >
                        <IconSparkles size={12} />
                        <span>AI 润色追加版</span>
                      </button>
                      <button
                        type="button"
                        className="btn sm ghost"
                        disabled={!contentInput.trim()}
                        onClick={() => setVisualModalOpen(true)}
                        title="自动提炼草稿结构，生成 1080×1440 高清思维导图或概念信息图，用作小红书首图或配图"
                      >
                        <IconWand size={12} />
                        <span>封面导图</span>
                      </button>
                      <button
                        type="button"
                        className="btn sm ghost"
                        disabled={!contentInput.trim()}
                        onClick={() => void handlePublishXiaohongshu()}
                        title="复制 H1/H2/引用/列表富文本并在右侧打开小红书「写长文」，直接套用官方一键排版"
                      >
                        <IconGlobe size={12} />
                        <span>复制并去小红书写长文</span>
                      </button>
                      <button type="button" className="btn sm ghost" onClick={() => void handleExportObsidian()}>
                        <IconBookOpen size={12} />
                        <span>同步 Obsidian</span>
                      </button>
                    </div>

                    <button
                      type="button"
                      className="btn sm primary"
                      onClick={() => void handleSaveHumanRevision()}
                      disabled={!dirty}
                    >
                      <IconCheck size={13} />
                      <span>保存为新版本 (v{detail.latestRevisionNo + 1})</span>
                    </button>
                  </div>

                  {exportResult && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                        padding: "8px 11px",
                        borderRadius: 8,
                        background: exportResult.status === "conflict" ? "var(--amber-soft)" : "var(--sage-soft)",
                        fontSize: 12,
                      }}
                    >
                      <span>{exportResult.message}</span>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => void window.diandian.obsidian.openDeepLink(exportResult.deepLink)}
                      >
                        <IconExternalLink size={12} />
                        打开 Obsidian
                      </button>
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </div>

      <ConceptVisualModal
        open={visualModalOpen}
        draftTitle={titleInput || detail?.title || ""}
        draftContent={contentInput}
        bookTitle={detail?.bookTitle}
        onClose={() => setVisualModalOpen(false)}
        onNotify={onNotify}
      />
    </div>
  );
};
