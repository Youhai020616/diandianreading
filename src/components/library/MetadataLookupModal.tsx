import React, { useEffect, useRef, useState } from "react";
import { canonicalIsbn } from "../../../electron/isbn";
import type { BookMetadataSource, BookRecord } from "../../types/desktop";
import { formatUserError } from "../../utils/formatError";
import { IconClose } from "../Icons";
import { LibraryBookCover } from "../LibraryBookCover";

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

interface MetadataLookupModalProps {
  book: BookRecord;
  onClose(): void;
  /** Called after an edition was saved; the cover may not have been downloadable. */
  onApplied(coverUnavailable: boolean): void;
  onError(message: string): void;
}

/** Search WeRead, Google Books and Open Library for editions of a book and apply one. */
export const MetadataLookupModal: React.FC<MetadataLookupModalProps> = ({ book, onClose: close, onApplied, onError }) => {
  const [query, setQuery] = useState(() => canonicalIsbn(book.isbn) || [book.title, book.author].filter(Boolean).join(" "));
  const [search, setSearch] = useState<
    { status: "loading" | "error" } | { status: "done"; result: MetadataResult }
  >({ status: "loading" });
  const [applyingEdition, setApplyingEdition] = useState<number | null>(null);
  const request = useRef(0);
  const result = search.status === "done" ? search.result : undefined;
  const notice = result && metadataSearchNotice(result);

  const runSearch = async (text: string) => {
    const q = text.trim();
    if (!q) return;
    const current = ++request.current;
    setSearch({ status: "loading" });
    try {
      const found = await window.diandian.library.lookupMetadata(q, book.id);
      if (current === request.current) setSearch({ status: "done", result: found });
    } catch {
      if (current === request.current) setSearch({ status: "error" });
    }
  };

  useEffect(() => {
    void runSearch(query);
    return () => { ++request.current; };
    // Search once for the initial query; later searches are user-triggered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onClose = () => {
    ++request.current;
    close();
  };

  const apply = async (index: number) => {
    if (!result?.lookupId || applyingEdition !== null) return;
    setApplyingEdition(index);
    try {
      const { coverUnavailable } = await window.diandian.library.applyMetadata(book.id, result.lookupId, index);
      onClose();
      onApplied(coverUnavailable);
    } catch (cause) {
      onError(formatUserError(cause, "保存书籍信息失败"));
    } finally {
      setApplyingEdition(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={applyingEdition === null ? onClose : undefined}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="meta-lookup-title"
        onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 id="meta-lookup-title">在线补全书籍信息</h3>
          <button type="button" className="btn icon-only ghost" aria-label="关闭" onClick={onClose} disabled={applyingEdition !== null}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="search-row" style={{ marginBottom: 12 }}>
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入书名、作者或 ISBN…"
            aria-label="书名、作者或 ISBN"
            disabled={applyingEdition !== null}
            onKeyDown={(e) => {
              // keyCode 229 covers IMEs that report the confirming Enter without isComposing.
              if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229
                && search.status !== "loading") {
                void runSearch(query);
              }
            }}
          />
          <button type="button" className="btn primary" onClick={() => void runSearch(query)}
            disabled={search.status === "loading" || applyingEdition !== null || !query.trim()}>
            {search.status === "loading" ? "查询中…" : "查询"}
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {search.status === "loading" && (
            <div className="muted-box" role="status">正在查询微信读书、Google Books 和 Open Library…</div>
          )}
          {search.status === "error" && (
            <div className="muted-box" role="alert">查询未完成，请重试。</div>
          )}
          {notice && (
            <div className={result?.candidates.length ? "metadata-source-notice" : "muted-box"} role="status">
              {notice}
            </div>
          )}
          {result?.candidates.map((c, idx) => (
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
                <button type="button" className="btn sm primary" onClick={() => void apply(idx)}
                  disabled={applyingEdition !== null}>
                  {applyingEdition === idx ? "保存中…" : "应用"}
                </button>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
};
