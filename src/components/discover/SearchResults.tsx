import React from "react";
import type { ZlibBookItem } from "../../types/desktop";
import { IconArrowLeft, IconBookOpen, IconCheck, IconDownload, IconSparkles } from "../Icons";
import { BookCoverMedia } from "./BookCoverMedia";
import { cleanShortTitle, type DownloadedEntry } from "./discoverShared";

interface SearchResultsProps {
  query: string;
  searching: boolean;
  results: ZlibBookItem[];
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  downloadingRef: string | null;
  downloadedMap: Record<string, DownloadedEntry>;
  onReturnHome(): void;
  onOpenLogin(): void;
  onSyncLogin(): void;
  onSelect(book: ZlibBookItem): void;
  onOpenFolder(filePath?: string): void;
  onDownload(book: ZlibBookItem): void;
  onOpenDouban(book: ZlibBookItem): void;
  onSendToChat(prompt: string, autoSend?: boolean): void;
  onLoadMore(): void;
}

/** Z-Library search results with per-book download, Douban and AI actions. */
export const SearchResults: React.FC<SearchResultsProps> = ({
  query, searching, results, error, hasMore, loadingMore, downloadingRef, downloadedMap, onReturnHome, onOpenLogin,
  onSyncLogin, onSelect, onOpenFolder, onDownload, onOpenDouban, onSendToChat, onLoadMore,
}) => (
  <section className="discover-section">
    <div className="discover-results-header">
      <div className="discover-results-header-left">
        <button
          type="button"
          className="btn sm ghost"
          onClick={onReturnHome}
        >
          <IconArrowLeft size={13} />
          <span>返回为你推荐</span>
        </button>
        <span className="discover-results-summary">
          「{query}」{searching ? "检索中…" : `已加载 ${results.length} 本`}
        </span>
      </div>
    </div>

    {error && (
      <div className="discover-error-box">
        <div>{error}</div>
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <button
            type="button"
            className="btn sm soft"
            onClick={() => onOpenLogin()}
          >
            右侧打开登录
          </button>
          <button
            type="button"
            className="btn sm primary"
            onClick={() => onSyncLogin()}
          >
            同步登录态
          </button>
        </div>
      </div>
    )}

    {searching ? (
      <div className="discover-search-skeletons">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="discover-result-skeleton">
            <div className="discover-skeleton-thumb" />
            <div className="discover-skeleton-lines">
              <div className="discover-skeleton-bar w-60" />
              <div className="discover-skeleton-bar w-40" />
              <div className="discover-skeleton-bar w-28" />
            </div>
          </div>
        ))}
      </div>
    ) : results.length === 0 && !error ? (
      <div className="muted-box">
        未检索到与「{query}」匹配的电子书，试试更换关键词或切换为「全部格式」。
      </div>
    ) : (
      <>
        <div className="discover-search-list">
          {results.map((book, idx) => {
            const isDownloading = Boolean(book.bookRef && downloadingRef === book.bookRef);
            const downloaded = book.bookRef ? downloadedMap[book.bookRef] : undefined;
            return (
              <article
                key={`${book.bookRef || book.id || book.title}-${idx}`}
                className="discover-result-card"
                onClick={() => onSelect(book)}
              >
                <div className="discover-result-cover">
                  <BookCoverMedia book={book} size="thumb" />
                </div>
                <div className="discover-result-body">
                  <h3 className="discover-result-title">{book.title}</h3>
                  {book.author && (
                    <div className="discover-result-author">{book.author}</div>
                  )}
                  <div className="discover-result-meta">
                    {book.extension && (
                      <span className={`discover-fmt-badge fmt-${book.extension}`}>
                        {book.extension.toUpperCase()}
                      </span>
                    )}
                    {book.size && <span>{book.size}</span>}
                    {book.year && <span>{book.year}</span>}
                    {book.language && <span>{book.language}</span>}
                    {book.publisher && <span className="discover-meta-pub">{book.publisher}</span>}
                  </div>
                </div>
                <div
                  className="discover-result-actions"
                  onClick={(e) => e.stopPropagation()}
                >
                  {downloaded ? (
                    <button
                      type="button"
                      className="btn sm sage"
                      onClick={() => onOpenFolder(downloaded.filePath)}
                      title="点击在访达中显示"
                    >
                      <IconCheck size={12} />
                      <span>已下载</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn sm primary"
                      disabled={isDownloading}
                      onClick={() => onDownload(book)}
                    >
                      <IconDownload size={12} />
                      <span>{isDownloading ? "下载中…" : "下载"}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn sm discover-douban-btn"
                    onClick={() => onOpenDouban(book)}
                    title="在右侧浏览器查看豆瓣评分与书评"
                  >
                    <IconBookOpen size={12} />
                    <span>豆瓣</span>
                  </button>
                  <button
                    type="button"
                    className="btn sm ghost"
                    onClick={() => {
                      onSendToChat(
                        `我对《${cleanShortTitle(book.title)}》${book.author ? `（${book.author}）` : ""}很感兴趣，请结合我的阅读画像简介核心观点、最值得优先读的章节，以及值不值得读。`,
                        true,
                      );
                    }}
                    title="和 AI 聊聊这本书"
                  >
                    <IconSparkles size={12} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>

        {hasMore && (
          <div className="discover-load-more-row">
            <span className="discover-load-more-line" />
            <button
              type="button"
              className="discover-load-more-btn"
              disabled={loadingMore}
              onClick={onLoadMore}
            >
              {loadingMore ? "正在加载下一页…" : "加载更多 ↓"}
            </button>
            <span className="discover-load-more-line" />
          </div>
        )}
      </>
    )}
  </section>
);
