export type CardTemplateId =
  | "editorial-paper"
  | "swiss-grid"
  | "nocturne-ink"
  | "botanical-green"
  | "magazine-glass";

export interface CardTemplateMeta {
  id: CardTemplateId;
  name: string;
  subtitle: string;
  aspect: "3:4";
  width: number;
  height: number;
  swatchBg: string;
  swatchAccent: string;
}

export interface ReadingCardPayload {
  templateId: CardTemplateId;
  quote: string;
  comment: string;
  bookTitle: string;
  author: string;
  tag: string;
  dateLabel?: string;
}

export const CARD_WIDTH = 540;
export const CARD_HEIGHT = 720;

export const CARD_TEMPLATES: readonly CardTemplateMeta[] = [
  {
    id: "editorial-paper",
    name: "墨韵宣纸",
    subtitle: "温润纸感 · 经典杂志书摘",
    aspect: "3:4",
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    swatchBg: "#f6f0e4",
    swatchAccent: "#9a4a2b",
  },
  {
    id: "swiss-grid",
    name: "瑞士网格",
    subtitle: "极简几何 · 高反差观点卡",
    aspect: "3:4",
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    swatchBg: "#fbfaf7",
    swatchAccent: "#18181b",
  },
  {
    id: "nocturne-ink",
    name: "深夜书房",
    subtitle: "深焙墨黑 · 琥珀金边金句",
    aspect: "3:4",
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    swatchBg: "#171615",
    swatchAccent: "#d9a45b",
  },
  {
    id: "botanical-green",
    name: "青苔书笺",
    subtitle: "森系墨绿 · 豆瓣/小红书种草",
    aspect: "3:4",
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    swatchBg: "#eef2ec",
    swatchAccent: "#2d523c",
  },
  {
    id: "magazine-glass",
    name: "灵感刊头",
    subtitle: "现代刊物 · 暖橘渐变封面感",
    aspect: "3:4",
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    swatchBg: "#fff6ed",
    swatchAccent: "#c85527",
  },
] as const;

export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatParagraphs(text: string): string {
  const cleaned = text.trim();
  if (!cleaned) return "";
  return cleaned
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("");
}

