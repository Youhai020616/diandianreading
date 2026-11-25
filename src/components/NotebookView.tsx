import React, { useMemo, useState } from "react";
import type {
  BookRecord,
  BrowserTabSummary,
  DraftRecord,
  NotebookItemKind,
  NotebookRecord,
} from "../types/desktop";
import {
  IconBookOpen,
  IconClose,
  IconFileText,
  IconGlobe,
  IconPenLine,
  IconPlus,
  IconSparkles,
  IconTrash,
} from "./Icons";

interface NotebookViewProps {
  notebook: NotebookRecord;
  books: BookRecord[];
  drafts: DraftRecord[];
  activeBrowserTab: BrowserTabSummary | null;
  onAddItem: (
    notebookId: string,
    item: { itemKind: NotebookItemKind; itemRef: string; title: string; meta?: string },
  ) => Promise<void>;
  onRemoveItem: (notebookId: string, itemId: string) => Promise<void>;
  onDeleteNotebook: (notebookId: string) => Promise<void>;
  onOpenBook: (bookId: string) => void;
  onOpenDraft: (draftId: string) => void;
  onOpenWebUrl: (url: string) => void;
  onAskNotebook: (notebook: NotebookRecord) => void;
}

export const NotebookView: React.FC<NotebookViewProps> = ({
  notebook,
  books,
  drafts,
  activeBrowserTab,
  onAddItem,
  onRemoveItem,
  onDeleteNotebook,
  onOpenBook,
  onOpenDraft,
  onOpenWebUrl,
  onAskNotebook,
}) => {
  const [pickerMode, setPickerMode] = useState<"book" | "draft" | null>(null);

  const bookItems = useMemo(() => notebook.items.filter((i) => i.itemKind === "book"), [notebook.items]);
  const draftItems = useMemo(() => notebook.items.filter((i) => i.itemKind === "draft"), [notebook.items]);
  const webItems = useMemo(() => notebook.items.filter((i) => i.itemKind === "web"), [notebook.items]);

  const linkedBookIds = new Set(bookItems.map((i) => i.itemRef));
  const linkedDraftIds = new Set(draftItems.map((i) => i.itemRef));

  const availableBooks = books.filter((b) => !linkedBookIds.has(b.id));
  const availableDrafts = drafts.filter((d) => !linkedDraftIds.has(d.id));

  const canPinWeb = Boolean(activeBrowserTab?.url && /^https?:\/\//i.test(activeBrowserTab.url));

  return (
    <div className="chat-view">
      <header className="view-header">
        <div className="view-header-left">
          <span className="nb-header-icon">{notebook.icon || "✦"}</span>
          <h1 className="view-title">{notebook.name}</h1>
          <span className="badge">{notebook.items.length} 项素材</span>
        </div>
        <div className="view-header-right">
          <button
            type="button"
            className="btn sm primary"
            onClick={() => onAskNotebook(notebook)}
            title="将此主题空间里的全部书目、草稿与网页打包交给问点点分析"
          >
            <IconSparkles size={13} />
            <span>以此主题问点点</span>
          </button>
          <button
            type="button"
            className="btn icon-only ghost"
            onClick={() => void onDeleteNotebook(notebook.id)}
            title="删除该主题空间（不会删除书库和草稿本身）"
          >
            <IconTrash size={14} />
          </button>
        </div>
      </header>

      <div className="studio-scroll">
        <div className="surf-doc-container nb-container">
          <div className="nb-toolbar">
            <button
              type="button"
              className={`btn sm ${pickerMode === "book" ? "soft" : "ghost"}`}
              onClick={() => setPickerMode((m) => (m === "book" ? null : "book"))}
            >
              <IconBookOpen size={13} />
              <span>+ 关联书目</span>
            </button>
            <button
              type="button"
              className={`btn sm ${pickerMode === "draft" ? "soft" : "ghost"}`}
              onClick={() => setPickerMode((m) => (m === "draft" ? null : "draft"))}
            >
              <IconPenLine size={13} />
              <span>+ 关联草稿</span>
            </button>
            {canPinWeb && activeBrowserTab && (
              <button
                type="button"
                className="btn sm ghost"
                onClick={() =>
                  void onAddItem(notebook.id, {
                    itemKind: "web",
                    itemRef: activeBrowserTab.url,
                    title: activeBrowserTab.title || activeBrowserTab.url,
                    meta: activeBrowserTab.url,
                  })
                }
              >
                <IconGlobe size={13} />
                <span>+ 收录当前右侧网页</span>
              </button>
            )}
          </div>

          {pickerMode === "book" && (
            <div className="nb-picker-card">
              <div className="nb-picker-head">
                <span>选择要加入此主题的本地书目</span>
                <button type="button" className="btn icon-only ghost" onClick={() => setPickerMode(null)}>
                  <IconClose size={13} />
                </button>
              </div>
              {availableBooks.length === 0 ? (
                <div className="nb-picker-empty">书库里的书目都已收录或暂为空。</div>
              ) : (
                <div className="nb-picker-list">
                  {availableBooks.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      className="nb-picker-item"
                      onClick={() =>
                        void onAddItem(notebook.id, {
                          itemKind: "book",
                          itemRef: b.id,
                          title: b.title,
                          meta: `${b.author ? `${b.author} · ` : ""}${b.highlightCount} 条划线`,
                        })
                      }
                    >
                      <IconBookOpen size={13} />
                      <span className="nb-picker-title">《{b.title}》</span>
                      <span className="nb-picker-meta">{b.highlightCount} 条划线</span>
                      <IconPlus size={12} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {pickerMode === "draft" && (
            <div className="nb-picker-card">
              <div className="nb-picker-head">
                <span>选择要加入此主题的创作草稿</span>
                <button type="button" className="btn icon-only ghost" onClick={() => setPickerMode(null)}>
                  <IconClose size={13} />
                </button>
              </div>
              {availableDrafts.length === 0 ? (
                <div className="nb-picker-empty">草稿箱里的文章都已收录或暂为空。</div>
              ) : (
                <div className="nb-picker-list">
                  {availableDrafts.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      className="nb-picker-item"
                      onClick={() =>
                        void onAddItem(notebook.id, {
                          itemKind: "draft",
                          itemRef: d.id,
                          title: d.title,
                          meta: `v${d.latestRevisionNo}`,
                        })
                      }
                    >
                      <IconFileText size={13} />
                      <span className="nb-picker-title">{d.title}</span>
                      <span className="nb-picker-meta">v{d.latestRevisionNo}</span>
                      <IconPlus size={12} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {notebook.items.length === 0 ? (
            <div className="muted-box" style={{ padding: "36px 20px" }}>
              <div style={{ fontWeight: 600, color: "var(--ink)", marginBottom: 6 }}>
                把同一主题的书、草稿与网页收纳在一起
              </div>
              <div>
                点击上方按钮把多本书目、正在写的文章或豆瓣/公众号参考页加入「{notebook.name}」，打开右侧「问点点」时就会自动把整个主题空间打包作为跨书上下文。
              </div>
            </div>
          ) : (
            <div className="nb-sections">
              {bookItems.length > 0 && (
                <section className="nb-section">
                  <div className="nb-section-label">
                    <IconBookOpen size={12} />
                    <span>关联书目 ({bookItems.length})</span>
                  </div>
                  <div className="nb-grid">
                    {bookItems.map((item) => (
                      <div key={item.id} className="nb-item-card" onClick={() => onOpenBook(item.itemRef)}>
                        <div className="nb-item-icon book">
                          <IconBookOpen size={14} />
                        </div>
                        <div className="nb-item-text">
                          <div className="nb-item-title">《{item.title}》</div>
                          {item.meta && <div className="nb-item-meta">{item.meta}</div>}
                        </div>
                        <button
                          type="button"
                          className="nb-item-remove"
                          onClick={(e) => {
                            e.stopPropagation();
                            void onRemoveItem(notebook.id, item.id);
                          }}
                          title="移出主题空间"
                        >
                          <IconClose size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {draftItems.length > 0 && (
                <section className="nb-section">
                  <div className="nb-section-label">
                    <IconPenLine size={12} />
                    <span>主题草稿 ({draftItems.length})</span>
                  </div>
                  <div className="nb-grid">
                    {draftItems.map((item) => (
                      <div key={item.id} className="nb-item-card" onClick={() => onOpenDraft(item.itemRef)}>
                        <div className="nb-item-icon draft">
                          <IconFileText size={14} />
                        </div>
                        <div className="nb-item-text">
                          <div className="nb-item-title">{item.title}</div>
                          {item.meta && <div className="nb-item-meta">{item.meta}</div>}
                        </div>
                        <button
                          type="button"
                          className="nb-item-remove"
                          onClick={(e) => {
                            e.stopPropagation();
                            void onRemoveItem(notebook.id, item.id);
                          }}
                          title="移出主题空间"
                        >
                          <IconClose size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {webItems.length > 0 && (
                <section className="nb-section">
                  <div className="nb-section-label">
                    <IconGlobe size={12} />
                    <span>收录网页与参考页 ({webItems.length})</span>
                  </div>
                  <div className="nb-grid">
                    {webItems.map((item) => (
                      <div key={item.id} className="nb-item-card" onClick={() => onOpenWebUrl(item.itemRef)}>
                        <div className="nb-item-icon web">
                          <IconGlobe size={14} />
                        </div>
                        <div className="nb-item-text">
                          <div className="nb-item-title">{item.title}</div>
                          <div className="nb-item-meta">{item.meta || item.itemRef}</div>
                        </div>
                        <button
                          type="button"
                          className="nb-item-remove"
                          onClick={(e) => {
                            e.stopPropagation();
                            void onRemoveItem(notebook.id, item.id);
                          }}
                          title="移出主题空间"
                        >
                          <IconClose size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
