import { CARD_HEIGHT, CARD_WIDTH, escapeHtml } from "./cardTemplates";

export type PosterThemeId = "editorial-paper" | "nocturne-ink" | "botanical-green";

export interface MonthlyPosterPayload {
  themeId: PosterThemeId;
  monthLabel: string;
  headline: string;
  booksCount: number;
  highlightsCount: number;
  draftsCount: number;
  books: Array<{ title: string; author: string }>;
  quotes: Array<{ quote: string; bookTitle: string }>;
  keywords: string[];
  showWatermark?: boolean;
}

const POSTER_THEMES: Record<
  PosterThemeId,
  {
    bg: string;
    cardBg: string;
    border: string;
    ink: string;
    muted: string;
    accent: string;
    chipBg: string;
  }
> = {
  "editorial-paper": {
    bg: "linear-gradient(180deg, #faf4e8 0%, #efe4d2 100%)",
    cardBg: "rgba(255, 253, 248, 0.78)",
    border: "rgba(154, 74, 43, 0.22)",
    ink: "#211913",
    muted: "#6e5d4e",
    accent: "#9a4a2b",
    chipBg: "rgba(154, 74, 43, 0.1)",
  },
  "nocturne-ink": {
    bg: "linear-gradient(165deg, #1b1917 0%, #100f0e 100%)",
    cardBg: "rgba(255, 255, 255, 0.04)",
    border: "rgba(217, 164, 91, 0.25)",
    ink: "#f6efe4",
    muted: "#ada295",
    accent: "#d9a45b",
    chipBg: "rgba(217, 164, 91, 0.14)",
  },
  "botanical-green": {
    bg: "linear-gradient(180deg, #f2f6f0 0%, #e4ede0 100%)",
    cardBg: "rgba(255, 255, 255, 0.78)",
    border: "rgba(45, 82, 60, 0.2)",
    ink: "#1a2a20",
    muted: "#4d6456",
    accent: "#2d523c",
    chipBg: "rgba(45, 82, 60, 0.1)",
  },
};

export function renderMonthlyPosterHtml(payload: MonthlyPosterPayload): string {
  const t = POSTER_THEMES[payload.themeId] ?? POSTER_THEMES["editorial-paper"];
  const monthLabel = escapeHtml(payload.monthLabel || "2026 · 11");
  const headline = escapeHtml(payload.headline || "我的阅读月报");

  const booksHtml = payload.books
    .slice(0, 6)
    .map(
      (b) =>
        `<span class="book-pill">《${escapeHtml(b.title.slice(0, 18))}》${b.author ? ` · ${escapeHtml(b.author.slice(0, 10))}` : ""}</span>`,
    )
    .join("");

  const quotesHtml = payload.quotes
    .slice(0, 3)
    .map(
      (q) => `
      <div class="q-item">
        <div class="q-text">“${escapeHtml(q.quote.slice(0, 96))}${q.quote.length > 96 ? "…" : ""}”</div>
        <div class="q-src">—— 《${escapeHtml(q.bookTitle)}》</div>
      </div>`,
    )
    .join("");

  const keywordsHtml = payload.keywords
    .slice(0, 6)
    .map((k) => `<span class="kw"># ${escapeHtml(k)}</span>`)
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: ${CARD_WIDTH}px;
    height: ${CARD_HEIGHT}px;
    overflow: hidden;
    background: transparent;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .poster {
    width: 100%;
    height: 100%;
    border-radius: 24px;
    background: ${t.bg};
    border: 1px solid ${t.border};
    padding: 32px;
    color: ${t.ink};
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 14px;
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    padding-bottom: 12px;
    border-bottom: 1px solid ${t.border};
  }
  .kicker {
    font-size: 10px;
    letter-spacing: 0.18em;
    color: ${t.accent};
    font-weight: 700;
    margin-bottom: 4px;
  }
  .title {
    font-family: "Songti SC", "STSong", Georgia, serif;
    font-size: 26px;
    font-weight: 700;
    line-height: 1.2;
  }
  .month {
    font-family: Georgia, serif;
    font-size: 20px;
    font-weight: 700;
    color: ${t.accent};
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
  }
  .stat-box {
    background: ${t.cardBg};
    border: 1px solid ${t.border};
    border-radius: 12px;
    padding: 12px 10px;
    text-align: center;
  }
  .stat-num {
    font-family: Georgia, serif;
    font-size: 26px;
    font-weight: 700;
    color: ${t.accent};
    line-height: 1.1;
  }
  .stat-label {
    font-size: 11px;
    color: ${t.muted};
    margin-top: 4px;
  }
  .section-label {
    font-size: 10.5px;
    letter-spacing: 0.14em;
    font-weight: 700;
    color: ${t.accent};
    margin-bottom: 7px;
  }
  .books-wrap {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .book-pill {
    font-size: 11.5px;
    padding: 4px 10px;
    border-radius: 999px;
    background: ${t.cardBg};
    border: 1px solid ${t.border};
    color: ${t.ink};
  }
  .quotes {
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1;
    min-height: 0;
    justify-content: safe center;
    overflow: hidden;
  }
  .q-item {
    background: ${t.cardBg};
    border-left: 3px solid ${t.accent};
    border-radius: 0 10px 10px 0;
    padding: 10px 12px;
    flex-shrink: 0;
  }
  .q-text {
    font-family: "Songti SC", Georgia, serif;
    font-size: 13px;
    line-height: 1.58;
    color: ${t.ink};
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .q-src {
    font-size: 10.5px;
    color: ${t.muted};
    margin-top: 4px;
    text-align: right;
  }
  .kw-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .kw {
    font-size: 11px;
    font-weight: 600;
    padding: 3px 10px;
    border-radius: 999px;
    background: ${t.chipBg};
    color: ${t.accent};
  }
  .footer {
    padding-top: 10px;
    border-top: 1px solid ${t.border};
    display: flex;
    justify-content: space-between;
    font-size: 10.5px;
    color: ${t.muted};
  }
</style>
</head>
<body>
  <article class="poster">
    <header class="header">
      <div>
        <div class="kicker">MONTHLY READING DIGEST</div>
        <h1 class="title">${headline}</h1>
      </div>
      <div class="month">${monthLabel}</div>
    </header>

    <section class="stats">
      <div class="stat-box">
        <div class="stat-num">${payload.booksCount}</div>
        <div class="stat-label">在读 / 归档书目</div>
      </div>
      <div class="stat-box">
        <div class="stat-num">${payload.highlightsCount}</div>
        <div class="stat-label">沉淀划线与想法</div>
      </div>
      <div class="stat-box">
        <div class="stat-num">${payload.draftsCount}</div>
        <div class="stat-label">个人输出草稿</div>
      </div>
    </section>

    ${
      booksHtml
        ? `<section><div class="section-label">SHELF · 本期书单</div><div class="books-wrap">${booksHtml}</div></section>`
        : ""
    }

    <section class="quotes">
      <div class="section-label">HIGHLIGHTS · 最触动我的句子</div>
      ${quotesHtml || `<div class="q-item"><div class="q-text">“把读过的书，变成自己看世界的坐标系。”</div></div>`}
    </section>

    ${
      keywordsHtml
        ? `<section><div class="section-label">KEYWORDS · 高频思考词</div><div class="kw-row">${keywordsHtml}</div></section>`
        : ""
    }

    <footer class="footer">
      <span>${payload.showWatermark !== false ? "点点读书 · Diandian Reading Studio" : "Reading Digest"}</span>
      <span>Keep Reading · Keep Thinking</span>
    </footer>
  </article>
</body>
</html>`;
}
