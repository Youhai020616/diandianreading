import type { ReactElement } from "react";
import { READY_BOOK_STATUSES } from "../../lib/normalize";
import type { BookSnapshot } from "../../lib/types";
import type { AppController } from "../../state/controller";
import type { ReaderController } from "../../state/readerController";
import type { AppState } from "../../state/store";

interface LibraryViewProps {
  state: AppState;
  controller: AppController;
  reader: ReaderController;
}

const STATUS_LABELS: Record<string, string> = {
  ready: "Ready / 可阅读",
  reading: "Reading / 阅读中",
  completed: "Completed / 已读完",
  pending: "Processing / 处理中",
  processing: "Processing / 处理中",
  failed: "Failed / 失败",
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? "Not ready / 未就绪";
}

export function LibraryView({ state, controller, reader }: LibraryViewProps): ReactElement {
  const openBook = (book: BookSnapshot): void => {
    reader.openBook(book);
    controller.setView("reader", true);
  };

  return (
    <section
      className="view"
      id="view-library"
      data-view-panel="library"
      aria-labelledby="library-title"
      hidden={state.currentView !== "library"}
    >
      <div className="view-heading">
        <div>
          <p className="eyebrow">LOCAL LIBRARY</p>
          <h1 id="library-title">
            Library <span>/ 书库</span>
          </h1>
          <p>已导入书籍的持久快照。就绪的书可直接进入阅读器,阅读进度与标注保存在本地。</p>
        </div>
        <button
          className="button button-secondary"
          id="refresh-library-button"
          type="button"
          onClick={() => void controller.refreshBooks()}
        >
          Refresh / 刷新书库
        </button>
      </div>

      {state.books.length === 0 ? (
        <div className="empty-state">
          <span aria-hidden="true">⇡</span>
          <h2>No books yet / 暂无书籍</h2>
          <p>先在 Import / 导入 页面导入书籍,处理完成后即可在这里开始阅读。</p>
        </div>
      ) : (
        <ul className="library-grid" id="library-grid">
          {state.books.map((book) => {
            const readable = READY_BOOK_STATUSES.has(book.status);
            return (
              <li className="library-card" key={book.id}>
                <div className="library-card-body">
                  <h2 className="library-card-title">{book.title}</h2>
                  {book.author ? <p className="library-card-author">{book.author}</p> : null}
                  <span className="status-badge" data-state={readable ? "completed" : book.status}>
                    {statusLabel(book.status)}
                  </span>
                </div>
                <button
                  className="button button-primary"
                  type="button"
                  data-open-book={book.id}
                  disabled={!readable}
                  aria-label={`Open / 打开阅读:${book.title}`}
                  onClick={() => openBook(book)}
                >
                  {readable ? "Read / 阅读" : "Not ready / 未就绪"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
