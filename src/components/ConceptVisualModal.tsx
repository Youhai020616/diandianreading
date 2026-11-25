import React, { useCallback, useEffect, useState } from "react";
import type {
  ConceptBranch,
  ConceptVisualLayout,
  ConceptVisualPayload,
  ConceptVisualTheme,
} from "../types/desktop";
import { IconClose, IconCopy, IconDownload, IconPlus, IconTrash } from "./Icons";

interface ConceptVisualModalProps {
  open: boolean;
  draftTitle: string;
  draftContent: string;
  bookTitle?: string;
  onClose: () => void;
  onNotify: (msg: string, tone?: "info" | "success" | "error") => void;
}

const THEME_SWATCHES: Array<{ id: ConceptVisualTheme; label: string; dot: string }> = [
  { id: "editorial-paper", label: "奶油杂志", dot: "#B84324" },
  { id: "memo-grid", label: "手账便签", dot: "#EAB308" },
  { id: "botanical-mist", label: "森系青岚", dot: "#1F5A45" },
  { id: "nocturne-ink", label: "高级黑金", dot: "#1C1D22" },
];

export const ConceptVisualModal: React.FC<ConceptVisualModalProps> = ({
  open,
  draftTitle,
  draftContent,
  bookTitle,
  onClose,
  onNotify,
}) => {
  const [layout, setLayout] = useState<ConceptVisualLayout>("cover");
  const [theme, setTheme] = useState<ConceptVisualTheme>("editorial-paper");
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [callout, setCallout] = useState("");
  const [showColophon, setShowColophon] = useState(true);
  const [branches, setBranches] = useState<ConceptBranch[]>([]);
  const [previewHtml, setPreviewHtml] = useState("");
  const [baking, setBaking] = useState<"copy" | "save" | null>(null);

  useEffect(() => {
    if (!open) return;
    void window.diandian.cards
      .extractConcept({ title: draftTitle, content: draftContent, bookTitle })
      .then((extracted) => {
        setTitle(extracted.title);
        setSubtitle(extracted.subtitle);
        setCallout(extracted.callout ?? "");
        setBranches(extracted.branches);
      })
      .catch(() => {});
  }, [open, draftTitle, draftContent, bookTitle]);

  const buildPayload = useCallback((): ConceptVisualPayload => {
    return {
      layout,
      theme,
      title: title.trim() || draftTitle.trim() || "阅读思考框架",
      subtitle: subtitle.trim() || "读书笔记 · READING NOTES",
      ...(callout.trim() ? { callout: callout.trim() } : {}),
      branches: branches.filter((b) => b.heading.trim().length > 0).slice(0, 5),
      showColophon,
    };
  }, [layout, theme, title, draftTitle, subtitle, callout, branches, showColophon]);

  useEffect(() => {
    if (!open || branches.length === 0) return;
    let cancelled = false;
    void window.diandian.cards.previewConceptHtml(buildPayload()).then((res) => {
      if (!cancelled) setPreviewHtml(res.html);
    });
    return () => {
      cancelled = true;
    };
  }, [open, branches, buildPayload]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !baking) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, baking, onClose]);

  if (!open) return null;

  const updateBranchHeading = (idx: number, val: string) => {
    setBranches((prev) => prev.map((b, i) => (i === idx ? { ...b, heading: val } : b)));
  };

  const updateBranchPoint = (idx: number, val: string) => {
    setBranches((prev) =>
      prev.map((b, i) => (i === idx ? { ...b, points: val.trim() ? [val] : [] } : b)),
    );
  };

  const addBranch = () => {
    if (branches.length >= 5) return;
    setBranches((prev) => [...prev, { heading: "新增观点分支", points: ["补充一句核心论据或案例"] }]);
  };

  const removeBranch = (idx: number) => {
    if (branches.length <= 1) return;
    setBranches((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleBake = async (mode: "copy" | "save") => {
    setBaking(mode);
    try {
      const payload = buildPayload();
      if (mode === "copy") {
        const res = await window.diandian.cards.bakeCopyConcept(payload);
        const kindLabel = layout === "cover" ? "杂志封面" : layout === "mindmap" ? "结构导图" : "干货清单";
        onNotify(
          `已复制高清${kindLabel}（${res.width}×${res.height} PNG），可直接粘贴进小红书`,
          "success",
        );
      } else {
        const res = await window.diandian.cards.bakeSaveConcept(payload);
        if (!res.canceled) {
          onNotify(`已保存高清配图（${res.width}×${res.height} PNG）`, "success");
        }
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "渲染高清图失败", "error");
    } finally {
      setBaking(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => !baking && onClose()}>
      <div className="modal-card cvis-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ marginBottom: 14 }}>
          <div>
            <h3 style={{ margin: 0 }}>封面导图 / 概念信息图</h3>
            <div style={{ fontSize: 12.5, color: "var(--ink-muted)", marginTop: 3 }}>
              自动从当前草稿提炼核心框架，输出 1080×1440 高清 PNG，直接用作小红书首图或正文配图
            </div>
          </div>
          <button type="button" className="btn icon-only ghost" disabled={baking !== null} onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>

        <div className="cvis-grid">
          {/* Left Live Preview (exact sandboxed HTML/SVG scaled cleanly) */}
          <div className="cvis-stage">
            <div className="cvis-frame-shell">
              {previewHtml ? (
                <iframe
                  title="概念视觉预览"
                  sandbox=""
                  srcDoc={previewHtml}
                  className="cvis-iframe"
                />
              ) : (
                <div className="cvis-loading">正在提炼草稿框架…</div>
              )}
            </div>
          </div>

          {/* Right Controls */}
          <div className="cvis-controls">
            <div className="cvis-switch-row">
              <div className="cvis-seg">
                <button
                  type="button"
                  className={`cvis-seg-btn ${layout === "cover" ? "active" : ""}`}
                  onClick={() => setLayout("cover")}
                >
                  杂志封面
                </button>
                <button
                  type="button"
                  className={`cvis-seg-btn ${layout === "mindmap" ? "active" : ""}`}
                  onClick={() => setLayout("mindmap")}
                >
                  结构导图
                </button>
                <button
                  type="button"
                  className={`cvis-seg-btn ${layout === "infographic" ? "active" : ""}`}
                  onClick={() => setLayout("infographic")}
                >
                  干货清单
                </button>
              </div>

              <div className="cvis-themes">
                {THEME_SWATCHES.map((sw) => (
                  <button
                    key={sw.id}
                    type="button"
                    className={`cvis-theme-chip ${theme === sw.id ? "active" : ""}`}
                    onClick={() => setTheme(sw.id)}
                    title={sw.label}
                  >
                    <span className="cvis-theme-dot" style={{ background: sw.dot }} />
                    <span>{sw.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="field-group" style={{ marginBottom: 8 }}>
              <label className="field-label">主标题</label>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>

            <div className="field-group" style={{ marginBottom: 8 }}>
              <label className="field-label">副标题 / 书目出处</label>
              <input className="input" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} />
            </div>

            <div className="field-group" style={{ marginBottom: 8 }}>
              <label className="field-label">焦点金句 / 一句话洞察（可选）</label>
              <input
                className="input"
                value={callout}
                onChange={(e) => setCallout(e.target.value)}
                placeholder="提炼一句最戳人的核心判断…"
              />
            </div>

            <label className="cvis-colophon-toggle">
              <input
                type="checkbox"
                checked={showColophon}
                onChange={(e) => setShowColophon(e.target.checked)}
              />
              <span>显示底部极简署名（点点读书）</span>
            </label>

            <div className="cvis-branches-head">
              <span className="field-label" style={{ margin: 0 }}>
                框架节点（{branches.length}/5）
              </span>
              {branches.length < 5 && (
                <button type="button" className="btn sm ghost" onClick={addBranch}>
                  <IconPlus size={12} />
                  <span>加分支</span>
                </button>
              )}
            </div>

            <div className="cvis-branches-list">
              {branches.map((b, idx) => (
                <div key={idx} className="cvis-branch-row">
                  <div className="cvis-branch-inputs">
                    <input
                      className="input cvis-branch-title"
                      value={b.heading}
                      onChange={(e) => updateBranchHeading(idx, e.target.value)}
                      placeholder={`分支 ${idx + 1} 标题`}
                    />
                    <input
                      className="input cvis-branch-sub"
                      value={b.points[0] ?? ""}
                      onChange={(e) => updateBranchPoint(idx, e.target.value)}
                      placeholder="一句话要点（可选）"
                    />
                  </div>
                  {branches.length > 1 && (
                    <button
                      type="button"
                      className="btn icon-only ghost"
                      onClick={() => removeBranch(idx)}
                      title="删除分支"
                    >
                      <IconTrash size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="cvis-footer-actions">
              <button
                type="button"
                className="btn primary"
                style={{ flex: 1 }}
                disabled={baking !== null || branches.length === 0}
                onClick={() => void handleBake("copy")}
              >
                <IconCopy size={14} />
                <span>{baking === "copy" ? "烘焙高清图中…" : "复制高清 PNG（去贴小红书）"}</span>
              </button>
              <button
                type="button"
                className="btn"
                disabled={baking !== null || branches.length === 0}
                onClick={() => void handleBake("save")}
              >
                <IconDownload size={14} />
                <span>{baking === "save" ? "保存中…" : "存图"}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
