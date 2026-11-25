export type ConceptVisualLayout = "cover" | "mindmap" | "infographic";
export type ConceptVisualTheme =
  | "editorial-paper"
  | "memo-grid"
  | "botanical-mist"
  | "nocturne-ink"
  | "cloud-blue";

export interface ConceptBranch {
  heading: string;
  points: string[];
}

export interface ConceptVisualPayload {
  layout: ConceptVisualLayout;
  theme: ConceptVisualTheme;
  title: string;
  subtitle: string;
  callout?: string;
  branches: ConceptBranch[];
  showColophon?: boolean;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanLine(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^[#>*•\-]+\s*/, "")
    .replace(/^\d+[.)、]\s*/, "")
    .trim();
}

function isBareNumeralHeading(heading: string): boolean {
  return /^(第?[一二三四五六七八九十百\d]+[、.．]?|0?\d+)$/.test(heading.trim());
}

function isChatFillerParagraph(text: string): boolean {
  return (
    /(已|已经)(存|记|写|添|保存)(入|进)?(本地)?书库|新建书目|章节都?归到/.test(text)
    || /(要是你想|如果你想|往下滚一屏|再叫我|需要的话我可以|存进创作工作台)/.test(text)
  );
}

/**
 * Distill a punchy 10-18 char Xiaohongshu-style sub-headline from a paragraph
 * when the Markdown heading was just a bare numeral like "一 / 二 / 三".
 */
function distillPunchyHeading(sentence: string): { heading: string; rest: string } {
  const clean = sentence.replace(/\s+/g, " ").trim();
  const sentences = clean
    .split(/(?<=[。！？!?])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const first = (sentences[0] ?? clean).replace(/[。！？!?]+$/, "").trim();
  const remainder = sentences.slice(1).join("").trim();

  // If the first sentence is already concise enough for a punchy card heading, keep it whole (never chop mid-word)
  if (first.length <= 24) {
    return { heading: first, rest: remainder };
  }

  const clauses = first
    .split(/[，,；;：:—–]+/)
    .map((c) => c.trim())
    .filter((c) => c.length >= 4);

  // Prefer the second clause when the first is a setup like "这句话表面在讲..."
  const bestClause =
    clauses.length >= 2 && /^(这句|这个|表面|其实|所以|但是|而)/.test(clauses[0]!) && clauses[1]!.length <= 24
      ? clauses[1]!
      : clauses.find((c) => c.length >= 6 && c.length <= 24) ?? first.slice(0, 22);

  const restCandidate = remainder || (first !== bestClause ? first : "");
  return {
    heading: bestClause.replace(/[，,；;：:、\-—]+$/, "").trim(),
    rest: restCandidate.slice(0, 68),
  };
}

/**
 * Deterministically parse a draft's Markdown headings, lists, and blockquotes into
 * structured, XHS-ready branches (never leaving bare "一 / 二 / 三" headings).
 */
export function extractConceptVisualFromDraft(
  title: string,
  content: string,
  bookTitle?: string,
): Omit<ConceptVisualPayload, "layout" | "theme"> {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const rawSections: Array<{
    heading: string;
    bareNumeral: boolean;
    quotes: string[];
    points: string[];
  }> = [];
  let current: (typeof rawSections)[number] | null = null;
  let callout = "";

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith(">")) {
      const q = cleanLine(trimmed);
      if (q.length >= 8) {
        if (!callout) callout = q.slice(0, 68);
        if (current) current.quotes.push(q);
      }
      continue;
    }

    const hMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    const boldSectionMatch = !hMatch ? /^\*\*([一二三四五六七八九十\d]{1,3})\*\*$/.exec(trimmed) : null;
    if (hMatch?.[2] || boldSectionMatch?.[1]) {
      const h = cleanLine(hMatch?.[2] ?? boldSectionMatch?.[1] ?? "");
      if (h && h !== title.trim()) {
        current = {
          heading: h.slice(0, 24),
          bareNumeral: isBareNumeralHeading(h),
          quotes: [],
          points: [],
        };
        rawSections.push(current);
      }
      continue;
    }

    const listMatch = /^(?:[-*•]|\d+[.)、])\s+(.+)$/.exec(trimmed);
    if (listMatch?.[1]) {
      const pt = cleanLine(listMatch[1]).slice(0, 64);
      if (!pt || isChatFillerParagraph(pt)) continue;
      if (!current) {
        current = { heading: "核心要点", bareNumeral: false, quotes: [], points: [] };
        rawSections.push(current);
      }
      if (current.points.length < 3) {
        current.points.push(pt);
      }
      continue;
    }

