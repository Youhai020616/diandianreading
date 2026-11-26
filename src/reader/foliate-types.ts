// Public subset of foliate-js used by the reader, pinned in package.json.
export type MetadataText = string | Record<string, string>;
export interface TocItem {
  label: string;
  href?: string;
  subitems?: TocItem[];
}
export interface EpubSection {
  id: string;
  cfi: string;
  linear?: string;
  createDocument(): Promise<Document>;
}
export interface EpubBook {
  metadata: { title?: MetadataText; author?: Array<string | { name?: MetadataText }> };
  toc?: TocItem[];
  sections: EpubSection[];
  transformTarget: EventTarget;
  resolveHref(href: string): { index: number; anchor(doc: Document): Element | number | null } | null;
  destroy(): void;
}
export interface FoliateView extends HTMLElement {
  book: EpubBook;
  lastLocation?: { tocItem?: TocItem | null; cfi: string; range: Range; fraction: number; section: {current: number} };
  renderer: HTMLElement & {
    setStyles?(css: string | [before: string, after: string]): void;
    render?(): void;
    scrollToAnchor?(anchor: Range): Promise<void>;
    getContents(): { doc: Document; index: number }[];
    /** Paginator only: current page and page count, including one blank page on each side. */
    page?: number;
    pages?: number;
  };
  open(book: EpubBook): Promise<void>;
  init(options: { lastLocation?: string | null; showTextStart: boolean }): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  goLeft(): Promise<void>;
  goRight(): Promise<void>;
  goToFraction(fraction: number): Promise<void>;
  goTo(locator: string | number): Promise<unknown>;
  getCFI(index: number, range: Range): string;
  resolveCFI(cfi: string): { index: number; anchor(doc: Document): Range };
  addAnnotation(annotation: { value: string }, remove?: boolean): Promise<unknown>;
  deselect(): void;
  close(): void;
}
