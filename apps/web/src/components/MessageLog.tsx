import { Component, useRef, useState, type ReactElement } from "react";
import { formatTime } from "../lib/labels";
import type { ChatMessageView, ChatReferenceView } from "../lib/types";

let citationSequence = 0;

interface CitationProps {
  reference: ChatReferenceView;
  index: number;
}

function Citation({ reference, index }: CitationProps): ReactElement {
  const sequenceRef = useRef(0);
  if (sequenceRef.current === 0) {
    citationSequence += 1;
    sequenceRef.current = citationSequence;
  }
  const [expanded, setExpanded] = useState(false);
  const sourceNumber = reference.citationNumber || index + 1;
  const detailId = `citation-detail-${sequenceRef.current}`;

  return (
    <div className="citation-list">
      <button
        type="button"
        className="citation-button"
        aria-expanded={expanded}
        aria-controls={detailId}
        aria-label={`来源 ${sourceNumber}，${reference.label}${reference.hasLocation ? "，来源位置可用" : ""}`}
        onClick={() => setExpanded((value) => !value)}
      >
        {`Source ${sourceNumber} / 来源 ${sourceNumber} · ${reference.label}`}
      </button>
      <div className="citation-detail" id={detailId} hidden={!expanded}>
        <h3>{`Source ${sourceNumber} / 来源 ${sourceNumber} · ${reference.label}`}</h3>
        <p>{reference.passage}</p>
        <p>
          {reference.hasLocation
            ? "A local source location is available; no provider identifier or physical path is shown / 可定位本地来源，但不显示 Provider ID 或物理路径。"
            : "No local source location was provided / API 未提供本地定位信息。"}
        </p>
      </div>
    </div>
  );
}

interface MessageLogProps {
  messages: ChatMessageView[];
  referencesByMessageId: ReadonlyMap<string, ChatReferenceView[]>;
}

interface ScrollSnapshot {
  nearBottom: boolean;
  firstRender: boolean;
}

export class MessageLog extends Component<MessageLogProps> {
  private node: HTMLDivElement | null = null;

  private scrollToBottom(): void {
    window.requestAnimationFrame(() => {
      if (this.node) {
        this.node.scrollTop = this.node.scrollHeight;
      }
    });
  }

  override componentDidMount(): void {
    if (this.props.messages.length > 0) {
      this.scrollToBottom();
    }
  }

  override getSnapshotBeforeUpdate(prevProps: MessageLogProps): ScrollSnapshot | null {
    const node = this.node;
    if (!node) {
      return null;
    }
    return {
      nearBottom: node.scrollHeight - node.scrollTop - node.clientHeight < 90,
      firstRender: prevProps.messages.length === 0,
    };
  }

  override componentDidUpdate(
    _prevProps: MessageLogProps,
    _prevState: unknown,
    snapshot: ScrollSnapshot | null,
  ): void {
    if (this.props.messages.length === 0 || !snapshot) {
      return;
    }
    if (snapshot.nearBottom || snapshot.firstRender) {
      this.scrollToBottom();
    }
  }

  override render(): ReactElement {
    const { messages, referencesByMessageId } = this.props;
    return (
      <div
        className="message-log"
        id="message-log"
        role="log"
        aria-label="AI chat messages / AI 对话消息"
        aria-relevant="additions text"
        ref={(node) => {
          this.node = node;
        }}
      >
        {messages.length === 0 ? (
          <div className="empty-chat">
            <span aria-hidden="true">✦</span>
            <h2>Ask from the book / 从书中提问</h2>
            <p>回答只以纯文本显示；来源按钮只使用 API references。暂不支持的端点会显示明确错误。 </p>
          </div>
        ) : (
          messages.map((message) => {
            const references =
              message.role === "assistant"
                ? message.references.length
                  ? message.references
                  : referencesByMessageId.get(message.id) || []
                : [];
            const pending = message.content === null || message.content === "";
            return (
              <article className="chat-message" data-role={message.role} key={message.id}>
                <div className="message-meta">
                  <strong>
                    {message.role === "user" ? "You / 你" : "Reading assistant / 阅读助手"}
                  </strong>
                  <span>{formatTime(message.createdAt)}</span>
                </div>
                <p className={pending ? "message-bubble message-pending" : "message-bubble"}>
                  {pending
                    ? message.role === "assistant"
                      ? "Answer pending / 回答等待处理中。"
                      : "Message content unavailable / 消息内容不可用。"
                    : message.content}
                </p>
                {message.role === "assistant"
                  ? references.map((reference, index) => (
                      <Citation
                        reference={reference}
                        index={index}
                        key={`${message.id}-${index}`}
                      />
                    ))
                  : null}
              </article>
            );
          })
        )}
      </div>
    );
  }
}
