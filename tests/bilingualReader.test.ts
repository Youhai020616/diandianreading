import { afterEach, expect, it, vi } from "vitest";
import { ChapterTranslations, pendingTranslationAttribute, translationAttribute, translationChunks, translationTarget } from "../src/reader/bilingual";
import type { ReaderEvent } from "../src/reader/types";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("chooses the target per paragraph and leaves matching languages and page numbers alone", () => {
  expect(translationTarget("小教堂", "auto")).toBe("en");
  expect(translationTarget("Small chapel", "auto")).toBe("zh");
  expect(translationTarget("这是一段中文。", "zh")).toBeNull();
  expect(translationTarget("English", "en")).toBeNull();
  expect(translationTarget("121", "auto")).toBeNull();
  expect(translationTarget("小さな教会", "auto")).toBeNull();
  expect(translationTarget("小教堂", "off")).toBeNull();
});

it("splits a long paragraph within the provider budget and preserves complete Unicode characters", () => {
  const source = "书".repeat(1599) + "😀" + "夏日。".repeat(1800);
  const chunks = translationChunks(source);
  expect(chunks.join("")).toBe(source);
  expect(chunks.every(text => text.length <= 1600 && !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(text))).toBe(true);
});

function setupChapter(texts: string[]) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let observer: IntersectionObserverCallback;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { observer = callback; }
    observe() {}
    disconnect() {}
  });
  let queued: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { queued = callback; return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => { queued = undefined; });
  function flush() { const cb = queued; queued = undefined; cb?.(0); }

  function paragraph(text: string) {
    const attrs = new Map<string, string>();
    return {
      innerText: text,
      closest: () => null,
      querySelector: () => null,
      setAttribute: attrs.set.bind(attrs),
      hasAttribute: attrs.has.bind(attrs),
      removeAttribute: attrs.delete.bind(attrs),
      attrs,
    };
  }
  const blocks = texts.map(paragraph);
  const doc = { body: { querySelectorAll: () => blocks } } as unknown as Document;
  const sent: ReaderEvent[] = [];
  const controller = new ChapterTranslations(e => sent.push(e), () => {});
  function visibility(first: number, end: number, isIntersecting = true) {
    observer(blocks.slice(first, end).map(target => ({
      target, isIntersecting, intersectionRect: { width: 200, height: 20 },
    })) as unknown as IntersectionObserverEntry[], {} as IntersectionObserver);
    flush();
  }
  controller.attach(doc);
  controller.setMode("auto");
  return { controller, blocks, sent, visibility, flush };
}

it("shows pending only for slow visible passages and clears it on partial failure, retry and provider changes", () => {
  const { controller, blocks, sent, visibility, flush } = setupChapter(["第一段", "第二段", "不在本页"]);
  const pending = () => blocks.map(block => block.hasAttribute(pendingTranslationAttribute));
  visibility(0, 2);
  expect(sent.at(-1)).toMatchObject({ type: "translate", id: 1, texts: ["第一段", "第二段"], target: "en" });
  expect(pending()).toEqual([false, false, false]);
  vi.advanceTimersByTime(300);
  expect(pending()).toEqual([true, true, false]);
  controller.accept(1, ["First paragraph", ""]);
  flush();
  expect(blocks[0]!.attrs.get(translationAttribute)).toBe("First paragraph");
  expect(pending()).toEqual([false, false, false]);
  expect(sent).toHaveLength(1);
  controller.retry();
  flush();
  expect(sent.at(-1)).toMatchObject({ type: "translate", id: 2, texts: ["第二段"] });
  vi.advanceTimersByTime(300);
  expect(pending()).toEqual([false, true, false]);

  controller.setMode("auto", 1);
  expect(sent.at(-1)).toEqual({ type: "cancelTranslation", id: 2 });
  controller.accept(2, ["stale"]);
  expect(blocks.every(el => !el.attrs.size)).toBe(true);
  visibility(1, 2);
  expect(sent.at(-1)).toMatchObject({ type: "translate", id: 3, revision: 1, texts: ["第二段"] });
  controller.setMode("off", 1);
  controller.accept(3, ["stale"]);
  vi.advanceTimersByTime(300);
  flush();
  expect(blocks.every(el => !el.attrs.size)).toBe(true);
  expect(sent.at(-1)).toEqual({ type: "cancelTranslation", id: 3 });
});

it("skips the indicator for fast results and removes it when a page or chapter is left", () => {
  const { controller, blocks, sent, visibility, flush } = setupChapter(["已缓存", "未缓存"]);
  visibility(0, 1);
  controller.accept(1, ["Cached"]);
  flush();
  vi.advanceTimersByTime(300);
  expect(blocks[0]!.attrs).toEqual(new Map([[translationAttribute, "Cached"]]));

  visibility(1, 2);
  vi.advanceTimersByTime(300);
  expect(blocks[1]!.hasAttribute(pendingTranslationAttribute)).toBe(true);
  visibility(1, 2, false);
  expect(sent.at(-1)).toEqual({ type: "cancelTranslation", id: 2 });
  controller.accept(2, ["late"]);
  expect(blocks[1]!.attrs.size).toBe(0);

  visibility(1, 2);
  vi.advanceTimersByTime(300);
  expect(blocks[1]!.hasAttribute(pendingTranslationAttribute)).toBe(true);
  controller.attach(undefined);
  controller.accept(3, ["from previous chapter"]);
  expect(blocks.every(block => block.attrs.size === 0)).toBe(true);
});

it("keeps the indicator for a long paragraph until the last batch completes", () => {
  const { controller, blocks, sent, visibility, flush } = setupChapter(["书".repeat(6200)]);
  visibility(0, 1);
  vi.advanceTimersByTime(300);
  controller.accept(1, ["Part one", "part two", "part three"]);
  flush();
  expect(sent.at(-1)).toMatchObject({ type: "translate", id: 2 });
  expect(blocks[0]!.hasAttribute(pendingTranslationAttribute)).toBe(true);
  expect(blocks[0]!.hasAttribute(translationAttribute)).toBe(false);
  controller.accept(2, ["part four"]);
  expect(blocks[0]!.attrs).toEqual(new Map([[translationAttribute, "Part one part two part three part four"]]));
});
