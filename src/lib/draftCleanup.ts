import type { DraftKind } from "../types/desktop";

export interface PreparedDraft {
  title: string;
  content: string;
  kind: DraftKind;
  bookTitle?: string;
}

const GENERIC_SITE_TITLES = new Set([
  "微信读书",
  "weread",
  "豆瓣",
  "豆瓣读书",
  "小红书",
  "小红书创作",
  "小红书创作服务平台",
  "公众号",
  "微信公众号",
  "知乎",
  "哔哩哔哩",
  "b 站创作中心",
  "新标签页",
  "阅读页",
  "网页摘录",
  "加载中",
]);

function isGenericSiteName(name: string): boolean {
  const clean = name.trim().toLowerCase().replace(/^《|》$/g, "");
  if (!clean) return true;
  if (GENERIC_SITE_TITLES.has(clean)) return true;
  return /^(微信读书|豆瓣读书|小红书|微信公众号|新标签页|加载中)/.test(clean);
}

function cleanBookTitleCandidate(raw: string): string {
  const stripped = raw
    .replace(/\s*[-–—|]\s*(微信读书|WeRead|豆瓣读书|豆瓣|小红书|知乎|哔哩哔哩).*$/i, "")
    .replace(/^《|》$/g, "")
    .replace(/^「|」$/g, "")
    .trim();
  if (!stripped || isGenericSiteName(stripped)) return "";
  return stripped;
}

function shortenBookName(name: string): string {
  // Trim edition parentheticals like "（第2版）" when constructing concise titles
  const compact = name.replace(/[（(][^）)]*(?:版|修订|纪念|珍藏|全译|典藏)[^）)]*[）)]/g, "").trim();
  return compact || name;
}

