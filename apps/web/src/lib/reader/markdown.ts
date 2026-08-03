/**
 * Offset-faithful markdown subset parser (no rendering dependencies).
 *
 * Every node records the half-open UTF-16 interval of the source it covers,
 * and every *text-producing* node (`text`, inline/block code content) renders
 * the source slice verbatim: `source.slice(node.start, node.end)` is exactly
 * the text the DOM will contain. Markup delimiters (`#`, `**`, "- ", fences,
 * link parentheses, …) fall in the gaps between text nodes and never produce
 * DOM text, so a DOM Selection maps back to source offsets exactly.
 *
 * Supported subset (documented, deliberately small):
 * - ATX headings `#{1,6} title` (same shape as the Python chapter policy);
 * - paragraphs (consecutive plain lines; inline markup may span newlines);
 * - flat unordered (`-`/`*`/`+`) and ordered (`1.` / `1)`) lists, one line
 *   per item, no nesting;
 * - blockquotes (consecutive `>` lines; inline markup per line);
 * - fenced code blocks (``` only) rendered verbatim;
 * - inline code (matched backtick runs), `**strong**`, `*em*`, `_em_`,
 *   `__strong__`, `***strong em***`;
 * - links `[text](url)` rendered as plain text with the URL displayed via a
 *   data attribute (never a navigable element).
 * Backslash escapes and embedded HTML are NOT interpreted: they render as
 * literal text, which both preserves offsets and neutralizes markup.
 *
 * Offsets in this module are UTF-16 code unit indices; callers convert to the
 * codepoint offsets of the anchor contract through `MarkdownDocument.map`.
 */
import { OffsetMap } from "./offsets";

export interface TextSpan {
  kind: "text";
  start: number;
  end: number;
}

export interface InlineCode {
  kind: "inline_code";
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
}

export interface Emphasis {
  kind: "strong" | "em";
  start: number;
  end: number;
  children: InlineNode[];
}

export interface LinkSpan {
  kind: "link";
  start: number;
  end: number;
  url: string;
  children: InlineNode[];
}

export type InlineNode = TextSpan | InlineCode | Emphasis | LinkSpan;

export interface HeadingBlock {
  kind: "heading";
  level: number;
  start: number;
  end: number;
  children: InlineNode[];
}

export interface ParagraphBlock {
  kind: "paragraph";
  start: number;
  end: number;
  children: InlineNode[];
}

export interface ListItemNode {
  start: number;
  end: number;
  children: InlineNode[];
}

export interface ListBlock {
  kind: "list";
  ordered: boolean;
  start: number;
  end: number;
  items: ListItemNode[];
}

export interface QuoteLine {
  start: number;
  end: number;
  children: InlineNode[];
}

export interface QuoteBlock {
  kind: "quote";
  start: number;
  end: number;
  lines: QuoteLine[];
}

export interface CodeBlock {
  kind: "code_block";
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
  language: string;
}

export type BlockNode = HeadingBlock | ParagraphBlock | ListBlock | QuoteBlock | CodeBlock;

export interface MarkdownDocument {
  source: string;
  map: OffsetMap;
  blocks: BlockNode[];
}

interface Line {
  start: number;
  end: number;
  text: string;
}

