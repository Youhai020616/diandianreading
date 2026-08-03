/**
 * Reader state machine (R3): book loading with explicit ETag revalidation,
 * chapter/progress bookkeeping with a >=5s debounce and a single silent
 * retry after 409, selection -> highlight/note creation, and the annotation
 * sidebar operations. Pure logic — components subscribe via the store.
 */
import { ApiError, friendlyError } from "../lib/errors";
import { createPdfjsEngine, type PdfDocumentHandle, type PdfEngine, type PdfPageHandle } from "../lib/pdf";
import {
  createHighlight,
  deleteAnnotation,
  editAnnotation,
  getBookContentBytes,
  getBookContentText,
  getBookDetail,
  listAnnotations,
  putProgress,
  restoreAnnotation,
  type AnchorPayload,
} from "../lib/reader/api";
import { parseMarkdown, type MarkdownDocument } from "../lib/reader/markdown";
import type {
  AnnotationColorValue,
  AnnotationView,
  BookDetail,
  ChapterView,
} from "../lib/reader/model";
import {
  quoteForRange,
  rangeCodepointLength,
  SELECTED_TEXT_MAX_CODEPOINTS,
  type SourceRangeU16,
} from "../lib/reader/selection";
import type { BookSnapshot } from "../lib/types";

export const PROGRESS_DEBOUNCE_MS = 5000;

const MARKDOWN_MIME = "text/markdown";
const PDF_MIME = "application/pdf";

export type ReaderMode = "markdown" | "pdf";

export interface ReaderSelection {
  startU16: number;
  endU16: number;
  startCp: number;
  endCp: number;
  text: string;
  rect: { left: number; top: number } | null;
}

export interface PdfViewState {
  pageCount: number;
  page: number;
  /** Engine failed under this environment: offer download instead. */
  fallback: boolean;
  textLayerAvailable: boolean;
}

export interface ReaderState {
  status: "idle" | "loading" | "ready" | "error";
  errorText: string | null;
  statusText: string;
  book: BookSnapshot | null;
  detail: BookDetail | null;
  mode: ReaderMode | null;
  doc: MarkdownDocument | null;
  annotations: AnnotationView[];
  selection: ReaderSelection | null;
  noteDraftOpen: boolean;
  noteDraft: string;
  activeAnnotationId: string | null;
  annotationBusy: boolean;
  editingAnnotationId: string | null;
  editDraft: string;
  currentChapterRef: string | null;
  scrollTargetCp: number | null;
  scrollToken: number;
  pdf: PdfViewState | null;
  manualQuoteOpen: boolean;
  manualQuoteDraft: string;
  progressNote: string;
}

export function initialReaderState(): ReaderState {
  return {
    status: "idle",
    errorText: null,
    statusText: "",
    book: null,
    detail: null,
    mode: null,
    doc: null,
    annotations: [],
    selection: null,
    noteDraftOpen: false,
    noteDraft: "",
    activeAnnotationId: null,
    annotationBusy: false,
    editingAnnotationId: null,
    editDraft: "",
    currentChapterRef: null,
    scrollTargetCp: null,
    scrollToken: 0,
    pdf: null,
    manualQuoteOpen: false,
    manualQuoteDraft: "",
    progressNote: "",
  };
}

export class ReaderStore {
  private state: ReaderState = initialReaderState();
  private readonly listeners = new Set<() => void>();

  getState = (): ReaderState => this.state;

  setState = (partial: Partial<ReaderState>): void => {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) {
      listener();
    }
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

interface PendingProgress {
  kind: "markdown" | "pdf";
  /** Codepoint caret for markdown, 1-based page for pdf. */
  position: number;
  percent: number;
}

export interface ReaderControllerOptions {
  announce?: (message: string) => void;
  pdfEngine?: PdfEngine;
}

interface ContentCacheEntry {
  etag: string;
  text: string;
}

export class ReaderController {
  readonly store = new ReaderStore();

  private readonly announce: (message: string) => void;
  private readonly pdfEngine: PdfEngine;
  private readonly contentCache = new Map<string, ContentCacheEntry>();

  private currentSha: string | null = null;
  private pdfDocument: PdfDocumentHandle | null = null;
  private openSequence = 0;
  /** Monotonic across books so the view's consumed-token guard never stalls. */
  private scrollSequence = 0;

