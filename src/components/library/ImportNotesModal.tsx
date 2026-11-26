import React, { useState } from "react";
import { formatUserError } from "../../utils/formatError";
import { CustomSelect } from "../CustomSelect";
import { IconClose, IconUpload } from "../Icons";

interface ImportNotesModalProps {
  onClose(): void;
  /** Called after an import with the touched books and a summary for the toast. */
  onImported(bookIds: string[], summary: string): void;
}

/** Import Kindle My Clippings or WeRead exports, from a file or pasted text. */
export const ImportNotesModal: React.FC<ImportNotesModalProps> = ({ onClose, onImported }) => {
  const [format, setFormat] = useState<"auto" | "kindle" | "weread">("auto");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  const importFile = async () => {
    setError("");
    try {
      const res = await window.diandian.library.importNotesFile({ format, fallbackTitle: title || undefined });
      if (res.canceled) return;
      onImported(res.bookIds, `导入完成（${res.format}）：新增 ${res.importedCount} 条，去重 ${res.deduplicatedCount} 条（涉及 ${res.booksTouched} 本书）`);
    } catch (cause) {
      setError(formatUserError(cause, "导入失败"));
    }
  };

  const importText = async () => {
    if (!text.trim()) return;
    setError("");
    try {
      const res = await window.diandian.library.importNotesText({ rawText: text, format, fallbackTitle: title || undefined });
      setText("");
      onImported(res.bookIds, `已导入 ${res.importedCount} 条划线（去重 ${res.deduplicatedCount} 条）`);
    } catch (cause) {
      setError(formatUserError(cause, "解析失败"));
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => onClose()}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>导入 Kindle / 微信读书笔记</h3>
          <button type="button" className="btn icon-only ghost" onClick={() => onClose()}>
            <IconClose size={16} />
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div className="field-group">
            <label className="field-label">格式识别</label>
            <CustomSelect
              value={format}
              onChange={(val) => setFormat(val as "auto" | "kindle" | "weread")}
              ariaLabel="导入格式识别"
              options={[
                { value: "auto", label: "自动识别（推荐）", description: "智能判断 Kindle 或微信读书导出格式" },
                { value: "kindle", label: "Kindle My Clippings.txt", description: "标准 Kindle 设备标注文本" },
                { value: "weread", label: "微信读书导出笔记 / Markdown", description: "支持微信读书复制或导出笔记" },
              ]}
            />
          </div>
          <div className="field-group">
            <label className="field-label">默认书名（微信读书粘贴时可选）</label>
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="留空则自动从首行提取"
            />
          </div>
        </div>

        <div className="field-group">
          <button type="button" className="btn soft" onClick={() => void importFile()}>
            <IconUpload size={14} />
            选择本机文件（My Clippings.txt / .md / .txt）
          </button>
        </div>

        <div className="field-group">
          <label className="field-label">或直接粘贴导出的划线文本</label>
          <textarea
            className="textarea"
            rows={7}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"例如微信读书 App「导出笔记 -> 复制」后的文本：\n◆ 第一章\n>> 这是一条划线金句…"}
          />
        </div>

        {error && <div className="muted-box" role="alert">{error}</div>}

        <div className="modal-footer">
          <button type="button" className="btn" onClick={() => onClose()}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void importText()}
            disabled={!text.trim()}
          >
            解析并去重入库
          </button>
        </div>
      </div>
    </div>
  );
};
