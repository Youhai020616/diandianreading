import { createHash } from "node:crypto";
import { strToU8, zipSync, type Zippable } from "fflate";

const MAX_BYTES = 2 * 1024 * 1024;

function xml(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function clean(text: string) {
  // Keep only characters allowed in XML 1.0, including supplementary-plane characters.
  return text.replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "").replace(/\r\n?/g, "\n").trim();
}

export function pastedTextEpub(input: { title: string; text: string }) {
  if (typeof input?.text !== "string" || typeof input.title !== "string" || input.title.length > 200) {
    throw new Error("请填写有效的书名和正文。");
  }
  if (Buffer.byteLength(input.text) > MAX_BYTES) throw new Error("每次最多可粘贴 2 MB 的文本。");
  const text = clean(input.text);
  if (!text) throw new Error("请先粘贴正文。");
  const title = clean(input.title) || [...text.split("\n", 1)[0]!].slice(0, 40).join("");
  const name = [...title.replace(/[<>:"/\\|?*\s]+/g, " ").replace(/^[. ]+|[. ]+$/g, "")].slice(0, 48).join("") || "文本";
  const fileName = (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name) ? "_" : "") + name + ".epub";
  const identifier = "urn:sha256:" + createHash("sha256").update(JSON.stringify([title, text])).digest("hex");
  const heading = xml(title);
  const lang = /\p{Script=Han}/u.test(text.slice(0, 4096)) ? "zh" : /[a-z]/i.test(text.slice(0, 4096)) ? "en" : "und";
  const doc = (body: string) => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}"><head><title>${heading}</title></head><body>${body}</body></html>`;
  const archive: Zippable = {
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8('<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
  };
  const sections: string[] = [];
  let paragraphs: string[] = [];
  let length = 0;
  const flush = () => {
    const id = "section-" + (sections.length + 1);
    archive[id + ".xhtml"] = strToU8(doc((sections.length ? "" : `<h1>${heading}</h1>`) + paragraphs.join("")));
    sections.push(id);
    paragraphs = [];
    length = 0;
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (length >= 24_000) flush();
    paragraphs.push(`<p>${xml(line)}</p>`);
    length += line.length + 7;
  }
  flush();
  const items = sections.map(id => `<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`).join("");
  const spine = sections.map(id => `<itemref idref="${id}"/>`).join("");
  const links = sections.map((id, i) => `<li><a href="${id}.xhtml">${sections.length === 1 ? heading : `第 ${i + 1} 部分`}</a></li>`).join("");
  archive["nav.xhtml"] = strToU8(doc(`<nav epub:type="toc"><ol>${links}</ol></nav>`));
  archive["book.opf"] = strToU8(`<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${heading}</dc:title><dc:identifier id="id">${identifier}</dc:identifier><dc:language>${lang}</dc:language><meta property="dcterms:modified">2000-01-01T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${items}</manifest><spine>${spine}</spine></package>`);
  // Fixed ZIP fields make the same text and title content-identical across imports.
  return { fileName, bytes: zipSync(archive, { mtime: new Date(2000, 0, 1), level: 1 }) };
}
