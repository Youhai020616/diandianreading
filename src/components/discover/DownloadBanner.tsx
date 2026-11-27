import React from "react";
import { supportsWeReadImport } from "../../../electron/router/wereadFormats";
import type { ConnectionsSnapshot } from "../../types/desktop";
import { IconBookOpen, IconCheck, IconClose, IconFolder, IconUpload, IconWand } from "../Icons";
import { cleanShortTitle, type DownloadedEntry } from "./discoverShared";

interface DownloadBannerProps {
  entry: DownloadedEntry;
  connections: ConnectionsSnapshot | null;
  dispatchBusy: string | null;
  onOpenDownloadLibrary(): void;
  onOpenFolder(filePath?: string): void;
  onRepairMeta(entry: DownloadedEntry): void;
  onOpenWeReadShelf(title?: string): void;
  onDispatch(entry: DownloadedEntry, target: "weread" | "kindle"): void;
  onDismiss(): void;
}

/** Next steps for the book that just finished downloading. */
export const DownloadBanner: React.FC<DownloadBannerProps> = ({
  entry, connections, dispatchBusy, onOpenDownloadLibrary, onOpenFolder, onRepairMeta, onOpenWeReadShelf, onDispatch, onDismiss,
}) => (
  <div className="discover-download-banner">
    <div className="discover-download-banner-left">
      <span className="discover-download-check">
        <IconCheck size={13} />
      </span>
      <span className="discover-download-text">
        已下载 <strong>《{cleanShortTitle(entry.title)}》</strong>
      </span>
    </div>
    <div className="discover-download-banner-actions">
      <button type="button" className="btn sm soft" onClick={onOpenDownloadLibrary}>
        <IconBookOpen size={12} />
        <span>查看本地书库</span>
      </button>
      <button
        type="button"
        className="btn sm ghost"
        onClick={() => onOpenFolder(entry.filePath)}
      >
        <IconFolder size={12} />
        <span>在访达中显示</span>
      </button>
      {entry.filePath && connections?.status.supportsMeta && (
        <button
          type="button"
          className={`btn sm ${entry.metaFixed ? "ghost" : "soft"}`}
          disabled={dispatchBusy !== null || entry.metaFixed}
          onClick={() => onRepairMeta(entry)}
          title="在线匹配并更新书名、作者等书目信息"
        >
          {entry.metaFixed ? <IconCheck size={12} /> : <IconWand size={12} />}
          <span>
            {dispatchBusy === `${entry.bookRef}:meta`
              ? "补全中…"
              : entry.metaFixed
                ? "已补元数据"
                : "补全书目信息"}
          </span>
        </button>
      )}
      {entry.filePath && supportsWeReadImport(entry.filePath.split(".").pop() ?? "") && (
        entry.wereadUploaded ? (
          <button
            type="button"
            className="btn sm primary"
            onClick={() => onOpenWeReadShelf(entry.title)}
            title="在右侧内置浏览器打开并刷新微信读书书架"
          >
            <IconBookOpen size={12} />
            <span>已传微信读书 · 去开读</span>
          </button>
        ) : (
          <button
            type="button"
            className="btn sm sage"
            disabled={dispatchBusy !== null}
            onClick={() => onDispatch(entry, "weread")}
            title={
              connections?.weread.loggedIn
                ? "一键导入到微信读书书架"
                : "点击导入微信读书书架（首次将弹出二维码开通传书通道，扫完自动续传）"
            }
          >
            <IconUpload size={12} />
            <span>
              {dispatchBusy === `${entry.bookRef}:weread` ? "上传中…" : "传微信读书"}
            </span>
          </button>
        )
      )}
      {entry.filePath && connections?.kindle.configured && (
        <button
          type="button"
          className="btn sm soft"
          disabled={dispatchBusy !== null}
          onClick={() => onDispatch(entry, "kindle")}
        >
          <IconUpload size={12} />
          <span>
            {dispatchBusy === `${entry.bookRef}:kindle` ? "推送中…" : "推 Kindle"}
          </span>
        </button>
      )}
      <button
        type="button"
        className="btn icon-only ghost"
        style={{ width: 22, height: 22 }}
        onClick={() => onDismiss()}
        title="关闭提示"
      >
        <IconClose size={12} />
      </button>
    </div>
  </div>
);
