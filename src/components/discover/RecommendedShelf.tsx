import React from "react";
import type { ZlibBookItem } from "../../types/desktop";
import { IconCheck, IconDownload, IconRefresh } from "../Icons";
import { BookCoverMedia } from "./BookCoverMedia";
import { INITIAL_FEED_COUNT, type DownloadedEntry, type FeedTab } from "./discoverShared";

interface RecommendedShelfProps {
  title: { zh: string; en: string };
  tab: FeedTab;
  books: ZlibBookItem[];
  loading: boolean;
  error: string | null;
  loadingMore: boolean;
  canLoadMore: boolean;
  expanded: boolean;
  downloadingRef: string | null;
  downloadedMap: Record<string, DownloadedEntry>;
  onSwitchTab(tab: FeedTab): void;
  onRefresh(): void;
  onSyncLogin(): void;
  onSelect(book: ZlibBookItem): void;
  onOpenFolder(filePath?: string): void;
  onDownload(book: ZlibBookItem): void;
  onLoadMore(): void;
  onCollapse(): void;
}

/** Cover wall of recommended, popular or favorite books with one-click download. */
export const RecommendedShelf: React.FC<RecommendedShelfProps> = ({
  title, tab, books, loading, error, loadingMore, canLoadMore, expanded, downloadingRef, downloadedMap, onSwitchTab,
  onRefresh, onSyncLogin, onSelect, onOpenFolder, onDownload, onLoadMore, onCollapse,
}) => (
  <section className="discover-section">
    <div className="discover-feed-header">
      <div className="discover-feed-title-group">
        <h2 className="discover-feed-title">{title.zh}</h2>
        <span className="discover-feed-en">{title.en}</span>
      </div>

      <div className="discover-feed-controls">
        <div className="discover-feed-tabs" role="tablist" aria-label="书单分类">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "recommended"}
            className={`discover-feed-tab ${tab === "recommended" ? "active" : ""}`}
            onClick={() => onSwitchTab("recommended")}
          >
            为你推荐
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "popular"}
            className={`discover-feed-tab ${tab === "popular" ? "active" : ""}`}
            onClick={() => onSwitchTab("popular")}
          >
            全站热门
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "favorites"}
            className={`discover-feed-tab ${tab === "favorites" ? "active" : ""}`}
            onClick={() => onSwitchTab("favorites")}
          >
            我的收藏
          </button>
        </div>

        <button
          type="button"
          className="btn icon-only ghost"
          style={{ width: 26, height: 26 }}
          disabled={loading}
          onClick={() => onRefresh()}
          title="刷新推荐书单"
        >
          <IconRefresh size={13} className={loading ? "spin-icon" : undefined} />
        </button>
      </div>
    </div>

    {error && (
      <div className="discover-error-box">
        <div>{error}</div>
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <button
            type="button"
            className="btn sm soft"
            onClick={() => onRefresh()}
          >
            重试加载
          </button>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => onSyncLogin()}
          >
            重新同步右侧登录态
          </button>
        </div>
      </div>
    )}

    {loading && books.length === 0 ? (
      <div className="discover-cover-shelf">
        <div className="discover-cover-grid">
          {Array.from({ length: INITIAL_FEED_COUNT }).map((_, i) => (
            <div key={i} className="discover-cover-skeleton" />
          ))}
        </div>
      </div>
    ) : books.length === 0 && !error ? (
      <div className="muted-box">
        {tab === "favorites"
          ? "你的 Z-Library 收藏夹目前为空，去搜几本喜欢的书吧。"
          : "暂时没有推荐书目，可以直接在上方搜索框输入书名或作者检索。"}
      </div>
    ) : (
      <>
        <div className="discover-cover-shelf">
          <div className="discover-cover-grid">
            {books.map((book, idx) => {
              const isDownloading = Boolean(book.bookRef && downloadingRef === book.bookRef);
              const isDone = Boolean(book.bookRef && downloadedMap[book.bookRef]);
              return (
                <div
                  key={`${book.bookRef || book.id || book.title}-${idx}`}
                  className={`discover-book-tile ${isDone ? "is-downloaded" : ""}`}
                  role="button"
                  tabIndex={0}
                  title={`${book.title}${book.author ? ` — ${book.author}` : ""}`}
                  onClick={() => onSelect(book)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(book);
                    }
                  }}
                >
                  <div className="discover-book-cover-frame">
                    <BookCoverMedia book={book} size="tile" />

                    {book.extension && (
                      <span className="discover-tile-ext">{book.extension.toUpperCase()}</span>
                    )}

                    {/* Quick 1-click download button on hover */}
                    <button
                      type="button"
                      className={`discover-tile-dl-btn ${isDone ? "done" : ""} ${isDownloading ? "busy" : ""}`}
                      disabled={isDownloading}
                      title={isDone ? "已下载到 Downloads/diandianreading" : "一键下载本书"}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isDone && book.bookRef) {
                          onOpenFolder(downloadedMap[book.bookRef]?.filePath);
                        } else {
                          onDownload(book);
                        }
                      }}
                    >
                      {isDone ? (
                        <IconCheck size={12} />
                      ) : isDownloading ? (
                        <IconRefresh size={12} className="spin-icon" />
                      ) : (
                        <IconDownload size={12} />
                      )}
                    </button>

                    {/* Floating frosted title caption on hover (Z-Library hover feel) */}
                    <div className="discover-tile-caption">
                      <div className="discover-tile-title">{book.title}</div>
                      {book.author && (
                        <div className="discover-tile-author">{book.author}</div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {(canLoadMore || expanded) && (
          <div className="discover-load-more-row">
            <span className="discover-load-more-line" />
            <div className="discover-load-more-actions">
              {canLoadMore && (
                <button
                  type="button"
                  className="discover-load-more-btn"
                  disabled={loadingMore}
                  onClick={() => onLoadMore()}
                >
                  {loadingMore
                    ? "正在加载更多…"
                    : expanded
                      ? "加载更多 ↓"
                      : "展开更多推荐 ↓"}
                </button>
              )}
              {expanded && (
                <button
                  type="button"
                  className="discover-load-more-btn subtle"
                  onClick={onCollapse}
                >
                  收起 ↑
                </button>
              )}
            </div>
            <span className="discover-load-more-line" />
          </div>
        )}
      </>
    )}
  </section>
);
