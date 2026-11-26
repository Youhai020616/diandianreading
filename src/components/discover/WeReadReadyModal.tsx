import React from "react";
import { IconBookOpen, IconCheck, IconClose } from "../Icons";
import { cleanShortTitle, type DownloadedEntry } from "./discoverShared";

interface WeReadReadyModalProps {
  entry: DownloadedEntry;
  onClose(): void;
  onOpenShelf(title?: string): void;
}

/** Confirms a book reached the WeRead shelf and offers to open it on the right. */
export const WeReadReadyModal: React.FC<WeReadReadyModalProps> = ({ entry, onClose, onOpenShelf }) => (
    <div
      className="discover-drawer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="已上传到微信读书书架"
      onClick={() => onClose()}
    >
      <div className="discover-weread-modal" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="discover-drawer-close"
          onClick={() => onClose()}
          title="关闭（Esc）"
        >
          <IconClose size={14} />
        </button>

        <div className="discover-weread-badge">
          <IconCheck size={20} />
        </div>

        <h3 className="discover-weread-title">已上架到微信读书书架</h3>
        <p className="discover-weread-desc">
          <strong>《{cleanShortTitle(entry.title)}》</strong>{" "}
          已导入完成。点击下方按钮将在右侧刷新「我的书架」，新书通常会出现在第一位。
        </p>

        <div className="discover-weread-actions">
          <button
            type="button"
            className="btn primary"
            onClick={() => onOpenShelf(entry.title)}
          >
            <IconBookOpen size={14} />
            <span>去右侧书架开读</span>
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => onClose()}
          >
            继续搜书
          </button>
        </div>
      </div>
    </div>
);
