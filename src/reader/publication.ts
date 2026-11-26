import { EPUB } from "foliate-js/epub.js";
import { BlobReader, configure, type Entry, ZipReader } from "foliate-js/vendor/zip.js";
import { pendingTranslationAttribute, translationAttribute } from "./bilingual";
import type { EpubBook } from "./foliate-types";
import { EPUB_LIMITS } from "../../electron/router/epubLimits";

const chapterPolicy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline' blob:; img-src blob: data:; font-src blob: data:; media-src blob:; frame-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

function stripActiveMarkup(source: string, mime: DOMParserSupportedType): string {
  const doc = new DOMParser().parseFromString(source, mime);
  const pi = doc.createTreeWalker(doc, NodeFilter.SHOW_PROCESSING_INSTRUCTION);
  const instructions: Node[] = [];
  while (pi.nextNode()) instructions.push(pi.currentNode);
  for (const node of instructions) node.parentNode?.removeChild(node);
  for (const element of doc.querySelectorAll("script,iframe,frame,frameset,object,embed,form,base,meta[http-equiv],foreignObject,link:not([rel~=stylesheet])")) element.remove();
  for (const element of doc.querySelectorAll("*")) {
    for (const name of element.getAttributeNames()) {
      if ([translationAttribute, pendingTranslationAttribute, "ping", "target", "download", "action", "formaction", "srcdoc"].includes(name) || /^on/i.test(name)) element.removeAttribute(name);
    }
    if (element.localName === "a" || element.localName === "area") {
      for (const attr of Array.from(element.attributes)) {
        if (attr.localName === "href" && /^(?:[a-z][a-z\d+.-]*:|\/\/|\\)/i.test(attr.value.trim())) element.removeAttributeNode(attr);
      }
    }
  }
  if (doc.head) {
    const meta = doc.createElementNS("http://www.w3.org/1999/xhtml", "meta");
    meta.setAttribute("http-equiv", "Content-Security-Policy");
    meta.setAttribute("content", chapterPolicy);
    doc.head.prepend(meta);
  }
  return new XMLSerializer().serializeToString(doc);
}

export async function openPublication(bytes: Uint8Array): Promise<EpubBook> {
  configure({ useWebWorkers: false });
  const zip = new ZipReader(new BlobReader(new Blob([bytes as Uint8Array<ArrayBuffer>])));
  const entries = new Map<string, Entry>();
  let total = 0;
  for await (const entry of zip.getEntriesGenerator()) {
    total += entry.uncompressedSize;
    if (entries.size >= EPUB_LIMITS.entries || total > EPUB_LIMITS.totalBytes) throw new Error("电子书内容过大，请使用系统阅读器打开。");
    if (entries.has(entry.filename)) throw new Error("书内存在重名资源，无法可靠定位正文。");
    entries.set(entry.filename, entry);
  }
  async function read(name: string, limit: number, type?: string): Promise<Blob | null> {
    const entry = entries.get(name);
    if (!entry || entry.directory) return null;
    if (entry.encrypted) throw new Error("该电子书包含加密内容，无法在工作台中读取。");
    if (entry.uncompressedSize > limit) throw new Error("书内资源过大，请使用系统阅读器打开。");
    let size = 0;
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    await entry.getData(new WritableStream({
      write(chunk) {
        size += chunk.byteLength;
        if (size > limit || size > entry.uncompressedSize) throw new Error("书内资源超过读取上限。");
        chunks.push(chunk);
      },
    }), { checkSignature: true });
    return new Blob(chunks, { type });
  }

  const book = await new EPUB({
    loadText: async name => (await read(name, EPUB_LIMITS.textBytes))?.text() ?? null,
    loadBlob: (name, type) => read(name, EPUB_LIMITS.entryBytes, type),
    getSize: name => entries.get(name)?.uncompressedSize ?? 0,
  }).init();
  if (!book.sections.length) throw new Error("这本 EPUB 没有可读章节。");

  book.transformTarget.addEventListener("load", event => {
    const { detail } = event as CustomEvent<{ isScript: boolean; allow: boolean }>;
    if (detail.isScript) detail.allow = false;
  });
  book.transformTarget.addEventListener("data", event => {
    const { detail } = event as CustomEvent<{ type: string; data: string | Blob | Promise<string | Blob> }>;
    if (["text/html", "application/xhtml+xml", "image/svg+xml"].includes(detail.type)) {
      detail.data = Promise.resolve(detail.data).then(async data =>
        stripActiveMarkup(typeof data === "string" ? data : await data.text(), detail.type as DOMParserSupportedType));
    }
  });
  return book;
}
