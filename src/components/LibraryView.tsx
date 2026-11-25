import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  BookMetadataCandidate,
  BookRecord,
  HighlightRecord,
  ObsidianExportOutcome,
  WeReadNotebookBook,
} from "../types/desktop";
import { CustomSelect } from "./CustomSelect";
import { ReadingPosterModal } from "./ReadingPosterModal";
import {
  IconBookOpen,
  IconCard,
  IconCheck,
  IconClose,
  IconExternalLink,
  IconEye,
  IconPenLine,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSparkles,
  IconSplit,
  IconTrash,
  IconUpload,
  IconWand,
} from "./Icons";

interface LibraryViewProps {
  refreshSignal: number;
  selectedBookId?: string | null;
  onSelectBookId?: (bookId: string | null) => void;
  viewMode?: "shelf" | "collision";
  onViewModeChange?: (mode: "shelf" | "collision") => void;
  onDataChanged?: () => void;
  onModalToggle: (open: boolean) => void;
  onSendToChat: (prompt: string) => void;
  onSendToDraft: (payload: { quote: string; comment: string; bookTitle: string; author: string }) => void;
  onNotify: (msg: string, tone?: "info" | "success" | "error") => void;
}

const SUGGESTED_THEMES = ["习惯", "系统", "自由", "激励", "长期", "认知", "关系", "决策"];

