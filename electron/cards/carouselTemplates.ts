import { CARD_HEIGHT, CARD_WIDTH, escapeHtml, type CardTemplateId } from "./cardTemplates";

export type CarouselSlideKind = "cover" | "body" | "outro";

export interface CarouselSlide {
  id: string;
  kind: CarouselSlideKind;
  heading: string;
  body: string;
  accentNote?: string;
}

export interface CarouselDeckPayload {
  templateId: CardTemplateId;
  bookTitle: string;
  author: string;
  tag: string;
  slides: CarouselSlide[];
}

function stripMdMarkers(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

/**
 * Intelligently split a reading essay / book review into a Xiaohongshu 3:4
 * carousel deck: 1 Cover slide + balanced Body slides + 1 Outro slide.
 */
export function splitTextIntoCarouselSlides(input: {
  title: string;
  bookTitle: string;
  author?: string;
  content: string;
  maxBodySlides?: number;
}): CarouselSlide[] {
  const maxBody = Math.max(1, Math.min(8, input.maxBodySlides ?? 5));
  const rawParagraphs = input.content
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const coverTitle = input.title.trim() || (input.bookTitle ? `读《${input.bookTitle}》` : "读书笔记");
  const firstHook =
    rawParagraphs.length > 0
      ? stripMdMarkers(rawParagraphs[0]!.split("\n")[0] ?? "").slice(0, 88)
      : "把读过的书，变成自己的判断力。";

  const slides: CarouselSlide[] = [
    {
      id: "slide-cover",
      kind: "cover",
      heading: coverTitle,
      body: firstHook,
      accentNote: input.bookTitle ? `《${input.bookTitle}》${input.author ? ` · ${input.author}` : ""}` : "",
    },
  ];

  // Pack paragraphs into balanced body slides (~150-230 chars each) or break on Markdown headings.
  const bodyChunks: Array<{ heading: string; paragraphs: string[] }> = [];
  let current: { heading: string; paragraphs: string[] } = { heading: "", paragraphs: [] };
  let currentLen = 0;

  const flush = () => {
    if (current.heading || current.paragraphs.length > 0) {
      bodyChunks.push(current);
      current = { heading: "", paragraphs: [] };
      currentLen = 0;
    }
  };

  for (const para of rawParagraphs) {
    const lines = para.split("\n").map((l) => l.trim()).filter(Boolean);
    const firstLine = lines[0] ?? "";
    const isHeading = /^#{1,4}\s+/.test(firstLine);

    if (isHeading) {
      flush();
      current.heading = stripMdMarkers(firstLine);
      const rest = lines.slice(1).map(stripMdMarkers).filter(Boolean);
      if (rest.length > 0) {
        current.paragraphs.push(rest.join("\n"));
        currentLen += rest.join("\n").length;
      }
      continue;
    }

    const cleaned = lines.map(stripMdMarkers).join("\n");
    if (currentLen > 0 && currentLen + cleaned.length > 230 && bodyChunks.length < maxBody - 1) {
      flush();
    }
    current.paragraphs.push(cleaned);
    currentLen += cleaned.length;
  }
  flush();

  const usableChunks = bodyChunks.slice(0, maxBody);
  if (usableChunks.length === 0) {
    usableChunks.push({
      heading: "核心思考",
      paragraphs: [input.content.trim() || "写下这本书最打动你的 1–3 个真实洞察。"],
    });
  }

  usableChunks.forEach((chunk, idx) => {
    slides.push({
      id: `slide-body-${idx + 1}`,
      kind: "body",
      heading: chunk.heading || `观点 0${idx + 1}`,
      body: chunk.paragraphs.join("\n\n"),
    });
  });

  slides.push({
    id: "slide-outro",
    kind: "outro",
    heading: input.bookTitle ? `推荐共读《${input.bookTitle}》` : "读完记一笔",
    body: "好书值得反复重读，更值得留下你此刻真实的批注与思考。",
    accentNote: input.author ? `作者 · ${input.author}` : "点点读书 · 本地伴读工作台",
  });

  return slides;
}

const DECK_THEME_VARS: Record<
  CardTemplateId,
  {
    bg: string;
    frameBg: string;
    border: string;
    ink: string;
    muted: string;
    accent: string;
    accentSoft: string;
    pillBg: string;
    pillFg: string;
  }
> = {
  "editorial-paper": {
    bg: "linear-gradient(180deg, #faf5eb 0%, #f1e7d7 100%)",
    frameBg: "transparent",
    border: "rgba(154, 74, 43, 0.24)",
    ink: "#201913",
    muted: "#6e5d4e",
    accent: "#9a4a2b",
    accentSoft: "rgba(154, 74, 43, 0.09)",
    pillBg: "#9a4a2b",
    pillFg: "#fffdf9",
  },
  "swiss-grid": {
    bg: "#fcfbf9",
    frameBg: "transparent",
    border: "#18181b",
    ink: "#111113",
    muted: "#52525b",
    accent: "#18181b",
    accentSoft: "#f4f4f5",
    pillBg: "#18181b",
    pillFg: "#fcfbf9",
  },
  "nocturne-ink": {
    bg: "linear-gradient(165deg, #1b1917 0%, #100f0e 100%)",
    frameBg: "rgba(255,255,255,0.02)",
    border: "rgba(217, 164, 91, 0.28)",
    ink: "#f6f0e5",
    muted: "#afa496",
    accent: "#d9a45b",
    accentSoft: "rgba(217, 164, 91, 0.12)",
    pillBg: "#d9a45b",
    pillFg: "#171412",
  },
  "botanical-green": {
    bg: "linear-gradient(180deg, #f2f6f0 0%, #e5ede1 100%)",
    frameBg: "rgba(255, 255, 255, 0.72)",
    border: "rgba(45, 82, 60, 0.22)",
    ink: "#1a2a20",
    muted: "#4d6456",
    accent: "#2d523c",
    accentSoft: "rgba(45, 82, 60, 0.09)",
    pillBg: "#2d523c",
    pillFg: "#ffffff",
  },
  "magazine-glass": {
    bg: "radial-gradient(circle at 12% 14%, rgba(232,121,66,0.25), transparent 46%), linear-gradient(145deg, #fff9f2 0%, #fae9d8 100%)",
    frameBg: "rgba(255, 253, 250, 0.8)",
    border: "rgba(200, 85, 39, 0.22)",
    ink: "#211610",
    muted: "#705344",
    accent: "#c85527",
    accentSoft: "rgba(200, 85, 39, 0.09)",
    pillBg: "linear-gradient(135deg, #c85527, #e07a43)",
    pillFg: "#ffffff",
  },
};

export function renderCarouselSlideHtml(
  deck: CarouselDeckPayload,
  slideIndex: number,
): string {
  const slide = deck.slides[slideIndex];
  if (!slide) {
    throw new Error(`无效的卡片页码: ${slideIndex}`);
  }
  const theme = DECK_THEME_VARS[deck.templateId] ?? DECK_THEME_VARS["editorial-paper"];
  const total = deck.slides.length;
  const pageNum = `${String(slideIndex + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`;
  const tag = escapeHtml(deck.tag || "读书笔记");
  const bookTitle = escapeHtml(deck.bookTitle || "点点读书");
  const author = escapeHtml(deck.author || "");

  const bodyHtml = slide.body
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `<p>${escapeHtml(l)}</p>`)
    .join("");

  const isCover = slide.kind === "cover";
  const isOutro = slide.kind === "outro";
  const bodySize = slide.body.length > 220 ? 16 : slide.body.length > 140 ? 18 : 20;

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
  .card {
    width: 100%;
    height: 100%;
    border-radius: 24px;
    background: ${theme.bg};
    border: 1px solid ${theme.border};
    padding: 36px;
    color: ${theme.ink};
  }
  .frame {
    width: 100%;
    height: 100%;
    border-radius: 16px;
    background: ${theme.frameBg};
    border: 1px solid ${theme.border};
    padding: 30px 30px 26px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }
  .top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-bottom: 14px;
    border-bottom: 1px solid ${theme.border};
    font-size: 11px;
    letter-spacing: 0.14em;
    font-weight: 700;
    color: ${theme.accent};
  }
  .pill {
    background: ${theme.pillBg};
    color: ${theme.pillFg};
    padding: 4px 11px;
    border-radius: 999px;
    letter-spacing: 0.08em;
  }
  .center {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 18px;
    padding: 18px 0;
  }
  .cover-title {
    font-family: "Songti SC", "STSong", "Noto Serif SC", Georgia, serif;
    font-size: 36px;
    line-height: 1.38;
    font-weight: 700;
    color: ${theme.ink};
  }
  .cover-hook {
    font-size: 16px;
    line-height: 1.75;
    color: ${theme.muted};
    padding-left: 14px;
    border-left: 3px solid ${theme.accent};
  }
  .cover-chip {
    align-self: flex-start;
    padding: 7px 14px;
    border-radius: 10px;
    background: ${theme.accentSoft};
    color: ${theme.accent};
    font-size: 13px;
    font-weight: 600;
  }
  .slide-num {
    font-family: Georgia, serif;
    font-size: 40px;
    line-height: 1;
    font-weight: 700;
    color: ${theme.accent};
    opacity: 0.35;
  }
  .body-heading {
    font-family: "Songti SC", "STSong", Georgia, serif;
    font-size: 24px;
    line-height: 1.4;
    font-weight: 700;
    color: ${theme.ink};
  }
  .body-text {
    font-size: ${bodySize}px;
    line-height: 1.78;
    color: ${theme.ink};
  }
  .body-text p + p { margin-top: 12px; }
  .outro-box {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
  }
  .outro-title {
    font-family: "Songti SC", Georgia, serif;
    font-size: 26px;
    font-weight: 700;
  }
  .outro-desc {
    font-size: 15px;
    line-height: 1.75;
    color: ${theme.muted};
    max-width: 340px;
  }
  .bottom {
    padding-top: 14px;
    border-top: 1px solid ${theme.border};
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 11.5px;
    color: ${theme.muted};
  }
  .swipe {
    color: ${theme.accent};
    font-weight: 600;
  }