function resolveDateLabel(dateLabel?: string): string {
  const trimmed = (dateLabel ?? "").trim();
  if (trimmed) return trimmed;
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}.${m}.${d}`;
}

export function renderReadingCardHtml(payload: ReadingCardPayload): string {
  const template = CARD_TEMPLATES.some((t) => t.id === payload.templateId)
    ? payload.templateId
    : "editorial-paper";

  const quoteHtml = formatParagraphs(payload.quote || "读一本书，最重要的是在字里行间照见自己的困惑与答案。");
  const commentText = (payload.comment || "").trim();
  const commentHtml = commentText ? formatParagraphs(commentText) : "";
  const bookTitle = escapeHtml((payload.bookTitle || "未命名书摘").trim());
  const author = escapeHtml((payload.author || "").trim());
  const tag = escapeHtml((payload.tag || "读书笔记").trim());
  const dateStr = escapeHtml(resolveDateLabel(payload.dateLabel));
  const quoteLen = (payload.quote || "").trim().length;
  const quoteSizePx = quoteLen > 180 ? 18 : quoteLen > 110 ? 21 : quoteLen > 60 ? 24 : 28;

  const themes: Record<CardTemplateId, string> = {
    "editorial-paper": `
      body { background: transparent; color: #241d17; }
      .card {
        background:
          radial-gradient(circle at 86% 12%, rgba(180, 96, 58, 0.08), transparent 45%),
          radial-gradient(circle at 12% 88%, rgba(154, 74, 43, 0.06), transparent 45%),
          linear-gradient(180deg, #faf5eb 0%, #f3eadc 100%);
        border: 1px solid rgba(120, 88, 60, 0.18);
        padding: 46px 44px 40px;
      }
      .frame {
        border: 1px solid rgba(154, 74, 43, 0.22);
        border-radius: 14px;
        height: 100%;
        padding: 34px 32px 28px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      }
      .eyebrow {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 11px;
        letter-spacing: 0.16em;
        color: #8f4729;
        text-transform: uppercase;
        border-bottom: 1px solid rgba(154, 74, 43, 0.18);
        padding-bottom: 14px;
      }
      .mark {
        font-family: Georgia, "Songti SC", serif;
        font-size: 52px;
        line-height: 0.7;
        color: rgba(154, 74, 43, 0.28);
        margin-bottom: 10px;
      }
      .quote {
        font-family: "Songti SC", "STSong", "Noto Serif SC", Georgia, serif;
        font-size: ${quoteSizePx}px;
        line-height: 1.7;
        font-weight: 600;
        color: #201913;
      }
      .comment {
        margin-top: 22px;
        padding: 14px 16px;
        border-left: 2.5px solid #9a4a2b;
        background: rgba(255, 252, 245, 0.65);
        border-radius: 0 8px 8px 0;
        font-size: 13.5px;
        line-height: 1.7;
        color: #4f4135;
      }
      .comment-label {
        font-size: 10px;
        letter-spacing: 0.14em;
        color: #9a4a2b;
        margin-bottom: 5px;
        font-weight: 600;
      }
      .footer {
        padding-top: 18px;
        border-top: 1px solid rgba(154, 74, 43, 0.18);
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
        gap: 12px;
      }
      .book-title { font-family: "Songti SC", Georgia, serif; font-size: 15px; font-weight: 700; color: #241d17; }
      .author { font-size: 12px; color: #756354; margin-top: 3px; }
      .brand { font-size: 11px; color: #9a7c66; letter-spacing: 0.08em; white-space: nowrap; }
    `,
    "swiss-grid": `
      body { background: transparent; color: #141416; }
      .card {
        background: #fcfbf9;
        border: 1.5px solid #18181b;
        padding: 36px;
      }
      .frame {
        height: 100%;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      }
      .eyebrow {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding-bottom: 14px;
        border-bottom: 2px solid #18181b;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      .tag-pill {
        background: #18181b;
        color: #fcfbf9;
        padding: 4px 10px;
        border-radius: 2px;
      }
      .mark { display: none; }
      .quote {
        font-family: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
        font-size: ${quoteSizePx}px;
        line-height: 1.55;
        font-weight: 700;
        letter-spacing: -0.02em;
        color: #111113;
      }
      .comment {
        margin-top: 24px;
        padding-top: 16px;
        border-top: 1px dashed #a1a1aa;
        font-size: 13.5px;
        line-height: 1.72;
        color: #3f3f46;
      }
      .comment-label {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.14em;
        color: #71717a;
        margin-bottom: 6px;
        text-transform: uppercase;
      }
      .footer {
        padding-top: 16px;
        border-top: 2px solid #18181b;
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
      }
      .book-title { font-size: 15px; font-weight: 800; color: #111113; }
      .author { font-size: 12px; color: #52525b; margin-top: 3px; }
      .brand { font-size: 11px; font-weight: 700; letter-spacing: 0.1em; color: #18181b; }
    `,
    "nocturne-ink": `
      body { background: transparent; color: #f5efe4; }
      .card {
        background:
          radial-gradient(circle at 80% 10%, rgba(217, 164, 91, 0.18), transparent 48%),
          radial-gradient(circle at 15% 90%, rgba(168, 108, 52, 0.14), transparent 50%),
          linear-gradient(165deg, #1b1917 0%, #11100f 100%);
        border: 1px solid rgba(217, 164, 91, 0.32);
        padding: 40px;
      }
      .frame {
        height: 100%;
        border: 1px solid rgba(217, 164, 91, 0.22);
        border-radius: 16px;
        padding: 34px 30px 28px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      }
      .eyebrow {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 11px;
        letter-spacing: 0.16em;
        color: #d9a45b;
        text-transform: uppercase;
      }
      .mark {
        font-family: Georgia, serif;
        font-size: 48px;
        line-height: 0.7;
        color: rgba(217, 164, 91, 0.45);
        margin-bottom: 10px;
      }
      .quote {
        font-family: "Songti SC", "STSong", Georgia, serif;
        font-size: ${quoteSizePx}px;
        line-height: 1.72;
        font-weight: 500;
        color: #f7f2e8;
      }
      .comment {
        margin-top: 22px;
        padding: 14px 16px;
        background: rgba(255, 255, 255, 0.045);
        border-left: 2px solid #d9a45b;
        border-radius: 0 8px 8px 0;
        font-size: 13px;
        line-height: 1.7;
        color: #cfc6b8;
      }
      .comment-label {
        font-size: 10px;
        letter-spacing: 0.14em;
        color: #d9a45b;
        margin-bottom: 6px;
      }
      .footer {
        padding-top: 16px;
        border-top: 1px solid rgba(217, 164, 91, 0.2);
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
      }
      .book-title { font-family: "Songti SC", Georgia, serif; font-size: 15px; font-weight: 600; color: #f5efe4; }
      .author { font-size: 12px; color: #a79c8e; margin-top: 3px; }
      .brand { font-size: 11px; color: #d9a45b; letter-spacing: 0.1em; opacity: 0.85; }
    `,
    "botanical-green": `
      body { background: transparent; color: #1d2c23; }
      .card {
        background:
          radial-gradient(circle at 90% 85%, rgba(45, 82, 60, 0.12), transparent 46%),
          linear-gradient(180deg, #f3f6f1 0%, #e7eee4 100%);
        border: 1px solid rgba(45, 82, 60, 0.2);
        padding: 38px;
      }
      .frame {
        height: 100%;
        background: rgba(255, 255, 255, 0.72);
        border: 1px solid rgba(45, 82, 60, 0.14);
        border-radius: 20px;
        padding: 34px 32px 28px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      }
      .eyebrow {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 11px;
        color: #2d523c;
        font-weight: 600;
        letter-spacing: 0.1em;
      }
      .tag-pill {
        background: rgba(45, 82, 60, 0.1);
        color: #234330;
        padding: 4px 12px;
        border-radius: 999px;
      }
      .mark {
        width: 36px;
        height: 3px;
        background: #2d523c;
        border-radius: 2px;
        margin-bottom: 18px;
        font-size: 0;
      }
      .quote {
        font-family: "Songti SC", "STSong", Georgia, serif;
        font-size: ${quoteSizePx}px;
        line-height: 1.7;
        font-weight: 600;
        color: #19291f;
      }
      .comment {
        margin-top: 22px;
        padding: 14px 16px;
        background: #eef4ec;
        border-radius: 12px;
        font-size: 13.5px;
        line-height: 1.7;
        color: #354c3e;
      }
      .comment-label {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.12em;
        color: #2d523c;
        margin-bottom: 5px;
      }
      .footer {
        padding-top: 16px;
        border-top: 1px solid rgba(45, 82, 60, 0.16);
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
      }
      .book-title { font-size: 15px; font-weight: 700; color: #19291f; }
      .author { font-size: 12px; color: #546b5c; margin-top: 3px; }
      .brand { font-size: 11px; color: #4e6c59; letter-spacing: 0.08em; }
    `,
    "magazine-glass": `
      body { background: transparent; color: #231914; }
      .card {
        background:
          radial-gradient(circle at 12% 14%, rgba(232, 121, 66, 0.24), transparent 46%),
          radial-gradient(circle at 88% 82%, rgba(217, 159, 89, 0.26), transparent 50%),
          linear-gradient(145deg, #fff9f2 0%, #fae9d8 100%);
        border: 1px solid rgba(200, 85, 39, 0.18);
        padding: 36px;
      }
      .frame {
        height: 100%;
        background: rgba(255, 253, 250, 0.78);
        border: 1px solid rgba(255, 255, 255, 0.9);
        border-radius: 22px;
        padding: 34px 32px 28px;
        box-shadow: 0 18px 40px rgba(154, 74, 43, 0.09);
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      }
      .eyebrow {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 11px;
        font-weight: 700;
        color: #c85527;
        letter-spacing: 0.12em;
      }
      .tag-pill {
        background: linear-gradient(135deg, #c85527, #e07a43);
        color: #fff;
        padding: 4px 12px;
        border-radius: 999px;
      }
      .mark {
        font-family: Georgia, serif;
        font-size: 56px;
        line-height: 0.68;
        color: rgba(200, 85, 39, 0.24);
        margin-bottom: 10px;
      }
      .quote {
        font-family: "Songti SC", "STSong", Georgia, serif;
        font-size: ${quoteSizePx}px;
        line-height: 1.68;
        font-weight: 700;
        color: #211610;
      }
      .comment {
        margin-top: 20px;
        padding: 14px 16px;
        background: rgba(200, 85, 39, 0.07);
        border-radius: 12px;
        font-size: 13.5px;
        line-height: 1.7;
        color: #4f372a;
      }
      .comment-label {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.12em;
        color: #c85527;
        margin-bottom: 5px;
      }
      .footer {
        padding-top: 16px;
        border-top: 1px solid rgba(200, 85, 39, 0.16);
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
      }
      .book-title { font-size: 15px; font-weight: 800; color: #211610; }
      .author { font-size: 12px; color: #7a5c4c; margin-top: 3px; }
      .brand { font-size: 11px; font-weight: 600; color: #b56542; letter-spacing: 0.06em; }
    `,
  };

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
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 100%;
    height: 100%;
    border-radius: 24px;
    overflow: hidden;
  }
  .body-block {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 20px 0;
  }
  .quote p + p { margin-top: 12px; }
  .comment p + p { margin-top: 6px; }
  ${themes[template]}
</style>
</head>
<body>
  <article class="card">
    <div class="frame">
      <header class="eyebrow">
        <span class="tag-pill">${tag}</span>
        <span>${dateStr}</span>
      </header>
      <section class="body-block">
        <div class="mark">“</div>
        <div class="quote">${quoteHtml}</div>
        ${
          commentHtml
            ? `<div class="comment"><div class="comment-label">MY NOTE</div>${commentHtml}</div>`
            : ""
        }
      </section>
      <footer class="footer">
        <div>
          <div class="book-title">《${bookTitle}》</div>
          ${author ? `<div class="author">${author}</div>` : ""}
        </div>
        <div class="brand">点点读书 · Reading Note</div>
      </footer>
    </div>
  </article>
</body>
</html>`;
}
