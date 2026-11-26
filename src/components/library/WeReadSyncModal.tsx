import React, { useEffect, useState } from "react";
import type { WeReadNotebookBook } from "../../types/desktop";
import { IconCheck, IconClose } from "../Icons";
import { LibraryBookCover } from "../LibraryBookCover";

interface WeReadSyncModalProps {
  onClose(): void;
  /** Called after a successful sync with the first synced book and a summary for the toast. */
  onSynced(firstBookId: string | undefined, summary: string): void;
}

/** Pick WeRead books that have highlights and pull their highlights and notes into the library. */
export const WeReadSyncModal: React.FC<WeReadSyncModalProps> = ({ onClose, onSynced }) => {
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [books, setBooks] = useState<WeReadNotebookBook[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void window.diandian.library.listWeReadNotebooks().then((list) => {
      if (!active) return;
      setBooks(list);
      setSelectedIds(list.slice(0, 10).map((b) => b.bookId));
    }).catch((cause: unknown) => {
      if (!active) return;
      setBooks([]);
      setError(cause instanceof Error ? cause.message : "读取微信读书笔记书单失败");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const syncSelected = async () => {
    const chosen = books.filter((b) => selectedIds.includes(b.bookId));
    if (chosen.length === 0) return;
    setSyncing(true);
    setError("");
    try {
      const res = await window.diandian.library.syncWeReadBooks(chosen);
      onSynced(
        res.details[0]?.localBookId,
        `微信读书同步完成：共 ${res.booksSynced} 本书，新增 ${res.importedCount} 条划线/想法，自动去重 ${res.deduplicatedCount} 条`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "同步微信读书失败");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => onClose()}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ width: 560 }}>
        <div className="modal-header">
          <h3>一键同步微信读书整书划线与想法</h3>
          <button type="button" className="btn icon-only ghost" onClick={() => onClose()}>
            <IconClose size={16} />
          </button>
        </div>

        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--ink-secondary)", lineHeight: 1.55 }}>
          直接复用你右侧内置浏览器的微信读书登录态，批量拉取整本书的章节划线与个人想法（自动 SHA-256 指纹去重，后续增量更新不重复）。
        </p>

        {loading ? (
          <div className="muted-box">正在读取你的微信读书笔记书单…</div>
        ) : error ? (
          <div style={{ padding: "12px 14px", borderRadius: 10, background: "var(--danger-soft)", color: "var(--danger)", fontSize: 12.5, lineHeight: 1.6 }}>
            {error}
          </div>
        ) : books.length === 0 ? (
          <div className="muted-box">你的微信读书账号下暂无带划线或想法的书目。</div>
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>
                共检测到 {books.length} 本带笔记书籍，已选 {selectedIds.length} 本
              </span>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => setSelectedIds(books.map((b) => b.bookId))}
                >
                  全选
                </button>
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => setSelectedIds([])}
                >
                  清空
                </button>
              </div>
            </div>

            <div className="cookie-domain-list" style={{ maxHeight: 320 }}>
              {books.map((b) => {
                const checked = selectedIds.includes(b.bookId);
                return (
                  <label key={b.bookId} className={`cookie-domain-row ${checked ? "selected" : ""}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setSelectedIds((prev) =>
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
          <button type="button" className="btn" onClick={() => onClose()}>
            关闭
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={syncing || selectedIds.length === 0}
            onClick={() => void syncSelected()}
          >
            <IconCheck size={14} />
            <span>{syncing ? "正在拉取入库…" : `同步选中的 ${selectedIds.length} 本书`}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
