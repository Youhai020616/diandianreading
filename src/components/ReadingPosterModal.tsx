import React, { useCallback, useEffect, useState } from "react";
import type { MonthlyPosterPayload, PosterThemeId, ReadingStatsSummary } from "../types/desktop";
import { CustomSelect } from "./CustomSelect";
import { IconClose, IconCopy, IconDownload, IconRefresh } from "./Icons";

interface ReadingPosterModalProps {
  open: boolean;
  onClose: () => void;
  onNotify: (msg: string, tone?: "info" | "success" | "error") => void;
}

export const ReadingPosterModal: React.FC<ReadingPosterModalProps> = ({ open, onClose, onNotify }) => {
  const [monthKey, setMonthKey] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [posterTheme, setPosterTheme] = useState<PosterThemeId>("editorial-paper");
  const [posterHeadline, setPosterHeadline] = useState("我的阅读月报");
  const [posterKeywordsText, setPosterKeywordsText] = useState("深度阅读, 长期主义, 个人表达");
  const [posterWatermark, setPosterWatermark] = useState(true);
  const [stats, setStats] = useState<ReadingStatsSummary | null>(null);
  const [baking, setBaking] = useState<"copy" | "save" | null>(null);

  const loadStats = useCallback(async (mk: string) => {
    try {
      const s = await window.diandian.library.readingStats(mk);
      setStats(s);
      if (s.suggestedKeywords.length > 0) {
        setPosterKeywordsText(s.suggestedKeywords.join(", "));
      }
    } catch {
      // Non-fatal
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadStats(monthKey);
  }, [open, monthKey, loadStats]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !baking) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, baking, onClose]);

  if (!open) return null;

  const posterPreview: MonthlyPosterPayload = {
    themeId: posterTheme,
    monthLabel: monthKey.replace("-", " · "),
    headline: posterHeadline.trim() || "我的阅读月报",
    booksCount: stats?.monthBooksCount || stats?.totalBooks || 0,
    highlightsCount: stats?.monthHighlightsCount || stats?.totalHighlights || 0,
    draftsCount: stats?.totalDrafts || 0,
    books: (stats?.monthBooks ?? []).map((b) => ({ title: b.title, author: b.author })),
    quotes: (stats?.featuredQuotes ?? []).map((q) => ({ quote: q.quote, bookTitle: q.bookTitle })),
    keywords: posterKeywordsText
      .split(/[,，、\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 6),
    showWatermark: posterWatermark,
  };

  const handleBakePoster = async (mode: "copy" | "save") => {
    setBaking(mode);
    try {
      if (mode === "copy") {
        const res = await window.diandian.cards.bakeCopyPoster(posterPreview);
        onNotify(`已复制高清阅读月报海报（${res.width}×${res.height} PNG）到剪贴板`, "success");
      } else {
        const res = await window.diandian.cards.bakeSavePoster(posterPreview);
        if (!res.canceled) {
          onNotify(`已保存阅读月报海报（${res.width}×${res.height} PNG）`, "success");
        }
      }
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "月报渲染失败", "error");
    } finally {
      setBaking(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => !baking && onClose()}>
      <div className="modal-card poster-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ marginBottom: 14 }}>
          <div>
            <h3 style={{ margin: 0 }}>本月阅读海报</h3>
            <div style={{ fontSize: 12.5, color: "var(--ink-muted)", marginTop: 3 }}>
              汇总本月的笔记书目、划线和创作草稿进度（3:4 · 2× 高清 PNG）
            </div>
          </div>
          <button type="button" className="btn icon-only ghost" disabled={baking !== null} onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>

        <div className="poster-modal-grid">
          <div className="poster-modal-stage">
            <div className={`live-card poster-preview-card tpl-${posterTheme}`}>
              <div className="poster-preview-inner">
                <div className="live-card-eyebrow poster-preview-head">
                  <span style={{ fontWeight: 700 }}>{posterPreview.headline}</span>
                  <span>{posterPreview.monthLabel}</span>
                </div>

                <div className="poster-preview-stats">
                  <div className="poster-preview-stat">
                    <div className="poster-preview-stat-num">{posterPreview.booksCount}</div>
                    <div className="poster-preview-stat-label">书目</div>
                  </div>
                  <div className="poster-preview-stat">
                    <div className="poster-preview-stat-num">{posterPreview.highlightsCount}</div>
                    <div className="poster-preview-stat-label">划线</div>
                  </div>
                  <div className="poster-preview-stat">
                    <div className="poster-preview-stat-num">{posterPreview.draftsCount}</div>
                    <div className="poster-preview-stat-label">草稿</div>
                  </div>
                </div>

                {posterPreview.books.length > 0 && (
                  <div className="poster-preview-books">
                    {posterPreview.books.slice(0, 3).map((b, i) => (
                      <span key={i} className="poster-preview-book-pill">
                        《{b.title.slice(0, 12)}》
                      </span>
                    ))}
                    {posterPreview.books.length > 3 && (
                      <span className="poster-preview-book-pill">
                        +{posterPreview.books.length - 3}
                      </span>
                    )}
                  </div>
                )}

                <div className="poster-preview-quotes">
                  {(posterPreview.quotes.length > 0
                    ? posterPreview.quotes.slice(0, 2)
                    : [{ quote: "把读过的书，变成自己看世界的坐标系。", bookTitle: "点点读书" }]
                  ).map((q, i) => (
                    <div key={i} className="poster-preview-quote-card">
                      <div className="poster-preview-quote-text">“{q.quote}”</div>
                      <div className="poster-preview-quote-src">—— 《{q.bookTitle}》</div>
                    </div>
                  ))}
                </div>

                <div className="poster-preview-kws">
                  {posterPreview.keywords.slice(0, 4).map((k, i) => (
                    <span key={i} className="poster-preview-kw">
                      # {k}
                    </span>
                  ))}
                </div>

                <div className="live-card-footer" style={{ paddingTop: 6 }}>
                  <span className="live-card-brand">{posterWatermark ? "点点读书 · Monthly Digest" : "Monthly Digest"}</span>
                  <span className="live-card-brand">3:4 HD</span>
                </div>
              </div>
            </div>
          </div>

          <div className="poster-modal-controls">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span className="field-label">海报设置</span>
              <button type="button" className="btn sm ghost" onClick={() => void loadStats(monthKey)}>
                <IconRefresh size={12} />
                <span>刷新月报数据</span>
              </button>
            </div>

            <div className="field-group">
              <label className="field-label">统计月份</label>
              <input
                type="month"
                className="input"
                value={monthKey}
                onChange={(e) => setMonthKey(e.target.value)}
              />
            </div>

            <div className="field-group">
              <label className="field-label">海报配色</label>
              <CustomSelect
                value={posterTheme}
                onChange={(val) => setPosterTheme(val as PosterThemeId)}
                ariaLabel="海报配色"
                options={[
                  { value: "editorial-paper", label: "墨韵宣纸（经典刊物）", description: "温润纸色 · 经典书卷质感" },
                  { value: "nocturne-ink", label: "深夜典藏（黑金质感）", description: "深墨底色 · 高级鎏金点缀" },
                  { value: "botanical-green", label: "青苔月刊（清新森系）", description: "淡雅森绿 · 通透柔和" },
                ]}
              />
            </div>

            <div className="field-group">
              <label className="field-label">月报主标题</label>
              <input
                className="input"
                value={posterHeadline}
                onChange={(e) => setPosterHeadline(e.target.value)}
              />
            </div>

            <div className="field-group">
              <label className="field-label">本月思考关键词</label>
              <input
                className="input"
                value={posterKeywordsText}
                onChange={(e) => setPosterKeywordsText(e.target.value)}
                placeholder="深度阅读, 长期主义, 系统思考"
              />
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--ink-secondary)", marginBottom: 14 }}>
              <input
                type="checkbox"
                checked={posterWatermark}
                onChange={(e) => setPosterWatermark(e.target.checked)}
              />
              底部展示「点点读书」刊物署名
            </label>

            <div style={{ display: "flex", gap: 8, marginTop: "auto" }}>
              <button
                type="button"
                className="btn primary"
                style={{ flex: 1 }}
                disabled={baking !== null}
                onClick={() => void handleBakePoster("copy")}
              >
                <IconCopy size={14} />
                <span>{baking === "copy" ? "生成中…" : "复制高清月报"}</span>
              </button>
              <button
                type="button"
                className="btn"
                disabled={baking !== null}
                onClick={() => void handleBakePoster("save")}
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
