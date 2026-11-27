import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConceptBranch,
  ConceptVisualLayout,
  ConceptVisualPayload,
  ConceptVisualTheme,
} from "../types/desktop";
import { IconClose, IconCopy, IconDownload, IconPlus, IconTrash, IconUpload } from "./Icons";

interface ConceptVisualModalProps {
  open: boolean;
  draftTitle: string;
  draftContent: string;
  bookId?: string;
  bookTitle?: string;
  onClose: () => void;
  onNotify: (msg: string, tone?: "info" | "success" | "error") => void;
}

const LAYOUT_OPTIONS: Array<{ id: ConceptVisualLayout; label: string; hint: string }> = [
  { id: "cover", label: "书封首图", hint: "立体书封 + 大字报标题，最适合做小红书第 1 张吸睛首图" },
  { id: "versus", label: "认知反差", hint: "误区 vs 真相对撞卡，高收藏率反常识结构" },
  { id: "mindmap", label: "视觉笔记", hint: "手绘感胶带四宫格导图，告别死板流程图" },
  { id: "infographic", label: "杂志书摘", hint: "单读风极简纸本排版，适合多要点深度拆解" },
];

const THEME_SWATCHES: Array<{ id: ConceptVisualTheme; label: string; dot: string }> = [
  { id: "editorial-paper", label: "奶油单读", dot: "#B83B1D" },
  { id: "memo-grid", label: "手账方格", dot: "#EAB308" },
  { id: "botanical-mist", label: "森系青岚", dot: "#1B5942" },
  { id: "cloud-blue", label: "冰川杂志", dot: "#2563EB" },
  { id: "nocturne-ink", label: "黑金夜读", dot: "#1C1D22" },
];

async function compressImageFileToDataUrl(file: File): Promise<string> {
  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("解析封面图片失败"));
    el.src = rawDataUrl;
  });

  const maxW = 480;
  const maxH = 680;
  const scale = Math.min(1, maxW / Math.max(1, img.naturalWidth), maxH / Math.max(1, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return rawDataUrl;
  // JPEG has no alpha: paint paper white so transparent PNG covers do not turn black.
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.9);
}

