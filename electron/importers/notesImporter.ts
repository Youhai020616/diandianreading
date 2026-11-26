import type { BookSource, KnowledgeDatabase } from "../storage/database";

export interface ParsedHighlightItem {
  bookTitle: string;
  bookAuthor: string;
  chapter: string;
  quote: string;
  note: string;
  source: BookSource;
}

export interface ImportNotesResult {
  format: "kindle" | "weread" | "generic";
  booksTouched: number;
  importedCount: number;
  deduplicatedCount: number;
  bookIds: string[];
}

interface ImportOptions {
  format?: "auto" | "kindle" | "weread";
  fallbackTitle?: string;
  fallbackAuthor?: string;
  fileTitle?: string;
}

/**
 * Parse Kindle `My Clippings.txt` (supports both English and Chinese Kindle headers).
 */
/**
 * Kindle gives no chapter, only a metadata line ("Your Highlight on page 19 | Location 280-282 | Added on
 * …", "您在第 12 页（位置 #170-171）的标注 | 添加于 …"). Keep where the passage is, e.g. "第 19 页 · 位置
 * 280-282"; the import date is not a chapter.
 */
export function kindleLocationLabel(metaLine: string): string {
  const meta = metaLine.replace(/^-\s*/, "").trim();
  const page = /\bpage\s+([\w-]+)/i.exec(meta)?.[1] ?? /第\s*([\w-]+)\s*页/.exec(meta)?.[1];
  const location = /\blocation\s+#?([\d-]+)/i.exec(meta)?.[1] ?? /位置\s*#?\s*([\d-]+)/.exec(meta)?.[1];
  const parts = [page ? `第 ${page} 页` : "", location ? `位置 ${location}` : ""].filter(Boolean);
  if (parts.length > 0) return parts.join(" · ");
  return (meta.split("|")[0] ?? "").trim().slice(0, 80);
}

export function parseKindleClippings(rawText: string): ParsedHighlightItem[] {
  const normalized = rawText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const blocks = normalized
    .split(/^==========\s*$/m)
    .map((b) => b.trim())
    .filter(Boolean);

  const items: ParsedHighlightItem[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim());
    if (lines.length < 3) continue;

    const headerLine = lines[0] ?? "";
    const metaLine = lines[1] ?? "";
    const body = lines.slice(2).filter(Boolean).join("\n").trim();
    if (!body) continue;

    // Skip pure bookmarks without text.
    if (/Your Bookmark|您的书签/i.test(metaLine)) continue;

    let bookTitle = headerLine;
    let bookAuthor = "";
    const authorMatch = /^(.*)\(([^()]+)\)\s*$/.exec(headerLine);
    if (authorMatch && authorMatch[1] && authorMatch[2]) {
      bookTitle = authorMatch[1].trim();
      bookAuthor = authorMatch[2].trim();
    }

    const isNote = /Your Note|您的笔记/i.test(metaLine);
    const previous = items.at(-1);
    if (isNote && previous?.bookTitle === bookTitle && previous.bookAuthor === bookAuthor && !previous.note) {
      previous.note = body;
      continue;
    }

    items.push({
      bookTitle: bookTitle || "未命名 Kindle 书籍",
      bookAuthor,
      chapter: kindleLocationLabel(metaLine),
      quote: body,
      note: "",
      source: "kindle",
    });
  }

  return items;
}

/**
 * Parse WeRead exported notes (App "导出笔记" / Markdown / copied highlight blocks).
 */
