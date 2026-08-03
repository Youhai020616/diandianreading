import { useEffect, useRef, useState, type ReactElement } from "react";
import { ANNOTATION_COLORS } from "../../lib/reader/model";
import type { ReaderController, ReaderState } from "../../state/readerController";
import { COLOR_LABELS } from "./SelectionToolbar";

interface PdfReaderViewProps {
  state: ReaderState;
  reader: ReaderController;
}

const PDF_SCALE = 1.25;

export function PdfReaderView({ state, reader }: PdfReaderViewProps): ReactElement | null {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const [selectionText, setSelectionText] = useState("");
  const [renderError, setRenderError] = useState(false);

  const pdf = state.pdf;
  const page = pdf !== null ? pdf.page : 1;
  const fallback = pdf !== null && pdf.fallback;

  useEffect(() => {
    if (pdf === null || fallback) {
      return;
    }
    let cancelled = false;
    const handleTask = reader.pdfPageHandle(page);
    if (handleTask === null) {
      return;
    }
    void (async (): Promise<void> => {
      try {
        const handle = await handleTask;
        if (cancelled) {
          return;
        }
        const canvas = canvasRef.current;
        if (canvas !== null && typeof canvas.getContext === "function" && canvas.getContext("2d") !== null) {
          await handle.render(canvas, PDF_SCALE);
        }
        const layer = textLayerRef.current;
        if (layer !== null) {
          layer.textContent = "";
          const available = await handle.renderTextLayer(layer, PDF_SCALE);
          if (!cancelled) {
            reader.setPdfTextLayerAvailable(available);
          }
        }
        if (!cancelled) {
          setRenderError(false);
        }
      } catch {
        if (!cancelled) {
          setRenderError(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reader, pdf === null, fallback, page]);

  if (pdf === null || state.book === null) {
    return null;
  }

  const contentHref = `/api/books/${encodeURIComponent(state.book.id)}/content`;

  if (fallback) {
    return (
      <div className="pdf-fallback" role="status">
        <h3>PDF cannot be rendered inline / 无法内嵌渲染该 PDF</h3>
        <p>
          The embedded PDF engine is unavailable in this environment. Download the original file
          and open it externally / 内嵌 PDF 引擎在当前环境不可用，请下载原文件后用外部阅读器打开。
        </p>
        <a className="button button-primary" href={contentHref} download>
          Download PDF / 下载 PDF
        </a>
      </div>
    );
  }

  const captureSelection = (): void => {
    const selection = window.getSelection();
    const text = selection !== null ? selection.toString().trim() : "";
    setSelectionText(text);
  };

  return (
    <div className="pdf-reader">
      <div className="pdf-controls" role="group" aria-label="Page navigation / 页码导航">
        <button
          className="button button-secondary"
          id="pdf-prev-page"
          type="button"
          disabled={page <= 1}
          onClick={() => reader.stepPdfPage(-1)}
        >
          Previous / 上一页
        </button>
        <label htmlFor="pdf-page-input">
          <span className="sr-only">Page number / 页码</span>
          <input
            className="pdf-page-input"
            id="pdf-page-input"
            type="number"
            min={1}
            max={Math.max(1, pdf.pageCount)}
            value={page}
            onChange={(event) => {
              const value = Number.parseInt(event.currentTarget.value, 10);
              if (Number.isFinite(value)) {
                reader.setPdfPage(value);
              }
            }}
          />
        </label>
        <span className="pdf-page-count" id="pdf-page-count">{`/ ${pdf.pageCount} 页`}</span>
        <button
          className="button button-secondary"
          id="pdf-next-page"
          type="button"
          disabled={page >= pdf.pageCount}
          onClick={() => reader.stepPdfPage(1)}
        >
          Next / 下一页
        </button>
      </div>

      {renderError ? (
        <p className="section-status" data-state="error" role="status">
          This page could not be rendered / 本页渲染失败。
          <a href={contentHref} download>
            Download PDF / 下载 PDF
          </a>
        </p>
      ) : null}

      <div className="pdf-page-shell">
        <canvas className="pdf-canvas" ref={canvasRef} aria-label={`PDF 第 ${page} 页`}></canvas>
        <div
          className="pdf-text-layer"
          ref={textLayerRef}
          onMouseUp={captureSelection}
          onKeyUp={captureSelection}
        ></div>
      </div>

      <div className="pdf-annotate" aria-label="Page highlight / 页级划线">
        {pdf.textLayerAvailable && selectionText.length > 0 ? (
          <div className="selection-toolbar-row" role="toolbar" aria-label="Highlight selection / 划线所选文字">
            <span className="pdf-selection-preview">{selectionText.slice(0, 80)}</span>
            {ANNOTATION_COLORS.map((color) => (
              <button
                className={`swatch-button swatch-${color}`}
                type="button"
                key={color}
                aria-label={COLOR_LABELS[color]}
                disabled={state.annotationBusy}
                onClick={() => {
                  void reader.createPdfHighlight(color, selectionText);
                  setSelectionText("");
                }}
              ></button>
            ))}
            <button
              className="button button-secondary"
              type="button"
              onClick={() => setSelectionText("")}
            >
              Cancel / 取消
            </button>
          </div>
        ) : !state.manualQuoteOpen ? (
          <button
            className="button button-secondary"
            id="pdf-manual-quote-button"
            type="button"
            onClick={() => reader.openManualQuote()}
          >
            Highlight this page (typed quote) / 在本页划线（手输引述）
          </button>
        ) : null}

        {state.manualQuoteOpen ? (
          <form className="pdf-manual-quote" onSubmit={(event) => event.preventDefault()}>
            <label htmlFor="pdf-manual-quote-input">
              Quoted passage on this page / 本页中要划线的原文引述
            </label>
            <textarea
              id="pdf-manual-quote-input"
              rows={3}
              value={state.manualQuoteDraft}
              onChange={(event) => reader.setManualQuoteDraft(event.currentTarget.value)}
            ></textarea>
            <div className="selection-toolbar-row">
              {ANNOTATION_COLORS.map((color) => (
                <button
                  className={`swatch-button swatch-${color}`}
                  type="button"
                  key={color}
                  aria-label={COLOR_LABELS[color]}
                  disabled={state.annotationBusy || state.manualQuoteDraft.trim().length === 0}
                  onClick={() => void reader.createPdfHighlight(color, state.manualQuoteDraft)}
                ></button>
              ))}
              <button
                className="button button-secondary"
                type="button"
                onClick={() => reader.cancelManualQuote()}
              >
                Cancel / 取消
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}
