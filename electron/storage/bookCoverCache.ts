import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { nativeImage } from "electron";

const MAX_BYTES = 4 * 1024 * 1024;
const THUMBNAIL_SIDE = 480;
const MAX_COVER_PIXELS = 20_000_000;

function permittedUrl(url: URL, archiveRedirect: boolean): boolean {
  if (url.protocol !== "https:" || url.port || url.username || url.password) return false;
  const host = url.hostname;
  return host === "covers.openlibrary.org" || host === "books.google.com" || host === "books.googleusercontent.com"
    || ["static.zlibcdn.com", "static.zlibcdn2.com", "static.zlibcdn.me", "s3proxy.cdn-zlib.sk"].includes(host)
    || host === "cdn.weread.qq.com" || host === "res.weread.qq.com"
    || host === "wfqqreader-1252317822.image.myqcloud.com" || /^wx\d*\.qpic\.cn$/.test(host)
    || (archiveRedirect && (host === "archive.org" || /^(?:ia|dn)\d+(?:\.[a-z]+)?\.archive\.org$/.test(host)));
}

async function downloadImage(url: URL): Promise<Buffer | null> {
  const signal = AbortSignal.timeout(8_000);
  const archiveRedirect = url.hostname === "covers.openlibrary.org";
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (!permittedUrl(url, archiveRedirect)) return null;
    const response = await fetch(url, {
      redirect: "manual",
      signal,
      headers: { accept: "image/jpeg,image/png,image/webp,image/gif", "user-agent": "diandianreading/2.0 (desktop reading companion)" },
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || Number(response.headers.get("content-length")) > MAX_BYTES || !response.body) {
      await response.body?.cancel();
      return null;
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      if (length > MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  }
  return null;
}

function withinPixelLimit(width: number, height: number): boolean {
  return width >= 2 && height >= 2 && width * height <= MAX_COVER_PIXELS;
}

// Read the dimensions before asking Electron to allocate the uncompressed bitmap.
// nativeImage.createFromBuffer supports PNG and JPEG covers.
function canDecodeCover(bytes: Buffer): boolean {
  if (bytes.length < 10) return false;
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString("ascii", 12, 16) === "IHDR") {
    return withinPixelLimit(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  }
  if (bytes.readUInt16BE(0) !== 0xffd8) return false;
  let position = 2;
  while (position + 4 < bytes.length && bytes[position] === 0xff) {
    while (bytes[position] === 0xff) position++;
    if (position + 3 >= bytes.length) return false;
    const marker = bytes[position++]!;
    const length = bytes.readUInt16BE(position);
    if (length < 2 || position + length > bytes.length || marker === 0xda) return false;
    // Start of frame segments contain height and width. Skip metadata and Huffman tables.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return length >= 8 && withinPixelLimit(bytes.readUInt16BE(position + 5), bytes.readUInt16BE(position + 3));
    }
    position += length;
  }
  return false;
}

function decodeCover(bytes: Buffer) {
  if (!canDecodeCover(bytes)) return null;
  const image = nativeImage.createFromBuffer(bytes);
  return image.isEmpty() ? null : image;
}

function dataUrl(jpeg: Buffer): string {
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

export async function makeCoverThumbnail(bytes: Buffer, maxSide = THUMBNAIL_SIDE): Promise<Buffer | null> {
  const header = bytes.toString("latin1", 0, 6);
  const isGif = header === "GIF87a" || header === "GIF89a";
  const isWebP = bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP";
  if (isGif || isWebP) {
    if (isGif && (bytes.length < 10 || !withinPixelLimit(bytes.readUInt16LE(6), bytes.readUInt16LE(8)))) return null;
    try {
      const { default: sharp } = await import("sharp");
      const firstFrame = sharp(bytes, { pages: 1, limitInputPixels: MAX_COVER_PIXELS });
      const meta = await firstFrame.metadata();
      if (meta.format !== (isGif ? "gif" : "webp") || !withinPixelLimit(meta.width, meta.height)) return null;
      return await firstFrame.autoOrient().resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" }).jpeg({ quality: 88 }).toBuffer();
    } catch {
      return null;
    }
  }
  const image = decodeCover(bytes);
  if (!image) return null;
  const { width, height } = image.getSize();
  const ratio = Math.min(1, maxSide / Math.max(width, height));
  const thumb = ratio === 1 ? image : image.resize({
    width: Math.max(2, Math.round(width * ratio)),
    height: Math.max(2, Math.round(height * ratio)),
  });
  const jpeg = thumb.toJPEG(88);
  return jpeg.length ? jpeg : null;
}

export class BookCoverCache {
  private readonly directory: string;
  private readonly pending = new Map<string, Promise<string | null>>();

  constructor(userDataDir: string) {
    this.directory = path.join(userDataDir, "state", "book-covers");
  }

  /** Returns only locally persisted, decoded images. The original URL remains in the book record. */
  async get(coverUrl: string, forBook = false): Promise<string | null> {
    if (!URL.canParse(coverUrl)) return null;
    const url = new URL(coverUrl);
    if (!permittedUrl(url, false)) return null;
    url.hash = "";
    const key = createHash("sha256").update(url.href).digest("hex") + (forBook ? "-book" : "");
    const existing = this.pending.get(key);
    if (existing) return existing;
    const task = this.readOrDownload(key, url, forBook).catch(() => null).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }

  private async readOrDownload(key: string, url: URL, forBook: boolean): Promise<string | null> {
    const file = path.join(this.directory, key + ".jpg");
    let cached: Buffer | undefined;
    try {
      if ((await fs.stat(file)).size <= MAX_BYTES) cached = await fs.readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (cached && cached.at(-2) === 0xff && cached.at(-1) === 0xd9 && decodeCover(cached)) return dataUrl(cached);

    const bytes = await downloadImage(url);
    const jpeg = bytes && await makeCoverThumbnail(bytes, forBook ? 1200 : THUMBNAIL_SIDE);
    if (!jpeg) return null;
    await fs.mkdir(this.directory, { recursive: true });
    const temp = file + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(temp, jpeg, { mode: 0o600, flag: "wx" });
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true });
    }
    return dataUrl(jpeg);
  }
}
