import React from "react";

export type MarkdownBlock =
  | { type: "code"; lang?: string; text: string }
  | { type: "hr" }
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "blockquote"; lines: string[] }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "paragraph"; text: string };

const HR_RE = /^(-{3,}|\*{3,}|_{3,})$/;
const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const UL_RE = /^[-*•]\s+/;
const OL_RE = /^\d+\.\s+/;

function startsNewBlock(trimmed: string): boolean {
  return (
    !trimmed
    || trimmed.startsWith("```")
    || HR_RE.test(trimmed)
    || HEADING_RE.test(trimmed)
    || trimmed.startsWith(">")
    || UL_RE.test(trimmed)
    || OL_RE.test(trimmed)
  );
}

/**
 * Linear-time, streaming-safe Markdown block parser.
 * Strictly guarantees line index advances on every outer iteration so incomplete
 * streaming prefixes (e.g. "#", "##", "###", "#tag", unclosed "```", ">") can
 * never trigger an infinite loop.
 */
export function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const startIdx = i;
    const trimmed = (lines[i] ?? "").trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // Fenced code block
    if (trimmed.startsWith("```")) {
      const lang = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) {
        codeLines.push(lines[i] ?? "");
        i++;
      }
      if (i < lines.length) i++;
      blocks.push({
        type: "code",
        ...(lang ? { lang } : {}),
        text: codeLines.join("\n"),
      });
      continue;
    }

    // Horizontal rule
    if (HR_RE.test(trimmed)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // Headings (# .. ###### with trailing space + text)
    const headingMatch = HEADING_RE.exec(trimmed);
    if (headingMatch && headingMatch[1] && headingMatch[2]) {
      const rawLevel = headingMatch[1].length;
      const level: 1 | 2 | 3 = rawLevel === 1 ? 1 : rawLevel === 2 ? 2 : 3;
      blocks.push({ type: "heading", level, text: headingMatch[2] });
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
      blocks.push({ type: "blockquote", lines: quoteLines });
      continue;
    }

    // Unordered list
    if (UL_RE.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && UL_RE.test((lines[i] ?? "").trim())) {
        items.push((lines[i] ?? "").trim().replace(UL_RE, ""));
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    // Ordered list
    if (OL_RE.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && OL_RE.test((lines[i] ?? "").trim())) {
        items.push((lines[i] ?? "").trim().replace(OL_RE, ""));
        i++;
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    // Paragraph: unconditionally consume the current line first, then absorb
    // contiguous plain lines until the next blank line or explicit block starter.
    const paraLines: string[] = [trimmed];
    i++;
    while (i < lines.length) {
      const nextTrimmed = (lines[i] ?? "").trim();
      if (startsNewBlock(nextTrimmed)) break;
      paraLines.push(nextTrimmed);
      i++;
    }
    blocks.push({ type: "paragraph", text: paraLines.join("\n") });

    // Defensive invariant guard against future edits.
    if (i <= startIdx) {
      i = startIdx + 1;
    }
  }

  return blocks;
}

/**
 * Pure-React Markdown renderer (zero dangerouslySetInnerHTML).
 * Supports headings, paragraphs, blockquotes, bullet/numbered lists,
 * fenced code blocks, horizontal rules, inline code, bold, and italics.
 */
function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const tokenRe = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = tokenRe.exec(text)) !== null) {
    const token = match[0];
    if (!token) {
      tokenRe.lastIndex++;
      continue;
    }
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <code key={key++} className="md-inline-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*") && token.endsWith("*")) {
      nodes.push(<em key={key++}>{token.slice(1, -1)}</em>);
    } else {
      nodes.push(token);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

export const MarkdownText: React.FC<{ content: string; className?: string }> = React.memo(
  ({ content, className }) => {
    const parsed = parseMarkdownBlocks(content);

    return (
      <div className={`md-root ${className ?? ""}`.trim()}>
        {parsed.map((block, idx) => {
          if (block.type === "code") {
            return (
              <pre key={idx} className="md-code-block" data-lang={block.lang || undefined}>
                <code>{block.text}</code>
              </pre>
            );
          }
          if (block.type === "hr") {
            return <hr key={idx} className="md-hr" />;
          }
          if (block.type === "heading") {
            const body = renderInline(block.text);
            if (block.level === 1) return <h2 key={idx} className="md-h1">{body}</h2>;
            if (block.level === 2) return <h3 key={idx} className="md-h2">{body}</h3>;
            return <h4 key={idx} className="md-h3">{body}</h4>;
          }
          if (block.type === "blockquote") {
            return (
              <blockquote key={idx} className="md-quote">
                {block.lines.map((ql, qIdx) => (
                  <p key={qIdx}>{renderInline(ql)}</p>
                ))}
              </blockquote>
            );
          }
          if (block.type === "ul") {
            return (
              <ul key={idx} className="md-list">
                {block.items.map((item, iIdx) => (
                  <li key={iIdx}>{renderInline(item)}</li>
                ))}
              </ul>
            );
          }
          if (block.type === "ol") {
            return (
              <ol key={idx} className="md-list md-ol">
                {block.items.map((item, iIdx) => (
                  <li key={iIdx}>{renderInline(item)}</li>
                ))}
              </ol>
            );
          }
          return (
            <p key={idx} className="md-p">
              {renderInline(block.text)}
            </p>
          );
        })}
      </div>
    );
  },
);
