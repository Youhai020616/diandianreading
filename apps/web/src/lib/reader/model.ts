/**
 * Client-side projections of the R1/R2 reading and annotation payloads.
 * Shapes mirror `interfaces/web/serializers.py` exactly; nothing is invented
 * and unknown values degrade to null instead of throwing.
 */
import { isRecord, unwrapData, type UnknownRecord } from "../records";
import { displayText, internalIdentifier } from "../text";
import type { BookSnapshot } from "../types";
import { normalizeBook } from "../normalize";

export const ANNOTATION_COLORS = ["yellow", "green", "blue", "pink", "purple"] as const;
export type AnnotationColorValue = (typeof ANNOTATION_COLORS)[number];

export type AnchorTypeValue = "markdown_offset" | "pdf_page";
export type AnnotationKindValue = "highlight" | "note";
export type AnnotationStatusValue = "active" | "orphaned" | "deleted";

export interface QuoteView {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface AnchorView {
  type: AnchorTypeValue;
  anchorSha256: string;
  start: number | null;
  end: number | null;
  chapterRef: string | null;
  quote: QuoteView | null;
}

export interface AnnotationView {
  id: string;
  bookId: string;
  kind: AnnotationKindValue;
  status: AnnotationStatusValue;
  anchor: AnchorView | null;
  selectedText: string | null;
  body: string | null;
  color: AnnotationColorValue | null;
  createdAt: string | null;
  updatedAt: string | null;
  version: number;
}

export interface ChapterView {
  reference: string;
  title: string;
  /** Codepoint offsets into the normalized markdown (server-computed). */
  start: number;
  end: number;
}

export interface ReadingDocumentInfo {
  anchorSha256: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ProgressView {
  anchor: AnchorView;
  percent: number;
  version: number;
}

export interface BookDetail {
  book: BookSnapshot;
  document: ReadingDocumentInfo;
  chapters: ChapterView[];
  progress: ProgressView | null;
}

function finiteInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

export function normalizeAnchor(raw: unknown): AnchorView | null {
  if (!isRecord(raw)) {
    return null;
  }
  const type = raw["type"];
  if (type !== "markdown_offset" && type !== "pdf_page") {
    return null;
  }
  const sha = raw["anchor_sha256"];
  if (typeof sha !== "string" || sha.length === 0) {
    return null;
  }
  let quote: QuoteView | null = null;
  const rawQuote = raw["quote"];
  if (isRecord(rawQuote) && typeof rawQuote["exact"] === "string") {
    quote = {
      exact: rawQuote["exact"],
      prefix: typeof rawQuote["prefix"] === "string" ? rawQuote["prefix"] : "",
      suffix: typeof rawQuote["suffix"] === "string" ? rawQuote["suffix"] : "",
    };
  }
  return {
    type,
    anchorSha256: sha,
    start: finiteInt(raw["start"]),
    end: finiteInt(raw["end"]),
    chapterRef: typeof raw["chapter_ref"] === "string" ? raw["chapter_ref"] : null,
    quote,
  };
}

export function normalizeAnnotation(raw: unknown): AnnotationView | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = internalIdentifier(raw["id"]);
  const bookId = internalIdentifier(raw["book_id"]);
  const kind = raw["kind"];
  const status = raw["status"];
  if (
    !id
    || !bookId
    || (kind !== "highlight" && kind !== "note")
    || (status !== "active" && status !== "orphaned" && status !== "deleted")
  ) {
    return null;
  }
  const rawColor = raw["color"];
  const color = (ANNOTATION_COLORS as readonly string[]).includes(rawColor as string)
    ? (rawColor as AnnotationColorValue)
    : null;
  return {
    id,
    bookId,
    kind,
    status,
    anchor: normalizeAnchor(raw["anchor"]),
    selectedText: typeof raw["selected_text"] === "string" ? raw["selected_text"] : null,
    body: typeof raw["body"] === "string" ? raw["body"] : null,
    color,
    createdAt: typeof raw["created_at"] === "string" ? raw["created_at"] : null,
    updatedAt: typeof raw["updated_at"] === "string" ? raw["updated_at"] : null,
    version: finiteInt(raw["version"]) ?? 0,
  };
}

export function normalizeProgress(raw: unknown): ProgressView | null {
  if (!isRecord(raw)) {
    return null;
  }
  const anchor = normalizeAnchor(raw["anchor"]);
  const percent = raw["percent"];
  if (anchor === null || typeof percent !== "number" || !Number.isFinite(percent)) {
    return null;
  }
  return {
    anchor,
    percent: Math.max(0, Math.min(1, percent)),
    version: finiteInt(raw["version"]) ?? 0,
  };
}

export function normalizeChapters(raw: unknown): ChapterView[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const chapters: ChapterView[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue;
    }
    const reference = internalIdentifier(entry["reference"]);
    const start = finiteInt(entry["start"]);
    const end = finiteInt(entry["end"]);
    if (!reference || start === null || end === null || end < start) {
      continue;
    }
    chapters.push({
      reference,
      title: displayText(entry["title"], "", 200),
      start,
      end,
    });
  }
  return chapters;
}

export function normalizeBookDetail(payload: unknown): BookDetail | null {
  const data = unwrapData(payload);
  if (!isRecord(data)) {
    return null;
  }
  const book = normalizeBook(data["book"]);
  const rawDocument = data["document"];
  if (book === null || !isRecord(rawDocument)) {
    return null;
  }
  const sha = rawDocument["anchor_sha256"];
  const mime = rawDocument["mime_type"];
  if (typeof sha !== "string" || sha.length === 0 || typeof mime !== "string") {
    return null;
  }
  return {
    book,
    document: {
      anchorSha256: sha,
      mimeType: mime,
      sizeBytes: finiteInt(rawDocument["size_bytes"]) ?? 0,
    },
    chapters: normalizeChapters(data["chapters"]),
    progress: normalizeProgress(data["progress"]),
  };
}

export function annotationEnvelope(payload: unknown): AnnotationView | null {
  const data = unwrapData(payload);
  if (!isRecord(data)) {
    return null;
  }
  return normalizeAnnotation(data["annotation"]);
}

export interface AnnotationPage {
  annotations: AnnotationView[];
  nextCursor: { createdAt: string; id: string } | null;
}

export function normalizeAnnotationPage(payload: unknown): AnnotationPage {
  const data = unwrapData(payload);
  const annotations: AnnotationView[] = [];
  let nextCursor: { createdAt: string; id: string } | null = null;
  if (isRecord(data)) {
    const rawList = data["annotations"];
    if (Array.isArray(rawList)) {
      for (const entry of rawList) {
        const annotation = normalizeAnnotation(entry);
        if (annotation !== null) {
          annotations.push(annotation);
        }
      }
    }
    const cursor = data["next_cursor"];
    if (isRecord(cursor)) {
      const createdAt = cursor["created_at"];
      const id = cursor["id"];
      if (typeof createdAt === "string" && typeof id === "string") {
        nextCursor = { createdAt, id };
      }
    }
  }
  return { annotations, nextCursor };
}

export function progressEnvelope(payload: unknown): ProgressView | null {
  const data = unwrapData(payload);
  if (!isRecord(data)) {
    return null;
  }
  return normalizeProgress((data as UnknownRecord)["progress"]);
}
