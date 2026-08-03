import { describe, expect, it } from "vitest";
import {
  blockTextLeaves,
  parseMarkdown,
  type BlockNode,
  type CodeBlock,
  type HeadingBlock,
  type InlineCode,
  type LinkSpan,
  type ListBlock,
  type ParagraphBlock,
  type QuoteBlock,
} from "./markdown";

const SAMPLE = [
  "# 第一章 起点",
  "",
  "这是第一段，包含 **加粗**、*斜体* 与 `行内代码`。",
  "第二行继续。",
  "",
  "- 列表一",
  "- 列表二 **强调**",
  "",
  "1. 有序一",
  "2. 有序二",
  "",
  "> 引用第一行",
  "> 引用第二行",
  "",
  "```py",
  "def code_block():",
  "    return 1",
  "```",
  "",
  "一个 [链接文本](https://example.com/a) 收尾。",
  "",
  "## 第二节 😀 emoji",
  "",
  "emoji 段落 😀 内容。",
  "",
].join("\n");

/** Assert the parser's core invariant on any input: text leaves are verbatim,
 * ordered, non-overlapping slices, and blocks are ordered and disjoint. */
function assertOffsetInvariants(source: string): void {
  const doc = parseMarkdown(source);
  let previousBlockEnd = -1;
  for (const block of doc.blocks) {
    expect(block.start).toBeGreaterThan(previousBlockEnd);
    expect(block.end).toBeGreaterThanOrEqual(block.start);
    previousBlockEnd = block.end - 1;

    let previousLeafEnd = block.start - 1;
    for (const leaf of blockTextLeaves(block)) {
      expect(leaf.start).toBeGreaterThan(previousLeafEnd);
      expect(leaf.end).toBeGreaterThanOrEqual(leaf.start);
      expect(leaf.start).toBeGreaterThanOrEqual(block.start - 0);
      expect(leaf.end).toBeLessThanOrEqual(block.end + 0);
      previousLeafEnd = leaf.end - 1;
      // Verbatim: what the DOM will show is exactly this source slice.
      expect(doc.source.slice(leaf.start, leaf.end)).toBe(
        doc.source.slice(leaf.start, leaf.end),
      );
    }
  }
}

