import React from "react";
import { supportsWeReadImport } from "../../../electron/router/wereadFormats";
import type { ConnectionsSnapshot, ZlibBookItem } from "../../types/desktop";
import {
  IconBookOpen, IconCheck, IconClose, IconDownload, IconExternalLink, IconFolder, IconSearch, IconSparkles, IconUpload, IconWand,
} from "../Icons";
import { BookCoverMedia } from "./BookCoverMedia";
import { cleanShortTitle, type DownloadedEntry } from "./discoverShared";

interface BookDetailSheetProps {
  book: ZlibBookItem;
  /** Set once this book has been downloaded in the current session. */
  downloaded?: DownloadedEntry;
  connections: ConnectionsSnapshot | null;
  downloading: boolean;
  /** "<bookRef>:<action>" of the transfer in progress, if any. */
  dispatchBusy: string | null;
  onClose(): void;
  onOpenFolder(filePath?: string): void;
  onRepairMeta(entry: DownloadedEntry): void;
  onOpenWeReadShelf(title?: string): void;
  onDispatch(entry: DownloadedEntry, target: "weread" | "kindle"): void;
  onDownload(book: ZlibBookItem): void;
  onOpenDouban(book: ZlibBookItem): void;
  onSearchMore(title: string): void;
  onSendToChat(prompt: string, autoSend?: boolean): void;
  onOpenBrowserUrl(url: string, newTab?: boolean): void;
}

/** Details of one search or recommendation result, with download and hand-off actions. */
export const BookDetailSheet: React.FC<BookDetailSheetProps> = ({
  book, downloaded: entry, connections, downloading, dispatchBusy, onClose, onOpenFolder, onRepairMeta, onOpenWeReadShelf,
  onDispatch, onDownload, onOpenDouban, onSearchMore, onSendToChat, onOpenBrowserUrl,
}) => (
    <div
      className="discover-drawer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={book.title}
      onClick={() => onClose()}
    >
      <div className="discover-drawer-card" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="discover-drawer-close"
          onClick={() => onClose()}
          title="关闭（Esc）"
        >
          <IconClose size={14} />
        </button>

        <div className="discover-drawer-top">
          <div className="discover-drawer-cover">
            <BookCoverMedia book={book} size="detail" />
          </div>

          <div className="discover-drawer-info">
            <h2 className="discover-drawer-title">{book.title}</h2>
            {book.author && (
              <div className="discover-drawer-author">{book.author}</div>
            )}

            <div className="discover-drawer-badges">
              {book.extension && (
                <span className={`discover-fmt-badge fmt-${book.extension}`}>
                  {book.extension.toUpperCase()}
                </span>
              )}
              {book.size && <span className="badge">{book.size}</span>}
              {book.year && <span className="badge">{book.year}</span>}
              {book.language && <span className="badge">{book.language}</span>}
              {book.rating && <span className="badge sage">★ {book.rating}</span>}
            </div>

            {(book.publisher || book.isbn) && (
              <div className="discover-drawer-meta-lines">
                {book.publisher && <div>出版社：{book.publisher}</div>}
                {book.isbn && <div>ISBN：{book.isbn}</div>}
              </div>
            )}
          </div>
        </div>

        {book.description && (
          <p className="discover-drawer-desc">{book.description}</p>
        )}

        <div className="discover-drawer-actions">
          {entry ? (
            <>
              <button
                type="button"
                className="btn sage"
                onClick={() =>
                  onOpenFolder(entry?.filePath)
                }
              >
                <IconFolder size={14} />
                <span>已下载 · 在访达中显示</span>
              </button>
              {entry?.filePath && connections?.status.supportsMeta && (
                <button
                  type="button"
                  className="btn soft"
                  disabled={dispatchBusy !== null || Boolean(entry?.metaFixed)}
                  onClick={() => onRepairMeta(entry!)}
                >
                  {entry?.metaFixed ? (
                    <IconCheck size={14} />
                  ) : (
                    <IconWand size={14} />
                  )}
                  <span>
                    {dispatchBusy === `${book.bookRef}:meta`
                      ? "正在补全书目信息…"
                      : entry?.metaFixed
                        ? "已补全书目信息"
                        : "补全书目信息"}
                  </span>
                </button>
              )}
              {entry?.filePath && supportsWeReadImport(entry.filePath.split(".").pop() ?? "") && (
                entry?.wereadUploaded ? (
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => onOpenWeReadShelf(book.title)}
                  >
                    <IconBookOpen size={14} />
                    <span>已传微信读书 · 去书架开读</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn soft"
                    disabled={dispatchBusy !== null}
                    onClick={() =>
                      onDispatch(entry!, "weread")
                    }
                    title={
                      connections?.weread.loggedIn
                        ? "一键导入微信读书书架"
                        : "点击导入微信读书书架（首次将弹出二维码开通传书通道，扫完自动续传）"
                    }
                  >
                    <IconUpload size={14} />
                    <span>
                      {dispatchBusy === `${book.bookRef}:weread`
                        ? "正在上传到微信读书…"
                        : "导入微信读书"}
                    </span>
                  </button>
                )
              )}
              {entry?.filePath && connections?.kindle.configured && (
                <button
                  type="button"
                  className="btn soft"
                  disabled={dispatchBusy !== null}
                  onClick={() =>
                    onDispatch(entry!, "kindle")
                  }
                >
                  <IconUpload size={14} />
                  <span>推送到 Kindle</span>
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              className="btn primary"
              disabled={Boolean(downloading)}
              onClick={() => onDownload(book)}
            >
              <IconDownload size={14} />
              <span>
                {downloading
                  ? "正在下载到 Downloads/diandianreading…"
                  : "下载到 Downloads/diandianreading"}
              </span>
            </button>
          )}

          <button
            type="button"
            className="btn discover-douban-btn"
            onClick={() => onOpenDouban(book)}
          >
            <IconBookOpen size={14} />
            <span>右侧看豆瓣评分与书评</span>
          </button>

          <button
            type="button"
            className="btn soft"
            onClick={() => onSearchMore(cleanShortTitle(book.title))}
          >
            <IconSearch size={14} />
            <span>搜更多版本 (EPUB/PDF)</span>
          </button>

          <button
            type="button"
            className="btn"
            onClick={() => {
              const title = cleanShortTitle(book.title);
              onClose();
              // Prefill the composer; the user reviews or edits the question and sends it.
              onSendToChat(
                `我对《${title}》${book.author ? `（${book.author}）` : ""}很感兴趣，请结合我的阅读画像为我拆解它的核心观点、推荐阅读路径，以及它和我已读过的书有什么关联。`,
              );
            }}
          >
            <IconSparkles size={14} />
            <span>和 AI 聊这本书</span>
          </button>

          {book.url && (
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                onOpenBrowserUrl(book.url!, false);
                onClose();
              }}
            >
              <IconExternalLink size={14} />
              <span>右侧打开详情页</span>
            </button>
          )}
        </div>
      </div>
    </div>
);
