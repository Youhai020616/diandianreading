import { useCallback, useEffect, useState, type ReactElement } from "react";
import { ApiError, friendlyError } from "../lib/errors";
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
  type VaultSnapshot,
  configureVault,
  exportToObsidian,
  generateContent,
  listContents,
  loadContent,
  loadVault,
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

/**
 * The local API states exactly which rule rejected the request ("Vault path
 * must be absolute", "The configured vault directory is unavailable"). Showing
 * the shared code label instead would hide the one fact the user needs to act,
 * and these messages carry no credential or remote data.
 */
function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const payload = error.payload as { error?: { message?: unknown } } | null;
    const message = payload?.error?.message;
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }
  return friendlyError(error, "操作失败");
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
  const [vault, setVault] = useState<VaultSnapshot | null>(null);
  const [vaultName, setVaultName] = useState("");
  const [vaultPath, setVaultPath] = useState("");

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

  const active = state.currentView === "workbench";

  useEffect(() => {
    if (!active) {
      return;
    }
    void (async () => {
      try {
        const current = await loadVault();
        setVault(current);
        if (current !== null) {
          setVaultName(current.name);
          setVaultPath(current.root_path);
        }
      } catch {
        // A vault that cannot be read is reported when an export is attempted;
        // failing the whole panel here would hide the rest of the workbench.
      }
    })();
  }, [active]);

  const saveVault = async (): Promise<void> => {
    if (vaultPath.trim() === "") {
      setMessage("请先填写 Vault 的绝对路径");
      return;
    }
    try {
      const saved = await configureVault(vaultName.trim(), vaultPath.trim());
      setVault(saved);
      setMessage(saved === null ? "Vault 未保存" : `已设置 Vault：${saved.name}`);
    } catch (error) {
      setMessage(errorText(error));
    }
  };

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
      setMessage("请先选择一本书");
      return;
    }
    if (vault === null) {
      setMessage("尚未配置 Obsidian Vault：请在下方填写 Vault 根目录并保存");
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
            <div className="field">
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
            </div>

            <div className="field">
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
            </div>

            <div className="field">
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
            </div>

            <div className="field">
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
            </div>

            <div className="field">
              <label htmlFor="workbench-platform">目标平台（可选）</label>
              <input
                id="workbench-platform"
                type="text"
                value={form.targetPlatform}
                onChange={(event) =>
                  setForm({ ...form, targetPlatform: event.target.value })
                }
              />
            </div>

            <div className="workbench-toggles">
              <label className="workbench-toggle" htmlFor="workbench-citations">
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

              <label
                className="workbench-toggle"
                htmlFor="workbench-first-person"
              >
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
            </div>

            <div className="workbench-actions">
              <button
                className="button button-primary"
                type="button"
                onClick={() => void submitGeneration()}
              >
                生成 / Generate
              </button>
              <button
                className="button button-secondary"
                type="button"
                onClick={() => void runExport()}
              >
                导出到 Obsidian
              </button>
            </div>
          </div>

          <section className="workbench-vault" aria-label="Obsidian Vault">
            <div className="workbench-vault-heading">
              <h3>Obsidian Vault</h3>
              <p
                className="workbench-vault-state"
                data-configured={vault !== null}
                data-testid="workbench-vault-state"
              >
                {vault === null ? "尚未配置" : `已配置：${vault.root_path}`}
              </p>
            </div>

            <div className="workbench-vault-form">
              <div className="field">
                <label htmlFor="workbench-vault-name">Vault 名称</label>
                <input
                  id="workbench-vault-name"
                  type="text"
                  value={vaultName}
                  placeholder="例如：My Vault"
                  onChange={(event) => setVaultName(event.target.value)}
                />
              </div>

              <div className="field">
                <label htmlFor="workbench-vault-path">Vault 根目录（绝对路径）</label>
                <input
                  id="workbench-vault-path"
                  type="text"
                  value={vaultPath}
                  placeholder="/Users/you/Obsidian/MyVault"
                  onChange={(event) => setVaultPath(event.target.value)}
                />
              </div>

              <button
                className="button button-secondary"
                type="button"
                onClick={() => void saveVault()}
              >
                保存 Vault
              </button>
            </div>

            <p className="field-help">
              导出只写入这个目录；你手改过的文件不会被覆盖，而是生成冲突文件。
            </p>
          </section>

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

              {/* `workbench-title` is already taken by the panel heading that
                  labels this section; a duplicate id would silently detach this
                  label from its input. */}
              <div className="field">
                <label htmlFor="workbench-draft-title">标题</label>
                <input
                  id="workbench-draft-title"
                  type="text"
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                />
              </div>

              <div className="field">
                <label htmlFor="workbench-body">正文</label>
                <textarea
                  id="workbench-body"
                  value={draftBody}
                  onChange={(event) => setDraftBody(event.target.value)}
                />
              </div>

              <button
                className="button button-primary"
                type="button"
                onClick={() => void persistEdit()}
              >
                保存为新修订
              </button>

              <section className="workbench-preview-block" aria-label="预览">
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