function extractBookAndChapter(
  rawContent: string,
  options?: { bookHint?: string | null; pageTitle?: string | null },
): { bookTitle: string; chapterTitle: string } {
  let bookTitle = "";
  let chapterTitle = "";

  // 1. Explicit "书目「...」" or "《...》" in reply
  const explicitBookMatch =
    rawContent.match(/(?:新建书目|书目|书库[（(]|读)\s*[「《]([^」》\n]{2,40})[」》]/)
    ?? rawContent.match(/《([^》\n]{2,36})》/);
  if (explicitBookMatch?.[1]) {
    bookTitle = cleanBookTitleCandidate(explicitBookMatch[1]);
  }

  // 2. Explicit chapter clue like 章节都归到「相信·2008年8月20日」
  const chapterMatch = rawContent.match(/(?:章节(?:都?归到|标为|为)?)\s*[「《]([^」》\n]{1,28})[」》]/);
  if (chapterMatch?.[1]) {
    const rawChap = chapterMatch[1].trim();
    const firstSeg = rawChap.split(/[·\-—|]/)[0]?.trim() || rawChap;
    if (firstSeg && firstSeg.length <= 16 && firstSeg !== bookTitle) {
      chapterTitle = firstSeg;
    }
  }

  // 3. Fallback to pageTitle / bookHint from app context
  if (!bookTitle && options?.pageTitle) {
    const parts = options.pageTitle
      .replace(/\s*[-–—|]\s*(微信读书|WeRead|豆瓣读书|豆瓣|小红书|知乎|哔哩哔哩).*$/i, "")
      .split(/\s+[-–—·]\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const first = parts[0] ? cleanBookTitleCandidate(parts[0]) : "";
    if (first) {
      bookTitle = first;
      if (!chapterTitle && parts[1] && parts[1].length <= 16 && !isGenericSiteName(parts[1])) {
        chapterTitle = parts[1];
      }
    }
  }
  if (!bookTitle && options?.bookHint) {
    bookTitle = cleanBookTitleCandidate(options.bookHint);
  }

  return { bookTitle, chapterTitle };
}

function isLeadingChatChatter(paragraph: string): boolean {
  const p = paragraph.trim();
  if (!p || p.startsWith("#") || p.startsWith(">")) return false;
  if (p.length > 260) return false;
  return (
    /(已|已经)(存|记|写|添|保存|录入|收入)(入|进)?(本地)?书库/.test(p)
    || /新建书目|章节都?归到|章节标为/.test(p)
    || /^(好的[，,。！!]?|收到[，,。！!]?|没问题|我先(查|看|读|找|帮)|帮你(整理|提炼|找|看)|以下是我为你|下面为你|根据右侧|右边这一屏|右侧(这)?一?页)/.test(p)
    || /(只提炼这屏上真正出现过的话|不替他把论证补完|抓不到正文|只取到\s*\d+\s*个字符)/.test(p)
  );
}

function isTrailingChatOffer(paragraph: string): boolean {
  const p = paragraph.trim();
  if (!p || p.startsWith("#") || p.startsWith(">")) return false;
  if (p.length > 260) return false;
  return (
    /(要是你想|如果你想|如果(你)?需要|需要的话我(可以|能)|要不要我|要我把这段|往下滚一屏|再叫我|随时(叫|告诉)我|想继续的话|告诉我一两本)/.test(p)
    || /(存进创作工作台|串成一张卡片文案|整理成可发的小红书|补第.+条的思考)/.test(p)
  );
}

function cleanTitleBoundary(raw: string, maxLen = 28): string {
  const cleaned = raw
    .replace(/^[#>*\-\s]+/, "")
    .replace(/\*\*|__/g, "")
    .replace(/`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxLen) return cleaned;

  const slice = cleaned.slice(0, maxLen);
  // Prefer ending at sentence/clause punctuation instead of cutting mid-word/mid-bracket
  const punctIdx = Math.max(
    slice.lastIndexOf("。"),
    slice.lastIndexOf("！"),
    slice.lastIndexOf("？"),
    slice.lastIndexOf("，"),
    slice.lastIndexOf("；"),
    slice.lastIndexOf("："),
  );
  if (punctIdx >= 10) {
    return slice.slice(0, punctIdx).trim();
  }
  return slice.replace(/[（(「『《【\[，,、：:；;\-—\s]+$/, "").trim();
}

function normalizeSectionMarkers(body: string): string {
  return body
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      // Convert standalone bold Chinese/Arabic section markers like "**一**" or "**一、标题**" into H3
      const boldNumOnly = trimmed.match(/^\*\*([一二三四五六七八九十]+|\d{1,2})\*\*$/);
      if (boldNumOnly?.[1]) {
        return `### ${boldNumOnly[1]}`;
      }
      const boldHeading = trimmed.match(/^\*\*([一二三四五六七八九十]+[、.．]\s*[^*]{1,28})\*\*$/);
      if (boldHeading?.[1]) {
        return `### ${boldHeading[1].trim()}`;
      }
      return line;
    })
    .join("\n");
}

/**
 * Clean a raw AI chat reply before saving it as a studio draft:
 * - Strips conversational tool/status openers and follow-up chat offers
 * - Normalizes standalone bold section markers into proper Markdown headings
 * - Derives a concise, non-truncated title from explicit headings or book context
 */
export function prepareDraftFromAssistantReply(
  rawContent: string,
  options?: { bookHint?: string | null; pageTitle?: string | null },
): PreparedDraft {
  const normalized = rawContent.replace(/\r\n/g, "\n").trim();
  const { bookTitle, chapterTitle } = extractBookAndChapter(normalized, options);

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  // Strip up to 2 leading conversational chatter paragraphs (only if real content remains)
  let start = 0;
  while (start < paragraphs.length - 1 && start < 2 && isLeadingChatChatter(paragraphs[start]!)) {
    start++;
  }

  // Strip up to 2 trailing conversational follow-up paragraphs (only if real content remains)
  let end = paragraphs.length;
  while (end - start > 1 && paragraphs.length - end < 2 && isTrailingChatOffer(paragraphs[end - 1]!)) {
    end--;
  }

  const kept = paragraphs.slice(start, end);
  let body = normalizeSectionMarkers(kept.join("\n\n")).trim() || normalized;

  // Check if the cleaned body starts with a meaningful Markdown H1/H2 title
  let title = "";
  const bodyLines = body.split("\n");
  const firstLineTrimmed = (bodyLines[0] ?? "").trim();
  const headingMatch = firstLineTrimmed.match(/^#{1,2}\s+(.+)$/);
  if (headingMatch?.[1]) {
    const candidate = cleanTitleBoundary(headingMatch[1], 30);
    if (candidate.length >= 3 && !/^[一二三四五六七八九十\d]+$/.test(candidate)) {
      title = candidate;
      // Avoid duplicating the promoted H1/H2 title on line 1 of the body
      body = bodyLines.slice(1).join("\n").trim() || body;
    }
  }

  // Priority 2: Book + chapter title
  if (!title && bookTitle) {
    const shortBook = shortenBookName(bookTitle);
    if (chapterTitle && `${shortBook}${chapterTitle}`.length <= 22) {
      title = `《${shortBook}》· ${chapterTitle}`;
    } else {
      title = `读《${cleanTitleBoundary(shortBook, 20)}》随笔`;
    }
  }

  // Priority 3: First meaningful non-marker line from cleaned body
  if (!title) {
    const meaningfulLine = body
      .split("\n")
      .map((l) => l.replace(/^[#>*\-\s]+/, "").replace(/\*\*|__/g, "").trim())
      .find((l) => l.length >= 4 && !/^[一二三四五六七八九十\d、.．]+$/.test(l));
    title = meaningfulLine ? cleanTitleBoundary(meaningfulLine, 26) : "读书思考初稿";
  }

  const quoteCount = (body.match(/^>\s+/gm) || []).length;
  const sectionCount = (body.match(/^#{2,3}\s+/gm) || []).length;
  const kind: DraftKind = quoteCount >= 2 || sectionCount >= 2 ? "note" : "review";

  return {
    title: title || "读书思考初稿",
    content: body,
    kind,
    ...(bookTitle ? { bookTitle } : {}),
  };
}

export function cleanQuoteDraftTitle(bookTitle: string | undefined, quote: string): string {
  const cleanBook = bookTitle ? cleanBookTitleCandidate(bookTitle) : "";
  if (cleanBook) {
    return `读《${cleanTitleBoundary(shortenBookName(cleanBook), 20)}》有感`;
  }
  const snippet = cleanTitleBoundary(quote, 22);
  return snippet || "读书摘录随笔";
}

/**
 * Returns true if an already-saved draft's title or body contains AI conversational chatter
 * that can be cleanly stripped with one click.
 */
export function hasDraftChatter(title: string, content: string): boolean {
  const trimmedTitle = title.trim();
  if (
    isLeadingChatChatter(trimmedTitle)
    || /^(读《(微信读书|豆瓣读书|小红书)》)/.test(trimmedTitle)
  ) {
    return true;
  }
  const paragraphs = content
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length < 2) return false;
  return (
    isLeadingChatChatter(paragraphs[0]!)
    || isTrailingChatOffer(paragraphs[paragraphs.length - 1]!)
  );
}