  private nextScrollToken(): number {
    this.scrollSequence += 1;
    return this.scrollSequence;
  }

  private pendingProgress: PendingProgress | null = null;
  private progressTimer: number | null = null;
  private progressInFlight = false;

  constructor(options?: ReaderControllerOptions) {
    this.announce = options?.announce ?? ((): void => undefined);
    this.pdfEngine = options?.pdfEngine ?? createPdfjsEngine();
  }

  // ----- lifecycle -----------------------------------------------------------

  openBook(book: BookSnapshot): void {
    this.openSequence += 1;
    this.clearProgressTimer();
    this.pendingProgress = null;
    void this.destroyPdfDocument();
    this.store.setState({
      ...initialReaderState(),
      status: "loading",
      book,
      statusText: "Loading the book / 正在加载书籍…",
    });
    void this.load(book, this.openSequence, false);
  }

  closeBook(): void {
    this.openSequence += 1;
    this.clearProgressTimer();
    this.pendingProgress = null;
    this.currentSha = null;
    void this.destroyPdfDocument();
    this.store.setState(initialReaderState());
  }

  dispose(): void {
    this.closeBook();
  }

  private async destroyPdfDocument(): Promise<void> {
    const handle = this.pdfDocument;
    this.pdfDocument = null;
    if (handle !== null) {
      try {
        await handle.destroy();
      } catch {
        // Destroying a broken engine handle must never surface.
      }
    }
  }

  private isCurrent(sequence: number): boolean {
    return sequence === this.openSequence;
  }

  private async load(book: BookSnapshot, sequence: number, quiet: boolean): Promise<void> {
    try {
      const detail = await getBookDetail(book.id);
      if (!this.isCurrent(sequence)) {
        return;
      }
      if (detail.document.mimeType === PDF_MIME) {
        await this.loadPdf(book, detail, sequence);
      } else if (detail.document.mimeType === MARKDOWN_MIME) {
        await this.loadMarkdown(book, detail, sequence);
      } else {
        this.store.setState({
          status: "error",
          errorText: "This document format cannot be displayed / 暂不支持展示该文档格式。",
        });
      }
    } catch (error) {
      if (!this.isCurrent(sequence) || quiet) {
        return;
      }
      this.store.setState({
        status: "error",
        errorText: friendlyError(error, "The book could not be loaded / 无法加载书籍。"),
      });
    }
  }

  private async loadMarkdown(
    book: BookSnapshot,
    detail: BookDetail,
    sequence: number,
  ): Promise<void> {
    const cached = this.contentCache.get(book.id) ?? null;
    const result = await getBookContentText(book.id, cached !== null ? cached.etag : null);
    if (!this.isCurrent(sequence)) {
      return;
    }
    let text: string;
    let etag: string;
    if (result.kind === "fresh") {
      text = result.text;
      etag = result.etag.length > 0 ? result.etag : detail.document.anchorSha256;
      this.contentCache.set(book.id, { etag, text });
    } else if (cached !== null) {
      text = cached.text;
      etag = cached.etag;
    } else {
      throw new ApiError(304, "INVALID_RESPONSE", null);
    }
    const doc = parseMarkdown(text);
    this.currentSha = etag;

    let annotations: AnnotationView[] = [];
    let annotationNote = "";
    try {
      annotations = await listAnnotations(book.id);
    } catch (error) {
      annotationNote = friendlyError(
        error,
        "Annotations are temporarily unavailable / 标注暂时不可用。",
      );
    }
    if (!this.isCurrent(sequence)) {
      return;
    }

    const progress = detail.progress;
    const restoreCp =
      progress !== null
      && progress.anchor.type === "markdown_offset"
      && progress.anchor.anchorSha256 === etag
      && progress.anchor.start !== null
        ? Math.min(progress.anchor.start, doc.map.cpLength)
        : null;

    this.store.setState({
      status: "ready",
      errorText: null,
      statusText: annotationNote,
      book,
      detail,
      mode: "markdown",
      doc,
      annotations,
      pdf: null,
      selection: null,
      currentChapterRef: restoreCp !== null ? chapterAt(detail.chapters, restoreCp) : null,
      scrollTargetCp: restoreCp,
      scrollToken: restoreCp !== null ? this.nextScrollToken() : this.store.getState().scrollToken,
    });
  }

