import type { ReactElement } from "react";
import { ANNOTATION_COLORS, type AnnotationColorValue } from "../../lib/reader/model";
import type { ReaderController, ReaderState } from "../../state/readerController";

export const COLOR_LABELS: Record<AnnotationColorValue, string> = {
  yellow: "Yellow highlight / 黄色划线",
  green: "Green highlight / 绿色划线",
  blue: "Blue highlight / 蓝色划线",
  pink: "Pink highlight / 粉色划线",
  purple: "Purple highlight / 紫色划线",
};

interface SelectionToolbarProps {
  state: ReaderState;
  reader: ReaderController;
}

export function SelectionToolbar({ state, reader }: SelectionToolbarProps): ReactElement | null {
  const selection = state.selection;
  if (selection === null) {
    return null;
  }
  const style =
    selection.rect !== null
      ? { top: `${Math.max(0, selection.rect.top)}px`, left: `${Math.max(0, selection.rect.left)}px` }
      : undefined;
  return (
    <div
      className="selection-toolbar"
      id="selection-toolbar"
      role="toolbar"
      aria-label="Annotate selection / 标注所选文字"
      {...(style !== undefined ? { style } : {})}
    >
      {!state.noteDraftOpen ? (
        <div className="selection-toolbar-row">
          {ANNOTATION_COLORS.map((color) => (
            <button
              className={`swatch-button swatch-${color}`}
              type="button"
              key={color}
              aria-label={COLOR_LABELS[color]}
              disabled={state.annotationBusy}
              onClick={() => void reader.createHighlightFromSelection(color, null)}
            ></button>
          ))}
          <button
            className="button button-secondary toolbar-note-button"
            id="selection-note-button"
            type="button"
            disabled={state.annotationBusy}
            onClick={() => reader.openNoteDraft()}
          >
            Add thought / 写想法
          </button>
          <button
            className="button button-secondary"
            type="button"
            aria-label="Dismiss / 取消"
            onClick={() => reader.clearSelection()}
          >
            ✕
          </button>
        </div>
      ) : (
        <form
          className="selection-note-form"
          onSubmit={(event) => {
            event.preventDefault();
            void reader.createHighlightFromSelection("yellow", state.noteDraft.trim() || null);
          }}
        >
          <label className="sr-only" htmlFor="selection-note-input">
            Thought about the selection / 针对所选文字的想法
          </label>
          <textarea
            id="selection-note-input"
            rows={3}
            value={state.noteDraft}
            placeholder="写下想法… / Write a thought…"
            onChange={(event) => reader.setNoteDraft(event.currentTarget.value)}
          ></textarea>
          <div className="selection-toolbar-row">
            <button
              className="button button-primary"
              id="selection-note-save"
              type="submit"
              disabled={state.annotationBusy || state.noteDraft.trim().length === 0}
            >
              Save thought / 保存想法
            </button>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => reader.clearSelection()}
            >
              Cancel / 取消
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