    const plain = cleanLine(trimmed);
    if (plain.length < 4 || isChatFillerParagraph(plain)) continue;
    if (current) {
      if (current.points.length < 3) {
        current.points.push(plain.slice(0, 88));
      }
    } else {
      const distilled = distillPunchyHeading(plain);
      rawSections.push({
        heading: distilled.heading,
        bareNumeral: false,
        quotes: [],
        points: distilled.rest ? [distilled.rest] : [],
      });
    }
  }

  // Upgrade bare-numeral sections ("一 / 二 / 三") using their own commentary or quote
  const branches: ConceptBranch[] = [];
  for (const sec of rawSections) {
    if (sec.bareNumeral) {
      const source = sec.points[0] || sec.quotes[0] || "";
      if (!source) continue;
      const distilled = distillPunchyHeading(source);
      const secondary =
        sec.points.length > 1
          ? sec.points[1]!
          : distilled.rest && distilled.rest !== distilled.heading
            ? distilled.rest
            : sec.quotes[0] && sec.quotes[0] !== source
              ? sec.quotes[0]
              : "";
      branches.push({
        heading: distilled.heading.slice(0, 26),
        points: secondary ? [secondary.slice(0, 64)] : [],
      });
    } else {
      const cleanPoints = sec.points
        .map((p) => {
          const firstSent = p.split(/(?<=[。！？!?])/)[0]?.trim() || p;
          return firstSent.slice(0, 64);
        })
        .filter(Boolean)
        .slice(0, 2);
      branches.push({
        heading: sec.heading.replace(/^[一二三四五六七八九十]+[、.．]\s*/, "").slice(0, 26),
        points: cleanPoints,
      });
    }
  }

  const finalBranches =
    branches.length > 0
      ? branches.slice(0, 5)
      : [
          { heading: "核心命题", points: ["提炼文章最关键的判断与洞察"] },
          { heading: "关键论据", points: ["结合原书案例与个人亲历验证"] },
          { heading: "行动坐标", points: ["把抽象观点落回真实生活决策"] },
        ];

  const cleanTitle = (title.trim() || "阅读思考框架").slice(0, 28);
  const subtitle = bookTitle
    ? `《${bookTitle}》 · 读书拆解`
    : "读书笔记 · READING NOTES";

  return {
    title: cleanTitle,
    subtitle,
    ...(callout ? { callout } : {}),
    branches: finalBranches,
  };
}

interface ThemePalette {
  bgColor: string;
  bgGradient: string;
  bgPattern: string;
  frameBorder: string;
  cardBg: string;
  cardBorder: string;
  cardShadow: string;
  ink: string;
  secondary: string;
  muted: string;
  accent: string;
  accentSoft: string;
  highlightMark: string;
  spineColor: string;
  quoteBg: string;
  quoteInk: string;
  quoteBorder: string;
  serifTitle: boolean;
  tactileBorder: boolean;
}

