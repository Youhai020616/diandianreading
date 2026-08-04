import { useCallback, useEffect, useState, type ReactElement } from "react";
import { READY_BOOK_STATUSES } from "../lib/normalize";
import type { BookSnapshot } from "../lib/types";
import {
  CONTENT_TYPES,
  LENGTHS,
  TONES,
  type ContentAssetSnapshot,
  type ContentRevisionSnapshot,
  type ExportResultSnapshot,
  type GenerationForm,
  exportToObsidian,
  generateContent,
  listContents,
  loadContent,
  saveRevision,
} from "../lib/workbench";
import type { AppState } from "../state/store";

interface WorkbenchViewProps {
  state: AppState;
}

const DEFAULT_FORM: GenerationForm = {
  contentType: "reading_report",
  tone: "rational",
  length: "medium",
  language: "zh-CN",
  targetPlatform: "",
  requireCitations: true,
  firstPerson: false,
};

const AUTHOR_LABELS: Record<string, string> = {
  ai: "AI 原始稿",
  human: "我的修改稿",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败";
}

export function WorkbenchView({ state }: WorkbenchViewProps): ReactElement {
  const readyBooks = state.books.filter((book) =>
    READY_BOOK_STATUSES.has(book.status),
  );
  const [bookId, setBookId] = useState("");
  const [form, setForm] = useState<GenerationForm>(DEFAULT_FORM);
  const [contents, setContents] = useState<ContentAssetSnapshot[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [revisions, setRevisions] = useState<ContentRevisionSnapshot[]>([]);
  const [activeRevision, setActiveRevision] = useState<number>(0);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [exports, setExports] = useState<ExportResultSnapshot[]>([]);
  const [message, setMessage] = useState("");

  const refreshContents = useCallback(async (id: string): Promise<void> => {
    if (!id) {
      setContents([]);
      return;
    }
    try {
      setContents(await listContents(id));
    } catch (error) {
      setMessage(errorText(error));
    }
  }, []);

  useEffect(() => {
    void refreshContents(bookId);
  }, [bookId, refreshContents]);

  const openContent = async (id: string): Promise<void> => {
    try {
      const detail = await loadContent(id);
      setSelectedId(id);
      setRevisions(detail.revisions);
      const latest = detail.revisions[detail.revisions.length - 1];
      setActiveRevision(latest ? latest.revision_number : 0);
      setDraftTitle(latest ? latest.title : "");
      setDraftBody(latest ? latest.body : "");
    } catch (error) {
      setMessage(errorText(error));
    }
  };

  const submitGeneration = async (): Promise<void> => {
    if (!bookId) {
      setMessage("请先选择一本书");
      return;
    }
    try {
      const created = await generateContent(bookId, form);
      setMessage(
        created
          ? "已提交生成任务，完成后会出现在下面的列表中"
          : "生成任务已提交",
      );
      await refreshContents(bookId);
    } catch (error) {
      setMessage(errorText(error));
    }
  };

  const persistEdit = async (): Promise<void> => {
    if (!selectedId) {
      return;
    }
    try {
      await saveRevision(selectedId, draftTitle, draftBody);
      await openContent(selectedId);
      await refreshContents(bookId);
      setMessage("已保存为新的修改稿；AI 原始稿仍然保留");
    } catch (error) {
      setMessage(errorText(error));
    }
  };

  const runExport = async (): Promise<void> => {
    if (!bookId) {
      return;
    }
    try {
      const results = await exportToObsidian(bookId);
      setExports(results);
      const conflicts = results.filter((item) => item.conflict_path !== null);
      setMessage(
        conflicts.length > 0
          ? `${conflicts.length} 个文件你手动改过，已写入冲突文件而不是覆盖`
          : "已导出到 Obsidian",
      );
    } catch (error) {
      setMessage(errorText(error));
    }
  };

  const shown =
    revisions.find((item) => item.revision_number === activeRevision) ?? null;
  const active = state.currentView === "workbench";

  return (
    <section
      className="view"
      id="view-workbench"
      data-view-panel="workbench"
      aria-labelledby="workbench-title"
      hidden={!active}
    >
      <div className="view-heading">
        <h2 id="workbench-title">Workbench / 创作工作台</h2>
      </div>
      {/* Rendered only while active: the book picker repeats every library title,
          and leaving those options in a hidden panel makes them ambiguous to any
          text query run against the whole document. */}
      {active && (
        <>
          <div className="workbench-controls">
            <label htmlFor="workbench-book">来源书籍</label>
            <select
              id="workbench-book"
              value={bookId}
              onChange={(event) => setBookId(event.target.value)}
            >
              <option value="">请选择</option>
              {readyBooks.map((book: BookSnapshot) => (
                <option key={book.id} value={book.id}>
                  {book.title}
                </option>
              ))}
            </select>

            <label htmlFor="workbench-type">内容类型</label>
            <select
              id="workbench-type"
              value={form.contentType}
              onChange={(event) =>
                setForm({ ...form, contentType: event.target.value })
              }
            >
              {CONTENT_TYPES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>

            <label htmlFor="workbench-tone">语气</label>
            <select
              id="workbench-tone"
              value={form.tone}
              onChange={(event) =>
                setForm({ ...form, tone: event.target.value })
              }
            >
              {TONES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>

            <label htmlFor="workbench-length">长度</label>
            <select
              id="workbench-length"
              value={form.length}
              onChange={(event) =>
                setForm({ ...form, length: event.target.value })
              }
            >
              {LENGTHS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>

            <label htmlFor="workbench-platform">目标平台（可选）</label>
            <input
              id="workbench-platform"
              type="text"
              value={form.targetPlatform}
              onChange={(event) =>
                setForm({ ...form, targetPlatform: event.target.value })
              }
            />

            <label htmlFor="workbench-citations">
              <input
                id="workbench-citations"
                type="checkbox"
                checked={form.requireCitations}
                onChange={(event) =>
                  setForm({ ...form, requireCitations: event.target.checked })
                }
              />
              保留引用
            </label>

            <label htmlFor="workbench-first-person">
              <input
                id="workbench-first-person"
                type="checkbox"
                checked={form.firstPerson}
                onChange={(event) =>
                  setForm({ ...form, firstPerson: event.target.checked })
                }
              />
              第一人称
            </label>

            <button type="button" onClick={() => void submitGeneration()}>
              生成 / Generate
            </button>
            <button type="button" onClick={() => void runExport()}>
              导出到 Obsidian
            </button>
          </div>

          <p
            role="status"
            data-testid="workbench-status"
            className="workbench-status"
          >
            {message}
          </p>

          <ul className="workbench-list" aria-label="内容列表">
            {contents.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => void openContent(item.id)}>
                  {item.content_type} · {item.status} · 修订{" "}
                  {item.latest_revision_number}
                </button>
              </li>
            ))}
          </ul>

          {shown !== null && (
            <div className="workbench-editor">
              <ol className="workbench-revisions" aria-label="版本历史">
                {revisions.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      aria-pressed={item.revision_number === activeRevision}
                      onClick={() => {
                        setActiveRevision(item.revision_number);
                        setDraftTitle(item.title);
                        setDraftBody(item.body);
                      }}
                    >
                      第 {item.revision_number} 版 ·{" "}
                      {AUTHOR_LABELS[item.author_kind]}
                    </button>
                  </li>
                ))}
              </ol>

              <p className="workbench-author" data-author={shown.author_kind}>
                当前查看：{AUTHOR_LABELS[shown.author_kind]}
              </p>

              <label htmlFor="workbench-title">标题</label>
              <input
                id="workbench-title"
                type="text"
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
              />

              <label htmlFor="workbench-body">正文</label>
              <textarea
                id="workbench-body"
                value={draftBody}
                onChange={(event) => setDraftBody(event.target.value)}
              />

              <button type="button" onClick={() => void persistEdit()}>
                保存为新修订
              </button>

              <section aria-label="预览">
                <h3>预览</h3>
                <p className="workbench-preview">{draftBody}</p>
              </section>
            </div>
          )}

          {exports.length > 0 && (
            <ul className="workbench-exports" aria-label="导出结果">
              {exports.map((item) => (
                <li key={item.target_kind} data-outcome={item.outcome}>
                  {item.target_kind} · {item.outcome}
                  {item.conflict_path !== null &&
                    ` · 冲突文件：${item.conflict_path}`}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