export function parseWeReadNotes(
  rawText: string,
  fallbackTitle = "",
  fallbackAuthor = "",
  fileTitle = "",
): ParsedHighlightItem[] {
  const lines = rawText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");

  let bookTitle = fallbackTitle.trim() || fileTitle.trim() || "微信读书笔记";
  let hasTitleHeading = false;
  let bookAuthor = fallbackAuthor.trim();
  let currentChapter = "";
  const items: ParsedHighlightItem[] = [];

  let i = 0;
  // Detect leading title / author lines before first chapter marker `◆` or highlight `>>`.
  const preamble: string[] = [];
  while (i < lines.length) {
    const line = (lines[i] ?? "").trim();
    if (!line) {
      i++;
      continue;
    }
    if (line.startsWith("◆") || line.startsWith(">>") || line.startsWith("> ") || line.startsWith("## ") || line.startsWith("•")) {
      break;
    }
    if (line.startsWith("# ")) {
      bookTitle = line.slice(2).trim() || bookTitle;
      hasTitleHeading = true;
      i++;
      continue;
    }
    if (/^\d+\s*个笔记/.test(line) || /^来自微信读书/.test(line)) {
      i++;
      continue;
    }
    preamble.push(line);
    i++;
    if (preamble.length >= 2) break;
  }

  if (!hasTitleHeading && preamble[0] && !fallbackTitle.trim()) bookTitle = preamble[0];
  if (!bookAuthor) bookAuthor = preamble[hasTitleHeading ? 0 : 1] ?? "";

  let pendingThought = "";
  for (; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line) continue;
    if (/^--\s*来自微信读书/.test(line) || /^\d{4}\/\d{2}\/\d{2}\s+发表想法/.test(line)) continue;

    if (line.startsWith("◆ ")) {
      currentChapter = line.slice(2).trim();
      pendingThought = "";
      continue;
    }
    if (line.startsWith("## ") || line.startsWith("### ")) {
      currentChapter = line.replace(/^#+\s*/, "").trim();
      pendingThought = "";
      continue;
    }

    if (line.startsWith(">>") || line.startsWith("> ")) {
      const quote = line.replace(/^>>?\s*/, "").trim();
      if (!quote) continue;
      items.push({
        bookTitle,
        bookAuthor,
        chapter: currentChapter,
        quote,
        note: pendingThought,
        source: "weread",
      });
      pendingThought = "";
      continue;
    }

    if (line.startsWith("• ") || line.startsWith("- ") || line.startsWith("* ")) {
      const text = line.slice(2).trim();
      if (!text) continue;
      // If followed by `>>` quote, treat as thought; otherwise treat as highlight.
      const nextNonEmpty = lines.slice(i + 1).find((l) => l.trim().length > 0)?.trim() ?? "";
      if (nextNonEmpty.startsWith(">>") || nextNonEmpty.startsWith("> ")) {
        pendingThought = text;
      } else {
        items.push({
          bookTitle,
          bookAuthor,
          chapter: currentChapter,
          quote: text,
          note: "",
          source: "weread",
        });
      }
      continue;
    }

    // Standalone paragraph: if next line is `>>`, treat as user's thought attached to that quote.
    const nextLine = lines.slice(i + 1).find((l) => l.trim().length > 0)?.trim() ?? "";
    if (nextLine.startsWith(">>") || nextLine.startsWith("> ")) {
      pendingThought = pendingThought ? `${pendingThought}\n${line}` : line;
    } else if (items.length > 0 && /^(想法|笔记|点评)[:：]/.test(line)) {
      const thought = line.replace(/^(想法|笔记|点评)[:：]\s*/, "").trim();
      if (thought) {
        const prev = items[items.length - 1]!;
        prev.note = prev.note ? `${prev.note}\n${thought}` : thought;
      }
    } else if (line.length >= 8) {
      items.push({
        bookTitle,
        bookAuthor,
        chapter: currentChapter,
        quote: line,
        note: "",
        source: "weread",
      });
    }
  }

  return items;
}

export function detectAndParseNotes(
  rawText: string,
  options: ImportOptions = {},
): { format: "kindle" | "weread" | "generic"; items: ParsedHighlightItem[] } {
  const mode = options.format ?? "auto";
  if (mode === "kindle" || (mode === "auto" && /^==========\s*$/m.test(rawText))) {
    return { format: "kindle", items: parseKindleClippings(rawText) };
  }
  const hasWeReadMarkers = /^◆\s|^>>\s|来自微信读书/m.test(rawText);
  if (mode === "weread" || hasWeReadMarkers) {
    return {
      format: "weread",
      items: parseWeReadNotes(rawText, options.fallbackTitle, options.fallbackAuthor, options.fileTitle),
    };
  }
  return {
    format: "generic",
    items: parseWeReadNotes(rawText, options.fallbackTitle || options.fileTitle || "导入笔记", options.fallbackAuthor),
  };
}

export function importNotesIntoDatabase(
  db: KnowledgeDatabase,
  rawText: string,
  options: ImportOptions = {},
): ImportNotesResult {
  const { format, items } = detectAndParseNotes(rawText, options);
  if (items.length === 0) {
    throw new Error("未在文本中识别到有效的划线或笔记条目");
  }

  return db.transaction(() => {
    const bookIdByKey = new Map<string, string>();
    const touchedBooks = new Set<string>();
    let importedCount = 0;
    let deduplicatedCount = 0;

    for (const item of items) {
      const key = JSON.stringify([item.bookTitle, item.bookAuthor]);
      let bookId = bookIdByKey.get(key);
      if (!bookId) {
        const book = db.findOrCreateBook({
          title: item.bookTitle,
          author: item.bookAuthor,
          source: item.source,
        });
        bookId = book.id;
        bookIdByKey.set(key, bookId);
      }
      touchedBooks.add(bookId);

      const added = db.addHighlight({
        bookId,
        chapter: item.chapter,
        quote: item.quote,
        note: item.note,
        source: item.source,
      });
      if (added.deduplicated) deduplicatedCount++;
      else importedCount++;
    }

    return {
      format,
      booksTouched: touchedBooks.size,
      importedCount,
      deduplicatedCount,
      bookIds: [...touchedBooks],
    };
  });
}
