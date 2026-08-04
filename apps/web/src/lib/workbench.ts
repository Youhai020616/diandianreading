import { apiRequest } from "./api";

export type ContentStatus =
  | "queued"
  | "generating"
  | "draft"
  | "editing"
  | "approved"
  | "scheduled"
  | "published";

export type RevisionAuthor = "ai" | "human";

export interface ContentAssetSnapshot {
  id: string;
  book_id: string;
  content_type: string;
  status: ContentStatus;
  language: string;
  tone: string;
  length: string;
  target_platform: string | null;
  require_citations: boolean;
  first_person: boolean;
  sources: Array<{ kind: string; reference: string }>;
  latest_revision_number: number;
}

export interface ContentRevisionSnapshot {
  id: string;
  content_id: string;
  revision_number: number;
  author_kind: RevisionAuthor;
  title: string;
  body: string;
  created_at: string | null;
}

export interface ExportResultSnapshot {
  target_kind: string;
  outcome: "created" | "updated" | "unchanged" | "conflict";
  relative_path: string;
  deep_link: string;
  conflict_path: string | null;
}

export interface GenerationForm {
  contentType: string;
  tone: string;
  length: string;
  language: string;
  targetPlatform: string;
  requireCitations: boolean;
  firstPerson: boolean;
}

export const CONTENT_TYPES: Array<{ value: string; label: string }> = [
  { value: "reading_report", label: "读书长文" },
  { value: "reading_card", label: "读书卡片" },
  { value: "slides", label: "幻灯片大纲" },
  { value: "podcast_script", label: "播客脚本" },
  { value: "video_script", label: "视频脚本" },
  { value: "short_post", label: "社交短帖" },
  { value: "quiz", label: "复习题" },
];

export const TONES: Array<{ value: string; label: string }> = [
  { value: "rational", label: "理性" },
  { value: "personal", label: "个人化" },
  { value: "narrative", label: "故事化" },
  { value: "concise", label: "简洁" },
];

export const LENGTHS: Array<{ value: string; label: string }> = [
  { value: "short", label: "短" },
  { value: "medium", label: "中" },
  { value: "long", label: "长" },
];

function envelopeData(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && "data" in payload) {
    const data = (payload as { data: unknown }).data;
    if (data && typeof data === "object") {
      return data as Record<string, unknown>;
    }
  }
  return {};
}

export async function listContents(bookId: string): Promise<ContentAssetSnapshot[]> {
  const data = envelopeData(await apiRequest(`/api/books/${encodeURIComponent(bookId)}/contents`));
  const contents = data.contents;
  return Array.isArray(contents) ? (contents as ContentAssetSnapshot[]) : [];
}

export async function generateContent(
  bookId: string,
  form: GenerationForm,
): Promise<ContentAssetSnapshot | null> {
  const data = envelopeData(
    await apiRequest(`/api/books/${encodeURIComponent(bookId)}/generate-content`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content_type: form.contentType,
        tone: form.tone,
        length: form.length,
        language: form.language,
        target_platform: form.targetPlatform.trim() === "" ? null : form.targetPlatform.trim(),
        require_citations: form.requireCitations,
        first_person: form.firstPerson,
      }),
    }),
  );
  const content = data.content;
  return content ? (content as ContentAssetSnapshot) : null;
}

export async function loadContent(contentId: string): Promise<{
  content: ContentAssetSnapshot | null;
  revisions: ContentRevisionSnapshot[];
}> {
  const data = envelopeData(await apiRequest(`/api/contents/${encodeURIComponent(contentId)}`));
  const revisions = data.revisions;
  return {
    content: (data.content as ContentAssetSnapshot) ?? null,
    revisions: Array.isArray(revisions) ? (revisions as ContentRevisionSnapshot[]) : [],
  };
}

export async function saveRevision(
  contentId: string,
  title: string,
  body: string,
): Promise<void> {
  await apiRequest(`/api/contents/${encodeURIComponent(contentId)}/revisions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, body }),
  });
}

export async function exportToObsidian(bookId: string): Promise<ExportResultSnapshot[]> {
  const data = envelopeData(
    await apiRequest(`/api/books/${encodeURIComponent(bookId)}/obsidian-export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  const exports = data.exports;
  return Array.isArray(exports) ? (exports as ExportResultSnapshot[]) : [];
}