  private async loadPdf(book: BookSnapshot, detail: BookDetail, sequence: number): Promise<void> {
    const content = await getBookContentBytes(book.id);
    if (!this.isCurrent(sequence)) {
      return;
    }
    this.currentSha =
      content.etag.length > 0 ? content.etag : detail.document.anchorSha256;

    let annotations: AnnotationView[] = [];
    let annotationNote = "";
    try {
      annotations = await listAnnotations(book.id);
    } catch (error) {
      annotationNote = friendlyError(
        error,
        "Annotations are temporarily unavailable / 标注暂时不可用。",
      );
    }

    let handle: PdfDocumentHandle | null = null;
    try {
      handle = await this.pdfEngine.open(content.bytes);
    } catch {
      // Engine unavailable (CSP/Trusted Types conflict, missing Worker, …):
      // degrade to the download prompt instead of a broken canvas.
      handle = null;
    }
    if (!this.isCurrent(sequence)) {
      if (handle !== null) {
        try {
          await handle.destroy();
        } catch {
          // Already navigating away.
        }
      }
      return;
    }
    this.pdfDocument = handle;

    const progress = detail.progress;
    const restoredPage =
      progress !== null
      && progress.anchor.type === "pdf_page"
      && progress.anchor.anchorSha256 === this.currentSha
      && progress.anchor.start !== null
        ? progress.anchor.start
        : 1;
    const pageCount = handle !== null ? handle.pageCount : 0;

    this.store.setState({
      status: "ready",
      errorText: null,
      statusText: annotationNote,
      book,
      detail,
      mode: "pdf",
      doc: null,
      annotations,
      selection: null,
      pdf: {
        pageCount,
        page: pageCount > 0 ? Math.max(1, Math.min(restoredPage, pageCount)) : 1,
        fallback: handle === null,
        textLayerAvailable: false,
      },
    });
  }

  /** Silent document refresh used by the single 409 retry. */
  private async refreshAfterConflict(): Promise<void> {
    const state = this.store.getState();
    const book = state.book;
    if (book === null) {
      return;
    }
    const sequence = this.openSequence;
    try {
      const detail = await getBookDetail(book.id);
      if (!this.isCurrent(sequence)) {
        return;
      }
      if (detail.document.anchorSha256 !== this.currentSha) {
        await this.load(book, sequence, true);
      } else {
        this.store.setState({ detail });
      }
    } catch {
      // Silent by contract: the retry below will fail and stay quiet too.
    }
  }

  // ----- progress ------------------------------------------------------------

  reportMarkdownPosition(firstVisibleCp: number, percent: number): void {
    const state = this.store.getState();
    if (state.mode !== "markdown" || state.detail === null) {
      return;
    }
    const chapterRef = chapterAt(state.detail.chapters, firstVisibleCp);
    if (chapterRef !== state.currentChapterRef) {
      this.store.setState({ currentChapterRef: chapterRef });
    }
    this.queueProgress({ kind: "markdown", position: firstVisibleCp, percent });
  }

  reportPdfPage(page: number, percent: number): void {
    const state = this.store.getState();
    if (state.mode !== "pdf") {
      return;
    }
    this.queueProgress({ kind: "pdf", position: page, percent });
  }

  private queueProgress(pending: PendingProgress): void {
    this.pendingProgress = pending;
    if (this.progressTimer === null) {
      this.progressTimer = window.setTimeout(() => {
        this.progressTimer = null;
        void this.flushProgress();
      }, PROGRESS_DEBOUNCE_MS);
    }
  }

  private clearProgressTimer(): void {
    if (this.progressTimer !== null) {
      window.clearTimeout(this.progressTimer);
      this.progressTimer = null;
    }
  }

  private progressAnchor(pending: PendingProgress): AnchorPayload | null {
    const state = this.store.getState();
    const sha = this.currentSha;
    if (sha === null) {
      return null;
    }
    if (pending.kind === "markdown") {
      const doc = state.doc;
      if (doc === null) {
        return null;
      }
      const caret = Math.max(0, Math.min(pending.position, doc.map.cpLength));
      const anchor: AnchorPayload = {
        type: "markdown_offset",
        anchor_sha256: sha,
        start: caret,
        end: caret,
      };
      const chapterRef =
        state.detail !== null ? chapterAt(state.detail.chapters, caret) : null;
      if (chapterRef !== null) {
        anchor.chapter_ref = chapterRef;
      }
      return anchor;
    }
    const pageCount = state.pdf !== null ? state.pdf.pageCount : 0;
    const page = Math.max(1, pageCount > 0 ? Math.min(pending.position, pageCount) : pending.position);
    return { type: "pdf_page", anchor_sha256: sha, start: page };
  }

