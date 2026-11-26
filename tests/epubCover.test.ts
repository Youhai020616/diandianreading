import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readEpubCover } from "../electron/router/epubCover";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 101, 0, 70, 0, 0xff, 0xd9]);
const dataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
vi.mock("electron", () => ({
  nativeImage: {
    createFromBuffer: (bytes: Buffer) => ({
      isEmpty: () => !bytes.equals(jpeg),
      getSize: () => ({ width: 70, height: 101 }),
      toJPEG: () => jpeg,
    }),
  },
}));

let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "epub-cover-")); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

async function book(content: string, resources: Record<string, Buffer | string> = {}) {
  const files: Record<string, Buffer> = {
    "META-INF/container.xml": Buffer.from('<container><rootfiles><rootfile full-path="OPS/Book.opf"/></rootfiles></container>'),
    "OPS/Book.opf": Buffer.from(`<package>${content}</package>`),
  };
  for (const [name, data] of Object.entries(resources)) files[name] = Buffer.from(data);
  const filePath = path.join(directory, "测试书.epub");
  await fs.writeFile(filePath, zipSync(files));
  return filePath;
}

describe("local EPUB covers", () => {
  it.each(["gif", "webp"] as const)("previews the first frame of an embedded %s cover offline", async format => {
    const pixels = Buffer.concat([Buffer.alloc(24 * 36 * 3, 16), Buffer.alloc(24 * 36 * 3, 233)]);
    const image = await sharp(pixels, { raw: { width: 24, height: 72, pageHeight: 36, channels: 3 } })
      .toFormat(format, { delay: [40, 40] }).toBuffer();
    const file = await book(`<manifest><item id="illustration" href="assets/cover.${format}"/></manifest>`,
      { [`OPS/assets/cover.${format}`]: image });
    const before = await fs.readFile(file);
    const result = await readEpubCover(file);
    expect(result).toMatch(/^data:image\/jpeg;base64,/);
    const thumbnail = sharp(Buffer.from(result!.split(",")[1]!, "base64"));
    expect(await thumbnail.metadata()).toMatchObject({ format: "jpeg", width: 24, height: 36 });
    expect((await thumbnail.raw().toBuffer())[0]).toBeLessThan(25);
    expect(await fs.readFile(file)).toEqual(before);
  });

  it("ignores damaged WebP and oversized GIF covers", async () => {
    const oversized = await sharp({ create: { width: 12, height: 12, channels: 3, background: "red" } }).gif().toBuffer();
    oversized.writeUInt16LE(30_000, 6);
    oversized.writeUInt16LE(30_000, 8);
    for (const payload of [Buffer.from("RIFF0000WEBPbad"), oversized]) {
      const file = await book('<manifest><item id="art" properties="cover-image" href="front"/></manifest>', { "OPS/front": payload });
      expect(await readEpubCover(file)).toBeNull();
    }
  });

  it("chooses the EPUB3 cover property over competing images and resolves escaped paths", async () => {
    const file = await book(`<manifest>
      <item id="cover" href="other.jpg"/>
      <item id="x" href="images/%E4%B9%A6%20&amp;%20me.jpg" properties="optional cover-image"/>
    </manifest>`, { "OPS/images/书 & me.jpg": jpeg, "OPS/other.jpg": "not the declared cover" });
    expect(await readEpubCover(file)).toBe(dataUrl);
  });

  it("uses the EPUB2 cover metadata ID regardless of the image filename", async () => {
    const file = await book(`<metadata><meta name="cover" content="x_cover.jpg"/></metadata>
      <manifest><item id="x_cover.jpg" href="Images/00073.jpg"/></manifest>`, { "OPS/Images/00073.jpg": jpeg });
    expect(await readEpubCover(file)).toBe(dataUrl);
  });

  it.each(['<img src="../Images/front.jpg"/>', '<svg><image xlink:href="../Images/front.jpg"/></svg>'])(
    "follows a guide cover page with a relative image reference", async (markup) => {
      const file = await book('<guide><reference type="cover" href="Text/cover.xhtml#front"/></guide>', {
        "OPS/Text/cover.xhtml": `<html xmlns:xlink="http://www.w3.org/1999/xlink"><body>${markup}</body></html>`,
        "OPS/Images/front.jpg": jpeg,
      });
      expect(await readEpubCover(file)).toBe(dataUrl);
    },
  );

  it.each(["https://example.org/front.jpg", "../../outside.jpg", "/front.jpg", "bad%zz", "file:///front.jpg"])(
    "ignores non-archive references", async (href) => {
      const file = await book(`<manifest><item id="front" properties="cover-image" href="${href}"/></manifest>`);
      expect(await readEpubCover(file)).toBeNull();
    },
  );

  it("leaves undeclared illustrations alone and reads a conventionally named cover", async () => {
    const resources = { "OPS/assets/a.jpg": jpeg, "OPS/assets/cover.jpg": jpeg };
    const file = await book('<manifest><item id="figure1" href="assets/a.jpg"/></manifest>', resources);
    expect(await readEpubCover(file)).toBeNull();
    await book('<manifest><item id="i1" href="assets/cover.jpg"/></manifest>', resources);
    expect(await readEpubCover(file)).toBe(dataUrl);
  });

  it("skips oversized and non-image cover entries", async () => {
    for (const payload of [Buffer.alloc(8 * 1024 * 1024 + 1), Buffer.from("<svg/>")]) {
      const file = await book('<manifest><item id="cover" href="front.jpg"/></manifest>', { "OPS/front.jpg": payload });
      expect(await readEpubCover(file)).toBeNull();
    }
  });

  it("handles missing files, invalid ZIPs and incomplete XML", async () => {
    const file = await book("<manifest>");
    expect(await readEpubCover(file)).toBeNull();
    await fs.writeFile(file, "not a zip file");
    expect(await readEpubCover(file)).toBeNull();
    await fs.rm(file);
    expect(await readEpubCover(file)).toBeNull();
  });
});
