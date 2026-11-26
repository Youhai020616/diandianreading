import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { openPromise, type Entry, type ZipFile } from "yauzl";
import { fileDigest, type DownloadReceipt } from "./downloadReceipts";
import { listDownloadedBooks } from "./downloadedBooks";

// Older downloads have no receipt for their original bytes. Recognize only the
// cover and OPF edits made by the bundled zlib workflow, keeping the rest of the edition intact.
async function entries(zip: ZipFile) {
  if (zip.entryCount > 12_000) return;
  const files = new Map<string, Entry>();
  let bytes = 0;
  for await (const entry of zip.eachEntry()) {
    if (entry.fileName.endsWith("/")) continue;
    bytes += entry.uncompressedSize;
    if (!entry.canDecodeFileData() || files.has(entry.fileName) || bytes > 512 * 1024 ** 2 || entry.uncompressedSize > 128 * 1024 ** 2) return;
    files.set(entry.fileName, entry);
  }
  return files;
}

async function entryHash(zip: ZipFile, entry: Entry) {
  const hash = createHash("sha256");
  for await (const chunk of await zip.openReadStreamPromise(entry)) hash.update(chunk);
  return hash.digest("hex");
}

async function packageXml(zip: ZipFile, entry: Entry) {
  if (entry.uncompressedSize > 1024 ** 2) return null;
  const bytes: Buffer[] = [];
  for await (const chunk of await zip.openReadStreamPromise(entry)) bytes.push(chunk);
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(bytes));
}

function samePackage(source: string, covered: string): boolean {
  const coverMeta = /\s*<meta name="cover" content="cover-image"\s*\/>/;
  const coverItem = /\s*<item id="cover-image" href="cover-image\.jpg" media-type="image\/jpeg" properties="cover-image"\s*\/>/;
  if (!coverMeta.test(covered) || !coverItem.test(covered) || /(?:name=["']cover["']|properties=["'][^"']*cover-image)/i.test(source)) return false;
  const modificationTime = /\s*<meta\s+property=["']dcterms:modified["']\s*>\s*[\d:T.\-+Z]+\s*<\/meta>/gi;
  return source.replace(modificationTime, "") === covered.replace(coverMeta, "").replace(coverItem, "").replace(modificationTime, "");
}

async function isCoveredCopy(raw: ZipFile, original: Map<string, Entry>, file: string) {
  const copy = await openPromise(file, { autoClose: false, strictFileNames: true });
  try {
    // zlib preserves the input entries and adds exactly one JPEG. The ZIP footer
    // rules out unrelated books before reading any of their directory or resource data.
    if (copy.entryCount !== raw.entryCount + 1) return false;
    const stored = await entries(copy);
    if (!stored || stored.size !== original.size + 1) return false;
    const extras = [...stored.keys()].filter(name => !original.has(name));
    const cover = extras[0];
    if (extras.length !== 1 || !cover || path.posix.basename(cover) !== "cover-image.jpg") return false;
    const packages = [...original.keys()].filter(name => /\.opf$/i.test(name) && path.posix.dirname(name) === path.posix.dirname(cover));
    if (packages.length !== 1) return false;
    const opf = packages[0]!;
    const others = [...original].filter(([name]) => name !== opf);
    if (others.some(([name, entry]) => {
      const candidate = stored.get(name);
      return candidate?.crc32 !== entry.crc32 || candidate.uncompressedSize !== entry.uncompressedSize;
    })) return false;
    const a = await packageXml(raw, original.get(opf)!);
    const b = await packageXml(copy, stored.get(opf)!);
    if (!a || !b || !samePackage(a, b)) return false;
    for (const [name, entry] of others) {
      if (await entryHash(raw, entry) !== await entryHash(copy, stored.get(name)!)) return false;
    }
    return true;
  } finally { copy.close(); }
}

export async function findLegacyCoveredEpub(staged: string, root: string): Promise<DownloadReceipt | undefined> {
  const candidates = (await listDownloadedBooks(root)).filter(entry => entry.format === "epub");
  if (!candidates.length) return;
  const zip = await openPromise(staged, { autoClose: false, strictFileNames: true }).catch(() => null);
  if (!zip) return;
  try {
    const raw = await entries(zip);
    if (!raw?.has("META-INF/container.xml")) return;
    // Cover and package metadata cannot account for a giant unrelated archive.
    const maxSize = [...raw.values()].reduce((n, entry) => n + Math.max(entry.uncompressedSize, entry.compressedSize), 0)
      + 24 * 1024 ** 2; // Covers, OPF changes, ZIP headers and compression overhead.
    const wanted = path.basename(staged);
    candidates.sort((a, b) => Number(b.fileName === wanted) - Number(a.fileName === wanted));
    for (const candidate of candidates) {
      if (candidate.sizeBytes > maxSize) continue;
      const file = candidate.filePath;
      const before = await fs.lstat(file).catch(() => null);
      if (!before?.isFile()) continue;
      if (await isCoveredCopy(zip, raw, file).catch(() => false)) {
        const hash = await fileDigest(file);
        const after = await fs.lstat(file).catch(() => null);
        if (after?.dev === before.dev && after.ino === before.ino && after.ctimeMs === before.ctimeMs && after.size === before.size) {
          return { file, size: before.size, hash };
        }
      }
    }
  } catch { /* Invalid or unfamiliar EPUBs retain separate files. */ }
  finally { zip.close(); }
}