export const LibraryView: React.FC<LibraryViewProps> = ({
  refreshSignal,
  selectedBookId: controlledBookId,
  onSelectBookId,
  viewMode: controlledViewMode,
  onViewModeChange,
  onDataChanged,
  onModalToggle,
  onSendToChat,
  onSendToDraft,
  onNotify,
}) => {
  const [internalViewMode, setInternalViewMode] = useState<"shelf" | "collision">("shelf");
  const viewMode = controlledViewMode ?? internalViewMode;
  const setViewMode = (mode: "shelf" | "collision") => {
    onViewModeChange?.(mode);
    setInternalViewMode(mode);
  };

  const [books, setBooks] = useState<BookRecord[]>([]);
  const [internalSelectedBookId, setInternalSelectedBookId] = useState<string | null>(null);
  const selectedBookId = controlledBookId !== undefined ? controlledBookId : internalSelectedBookId;
  const setSelectedBookId = useCallback(
    (next: string | null | ((prev: string | null) => string | null)) => {
      if (typeof next === "function") {
        setInternalSelectedBookId((prev) => {
          const base = controlledBookId !== undefined ? controlledBookId : prev;
          const resolved = next(base);
          onSelectBookId?.(resolved);
          return resolved;
        });
      } else {
        setInternalSelectedBookId(next);
        onSelectBookId?.(next);
      }
    },
    [controlledBookId, onSelectBookId],
  );
  const [highlights, setHighlights] = useState<HighlightRecord[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [capturing, setCapturing] = useState(false);

  // Cross-book viewpoint collision
  const [themeQuery, setThemeQuery] = useState("");
  const [collisionHits, setCollisionHits] = useState<
    Array<HighlightRecord & { bookTitle: string; bookAuthor: string }>
  >([]);
  const [collisionLoading, setCollisionLoading] = useState(false);

  // Add highlight inline
  const [newQuote, setNewQuote] = useState("");
  const [newNote, setNewNote] = useState("");
  const [newChapter, setNewChapter] = useState("");
  const [showAddHighlight, setShowAddHighlight] = useState(false);

  // Inline note edit
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteText, setEditingNoteText] = useState("");

  // Last obsidian export badge
  const [lastExport, setLastExport] = useState<ObsidianExportOutcome | null>(null);

  // Modals
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importFormat, setImportFormat] = useState<"auto" | "kindle" | "weread">("auto");
  const [importTitle, setImportTitle] = useState("");

  const [newBookModalOpen, setNewBookModalOpen] = useState(false);
  const [newBookTitle, setNewBookTitle] = useState("");
  const [newBookAuthor, setNewBookAuthor] = useState("");

  const [metaModalOpen, setMetaModalOpen] = useState(false);
  const [metaQuery, setMetaQuery] = useState("");
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaCandidates, setMetaCandidates] = useState<BookMetadataCandidate[]>([]);

  // WeRead full-shelf sync modal
  const [wereadModalOpen, setWeReadModalOpen] = useState(false);
  const [wereadLoading, setWeReadLoading] = useState(false);
  const [wereadSyncing, setWeReadSyncing] = useState(false);
  const [wereadBooks, setWeReadBooks] = useState<WeReadNotebookBook[]>([]);
  const [selectedWeReadIds, setSelectedWeReadIds] = useState<string[]>([]);
  const [wereadError, setWeReadError] = useState("");

  // Monthly reading poster modal
  const [posterModalOpen, setPosterModalOpen] = useState(false);

  const anyModalOpen = importModalOpen || newBookModalOpen || metaModalOpen || wereadModalOpen || posterModalOpen;
  useEffect(() => {
    onModalToggle(anyModalOpen);
    return () => {
      if (anyModalOpen) onModalToggle(false);
    };
  }, [anyModalOpen, onModalToggle]);

  const loadBooks = useCallback(
    async (q = searchQuery) => {
      const list = await window.diandian.library.listBooks(q);
      setBooks(list);
      setSelectedBookId((prev) => {
        if (prev && list.some((b) => b.id === prev)) return prev;
        return list[0]?.id ?? null;
      });
    },
    [searchQuery],
  );

  const loadHighlights = useCallback(async (bookId: string | null) => {
    if (!bookId) {
      setHighlights([]);
      return;
    }
    const list = await window.diandian.library.listHighlights(bookId);
    setHighlights(list);
  }, []);

  useEffect(() => {
    void loadBooks(searchQuery);
  }, [loadBooks, searchQuery, refreshSignal]);

  useEffect(() => {
    setLastExport(null);
    void loadHighlights(selectedBookId);
  }, [selectedBookId, loadHighlights, refreshSignal]);

  const runCollisionSearch = useCallback(async (q: string) => {
    setCollisionLoading(true);
    try {
      const rows = await window.diandian.library.searchHighlights(q.trim(), 80);
      setCollisionHits(rows);
    } finally {
      setCollisionLoading(false);
    }
  }, []);

  useEffect(() => {
    if (viewMode === "collision") {
      void runCollisionSearch(themeQuery);
    }
  }, [viewMode, themeQuery, runCollisionSearch, refreshSignal]);

  const groupedCollision = useMemo(() => {
    const map = new Map<
      string,
      { bookId: string; bookTitle: string; bookAuthor: string; items: Array<HighlightRecord & { bookTitle: string; bookAuthor: string }> }
    >();
    for (const item of collisionHits) {
      const existing = map.get(item.bookId);
      if (existing) {
        existing.items.push(item);
      } else {
        map.set(item.bookId, {
          bookId: item.bookId,
          bookTitle: item.bookTitle,
          bookAuthor: item.bookAuthor,
          items: [item],
        });
      }
    }
    return [...map.values()].sort((a, b) => b.items.length - a.items.length);
  }, [collisionHits]);

  const selectedBook = books.find((b) => b.id === selectedBookId) ?? null;

  const handleOpenWeReadSync = async () => {
    setWeReadModalOpen(true);
    setWeReadError("");
    setWeReadLoading(true);
    try {
      const list = await window.diandian.library.listWeReadNotebooks();
      setWeReadBooks(list);
      setSelectedWeReadIds(list.slice(0, 10).map((b) => b.bookId));
    } catch (error) {
      setWeReadBooks([]);
      setWeReadError(error instanceof Error ? error.message : "读取微信读书笔记书单失败");
    } finally {
      setWeReadLoading(false);
    }
  };

  const handleSyncSelectedWeRead = async () => {
    const chosen = wereadBooks.filter((b) => selectedWeReadIds.includes(b.bookId));
    if (chosen.length === 0) return;
    setWeReadSyncing(true);
    setWeReadError("");
    try {
      const res = await window.diandian.library.syncWeReadBooks(chosen);
      setWeReadModalOpen(false);
      await loadBooks();
      onDataChanged?.();
      if (res.details[0]?.localBookId) {
        setSelectedBookId(res.details[0].localBookId);
      }
      onNotify(
        `微信读书同步完成：共 ${res.booksSynced} 本书，新增 ${res.importedCount} 条划线/想法，自动去重 ${res.deduplicatedCount} 条`,
        "success",
      );
    } catch (error) {
      setWeReadError(error instanceof Error ? error.message : "同步微信读书失败");
    } finally {
      setWeReadSyncing(false);
    }
  };

  const handleCaptureBrowser = async () => {
    setCapturing(true);
    try {
      const res = await window.diandian.library.captureFromBrowser({});
      await loadBooks();
      onDataChanged?.();
      setSelectedBookId(res.book.id);
      await loadHighlights(res.book.id);
      onNotify(
        res.deduplicated
          ? `这条划线已在《${res.book.title}》中，已自动去重`
          : `已采集到《${res.book.title}》（${res.usedSelection ? "选中段落" : "当前页正文"}）`,
        "success",
      );
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "采集失败", "error");
    } finally {
      setCapturing(false);
    }
  };

  const handleImportFile = async () => {
    try {
      const res = await window.diandian.library.importNotesFile({
        format: importFormat,
        fallbackTitle: importTitle || undefined,
      });
      if (res.canceled) return;
      setImportModalOpen(false);
      await loadBooks();
      onDataChanged?.();
      if (res.bookIds[0]) setSelectedBookId(res.bookIds[0]);
      onNotify(
        `导入完成（${res.format}）：新增 ${res.importedCount} 条，去重 ${res.deduplicatedCount} 条（涉及 ${res.booksTouched} 本书）`,
        "success",
      );
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "导入失败", "error");
    }
  };

  const handleImportTextSubmit = async () => {
    if (!importText.trim()) return;
    try {
      const res = await window.diandian.library.importNotesText({
        rawText: importText,
        format: importFormat,
        fallbackTitle: importTitle || undefined,
      });
      setImportText("");
      setImportModalOpen(false);
      await loadBooks();
      onDataChanged?.();
      if (res.bookIds[0]) setSelectedBookId(res.bookIds[0]);
      onNotify(`已导入 ${res.importedCount} 条划线（去重 ${res.deduplicatedCount} 条）`, "success");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "解析失败", "error");
    }
  };

  const handleCreateBook = async () => {
    if (!newBookTitle.trim()) return;
    try {
      const book = await window.diandian.library.createBook({
        title: newBookTitle.trim(),
        author: newBookAuthor.trim(),
        source: "manual",
      });
      setNewBookTitle("");
      setNewBookAuthor("");
      setNewBookModalOpen(false);
      await loadBooks();
      onDataChanged?.();
      setSelectedBookId(book.id);
      onNotify(`已新建书目《${book.title}》`, "success");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "创建失败", "error");
    }
  };

  const handleAddHighlight = async () => {
    if (!selectedBook || !newQuote.trim()) return;
    try {
      const res = await window.diandian.library.addHighlight({
        bookId: selectedBook.id,
        chapter: newChapter.trim(),
        quote: newQuote.trim(),
        note: newNote.trim(),
      });
      setNewQuote("");
      setNewNote("");
      setNewChapter("");
      setShowAddHighlight(false);
      await loadBooks();
      onDataChanged?.();
      await loadHighlights(selectedBook.id);
      onNotify(res.deduplicated ? "已有相同划线，自动去重" : "已保存划线", "success");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "保存失败", "error");
    }
  };

  const handleSaveNote = async (id: string) => {
    try {
      await window.diandian.library.updateHighlightNote(id, editingNoteText);
      setEditingNoteId(null);
      await loadHighlights(selectedBookId);
      onNotify("想法已更新", "success");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "更新失败", "error");
    }
  };

  const handleOpenMetaLookup = async () => {
    if (!selectedBook) return;
    const q = [selectedBook.title, selectedBook.author].filter(Boolean).join(" ");
    setMetaQuery(q);
    setMetaCandidates([]);
    setMetaModalOpen(true);
    setMetaLoading(true);
    try {
      const list = await window.diandian.library.lookupMetadata(q);
      setMetaCandidates(list);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "在线元数据查询失败", "error");
    } finally {
      setMetaLoading(false);
    }
  };

  const handleSearchMeta = async () => {
    if (!metaQuery.trim()) return;
    setMetaLoading(true);
    try {
      const list = await window.diandian.library.lookupMetadata(metaQuery.trim());
      setMetaCandidates(list);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "查询失败", "error");
    } finally {
      setMetaLoading(false);
    }
  };

  const handleApplyMeta = async (cand: BookMetadataCandidate) => {
    if (!selectedBook) return;
    try {
      await window.diandian.library.updateBook({
        id: selectedBook.id,
        title: cand.title || selectedBook.title,
        author: cand.author || selectedBook.author,
        isbn: cand.isbn || selectedBook.isbn,
        publisher: cand.publisher || selectedBook.publisher,
        publishedYear: cand.publishedYear || selectedBook.publishedYear,
        description: cand.description || selectedBook.description,
        coverUrl: cand.coverUrl || selectedBook.coverUrl,
      });
      setMetaModalOpen(false);
      await loadBooks();
      onNotify("已补全书籍元数据", "success");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "应用元数据失败", "error");
    }
  };

  const handleExportObsidian = async () => {
    if (!selectedBook) return;
    try {
      const res = await window.diandian.obsidian.exportBook(selectedBook.id);
      setLastExport(res);
      onNotify(res.message, res.status === "conflict" ? "info" : "success");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "导出 Obsidian 失败", "error");
    }
  };

  const handleDeleteBook = async () => {
    if (!selectedBook) return;
    await window.diandian.library.deleteBook(selectedBook.id);
    setSelectedBookId(null);
    await loadBooks();
    onDataChanged?.();
    onNotify(`已删除《${selectedBook.title}》`, "info");
  };

  const handleGenerateCollisionReport = () => {
    if (groupedCollision.length === 0) return;
    const topicLabel = themeQuery.trim() || "我近期关注的核心主题";
    const snippet = groupedCollision
      .slice(0, 6)
      .map((g) => {
        const lines = g.items
          .slice(0, 4)
          .map((it) => `  - 「${it.quote.slice(0, 140)}」${it.note ? `（我的想法：${it.note}）` : ""}`)
          .join("\n");
        return `《${g.bookTitle}》${g.bookAuthor ? `（${g.bookAuthor}）` : ""}：\n${lines}`;
      })
      .join("\n\n");

    onSendToChat(
      `请围绕主题「${topicLabel}」，对我本地书库里来自 ${groupedCollision.length} 本不同书籍的划线做一次深度「跨书观点碰撞分析」，严格遵守我的 STYLE.md 风格：\n1. 这些书之间有哪些**核心共识与互相印证**？\n2. 哪几本书的观点存在**明显分歧或适用边界张力**？\n3. 结合我写下的个人批注，提炼一个属于我自己的判断框架，并调用 draft_create_or_revise 存成一篇专题主题对照草稿（kind: "note"）。\n\n以下是命中的跨书划线：\n\n${snippet}`,
    );
  };

  return (
    <div className="chat-view">
      <header className="view-header">
        <div className="view-header-left">
          <h1 className="view-title">本地书库</h1>
          <span className="badge">{books.length} 本书</span>
        </div>
        <div className="view-header-right">
          <button type="button" className="btn sm sage" onClick={() => void handleOpenWeReadSync()}>
            <IconRefresh size={13} />
            <span>同步微信读书</span>
          </button>
          <button type="button" className="btn sm ghost" onClick={() => void handleCaptureBrowser()} disabled={capturing}>
            <IconEye size={13} />
            <span>{capturing ? "采集中…" : "采集右侧"}</span>
          </button>
          <button type="button" className="btn sm ghost" onClick={() => setImportModalOpen(true)}>
            <IconUpload size={13} />
            <span>导入</span>
          </button>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => setPosterModalOpen(true)}
            title="生成本月跨源阅读月报海报"
          >
            <IconCard size={13} />
            <span>阅读月报</span>
          </button>
          <button type="button" className="btn sm primary" onClick={() => setNewBookModalOpen(true)}>
            <IconPlus size={13} />
            <span>新建</span>
          </button>
        </div>
      </header>

      <div className="library-subbar">
        <div className="section-tabs">
          <button
            type="button"
            className={`section-tab ${viewMode === "shelf" ? "active" : ""}`}
            onClick={() => setViewMode("shelf")}
          >
            我的书架与划线
          </button>
          <button
            type="button"
            className={`section-tab ${viewMode === "collision" ? "active" : ""}`}
            onClick={() => setViewMode("collision")}
          >
            跨书观点碰撞
          </button>
        </div>

        {viewMode === "shelf" && (books.length > 0 || searchQuery.trim().length > 0) && (
          <div className="inline-filter-box">
            <IconSearch size={13} />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="筛选书名、作者或标签…"
            />
            {searchQuery && (
              <button
                type="button"
                className="inline-filter-clear"
                onClick={() => setSearchQuery("")}
                title="清空筛选"
              >
                <IconClose size={11} />
              </button>
            )}
          </div>
        )}
      </div>

      {viewMode === "collision" ? (
        <div className="studio-scroll">
          <div className="surf-doc-container">
            <section className="surf-plain-section" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: "-0.015em" }}>
                    跨书观点碰撞 &amp; 主题对照
                  </h3>
                  <div style={{ fontSize: 12.5, color: "var(--ink-muted)", marginTop: 3 }}>
                    输入任意关键词，把你所有书里关于同一问题的划线按书目并排呈现，一键生成多书思辨对照笔记。
                  </div>
                </div>
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={groupedCollision.length === 0}
                  onClick={handleGenerateCollisionReport}
                >
                  <IconSparkles size={13} />
                  <span>AI 生成碰撞报告</span>
                </button>
              </div>

            <div className="search-row">
              <div className="search-box">
                <IconSearch size={14} />
                <input
                  className="input"
                  value={themeQuery}
                  onChange={(e) => setThemeQuery(e.target.value)}
                  placeholder="输入碰撞主题词，如：激励、习惯、系统、自由、护城河…"
                />
              </div>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>快捷主题：</span>
              {SUGGESTED_THEMES.map((kw) => (
                <button
                  key={kw}
                  type="button"
                  className="quick-chip"
                  onClick={() => setThemeQuery(kw)}
                >
                  {kw}
                </button>
              ))}
              {themeQuery && (
                <button type="button" className="quick-chip" onClick={() => setThemeQuery("")}>
                  显示全部
                </button>
              )}
            </div>
          </section>

          {collisionLoading ? (
            <div className="muted-box">正在跨书检索历史划线…</div>
          ) : groupedCollision.length === 0 ? (
            <div className="muted-box">
              没有在本地书库里找到匹配「{themeQuery || "全部"}」的划线。可以先点击右上角「同步微信读书」或导入 Kindle 笔记充实书库。
            </div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--ink-secondary)" }}>
                <IconSplit size={14} />
                <span>
                  命中 <strong>{groupedCollision.length}</strong> 本书 · 共 <strong>{collisionHits.length}</strong> 条相关划线
                </span>
              </div>
              <div className="collision-grid">
                {groupedCollision.map((group) => (
                  <article key={group.bookId} className="editorial-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                      <h4 style={{ margin: 0, fontFamily: "var(--font-serif)", fontSize: 15 }}>
                        《{group.bookTitle}》
                      </h4>
                      <span className="badge">{group.items.length} 条</span>
                    </div>
                    {group.bookAuthor && (
                      <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: -6 }}>
                        {group.bookAuthor}
                      </div>
                    )}
                    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                      {group.items.slice(0, 6).map((item) => (
                        <div key={item.id} style={{ paddingLeft: 10, borderLeft: "2px solid var(--accent-border)" }}>
                          <div style={{ fontFamily: "var(--font-serif)", fontSize: 13.5, lineHeight: 1.65 }}>
                            {item.quote}
                          </div>
                          {item.note && (
                            <div style={{ fontSize: 12, color: "var(--accent-hover)", marginTop: 4 }}>
                              想法：{item.note}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
          </div>
        </div>
      ) : (
        <div className="studio-scroll">
          <div className="surf-doc-container">
            {books.length === 0 ? (
              searchQuery.trim() ? (
                <div className="muted-box" style={{ padding: "28px 20px" }}>
                  <div style={{ marginBottom: 10 }}>
                    未找到与「<strong>{searchQuery.trim()}</strong>」匹配的书目
                  </div>
                  <button type="button" className="btn sm" onClick={() => setSearchQuery("")}>
                    清空筛选
                  </button>
                </div>
              ) : (
                <div className="muted-box" style={{ padding: "36px 20px" }}>
                  <div style={{ marginBottom: 8, color: "var(--ink)", fontWeight: 600 }}>书库还是空的</div>
                  <div style={{ marginBottom: 14 }}>
                    你可以直接点击 <strong>「同步微信读书」</strong> 一键拉取整书全部划线与想法，或导入 Kindle{" "}
                    <span className="code-inline">My Clippings.txt</span>，或在右侧选中任意段落直接浮窗点「存书库」。
                  </div>
                  <div style={{ display: "flex", justifyContent: "center", flexWrap: "wrap", gap: 8 }}>
                    <button type="button" className="btn sage" onClick={() => void handleOpenWeReadSync()}>
                      <IconRefresh size={14} />
                      一键同步微信读书书架笔记
                    </button>
                    <button type="button" className="btn primary" onClick={() => setImportModalOpen(true)}>
                      <IconUpload size={14} />
                      导入 Kindle / 文本笔记
                    </button>
                    <button type="button" className="btn" onClick={() => setNewBookModalOpen(true)}>
                      <IconPlus size={14} />
                      手动建档
                    </button>
                  </div>
                </div>
              )
            ) : (
              <>
                <div className="switcher-strip" role="tablist" aria-label="书架切换">
                  {books.map((book) => (
                    <button
                      key={book.id}
                      type="button"
                      role="tab"
                      aria-selected={book.id === selectedBookId}
                      className={`switcher-pill ${book.id === selectedBookId ? "active" : ""}`}
                      onClick={() => setSelectedBookId(book.id)}
                      title={`${book.title}${book.author ? ` · ${book.author}` : ""}`}
                    >
                      <IconBookOpen size={12} style={{ flexShrink: 0, opacity: 0.72 }} />
                      <span className="switcher-pill-title">{book.title}</span>
                      {book.highlightCount > 0 && (
                        <span className="switcher-pill-meta">{book.highlightCount}</span>
                      )}
                    </button>
                  ))}
                </div>

                {selectedBook && (
                  <>
                    <section className="surf-plain-section">
                    <div className="book-hero">
                      <div className="book-cover-box">
                        {selectedBook.coverUrl ? (
                          <img src={selectedBook.coverUrl} alt={selectedBook.title} />
                        ) : (
                          selectedBook.title.slice(0, 1)
                        )}
                      </div>
                      <div className="book-hero-info">
                        <h2 className="book-hero-title">{selectedBook.title}</h2>
                        <div className="book-hero-meta">
                          <span>{selectedBook.author || "作者待补全"}</span>
                          {selectedBook.publisher && <span>· {selectedBook.publisher}</span>}
                          {selectedBook.publishedYear && <span>· {selectedBook.publishedYear}</span>}
                          {selectedBook.isbn && <span className="badge mono">ISBN {selectedBook.isbn}</span>}
                          <span className="badge">{selectedBook.highlightCount} 条划线</span>
                        </div>
                        {selectedBook.description && (
                          <p style={{ margin: "0 0 10px", fontSize: 12.5, color: "var(--ink-secondary)" }}>
                            {selectedBook.description.slice(0, 180)}
                            {selectedBook.description.length > 180 ? "…" : ""}
                          </p>
                        )}
                        <div className="book-hero-actions">
                          <button
                            type="button"
                            className="btn sm primary"
                            onClick={() =>
                              onSendToChat(
                                `请读取本地书库中《${selectedBook.title}》（bookId: ${selectedBook.id}）的全部划线和我的想法，按照我的 STYLE.md 风格提炼 1 篇有个人立场的书评初稿，并存入创作工作台。`,
                              )
                            }
                          >
                            <IconSparkles size={12} />
                            <span>AI 基于划线起草</span>
                          </button>
                          <button type="button" className="btn sm" onClick={() => void handleOpenMetaLookup()}>
                            <IconWand size={12} />
                            <span>补全元数据</span>
                          </button>
                          <button type="button" className="btn sm sage" onClick={() => void handleExportObsidian()}>
                            <IconBookOpen size={12} />
                            <span>同步 Obsidian</span>
                          </button>
                          <button
                            type="button"
                            className="btn sm"
                            onClick={() => setShowAddHighlight((v) => !v)}
                          >
                            <IconPlus size={12} />
                            <span>记一条划线</span>
                          </button>
                          <button
                            type="button"
                            className="btn sm ghost"
                            onClick={() => void handleDeleteBook()}
                            title="删除这本书"
                          >
                            <IconTrash size={12} />
                          </button>
                        </div>

                        {lastExport && (
                          <div
                            style={{
                              marginTop: 10,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: 8,
                              padding: "7px 10px",
                              borderRadius: 8,
                              background: lastExport.status === "conflict" ? "var(--amber-soft)" : "var(--sage-soft)",
                              fontSize: 12,
                            }}
                          >
                            <span>{lastExport.message}</span>
                            <button
                              type="button"
                              className="btn sm"
                              onClick={() => void window.diandian.obsidian.openDeepLink(lastExport.deepLink)}
                            >
                              <IconExternalLink size={12} />
                              在 Obsidian 打开
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </section>

                  {showAddHighlight && (
                    <section className="editorial-card">
                      <div className="field-group">
                        <label className="field-label">原文划线 / 金句</label>
                        <textarea
                          className="textarea"
                          rows={3}
                          value={newQuote}
                          onChange={(e) => setNewQuote(e.target.value)}
                          placeholder="粘贴或输入书中的关键段落…"
                        />
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                        <div className="field-group">
                          <label className="field-label">章节（可选）</label>
                          <input
                            className="input"
                            value={newChapter}
                            onChange={(e) => setNewChapter(e.target.value)}
                            placeholder="如：第三章 系统惯性"
                          />
                        </div>
                        <div className="field-group">
                          <label className="field-label">我的想法（可选）</label>
                          <input
                            className="input"
                            value={newNote}
                            onChange={(e) => setNewNote(e.target.value)}
                            placeholder="这一句触动了你什么？"
                          />
                        </div>
                      </div>
                      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                        <button type="button" className="btn sm" onClick={() => setShowAddHighlight(false)}>
                          取消
                        </button>
                        <button type="button" className="btn sm primary" onClick={() => void handleAddHighlight()}>
                          保存到书库
                        </button>
                      </div>
                    </section>
                  )}

                  <div className="highlight-list">
                    {highlights.length === 0 ? (
                      <div className="muted-box">这本书还没有划线记录，点击上方「同步微信读书」「采集右侧」或「记一条划线」开始积累。</div>
                    ) : (
                      highlights.map((h) => (
                        <article key={h.id} className="highlight-card">
                          <div className="highlight-chapter">
                            <span>{h.chapter || "未标注章节"}</span>
                            <span className="badge mono">{h.source}</span>
                          </div>
                          <blockquote className="highlight-quote">{h.quote}</blockquote>

                          {editingNoteId === h.id ? (
                            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                              <textarea
                                className="textarea"
                                rows={2}
                                value={editingNoteText}
                                onChange={(e) => setEditingNoteText(e.target.value)}
                                placeholder="写下你的个人思考或反驳…"
                              />
                              <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
                                <button type="button" className="btn sm" onClick={() => setEditingNoteId(null)}>
                                  取消
                                </button>
                                <button type="button" className="btn sm primary" onClick={() => void handleSaveNote(h.id)}>
                                  保存想法
                                </button>
                              </div>
                            </div>
                          ) : h.note ? (
                            <div className="highlight-note">
                              <strong style={{ color: "var(--accent)", marginRight: 6 }}>我的想法</strong>
                              {h.note}
                            </div>
                          ) : null}

                          <div className="highlight-footer">
                            <button
                              type="button"
                              className="btn sm ghost"
                              onClick={() => {
                                setEditingNoteId(h.id);
                                setEditingNoteText(h.note);
                              }}
                            >
                              {h.note ? "编辑想法" : "+ 写想法"}
                            </button>
                            <button
                              type="button"
                              className="btn sm ghost"
                              onClick={() =>
                                onSendToDraft({
                                  quote: h.quote,
                                  comment: h.note,
                                  bookTitle: selectedBook.title,
                                  author: selectedBook.author,
                                })
                              }
                            >
                              <IconPenLine size={12} />
                              <span>写入草稿</span>
                            </button>
                            <button
                              type="button"
                              className="btn sm ghost"
                              onClick={() =>
                                onSendToChat(
                                  `我在读《${selectedBook.title}》时划下这句话：\n\n> ${h.quote}\n${h.note ? `\n我的想法：${h.note}\n` : ""}\n请帮我深度拆解并延伸讨论。`,
                                )
                              }
                            >
                              <IconSparkles size={12} />
                              <span>共读</span>
                            </button>
                            <button
                              type="button"
                              className="btn sm ghost"
                              onClick={async () => {
                                await window.diandian.library.deleteHighlight(h.id);
                                await loadBooks();
                                onDataChanged?.();
                                await loadHighlights(selectedBook.id);
                              }}
                              title="删除划线"
                            >
                              <IconTrash size={12} />
                            </button>
                          </div>
                        </article>
                      ))
                    )}
                  </div>
                </>
              )}
            </>
          )}
          </div>
        </div>
      )}

      {/* WeRead Full-Shelf Highlights Sync Modal */}
      {wereadModalOpen && (
        <div className="modal-backdrop" onClick={() => setWeReadModalOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ width: 560 }}>
            <div className="modal-header">
              <h3>一键同步微信读书整书划线与想法</h3>
              <button type="button" className="btn icon-only ghost" onClick={() => setWeReadModalOpen(false)}>
                <IconClose size={16} />
              </button>
            </div>

            <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--ink-secondary)", lineHeight: 1.55 }}>
              直接复用你右侧内置浏览器的微信读书登录态，批量拉取整本书的章节划线与个人想法（自动 SHA-256 指纹去重，后续增量更新不重复）。
            </p>

            {wereadLoading ? (
              <div className="muted-box">正在读取你的微信读书笔记书单…</div>
            ) : wereadError ? (
              <div style={{ padding: "12px 14px", borderRadius: 10, background: "var(--danger-soft)", color: "var(--danger)", fontSize: 12.5, lineHeight: 1.6 }}>
                {wereadError}
              </div>
            ) : wereadBooks.length === 0 ? (
              <div className="muted-box">你的微信读书账号下暂无带划线或想法的书目。</div>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>
                    共检测到 {wereadBooks.length} 本带笔记书籍，已选 {selectedWeReadIds.length} 本
                  </span>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      type="button"
                      className="btn sm ghost"
                      onClick={() => setSelectedWeReadIds(wereadBooks.map((b) => b.bookId))}
                    >
                      全选
                    </button>
                    <button
                      type="button"
                      className="btn sm ghost"
                      onClick={() => setSelectedWeReadIds([])}
                    >
                      清空
                    </button>
                  </div>
                </div>

                <div className="cookie-domain-list" style={{ maxHeight: 320 }}>
                  {wereadBooks.map((b) => {
                    const checked = selectedWeReadIds.includes(b.bookId);
                    return (
                      <label key={b.bookId} className={`cookie-domain-row ${checked ? "selected" : ""}`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setSelectedWeReadIds((prev) =>
                              prev.includes(b.bookId)
                                ? prev.filter((id) => id !== b.bookId)
                                : [...prev, b.bookId],
                            )
                          }
                        />
                        <div className="book-cover-box" style={{ width: 32, height: 44, fontSize: 13 }}>
                          {b.coverUrl ? <img src={b.coverUrl} alt={b.title} /> : b.title.slice(0, 1)}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {b.title}
                          </div>
                          <div style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                            {b.author || "未知作者"}
                          </div>
                        </div>
                        <span className="badge mono">{b.bookmarkCount || b.noteCount} 划线</span>
                        {b.reviewCount > 0 && <span className="badge accent">{b.reviewCount} 想法</span>}
                      </label>
                    );
                  })}
                </div>
              </>
            )}

            <div className="modal-footer">
              <button type="button" className="btn" onClick={() => setWeReadModalOpen(false)}>
                关闭
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={wereadSyncing || selectedWeReadIds.length === 0}
                onClick={() => void handleSyncSelectedWeRead()}
              >
                <IconCheck size={14} />
                <span>{wereadSyncing ? "正在拉取入库…" : `同步选中的 ${selectedWeReadIds.length} 本书`}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import Notes Modal */}
      {importModalOpen && (
        <div className="modal-backdrop" onClick={() => setImportModalOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>导入 Kindle / 微信读书笔记</h3>
              <button type="button" className="btn icon-only ghost" onClick={() => setImportModalOpen(false)}>
                <IconClose size={16} />
              </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div className="field-group">
                <label className="field-label">格式识别</label>
                <CustomSelect
                  value={importFormat}
                  onChange={(val) => setImportFormat(val as "auto" | "kindle" | "weread")}
                  ariaLabel="导入格式识别"
                  options={[
                    { value: "auto", label: "自动识别（推荐）", description: "智能判断 Kindle 或微信读书导出格式" },
                    { value: "kindle", label: "Kindle My Clippings.txt", description: "标准 Kindle 设备标注文本" },
                    { value: "weread", label: "微信读书导出笔记 / Markdown", description: "支持微信读书复制或导出笔记" },
                  ]}
                />
              </div>
              <div className="field-group">
                <label className="field-label">默认书名（微信读书粘贴时可选）</label>
                <input
                  className="input"
                  value={importTitle}
                  onChange={(e) => setImportTitle(e.target.value)}
                  placeholder="留空则自动从首行提取"
                />
              </div>
            </div>

            <div className="field-group">
              <button type="button" className="btn soft" onClick={() => void handleImportFile()}>
                <IconUpload size={14} />
                选择本机文件（My Clippings.txt / .md / .txt）
              </button>
            </div>

            <div className="field-group">
              <label className="field-label">或直接粘贴导出的划线文本</label>
              <textarea
                className="textarea"
                rows={7}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={"例如微信读书 App「导出笔记 -> 复制」后的文本：\n◆ 第一章\n>> 这是一条划线金句…"}
              />
            </div>

            <div className="modal-footer">
              <button type="button" className="btn" onClick={() => setImportModalOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => void handleImportTextSubmit()}
                disabled={!importText.trim()}
              >
                解析并去重入库
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New Book Modal */}
      {newBookModalOpen && (
        <div className="modal-backdrop" onClick={() => setNewBookModalOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ width: 420 }}>
            <div className="modal-header">
              <h3>新建书籍档案</h3>
              <button type="button" className="btn icon-only ghost" onClick={() => setNewBookModalOpen(false)}>
                <IconClose size={16} />
              </button>
            </div>
            <div className="field-group">
              <label className="field-label">书名</label>
              <input
                className="input"
                value={newBookTitle}
                onChange={(e) => setNewBookTitle(e.target.value)}
                placeholder="例如：置身事内"
              />
            </div>
            <div className="field-group">
              <label className="field-label">作者（可选）</label>
              <input
                className="input"
                value={newBookAuthor}
                onChange={(e) => setNewBookAuthor(e.target.value)}
                placeholder="例如：兰小欢"
              />
            </div>
            <div className="modal-footer">
              <button type="button" className="btn" onClick={() => setNewBookModalOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => void handleCreateBook()}
                disabled={!newBookTitle.trim()}
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Metadata Lookup Modal */}
      {metaModalOpen && (
        <div className="modal-backdrop" onClick={() => setMetaModalOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>在线补全书籍元数据</h3>
              <button type="button" className="btn icon-only ghost" onClick={() => setMetaModalOpen(false)}>
                <IconClose size={16} />
              </button>
            </div>
            <div className="search-row" style={{ marginBottom: 12 }}>
              <input
                className="input"
                value={metaQuery}
                onChange={(e) => setMetaQuery(e.target.value)}
                placeholder="输入书名、作者或 ISBN…"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSearchMeta();
                }}
              />
              <button type="button" className="btn primary" onClick={() => void handleSearchMeta()} disabled={metaLoading}>
                {metaLoading ? "查询中…" : "查询"}
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {metaLoading ? (
                <div className="muted-box">正在并行查询 Google Books 与 Open Library…</div>
              ) : metaCandidates.length === 0 ? (
                <div className="muted-box">暂无匹配结果，可尝试只输入书名或 ISBN 重新查询。</div>
              ) : (
                metaCandidates.map((c, idx) => (
                  <div
                    key={`${c.source}-${idx}`}
                    className="editorial-card"
                    style={{ padding: 12, display: "flex", gap: 12, alignItems: "center" }}
                  >
                    <div className="book-cover-box" style={{ width: 42, height: 60, fontSize: 15 }}>
                      {c.coverUrl ? <img src={c.coverUrl} alt={c.title} /> : c.title.slice(0, 1)}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontFamily: "var(--font-serif)" }}>{c.title}</div>
                      <div style={{ fontSize: 12, color: "var(--ink-secondary)" }}>
                        {[c.author, c.publisher, c.publishedYear, c.isbn].filter(Boolean).join(" · ")}
                      </div>
                      <span className="badge mono" style={{ marginTop: 4 }}>{c.source}</span>
                    </div>
                    <button type="button" className="btn sm primary" onClick={() => void handleApplyMeta(c)}>
                      应用
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      <ReadingPosterModal
        open={posterModalOpen}
        onClose={() => setPosterModalOpen(false)}
        onNotify={onNotify}
      />
    </div>
  );
};