const HEADING_PATTERN = /^(#{1,6})[ \t]+(.+?)[ \t]*$/u;
const UNORDERED_PATTERN = /^([-*+])[ \t]+(?=\S)/u;
const ORDERED_PATTERN = /^(\d{1,9})[.)][ \t]+(?=\S)/u;
const FENCE_OPEN_PATTERN = /^```([^`]*)$/u;
const FENCE_CLOSE_PATTERN = /^```[ \t]*$/u;
const URL_DISPLAY_MAX = 512;

function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start <= source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline === -1 ? source.length : newline;
    lines.push({ start, end, text: source.slice(start, end) });
    if (newline === -1) {
      break;
    }
    start = newline + 1;
  }
  // Drop a trailing empty pseudo-line produced by a final newline.
  const last = lines[lines.length - 1];
  if (lines.length > 1 && last !== undefined && last.text === "") {
    lines.pop();
  }
  return lines;
}

function isAlphanumeric(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
  );
}

function isWhitespaceCode(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a;
}

function runLength(source: string, index: number, end: number, character: string): number {
  let length = 0;
  while (index + length < end && source.charAt(index + length) === character) {
    length += 1;
  }
  return length;
}

/**
 * Find `count` consecutive `character`s at or after `from`, requiring a
 * non-space character immediately before the closer (CommonMark-ish) and a
 * non-empty inner span.
 */
function findEmphasisCloser(
  source: string,
  character: string,
  count: number,
  from: number,
  end: number,
): number {
  let index = from;
  while (index < end) {
    const found = source.indexOf(character.repeat(count), index);
    if (found === -1 || found + count > end) {
      return -1;
    }
    const before = source.charCodeAt(found - 1);
    const run = runLength(source, found, end, character);
    if (found > from && !isWhitespaceCode(before) && run === count) {
      return found;
    }
    index = found + Math.max(run, 1);
  }
  return -1;
}

function sanitizedUrl(raw: string): string {
  let url = raw.trim();
  const space = url.search(/[\s]/u);
  if (space !== -1) {
    url = url.slice(0, space);
  }
  // eslint-disable-next-line no-control-regex
  url = url.replace(/[\u0000-\u001f\u007f]/gu, "");
  if (url.length > URL_DISPLAY_MAX) {
    url = url.slice(0, URL_DISPLAY_MAX);
  }
  return url;
}

function parseInline(
  source: string,
  rangeStart: number,
  rangeEnd: number,
  allowLinks: boolean,
): InlineNode[] {
  const nodes: InlineNode[] = [];
  let textStart = rangeStart;
  let index = rangeStart;

  const flushText = (upTo: number): void => {
    if (upTo > textStart) {
      nodes.push({ kind: "text", start: textStart, end: upTo });
    }
  };

  while (index < rangeEnd) {
    const character = source.charAt(index);

    if (character === "`") {
      const run = runLength(source, index, rangeEnd, "`");
      const fence = "`".repeat(run);
      let closer = -1;
      let cursor = index + run;
      while (cursor < rangeEnd) {
        const found = source.indexOf(fence, cursor);
        if (found === -1 || found + run > rangeEnd) {
          break;
        }
        if (runLength(source, found, rangeEnd, "`") === run) {
          closer = found;
          break;
        }
        cursor = found + runLength(source, found, rangeEnd, "`");
      }
      if (closer > index + run) {
        flushText(index);
        nodes.push({
          kind: "inline_code",
          start: index,
          end: closer + run,
          contentStart: index + run,
          contentEnd: closer,
        });
        index = closer + run;
        textStart = index;
        continue;
      }
      index += run;
      continue;
    }

    if (character === "*" || character === "_") {
      const run = Math.min(runLength(source, index, rangeEnd, character), 3);
      const afterOpen = source.charCodeAt(index + run);
      const openerOk = index + run < rangeEnd && !isWhitespaceCode(afterOpen);
      const beforeOpen = source.charCodeAt(index - 1);
      const underscoreOpenOk =
        character !== "_" || index === 0 || !isAlphanumeric(beforeOpen);
      if (openerOk && underscoreOpenOk) {
        const emitted = ((): InlineNode | null => {
          if (run === 3) {
            const closer = findEmphasisCloser(source, character, 3, index + 3, rangeEnd);
            if (closer !== -1) {
              const inner: Emphasis = {
                kind: "em",
                start: index + 2,
                end: closer + 1,
                children: parseInline(source, index + 3, closer, allowLinks),
              };
              return { kind: "strong", start: index, end: closer + 3, children: [inner] };
            }
          }
          if (run >= 2) {
            const closer = findEmphasisCloser(source, character, 2, index + 2, rangeEnd);
            if (closer !== -1) {
              return {
                kind: "strong",
                start: index,
                end: closer + 2,
                children: parseInline(source, index + 2, closer, allowLinks),
              };
            }
          }
          if (run === 1) {
            const closer = findEmphasisCloser(source, character, 1, index + 1, rangeEnd);
            const underscoreCloseOk =
              closer === -1
              || character !== "_"
              || closer + 1 >= source.length
              || !isAlphanumeric(source.charCodeAt(closer + 1));
            if (closer !== -1 && underscoreCloseOk) {
              return {
                kind: "em",
                start: index,
                end: closer + 1,
                children: parseInline(source, index + 1, closer, allowLinks),
              };
            }
          }
          return null;
        })();
        if (emitted !== null) {
          flushText(index);
          nodes.push(emitted);
          index = emitted.end;
          textStart = index;
          continue;
        }
      }
      index += Math.max(run, 1);
      continue;
    }

    if (character === "[" && allowLinks) {
      let depth = 1;
      let cursor = index + 1;
      let closeBracket = -1;
      while (cursor < rangeEnd) {
        const candidate = source.charAt(cursor);
        if (candidate === "[") {
          depth += 1;
        } else if (candidate === "]") {
          depth -= 1;
          if (depth === 0) {
            closeBracket = cursor;
            break;
          }
        }
        cursor += 1;
      }
      if (closeBracket !== -1 && source.charAt(closeBracket + 1) === "(") {
        const closeParen = source.indexOf(")", closeBracket + 2);
        if (closeParen !== -1 && closeParen < rangeEnd) {
          flushText(index);
          nodes.push({
            kind: "link",
            start: index,
            end: closeParen + 1,
            url: sanitizedUrl(source.slice(closeBracket + 2, closeParen)),
            children: parseInline(source, index + 1, closeBracket, false),
          });
          index = closeParen + 1;
          textStart = index;
          continue;
        }
      }
      index += 1;
      continue;
    }

    index += 1;
  }

  flushText(rangeEnd);
  return nodes;
}

