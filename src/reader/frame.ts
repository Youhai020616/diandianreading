import "foliate-js/view.js";
import { Overlayer } from "foliate-js/overlayer.js";
import { ChapterTranslations, translationStyles } from "./bilingual";
import { prepareInlineFonts, readerFontStyles } from "./fonts";
import { openPublication } from "./publication";
import { HIGHLIGHT_COLORS, readerTextureImage, type ReaderHighlightColor } from "./themes";
import { createWheelPager, type WheelTurn } from "./wheelPaging";
import type { EpubBook, FoliateView, MetadataText, TocItem } from "./foliate-types";
import type { ReaderAppearance, ReaderCommand, ReaderEvent, ReaderInfo, ReaderMark, SelectionAnchor } from "./types";

function metadataText(value?: MetadataText): string {
  return typeof value === "string" ? value : Object.values(value ?? {})[0] ?? "";
}

function tableOfContents(book: EpubBook): ReaderInfo["toc"] {
  const result: ReaderInfo["toc"] = [];
  function collect(items: TocItem[], depth: number) {
    for (const item of items) {
      if (item.href) result.push({ href: item.href, label: item.label, depth });
      if (item.subitems) collect(item.subitems, depth + 1);
    }
  }
  collect(book.toc ?? [], 0);
  return result.length ? result : book.sections.map((section, i) => ({ href: section.id, label: `第 ${i + 1} 节`, depth: 0 }));
}

function anchorPoint(doc: Document, rect: DOMRect): SelectionAnchor {
  const outer = doc.defaultView?.frameElement?.getBoundingClientRect();
  return {
    x: Math.min(innerWidth, Math.max(0, (outer?.left ?? 0) + rect.left + rect.width / 2)),
    y: Math.min(innerHeight, Math.max(0, (outer?.top ?? 0) + rect.top)),
    bottom: Math.min(innerHeight, Math.max(0, (outer?.top ?? 0) + rect.bottom)),
  };
}

function textAnchoredRange(doc: Document, selection: Range): Range {
  // Triple-clicks and select-all can place an endpoint on a paragraph element.
  // CFI text offsets preserve the complete selection across re-pagination.
  if (selection.startContainer.nodeType === Node.TEXT_NODE && selection.endContainer.nodeType === Node.TEXT_NODE) return selection;
  const range = selection.cloneRange();
  const walker = doc.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  let first: Node | null = null;
  let last: Node | null = null;
  while (walker.nextNode()) {
    const text = walker.currentNode;
    if (text.textContent?.length && range.intersectsNode(text)) {
      first ??= text;
      last = text;
    }
  }
  if (first && range.startContainer.nodeType !== Node.TEXT_NODE) range.setStart(first, 0);
  if (last && range.endContainer.nodeType !== Node.TEXT_NODE) range.setEnd(last, last.textContent!.length);
  return range;
}

function sameTextStart(a: Range, b: Range): boolean {
  const order = a.compareBoundaryPoints(Range.START_TO_START, b);
  if (order === 0) return true;
  // A drag can stop at an inline element boundary or include leading whitespace.
  const [earlier, later] = order < 0 ? [a, b] : [b, a];
  const gap = earlier.cloneRange();
  gap.setEnd(later.startContainer, later.startOffset);
  return !gap.toString().trim();
}

function looksLikeNote(link: Element, href: string) {
  if (!href.includes("#")) return false;
  const kind = `${link.getAttribute("epub:type") ?? ""} ${link.getAttribute("role") ?? ""}`;
  if (/backlink/i.test(kind)) return false;
  return /noteref/i.test(kind) || !!link.closest("sup") || !!link.querySelector("sup")
    || /^\s*[[【〔(（]?\d{1,3}[\]】〕)）]?\s*$/.test(link.textContent ?? "");
}

async function readFootnote(book: EpubBook, href: string) {
  const target = book.resolveHref(href);
  const section = target && book.sections[target.index];
  if (!target || !section) return "";
  const doc = await section.createDocument();
  const anchor = target.anchor(doc);
  if (!anchor || typeof anchor === "number") return "";
  const block = anchor.closest('aside,li,p,dd,div[role="doc-footnote"]')
    ?? (anchor.textContent?.trim() ? anchor : anchor.nextElementSibling);
  return block?.textContent?.trim().slice(0, 6000) ?? "";
}