const PALETTES: Record<ConceptVisualTheme, ThemePalette> = {
  "editorial-paper": {
    bgColor: "#F8F3EA",
    bgGradient: "linear-gradient(165deg, #FAF6EE 0%, #F4ECDF 100%)",
    bgPattern: "radial-gradient(rgba(96, 74, 48, 0.085) 1px, transparent 1px)",
    frameBorder: "rgba(130, 102, 70, 0.22)",
    cardBg: "#FFFDF9",
    cardBorder: "rgba(130, 102, 70, 0.16)",
    cardShadow: "0 4px 16px rgba(68, 49, 28, 0.055)",
    ink: "#1E1915",
    secondary: "#4A4036",
    muted: "#7D6F61",
    accent: "#B84324",
    accentSoft: "rgba(184, 67, 36, 0.1)",
    highlightMark: "linear-gradient(180deg, transparent 58%, rgba(246, 211, 148, 0.72) 58%)",
    spineColor: "#C59A6B",
    quoteBg: "#EFE7D8",
    quoteInk: "#2B231C",
    quoteBorder: "#B84324",
    serifTitle: true,
    tactileBorder: false,
  },
  "memo-grid": {
    bgColor: "#FCFBF7",
    bgGradient: "linear-gradient(180deg, #FDFCF8 0%, #F8F6F0 100%)",
    bgPattern:
      "linear-gradient(to right, rgba(24, 24, 27, 0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(24, 24, 27, 0.05) 1px, transparent 1px)",
    frameBorder: "rgba(24, 24, 27, 0.16)",
    cardBg: "#FFFFFF",
    cardBorder: "#242220",
    cardShadow: "3.5px 3.5px 0 rgba(24, 24, 27, 0.1)",
    ink: "#18181B",
    secondary: "#3F3F46",
    muted: "#71717A",
    accent: "#DC4A2D",
    accentSoft: "#FEF08A",
    highlightMark: "linear-gradient(180deg, transparent 52%, #FEF08A 52%)",
    spineColor: "#242220",
    quoteBg: "#FFFBE2",
    quoteInk: "#18181B",
    quoteBorder: "#242220",
    serifTitle: false,
    tactileBorder: true,
  },
  "botanical-mist": {
    bgColor: "#EEF4EE",
    bgGradient: "linear-gradient(165deg, #F3F7F2 0%, #E5EFE7 100%)",
    bgPattern: "radial-gradient(rgba(31, 78, 61, 0.085) 1px, transparent 1px)",
    frameBorder: "rgba(31, 78, 61, 0.18)",
    cardBg: "#FFFFFF",
    cardBorder: "rgba(31, 78, 61, 0.15)",
    cardShadow: "0 4px 16px rgba(24, 56, 44, 0.06)",
    ink: "#162A22",
    secondary: "#3A5247",
    muted: "#647B70",
    accent: "#1F5A45",
    accentSoft: "rgba(31, 90, 69, 0.11)",
    highlightMark: "linear-gradient(180deg, transparent 58%, rgba(183, 222, 194, 0.82) 58%)",
    spineColor: "#4E836D",
    quoteBg: "#DFEAE2",
    quoteInk: "#162A22",
    quoteBorder: "#1F5A45",
    serifTitle: true,
    tactileBorder: false,
  },
  "nocturne-ink": {
    bgColor: "#111216",
    bgGradient: "radial-gradient(circle at 18% 10%, #23242C 0%, #121318 56%, #0B0C0F 100%)",
    bgPattern: "radial-gradient(rgba(217, 186, 130, 0.09) 1px, transparent 1px)",
    frameBorder: "rgba(217, 186, 130, 0.24)",
    cardBg: "#1A1C22",
    cardBorder: "rgba(217, 186, 130, 0.22)",
    cardShadow: "0 8px 24px rgba(0, 0, 0, 0.42)",
    ink: "#F6F2E9",
    secondary: "#CBC5B9",
    muted: "#958F84",
    accent: "#DFBF84",
    accentSoft: "rgba(223, 191, 132, 0.15)",
    highlightMark: "linear-gradient(180deg, transparent 60%, rgba(223, 191, 132, 0.34) 60%)",
    spineColor: "rgba(223, 191, 132, 0.58)",
    quoteBg: "#22211C",
    quoteInk: "#F5EFE2",
    quoteBorder: "#DFBF84",
    serifTitle: true,
    tactileBorder: false,
  },
  "cloud-blue": {
    bgColor: "#F2F6FD",
    bgGradient: "linear-gradient(165deg, #F8FAFD 0%, #EBF2FC 100%)",
    bgPattern: "radial-gradient(rgba(37, 99, 235, 0.085) 1px, transparent 1px)",
    frameBorder: "rgba(37, 99, 235, 0.16)",
    cardBg: "#FFFFFF",
    cardBorder: "rgba(30, 64, 175, 0.12)",
    cardShadow: "0 4px 16px rgba(30, 64, 175, 0.055)",
    ink: "#111C30",
    secondary: "#3B4C6B",
    muted: "#6E7F9E",
    accent: "#2563EB",
    accentSoft: "rgba(37, 99, 235, 0.1)",
    highlightMark: "linear-gradient(180deg, transparent 58%, rgba(191, 219, 254, 0.85) 58%)",
    spineColor: "#60A5FA",
    quoteBg: "#E6EFFD",
    quoteInk: "#111C30",
    quoteBorder: "#2563EB",
    serifTitle: false,
    tactileBorder: false,
  },
};

