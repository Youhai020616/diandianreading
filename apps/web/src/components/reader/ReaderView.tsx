import {
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import type { HighlightSpan } from "../../lib/reader/highlights";
import { rangeToSourceOffsets } from "../../lib/reader/selection";
import type { AppController } from "../../state/controller";
import type { ReaderController, ReaderState } from "../../state/readerController";
import type { AppState } from "../../state/store";
import { AnnotationSidebar } from "./AnnotationSidebar";
import { MarkdownContent } from "./MarkdownContent";
import { PdfReaderView } from "./PdfReaderView";
import { SelectionToolbar } from "./SelectionToolbar";

interface ReaderViewProps {
  appState: AppState;
  controller: AppController;
  reader: ReaderController;
}

function markdownHighlights(state: ReaderState): HighlightSpan[] {
  const doc = state.doc;
  const detail = state.detail;
  if (doc === null || detail === null) {
    return [];
  }
  const sha = detail.document.anchorSha256;
  const spans: HighlightSpan[] = [];
  for (const annotation of state.annotations) {
    const anchor = annotation.anchor;
    if (
      annotation.kind !== "highlight"
      || annotation.status !== "active"
      || annotation.color === null
      || anchor === null
      || anchor.type !== "markdown_offset"
      || anchor.anchorSha256 !== sha
      || anchor.start === null
      || anchor.end === null
      || anchor.end <= anchor.start
    ) {
      continue;
    }
    const createdAtMs = annotation.createdAt !== null ? Date.parse(annotation.createdAt) : 0;
    spans.push({
      id: annotation.id,
      startU16: doc.map.u16FromCp(anchor.start),
      endU16: doc.map.u16FromCp(anchor.end),
      color: annotation.color,
      createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
    });
  }
  return spans;
}

export function ReaderView({ appState, controller, reader }: ReaderViewProps): ReactElement {
  const state = useSyncExternalStore(reader.store.subscribe, reader.store.getState);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrolledTokenRef = useRef(0);

  const highlights = useMemo(() => markdownHighlights(state), [state]);

  // Restore/refocus the reading position when a scroll target is published.
  useEffect(() => {
    if (
      state.scrollToken === 0
      || state.scrollToken === scrolledTokenRef.current
      || state.scrollTargetCp === null
      || state.doc === null
    ) {
      return;
    }
    scrolledTokenRef.current = state.scrollToken;
    const container = contentRef.current;
    if (container === null) {
      return;
    }
    const targetCp = state.scrollTargetCp;
    const blocks = Array.from(container.querySelectorAll<HTMLElement>(".md-block"));
    let target: HTMLElement | null = null;
    for (const block of blocks) {
      const start = Number.parseInt(block.getAttribute("data-start") ?? "", 10);
      const end = Number.parseInt(block.getAttribute("data-end") ?? "", 10);
      if (Number.isFinite(start) && start <= targetCp && (target === null || start >= 0)) {
        if (Number.isFinite(end) && targetCp < end) {
          target = block;
          break;
        }
        target = block;
      }
      if (Number.isFinite(start) && start > targetCp) {
        break;
      }
    }
    const destination = target ?? blocks[0] ?? null;
    if (destination !== null) {
      if (typeof destination.scrollIntoView === "function") {
        destination.scrollIntoView({ block: "start" });
      } else {
        container.scrollTop = destination.offsetTop;
      }
    }
  }, [state.scrollToken, state.scrollTargetCp, state.doc]);

  const handleScroll = (): void => {
    const container = contentRef.current;
    if (container === null || state.doc === null) {
      return;
    }
    const scrollRange = container.scrollHeight - container.clientHeight;
    const percent = scrollRange > 0 ? container.scrollTop / scrollRange : 0;
    const blocks = container.querySelectorAll<HTMLElement>(".md-block");
    let firstVisibleCp = 0;
    for (const block of Array.from(blocks)) {
      if (block.offsetTop + block.offsetHeight >= container.scrollTop) {
        const start = Number.parseInt(block.getAttribute("data-start") ?? "", 10);
        if (Number.isFinite(start)) {
          firstVisibleCp = start;
        }
        break;
      }
    }
    reader.reportMarkdownPosition(firstVisibleCp, percent);
  };

  const handleSelection = (): void => {
    if (state.mode !== "markdown") {
      return;
    }
    const container = contentRef.current;
    const selection = window.getSelection();
    if (container === null || selection === null || selection.rangeCount === 0) {
      return;
    }
    const range = selection.getRangeAt(0);
    if (range.collapsed) {
      reader.clearSelection();
      return;
    }
    const mapped = rangeToSourceOffsets(range, container);
    if (mapped === null) {
      reader.clearSelection();
      return;
    }
    let rect: { left: number; top: number } | null = null;
    if (typeof range.getBoundingClientRect === "function") {
      try {
        const bounds = range.getBoundingClientRect();
        rect = { left: bounds.left, top: bounds.bottom + 8 };
      } catch {
        rect = null;
      }
    }
    reader.setMarkdownSelection(mapped, rect);
  };

  const handleContentKeydown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget || event.shiftKey) {
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (state.mode === "pdf") {
        reader.stepPdfPage(-1);
      } else {
        reader.stepChapter(-1);
      }
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      if (state.mode === "pdf") {
        reader.stepPdfPage(1);
      } else {
        reader.stepChapter(1);
      }
    } else if (event.key === "Escape") {
      reader.clearSelection();
    }
  };

  const backToLibrary = (): void => {
    reader.closeBook();
    controller.setView("library", true);
  };

  const title = state.book !== null ? state.book.title : "Reader / 阅读器";

  return (
    <section
      className="view"
      id="view-reader"
      data-view-panel="reader"
      aria-labelledby="reader-title"
      hidden={appState.currentView !== "reader"}
    >
      <div className="view-heading reader-heading">
        <div>
          <p className="eyebrow">READING / 阅读</p>
          <h1 id="reader-title">{title}</h1>
          {state.book !== null && state.book.author ? <p>{state.book.author}</p> : null}
        </div>
        <button
          className="button button-secondary"
          id="reader-back-button"
          type="button"
          onClick={backToLibrary}
        >
          Back to library / 返回书库
        </button>
      </div>

      <p
        className="section-status"
        id="reader-status"
        role="status"
        aria-live="polite"
        data-state={state.status === "error" ? "error" : state.statusText ? "error" : "ready"}
      >
        {state.status === "error"
          ? state.errorText ?? ""
          : state.statusText || state.progressNote}
      </p>

      {state.status === "loading" ? (
        <p className="reader-loading">Loading the reading document / 正在加载正文…</p>
      ) : null}

      {state.status === "error" ? (
        <button
          className="button button-primary"
          type="button"
          onClick={() => {
            if (state.book !== null) {
              reader.openBook(state.book);
            }
          }}
        >
          Retry / 重试
        </button>
      ) : null}

      {state.status === "ready" ? (
        <div className="reader-layout" data-mode={state.mode ?? ""}>
          {state.mode === "markdown" && state.detail !== null && state.detail.chapters.length > 0 ? (
            <nav className="chapter-sidebar" aria-label="Chapters / 章节">
              <div className="panel-heading">
                <h2>Chapters / 章节</h2>
              </div>
              <ul className="chapter-list" id="chapter-list">
                {state.detail.chapters.map((chapter) => (
                  <li key={chapter.reference}>
                    <button
                      className={
                        chapter.reference === state.currentChapterRef
                          ? "chapter-button is-active"
                          : "chapter-button"
                      }
                      type="button"
                      aria-current={
                        chapter.reference === state.currentChapterRef ? "true" : undefined
                      }
                      onClick={() => reader.selectChapter(chapter.reference)}
                    >
                      {chapter.title || "(untitled) / 无标题"}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}

          <div
            className="reader-content"
            id="reader-content"
            ref={contentRef}
            tabIndex={0}
            role="region"
            aria-label={`正文 / Book text: ${title}`}
            onScroll={handleScroll}
            onMouseUp={handleSelection}
            onKeyUp={handleSelection}
            onKeyDown={handleContentKeydown}
          >
            {state.mode === "markdown" && state.doc !== null ? (
              <MarkdownContent
                doc={state.doc}
                highlights={highlights}
                activeAnnotationId={state.activeAnnotationId}
                onMarkClick={(annotationId) => reader.activateAnnotation(annotationId)}
              />
            ) : null}
            {state.mode === "pdf" ? <PdfReaderView state={state} reader={reader} /> : null}
          </div>

          <AnnotationSidebar state={state} reader={reader} />
        </div>
      ) : null}

      <SelectionToolbar state={state} reader={reader} />
    </section>
  );
}
