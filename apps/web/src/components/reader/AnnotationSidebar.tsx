import type { ReactElement } from "react";
import { formatTime } from "../../lib/labels";
import { ANNOTATION_COLORS, type AnnotationView } from "../../lib/reader/model";
import type { ReaderController, ReaderState } from "../../state/readerController";
import { COLOR_LABELS } from "./SelectionToolbar";

interface AnnotationSidebarProps {
  state: ReaderState;
  reader: ReaderController;
}

function annotationQuote(annotation: AnnotationView): string | null {
  if (annotation.selectedText !== null) {
    return annotation.selectedText;
  }
  if (annotation.anchor !== null && annotation.anchor.quote !== null) {
    return annotation.anchor.quote.exact;
  }
  return null;
}

function canJump(annotation: AnnotationView, state: ReaderState): boolean {
  if (annotation.status !== "active" || annotation.anchor === null) {
    return false;
  }
  if (annotation.anchor.type === "markdown_offset") {
    return (
      state.mode === "markdown"
      && state.detail !== null
      && annotation.anchor.anchorSha256 === state.detail.document.anchorSha256
      && annotation.anchor.start !== null
    );
  }
  return state.mode === "pdf" && annotation.anchor.start !== null;
}

function AnnotationCard({
  annotation,
  state,
  reader,
}: {
  annotation: AnnotationView;
  state: ReaderState;
  reader: ReaderController;
}): ReactElement {
  const quote = annotationQuote(annotation);
  const editing = state.editingAnnotationId === annotation.id;
  const active = state.activeAnnotationId === annotation.id;
  const deleted = annotation.status === "deleted";
  const busy = state.annotationBusy;

  return (
    <li
      className={`annotation-card${active ? " is-active" : ""}`}
      data-annotation-card={annotation.id}
      data-status={annotation.status}
    >
      <div className="annotation-card-head">
        {annotation.color !== null ? (
          <span className={`swatch-dot swatch-${annotation.color}`} aria-hidden="true"></span>
        ) : null}
        <span className="annotation-kind">
          {annotation.kind === "highlight" ? "Highlight / 划线" : "Note / 笔记"}
        </span>
        {annotation.status === "orphaned" ? (
          <span className="status-badge" data-state="blocked">
            Orphaned / 已失锚
          </span>
        ) : null}
        {deleted ? (
          <span className="status-badge" data-state="cancelled">
            Deleted / 已删除
          </span>
        ) : null}
      </div>

      {quote !== null ? <blockquote className="annotation-quote">{quote}</blockquote> : null}
      {annotation.status === "orphaned" ? (
        <p className="annotation-orphan-hint">
          The passage moved after re-import; the original quote is kept above /
          重新导入后未能定位原文，已保留原始引述。
        </p>
      ) : null}

      {editing ? (
        <form
          className="annotation-edit-form"
          onSubmit={(event) => {
            event.preventDefault();
            void reader.saveEdit();
          }}
        >
          <label className="sr-only" htmlFor={`annotation-edit-${annotation.id}`}>
            Edit thought / 编辑想法
          </label>
          <textarea
            id={`annotation-edit-${annotation.id}`}
            rows={3}
            value={state.editDraft}
            onChange={(event) => reader.setEditDraft(event.currentTarget.value)}
          ></textarea>
          <div className="annotation-card-actions">
            <button className="button button-primary" type="submit" disabled={busy}>
              Save / 保存
            </button>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => reader.cancelEdit()}
            >
              Cancel / 取消
            </button>
          </div>
        </form>
      ) : annotation.body !== null ? (
        <p className="annotation-body">{annotation.body}</p>
      ) : null}

      <p className="annotation-meta">{formatTime(annotation.createdAt)}</p>

      <div className="annotation-card-actions">
        {canJump(annotation, state) ? (
          <button
            className="button button-secondary"
            type="button"
            data-annotation-jump={annotation.id}
            onClick={() => reader.jumpToAnnotation(annotation.id)}
          >
            Jump to text / 跳到原文
          </button>
        ) : null}
        {!deleted && !editing ? (
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={() => reader.beginEdit(annotation.id)}
          >
            {annotation.body !== null ? "Edit thought / 编辑想法" : "Add thought / 写想法"}
          </button>
        ) : null}
        {!deleted ? (
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            data-annotation-delete={annotation.id}
            onClick={() => void reader.softDelete(annotation.id)}
          >
            Delete / 删除
          </button>
        ) : (
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            data-annotation-restore={annotation.id}
            onClick={() => void reader.restore(annotation.id)}
          >
            Restore / 恢复
          </button>
        )}
      </div>

      {!deleted && annotation.kind === "highlight" ? (
        <div
          className="annotation-recolor"
          role="group"
          aria-label="Change color / 更改颜色"
        >
          {ANNOTATION_COLORS.map((color) => (
            <button
              className={`swatch-button swatch-${color}${annotation.color === color ? " is-current" : ""}`}
              type="button"
              key={color}
              aria-label={COLOR_LABELS[color]}
              aria-pressed={annotation.color === color}
              disabled={busy || annotation.color === color}
              onClick={() => void reader.changeColor(annotation.id, color)}
            ></button>
          ))}
        </div>
      ) : null}
    </li>
  );
}

export function AnnotationSidebar({ state, reader }: AnnotationSidebarProps): ReactElement {
  const visible = state.annotations.filter((entry) => entry.status !== "deleted");
  const deleted = state.annotations.filter((entry) => entry.status === "deleted");

  return (
    <aside className="annotation-sidebar" aria-labelledby="annotation-sidebar-title">
      <div className="panel-heading">
        <h2 id="annotation-sidebar-title">Annotations / 标注</h2>
        <span>{String(visible.length)}</span>
      </div>
      {visible.length === 0 && deleted.length === 0 ? (
        <p className="annotation-empty">
          Select text to create the first highlight / 选中正文文字即可创建第一条划线。
        </p>
      ) : (
        <>
          <ul className="annotation-list" id="annotation-list">
            {visible.map((annotation) => (
              <AnnotationCard
                annotation={annotation}
                state={state}
                reader={reader}
                key={annotation.id}
              />
            ))}
          </ul>
          {deleted.length > 0 ? (
            <details className="annotation-deleted-group">
              <summary>{`Deleted / 已删除（${deleted.length}）`}</summary>
              <ul className="annotation-list">
                {deleted.map((annotation) => (
                  <AnnotationCard
                    annotation={annotation}
                    state={state}
                    reader={reader}
                    key={annotation.id}
                  />
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </aside>
  );
}
