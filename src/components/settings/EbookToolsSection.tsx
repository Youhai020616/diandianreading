import React, { useRef, useState } from "react";
import type { LocalBookMetadata } from "../../types/desktop";
import { IconCheck, IconFolder, IconSearch, IconUpload, IconWand } from "../Icons";

interface EbookToolsSectionProps {
  /** Whether the installed CLI can read and write book metadata. */
  supportsMeta: boolean;
  onBookMetadataChanged(previousPath: string, updatedPath: string, title: string): void;
  onNotify(msg: string, tone?: "info" | "success" | "error"): void;
}

/** Pick a local ebook, fix its title/author/ISBN, or send it to Kindle or WeRead. */
export const EbookToolsSection: React.FC<EbookToolsSectionProps> = ({ supportsMeta, onBookMetadataChanged, onNotify }) => {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [selectedEbookPath, setSelectedEbookPath] = useState("");
  const [routerLog, setRouterLog] = useState("");

  // Local EPUB/PDF metadata repair (zlib v0.0.16+ meta)
  const [metaDraft, setMetaDraft] = useState<LocalBookMetadata | null>(null);
  const [metaMatches, setMetaMatches] = useState<LocalBookMetadata[]>([]);
  const [renameOnApply, setRenameOnApply] = useState(false);
  // What the file currently contains, so adopted or typed changes read as unsaved.
  const [metaSaved, setMetaSaved] = useState<LocalBookMetadata | null>(null);
  const metaEditorRef = useRef<HTMLDivElement>(null);

  const handlePickEbook = async () => {
    const res = await window.diandian.router.pickEbookFile();
    if (!res.canceled) {
      setSelectedEbookPath(res.filePath);
      setMetaDraft(null);
      setMetaSaved(null);
      setMetaMatches([]);
      setRouterLog("");
    }
  };

  const revealMetaEditor = () => {
    requestAnimationFrame(() => {
      metaEditorRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      metaEditorRef.current?.querySelector("input")?.focus({ preventScroll: true });
    });
  };

  const openMetaEditor = (metadata: LocalBookMetadata) => {
    setMetaDraft(metadata);
    setMetaSaved(metadata);
  };

  const handleReadLocalMeta = async () => {
    if (!selectedEbookPath) return;
    setBusyAction("meta-read");
    try {
      openMetaEditor(await window.diandian.router.readBookMeta(selectedEbookPath));
      setMetaMatches([]);
      revealMetaEditor();
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "无法读取这本书的信息", "error");
    } finally {
      setBusyAction(null);
    }
  };

  const handleFetchLocalMeta = async () => {
    if (!selectedEbookPath) return;
    setBusyAction("meta-fetch");
    try {
      // Show the file's own information next to the matches so they can be compared before saving.
      if (!metaDraft) {
        const current = await window.diandian.router.readBookMeta(selectedEbookPath).catch(() => null);
        if (current) openMetaEditor(current);
      }
      const list = await window.diandian.router.fetchBookMetaMatches(selectedEbookPath, [
        "douban",
        "weread",
        "openlibrary",
        "google",
      ]);
      setMetaMatches(list);
      if (list.length === 0) {
        onNotify("没有在线找到这本书的信息，可以在下方手动填写后保存。", "info");
      } else {
        onNotify(`找到 ${list.length} 个可能的版本，点「采用」后记得保存到文件。`, "success");
      }
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "在线查找失败，请稍后重试", "error");
    } finally {
      setBusyAction(null);
    }
  };

  const adoptMetaMatch = (match: LocalBookMetadata) => {
    setMetaDraft(match);
    revealMetaEditor();
  };

  const handleApplyLocalMeta = async () => {
    if (!selectedEbookPath || !metaDraft) return;
    setBusyAction("meta-apply");
    try {
      const res = await window.diandian.router.applyBookMeta({
        filePath: selectedEbookPath,
        ...metaDraft,
        rename: renameOnApply,
      });
      setSelectedEbookPath(res.filePath);
      openMetaEditor(res.metadata);
      onBookMetadataChanged(selectedEbookPath, res.filePath, res.metadata.title);
      setRouterLog(res.output);
      onNotify(`已更新《${res.metadata.title || "这本书"}》的书籍信息`, "success");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "保存失败，原文件未改动", "error");
    } finally {
      setBusyAction(null);
    }
  };

  const handleDispatchEbook = async (target: "kindle" | "weread") => {
    if (!selectedEbookPath) return;
    setBusyAction(target);
    try {
      if (target === "kindle") {
        const res = await window.diandian.router.sendKindle(selectedEbookPath);
        setRouterLog(res.output);
        onNotify("已发送到 Kindle", "success");
      } else {
        const res = await window.diandian.router.importWeRead(selectedEbookPath);
        setRouterLog(res.output);
        onNotify(res.alreadyExisted ? "微信读书书架里已经有这本书了" : "已导入微信读书书架", res.alreadyExisted ? "info" : "success");
      }
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "发送失败，请稍后重试", "error");
    } finally {
      setBusyAction(null);
    }
  };

  const metaDirty = metaDraft !== null && metaSaved !== null
    && (["title", "authors", "publisher", "isbn", "date"] as const).some(key => metaDraft[key] !== metaSaved[key]);

  return (
    <>
      <div className="pref-section-label">整理书籍信息，发送到 Kindle 或微信读书</div>
      <section className="editorial-card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            className="input"
            readOnly
            value={selectedEbookPath}
            placeholder="先选择一本电子书（EPUB、PDF、MOBI、AZW3）"
            aria-label="已选择的电子书"
          />
          <button type="button" className="btn" onClick={() => void handlePickEbook()}>
            <IconFolder size={14} />
            <span>选择文件</span>
          </button>
        </div>
        {!selectedEbookPath && (
          <div style={{ fontSize: 12, color: "var(--ink-muted)", marginTop: -6 }}>
            选好文件后，可以修改它的书名、作者等信息，也可以直接发送到 Kindle 或微信读书。
          </div>
        )}

        {supportsMeta && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-secondary)" }}>书籍信息</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              <button
                type="button"
                className="btn sm soft"
                disabled={!selectedEbookPath || busyAction !== null}
                onClick={() => void handleReadLocalMeta()}
              >
                <IconWand size={13} />
                <span>{busyAction === "meta-read" ? "读取中…" : "编辑书名和作者"}</span>
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={!selectedEbookPath || busyAction !== null}
                onClick={() => void handleFetchLocalMeta()}
              >
                <IconSearch size={13} />
                <span>{busyAction === "meta-fetch" ? "查找中…" : "在线查找书籍信息"}</span>
              </button>
            </div>

            {metaMatches.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>
                  可能的版本：点「采用」填入下方，确认后点「保存到文件」。
                </div>
                {metaMatches.slice(0, 5).map((m, idx) => (
                  <div
                    key={`mm-${idx}`}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 8,
                      padding: "8px 10px",
                      borderRadius: 8,
                      border: "1px solid var(--border)",
                      background: "var(--surface-tint)",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 12.5 }}>{m.title}</div>
                      <div style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                        {[m.authors, m.publisher, m.date, m.isbn].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <button type="button" className="btn sm soft" onClick={() => adoptMetaMatch(m)}>
                      采用
                    </button>
                  </div>
                ))}
              </div>
            )}

            {metaDraft && (
              <div
                ref={metaEditorRef}
                style={{
                  padding: 12,
                  borderRadius: 10,
                  border: `1px solid ${metaDirty ? "var(--accent-border)" : "var(--border)"}`,
                  background: "var(--surface-tint)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  scrollMarginBlock: 16,
                }}
              >
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div className="field-group" style={{ marginBottom: 0 }}>
                    <label className="field-label">书名</label>
                    <input
                      className="input"
                      value={metaDraft.title}
                      onChange={(e) => setMetaDraft((d) => (d ? { ...d, title: e.target.value } : d))}
                    />
                  </div>
                  <div className="field-group" style={{ marginBottom: 0 }}>
                    <label className="field-label">作者（多位用 &amp; 分隔）</label>
                    <input
                      className="input"
                      value={metaDraft.authors}
                      onChange={(e) => setMetaDraft((d) => (d ? { ...d, authors: e.target.value } : d))}
                    />
                  </div>
                  <div className="field-group" style={{ marginBottom: 0 }}>
                    <label className="field-label">出版社</label>
                    <input
                      className="input"
                      value={metaDraft.publisher}
                      onChange={(e) => setMetaDraft((d) => (d ? { ...d, publisher: e.target.value } : d))}
                    />
                  </div>
                  <div className="field-group" style={{ marginBottom: 0 }}>
                    <label className="field-label">出版日期</label>
                    <input
                      className="input"
                      value={metaDraft.date}
                      onChange={(e) => setMetaDraft((d) => (d ? { ...d, date: e.target.value } : d))}
                    />
                  </div>
                  <div className="field-group" style={{ marginBottom: 0 }}>
                    <label className="field-label">ISBN</label>
                    <input
                      className="input"
                      value={metaDraft.isbn}
                      onChange={(e) => setMetaDraft((d) => (d ? { ...d, isbn: e.target.value } : d))}
                    />
                  </div>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ink-secondary)" }}>
                    <input
                      type="checkbox"
                      checked={renameOnApply}
                      onChange={(e) => setRenameOnApply(e.target.checked)}
                    />
                    同时把文件名改成「书名 - 作者」
                  </label>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {metaDirty && <span style={{ fontSize: 12, color: "var(--amber)" }}>修改尚未保存到文件</span>}
                    <button
                      type="button"
                      className="btn sm primary"
                      disabled={busyAction !== null}
                      onClick={() => void handleApplyLocalMeta()}
                    >
                      <IconCheck size={12} />
                      <span>{busyAction === "meta-apply" ? "保存中…" : "保存到文件"}</span>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-secondary)" }}>发送</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <button
              type="button"
              className="btn sm primary"
              disabled={!selectedEbookPath || busyAction !== null}
              onClick={() => void handleDispatchEbook("kindle")}
            >
              <IconUpload size={13} />
              <span>{busyAction === "kindle" ? "发送中…" : "推送到 Kindle"}</span>
            </button>
            <button
              type="button"
              className="btn sm sage"
              disabled={!selectedEbookPath || busyAction !== null}
              onClick={() => void handleDispatchEbook("weread")}
            >
              <IconUpload size={13} />
              <span>{busyAction === "weread" ? "导入中…" : "导入微信读书书架"}</span>
            </button>
          </div>
        </div>

        {routerLog && (
          <details style={{ fontSize: 12, color: "var(--ink-muted)" }}>
            <summary style={{ cursor: "pointer" }}>查看详细输出</summary>
            <pre className="md-code-block" style={{ margin: "8px 0 0" }}>
              {routerLog}
            </pre>
          </details>
        )}
      </section>
    </>
  );
};
