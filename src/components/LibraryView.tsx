import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canonicalIsbn } from "../../electron/isbn";
import type {
  BookMetadataSource,
  BookRecord,
  HighlightRecord,
  WeReadNotebookBook,
} from "../types/desktop";
import { ObsidianExportAction } from "./ObsidianExportAction";
import { LibraryBookCover } from "./LibraryBookCover";
import { ActionMenu } from "./ActionMenu";
import { ListPicker } from "./ListPicker";
import { formatUserError } from "../utils/formatError";
import { CustomSelect } from "./CustomSelect";
import { ReadingPosterModal } from "./ReadingPosterModal";
import {
  IconBookOpen,
  IconCard,
  IconCheck,
  IconClose,
  IconEye,
  IconMoreHorizontal,
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

const SOURCE_LABELS: Record<string, string> = {
  weread: "微信读书",
  kindle: "Kindle",
  local: "本地阅读",
  zlib: "Z-Library",
  manual: "手动记录",
};

interface LibraryViewProps {
  onOpenOriginal: (highlightId: string) => void;
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
  /** One-shot command from the native app menu (文件 → 新建书目 / 导入笔记). */
  menuCommand?: { kind: "new-book" | "import-notes"; nonce: number } | null;
  onMenuCommandHandled?: () => void;
}

const SUGGESTED_THEMES = ["习惯", "系统", "自由", "激励", "长期", "认知", "关系", "决策"];

const METADATA_SOURCES: Record<BookMetadataSource, string> = {
  weread: "微信读书",
  "google-books": "Google Books",
  openlibrary: "Open Library",
};

type MetadataResult = Awaited<ReturnType<typeof window.diandian.library.lookupMetadata>>;

function metadataSearchNotice({ candidates, issues, invalidIsbn }: MetadataResult): string {
  if (invalidIsbn) return "ISBN 校验未通过，请核对书上的 10 位或 13 位书号。";
  const messages: string[] = [];
  if (candidates.length === 0) {
    const failed = new Set(issues.map(issue => METADATA_SOURCES[issue.source]));
    const available = Object.values(METADATA_SOURCES).filter(name => !failed.has(name));
    messages.push(available.length
      ? `${available.join("、")} 未找到匹配的书籍。可以只输入书名，或用 ISBN 再查一次。`
      : "所有书源暂时都无法完成查询，请稍后重试。");
  }
  for (const issue of issues) {
    const reason = issue.reason === "rate-limited" ? "暂时限制了查询次数" : "暂时无法访问";
    messages.push(`${METADATA_SOURCES[issue.source]}${reason}。`);
  }
  return messages.join(" ");
}

export const LibraryView: React.FC<LibraryViewProps> = ({
  onOpenOriginal,
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
  menuCommand,
  onMenuCommandHandled,
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
  const activeBookId = useRef(selectedBookId);
  useEffect(() => { activeBookId.current = selectedBookId; }, [selectedBookId]);
  const setSelectedBookId = useCallback(
    (next: string | null) => {
      activeBookId.current = next;
      setInternalSelectedBookId(next);
      onSelectBookId?.(next);
    },
    [onSelectBookId],
  );
  const [highlights, setHighlights] = useState<HighlightRecord[]>([]);
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
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  useEffect(() => setDescriptionExpanded(false), [selectedBookId]);

  // Inline note edit
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteText, setEditingNoteText] = useState("");

  // Modals
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importError, setImportError] = useState("");
  const [importText, setImportText] = useState("");
  const [importFormat, setImportFormat] = useState<"auto" | "kindle" | "weread">("auto");
  const [importTitle, setImportTitle] = useState("");

  const [newBookModalOpen, setNewBookModalOpen] = useState(false);
  const [newBookTitle, setNewBookTitle] = useState("");
  const [newBookAuthor, setNewBookAuthor] = useState("");

  const [metaModalOpen, setMetaModalOpen] = useState(false);
  const [metaQuery, setMetaQuery] = useState("");
  const [metaSearch, setMetaSearch] = useState<
    { status: "loading" | "error" } | { status: "done"; result: MetadataResult }
  >({ status: "loading" });
  const [applyingEdition, setApplyingEdition] = useState<number | null>(null);
  const metaRequest = useRef(0);
  const metaResult = metaSearch.status === "done" ? metaSearch.result : undefined;
  const metaNotice = metaResult && metadataSearchNotice(metaResult);

  // WeRead full-shelf sync modal
  const [wereadModalOpen, setWeReadModalOpen] = useState(false);
  const [wereadLoading, setWeReadLoading] = useState(false);
  const [wereadSyncing, setWeReadSyncing] = useState(false);
  const [wereadBooks, setWeReadBooks] = useState<WeReadNotebookBook[]>([]);
  const [selectedWeReadIds, setSelectedWeReadIds] = useState<string[]>([]);
  const [wereadError, setWeReadError] = useState("");

  // Monthly reading poster modal
  const [posterModalOpen, setPosterModalOpen] = useState(false);

  useEffect(() => {
    if (!menuCommand) return;
    if (menuCommand.kind === "new-book") setNewBookModalOpen(true);
    else setImportModalOpen(true);
    onMenuCommandHandled?.();
  }, [menuCommand, onMenuCommandHandled]);

  const anyModalOpen = importModalOpen || newBookModalOpen || metaModalOpen || wereadModalOpen || posterModalOpen;
  useEffect(() => {
    onModalToggle(anyModalOpen);
    return () => {
      if (anyModalOpen) onModalToggle(false);
    };
  }, [anyModalOpen, onModalToggle]);

  const listRequest = useRef(0);
  const loadBooks = useCallback(
    async () => {
      const request = ++listRequest.current;
      const list = await window.diandian.library.listBooks();
      if (request !== listRequest.current) return;
      setBooks(list);
      if (!list.some(book => book.id === activeBookId.current)) {
        setSelectedBookId(list[0]?.id ?? null);
      }
    },
    [setSelectedBookId],
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
    void loadBooks();
  }, [loadBooks, refreshSignal]);

  useEffect(() => {
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

  const openImport = () => {
    setImportError("");
    setImportModalOpen(true);
  };

  const handleImportFile = async () => {
    setImportError("");
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
      setImportError(formatUserError(error, "导入失败"));
    }
  };

  const handleImportTextSubmit = async () => {
    if (!importText.trim()) return;
    setImportError("");
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
      setImportError(formatUserError(error, "解析失败"));
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

  const searchMetadata = async (query: string) => {
    const q = query.trim();
    if (!q || !selectedBookId) return;
    const request = ++metaRequest.current;
    setMetaSearch({ status: "loading" });
    try {
      const result = await window.diandian.library.lookupMetadata(q, selectedBookId);
      if (request === metaRequest.current) setMetaSearch({ status: "done", result });
    } catch {
      if (request === metaRequest.current) setMetaSearch({ status: "error" });
    }
  };

  const handleOpenMetaLookup = () => {
    if (!selectedBook) return;
    const q = canonicalIsbn(selectedBook.isbn) || [selectedBook.title, selectedBook.author].filter(Boolean).join(" ");
    setMetaQuery(q);
    setMetaModalOpen(true);
    void searchMetadata(q);
  };

  const closeMetaLookup = () => {
    ++metaRequest.current;
    setMetaModalOpen(false);
  };

  const handleApplyMeta = async (index: number) => {
    if (!selectedBook || !metaResult?.lookupId || applyingEdition !== null) return;
    setApplyingEdition(index);
    try {
      const { coverUnavailable } = await window.diandian.library.applyMetadata(selectedBook.id, metaResult.lookupId, index);
      closeMetaLookup();
      await loadBooks();
      onNotify(coverUnavailable ? "已保存书籍资料。这个版本的封面暂时无法下载。" : "已补全书籍信息",
        coverUnavailable ? "info" : "success");
    } catch (error) {
      onNotify(formatUserError(error, "保存书籍信息失败"), "error");
    } finally {
      setApplyingEdition(null);
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
      `请围绕主题「${topicLabel}」，对我的阅读笔记里来自 ${groupedCollision.length} 本不同书籍的划线做一次深度「跨书观点碰撞分析」，严格遵守我的 STYLE.md 风格：\n1. 这些书之间有哪些**核心共识与互相印证**？\n2. 哪几本书的观点存在**明显分歧或适用边界张力**？\n3. 结合我写下的个人批注，提炼一个属于我自己的判断框架，并调用 draft_create_or_revise 存成一篇专题主题对照草稿（kind: "note"）。\n\n以下是命中的跨书划线：\n\n${snippet}`,
    );
  };

  return (
    <div className="chat-view">
      <header className="view-header">
        <div className="view-header-left">
          <h1 className="view-title">阅读笔记</h1>
          {viewMode === "shelf" && books.length > 0 ? (
            <ListPicker
              label="全部书目"
              icon={<IconBookOpen size={13} />}
              searchPlaceholder="按书名、作者或标签查找…"
              activeId={selectedBookId}
              onSelect={setSelectedBookId}
              items={books.map((book) => ({
                id: book.id,
                title: book.title,
                meta: [book.author || "作者待补全", `${book.highlightCount} 条笔记`].join(" · "),
                keywords: [book.isbn, ...book.tags].join(" "),
              }))}
            />
          ) : (
            <span className="badge">{books.length} 个书目</span>
          )}
        </div>
        <div className="view-header-right">
          <ActionMenu
            label="添加笔记"
            icon={<IconPlus size={13} />}
            ariaLabel="添加笔记"
            triggerClassName="btn sm primary"
            items={[
              { key: "weread", label: "同步微信读书划线", icon: <IconRefresh size={14} />, onSelect: () => void handleOpenWeReadSync() },
              {
                key: "capture",
                label: capturing ? "正在采集右侧页面…" : "采集右侧页面的划线",
                icon: <IconEye size={14} />,
                disabled: capturing,
                onSelect: () => void handleCaptureBrowser(),
              },
              { key: "import", label: "导入 Kindle / 文本笔记", icon: <IconUpload size={14} />, onSelect: openImport },
              { key: "new-book", label: "手动新建书目", icon: <IconPlus size={14} />, onSelect: () => setNewBookModalOpen(true) },
            ]}
          />
        </div>
      </header>

      <div className="library-subbar">
        <div className="section-tabs">
          <button
            type="button"
            className={`section-tab ${viewMode === "shelf" ? "active" : ""}`}
            onClick={() => setViewMode("shelf")}
          >
            按书查看划线
          </button>
          <button
            type="button"
            className={`section-tab ${viewMode === "collision" ? "active" : ""}`}
            onClick={() => setViewMode("collision")}
          >
            跨书观点碰撞
          </button>
        </div>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => setPosterModalOpen(true)}
          title="生成本月跨源阅读月报海报"
        >
          <IconCard size={13} />
          <span>阅读月报</span>
        </button>
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
              阅读笔记中没有匹配「{themeQuery || "全部"}」的划线。可以同步微信读书或导入 Kindle 笔记。
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
                <div className="muted-box" style={{ padding: "36px 20px" }}>
                  <div style={{ marginBottom: 8, color: "var(--ink)", fontWeight: 600 }}>阅读笔记里还没有书目</div>
                  <div style={{ marginBottom: 14 }}>
                    可以一键同步微信读书的整书划线与想法，或导入 Kindle{" "}
                    <span className="code-inline">My Clippings.txt</span>，也可以在右侧选中一段文字，点击「存入阅读笔记」。
                  </div>
                  <div style={{ display: "flex", justifyContent: "center", flexWrap: "wrap", gap: 8 }}>
                    <button type="button" className="btn sage" onClick={() => void handleOpenWeReadSync()}>
                      <IconRefresh size={14} />
                      一键同步微信读书书架笔记
                    </button>
                    <button type="button" className="btn primary" onClick={openImport}>
                      <IconUpload size={14} />
                      导入 Kindle / 文本笔记
                    </button>
                    <button type="button" className="btn" onClick={() => setNewBookModalOpen(true)}>
                      <IconPlus size={14} />
                      手动建档
                    </button>
                  </div>
                </div>
            ) : (
              <>
                {selectedBook && (
                  <>
                    <section className="surf-plain-section">
                    <div className="book-hero">
                      <div className="book-cover-box">
                        <LibraryBookCover key={selectedBook.updatedAt} bookId={selectedBook.id}
                          title={selectedBook.title} coverUrl={selectedBook.coverUrl} />
                      </div>
                      <div className="book-hero-info">
                        <h2 className="book-hero-title">{selectedBook.title}</h2>
                        <div className="book-hero-meta">
                          <span>{selectedBook.author || "作者待补全"}</span>
                          {selectedBook.publisher && <span>· {selectedBook.publisher}</span>}
                          {selectedBook.publishedYear && <span>· {selectedBook.publishedYear}</span>}
                          <span className="badge">{selectedBook.highlightCount} 条笔记</span>
                        </div>
                        {selectedBook.description && (
                          <div className="book-hero-description">
                            <p className={descriptionExpanded ? "" : "clamped"}>{selectedBook.description}</p>
                            {selectedBook.description.length > 90 && (
                              <button type="button" onClick={() => setDescriptionExpanded((v) => !v)}>
                                {descriptionExpanded ? "收起简介" : "展开简介"}
                              </button>
                            )}
                          </div>
                        )}
                        <div className="book-hero-actions">
                          <button
                            type="button"
                            className="btn sm primary"
                            onClick={() =>
                              onSendToChat(
                                `请读取阅读笔记中《${selectedBook.title}》（bookId: ${selectedBook.id}）的全部划线和我的想法，按照我的 STYLE.md 风格提炼 1 篇有个人立场的书评初稿，并存入创作工作台。`,
                              )
                            }
                          >
                            <IconSparkles size={12} />
                            <span>AI 基于划线起草</span>
                          </button>
                          <button
                            type="button"
                            className="btn sm"
                            onClick={() => setShowAddHighlight((v) => !v)}
                          >
                            <IconPlus size={12} />
                            <span>记一条划线</span>
                          </button>
                          <ObsidianExportAction key={selectedBook.id} kind="book" itemId={selectedBook.id} title={selectedBook.title} />
                          <ActionMenu
                            icon={<IconMoreHorizontal size={15} />}
                            ariaLabel={`《${selectedBook.title}》的更多操作`}
                            triggerClassName="btn sm ghost icon-only"
                            items={[
                              { key: "metadata", label: "补全书籍信息", icon: <IconWand size={14} />, onSelect: handleOpenMetaLookup },
                              {
                                key: "delete",
                                label: "删除这本书",
                                confirmLabel: selectedBook.highlightCount
                                  ? `确认删除，连同 ${selectedBook.highlightCount} 条笔记`
                                  : "确认删除这本书",
                                icon: <IconTrash size={14} />,
                                danger: true,
                                onSelect: () => void handleDeleteBook(),
                              },
                            ]}
                          />
                        </div>

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
                          保存划线
                        </button>
                      </div>
                    </section>
                  )}

                  <div className="highlight-list">
                    {highlights.length === 0 ? (
                      <div className="muted-box">这本书还没有划线。可以从右上角「添加笔记」同步微信读书或采集右侧页面，也可以点「记一条划线」手动记录。</div>
                    ) : (
                      highlights.map((h) => (
                        <article key={h.id} className="highlight-card">
                          <div className="highlight-chapter">
                            <span>{h.chapter || "未标注章节"}</span>
                            <span className="badge">{SOURCE_LABELS[h.source] ?? h.source}</span>
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
                                <button type="button" className="btn sm primary"
                                  disabled={h.isHighlighted === false && !editingNoteText.trim()}
                                  onClick={() => void handleSaveNote(h.id)}>
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
                            {h.cfi && (
                              <button type="button" className="btn sm ghost" onClick={() => onOpenOriginal(h.id)}>
                                <IconBookOpen size={12} />回到原文
                              </button>
                            )}
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
                                  `我在《${selectedBook.title}》里读到这句话：\n\n> ${h.quote}\n${h.note ? `\n我的想法：${h.note}\n` : ""}\n请帮我深度拆解并延伸讨论。`,
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
                              title={h.note ? "删除这条笔记及想法" : "删除划线"}
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
                          <LibraryBookCover title={b.title} coverUrl={b.coverUrl} />
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

            {importError && <div className="muted-box" role="alert">{importError}</div>}

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
        <div className="modal-backdrop" onClick={applyingEdition === null ? closeMetaLookup : undefined}>
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="meta-lookup-title"
            onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 id="meta-lookup-title">在线补全书籍信息</h3>
              <button type="button" className="btn icon-only ghost" aria-label="关闭" onClick={closeMetaLookup} disabled={applyingEdition !== null}>
                <IconClose size={16} />
              </button>
            </div>
            <div className="search-row" style={{ marginBottom: 12 }}>
              <input
                className="input"
                value={metaQuery}
                onChange={(e) => setMetaQuery(e.target.value)}
                placeholder="输入书名、作者或 ISBN…"
                aria-label="书名、作者或 ISBN"
                disabled={applyingEdition !== null}
                onKeyDown={(e) => {
                  // keyCode 229 covers IMEs that report the confirming Enter without isComposing.
                  if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229
                    && metaSearch.status !== "loading") {
                    void searchMetadata(metaQuery);
                  }
                }}
              />
              <button type="button" className="btn primary" onClick={() => void searchMetadata(metaQuery)}
                disabled={metaSearch.status === "loading" || applyingEdition !== null || !metaQuery.trim()}>
                {metaSearch.status === "loading" ? "查询中…" : "查询"}
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {metaSearch.status === "loading" && (
                <div className="muted-box" role="status">正在查询微信读书、Google Books 和 Open Library…</div>
              )}
              {metaSearch.status === "error" && (
                <div className="muted-box" role="alert">查询未完成，请重试。</div>
              )}
              {metaNotice && (
                <div className={metaResult?.candidates.length ? "metadata-source-notice" : "muted-box"} role="status">
                  {metaNotice}
                </div>
              )}
              {metaResult?.candidates.map((c, idx) => (
                  <div
                    key={`${c.source}-${idx}`}
                    className="editorial-card"
                    style={{ padding: 12, display: "flex", gap: 12, alignItems: "center" }}
                  >
                    <div className="book-cover-box" style={{ width: 42, height: 60, fontSize: 15 }}>
                      <LibraryBookCover title={c.title} coverUrl={c.coverUrl} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontFamily: "var(--font-serif)" }}>{c.title}</div>
                      <div style={{ fontSize: 12, color: "var(--ink-secondary)" }}>
                        {[c.author, c.publisher, c.publishedYear, c.isbn].filter(Boolean).join(" · ")}
                      </div>
                      <span className="badge" style={{ marginTop: 4 }}>{METADATA_SOURCES[c.source]}</span>
                    </div>
                    <button type="button" className="btn sm primary" onClick={() => void handleApplyMeta(idx)}
                      disabled={applyingEdition !== null}>
                      {applyingEdition === idx ? "保存中…" : "应用"}
                    </button>
                  </div>
                ))}
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