</style>
</head>
<body>
  <article class="card">
    <div class="frame">
      <header class="top">
        <span class="pill">${tag}</span>
        <span>${pageNum}</span>
      </header>

      <main class="center">
        ${
          isCover
            ? `
              <h1 class="cover-title">${escapeHtml(slide.heading)}</h1>
              <div class="cover-hook">${bodyHtml}</div>
              ${slide.accentNote ? `<div class="cover-chip">${escapeHtml(slide.accentNote)}</div>` : ""}
            `
            : isOutro
              ? `
                <div class="outro-box">
                  <div class="cover-chip" style="align-self:center;">READING DECK · END</div>
                  <h2 class="outro-title">${escapeHtml(slide.heading)}</h2>
                  <div class="outro-desc">${bodyHtml}</div>
                  ${slide.accentNote ? `<div style="font-size:12.5px;color:${theme.accent};font-weight:600;">${escapeHtml(slide.accentNote)}</div>` : ""}
                </div>
              `
              : `
                <div class="slide-num">${String(slideIndex + 1).padStart(2, "0")}</div>
                <h2 class="body-heading">${escapeHtml(slide.heading)}</h2>
                <div class="body-text">${bodyHtml}</div>
              `
        }
      </main>

      <footer class="bottom">
        <span>《${bookTitle}》${author ? ` · ${author}` : ""}</span>
        <span class="swipe">${slideIndex < total - 1 ? "左滑继续 →" : "点点读书"}</span>
      </footer>
    </div>
  </article>
</body>
</html>`;
}
