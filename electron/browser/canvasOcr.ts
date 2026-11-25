import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface OcrLineObservation {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const END_PUNCT_RE = /[。！？!?：:；;…”」』》）】\])\.…]$/;
const CJK_CHAR_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

/**
 * Reconstruct clean paragraphs from Apple Vision bounding-box observations
 * (Vision normalized coordinates: y=0 at bottom, y=1 at top).
 */
export function reconstructOcrParagraphs(rawItems: OcrLineObservation[]): string {
  const items = rawItems
    .map((item) => ({
      ...item,
      text: String(item.text ?? "").replace(/\s+/g, " ").trim(),
    }))
    .filter((item) => item.text.length > 0);

  if (items.length === 0) return "";

  const avgHeight =
    items.reduce((sum, item) => sum + (item.h > 0 ? item.h : 0.02), 0) / items.length;
  const sameRowThreshold = Math.max(0.006, avgHeight * 0.45);

  // Sort top-to-bottom (y descending), grouping same visual line left-to-right (x ascending).
  const sorted = [...items].sort((a, b) => {
    if (Math.abs(a.y - b.y) <= sameRowThreshold) {
      return a.x - b.x;
    }
    return b.y - a.y;
  });

  // Merge fragments that lie on the exact same horizontal line.
  const lines: OcrLineObservation[] = [];
  for (const item of sorted) {
    const prev = lines[lines.length - 1];
    if (prev && Math.abs(prev.y - item.y) <= sameRowThreshold) {
      const gap = item.x - (prev.x + prev.w);
      const sep = gap > avgHeight * 0.4 ? " " : "";
      prev.text = `${prev.text}${sep}${item.text}`.trim();
      prev.w = Math.max(prev.w, item.x + item.w - prev.x);
      prev.h = Math.max(prev.h, item.h);
    } else {
      lines.push({ ...item });
    }
  }

  // Compute typical intra-paragraph line spacing using lower quartile (robust even on pages with many short paragraphs/headings).
  const steps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const step = lines[i - 1]!.y - lines[i]!.y;
    if (step > 0 && step < avgHeight * 4) steps.push(step);
  }
  steps.sort((a, b) => a - b);
  const baseStep =
    steps.length > 0
      ? steps[Math.floor((steps.length - 1) * 0.25)]!
      : Math.max(0.02, avgHeight * 1.4);

  // Estimate left margin for paragraph indentation detection.
  const xs = lines.map((l) => l.x).sort((a, b) => a - b);
  const baseLeftX = xs[Math.floor(xs.length * 0.25)] ?? 0;

  const paragraphs: string[] = [];
  let current = lines[0]!.text;

  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1]!;
    const curr = lines[i]!;
    const dy = prev.y - curr.y;
    const isLargeGap = dy > baseStep * 1.38;
    const isHeadingLine =
      prev.h > avgHeight * 1.25 || (prev.text.length <= 16 && !/[，,、；;]$/.test(prev.text) && dy > baseStep * 1.12);
    const isIndentedStart =
      curr.x - baseLeftX > avgHeight * 1.1 && END_PUNCT_RE.test(prev.text);

    if (isLargeGap || isHeadingLine || isIndentedStart) {
      paragraphs.push(current.trim());
      current = curr.text;
    } else {
      const prevTail = current.slice(-1);
      const currHead = curr.text.slice(0, 1);
      const needsSpace =
        prevTail && currHead && !CJK_CHAR_RE.test(prevTail) && !CJK_CHAR_RE.test(currHead);
      current = `${current}${needsSpace ? " " : ""}${curr.text}`;
    }
  }
  if (current.trim()) paragraphs.push(current.trim());

  return paragraphs
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

const MACOS_VISION_JXA_SCRIPT = `
ObjC.import("Foundation");
ObjC.import("Vision");
function run(argv) {
  const filePath = argv[0];
  if (!filePath) return "[]";
  const url = $.NSURL.fileURLWithPath(filePath);
  const req = $.VNRecognizeTextRequest.alloc.init;
  req.recognitionLanguages = $(["zh-Hans", "zh-Hant", "en-US"]);
  req.recognitionLevel = $.VNRequestTextRecognitionLevelAccurate;
  req.usesLanguageCorrection = true;
  const handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $.NSDictionary.dictionary);
  const ok = handler.performRequestsError($([req]), null);
  if (!ok) return "[]";
  const results = req.results;
  const out = [];
  for (let i = 0; i < results.count; i++) {
    const obs = results.objectAtIndex(i);
    const top = obs.topCandidates(1);
    if (top.count === 0) continue;
    const box = obs.boundingBox;
    out.push({
      text: ObjC.unwrap(top.objectAtIndex(0).string),
      x: box.origin.x,
      y: box.origin.y,
      w: box.size.width,
      h: box.size.height,
    });
  }
  return JSON.stringify(out);
}
`;

function runOsascriptVision(imagePath: string, timeoutMs = 10_000): Promise<OcrLineObservation[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", MACOS_VISION_JXA_SCRIPT, imagePath],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout || "[]").trim() || "[]");
          resolve(Array.isArray(parsed) ? (parsed as OcrLineObservation[]) : []);
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );
  });
}

/**
 * 100% local on-device OCR for Canvas-rendered pages (e.g. WeRead Web Reader).
 * Uses macOS built-in Apple Vision framework with zero external dependencies or network calls.
 */
export async function recognizeCanvasPngLocally(pngBuffer: Buffer): Promise<string> {
  if (process.platform !== "darwin" || !pngBuffer || pngBuffer.length === 0) {
    return "";
  }
  const tempFile = path.join(
    os.tmpdir(),
    `diandian-ocr-${process.pid}-${crypto.randomBytes(6).toString("hex")}.png`,
  );
  try {
    fs.writeFileSync(tempFile, pngBuffer, { mode: 0o600 });
    const observations = await runOsascriptVision(tempFile);
    return reconstructOcrParagraphs(observations);
  } catch {
    return "";
  } finally {
    try {
      fs.unlinkSync(tempFile);
    } catch {
      // Ignore cleanup error
    }
  }
}