  private async flushProgress(): Promise<void> {
    if (this.progressInFlight) {
      return;
    }
    const pending = this.pendingProgress;
    this.pendingProgress = null;
    const state = this.store.getState();
    const book = state.book;
    if (pending === null || book === null || state.status !== "ready") {
      return;
    }
    const sequence = this.openSequence;
    this.progressInFlight = true;
    try {
      const percent = Math.max(0, Math.min(1, pending.percent));
      const anchor = this.progressAnchor(pending);
      if (anchor === null) {
        return;
      }
      try {
        await putProgress(book.id, anchor, percent);
        this.noteProgressSaved(percent);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409 || !this.isCurrent(sequence)) {
          return; // Progress is best-effort; never interrupt reading.
        }
        await this.refreshAfterConflict();
        if (!this.isCurrent(sequence)) {
          return;
        }
        const retryAnchor = this.progressAnchor(pending);
        if (retryAnchor === null) {
          return;
        }
        try {
          await putProgress(book.id, retryAnchor, percent);
          this.noteProgressSaved(percent);
        } catch {
          // One silent retry only (by contract).
        }
      }
    } finally {
      this.progressInFlight = false;
      if (this.pendingProgress !== null && this.progressTimer === null && this.isCurrent(sequence)) {
        this.queueProgress(this.pendingProgress);
      }
    }
  }

  private noteProgressSaved(percent: number): void {
    this.store.setState({
      progressNote: `Progress saved / 进度已保存 · ${Math.round(percent * 100)}%`,
    });
  }

  // ----- chapters ------------------------------------------------------------

  selectChapter(reference: string): void {
    const state = this.store.getState();
    if (state.detail === null) {
      return;
    }
    const chapter = state.detail.chapters.find((entry) => entry.reference === reference);
    if (chapter === undefined) {
      return;
    }
    this.store.setState({
      currentChapterRef: chapter.reference,
      scrollTargetCp: chapter.start,
      scrollToken: this.nextScrollToken(),
    });
    this.announce(
      chapter.title.length > 0
        ? `Chapter / 章节：${chapter.title}`
        : "Chapter selected / 已切换章节。",
    );
  }

  stepChapter(delta: number): void {
    const state = this.store.getState();
    if (state.mode !== "markdown" || state.detail === null || state.detail.chapters.length === 0) {
      return;
    }
    const chapters = state.detail.chapters;
    const foundIndex = chapters.findIndex(
      (chapter) => chapter.reference === state.currentChapterRef,
    );
    // Before any scroll/progress the reader sits at the top: that is chapter 0.
    const currentIndex = foundIndex === -1 ? 0 : foundIndex;
    const nextIndex = Math.max(0, Math.min(chapters.length - 1, currentIndex + delta));
    const target = chapters[nextIndex];
    if (target !== undefined && nextIndex !== currentIndex) {
      this.selectChapter(target.reference);
    }
  }

  // ----- selection & highlight creation --------------------------------------

  setMarkdownSelection(range: SourceRangeU16, rect: { left: number; top: number } | null): void {
    const state = this.store.getState();
    const doc = state.doc;
    if (state.mode !== "markdown" || doc === null) {
      return;
    }
    const length = rangeCodepointLength(doc, range.startU16, range.endU16);
    if (length <= 0) {
      this.clearSelection();
      return;
    }
    if (length > SELECTED_TEXT_MAX_CODEPOINTS) {
      this.store.setState({
        selection: null,
        noteDraftOpen: false,
        statusText:
          "Selection is too long to annotate (2000 codepoints max) / 选区过长，无法标注（上限 2000 字符）。",
      });
      return;
    }
    this.store.setState({
      selection: {
        startU16: range.startU16,
        endU16: range.endU16,
        startCp: doc.map.cpFromU16(range.startU16),
        endCp: doc.map.cpFromU16(range.endU16),
        text: doc.source.slice(range.startU16, range.endU16),
        rect,
      },
      noteDraftOpen: false,
      noteDraft: "",
      statusText: "",
    });
  }