function formatTitleHtml(rawTitle: string): string {
  const trimmed = rawTitle.trim();
  const dotIdx = trimmed.indexOf("·");
  if (dotIdx > 0 && dotIdx < trimmed.length - 1) {
    const left = trimmed.slice(0, dotIdx).trim();
    const right = trimmed.slice(dotIdx + 1).trim();
    return `${escapeHtml(left)} <span class="nowrap-seg">· ${escapeHtml(right)}</span>`;
  }
  return escapeHtml(trimmed);
}

export const CONCEPT_CARD_WIDTH = 540;
export const CONCEPT_CARD_HEIGHT = 720;

function renderCoverBody(payload: ConceptVisualPayload): string {
  const branches = payload.branches.slice(0, 4);
  const focalQuote =
    payload.callout
    || branches[0]?.points[0]
    || branches[0]?.heading
    || "把书里的判断，变成自己的坐标系。";

  const teaserItems = branches
    .slice(0, 3)
    .map(
      (b, idx) => `
        <div class="cover-teaser-row">
          <span class="cover-teaser-num">0${idx + 1}</span>
          <span class="cover-teaser-text">${escapeHtml(b.heading)}</span>
        </div>
      `,
    )
    .join("");

  return `
    <div class="cover-layout">
      <div class="cover-hero">
        <div class="cover-kicker-row">
          <span class="kicker-tag">READING NOTES · 读后拆解</span>
          <span class="cover-dots">✦ ✦ ✦</span>
        </div>
        <h1 class="cover-title ${payload.title.trim().startsWith("《") ? "hang-punct" : ""}"><span class="hl-mark">${formatTitleHtml(payload.title)}</span></h1>
        <div class="cover-sub">${escapeHtml(payload.subtitle)}</div>
      </div>

      <div class="cover-quote-card">
        <div class="cover-quote-mark" aria-hidden="true">“</div>
        <div class="cover-quote-text">${escapeHtml(focalQuote)}</div>
      </div>

      <div class="cover-teasers">
        <div class="cover-teasers-label">本篇核心拆解</div>
        ${teaserItems}
      </div>
    </div>
  `;
}

function renderMindmapBody(payload: ConceptVisualPayload, pal: ThemePalette): string {
  const branches = payload.branches.slice(0, 5);
  const dense = branches.length >= 4;

  const nodesHtml = branches
    .map((b, idx) => {
      const point = b.points[0] || "";
      const isFirst = idx === 0;
      const isLast = idx === branches.length - 1;
      return `
        <div class="tree-row ${isFirst ? "is-first" : ""} ${isLast ? "is-last" : ""}">
          <div class="tree-rail" aria-hidden="true">
            <span class="tree-trunk"></span>
            <svg class="tree-arm-svg" width="22" height="12" viewBox="0 0 22 12" xmlns="http://www.w3.org/2000/svg">
              <line x1="0" y1="6" x2="18" y2="6" stroke="${pal.spineColor}" stroke-width="1.8" stroke-linecap="round" />
              <circle cx="19" cy="6" r="2.2" fill="${pal.accent}" />
            </svg>
            <span class="tree-node-badge">0${idx + 1}</span>
          </div>
          <div class="tree-card">
            <div class="tree-card-head">${escapeHtml(b.heading)}</div>
            ${point ? `<div class="tree-card-sub">${escapeHtml(point)}</div>` : ""}
          </div>
        </div>
      `;
    })
    .join("");

  return `
    <div class="page-head">
      <div class="page-head-top">
        <span class="kicker-tag">MINDMAP · 读书导图</span>
        <span class="page-head-count">${branches.length} 个核心观点</span>
      </div>
      <h1 class="page-title ${payload.title.trim().startsWith("《") ? "hang-punct" : ""}"><span class="hl-mark">${formatTitleHtml(payload.title)}</span></h1>
      <div class="page-sub">${escapeHtml(payload.subtitle)}</div>
    </div>

    <div class="tree-wrap ${dense ? "is-dense" : ""}">
      ${nodesHtml}
    </div>

    ${
      payload.callout
        ? `
          <div class="editorial-callout">
            <span class="editorial-callout-mark" aria-hidden="true">“</span>
            <span class="editorial-callout-text">${escapeHtml(payload.callout)}</span>
          </div>
        `
        : ""
    }
  `;
}

