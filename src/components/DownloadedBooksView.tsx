import { useEffect, useId, useRef, useState } from "react";
import type { DownloadedBookFile, LocalBookImportResult } from "../types/desktop";
import { supportsWeReadImport } from "../../electron/router/wereadFormats";
import { formatUserError } from "../utils/formatError";
import { IconClose, IconExternalLink, IconFileText, IconFolder, IconHistory, IconPlus, IconMoreHorizontal, IconRefresh, IconSearch, IconUpload } from "./Icons";
import "./DownloadedBooksView.css";

interface DownloadedBooksViewProps {
  files: DownloadedBookFile[];
  loading: boolean;
  error: string;
  onRefresh: () => void;
  onDiscover: () => void;
  onOpenHistoryImport: () => void;
  onRead: (file: DownloadedBookFile) => void;
  imports: Readonly<Record<string, WeReadImportStatus | undefined>>;
  onImport: (file: DownloadedBookFile) => void;
  onOpenConnections: () => void;
  onOpenWeReadShelf: () => void;
  onNotify: (message: string, tone?: "info" | "success" | "error") => void;
}

export type WeReadImportStatus = "uploading" | "shelf" | "settings";

export function downloadedBookRevision(file: DownloadedBookFile): string {
  return JSON.stringify([file.filePath, file.modifiedAt, file.sizeBytes, file.fileRevision]);
}

const dateFormat = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
const sizeFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });

const coverRequests = new Map<string, Promise<string | null>>();

function requestCover(filePath: string, revision: string) {
  const cached = coverRequests.get(revision);
  if (cached) return cached;

  const request = Promise.resolve()
    .then(() => window.diandian.router.getDownloadedBookCover(filePath))
    .then(cover => {
      if (!cover && coverRequests.get(revision) === request) coverRequests.delete(revision);
      return cover;
    })
    .catch(() => {
      if (coverRequests.get(revision) === request) coverRequests.delete(revision);
      return null;
    });
  coverRequests.set(revision, request);
  if (coverRequests.size > 64) coverRequests.delete(coverRequests.keys().next().value!);
  return request;
}

function DownloadedBookCover({ file, revision, title, refresh }: {
  file: DownloadedBookFile; revision: string; title: string; refresh: number;
}) {
  const { filePath } = file;
  const frame = useRef<HTMLSpanElement>(null);
  const [source, setSource] = useState<string | null | undefined>();

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let active = true;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      observer.disconnect();
      void requestCover(filePath, revision).then(cover => {
        if (active) setSource(cover);
      });
    }, { root: element.closest(".downloaded-books-content"), rootMargin: "100px 0px" });
    observer.observe(element);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [filePath, revision, refresh]);

  return (
    <span className="downloaded-book-cover" ref={frame} aria-hidden="true">
      {source ? <img src={source} alt="" decoding="async" onError={() => setSource(null)} />
        : <span className="downloaded-book-cover-title">{title}</span>}
    </span>
  );
}

function fileSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${sizeFormat.format(size)} ${units[unit]}`;
}

function FileActions({ title, openExternal, locate, importWeRead, uploading }: {
  title: string; openExternal?: () => void; locate: () => void; importWeRead?: () => void; uploading: boolean;
}) {
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  return (
    <>
      <button type="button" className="btn sm ghost" popoverTarget={menuId}
        aria-label={`《${title}》的更多操作`} title="更多操作"><IconMoreHorizontal size={16} /></button>
      <div id={menuId} ref={menu} popover="auto" className="downloaded-book-menu" aria-label="电子书操作">
        {importWeRead && <button type="button" disabled={uploading} onClick={() => { menu.current?.hidePopover(); importWeRead(); }}>
          <IconUpload size={14} />{uploading ? "正在导入微信读书…" : "导入到微信读书"}
        </button>}
        {openExternal && <button type="button" onClick={() => { menu.current?.hidePopover(); openExternal(); }}>
          <IconExternalLink size={14} />用系统阅读器打开
        </button>}
        <button type="button" onClick={() => { menu.current?.hidePopover(); locate(); }}>
          <IconFolder size={14} />在文件夹中显示
        </button>
      </div>
    </>
  );
}

export function DownloadedBooksView({ files, loading, error, onRefresh, onDiscover, onOpenHistoryImport, onRead, onNotify,
  imports, onImport, onOpenConnections, onOpenWeReadShelf }: DownloadedBooksViewProps) {
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [failures, setFailures] = useState<LocalBookImportResult["failures"]>([]);
  const importMenuId = useId();
  const importMenu = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const importLock = useRef(false);

  async function runImport(mode: "files" | "directory" | "text") {
    if (importLock.current) return;
    importLock.current = true;
    setImporting(true);
    importMenu.current?.hidePopover();
    try {
      const result = mode === "text"
        ? await window.diandian.router.importBookText({ title, text })
        : await window.diandian.router.importLocalBooks(mode);
      if (result.canceled) return;
      setFailures(result.failures);
      if (result.added || result.existing) {
        setQuery("");
        onRefresh();
        content.current?.scrollTo({ top: 0 });
        if (mode === "text") { setPasteOpen(false); setTitle(""); setText(""); }
      }
      const summary = [
        result.added && `已导入 ${result.added} 本`,
        result.existing && `${result.existing} 本已在书库`,
        result.failures.length && `${result.failures.length} 项导入失败`,
      ].filter(Boolean).join("，");
      onNotify(summary || "文件夹中没有找到支持的电子书。", result.failures.length ? "error" : result.added ? "success" : "info");
    } catch (cause) {
      onNotify(formatUserError(cause, "导入书籍失败"), "error");
    } finally {
      importLock.current = false;
      setImporting(false);
    }
  }

  const [coverRefresh, setCoverRefresh] = useState(0);
  useEffect(() => {
    const retry = () => setCoverRefresh(value => value + 1);
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, []);
  const search = query.trim().normalize("NFKC").toLowerCase();
  const matches = files.filter(file => file.fileName.normalize("NFKC").toLowerCase().includes(search));

  async function openBook(file: DownloadedBookFile) {
    try {
      await window.diandian.router.openDownloadedBook(file.filePath);
    } catch (cause) {
      onNotify(formatUserError(cause, "打开电子书失败"), "error");
      onRefresh();
    }
  }

  async function showInFolder(filePath?: string) {
    try {
      const location = await window.diandian.router.openDownloadDir(filePath);
      if (filePath && location.path !== filePath) {
        onNotify("这个文件已移动，已打开下载目录。", "info");
        onRefresh();
      }
    } catch (cause) {
      onNotify(formatUserError(cause, "打开下载目录失败"), "error");
      onRefresh();
    }
  }

  return (
    <div className="chat-view downloaded-books">
      <header className="view-header">
        <div className="view-header-left">
          <h1 className="view-title">本地书库</h1>
          {(files.length > 0 || (!loading && !error)) && <span className="badge">{files.length} 本书</span>}
        </div>
        <div className="view-header-right">
          <button type="button" className="btn sm primary" popoverTarget={importMenuId} disabled={importing}>
            <IconPlus size={14} />{importing ? "正在导入…" : "导入书籍"}
          </button>
          <div id={importMenuId} ref={importMenu} popover="auto" className="downloaded-book-menu" aria-label="导入来源">
            <button type="button" onClick={() => void runImport("files")}><IconFileText size={14} />选择文件…</button>
            <button type="button" onClick={() => void runImport("directory")}><IconFolder size={14} />选择文件夹…</button>
            <button type="button" onClick={() => { importMenu.current?.hidePopover(); setPasteOpen(true); content.current?.scrollTo({ top: 0 }); }}>
              <IconPlus size={14} />粘贴文本…
            </button>
            <button type="button" onClick={() => { importMenu.current?.hidePopover(); onOpenHistoryImport(); }}>
              <IconHistory size={14} />从 Z-Library 下载历史导入
            </button>
          </div>
          <button type="button" className="btn sm ghost" onClick={() => void showInFolder()}>
            <IconFolder size={14} />打开下载目录
          </button>
          <button type="button" className="btn sm ghost" onClick={() => { setCoverRefresh(value => value + 1); onRefresh(); }} disabled={loading}>
            <IconRefresh size={14} />刷新
          </button>
        </div>
      </header>

      <div className="studio-scroll downloaded-books-content" ref={content}>
        {pasteOpen && (
          <form className="shelf-text-import" aria-label="粘贴文本" onSubmit={event => { event.preventDefault(); void runImport("text"); }}>
            <label>书名<input autoFocus value={title} maxLength={200} placeholder="留空时使用正文首行"
              onChange={event => setTitle(event.target.value)} disabled={importing} /></label>
            <label>正文<textarea rows={5} placeholder="粘贴要阅读的文字…" value={text}
              onChange={event => setText(event.target.value)} disabled={importing} /></label>
            <div className="shelf-text-import-actions">
              <button type="button" className="btn sm ghost" disabled={importing} onClick={() => setPasteOpen(false)}>取消</button>
              <button type="submit" className="btn sm primary" disabled={importing || !text.trim()}>存为 EPUB</button>
            </div>
          </form>
        )}
        {failures.length > 0 && <details className="shelf-import-errors">
          <summary>查看 {failures.length} 项导入失败的原因</summary>
          <ul>{failures.map((failure, index) => <li key={index}>{failure.name} · {failure.message}</li>)}</ul>
        </details>}
        {(files.length > 0 || query) && (
          <div className="inline-filter-box">
            <IconSearch size={13} />
            <input aria-label="筛选本地电子书" placeholder="筛选文件名或格式…" value={query}
              onChange={event => setQuery(event.target.value)} />
            {query && (
              <button type="button" className="inline-filter-clear" aria-label="清空筛选" onClick={() => setQuery("")}>
                <IconClose size={11} />
              </button>
            )}
          </div>
        )}
        {error && (
          <div className="muted-box downloaded-books-message" role="alert">
            <span>{error}</span>
            <button type="button" className="btn sm" onClick={onRefresh} disabled={loading}>重试</button>
          </div>
        )}
        {files.length === 0 && !error && (
          loading ? <div className="muted-box" role="status">正在读取下载目录…</div> : (
            <div className="muted-box downloaded-books-message">
              <span>书库中还没有电子书。点「导入书籍」添加本机文件，也可以从「搜书发现」下载。</span>
              <button type="button" className="btn sm primary" onClick={onDiscover}>去搜书</button>
            </div>
          )
        )}
        {files.length > 0 && matches.length === 0 && (
          <div className="muted-box downloaded-books-message" role="status">
            <span>没有找到与「{query.trim()}」匹配的电子书。</span>
            <button type="button" className="btn sm" onClick={() => setQuery("")}>显示全部</button>
          </div>
        )}
        {matches.length > 0 && (
          <ul className="downloaded-books-list" aria-label="本地电子书">
            {matches.map(file => {
              const title = file.fileName.replace(/\.[^.]+$/, "") || file.fileName;
              const revision = downloadedBookRevision(file);
              const importStatus = imports[revision];
              const readableHere = file.format === "epub";
              return (
                <li key={file.filePath}>
                  <button type="button" className="downloaded-book-open" aria-label={`${readableHere ? "阅读" : "打开"}《${title}》`}
                    title={readableHere ? "在工作台阅读" : "用系统阅读器打开"}
                    onClick={() => readableHere ? onRead(file) : void openBook(file)}>
                    <DownloadedBookCover key={revision} file={file} revision={revision} title={title} refresh={coverRefresh} />
                    <span className="downloaded-book-description">
                      <strong>{title}</strong>
                      <small><span className="badge mono">{file.format.toUpperCase()}</span>
                        <span>{fileSize(file.sizeBytes)} · 修改于 {dateFormat.format(file.modifiedAt)}</span>
                      </small>
                    </span>
                    <span className="downloaded-book-action" aria-hidden="true">{readableHere ? "阅读" : "打开"}</span>
                  </button>
                  <FileActions title={title} openExternal={readableHere ? () => void openBook(file) : undefined}
                    importWeRead={supportsWeReadImport(file.format) ? () => onImport(file) : undefined}
                    uploading={importStatus === "uploading"}
                    locate={() => void showInFolder(file.filePath)} />
                  {importStatus && <div className="downloaded-book-import-status">
                    {importStatus === "uploading" && <span role="status">正在导入微信读书…</span>}
                    {importStatus === "settings" && <button type="button" className="btn sm ghost" onClick={onOpenConnections}>前往「连接与偏好」</button>}
                    {importStatus === "shelf" && <button type="button" className="btn sm ghost" onClick={onOpenWeReadShelf}>查看微信读书书架</button>}
                  </div>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