  clearSelection(): void {
    const state = this.store.getState();
    if (state.selection !== null || state.noteDraftOpen) {
      this.store.setState({ selection: null, noteDraftOpen: false, noteDraft: "" });
    }
  }

  openNoteDraft(): void {
    if (this.store.getState().selection !== null) {
      this.store.setState({ noteDraftOpen: true });
    }
  }

  setNoteDraft(value: string): void {
    this.store.setState({ noteDraft: value });
  }

  async createHighlightFromSelection(
    color: AnnotationColorValue,
    body: string | null,
  ): Promise<void> {
    const state = this.store.getState();
    const { selection, doc, book } = state;
    const sha = this.currentSha;
    if (selection === null || doc === null || book === null || sha === null) {
      return;
    }
    const quote = quoteForRange(doc, selection.startU16, selection.endU16);
    const anchor: AnchorPayload = {
      type: "markdown_offset",
      anchor_sha256: sha,
      start: selection.startCp,
      end: selection.endCp,
      quote,
    };
    const chapterRef =
      state.detail !== null ? chapterAt(state.detail.chapters, selection.startCp) : null;
    if (chapterRef !== null) {
      anchor.chapter_ref = chapterRef;
    }
    await this.submitHighlight(book.id, anchor, quote.exact, color, body);
  }

  private async submitHighlight(
    bookId: string,
    anchor: AnchorPayload,
    selectedText: string,
    color: AnnotationColorValue,
    body: string | null,
  ): Promise<void> {
    this.store.setState({ annotationBusy: true });
    try {
      const created = await createHighlight(bookId, {
        anchor,
        selectedText,
        color,
        body,
      });
      const state = this.store.getState();
      this.store.setState({
        annotations: created !== null ? [created, ...state.annotations] : state.annotations,
        selection: null,
        noteDraftOpen: false,
        noteDraft: "",
        manualQuoteOpen: false,
        manualQuoteDraft: "",
        activeAnnotationId: created !== null ? created.id : state.activeAnnotationId,
        statusText: "",
      });
      this.announce(
        body !== null && body.length > 0
          ? "Highlight with note saved / 已保存划线与想法。"
          : "Highlight saved / 已保存划线。",
      );
    } catch (error) {
      this.store.setState({
        statusText: friendlyError(error, "The highlight could not be saved / 无法保存划线。"),
      });
    } finally {
      this.store.setState({ annotationBusy: false });
    }
  }

  // ----- PDF -----------------------------------------------------------------

  pdfPageHandle(pageNumber: number): Promise<PdfPageHandle> | null {
    if (this.pdfDocument === null) {
      return null;
    }
    return this.pdfDocument.getPage(pageNumber);
  }

  setPdfPage(page: number): void {
    const state = this.store.getState();
    if (state.mode !== "pdf" || state.pdf === null || state.pdf.fallback) {
      return;
    }
    const clamped = Math.max(1, Math.min(page, Math.max(1, state.pdf.pageCount)));
    if (clamped === state.pdf.page) {
      return;
    }
    this.store.setState({ pdf: { ...state.pdf, page: clamped } });
    const percent = state.pdf.pageCount > 0 ? clamped / state.pdf.pageCount : 0;
    this.reportPdfPage(clamped, percent);
  }

  stepPdfPage(delta: number): void {
    const state = this.store.getState();
    if (state.pdf !== null) {
      this.setPdfPage(state.pdf.page + delta);
    }
  }

  setPdfTextLayerAvailable(available: boolean): void {
    const state = this.store.getState();
    if (state.pdf !== null && state.pdf.textLayerAvailable !== available) {
      this.store.setState({ pdf: { ...state.pdf, textLayerAvailable: available } });
    }
  }

  openManualQuote(): void {
    if (this.store.getState().mode === "pdf") {
      this.store.setState({ manualQuoteOpen: true, manualQuoteDraft: "" });
    }
  }

  cancelManualQuote(): void {
    this.store.setState({ manualQuoteOpen: false, manualQuoteDraft: "" });
  }

  setManualQuoteDraft(value: string): void {
    this.store.setState({ manualQuoteDraft: value });
  }

