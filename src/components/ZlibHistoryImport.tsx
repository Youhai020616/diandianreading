import { useEffect, useRef, useState } from "react";
import type { ZlibDownloadHistoryPage } from "../types/desktop";
import { formatUserError } from "../utils/formatError";
import { IconArrowLeft, IconArrowRight, IconCheck, IconClose, IconDownload, IconRefresh } from "./Icons";
import "./ZlibHistoryImport.css";

type HistoryBook = ZlibDownloadHistoryPage["books"][number];
interface HistoryImportProps {
  onClose(): void;
  onImported(): void;
}

interface HistoryPage {
  books: HistoryBook[];
  localRefs: Set<string>;
  hasMore: boolean;
}

function unavailableReason(book: HistoryBook): string {
  return book.unavailableReason || (book.bookRef ? "" : "缺少下载标识");
}

export function ZlibHistoryImport({ onClose, onImported }: HistoryImportProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const batch = useRef<{ stop: boolean } | null>(null);
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<HistoryPage | null>(null);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState(new Map<string, HistoryBook>());
  const [failures, setFailures] = useState(new Map<string, string>());
  const [progress, setProgress] = useState<{ title: string; current: number; total: number } | null>(null);
  const [stopping, setStopping] = useState(false);
  const [summary, setSummary] = useState("");

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => {
      if (batch.current) batch.current.stop = true;
      element.close();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const restartMessage = "请重新启动点点读书，以加载下载历史导入功能。";
    if (!window.diandian.router.downloadHistoryPage || !window.diandian.router.downloadHistoryBook) {
      setLoadError(restartMessage);
      return;
    }
    void window.diandian.router.downloadHistoryPage(page, refresh > 0).then(data => {
      if (!active) return;
      const localRefs = new Set(data.localRefs);
      const books = data.books;
      setResult({ books, localRefs, hasMore: data.hasMore });
      setSelected(previous => {
        const next = new Map(previous);
        for (const book of books) {
          if (localRefs.has(book.bookRef) || unavailableReason(book)) next.delete(book.bookRef);
          else if (next.has(book.bookRef)) next.set(book.bookRef, book);
        }
        return next;
      });
    }).catch(cause => {
      if (active) setLoadError(String(cause).includes("No handler registered")
        ? restartMessage : formatUserError(cause, "读取 Z-Library 下载历史失败"));
    });
    return () => { active = false; };
  }, [page, refresh]);

  function changePage(next: number) {
    setResult(null);
    setLoadError("");
    if (next === page) setRefresh(value => value + 1);
    else { setRefresh(0); setPage(next); }
  }

  const loading = !result && !loadError;
  const eligible = result?.books.filter(book => !result.localRefs.has(book.bookRef) && !unavailableReason(book)) ?? [];
  const allSelected = eligible.length > 0 && eligible.every(book => selected.has(book.bookRef));
  const retrySelection = selected.size > 0 && [...selected.keys()].every(ref => failures.has(ref));

  function choose(books: HistoryBook[], checked: boolean) {
    setSummary("");
    setSelected(previous => {
      const next = new Map(previous);
      for (const book of books) {
        if (checked) next.set(book.bookRef, book);
        else next.delete(book.bookRef);
      }
      return next;
    });
  }

  async function downloadSelected() {
    if (batch.current || !selected.size || !result) return;
    const queue = [...selected.values()];
    const run = { stop: false };
    batch.current = run;
    setSummary("");
    setStopping(false);
    let succeeded = 0;
    let existing = 0;
    let failed = 0;
    try {
      for (const book of queue) {
        if (run.stop) break;
        setProgress({ title: book.title, current: succeeded + existing + failed + 1, total: queue.length });
        try {
          const { title, author, isbn, publisher, year, coverUrl } = book;
          const downloaded = await window.diandian.router.downloadHistoryBook(book.bookRef, { title, author, isbn, publisher, year, coverUrl });
          if (downloaded.alreadyLocal) existing++;
          else succeeded++;
        } catch (cause) {
          failed++;
          setFailures(previous => new Map(previous).set(book.bookRef, formatUserError(cause, "下载失败，请重试")));
          continue;
        }
        setResult(previous => previous && { ...previous, localRefs: new Set(previous.localRefs).add(book.bookRef) });
        setSelected(previous => { const next = new Map(previous); next.delete(book.bookRef); return next; });
        onImported();
      }
    } finally {
      batch.current = null;
      setProgress(null);
      setStopping(false);
      const remaining = queue.length - succeeded - existing - failed;
      setSummary([
        succeeded && `已下载 ${succeeded} 本`,
        existing && `${existing} 本已在书库`,
        failed && `${failed} 本失败`,
        remaining && `${remaining} 本待下载`,
      ].filter(Boolean).join("，"));
    }
  }

  function stopAfterCurrent() {
    if (batch.current) batch.current.stop = true;
    setStopping(true);
  }

  return <dialog className="zlib-history-dialog" ref={dialog} aria-labelledby="zlib-history-title"
    onCancel={event => { event.preventDefault(); if (!batch.current) onClose(); }}
    onKeyDown={event => event.stopPropagation()}>
    <header className="zlib-history-header">
      <h2 id="zlib-history-title">从 Z-Library 下载历史导入</h2>
      <button type="button" className="btn icon-only ghost" aria-label="关闭下载历史" disabled={!!progress} onClick={onClose}><IconClose /></button>
    </header>
    <div className="zlib-history-toolbar">
      <label><input type="checkbox" checked={allSelected} disabled={!eligible.length || !!progress}
        ref={node => { if (node) node.indeterminate = !allSelected && eligible.some(book => selected.has(book.bookRef)); }}
        onChange={event => choose(eligible, event.target.checked)} />全选本页</label>
      <button type="button" className="btn sm ghost" disabled={loading || !!progress} onClick={() => changePage(page)}>
        <IconRefresh size={14} />刷新
      </button>
    </div>
    <div className="zlib-history-list" key={page} aria-busy={loading}>
      {loading && <p className="zlib-history-message" role="status">正在读取下载历史…</p>}
      {loadError && <div className="zlib-history-message" role="alert">
        <p>{loadError}</p>
        <button type="button" className="btn sm" onClick={() => changePage(page)}>重试</button>
      </div>}
      {result?.books.length === 0 && <p className="zlib-history-message">{page === 1 ? "这个账号还没有下载记录。" : "这一页没有下载记录。"}</p>}
      {result && result.books.length > 0 && <ul>{result.books.map((book, index) => {
        const isLocal = result.localRefs.has(book.bookRef);
        const reason = unavailableReason(book);
        const error = failures.get(book.bookRef);
        const meta = [book.author, book.extension.toUpperCase(), book.size].filter(Boolean).join(" · ");
        return <li key={`${book.bookRef}:${index}`}>
          <label className="zlib-history-row">
            <input type="checkbox" aria-label={book.title} disabled={isLocal || !!reason || !!progress}
              checked={!isLocal && !reason && selected.has(book.bookRef)} onChange={event => choose([book], event.target.checked)} />
            <span className="zlib-history-book">
              <strong>{book.title}</strong>
              {meta && <small>{meta}</small>}
              {!!error && !isLocal && <small className="zlib-history-error">{error}</small>}
            </span>
            {isLocal ? <span className="zlib-history-local"><IconCheck size={13} />已在书库</span>
              : reason && <small className="zlib-history-unavailable">{reason}</small>}
          </label>
        </li>;
      })}</ul>}
    </div>
    <nav className="zlib-history-pager" aria-label="下载历史分页">
      <button type="button" className="btn sm ghost" aria-label="上一页" disabled={page === 1 || loading || !!progress}
        onClick={() => changePage(page - 1)}><IconArrowLeft size={14} /></button>
      <span>第 {page} 页</span>
      <button type="button" className="btn sm ghost" aria-label="下一页" disabled={!result?.hasMore || !!progress}
        onClick={() => changePage(page + 1)}><IconArrowRight size={14} /></button>
    </nav>
    <footer className="zlib-history-footer">
      <div className="zlib-history-feedback" role="status">
        <strong>{progress ? `正在下载 ${progress.current} / ${progress.total}` : summary || `已选 ${selected.size} 本`}</strong>
        {progress && <small>{stopping ? "当前这本处理完后停止" : progress.title}</small>}
      </div>
      {progress ? <button type="button" className="btn sm" disabled={stopping || progress.current === progress.total} onClick={stopAfterCurrent}>
        {stopping ? "正在停止…" : "停止后续下载"}</button>
        : <button type="button" className="btn sm primary" disabled={!selected.size || !result} onClick={() => void downloadSelected()}>
          <IconDownload size={14} />{retrySelection ? "重试所选" : "下载所选"}{selected.size > 0 && ` (${selected.size})`}</button>}
    </footer>
  </dialog>;
}