function applyAppearance(view: FoliateView, appearance: ReaderAppearance) {
  const { columns, colors } = appearance;
  const size = Math.min(36, Math.max(13, appearance.fontSize));
  const height = Math.min(2.6, Math.max(1.2, appearance.lineHeight));
  const { dark, paper, ink, accent } = colors;
  const texture = readerTextureImage(appearance.texture, dark);
  // The grain sits on both the frame and each chapter page so it scrolls with the text.
  const background = texture ? `${paper} ${texture} repeat` : paper;
  document.body.style.background = background;
  const renderer = view.renderer;
  if (!renderer || renderer.localName === "foliate-fxl") return;
  renderer.setAttribute("max-column-count", String(columns));
  renderer.setAttribute("max-inline-size", columns === 2 ? "530px" : "740px");
  renderer.setAttribute("margin", "24px");
  renderer.setStyles?.(["@layer diandian-reader-font;", `
    @namespace epub "http://www.idpf.org/2007/ops";
    html { background: ${background} !important; color: ${ink} !important; font-size: ${size}px !important; color-scheme: ${dark ? "dark" : "light"}; }
    body { color: ${ink} !important; background: transparent !important; }
    body, p, li, dd, blockquote { line-height: ${height} !important; }
    ${readerFontStyles(appearance.fontFamily)}
    p, li, dd, blockquote { font-size: 1rem !important; overflow-wrap: break-word; }
    body :is(p,li,dd,div,span,h1,h2,h3,h4) { color: inherit !important; }
    body a:any-link, body a:any-link span { color: ${accent} !important; }
    ${translationStyles}
    aside[epub|type~="footnote"],aside[role="doc-footnote"] { display: none; }
  `]);
}