function renderInfographicBody(payload: ConceptVisualPayload): string {
  const branches = payload.branches.slice(0, 5);
  const dense = branches.length >= 4;

  const cardsHtml = branches
    .map((b, idx) => {
      const point = b.points[0] || "";
      return `
        <div class="info-item">
          <div class="info-idx">0${idx + 1}</div>
          <div class="info-body">
            <div class="info-head">${escapeHtml(b.heading)}</div>
            ${point ? `<div class="info-desc">${escapeHtml(point)}</div>` : ""}
          </div>
        </div>
      `;
    })
    .join("");

  return `
    <div class="page-head">
      <div class="page-head-top">
        <span class="kicker-tag">FRAMEWORK · 干货清单</span>
        <span class="page-head-count">${branches.length} 条关键洞察</span>
      </div>
      <h1 class="page-title ${payload.title.trim().startsWith("《") ? "hang-punct" : ""}"><span class="hl-mark">${formatTitleHtml(payload.title)}</span></h1>
      <div class="page-sub">${escapeHtml(payload.subtitle)}</div>
    </div>

    <div class="info-stack ${dense ? "is-dense" : ""}">
      ${cardsHtml}
    </div>

    ${
      payload.callout
        ? `
          <div class="editorial-callout">
            <span class="editorial-callout-mark" aria-hidden="true">“</span>
            <span class="editorial-callout-text">${escapeHtml(payload.callout)}</span>
          </div>
        `
        : ""
    }
  `;
}