export const ConceptVisualModal: React.FC<ConceptVisualModalProps> = ({
  open,
  draftTitle,
  draftContent,
  bookId,
  bookTitle,
  onClose,
  onNotify,
}) => {
  const [layout, setLayout] = useState<ConceptVisualLayout>("cover");
  const [theme, setTheme] = useState<ConceptVisualTheme>("editorial-paper");
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [resolvedBookTitle, setResolvedBookTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [defaultCoverUrl, setDefaultCoverUrl] = useState<string | undefined>(undefined);
  const [coverDataUrl, setCoverDataUrl] = useState<string | undefined>(undefined);
  const [showBookCover, setShowBookCover] = useState(true);
  const [callout, setCallout] = useState("");
  const [showColophon, setShowColophon] = useState(true);
  const [branches, setBranches] = useState<ConceptBranch[]>([]);
  const [previewHtml, setPreviewHtml] = useState("");
  const [baking, setBaking] = useState<"copy" | "save" | null>(null);
  const coverInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    // Drop the previous draft's framework and cover so they never flash in this draft's preview.
    setBranches([]);
    setPreviewHtml("");
    setDefaultCoverUrl(undefined);
    setCoverDataUrl(undefined);
    void window.diandian.cards
      .extractConcept({ title: draftTitle, content: draftContent, bookId, bookTitle })
      .then((extracted) => {
        if (!active) return;
        setTitle(extracted.title);
        setSubtitle(extracted.subtitle);
        // The extractor already rejected site names like "微信读书"; do not fall back to the raw value.
        setResolvedBookTitle(extracted.bookTitle ?? "");
        setAuthor(extracted.author ?? "");
        setDefaultCoverUrl(extracted.coverDataUrl);
        setCoverDataUrl(extracted.coverDataUrl);
        setCallout(extracted.callout ?? "");
        setBranches(extracted.branches);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [open, draftTitle, draftContent, bookId, bookTitle]);

  const buildPayload = useCallback((): ConceptVisualPayload => {
    return {
      layout,
      theme,
      title: title.trim() || draftTitle.trim() || "阅读思考框架",
      subtitle: subtitle.trim() || "读书笔记 · READING NOTES",
      ...(resolvedBookTitle.trim() ? { bookTitle: resolvedBookTitle.trim() } : {}),
      ...(author.trim() ? { author: author.trim() } : {}),
      ...(coverDataUrl ? { coverDataUrl } : {}),
      showBookCover,
      ...(callout.trim() ? { callout: callout.trim() } : {}),
      branches: branches.filter((b) => b.heading.trim().length > 0).slice(0, 5),
      showColophon,
    };
  }, [
    layout,
    theme,
    title,
    draftTitle,
    subtitle,
    resolvedBookTitle,
    author,
    coverDataUrl,
    showBookCover,
    callout,
    branches,
    showColophon,
  ]);

  useEffect(() => {
    if (!open || branches.length === 0) return;
    let cancelled = false;
    // Debounced: the payload can carry a few hundred KB of cover image per round trip.
    const timer = window.setTimeout(() => {
      void window.diandian.cards
        .previewConceptHtml(buildPayload())
        .then((res) => {
          if (!cancelled) setPreviewHtml(res.html);
        })
        .catch(() => {});
    }, 160);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
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
    setBranches((prev) => [...prev, { heading: "新增核心洞察", points: ["补充一句关键论据或个人体感"] }]);
  };

  const removeBranch = (idx: number) => {
    if (branches.length <= 1) return;
    setBranches((prev) => prev.filter((_, i) => i !== idx));
  };

  const handlePickCustomCover = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const dataUrl = await compressImageFileToDataUrl(file);
      setCoverDataUrl(dataUrl);
      setShowBookCover(true);
      onNotify("已替换为自定义书封图片", "success");
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "读取封面图失败", "error");
    }
  };

  const handleBake = async (mode: "copy" | "save") => {
    setBaking(mode);
    try {
      const payload = buildPayload();
      const kindLabel = LAYOUT_OPTIONS.find((item) => item.id === layout)?.label ?? "小红书配图";
      if (mode === "copy") {
        const res = await window.diandian.cards.bakeCopyConcept(payload);
        onNotify(
          `已复制高清「${kindLabel}」（${res.width}×${res.height} PNG），可直接粘贴进小红书`,
          "success",
        );
      } else {
        const res = await window.diandian.cards.bakeSaveConcept(payload);
        if (!res.canceled) {
          onNotify(`已保存高清「${kindLabel}」（${res.width}×${res.height} PNG）`, "success");
        }
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "渲染高清图失败", "error");
    } finally {
      setBaking(null);
    }
  };

  const activeLayoutHint = LAYOUT_OPTIONS.find((item) => item.id === layout)?.hint ?? "";
  const supportsCoverToggle = layout === "cover" || layout === "infographic";

  const branchPlaceholder = (idx: number): string => {
    if (layout === "versus") {
      if (idx === 0) return "误区 / 多数人的直觉";
      if (idx === 1) return "真相 / 书里的底层逻辑";
      return "延伸行动启示（可选）";
    }
    return `洞察 ${idx + 1} 标题`;
  };

  return (
    <div className="modal-backdrop" onClick={() => !baking && onClose()}>
      <div className="modal-card cvis-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0 }}>小红书封面与视觉配图工坊</h3>
            <div style={{ fontSize: 12.5, color: "var(--ink-muted)", marginTop: 3 }}>
              3:4 原生竖版（1080×1440 Retina PNG）· 自动融合真实立体书封与杂志级排版
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
                  title="小红书视觉预览"
                  sandbox=""
                  srcDoc={previewHtml}
                  className="cvis-iframe"
                />
              ) : (
                <div className="cvis-loading">正在提炼草稿与匹配书封…</div>
              )}
            </div>
            {activeLayoutHint && <div className="cvis-stage-caption">{activeLayoutHint}</div>}
          </div>

          {/* Right Controls */}
          <div className="cvis-controls">
            <div className="cvis-switch-row">
              <div className="cvis-seg">
                {LAYOUT_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`cvis-seg-btn ${layout === opt.id ? "active" : ""}`}
                    onClick={() => setLayout(opt.id)}
                  >
                    {opt.label}
                  </button>
                ))}
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
              <label className="field-label">大字报主标题（建议 8–18 字最有张力）</label>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 8, marginBottom: 8 }}>
              <div className="field-group" style={{ marginBottom: 0 }}>
                <label className="field-label">副标题 / 栏目感眉题</label>
                <input className="input" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} />
              </div>
              <div className="field-group" style={{ marginBottom: 0 }}>
                <label className="field-label">书名锚点（用于立体书封）</label>
                <input
                  className="input"
                  value={resolvedBookTitle}
                  onChange={(e) => setResolvedBookTitle(e.target.value)}
                  placeholder="如：认知觉醒"
                />
              </div>
            </div>

            <div className="field-group" style={{ marginBottom: 8 }}>
              <label className="field-label">焦点金句 / 行动结论（可选）</label>
              <input
                className="input"
                value={callout}
                onChange={(e) => setCallout(e.target.value)}
                placeholder="提炼一句最戳人的原书金句或结论…"
              />
            </div>

            <div className="cvis-toggles-bar">
              {supportsCoverToggle && (
                <div className="cvis-cover-bar">
                  <label className="cvis-colophon-toggle" style={{ marginBottom: 0 }}>
                    <input
                      type="checkbox"
                      checked={showBookCover}
                      onChange={(e) => setShowBookCover(e.target.checked)}
                    />
                    <span>展示 3D 立体书封</span>
                  </label>
                  <input
                    ref={coverInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={(e) => void handlePickCustomCover(e)}
                  />
                  <button
                    type="button"
                    className="btn sm ghost"
                    onClick={() => coverInputRef.current?.click()}
                    title="上传自定义书籍封面或实拍配图"
                  >
                    <IconUpload size={11} />
                    <span>{coverDataUrl ? "换书封图" : "上传书封图"}</span>
                  </button>
                  {coverDataUrl && coverDataUrl !== defaultCoverUrl && (
                    <button
                      type="button"
                      className="btn sm ghost"
                      onClick={() => setCoverDataUrl(defaultCoverUrl)}
                    >
                      恢复默认
                    </button>
                  )}
                </div>
              )}

              <label className="cvis-colophon-toggle" style={{ marginBottom: 0 }}>
                <input
                  type="checkbox"
                  checked={showColophon}
                  onChange={(e) => setShowColophon(e.target.checked)}
                />
                <span>底部署名</span>
              </label>
            </div>

            <div className="cvis-branches-head">
              <span className="field-label" style={{ margin: 0 }}>
                {layout === "versus" ? "正反观点对撞（前两项为误区 vs 真相）" : `核心洞察节点（${branches.length}/5）`}
              </span>
              {branches.length < 5 && (
                <button type="button" className="btn sm ghost" onClick={addBranch}>
                  <IconPlus size={12} />
                  <span>加节点</span>
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
                      placeholder={branchPlaceholder(idx)}
                    />
                    <input
                      className="input cvis-branch-sub"
                      value={b.points[0] ?? ""}
                      onChange={(e) => updateBranchPoint(idx, e.target.value)}
                      placeholder="一句话展开说明（可选）"
                    />
                  </div>
                  {branches.length > 1 && (
                    <button
                      type="button"
                      className="btn icon-only ghost"
                      onClick={() => removeBranch(idx)}
                      title="删除节点"
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