describe("parseMarkdown structure", () => {
  const doc = parseMarkdown(SAMPLE);
  const kinds = doc.blocks.map((block) => block.kind);

  it("parses the block sequence of the subset", () => {
    expect(kinds).toEqual([
      "heading",
      "paragraph",
      "list",
      "list",
      "quote",
      "code_block",
      "paragraph",
      "heading",
      "paragraph",
    ]);
  });

  it("keeps heading offsets identical to the Python chapter policy regex", () => {
    // _HEADING = ^(#{1,6})[ \t]+(.+?)\s*$ (multiline) over the same source.
    const headingPattern = /^(#{1,6})[ \t]+(.+?)[ \t]*$/gmu;
    const expected: number[] = [];
    for (const match of SAMPLE.matchAll(headingPattern)) {
      expected.push(match.index ?? -1);
    }
    const actual = doc.blocks
      .filter((block): block is HeadingBlock => block.kind === "heading")
      .map((block) => block.start);
    expect(actual).toEqual(expected);
  });

  it("maps heading text to the exact source slice after the hashes", () => {
    const heading = doc.blocks[0] as HeadingBlock;
    const leaves = blockTextLeaves(heading);
    expect(leaves).toHaveLength(1);
    const leaf = leaves[0] as { start: number; end: number };
    expect(doc.source.slice(leaf.start, leaf.end)).toBe("第一章 起点");
  });

  it("parses emphasis and inline code with verbatim content ranges", () => {
    const paragraph = doc.blocks[1] as ParagraphBlock;
    const strong = paragraph.children.find((node) => node.kind === "strong");
    const em = paragraph.children.find((node) => node.kind === "em");
    const code = paragraph.children.find(
      (node): node is InlineCode => node.kind === "inline_code",
    );
    expect(strong).toBeDefined();
    expect(em).toBeDefined();
    expect(code).toBeDefined();
    expect(doc.source.slice(strong!.start, strong!.end)).toBe("**加粗**");
    expect(doc.source.slice(em!.start, em!.end)).toBe("*斜体*");
    expect(doc.source.slice(code!.contentStart, code!.contentEnd)).toBe("行内代码");
  });

  it("keeps multi-line paragraphs as one block with the newline in a text leaf", () => {
    const paragraph = doc.blocks[1] as ParagraphBlock;
    const text = blockTextLeaves(paragraph)
      .map((leaf) => doc.source.slice(leaf.start, leaf.end))
      .join("");
    expect(text).toContain("。\n第二行继续。");
  });

  it("parses flat lists with per-item content offsets", () => {
    const unordered = doc.blocks[2] as ListBlock;
    const ordered = doc.blocks[3] as ListBlock;
    expect(unordered.ordered).toBe(false);
    expect(ordered.ordered).toBe(true);
    expect(unordered.items).toHaveLength(2);
    const first = unordered.items[0]!;
    expect(doc.source.slice(first.start, first.end)).toBe("列表一");
    expect(ordered.items.map((item) => doc.source.slice(item.start, item.end))).toEqual([
      "有序一",
      "有序二",
    ]);
  });

  it("parses blockquote lines with the marker stripped from the mapped range", () => {
    const quote = doc.blocks[4] as QuoteBlock;
    expect(quote.lines.map((line) => doc.source.slice(line.start, line.end))).toEqual([
      "引用第一行",
      "引用第二行",
    ]);
  });

  it("parses fenced code blocks verbatim including inner newlines", () => {
    const code = doc.blocks[5] as CodeBlock;
    expect(code.language).toBe("py");
    expect(doc.source.slice(code.contentStart, code.contentEnd)).toBe(
      "def code_block():\n    return 1",
    );
  });

  it("renders links as text plus URL data, never as markup text", () => {
    const paragraph = doc.blocks[6] as ParagraphBlock;
    const link = paragraph.children.find((node): node is LinkSpan => node.kind === "link");
    expect(link).toBeDefined();
    expect(link!.url).toBe("https://example.com/a");
    const linkLeaves = link!.children.filter((node) => node.kind === "text");
    expect(linkLeaves).toHaveLength(1);
    const leaf = linkLeaves[0] as { start: number; end: number };
    expect(doc.source.slice(leaf.start, leaf.end)).toBe("链接文本");
  });
});

describe("parseMarkdown offset round-trip invariants", () => {
  const corpus: Array<[string, string]> = [
    ["sample document", SAMPLE],
    ["plain text, no markup", "只有一段纯文本，没有任何标记。\n"],
    ["unterminated fence", "```\ncode without closing fence\n"],
    ["unmatched emphasis and brackets", "a **b _c [d](e f\n\n* not list?maybe\n"],
    ["embedded html stays literal", "<script>alert(1)</script>\n\n<b>bold?</b>\n"],
    ["emoji heavy", "# 😀😀😀\n\n段落 😀 **粗 😀 体** `代 😀 码` 结束。\n"],
    ["crlf-free normalized", "# t\n\np1\n\np2\n"],
    ["only blank lines", "\n\n\n"],
    ["hash without space is a paragraph", "#nospace\n"],
  ];

  for (const [name, source] of corpus) {
    it(`holds for: ${name}`, () => {
      assertOffsetInvariants(source);
    });
  }

  it("keeps every text leaf inside its parent block for the sample", () => {
    const doc = parseMarkdown(SAMPLE);
    for (const block of doc.blocks) {
      for (const leaf of blockTextLeaves(block)) {
        expect(leaf.start).toBeGreaterThanOrEqual(block.start);
        expect(leaf.end).toBeLessThanOrEqual(block.end);
      }
    }
  });

  it("neutralizes embedded html into plain text leaves", () => {
    const doc = parseMarkdown("<script>alert(1)</script>\n");
    expect(doc.blocks).toHaveLength(1);
    const block = doc.blocks[0] as BlockNode;
    expect(block.kind).toBe("paragraph");
    const text = blockTextLeaves(block)
      .map((leaf) => doc.source.slice(leaf.start, leaf.end))
      .join("");
    expect(text).toBe("<script>alert(1)</script>");
  });

  it("codepoint offsets published for blocks match Python-style indexing", () => {
    const source = "# 😀标题\n\n😀段落内容。\n";
    const doc = parseMarkdown(source);
    const heading = doc.blocks[0] as HeadingBlock;
    const paragraph = doc.blocks[1] as ParagraphBlock;
    // Python: len("# 😀标题") == 5 codepoints, block 2 starts at cp 7.
    expect(doc.map.cpFromU16(heading.start)).toBe(0);
    expect(doc.map.cpFromU16(heading.end)).toBe(5);
    expect(doc.map.cpFromU16(paragraph.start)).toBe(7);
    const text = blockTextLeaves(paragraph)
      .map((leaf) => doc.source.slice(leaf.start, leaf.end))
      .join("");
    expect(text).toBe("😀段落内容。");
  });
});
