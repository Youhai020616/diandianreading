import type { ReactElement } from "react";
import { bookOptionText } from "../lib/labels";
import { READY_BOOK_STATUSES } from "../lib/normalize";
import type { AppController } from "../state/controller";
import type { AppState } from "../state/store";
import { MessageLog } from "./MessageLog";

interface ChatPanelProps {
  state: AppState;
  controller: AppController;
}

export function ChatPanel({ state, controller }: ChatPanelProps): ReactElement {
  const { panelMode, chatOpen } = state;
  const desktop = panelMode === "desktop";
  const drawer = panelMode === "drawer";

  const role = panelMode === null ? undefined : desktop ? undefined : drawer ? "dialog" : "region";
  const ariaModal = drawer ? true : undefined;
  const ariaHidden = panelMode === null || desktop ? undefined : !chatOpen;

  return (
    <aside
      className="chat-panel"
      id="chat-panel"
      data-open={String(chatOpen)}
      aria-labelledby="chat-title"
      tabIndex={-1}
      role={role}
      aria-modal={ariaModal}
      aria-hidden={ariaHidden}
      ref={(node) => controller.registerRef("chatPanel", node)}
      onKeyDown={(event) => controller.handleChatPanelKeydown(event)}
    >
      <header className="chat-header">
        <div>
          <p className="card-kicker">BOOK-GROUNDED CONVERSATION</p>
          <h1 id="chat-title">
            AI Chat <span>/ 阅读对话</span>
          </h1>
        </div>
        <button
          className="icon-button"
          id="close-chat-button"
          type="button"
          aria-label="关闭 AI 对话 / Close AI chat"
          ref={(node) => controller.registerRef("closeChatButton", node)}
          onClick={() => controller.closeChat()}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <section className="chat-book-picker" aria-labelledby="book-picker-title">
        <label id="book-picker-title" htmlFor="chat-book-select">
          Book / 选择书籍
        </label>
        <div className="book-picker-row">
          <select
            id="chat-book-select"
            disabled={state.bookSelectDisabled}
            value={state.selectedBookId ?? ""}
            onChange={(event) => controller.onBookSelectionChange(event.target.value)}
            ref={(node) => controller.registerRef("chatBookSelect", node)}
          >
            {!state.booksRendered ? (
              <option value="">正在加载书籍 / Loading books</option>
            ) : state.books.length === 0 ? (
              <option value="">No books available / 暂无书籍</option>
            ) : (
              <>
                <option value="">Select a ready book / 选择已就绪书籍</option>
                {state.books.map((book) => (
                  <option
                    value={book.id}
                    key={book.id}
                    disabled={!READY_BOOK_STATUSES.has(book.status)}
                  >
                    {bookOptionText(book)}
                  </option>
                ))}
              </>
            )}
          </select>
          <button
            className="button button-lavender"
            id="load-conversation-button"
            type="button"
            disabled={state.loadConversationDisabled}
            onClick={() => void controller.openConversation()}
          >
            Open / 打开
          </button>
        </div>
        <p id="book-picker-help">{state.bookPickerHelp}</p>
      </section>

      <div
        className="chat-state"
        id="chat-state"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-state={state.chatState.state || undefined}
      >
        {state.chatState.text}
      </div>

      <MessageLog
        messages={state.messages}
        referencesByMessageId={state.referencesByMessageId}
      />

      <div className="run-actions" id="run-actions" hidden={!state.showRetryChat && !state.showCancelChat}>
        <button
          className="button button-secondary"
          id="retry-chat-button"
          type="button"
          hidden={!state.showRetryChat}
          disabled={state.retryChatDisabled}
          onClick={() => void controller.retryChatRun()}
        >
          Retry / 重试回答
        </button>
        <button
          className="button button-quiet"
          id="cancel-chat-button"
          type="button"
          hidden={!state.showCancelChat}
          disabled={state.cancelChatDisabled}
          onClick={() => void controller.cancelChatRun()}
        >
          Cancel / 请求取消
        </button>
      </div>

      <form
        className="chat-composer"
        id="chat-form"
        ref={(node) => controller.registerRef("chatForm", node)}
        onSubmit={(event) => {
          event.preventDefault();
          void controller.submitQuestion();
        }}
      >
        <label htmlFor="chat-question">Question / 问题</label>
        <textarea
          id="chat-question"
          name="question"
          rows={3}
          maxLength={8000}
          required
          disabled={state.questionDisabled}
          placeholder={state.questionPlaceholder}
          value={state.questionValue}
          onChange={(event) => controller.setQuestionValue(event.target.value)}
          onKeyDown={(event) =>
            controller.handleQuestionKeydown({
              key: event.key,
              shiftKey: event.shiftKey,
              isComposing: event.nativeEvent.isComposing,
              keyCode: event.keyCode,
              preventDefault: () => event.preventDefault(),
            })
          }
          onCompositionStart={() => controller.setComposing(true)}
          onCompositionEnd={() => controller.setComposing(false)}
          ref={(node) => controller.registerRef("chatQuestion", node)}
        />
        <div className="composer-footer">
          <p>Enter 发送 · Shift+Enter 换行</p>
          <button
            className="button button-primary"
            id="send-chat-button"
            type="submit"
            disabled={state.sendDisabled}
          >
            Send / 发送
          </button>
        </div>
      </form>
    </aside>
  );
}
