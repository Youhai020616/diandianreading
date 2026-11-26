import type { ReaderEvent, ReaderTranslationMode, ReaderTranslationTarget } from "./types";

export function translationTarget(text: string, mode: ReaderTranslationMode): ReaderTranslationTarget | null {
  if (mode === "off" || !text.trim()) return null;
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  if (!han && !latin) return null;
  if (mode === "auto" && /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)) return null;
  const source = han * 3 >= latin ? "zh" : "en";
  if (mode === "auto") return source === "zh" ? "en" : "zh";
  return mode === source ? null : mode;
}

const CHUNK_SIZE = 1600;
const BATCH_CHARS = 6000;
const BATCH_SIZE = 8;

// Split a long paragraph at natural boundaries when possible. The source DOM
// stays intact even when its translation needs multiple provider calls.
export function translationChunks(text: string): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > CHUNK_SIZE) {
    const prefix = rest.slice(0, CHUNK_SIZE);
    const boundary = Math.max(prefix.search(/[。！？.!?][^。！？.!?]*$/u) + 1, prefix.search(/\s\S*$/u));
    let end = boundary >= CHUNK_SIZE / 2 ? boundary : CHUNK_SIZE;
    if (/[\uD800-\uDBFF]/u.test(rest[end - 1]!)) end--;
    chunks.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

const BLOCKS = "p,h1,h2,h3,h4,h5,h6,li,dd,dt,blockquote,div,section,article,figcaption";
const IGNORE = 'nav,aside[role="doc-footnote"],[hidden],[aria-hidden="true"],pre,code,svg,math';
export const translationAttribute = "data-diandian-bilingual-text";
export const pendingTranslationAttribute = "data-diandian-bilingual-pending";
const WAIT_INDICATOR_DELAY = 250;

export const translationStyles = `
  [${translationAttribute}]::after, [${pendingTranslationAttribute}]::after {
    display: block !important;
    position: static !important;
    margin-block: .38em .65em !important;
    color: inherit !important;
    opacity: .83;
    text-indent: 0;
    letter-spacing: normal;
    line-height: inherit;
    white-space: pre-line;
    overflow-wrap: anywhere;
    user-select: none;
  }
  [${translationAttribute}]::after { content: attr(${translationAttribute}) !important; }
  [${pendingTranslationAttribute}]::after {
    content: "正在翻译…" !important;
    font: normal .78rem/1.6 system-ui, sans-serif !important;
    opacity: .72;
  }
  @media (prefers-reduced-motion: no-preference) {
    [${pendingTranslationAttribute}]::after {
      animation: diandian-translation-pulse 1.4s ease-in-out infinite alternate;
    }
    @keyframes diandian-translation-pulse { from { opacity: .6; } to { opacity: .85; } }
  }
`;

interface Passage {
  element: Element;
  target: ReaderTranslationTarget;
  chunks: string[];
  translated: string[];
  failed: boolean;
}
interface Work { passage: Passage; index: number }

export class ChapterTranslations {
  private doc?: Document;
  private mode: ReaderTranslationMode = "off";
  private revision = 0;
  private observer?: IntersectionObserver;
  private visible = new Set<Element>();
  private passages = new Map<Element, Passage | null>();
  private pending?: { id: number; work: Work[]; timer?: ReturnType<typeof setTimeout> };
  private waiting = new Set<Element>();
  private sequence = 0;
  private scheduled = 0;

  constructor(private emit: (event: ReaderEvent) => void, private reflow: () => void) {}

  attach(doc: Document | undefined) {
    if (this.doc === doc) return;
    this.reset();
    this.doc = doc;
    this.observe();
  }

  setMode(mode: ReaderTranslationMode, revision = 0) {
    if (this.mode === mode && this.revision === revision) return;
    const changed = this.reset();
    this.mode = mode;
    this.revision = revision;
    this.observe();
    if (changed) this.reflow();
  }

  private reset() {
    cancelAnimationFrame(this.scheduled);
    this.scheduled = 0;
    this.observer?.disconnect();
    this.observer = undefined;
    this.visible.clear();
    this.cancelPending();
    let changed = this.updateWaiting();
    for (const [element, passage] of this.passages) {
      if (passage && element.hasAttribute(translationAttribute)) {
        element.removeAttribute(translationAttribute);
        changed = true;
      }
    }
    this.passages.clear();
    return changed;
  }

  private cancelPending() {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.emit({ type: "cancelTranslation", id: this.pending.id });
    this.pending = undefined;
  }

  private updateWaiting() {
    let changed = false;
    for (const element of this.waiting) {
      if (this.visible.has(element) && !this.passages.get(element)?.failed && !element.hasAttribute(translationAttribute)) continue;
      element.removeAttribute(pendingTranslationAttribute);
      this.waiting.delete(element);
      changed = true;
    }
    if (this.pending && this.pending.timer === undefined) {
      for (const { passage: { element } } of this.pending.work) {
        if (!this.visible.has(element) || this.waiting.has(element)) continue;
        element.setAttribute(pendingTranslationAttribute, "");
        this.waiting.add(element);
        changed = true;
      }
    }
    return changed;
  }

  private observe() {
    if (!this.doc?.body || this.mode === "off") return;
    // The root is the reader viewport. A Foliate chapter iframe can itself be
    // hundreds of columns wide, so its own viewport is not the reading page.
    const observer = new IntersectionObserver(entries => {
      if (this.observer !== observer) return;
      for (const { target, isIntersecting, intersectionRect } of entries) {
        if (isIntersecting && intersectionRect.width && intersectionRect.height) this.visible.add(target);
        else this.visible.delete(target);
      }
      if (this.pending && !this.pending.work.some(({ passage }) => this.visible.has(passage.element))) {
        this.cancelPending();
      }
      if (this.updateWaiting()) this.reflow();
      this.schedule();
    });
    this.observer = observer;
    for (const element of this.doc.body.querySelectorAll(BLOCKS)) {
      if (!element.closest(IGNORE) && !element.querySelector(BLOCKS)) observer.observe(element);
    }
  }

  private schedule() {
    if (this.pending || this.scheduled || !this.visible.size) return;
    this.scheduled = requestAnimationFrame(() => {
      this.scheduled = 0;
      this.requestVisible();
    });
  }

  private passageFor(element: Element) {
    if (!this.passages.has(element)) {
      const node = element as HTMLElement;
      const text = (node.innerText ?? node.textContent ?? "").trim();
      const target = translationTarget(text, this.mode);
      this.passages.set(element, target ? { element, target, chunks: translationChunks(text), translated: [], failed: false } : null);
    }
    return this.passages.get(element);
  }

  private requestVisible() {
    let target: ReaderTranslationTarget | undefined;
    const work: Work[] = [];
    const texts: string[] = [];
    let chars = 0;
    for (const element of this.visible) {
      const passage = this.passageFor(element);
      if (!passage || passage.failed || (target && target !== passage.target)) continue;
      for (let i = 0; i < passage.chunks.length; i++) {
        if (passage.translated[i]) continue;
        const text = passage.chunks[i]!;
        if (chars + text.length > BATCH_CHARS) break;
        chars += text.length;
        target = passage.target;
        texts.push(text);
        work.push({ passage, index: i });
        if (work.length === BATCH_SIZE) break;
      }
      if (work.length === BATCH_SIZE) break;
    }
    if (!work.length || !target) return;
    const id = ++this.sequence;
    const timer = setTimeout(() => {
      if (this.pending?.id !== id) return;
      this.pending.timer = undefined;
      if (this.updateWaiting()) this.reflow();
    }, WAIT_INDICATOR_DELAY);
    this.pending = { id, work, timer };
    this.emit({ type: "translate", id, target, mode: this.mode, revision: this.revision, texts });
  }

  accept(id: number, values: string[]) {
    if (this.pending?.id !== id) return;
    clearTimeout(this.pending.timer);
    const { work } = this.pending;
    this.pending = undefined;
    const updated = new Set<Passage>();
    for (const [i, { passage, index }] of work.entries()) {
      const value = values[i]?.trim();
      if (value) {
        passage.translated[index] = value;
        updated.add(passage);
      } else passage.failed = true;
    }
    let changed = false;
    for (const passage of updated) {
      if (passage.chunks.every((_, i) => passage.translated[i])) {
        // Generated text participates in pagination without adding any child
        // nodes. Existing CFIs, selected quotations and annotation ranges
        // therefore continue to refer to exactly the original text.
        passage.element.setAttribute(translationAttribute, passage.translated.join(passage.target === "en" ? " " : ""));
        changed = true;
      }
    }
    if (this.updateWaiting() || changed) this.reflow();
    this.schedule();
  }

  // On a page filled entirely by one long generated translation, Foliate
  // falls back to the chapter body. Locate the source passage for resume.
  sourceOnTranslationPage(range?: Range): Range | undefined {
    const doc = this.doc;
    if (this.mode === "off" || !doc || !range?.collapsed || range.startContainer !== doc.body) return;
    const frame = doc.defaultView?.frameElement?.getBoundingClientRect();
    if (!frame) return;
    let largestArea = 0;
    let visible: Element | undefined;
    for (const passage of this.passages.values()) {
      if (!passage?.element.hasAttribute(translationAttribute)) continue;
      for (const rect of passage.element.getClientRects()) {
        const width = Math.min(innerWidth, rect.right + frame.left) - Math.max(0, rect.left + frame.left);
        const height = Math.min(innerHeight, rect.bottom + frame.top) - Math.max(0, rect.top + frame.top);
        if (width > 0 && height > 0 && width * height > largestArea) {
          largestArea = width * height;
          visible = passage.element;
        }
      }
    }
    if (!visible) return;
    const text = doc.createTreeWalker(visible, NodeFilter.SHOW_TEXT).nextNode();
    if (!text) return;
    const source = doc.createRange();
    source.setStart(text, 0);
    source.collapse(true);
    return source;
  }

  retry() {
    for (const passage of this.passages.values()) if (passage) passage.failed = false;
    this.schedule();
  }
}
