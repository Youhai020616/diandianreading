function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatInlineHtml(text: string): string {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1");
}

/**
 * Convert a draft's title + Markdown body into clean semantic HTML + plain text
 * tailored for Xiaohongshu Creator Platform's "写长文 -> 一键排版" editor
 * (which maps h1/h2/blockquote/ol/ul/p/strong directly to native layout blocks).
 */
export function formatDraftForXiaohongshu(
  title: string,
  content: string,
): { html: string; plainText: string } {
  const cleanTitle = title.trim();
  const normalized = content.replace(/\r\n/g, "\n").trim();
  const lines = normalized ? normalized.split("\n") : [];

  const htmlParts: string[] = [];
  const plainParts: string[] = [];

  const firstNonEmpty = lines.find((l) => l.trim().length > 0) ?? "";
  const alreadyStartsWithH1 = /^#\s+/.test(firstNonEmpty.trim());
  if (cleanTitle && !alreadyStartsWithH1) {
    htmlParts.push(`<h1>${escapeHtml(cleanTitle)}</h1>`);
    plainParts.push(cleanTitle, "");
  }

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i] ?? "";
    const trimmed = rawLine.trim();
    if (!trimmed) {
      i++;
      continue;
    }

    // Headings (# -> h1, ##/### -> h2)
    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (headingMatch?.[1] && headingMatch[2]) {
      const level = headingMatch[1].length === 1 ? 1 : 2;
      const body = headingMatch[2].trim();
      htmlParts.push(`<h${level}>${formatInlineHtml(body)}</h${level}>`);
      plainParts.push(stripInlineMarkdown(body), "");
      i++;
      continue;
    }

    // Blockquote
    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i] ?? "").trim().startsWith(">")) {
        quoteLines.push((lines[i] ?? "").trim().replace(/^>\s?/, ""));
        i++;
      }
      const joined = quoteLines.filter(Boolean).join("\n");
      if (joined) {
        htmlParts.push(`<blockquote><p>${formatInlineHtml(joined).replace(/\n/g, "<br/>")}</p></blockquote>`);
        plainParts.push(`「${stripInlineMarkdown(joined)}」`, "");
      }
      continue;
    }

    // Ordered list
    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test((lines[i] ?? "").trim())) {
        items.push((lines[i] ?? "").trim().replace(/^\d+[.)]\s+/, ""));
        i++;
      }
      htmlParts.push(`<ol>${items.map((it) => `<li>${formatInlineHtml(it)}</li>`).join("")}</ol>`);
      items.forEach((it, idx) => plainParts.push(`${idx + 1}. ${stripInlineMarkdown(it)}`));
      plainParts.push("");
      continue;
    }

    // Unordered list
    if (/^[-*•]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*•]\s+/.test((lines[i] ?? "").trim())) {
        items.push((lines[i] ?? "").trim().replace(/^[-*•]\s+/, ""));
        i++;
      }
      htmlParts.push(`<ul>${items.map((it) => `<li>${formatInlineHtml(it)}</li>`).join("")}</ul>`);
      items.forEach((it) => plainParts.push(`• ${stripInlineMarkdown(it)}`));
      plainParts.push("");
      continue;
    }

    // Horizontal rule -> skip cleanly
    if (/^([-*_]){3,}$/.test(trimmed)) {
      i++;
      continue;
    }

    // Paragraph (consume contiguous plain text lines)
    const paraLines: string[] = [];
    while (i < lines.length) {
      const curr = (lines[i] ?? "").trim();
      if (
        !curr ||
        /^#{1,4}\s+/.test(curr) ||
        curr.startsWith(">") ||
        /^\d+[.)]\s+/.test(curr) ||
        /^[-*•]\s+/.test(curr) ||
        /^([-*_]){3,}$/.test(curr)
      ) {
        break;
      }
      paraLines.push(curr);
      i++;
    }
    if (paraLines.length === 0) {
      paraLines.push(trimmed);
      i++;
    }
    const merged = paraLines.join("\n");
    htmlParts.push(`<p>${formatInlineHtml(merged).replace(/\n/g, "<br/>")}</p>`);
    plainParts.push(stripInlineMarkdown(merged), "");
  }

  return {
    html: htmlParts.join("\n"),
    plainText: plainParts.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
  };
}

export async function copyDraftForXiaohongshu(title: string, content: string): Promise<void> {
  const { html, plainText } = formatDraftForXiaohongshu(title, content);
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      const item = new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plainText], { type: "text/plain" }),
      });
      await navigator.clipboard.write([item]);
      return;
    } catch {
      // Fall back to plain text clipboard below
    }
  }
  await navigator.clipboard.writeText(plainText);
}

export const XHS_LONG_ARTICLE_URL = "https://creator.xiaohongshu.com/publish/publish?from=menu&target=article";