  async createPdfHighlight(color: AnnotationColorValue, quoteText: string): Promise<void> {
    const state = this.store.getState();
    const sha = this.currentSha;
    if (state.mode !== "pdf" || state.pdf === null || state.book === null || sha === null) {
      return;
    }
    const trimmed = quoteText.trim();
    if (trimmed.length === 0) {
      this.store.setState({
        statusText: "Enter the quoted passage first / 请先输入要划线的原文引述。",
      });
      return;
    }
    if (Array.from(trimmed).length > SELECTED_TEXT_MAX_CODEPOINTS) {
      this.store.setState({
        statusText:
          "The quote is too long (2000 codepoints max) / 引述过长（上限 2000 字符）。",
      });
      return;
    }
    const anchor: AnchorPayload = {
      type: "pdf_page",
      anchor_sha256: sha,
      start: state.pdf.page,
      quote: { exact: trimmed, prefix: "", suffix: "" },
    };
    await this.submitHighlight(state.book.id, anchor, trimmed, color, null);
  }

  // ----- annotation sidebar ---------------------------------------------------

  activateAnnotation(annotationId: string): void {
    this.store.setState({ activeAnnotationId: annotationId });
  }

  jumpToAnnotation(annotationId: string): void {
    const state = this.store.getState();
    const annotation = state.annotations.find((entry) => entry.id === annotationId);
    if (annotation === undefined || annotation.anchor === null) {
      return;
    }
    this.store.setState({ activeAnnotationId: annotationId });
    if (annotation.anchor.type === "markdown_offset" && annotation.anchor.start !== null) {
      this.store.setState({
        scrollTargetCp: annotation.anchor.start,
        scrollToken: this.nextScrollToken(),
      });
    } else if (annotation.anchor.type === "pdf_page" && annotation.anchor.start !== null) {
      this.setPdfPage(annotation.anchor.start);
    }
  }

  beginEdit(annotationId: string): void {
    const annotation = this.store
      .getState()
      .annotations.find((entry) => entry.id === annotationId);
    if (annotation !== undefined) {
      this.store.setState({
        editingAnnotationId: annotationId,
        editDraft: annotation.body ?? "",
      });
    }
  }

  cancelEdit(): void {
    this.store.setState({ editingAnnotationId: null, editDraft: "" });
  }

  setEditDraft(value: string): void {
    this.store.setState({ editDraft: value });
  }

  async saveEdit(): Promise<void> {
    const state = this.store.getState();
    const annotationId = state.editingAnnotationId;
    if (annotationId === null) {
      return;
    }
    const trimmed = state.editDraft.trim();
    await this.mutateAnnotation(
      annotationId,
      () => editAnnotation(annotationId, { body: trimmed.length > 0 ? trimmed : null }),
      "Note updated / 想法已更新。",
    );
    this.store.setState({ editingAnnotationId: null, editDraft: "" });
  }

  async changeColor(annotationId: string, color: AnnotationColorValue): Promise<void> {
    await this.mutateAnnotation(
      annotationId,
      () => editAnnotation(annotationId, { color }),
      "Color updated / 颜色已更新。",
    );
  }

  async softDelete(annotationId: string): Promise<void> {
    await this.mutateAnnotation(
      annotationId,
      () => deleteAnnotation(annotationId),
      "Annotation deleted; it can be restored / 标注已删除，可恢复。",
    );
  }

  async restore(annotationId: string): Promise<void> {
    await this.mutateAnnotation(
      annotationId,
      () => restoreAnnotation(annotationId),
      "Annotation restored / 标注已恢复。",
    );
  }

  private async mutateAnnotation(
    annotationId: string,
    operation: () => Promise<AnnotationView | null>,
    successMessage: string,
  ): Promise<void> {
    this.store.setState({ annotationBusy: true });
    try {
      const updated = await operation();
      if (updated !== null) {
        const state = this.store.getState();
        this.store.setState({
          annotations: state.annotations.map((entry) =>
            entry.id === annotationId ? updated : entry,
          ),
          statusText: "",
        });
      }
      this.announce(successMessage);
    } catch (error) {
      this.store.setState({
        statusText: friendlyError(error, "The annotation change failed / 标注操作失败。"),
      });
    } finally {
      this.store.setState({ annotationBusy: false });
    }
  }
}

function chapterAt(chapters: ChapterView[], cp: number): string | null {
  for (const chapter of chapters) {
    if (cp >= chapter.start && cp < chapter.end) {
      return chapter.reference;
    }
  }
  const last = chapters[chapters.length - 1];
  if (last !== undefined && cp >= last.end) {
    return last.reference;
  }
  return null;
}
