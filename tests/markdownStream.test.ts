import { describe, expect, it } from "vitest";
import { parseMarkdownBlocks } from "../src/components/MarkdownText";

describe("Streaming-safe Markdown block parser", () => {
  it("never infinite-loops on partial streaming prefixes or hashtags", () => {
    const sample = [
      "一句话判断",
      "",
      "### 核心观点",
      "它没有提出新理论，重点在于 **元认知** 与 `强反馈`。",
      "",
      "##### 五级小节",
      "#小红书读书笔记 #认知觉醒",
      "##",
      "#",
      "> 一段引用",
      ">",
      "---",
      "- 要点一",
      "- ",
      "1. 第一步",
      "2. ",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");

    // Simulate token-by-token streaming: parse EVERY single character prefix!
    for (let len = 1; len <= sample.length; len++) {
      const blocks = parseMarkdownBlocks(sample.slice(0, len));
      expect(Array.isArray(blocks)).toBe(true);
      expect(blocks.length).toBeLessThanOrEqual(30);
    }
  });

  it("parses headings, lists, blockquotes, code fences, and hashtags accurately", () => {
    const blocks = parseMarkdownBlocks(
      "# 主标题\n\n### 三级标题\n正文第一行\n正文第二行\n#标签不触发死循环\n\n- 列表 A\n- 列表 B\n\n> 引用一句",
    );
    expect(blocks.map((b) => b.type)).toEqual([
      "heading",
      "heading",
      "paragraph",
      "ul",
      "blockquote",
    ]);
    expect(blocks[0]).toEqual({ type: "heading", level: 1, text: "主标题" });
    expect(blocks[1]).toEqual({ type: "heading", level: 3, text: "三级标题" });
  });
});
