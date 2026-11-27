import { isGenericSiteName } from "../siteTitles";

export type ConceptVisualLayout = "cover" | "versus" | "mindmap" | "infographic";
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
  bookTitle?: string;
  author?: string;
  coverDataUrl?: string;
  showBookCover?: boolean;
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

function sanitizeCoverDataUrl(raw?: string): string | null {
  if (!raw || typeof raw !== "string") return null;
  const compact = raw.trim().replace(/\s+/g, "");
  if (/^data:image\/(?:jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(compact)) {
    return compact;
  }
  return null;
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

function extractBookTitleMention(title: string, content: string, explicitBookTitle?: string): string {
  const cleanExplicit = (explicitBookTitle ?? "").replace(/^《|》$/g, "").trim();
  if (cleanExplicit && !isGenericSiteName(cleanExplicit)) {
    return cleanExplicit;
  }
  const fromTitle = /《([^《》\n]{1,36})》/.exec(title)?.[1]?.trim();
  if (fromTitle) return fromTitle;
  const fromContent = /《([^《》\n]{1,36})》/.exec(content)?.[1]?.trim();
  return fromContent || "";
}

/**
 * Distill a punchy 10-22 char Xiaohongshu-style sub-headline from a paragraph
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

  if (first.length <= 24) {
    return { heading: first, rest: remainder };
  }

  const clauses = first
    .split(/[，,；;：:—–]+/)
    .map((c) => c.trim())
    .filter((c) => c.length >= 4);

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
      if (q.length >= 8 && !/^——\s*《/.test(q)) {
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

  const detectedBook = extractBookTitleMention(title, content, bookTitle);
  const cleanTitle = (title.trim() || "阅读思考框架").slice(0, 28);
  const subtitle = detectedBook
    ? `《${detectedBook}》 · 深度共读笔记`
    : "读书笔记 · READING NOTES";

  return {
    title: cleanTitle,
    subtitle,
    ...(detectedBook ? { bookTitle: detectedBook } : {}),
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
  cardMutedBg: string;
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
  clothBg: string;
  clothInk: string;
  clothAccent: string;
  tapeBg: string;
  serifTitle: boolean;
  tactileBorder: boolean;
  isDark: boolean;
}

const PALETTES: Record<ConceptVisualTheme, ThemePalette> = {
  "editorial-paper": {
    bgColor: "#F6F0E4",
    bgGradient: "linear-gradient(160deg, #FBF7EF 0%, #F1E7D6 100%)",
    bgPattern: "radial-gradient(rgba(96, 74, 48, 0.075) 1px, transparent 1px)",
    frameBorder: "rgba(116, 88, 58, 0.22)",
    cardBg: "#FFFDF9",
    cardMutedBg: "#EDE4D5",
    cardBorder: "rgba(116, 88, 58, 0.17)",
    cardShadow: "0 8px 24px rgba(58, 40, 22, 0.06)",
    ink: "#1B1612",
    secondary: "#463C33",
    muted: "#7A6B5D",
    accent: "#B83B1D",
    accentSoft: "rgba(184, 59, 29, 0.11)",
    highlightMark: "linear-gradient(180deg, transparent 58%, rgba(245, 204, 132, 0.78) 58%)",
    spineColor: "#BD8E60",
    quoteBg: "#EFE6D6",
    quoteInk: "#261E18",
    quoteBorder: "#B83B1D",
    clothBg: "linear-gradient(145deg, #8F331E 0%, #682112 100%)",
    clothInk: "#FAF3E8",
    clothAccent: "#E8C594",
    tapeBg: "rgba(218, 174, 118, 0.36)",
    serifTitle: true,
    tactileBorder: false,
    isDark: false,
  },
  "memo-grid": {
    bgColor: "#FCFBF6",
    bgGradient: "linear-gradient(180deg, #FEFDF9 0%, #F6F3E9 100%)",
    bgPattern:
      "linear-gradient(to right, rgba(24, 24, 27, 0.055) 1px, transparent 1px), linear-gradient(to bottom, rgba(24, 24, 27, 0.055) 1px, transparent 1px)",
    frameBorder: "rgba(24, 24, 27, 0.2)",
    cardBg: "#FFFFFF",
    cardMutedBg: "#F1EFE7",
    cardBorder: "#22201E",
    cardShadow: "4px 4px 0 rgba(24, 24, 27, 0.13)",
    ink: "#161618",
    secondary: "#3B3B42",
    muted: "#6E6E77",
    accent: "#D94426",
    accentSoft: "#FEF08A",
    highlightMark: "linear-gradient(180deg, transparent 52%, #FDE047 52%)",
    spineColor: "#22201E",
    quoteBg: "#FFFBEB",
    quoteInk: "#18181B",
    quoteBorder: "#22201E",
    clothBg: "linear-gradient(145deg, #27272A 0%, #141416 100%)",
    clothInk: "#FEFCE8",
    clothAccent: "#FACC15",
    tapeBg: "rgba(250, 204, 21, 0.55)",
    serifTitle: false,
    tactileBorder: true,
    isDark: false,
  },
  "botanical-mist": {
    bgColor: "#ECF3EC",
    bgGradient: "linear-gradient(160deg, #F4F8F3 0%, #E2EDE4 100%)",
    bgPattern: "radial-gradient(rgba(28, 74, 56, 0.075) 1px, transparent 1px)",
    frameBorder: "rgba(28, 74, 56, 0.2)",
    cardBg: "#FCFDFC",
    cardMutedBg: "#DCE8DF",
    cardBorder: "rgba(28, 74, 56, 0.16)",
    cardShadow: "0 8px 24px rgba(20, 52, 39, 0.06)",
    ink: "#13261E",
    secondary: "#354E43",
    muted: "#5E776B",
    accent: "#1B5942",
    accentSoft: "rgba(27, 89, 66, 0.12)",
    highlightMark: "linear-gradient(180deg, transparent 58%, rgba(173, 219, 187, 0.85) 58%)",
    spineColor: "#497E67",
    quoteBg: "#DDE9E0",
    quoteInk: "#13261E",
    quoteBorder: "#1B5942",
    clothBg: "linear-gradient(145deg, #214E3D 0%, #133226 100%)",
    clothInk: "#F2F7F3",
    clothAccent: "#B7DEC2",
    tapeBg: "rgba(116, 172, 138, 0.36)",
    serifTitle: true,
    tactileBorder: false,
    isDark: false,
  },
  "nocturne-ink": {
    bgColor: "#111216",
    bgGradient: "radial-gradient(circle at 18% 12%, #252630 0%, #13141A 56%, #0B0C10 100%)",
    bgPattern: "radial-gradient(rgba(223, 191, 132, 0.085) 1px, transparent 1px)",
    frameBorder: "rgba(223, 191, 132, 0.26)",
    cardBg: "#1A1C23",
    cardMutedBg: "#14161C",
    cardBorder: "rgba(223, 191, 132, 0.22)",
    cardShadow: "0 10px 28px rgba(0, 0, 0, 0.46)",
    ink: "#F6F1E7",
    secondary: "#CFC8BC",
    muted: "#968F83",
    accent: "#E2C185",
    accentSoft: "rgba(226, 193, 133, 0.15)",
    highlightMark: "linear-gradient(180deg, transparent 60%, rgba(226, 193, 133, 0.32) 60%)",
    spineColor: "rgba(226, 193, 133, 0.6)",
    quoteBg: "#211F1A",
    quoteInk: "#F6EFE2",
    quoteBorder: "#E2C185",
    clothBg: "linear-gradient(145deg, #2D261E 0%, #191511 100%)",
    clothInk: "#F8F1E3",
    clothAccent: "#E2C185",
    tapeBg: "rgba(226, 193, 133, 0.26)",
    serifTitle: true,
    tactileBorder: false,
    isDark: true,
  },
  "cloud-blue": {
    bgColor: "#EFF4FC",
    bgGradient: "linear-gradient(160deg, #F8FAFE 0%, #E6EEF9 100%)",
    bgPattern: "radial-gradient(rgba(37, 99, 235, 0.075) 1px, transparent 1px)",
    frameBorder: "rgba(30, 64, 175, 0.17)",
    cardBg: "#FFFFFF",
    cardMutedBg: "#E1EBF8",
    cardBorder: "rgba(30, 64, 175, 0.13)",
    cardShadow: "0 8px 24px rgba(30, 64, 175, 0.06)",
    ink: "#0F1A2E",
    secondary: "#364766",
    muted: "#687998",
    accent: "#2563EB",
    accentSoft: "rgba(37, 99, 235, 0.11)",
    highlightMark: "linear-gradient(180deg, transparent 58%, rgba(186, 214, 254, 0.88) 58%)",
    spineColor: "#5B9BF8",
    quoteBg: "#E4EEFC",
    quoteInk: "#0F1A2E",
    quoteBorder: "#2563EB",
    clothBg: "linear-gradient(145deg, #1E40AF 0%, #13286E 100%)",
    clothInk: "#F4F8FF",
    clothAccent: "#93C5FD",
    tapeBg: "rgba(96, 165, 250, 0.34)",
    serifTitle: false,
    tactileBorder: false,
    isDark: false,
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

function resolveDisplayBookTitle(payload: ConceptVisualPayload): string {
  const explicit = (payload.bookTitle ?? "").replace(/^《|》$/g, "").trim();
  if (explicit) return explicit;
  const fromSub = /《([^《》\n]{1,34})》/.exec(payload.subtitle)?.[1]?.trim();
  if (fromSub) return fromSub;
  const fromTitle = /《([^《》\n]{1,34})》/.exec(payload.title)?.[1]?.trim();
  if (fromTitle) return fromTitle;
  return payload.title.replace(/^《|》$/g, "").trim().slice(0, 18) || "精选共读";
}

function render3DBookHtml(
  payload: ConceptVisualPayload,
  size: "hero" | "mini",
): string {
  const safeCover = sanitizeCoverDataUrl(payload.coverDataUrl);
  const bookLabel = resolveDisplayBookTitle(payload);
  const authorLabel = (payload.author ?? "").trim();
  const cls = size === "hero" ? "book-3d is-hero" : "book-3d is-mini";

  if (safeCover) {
    return `
      <div class="${cls}">
        <div class="book-3d-pages" aria-hidden="true"></div>
        <div class="book-3d-face">
          <img class="book-3d-img" src="${safeCover}" alt="" />
          <span class="book-3d-spine" aria-hidden="true"></span>
          <span class="book-3d-sheen" aria-hidden="true"></span>
        </div>
      </div>
    `;
  }

  return `
    <div class="${cls} is-cloth">
      <div class="book-3d-pages" aria-hidden="true"></div>
      <div class="book-3d-face book-cloth-face">
        <div class="book-cloth-frame">
          <span class="book-cloth-kicker">EX LIBRIS</span>
          <div class="book-cloth-title">${escapeHtml(bookLabel.slice(0, 20))}</div>
          ${
            authorLabel && size === "hero"
              ? `<div class="book-cloth-author">${escapeHtml(authorLabel.slice(0, 16))}</div>`
              : `<div class="book-cloth-ornament">✦</div>`
          }
        </div>
        <span class="book-3d-spine" aria-hidden="true"></span>
        <span class="book-3d-sheen" aria-hidden="true"></span>
      </div>
    </div>
  `;
}

function renderBrushUnderlineSvg(color: string): string {
  return `<svg class="brush-svg" viewBox="0 0 220 14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M3 9.5C54 3.2 142 2.4 217 7.2" stroke="${color}" stroke-width="3.2" stroke-linecap="round" opacity="0.82"/>
    <path d="M24 12.2C82 8.4 156 8.1 204 10.6" stroke="${color}" stroke-width="1.5" stroke-linecap="round" opacity="0.45"/>
  </svg>`;
}

export const CONCEPT_CARD_WIDTH = 540;
export const CONCEPT_CARD_HEIGHT = 720;

/**
 * Layout 1: 爆款书封首图 (`cover`)
 * Minimal poster copy + high-tension headline + tactile 3D book object + piercing pull-quote.
 */
function renderCoverBody(payload: ConceptVisualPayload, pal: ThemePalette): string {
  const branches = payload.branches.slice(0, 4);
  const focalQuote =
    payload.callout
    || branches[0]?.points[0]
    || branches[0]?.heading
    || "真正决定差距的，从来不是你知道多少，而是你用哪套坐标系做判断。";
  const showBook = payload.showBookCover !== false;
  const bookLabel = resolveDisplayBookTitle(payload);
  const authorSuffix = payload.author?.trim() ? ` · ${payload.author.trim()}` : "";

  const indexRows = branches
    .slice(0, 3)
    .map(
      (b, idx) => `
        <div class="cover-idx-row">
          <span class="cover-idx-num">0${idx + 1}</span>
          <span class="cover-idx-text">${escapeHtml(b.heading)}</span>
        </div>
      `,
    )
    .join("");

  return `
    <div class="cover-poster">
      <div class="cover-masthead">
        <span class="kicker-tag">READING NOTES · 读后拆解</span>
        <span class="cover-issue">《${escapeHtml(bookLabel.slice(0, 14))}》${escapeHtml(authorSuffix.slice(0, 10))}</span>
      </div>

      <div class="cover-headline-zone">
        <h1 class="cover-poster-title ${payload.title.trim().startsWith("《") ? "hang-punct" : ""}">
          <span class="hl-mark">${formatTitleHtml(payload.title)}</span>
        </h1>
        ${renderBrushUnderlineSvg(pal.accent)}
        <div class="cover-poster-sub">${escapeHtml(payload.subtitle)}</div>
      </div>

      ${
        showBook
          ? `
            <div class="cover-showcase">
              <div class="cover-book-pedestal">
                ${render3DBookHtml(payload, "hero")}
              </div>
              <div class="cover-insight-col">
                <div class="cover-pullquote">
                  <div class="cover-qmark" aria-hidden="true">“</div>
                  <div class="cover-qtext">${escapeHtml(focalQuote)}</div>
                </div>
                <div class="cover-idx-list">
                  ${indexRows}
                </div>
              </div>
            </div>
          `
          : `
            <div class="cover-pure-quote">
              <div class="cover-qmark" aria-hidden="true">“</div>
              <div class="cover-pure-qtext">${escapeHtml(focalQuote)}</div>
            </div>
            <div class="cover-idx-list is-wide">
              ${indexRows}
            </div>
          `
      }
    </div>
  `;
}

/**
 * Layout 2: 认知反差对撞卡 (`versus`)
 * High-CTR Xiaohongshu cognitive shift archetype: ❌ Common Intuition vs ✦ Book's Deep Truth.
 */
function renderVersusBody(payload: ConceptVisualPayload, pal: ThemePalette): string {
  const b0 = payload.branches[0] ?? { heading: "多数人的惯性直觉", points: ["容易被表面因果与短期情绪带着走"] };
  const b1 = payload.branches[1] ?? {
    heading: payload.callout || "书里的底层真相",
    points: [b0.points[0] || "穿透表象，建立可复用的长期决策坐标系"],
  };
  const takeaway =
    payload.callout
    || payload.branches[2]?.heading
    || payload.branches[2]?.points[0]
    || b1.points[0]
    || "换一副眼镜看问题，答案往往在反面。";

  return `
    <div class="page-head">
      <div class="page-head-top">
        <span class="kicker-tag">COGNITIVE SHIFT · 认知反差</span>
        <span class="page-head-count">直觉误区 vs 底层真相</span>
      </div>
      <h1 class="page-title ${payload.title.trim().startsWith("《") ? "hang-punct" : ""}"><span class="hl-mark">${formatTitleHtml(payload.title)}</span></h1>
      <div class="page-sub">${escapeHtml(payload.subtitle)}</div>
    </div>

    <div class="vs-arena">
      <div class="vs-card is-myth">
        <div class="vs-badge-row">
          <span class="vs-pill myth">✕ 多数人的直觉 / 误区</span>
          <span class="vs-tag-en">BEFORE</span>
        </div>
        <div class="vs-card-title">${escapeHtml(b0.heading)}</div>
        ${b0.points[0] ? `<div class="vs-card-desc">${escapeHtml(b0.points[0])}</div>` : ""}
      </div>

      <div class="vs-bridge" aria-hidden="true">
        <div class="vs-divider-line"></div>
        <div class="vs-medallion">
          <span>VS · 认知重构</span>
          <svg width="16" height="16" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M9 3V14.5M9 14.5L4.5 10M9 14.5L13.5 10" stroke="${pal.accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div class="vs-divider-line"></div>
      </div>

      <div class="vs-card is-truth">
        <div class="vs-badge-row">
          <span class="vs-pill truth">✦ 书里的底层真相</span>
          <span class="vs-tag-en">INSIGHT</span>
        </div>
        <div class="vs-card-title"><span class="hl-mark">${escapeHtml(b1.heading)}</span></div>
        ${b1.points[0] ? `<div class="vs-card-desc">${escapeHtml(b1.points[0])}</div>` : ""}
      </div>
    </div>

    <div class="vs-takeaway">
      <span class="vs-takeaway-label">行动启示</span>
      <span class="vs-takeaway-text">${escapeHtml(takeaway)}</span>
    </div>
  `;
}

/**
 * Layout 3: 手绘感视觉笔记导图 (`mindmap`)
 * Replaces corporate boxes-on-a-stick with a warm iPad GoodNotes / Procreate sketchnote grid
 * featuring a hand-circled core anchor, organic curved SVG connectors, and washi-tape cards.
 */
function renderMindmapBody(payload: ConceptVisualPayload, pal: ThemePalette): string {
  const branches = payload.branches.slice(0, 4);
  const coreLabel = resolveDisplayBookTitle(payload);
  const gridClass =
    branches.length === 1
      ? "sketch-grid count-1"
      : branches.length === 2
        ? "sketch-grid count-2"
        : branches.length === 3
          ? "sketch-grid count-3"
          : "sketch-grid count-4";

  const cardsHtml = branches
    .map((b, idx) => {
      const point = b.points[0] || "";
      const featured = branches.length === 3 && idx === 0;
      return `
        <div class="sketch-card ${featured ? "is-wide" : ""}">
          <span class="sketch-tape" aria-hidden="true"></span>
          <div class="sketch-card-top">
            <span class="sketch-num">0${idx + 1}</span>
            <svg class="sketch-spark" width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M8 1.5L9.4 6.6L14.5 8L9.4 9.4L8 14.5L6.6 9.4L1.5 8L6.6 6.6L8 1.5Z" stroke="${pal.accent}" stroke-width="1.4" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="sketch-head">${escapeHtml(b.heading)}</div>
          ${point ? `<div class="sketch-desc">${escapeHtml(point)}</div>` : ""}
        </div>
      `;
    })
    .join("");

  return `
    <div class="page-head is-compact">
      <div class="page-head-top">
        <span class="kicker-tag">MINDMAP · 视觉笔记</span>
        <span class="page-head-count">${branches.length} 组核心脉络</span>
      </div>
      <h1 class="page-title ${payload.title.trim().startsWith("《") ? "hang-punct" : ""}"><span class="hl-mark">${formatTitleHtml(payload.title)}</span></h1>
    </div>

    <div class="sketch-core-stage">
      <div class="sketch-core-node">
        <svg class="sketch-loop-svg" viewBox="0 0 260 56" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M16 28C16 12 68 5 132 6C198 7 246 15 245 29C244 43 192 51 128 50C62 49 14 41 20 25" stroke="${pal.accent}" stroke-width="1.8" stroke-linecap="round" opacity="0.72"/>
          <path d="M24 31C28 16 74 9 135 9.5C194 10 239 18 238 30" stroke="${pal.spineColor}" stroke-width="1.1" stroke-linecap="round" stroke-dasharray="4 4" opacity="0.65"/>
        </svg>
        <span class="sketch-core-text">✦ ${escapeHtml(coreLabel.slice(0, 16))}</span>
      </div>
      <svg class="sketch-branches-svg" viewBox="0 0 420 26" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M210 2C168 12 118 14 96 24" stroke="${pal.spineColor}" stroke-width="1.7" stroke-linecap="round"/>
        <path d="M210 2C252 12 302 14 324 24" stroke="${pal.spineColor}" stroke-width="1.7" stroke-linecap="round"/>
        <circle cx="96" cy="24" r="2.6" fill="${pal.accent}"/>
        <circle cx="324" cy="24" r="2.6" fill="${pal.accent}"/>
      </svg>
    </div>

    <div class="${gridClass}">
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

/**
 * Layout 4: 单读风杂志书摘长图 (`infographic`)
 * Pure Kinfolk / 单读 print broadsheet: miniature 3D book header + thick-thin double rule +
 * oversized italic editorial numerals with zero boxy SaaS card borders.
 */
function renderInfographicBody(payload: ConceptVisualPayload): string {
  const branches = payload.branches.slice(0, 4);
  const dense = branches.length >= 4;
  const showBook = payload.showBookCover !== false;

  const rowsHtml = branches
    .map((b, idx) => {
      const point = b.points[0] || "";
      return `
        <div class="broadsheet-row">
          <div class="broadsheet-num">0${idx + 1}</div>
          <div class="broadsheet-content">
            <div class="broadsheet-head"><span class="hl-mark">${escapeHtml(b.heading)}</span></div>
            ${point ? `<div class="broadsheet-desc">${escapeHtml(point)}</div>` : ""}
          </div>
        </div>
      `;
    })
    .join("");

  return `
    <div class="broadsheet-header">
      <div class="broadsheet-header-main">
        <div class="page-head-top">
          <span class="kicker-tag">FRAMEWORK · 深度拆解</span>
          <span class="page-head-count">01 — 0${branches.length}</span>
        </div>
        <h1 class="page-title ${payload.title.trim().startsWith("《") ? "hang-punct" : ""}">${formatTitleHtml(payload.title)}</h1>
        <div class="page-sub">${escapeHtml(payload.subtitle)}</div>
      </div>
      ${showBook ? `<div class="broadsheet-mini-book">${render3DBookHtml(payload, "mini")}</div>` : ""}
    </div>

    <div class="broadsheet-list ${dense ? "is-dense" : ""}">
      ${rowsHtml}
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
  const pageTitleSize = titleLen > 20 ? 22 : titleLen > 14 ? 25 : 28;
  const coverTitleSize = titleLen > 20 ? 31 : titleLen > 14 ? 36 : 42;
  const showColophon = payload.showColophon !== false;

  const bodyHtml =
    payload.layout === "cover"
      ? renderCoverBody(payload, pal)
      : payload.layout === "versus"
        ? renderVersusBody(payload, pal)
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
    padding: 18px;
    background-color: ${pal.bgColor};
    background-image: ${bgLayers};
    background-size: ${bgSizes};
    color: ${pal.ink};
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .paper-grain {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: ${pal.isDark ? "0.045" : "0.032"};
    pointer-events: none;
    z-index: 2;
  }
  .nowrap-seg { white-space: nowrap; }
  .hang-punct { margin-left: -0.34em; }

  .sheet {
    flex: 1;
    min-height: 0;
    border: 1px solid ${pal.frameBorder};
    border-radius: ${pal.tactileBorder ? "14px" : "20px"};
    padding: 24px 26px 18px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    position: relative;
    overflow: hidden;
    z-index: 1;
  }
  .main-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 13px;
  }
  .kicker-tag {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    border-radius: ${pal.tactileBorder ? "6px" : "999px"};
    background: ${pal.accentSoft};
    color: ${pal.tactileBorder ? pal.ink : pal.accent};
    border: ${pal.tactileBorder ? `1.2px solid ${pal.cardBorder}` : "none"};
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }
  .hl-mark {
    background: ${pal.highlightMark};
    padding: 0 3px;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
  }
  .brush-svg {
    width: 168px;
    height: 11px;
    margin-top: -2px;
  }

  /* ---- Tactile 3D Hardcover Book Object ---- */
  .book-3d {
    position: relative;
    flex-shrink: 0;
  }
  .book-3d.is-hero {
    width: 146px;
    height: 206px;
    transform: rotate(-3deg);
  }
  .book-3d.is-mini {
    width: 58px;
    height: 82px;
    transform: rotate(2deg);
  }
  .book-3d-pages {
    position: absolute;
    inset: 3px -6px -5px 6px;
    border-radius: 3px 6px 6px 3px;
    background: repeating-linear-gradient(
      90deg,
      #FAF7F0 0px,
      #FAF7F0 1.5px,
      #E3DDD1 1.5px,
      #E3DDD1 2.5px
    );
    border: 1px solid rgba(0, 0, 0, 0.14);
    box-shadow: ${
      pal.isDark
        ? "0 20px 34px rgba(0, 0, 0, 0.62), 0 6px 12px rgba(0, 0, 0, 0.4)"
        : "0 20px 34px rgba(34, 24, 14, 0.22), 0 5px 12px rgba(34, 24, 14, 0.12)"
    };
  }
  .book-3d.is-mini .book-3d-pages {
    inset: 2px -3px -3px 3px;
    box-shadow: 0 8px 16px rgba(24, 18, 12, 0.18);
  }
  .book-3d-face {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 3px 6px 6px 3px;
    overflow: hidden;
    background: ${pal.cardBg};
    border: 1px solid rgba(0, 0, 0, 0.18);
  }
  .book-3d-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .book-3d-spine {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      90deg,
      rgba(255, 255, 255, 0.36) 0%,
      rgba(0, 0, 0, 0.28) 3.8%,
      rgba(255, 255, 255, 0.22) 6.5%,
      rgba(0, 0, 0, 0.05) 10%,
      transparent 20%
    );
    pointer-events: none;
  }
  .book-3d-sheen {
    position: absolute;
    inset: 0;
    background: linear-gradient(130deg, rgba(255, 255, 255, 0.18) 0%, transparent 46%, rgba(0, 0, 0, 0.12) 100%);
    pointer-events: none;
  }
  .book-cloth-face {
    background: ${pal.clothBg};
    color: ${pal.clothInk};
    padding: 12px 11px 12px 15px;
    display: flex;
  }
  .book-3d.is-mini .book-cloth-face {
    padding: 5px 5px 5px 7px;
  }
  .book-cloth-frame {
    flex: 1;
    border: 1px solid ${pal.clothAccent};
    border-radius: 2px;
    padding: 10px 8px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: center;
    text-align: center;
  }
  .book-3d.is-mini .book-cloth-frame {
    padding: 4px 3px;
  }
  .book-cloth-kicker {
    font-size: 7.5px;
    letter-spacing: 0.18em;
    color: ${pal.clothAccent};
    font-weight: 700;
  }
  .book-3d.is-mini .book-cloth-kicker { display: none; }
  .book-cloth-title {
    font-family: "Songti SC", "STSong", "Noto Serif SC", Georgia, serif;
    font-size: 15px;
    font-weight: 800;
    line-height: 1.35;
    color: ${pal.clothInk};
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }
  .book-3d.is-mini .book-cloth-title {
    font-size: 8.5px;
    -webkit-line-clamp: 3;
  }
  .book-cloth-author {
    font-size: 9.5px;
    color: ${pal.clothAccent};
    letter-spacing: 0.05em;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .book-cloth-ornament {
    font-size: 10px;
    color: ${pal.clothAccent};
  }

  /* ---- Shared Editorial Page Head ---- */
  .page-head {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-bottom: 11px;
    border-bottom: 1px solid ${pal.frameBorder};
    flex-shrink: 0;
  }
  .page-head.is-compact {
    padding-bottom: 9px;
  }
  .page-head-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .page-head-count {
    font-size: 10.5px;
    font-weight: 700;
    color: ${pal.muted};
    letter-spacing: 0.05em;
  }
  .page-title {
    font-family: ${titleFont};
    font-size: ${pageTitleSize}px;
    font-weight: 900;
    line-height: 1.26;
    letter-spacing: -0.02em;
    color: ${pal.ink};
    word-break: break-word;
  }
  .page-sub {
    font-size: 11.5px;
    color: ${pal.muted};
    letter-spacing: 0.03em;
  }

  /* ---- Layout 1: Cover Poster (爆款书封首图) ---- */
  .cover-poster {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 14px;
  }
  .cover-masthead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-bottom: 10px;
    border-bottom: 1.5px solid ${pal.ink};
  }
  .cover-issue {
    font-size: 11px;
    font-weight: 600;
    color: ${pal.secondary};
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cover-headline-zone {
    display: flex;
    flex-direction: column;
    gap: 9px;
    padding: 6px 0 2px;
  }
  .cover-poster-title {
    font-family: ${titleFont};
    font-size: ${coverTitleSize}px;
    font-weight: 900;
    line-height: 1.22;
    letter-spacing: -0.025em;
    color: ${pal.ink};
    word-break: break-word;
  }
  .cover-poster-sub {
    font-size: 12.5px;
    font-weight: 600;
    color: ${pal.muted};
    letter-spacing: 0.04em;
  }
  .cover-showcase {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 162px 1fr;
    gap: 20px;
    align-items: center;
    padding: 8px 4px 4px;
  }
  .cover-book-pedestal {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 8px 0;
  }
  .cover-insight-col {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
  }
  .cover-pullquote {
    position: relative;
    padding: 14px 16px 14px 18px;
    border-radius: ${pal.tactileBorder ? "10px" : "14px"};
    background: ${pal.cardBg};
    border: ${pal.tactileBorder ? `1.5px solid ${pal.cardBorder}` : `1px solid ${pal.cardBorder}`};
    box-shadow: ${pal.cardShadow};
  }
  .cover-qmark {
    font-family: Georgia, "Songti SC", serif;
    font-size: 36px;
    line-height: 0.78;
    color: ${pal.accent};
    margin-bottom: 4px;
  }
  .cover-qtext {
    font-family: ${titleFont};
    font-size: 15px;
    font-weight: 700;
    line-height: 1.56;
    color: ${pal.ink};
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .cover-pure-quote {
    padding: 22px 24px;
    border-radius: 16px;
    background: ${pal.cardBg};
    border: 1px solid ${pal.cardBorder};
    box-shadow: ${pal.cardShadow};
  }
  .cover-pure-qtext {
    font-family: ${titleFont};
    font-size: 19px;
    font-weight: 700;
    line-height: 1.62;
    color: ${pal.ink};
  }
  .cover-idx-list {
    display: flex;
    flex-direction: column;
  }
  .cover-idx-row {
    display: flex;
    align-items: baseline;
    gap: 9px;
    padding: 7.5px 2px;
    border-bottom: 1px dashed ${pal.frameBorder};
  }
  .cover-idx-row:last-child { border-bottom: none; }
  .cover-idx-num {
    font-family: Georgia, serif;
    font-style: italic;
    font-size: 13px;
    font-weight: 800;
    color: ${pal.accent};
    flex-shrink: 0;
  }
  .cover-idx-text {
    font-size: 12.8px;
    font-weight: 700;
    color: ${pal.ink};
    line-height: 1.38;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ---- Layout 2: Versus Cognitive Shift (认知反差卡) ---- */
  .vs-arena {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 8px;
  }
  .vs-card {
    padding: 18px 20px;
    border-radius: ${pal.tactileBorder ? "12px" : "16px"};
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .vs-card.is-myth {
    background: ${pal.cardMutedBg};
    border: 1px dashed ${pal.frameBorder};
    color: ${pal.secondary};
  }
  .vs-card.is-truth {
    background: ${pal.cardBg};
    border: ${pal.tactileBorder ? `1.8px solid ${pal.cardBorder}` : `1.5px solid ${pal.accent}`};
    box-shadow: ${pal.cardShadow};
  }
  .vs-badge-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .vs-pill {
    display: inline-flex;
    align-items: center;
    padding: 3px 9px;
    border-radius: 999px;
    font-size: 10.5px;
    font-weight: 800;
    letter-spacing: 0.04em;
  }
  .vs-pill.myth {
    background: rgba(120, 113, 108, 0.16);
    color: ${pal.muted};
  }
  .vs-pill.truth {
    background: ${pal.accentSoft};
    color: ${pal.tactileBorder ? pal.ink : pal.accent};
  }
  .vs-tag-en {
    font-size: 9.5px;
    font-weight: 800;
    letter-spacing: 0.14em;
    color: ${pal.muted};
    opacity: 0.7;
  }
  .vs-card-title {
    font-family: ${titleFont};
    font-size: 19px;
    font-weight: 800;
    line-height: 1.35;
    color: ${pal.ink};
  }
  .vs-card.is-myth .vs-card-title {
    color: ${pal.secondary};
    font-size: 17.5px;
  }
  .vs-card-desc {
    font-size: 13px;
    line-height: 1.56;
    color: ${pal.secondary};
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .vs-bridge {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 12px;
  }
  .vs-divider-line {
    flex: 1;
    height: 1px;
    background: ${pal.frameBorder};
  }
  .vs-medallion {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 12px;
    border-radius: 999px;
    background: ${pal.cardBg};
    border: 1.2px solid ${pal.accent};
    color: ${pal.accent};
    font-size: 10.5px;
    font-weight: 800;
    letter-spacing: 0.06em;
  }
  .vs-takeaway {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 11px 14px;
    border-radius: 12px;
    background: ${pal.quoteBg};
    border-left: 3.5px solid ${pal.quoteBorder};
    flex-shrink: 0;
  }
  .vs-takeaway-label {
    font-size: 10.5px;
    font-weight: 800;
    letter-spacing: 0.08em;
    padding: 2px 7px;
    border-radius: 5px;
    background: ${pal.accent};
    color: ${pal.isDark ? "#111216" : "#FFFDF9"};
    flex-shrink: 0;
  }
  .vs-takeaway-text {
    font-size: 12.8px;
    font-weight: 700;
    color: ${pal.quoteInk};
    line-height: 1.42;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* ---- Layout 3: Sketchnote Bento Mindmap (手绘感视觉笔记) ---- */
  .sketch-core-stage {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex-shrink: 0;
    margin-top: -2px;
  }
  .sketch-core-node {
    position: relative;
    padding: 9px 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .sketch-loop-svg {
    position: absolute;
    inset: -4px -12px;
    width: calc(100% + 24px);
    height: calc(100% + 8px);
    pointer-events: none;
  }
  .sketch-core-text {
    font-family: ${titleFont};
    font-size: 13.5px;
    font-weight: 800;
    color: ${pal.ink};
    letter-spacing: 0.03em;
    position: relative;
    z-index: 1;
  }
  .sketch-branches-svg {
    width: 340px;
    height: 20px;
    margin-top: -2px;
  }
  .sketch-grid {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    align-content: center;
  }
  .sketch-grid.count-1,
  .sketch-grid.count-2 {
    grid-template-columns: 1fr;
    gap: 14px;
  }
  .sketch-card {
    position: relative;
    padding: 15px 15px 14px;
    border-radius: ${pal.tactileBorder ? "10px" : "14px"};
    background: ${pal.cardBg};
    border: 1.4px solid ${pal.cardBorder};
    box-shadow: 3px 3px 0 ${pal.frameBorder};
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sketch-card.is-wide {
    grid-column: 1 / -1;
  }
  .sketch-tape {
    position: absolute;
    top: -6px;
    left: 18px;
    width: 44px;
    height: 12px;
    border-radius: 2px;
    background: ${pal.tapeBg};
    transform: rotate(-2.5deg);
  }
  .sketch-card:nth-child(even) .sketch-tape {
    left: auto;
    right: 20px;
    transform: rotate(2.5deg);
  }
  .sketch-card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .sketch-num {
    font-family: Georgia, serif;
    font-style: italic;
    font-size: 14px;
    font-weight: 900;
    color: ${pal.accent};
  }
  .sketch-head {
    font-family: ${titleFont};
    font-size: 15.5px;
    font-weight: 800;
    line-height: 1.34;
    color: ${pal.ink};
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .sketch-desc {
    font-size: 12.2px;
    line-height: 1.5;
    color: ${pal.secondary};
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* ---- Layout 4: Broadsheet Magazine Infographic (单读风书摘长图) ---- */
  .broadsheet-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding-bottom: 13px;
    border-bottom: 2.5px double ${pal.ink};
    flex-shrink: 0;
  }
  .broadsheet-header-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .broadsheet-mini-book {
    padding: 2px 6px 4px 2px;
    flex-shrink: 0;
  }
  .broadsheet-list {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    justify-content: space-evenly;
  }
  .broadsheet-row {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 12px 2px;
    border-bottom: 1px solid ${pal.frameBorder};
  }
  .broadsheet-list.is-dense .broadsheet-row {
    padding: 9px 2px;
  }
  .broadsheet-row:last-child {
    border-bottom: none;
  }
  .broadsheet-num {
    font-family: Georgia, "Songti SC", serif;
    font-style: italic;
    font-size: 26px;
    font-weight: 800;
    line-height: 1;
    color: ${pal.accent};
    width: 34px;
    flex-shrink: 0;
    padding-top: 2px;
  }
  .broadsheet-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .broadsheet-head {
    font-family: ${titleFont};
    font-size: 16.5px;
    font-weight: 800;
    line-height: 1.34;
    color: ${pal.ink};
  }
  .broadsheet-desc {
    font-size: 12.8px;
    line-height: 1.56;
    color: ${pal.secondary};
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* ---- Shared Editorial Pull-Quote Callout & Colophon ---- */
  .editorial-callout {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 11px 14px;
    border-radius: ${pal.tactileBorder ? "10px" : "12px"};
    background: ${pal.quoteBg};
    border-left: 3.5px solid ${pal.quoteBorder};
    flex-shrink: 0;
  }
  .editorial-callout-mark {
    font-family: Georgia, serif;
    font-size: 22px;
    line-height: 1;
    color: ${pal.accent};
    flex-shrink: 0;
  }
  .editorial-callout-text {
    font-family: ${titleFont};
    font-size: 12.5px;
    font-weight: 700;
    line-height: 1.48;
    color: ${pal.quoteInk};
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .colophon {
    margin-top: 10px;
    padding-top: 9px;
    border-top: 1px solid ${pal.frameBorder};
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 10px;
    letter-spacing: 0.08em;
    color: ${pal.muted};
    flex-shrink: 0;
  }
  .colophon-brand {
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .colophon-dot {
    color: ${pal.accent};
  }
</style>
</head>
<body>
  <div class="canvas">
    <svg class="paper-grain" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <filter id="grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.82" numOctaves="3" stitchTiles="stitch" />
      </filter>
      <rect width="100%" height="100%" filter="url(#grain)" />
    </svg>
    <div class="sheet">
      <div class="main-body">
        ${bodyHtml}
      </div>
      ${
        showColophon
          ? `
            <div class="colophon">
              <span class="colophon-brand"><span class="colophon-dot">✦</span> 点点读书 · READING STUDIO</span>
              <span>CURATED NOTES</span>
            </div>
          `
          : ""
      }
    </div>
  </div>
</body>
</html>`;
}
