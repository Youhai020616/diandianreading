import { posix } from "node:path";
import { SaxesParser } from "saxes";
import { openPromise, type Entry, type ZipFile } from "yauzl";
import { makeCoverThumbnail } from "../storage/bookCoverCache";

const XML_LIMIT = 1024 * 1024;
const IMAGE_LIMIT = 8 * 1024 * 1024;
const MAX_ENTRIES = 12_000;
const DIRECTORY_LIMIT = 8 * 1024 * 1024;

function resolveHref(documentPath: string, href: string): string | null {
  const localPart = href.trim().split(/[?#]/, 1)[0];
  if (!localPart) return null;
  let relative: string;
  try {
    relative = decodeURIComponent(localPart);
  } catch {
    return null;
  }
  if (/^(?:[a-z][a-z0-9+.-]*:|\/)|[\\\u0000]/i.test(relative)) return null;
  const resolved = posix.join(posix.dirname(documentPath), relative);
  return resolved === ".." || resolved.startsWith("../") ? null : resolved;
}

function visitXml(bytes: Buffer, visit: (name: string, attrs: Record<string, string>) => void): void {
  const bom = bytes.length >= 2 ? bytes.readUInt16BE(0) : 0;
  const encoding = bom === 0xfffe ? "utf-16le" : bom === 0xfeff ? "utf-16be" : "utf-8";
  const parser = new SaxesParser();
  parser.on("opentag", tag => visit(tag.name.slice(tag.name.lastIndexOf(":") + 1), tag.attributes));
  parser.write(new TextDecoder(encoding).decode(bytes)).close();
}

type PackageItem = { href: string; mediaType?: string };

function coverItems(opf: Buffer): PackageItem[] {
  let coverId: string | undefined;
  let propertyCover: PackageItem | undefined;
  let guideCover: PackageItem | undefined;
  let namedCover: PackageItem | undefined;
  const manifest = new Map<string, PackageItem>();
  visitXml(opf, (name, attrs) => {
    if (name === "meta" && attrs.name === "cover") coverId = attrs.content;
    if (name === "reference" && attrs.type === "cover" && attrs.href) guideCover = { href: attrs.href };
    if (name !== "item" || !attrs.id || !attrs.href) return;
    const item = { href: attrs.href, mediaType: attrs["media-type"] };
    manifest.set(attrs.id, item);
    if (attrs.properties?.split(/\s+/).includes("cover-image")) propertyCover = item;
    if (/^(?:cover|cover-image)$/i.test(attrs.id) || /(?:^|\/)cover\.(?:jpe?g|png|gif|webp)$/i.test(attrs.href)) namedCover ??= item;
  });
  return [propertyCover, coverId && manifest.get(coverId), guideCover, namedCover]
    .filter((item): item is PackageItem => Boolean(item));
}

async function readEntry(zip: ZipFile, entry: Entry | undefined, limit: number): Promise<Buffer | null> {
  if (!entry || !entry.canDecodeFileData() || !entry.uncompressedSize
      || entry.uncompressedSize > limit || entry.compressedSize > limit + 65536) return null;
  // yauzl's size-validating stream aborts if inflation exceeds the advertised size.
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function coverFromArchive(zip: ZipFile): Promise<string | null> {
  if (zip.entryCount > MAX_ENTRIES) return null;
  const entries = new Map<string, Entry>();
  let directoryBytes = 0;
  for await (const entry of zip.eachEntry()) {
    directoryBytes += 46 + entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength;
    if (directoryBytes > DIRECTORY_LIMIT) return null;
    entries.set(entry.fileName, entry);
  }
  const container = await readEntry(zip, entries.get("META-INF/container.xml"), XML_LIMIT);
  if (!container) return null;
  let rootPath = "";
  visitXml(container, (name, attrs) => {
    if (name === "rootfile" && attrs["full-path"]) rootPath ||= resolveHref("", attrs["full-path"]) ?? "";
  });
  const opf = await readEntry(zip, entries.get(rootPath), XML_LIMIT);
  if (!opf) return null;

  const tried = new Set<string>();
  for (const item of coverItems(opf)) {
    let imagePath = resolveHref(rootPath, item.href);
    if (!imagePath || tried.has(imagePath)) continue;
    tried.add(imagePath);
    if (/(?:html|svg)/i.test(item.mediaType ?? "") || /\.(?:x?html?|svg)$/i.test(imagePath)) {
      const page = await readEntry(zip, entries.get(imagePath), XML_LIMIT);
      if (!page) continue;
      let imageHref = "";
      visitXml(page, (name, attrs) => {
        if (name === "img") imageHref ||= attrs.src ?? "";
        if (name === "image") imageHref ||= attrs.href ?? attrs["xlink:href"] ?? "";
      });
      imagePath = resolveHref(imagePath, imageHref);
      if (!imagePath) continue;
    }
    const bytes = await readEntry(zip, entries.get(imagePath), IMAGE_LIMIT);
    const thumbnail = bytes && await makeCoverThumbnail(bytes);
    if (thumbnail) return `data:image/jpeg;base64,${thumbnail.toString("base64")}`;
  }
  return null;
}

/** Read only the package documents and embedded cover. Never render markup from a book. */
export async function readEpubCover(filePath: string): Promise<string | null> {
  let zip: ZipFile | undefined;
  try {
    zip = await openPromise(filePath, { autoClose: false, strictFileNames: true });
    return await coverFromArchive(zip);
  } catch {
    return null;
  } finally {
    zip?.close();
  }
}
