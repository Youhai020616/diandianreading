/**
 * DOM-level round-trip: render the offset-carrying markdown DOM, then map
 * Ranges back to source offsets. This is the correctness root for highlights.
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "../../components/reader/MarkdownContent";
import type { HighlightSpan } from "./highlights";
import { parseMarkdown } from "./markdown";
import { quoteForRange, rangeToSourceOffsets, SOURCE_OFFSET_ATTRIBUTE } from "./selection";

const SOURCE = [
  "# 标题一",
  "",
  "前缀文本 **加粗中心** 后缀文本。",
  "",
  "emoji 😀 段落，[链接](https://example.com) 结束。",
  "",
].join("\n");

interface Rendered {
  root: HTMLElement;
  doc: ReturnType<typeof parseMarkdown>;
}

function renderDoc(highlights: HighlightSpan[] = []): Rendered {
  const doc = parseMarkdown(SOURCE);
  const view = render(
    <div id="selection-root">
      <MarkdownContent
        doc={doc}
        highlights={highlights}
        activeAnnotationId={null}
        onMarkClick={() => undefined}
      />
    </div>,
  );
  return { root: view.container.querySelector("#selection-root") as HTMLElement, doc };
}

function textNodeBySource(root: HTMLElement, doc: Rendered["doc"], needle: string): {
  node: Text;
  offsetInNode: number;
} {
  const sourceIndex = doc.source.indexOf(needle);
  expect(sourceIndex).toBeGreaterThanOrEqual(0);
  const walker = root.querySelectorAll(`[${SOURCE_OFFSET_ATTRIBUTE}]`);
  for (const element of Array.from(walker)) {
    const su = Number.parseInt(element.getAttribute(SOURCE_OFFSET_ATTRIBUTE) ?? "", 10);
    const textNode = element.firstChild as Text | null;
    if (textNode === null || textNode.nodeType !== 3) {
      continue;
    }
    if (sourceIndex >= su && sourceIndex + needle.length <= su + textNode.length) {
      return { node: textNode, offsetInNode: sourceIndex - su };
    }
  }
  throw new Error(`No mapped text node contains: ${needle}`);
}

describe("rendered DOM carries exact source offsets", () => {
  it("every rendered text node equals the source slice at its data-su offset", () => {
    const { root, doc } = renderDoc();
    const mapped = root.querySelectorAll(`[${SOURCE_OFFSET_ATTRIBUTE}]`);
    expect(mapped.length).toBeGreaterThan(0);
    for (const element of Array.from(mapped)) {
      const su = Number.parseInt(element.getAttribute(SOURCE_OFFSET_ATTRIBUTE) ?? "", 10);
      const text = element.textContent ?? "";
      expect(doc.source.slice(su, su + text.length)).toBe(text);
    }
  });

  it("blocks expose codepoint data-start/data-end matching the anchor contract", () => {
    const { root, doc } = renderDoc();
    const blocks = root.querySelectorAll(".md-block");
    expect(blocks.length).toBe(doc.blocks.length);
    const paragraph = Array.from(blocks).find((element) =>
      (element.textContent ?? "").includes("emoji"),
    ) as HTMLElement;
    const startCp = Number.parseInt(paragraph.getAttribute("data-start") ?? "", 10);
    const endCp = Number.parseInt(paragraph.getAttribute("data-end") ?? "", 10);
    // Codepoint slicing (Python semantics) must reproduce the paragraph source.
    const byCodepoints = Array.from(doc.source).slice(startCp, endCp).join("");
    expect(byCodepoints.startsWith("emoji 😀 段落")).toBe(true);
  });

  it("link URLs are attribute data, not selectable text", () => {
    const { root } = renderDoc();
    const link = root.querySelector(".md-link") as HTMLElement;
    expect(link.getAttribute("data-url")).toBe("https://example.com");
    expect(link.textContent).toBe("链接");
    expect(root.querySelector("a")).toBeNull();
  });
});

describe("rangeToSourceOffsets", () => {
  it("maps a range inside a single text node", () => {
    const { root, doc } = renderDoc();
    const { node, offsetInNode } = textNodeBySource(root, doc, "前缀文本");
    const range = document.createRange();
    range.setStart(node, offsetInNode);
    range.setEnd(node, offsetInNode + 4);
    const mapped = rangeToSourceOffsets(range, root);
    expect(mapped).not.toBeNull();
    expect(doc.source.slice(mapped!.startU16, mapped!.endU16)).toBe("前缀文本");
  });

  it("maps a range spanning plain and emphasized nodes, including the delimiters", () => {
    const { root, doc } = renderDoc();
    const prefix = textNodeBySource(root, doc, "前缀文本 ");
    const bold = textNodeBySource(root, doc, "加粗中心");
    const range = document.createRange();
    range.setStart(prefix.node, prefix.offsetInNode);
    range.setEnd(bold.node, bold.offsetInNode + "加粗中心".length);
    const mapped = rangeToSourceOffsets(range, root);
    expect(mapped).not.toBeNull();
    // The source interval crosses the ** delimiters even though the DOM
    // selection never contained them.
    expect(doc.source.slice(mapped!.startU16, mapped!.endU16)).toBe("前缀文本 **加粗中心");
  });

  it("converts to codepoint quotes correctly across supplementary characters", () => {
    const { root, doc } = renderDoc();
    const target = textNodeBySource(root, doc, "段落");
    const range = document.createRange();
    range.setStart(target.node, target.offsetInNode);
    range.setEnd(target.node, target.offsetInNode + 2);
    const mapped = rangeToSourceOffsets(range, root)!;
    const quote = quoteForRange(doc, mapped.startU16, mapped.endU16);
    expect(quote.exact).toBe("段落");
    // Prefix contains the emoji as a single codepoint of context.
    expect(quote.prefix.endsWith("emoji 😀 ")).toBe(true);
    expect(quote.prefix.length).toBeLessThanOrEqual(65 * 2);
    expect(Array.from(quote.prefix).length).toBeLessThanOrEqual(64);
    expect(Array.from(quote.suffix).length).toBeLessThanOrEqual(64);
  });

  it("returns null for collapsed or unmapped ranges", () => {
    const { root } = renderDoc();
    const outside = document.createElement("p");
    outside.textContent = "toolbar text";
    document.body.appendChild(outside);
    const collapsed = document.createRange();
    collapsed.setStart(root, 0);
    collapsed.setEnd(root, 0);
    expect(rangeToSourceOffsets(collapsed, root)).toBeNull();
    const foreign = document.createRange();
    foreign.setStart(outside.firstChild as Text, 0);
    foreign.setEnd(outside.firstChild as Text, 3);
    expect(rangeToSourceOffsets(foreign, root)).toBeNull();
    outside.remove();
  });

  it("snaps element-container points to the nearest mapped text", () => {
    const { root, doc } = renderDoc();
    const paragraph = Array.from(root.querySelectorAll(".md-paragraph")).find((element) =>
      (element.textContent ?? "").includes("加粗中心"),
    ) as HTMLElement;
    const range = document.createRange();
    range.setStart(paragraph, 0);
    range.setEnd(paragraph, paragraph.childNodes.length);
    const mapped = rangeToSourceOffsets(range, root);
    expect(mapped).not.toBeNull();
    const text = doc.source.slice(mapped!.startU16, mapped!.endU16);
    expect(text.startsWith("前缀文本")).toBe(true);
    expect(text.endsWith("后缀文本。")).toBe(true);
  });

  it("still maps exactly when highlights split the text into marks", () => {
    const doc = parseMarkdown(SOURCE);
    const boldCenter = doc.source.indexOf("加粗中心");
    const highlight: HighlightSpan = {
      id: "hl-1",
      startU16: boldCenter + 1,
      endU16: boldCenter + 3,
      color: "green",
      createdAtMs: 1,
    };
    const view = render(
      <div id="selection-root-marks">
        <MarkdownContent
          doc={doc}
          highlights={[highlight]}
          activeAnnotationId={null}
          onMarkClick={() => undefined}
        />
      </div>,
    );
    const root = view.container.querySelector("#selection-root-marks") as HTMLElement;
    const mark = root.querySelector("mark.reader-mark") as HTMLElement;
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe(doc.source.slice(boldCenter + 1, boldCenter + 3));
    const markText = mark.firstChild as Text;
    const range = document.createRange();
    range.setStart(markText, 0);
    range.setEnd(markText, markText.length);
    const mapped = rangeToSourceOffsets(range, root);
    expect(mapped).toEqual({ startU16: boldCenter + 1, endU16: boldCenter + 3 });
  });
});