function connect(port: MessagePort) {
  const view = document.createElement("foliate-view") as FoliateView;
  document.body.append(view);
  let chapter = "";
  let ready = false;
  let appearance: ReaderAppearance;
  let marks = new Map<string, { shown: boolean; color: ReaderHighlightColor }>();
  type ResolveRange = (doc: Document) => Range;
  let sectionAnchors: Map<number, Map<string, ResolveRange>> | undefined;
  let documentRanges = new WeakMap<Document, Map<string, Range>>();
  let selectionFrame = 0;
  let lastClick: { doc: Document; anchor: SelectionAnchor; link: boolean } | null = null;

  const emit = (message: ReaderEvent) => port.postMessage(message);
  let translatedPageSource: Range | undefined;
  const translations = new ChapterTranslations(emit, () => {
    const anchor = translatedPageSource;
    view.renderer?.render?.();
    if (anchor?.startContainer.isConnected) void view.renderer?.scrollToAnchor?.(anchor);
  });
  const report = (error: unknown) => {
    const reason = error instanceof Error && /[\u3400-\u9fff]/u.test(error.message) ? error.message : "无法读取这本 EPUB。文件可能不完整，或采用了当前不支持的电子书格式。";
    emit({ type: "error", message: reason });
  };
  const setMark = (value: string, remove = false) => {
    // A stale position in a replaced edition should not interrupt reading.
    void view.addAnnotation({ value }, remove).catch(() => {});
  };
  function updateMarks(items: ReaderMark[]) {
    const next = new Map(items.map(({ locator, isHighlighted, color }) =>
      [locator, { shown: isHighlighted, color: color ?? "yellow" }] as const));
    if (ready) {
      for (const [value, mark] of marks) if (mark.shown && !next.get(value)?.shown) setMark(value, true);
      // Adding an annotation redraws it, which also applies a changed color.
      for (const [value, mark] of next) {
        const previous = marks.get(value);
        if (mark.shown && (!previous?.shown || previous.color !== mark.color)) setMark(value);
      }
    }
    marks = next;
    sectionAnchors = undefined;
    documentRanges = new WeakMap();
  }
  function anchorsForSection(index: number) {
    if (!sectionAnchors) {
      sectionAnchors = new Map();
      for (const value of marks.keys()) {
        try {
          const target = view.resolveCFI(value);
          const chapter = sectionAnchors.get(target.index) ?? new Map<string, ResolveRange>();
          chapter.set(value, target.anchor);
          sectionAnchors.set(target.index, chapter);
        } catch { /* An old locator can no longer resolve to a section. */ }
      }
    }
    return sectionAnchors.get(index);
  }
  function selectionLocator(index: number, doc: Document, range: Range, quote: string): string {
    const locator = view.getCFI(index, range);
    if (marks.has(locator) || !marks.size) return locator;
    let ranges = documentRanges.get(doc);
    if (!ranges) {
      ranges = new Map();
      // Resolve only this section's anchors against the live chapter document.
      for (const [value, anchor] of anchorsForSection(index) ?? []) {
        try {
          const marked = anchor(doc);
          if (marked && !marked.collapsed) ranges.set(value, marked);
        } catch { /* Ignore a locator that no longer exists in this chapter. */ }
      }
      documentRanges.set(doc, ranges);
    }
    for (const [value, marked] of ranges) {
      if (marked.toString().trim() === quote && sameTextStart(marked, range)) return value;
    }
    return locator;
  }
  const turnTo = (direction: WheelTurn) => {
    cancelAnimationFrame(selectionFrame);
    emit({ type: "selection", selection: null });
    const move = direction === "next" ? view.next() : direction === "prev" ? view.prev()
      : direction === "left" ? view.goLeft() : view.goRight();
    void move.catch(report);
  };
  const turn = (forward: boolean) => turnTo(forward ? "next" : "prev");
  // Chapter documents and the frame margins share one clock, so a swipe that crosses them stays one gesture.
  const pageByWheel = createWheelPager(direction => { if (ready) turnTo(direction); });
  const onWheel = (event: WheelEvent) => pageByWheel({
    deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode, ctrlKey: event.ctrlKey, time: performance.now(),
  });
  document.addEventListener("wheel", onWheel, { passive: true });
  function handleKey(event: KeyboardEvent) {
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.defaultPrevented) return;
    if (event.key === "Escape") {
      emit({ type: "escape" });
      return;
    }
    if (["ArrowLeft", "ArrowRight", "PageUp", "PageDown"].includes(event.key)) {
      event.preventDefault();
      turn(event.key === "ArrowRight" || event.key === "PageDown");
    }
  }
  document.addEventListener("keydown", handleKey);
  view.addEventListener("load", event => {
    const { doc, index } = (event as CustomEvent<{ doc: Document; index: number }>).detail;
    translatedPageSource = undefined;
    if (view.renderer.localName !== "foliate-fxl") {
      prepareInlineFonts(doc);
      translations.attach(doc);
    }
    function selectionDone() {
      cancelAnimationFrame(selectionFrame);
      selectionFrame = requestAnimationFrame(() => {
        const selected = doc.getSelection();
        const quote = selected?.toString().trim();
        if (!selected?.rangeCount || selected.isCollapsed || !quote) {
          emit({ type: "selection", selection: null });
          return;
        }
        const range = textAnchoredRange(doc, selected.getRangeAt(0));
        emit({ type: "selection", selection: {
          quote, chapter, locator: selectionLocator(index, doc, range, quote), ...anchorPoint(doc, range.getBoundingClientRect()),
        } });
      });
    }
    doc.addEventListener("pointerup", selectionDone);
    doc.addEventListener("keyup", event => { if (event.shiftKey) selectionDone(); });
    doc.addEventListener("keydown", handleKey);
    doc.addEventListener("wheel", onWheel, { passive: true });
    doc.addEventListener("auxclick", event => event.preventDefault());
    // The reader owns link navigation; never let HTML or SVG navigate the book frame.
    doc.addEventListener("click", event => {
      const link = (event.target as Element | null)?.closest?.("a,area");
      lastClick = { doc, anchor: anchorPoint(doc, new DOMRect(event.clientX, event.clientY, 0, 0)), link: !!link?.hasAttribute("href") };
      if (!link) return;
      event.preventDefault();
    }, true);
  });
  view.addEventListener("show-annotation", event => {
    const { value, range } = (event as CustomEvent<{ value: string; range: Range }>).detail;
    const doc = range.startContainer.ownerDocument;
    if (!doc || !marks.get(value)?.shown || doc.getSelection()?.isCollapsed === false) return;
    const click = lastClick?.doc === doc ? lastClick : null;
    if (click?.link) return;
    // The same click also fires pointerup. Its collapsed selection must not
    // dismiss the toolbar we just opened for this annotation.
    cancelAnimationFrame(selectionFrame);
    emit({ type: "selection", selection: {
      locator: value, quote: range.toString().trim(), chapter,
      ...(click?.anchor ?? anchorPoint(doc, range.getBoundingClientRect())),
    } });
  });
  view.addEventListener("external-link", event => event.preventDefault());
  view.addEventListener("link", event => {
    const { a, href } = (event as CustomEvent<{ a: Element; href: string }>).detail;
    if (!looksLikeNote(a, href)) return;
    event.preventDefault();
    const anchor = anchorPoint(a.ownerDocument, a.getBoundingClientRect());
    void readFootnote(view.book, href).then(text => {
      if (text) emit({ type: "footnote", text, anchor });
      else void view.goTo(href);
    }).catch(() => { void view.goTo(href); });
  });
  view.addEventListener("relocate", () => {
    const location = view.lastLocation;
    if (!location || !location.cfi) return;
    chapter = location.tocItem?.label || `第 ${(location.section?.current ?? 0) + 1} 节`;
    const fraction = Number.isFinite(location.fraction) ? Math.min(1, Math.max(0, location.fraction)) : 0;
    translatedPageSource = translations.sourceOnTranslationPage(location.range);
    const index = translatedPageSource && view.renderer.getContents().find(({ doc }) => doc === translatedPageSource?.startContainer.ownerDocument)?.index;
    const locator = index !== undefined && translatedPageSource ? view.getCFI(index, translatedPageSource) : location.cfi;
    const { page, pages } = view.renderer;
    // The paginator pads each chapter with a blank page at both ends.
    const sectionPage = typeof page === "number" && typeof pages === "number" && pages > 2
      ? { current: Math.min(pages - 2, Math.max(1, page)), total: pages - 2 } : undefined;
    emit({ type: "location", location: { locator, chapter, fraction, ...(sectionPage ? { sectionPage } : {}) } });
  });
  view.addEventListener("draw-annotation", event => {
    const { draw, annotation } = (event as CustomEvent<{
      draw: (fn: typeof Overlayer.highlight, options: { color: string }) => void; annotation: { value: string };
    }>).detail;
    draw(Overlayer.highlight, { color: HIGHLIGHT_COLORS[marks.get(annotation.value)?.color ?? "yellow"].hex });
  });
  view.addEventListener("create-overlay", event => {
    const { index } = (event as CustomEvent<{ index: number }>).detail;
    // The layer is attached after this event returns.
    queueMicrotask(() => {
      for (const value of anchorsForSection(index)?.keys() ?? []) if (marks.get(value)?.shown) setMark(value);
    });
  });

  port.onmessage = async (event: MessageEvent<ReaderCommand>) => {
    const command = event.data;
    try {
      switch (command.type) {
        case "open": {
          translations.setMode(command.translation ?? "off", command.translationRevision);
          appearance = command.appearance;
          updateMarks(command.highlights);
          const book = await openPublication(command.bytes);
          await view.open(book);
          applyAppearance(view, appearance);
          await view.init({ lastLocation: command.initialLocator, showTextStart: true });
          if (command.initialLocator && !view.renderer.getContents().some(content => content.doc?.body)) {
            await view.init({ showTextStart: true });
          }
          if (!view.renderer.getContents().some(content => content.doc?.body)) {
            throw new Error("这本 EPUB 的正文无法读取，请尝试系统阅读器。");
          }
          ready = true;
          const author = book.metadata.author;
          emit({ type: "ready", info: {
            title: metadataText(book.metadata.title),
            author: (Array.isArray(author) ? author : [author]).map(a => typeof a === "string" ? a : metadataText(a?.name)).filter(Boolean).join("、"),
            toc: tableOfContents(book),
            canTranslate: view.renderer.localName !== "foliate-fxl",
            layout: view.renderer.localName === "foliate-fxl" ? "fixed" : "reflowable",
          } });
          break;
        }
        case "translation": translations.setMode(command.mode, command.revision); break;
        case "translationResult": translations.accept(command.id, command.values); break;
        case "retryTranslation": translations.retry(); break;
        case "appearance": {
          appearance = command.value;
          const anchor = translatedPageSource;
          if (view.renderer) applyAppearance(view, appearance);
          if (anchor?.startContainer.isConnected) await view.renderer.scrollToAnchor?.(anchor);
          break;
        }
        case "highlights": updateMarks(command.values); break;
        case "clearSelection": cancelAnimationFrame(selectionFrame); if (ready) view.deselect(); break;
        case "goTo": if (ready) await view.goTo(command.locator); break;
        case "goToFraction":
          if (ready && Number.isFinite(command.fraction)) await view.goToFraction(Math.min(1, Math.max(0, command.fraction)));
          break;
        case "next": case "prev": if (ready) turn(command.type === "next"); break;
      }
    } catch (error) {
      report(error);
    }
  };
  window.addEventListener("pagehide", () => { translations.attach(undefined); view.close(); view.book?.destroy(); port.close(); }, { once: true });
}
window.addEventListener("message", function start(event) {
  if (event.source !== parent || event.data !== "diandian:init-epub" || !event.ports[0]) return;
  window.removeEventListener("message", start);
  connect(event.ports[0]);
});