export function renderConceptVisualHtml(payload: ConceptVisualPayload): string {
  const pal = PALETTES[payload.theme] ?? PALETTES["editorial-paper"];
  const titleFont = pal.serifTitle
    ? `"Songti SC", "STSong", "Noto Serif SC", "Source Han Serif SC", Georgia, serif`
    : `-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", sans-serif`;
  const titleLen = payload.title.trim().length;
  const pageTitleSize = titleLen > 18 ? 23 : titleLen > 12 ? 26 : 30;
  const coverTitleSize = titleLen > 18 ? 29 : titleLen > 12 ? 33 : 39;
  const showColophon = payload.showColophon !== false;

  const bodyHtml =
    payload.layout === "cover"
      ? renderCoverBody(payload)
      : payload.layout === "mindmap"
        ? renderMindmapBody(payload, pal)
        : renderInfographicBody(payload);

  const bgLayers = `${pal.bgPattern}, ${pal.bgGradient}`;
  const bgSizes = payload.theme === "memo-grid" ? "22px 22px, 22px 22px, 100% 100%" : "18px 18px, 100% 100%";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: ${CONCEPT_CARD_WIDTH}px;
    height: ${CONCEPT_CARD_HEIGHT}px;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", sans-serif;
    -webkit-font-smoothing: antialiased;
    background: transparent;
  }
  .canvas {
    width: ${CONCEPT_CARD_WIDTH}px;
    height: ${CONCEPT_CARD_HEIGHT}px;
    padding: 20px;
    background-color: ${pal.bgColor};
    background-image: ${bgLayers};
    background-size: ${bgSizes};
    color: ${pal.ink};
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .nowrap-seg {
    white-space: nowrap;
  }
  .hang-punct {
    margin-left: -0.36em;
  }
  .sheet {
    flex: 1;
    min-height: 0;
    border: 1px solid ${pal.frameBorder};
    border-radius: ${pal.tactileBorder ? "14px" : "20px"};
    padding: 26px 26px 18px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    position: relative;
    overflow: hidden;
  }
  .main-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .kicker-tag {
    display: inline-flex;
    align-items: center;
    padding: 3px 9px;
    border-radius: ${pal.tactileBorder ? "6px" : "999px"};
    background: ${pal.accentSoft};
    color: ${pal.tactileBorder ? pal.ink : pal.accent};
    border: ${pal.tactileBorder ? `1px solid ${pal.cardBorder}` : "none"};
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .hl-mark {
    background: ${pal.highlightMark};
    padding: 0 3px;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
  }

  /* ---- Shared Header (Mindmap & Infographic) ---- */
  .page-head {
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding-bottom: 12px;
    border-bottom: 1px solid ${pal.frameBorder};
  }
  .page-head-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .page-head-count {
    font-size: 11px;
    font-weight: 600;
    color: ${pal.muted};
    letter-spacing: 0.03em;
  }
  .page-title {
    font-family: ${titleFont};
    font-size: ${pageTitleSize}px;
    font-weight: 800;
    line-height: 1.28;
    letter-spacing: -0.015em;
    color: ${pal.ink};
    word-break: break-word;
  }
  .page-sub {
    font-size: 12px;
    color: ${pal.muted};
    letter-spacing: 0.02em;
  }

  /* ---- Layout 1: Magazine Cover (小红书首图) ---- */
  .cover-layout {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 16px;
  }
  .cover-hero {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-top: 6px;
  }
  .cover-kicker-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .cover-dots {
    font-size: 11px;
    letter-spacing: 0.25em;
    color: ${pal.accent};
    opacity: 0.72;
  }
  .cover-title {
    font-family: ${titleFont};
    font-size: ${coverTitleSize}px;
    font-weight: 900;
    line-height: 1.25;
    letter-spacing: -0.02em;
    color: ${pal.ink};
    word-break: break-word;
  }
  .cover-sub {
    font-size: 13px;
    font-weight: 500;
    color: ${pal.muted};
    letter-spacing: 0.04em;
  }
  .cover-quote-card {
    position: relative;
    padding: 22px 22px 20px 24px;
    border-radius: ${pal.tactileBorder ? "12px" : "16px"};
    background: ${pal.cardBg};
    border: ${pal.tactileBorder ? `1.6px solid ${pal.cardBorder}` : `1px solid ${pal.cardBorder}`};
    box-shadow: ${pal.cardShadow};
  }
  .cover-quote-mark {
    font-family: Georgia, "Songti SC", serif;
    font-size: 46px;
    line-height: 0.8;
    color: ${pal.accent};
    opacity: 0.78;
    margin-bottom: 6px;
  }
  .cover-quote-text {
    font-family: ${titleFont};
    font-size: 18px;
    font-weight: 700;
    line-height: 1.62;
    color: ${pal.ink};
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .cover-teasers {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px 16px;
    border-radius: ${pal.tactileBorder ? "12px" : "14px"};
    background: ${pal.quoteBg};
    border: ${pal.tactileBorder ? `1.4px solid ${pal.cardBorder}` : `1px solid ${pal.frameBorder}`};
  }
  .cover-teasers-label {
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.12em;
    color: ${pal.muted};
    margin-bottom: 2px;
  }
  .cover-teaser-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .cover-teaser-num {
    font-family: Georgia, serif;
    font-size: 13px;
    font-weight: 800;
    color: ${pal.accent};
    flex-shrink: 0;
  }
  .cover-teaser-text {
    font-size: 13.5px;
    font-weight: 600;
    color: ${pal.ink};
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ---- Layout 2: Vertical Spine Editorial Mindmap (竖版结构导图) ---- */
  .tree-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .tree-row {
    display: flex;
    align-items: stretch;
    gap: 2px;
  }
  .tree-rail {
    width: 36px;
    flex-shrink: 0;
    position: relative;
  }
  .tree-trunk {
    position: absolute;
    left: 11px;
    top: 0;
    bottom: 0;
    width: 2px;
    background: ${pal.spineColor};
    opacity: 0.72;
  }
  .tree-row.is-first .tree-trunk {
    top: 30px;
  }
  .tree-row.is-last .tree-trunk {
    bottom: auto;
    height: 30px;
  }
  .tree-row.is-first.is-last .tree-trunk {
    display: none;
  }
  .tree-arm-svg {
    position: absolute;
    left: 14px;
    top: 24px;
    z-index: 1;
    overflow: visible;
  }
  .tree-node-badge {
    position: absolute;
    left: 1px;
    top: 19px;
    width: 22px;
    height: 22px;
    border-radius: 999px;
    background: ${pal.cardBg};
    border: 1.8px solid ${pal.accent};
    color: ${pal.accent};
    font-size: 10px;
    font-weight: 800;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2;
  }
  .tree-card {
    flex: 1;
    min-width: 0;
    margin-bottom: 12px;
    padding: 13px 16px;
    border-radius: ${pal.tactileBorder ? "11px" : "14px"};
    background: ${pal.cardBg};
    border: ${pal.tactileBorder ? `1.5px solid ${pal.cardBorder}` : `1px solid ${pal.cardBorder}`};
    box-shadow: ${pal.cardShadow};
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .tree-row.is-last .tree-card {
    margin-bottom: 0;
  }
  .tree-wrap.is-dense .tree-card {
    margin-bottom: 8px;
    padding: 9px 14px;
    gap: 3px;
  }
  .tree-wrap.is-dense .tree-row.is-last .tree-card {
    margin-bottom: 0;
  }
  .tree-card-head {
    font-size: 15.5px;
    font-weight: 750;
    line-height: 1.35;
    color: ${pal.ink};
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .tree-wrap.is-dense .tree-card-head {
    font-size: 14px;
    -webkit-line-clamp: 1;
  }
  .tree-card-sub {
    font-size: 12.5px;
    line-height: 1.5;
    color: ${pal.secondary};
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .tree-wrap.is-dense .tree-card-sub {
    font-size: 11.5px;
    -webkit-line-clamp: 1;
  }

  /* ---- Layout 3: Editorial Infographic List (干货信息卡) ---- */
  .info-stack {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 11px;
  }
  .info-stack.is-dense {
    gap: 8px;
  }
  .info-item {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 14px 16px;
    border-radius: ${pal.tactileBorder ? "11px" : "15px"};
    background: ${pal.cardBg};
    border: ${pal.tactileBorder ? `1.5px solid ${pal.cardBorder}` : `1px solid ${pal.cardBorder}`};
    box-shadow: ${pal.cardShadow};
  }
  .info-stack.is-dense .info-item {
    padding: 10px 14px;
    gap: 11px;
  }
  .info-idx {
    font-family: Georgia, "Songti SC", serif;
    font-size: 22px;
    font-weight: 800;
    line-height: 1.05;
    color: ${pal.accent};
    flex-shrink: 0;
    width: 32px;
    text-align: center;
    padding-top: 2px;
  }
  .info-stack.is-dense .info-idx {
    font-size: 18px;
    width: 26px;
  }
  .info-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .info-head {
    font-size: 15.5px;
    font-weight: 750;
    line-height: 1.35;
    color: ${pal.ink};
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .info-stack.is-dense .info-head {
    font-size: 14px;
    -webkit-line-clamp: 1;
  }
  .info-desc {
    font-size: 12.5px;
    line-height: 1.52;
    color: ${pal.secondary};
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .info-stack.is-dense .info-desc {
    font-size: 11.5px;
    -webkit-line-clamp: 1;
  }

  /* ---- Bottom Callout Quote ---- */
  .editorial-callout {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 11px 15px;
    border-radius: ${pal.tactileBorder ? "10px" : "12px"};
    background: ${pal.quoteBg};
    border-left: 3px solid ${pal.quoteBorder};
    border-top: ${pal.tactileBorder ? `1.2px solid ${pal.cardBorder}` : "none"};
    border-right: ${pal.tactileBorder ? `1.2px solid ${pal.cardBorder}` : "none"};
    border-bottom: ${pal.tactileBorder ? `1.2px solid ${pal.cardBorder}` : "none"};
  }
  .editorial-callout-mark {
    font-family: Georgia, serif;
    font-size: 24px;
    line-height: 0.9;
    color: ${pal.accent};
    flex-shrink: 0;
    margin-top: 2px;
  }
  .editorial-callout-text {
    font-family: ${titleFont};
    font-size: 13px;
    font-weight: 600;
    line-height: 1.52;
    color: ${pal.quoteInk};
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* ---- Subtle Editorial Colophon ---- */
  .colophon {
    margin-top: 12px;
    padding-top: 9px;
    border-top: 1px solid ${pal.frameBorder};
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 10px;
    letter-spacing: 0.1em;
    color: ${pal.muted};
    opacity: 0.85;
  }
</style>
</head>
<body>
  <div class="canvas">
    <div class="sheet">
      <div class="main-body">
        ${bodyHtml}
      </div>
      ${
        showColophon
          ? `<div class="colophon"><span>READING ARCHIVE</span><span>点点读书</span></div>`
          : ""
      }
    </div>
  </div>
</body>
</html>`;
}
