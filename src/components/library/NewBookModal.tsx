import React, { useState } from "react";
import type { BookRecord } from "../../types/desktop";
import { IconClose } from "../Icons";

interface NewBookModalProps {
  onClose(): void;
  onCreated(book: BookRecord): void;
  onError(message: string): void;
}

/** Create an empty book record to collect highlights by hand. */
export const NewBookModal: React.FC<NewBookModalProps> = ({ onClose, onCreated, onError }) => {
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");

  const create = async () => {
    if (!title.trim()) return;
    try {
      onCreated(await window.diandian.library.createBook({ title: title.trim(), author: author.trim(), source: "manual" }));
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "创建失败");
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => onClose()}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ width: 420 }}>
        <div className="modal-header">
          <h3>新建书籍档案</h3>
          <button type="button" className="btn icon-only ghost" onClick={() => onClose()}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="field-group">
          <label className="field-label">书名</label>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：置身事内"
          />
        </div>
        <div className="field-group">
          <label className="field-label">作者（可选）</label>
          <input
            className="input"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="例如：兰小欢"
          />
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={() => onClose()}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void create()}
            disabled={!title.trim()}
          >
            创建
          </button>
        </div>
      </div>
    </div>
  );
};