function headingBlock(source: string, line: Line): HeadingBlock | null {
  const match = HEADING_PATTERN.exec(line.text);
  if (match === null) {
    return null;
  }
  const hashes = match[1] as string;
  const title = match[2] as string;
  const contentStart = line.start + line.text.indexOf(title, hashes.length);
  return {
    kind: "heading",
    level: hashes.length,
    start: line.start,
    end: line.end,
    children: parseInline(source, contentStart, contentStart + title.length, true),
  };
}

export function parseMarkdown(source: string): MarkdownDocument {
  const lines = splitLines(source);
  const blocks: BlockNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] as Line;

    if (line.text === "") {
      index += 1;
      continue;
    }

    const fenceMatch = FENCE_OPEN_PATTERN.exec(line.text);
    if (fenceMatch !== null) {
      let closeIndex = -1;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        if (FENCE_CLOSE_PATTERN.test((lines[cursor] as Line).text)) {
          closeIndex = cursor;
          break;
        }
      }
      const language = (fenceMatch[1] as string).trim().slice(0, 32);
      if (closeIndex === -1) {
        const contentStart = Math.min(line.end + 1, source.length);
        const lastLine = lines[lines.length - 1] as Line;
        blocks.push({
          kind: "code_block",
          start: line.start,
          end: lastLine.end,
          contentStart,
          contentEnd: lastLine.end,
          language,
        });
        index = lines.length;
        continue;
      }
      const closeLine = lines[closeIndex] as Line;
      const contentStart = Math.min(line.end + 1, source.length);
      const contentEnd =
        closeIndex === index + 1 ? contentStart : Math.max(contentStart, closeLine.start - 1);
      blocks.push({
        kind: "code_block",
        start: line.start,
        end: closeLine.end,
        contentStart,
        contentEnd,
        language,
      });
      index = closeIndex + 1;
      continue;
    }

    const heading = headingBlock(source, line);
    if (heading !== null) {
      blocks.push(heading);
      index += 1;
      continue;
    }

    if (line.text.startsWith(">")) {
      const quoteLines: QuoteLine[] = [];
      const first = line;
      let last = line;
      while (index < lines.length && (lines[index] as Line).text.startsWith(">")) {
        const quoted = lines[index] as Line;
        last = quoted;
        let contentOffset = 1;
        if (quoted.text.charAt(1) === " ") {
          contentOffset = 2;
        }
        const contentStart = Math.min(quoted.start + contentOffset, quoted.end);
        quoteLines.push({
          start: contentStart,
          end: quoted.end,
          children: parseInline(source, contentStart, quoted.end, true),
        });
        index += 1;
      }
      blocks.push({ kind: "quote", start: first.start, end: last.end, lines: quoteLines });
      continue;
    }

    const unordered = UNORDERED_PATTERN.exec(line.text);
    const ordered = unordered === null ? ORDERED_PATTERN.exec(line.text) : null;
    if (unordered !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items: ListItemNode[] = [];
      const first = line;
      let last = line;
      while (index < lines.length) {
        const candidate = lines[index] as Line;
        const marker = isOrdered
          ? ORDERED_PATTERN.exec(candidate.text)
          : UNORDERED_PATTERN.exec(candidate.text);
        if (marker === null) {
          break;
        }
        last = candidate;
        const contentStart = candidate.start + marker[0].length;
        items.push({
          start: contentStart,
          end: candidate.end,
          children: parseInline(source, contentStart, candidate.end, true),
        });
        index += 1;
      }
      blocks.push({
        kind: "list",
        ordered: isOrdered,
        start: first.start,
        end: last.end,
        items,
      });
      continue;
    }

    // Paragraph: consume consecutive lines that do not open another block.
    const first = line;
    let last = line;
    index += 1;
    while (index < lines.length) {
      const candidate = lines[index] as Line;
      if (
        candidate.text === ""
        || FENCE_OPEN_PATTERN.test(candidate.text)
        || HEADING_PATTERN.test(candidate.text)
        || candidate.text.startsWith(">")
        || UNORDERED_PATTERN.test(candidate.text)
        || ORDERED_PATTERN.test(candidate.text)
      ) {
        break;
      }
      last = candidate;
      index += 1;
    }
    blocks.push({
      kind: "paragraph",
      start: first.start,
      end: last.end,
      children: parseInline(source, first.start, last.end, true),
    });
  }

  return { source, map: new OffsetMap(source), blocks };
}

/** Depth-first traversal of the text-producing leaves of an inline tree. */
export function collectTextLeaves(nodes: InlineNode[]): Array<{ start: number; end: number }> {
  const leaves: Array<{ start: number; end: number }> = [];
  for (const node of nodes) {
    if (node.kind === "text") {
      leaves.push({ start: node.start, end: node.end });
    } else if (node.kind === "inline_code") {
      leaves.push({ start: node.contentStart, end: node.contentEnd });
    } else {
      leaves.push(...collectTextLeaves(node.children));
    }
  }
  return leaves;
}

/** All text leaves of a block, used by round-trip tests and mark rendering. */
export function blockTextLeaves(block: BlockNode): Array<{ start: number; end: number }> {
  if (block.kind === "code_block") {
    return block.contentEnd > block.contentStart
      ? [{ start: block.contentStart, end: block.contentEnd }]
      : [];
  }
  if (block.kind === "list") {
    return block.items.flatMap((item) => collectTextLeaves(item.children));
  }
  if (block.kind === "quote") {
    return block.lines.flatMap((quoteLine) => collectTextLeaves(quoteLine.children));
  }
  return collectTextLeaves(block.children);
}
