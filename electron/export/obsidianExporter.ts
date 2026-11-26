import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BookRecord, DraftRecord, HighlightRecord, KnowledgeDatabase } from "../storage/database";
import { resolveObsidianVaultRoot } from "./obsidianVaults";

export interface ObsidianExportOutcome {
  status: "written" | "unchanged" | "conflict";
  stableId: string;
  targetRelativePath: string;
  writtenRelativePath: string;
  deepLink: string;
  message: string;
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Sanitize a file or folder stem safely for macOS/Windows/Linux and Obsidian.
 */
export function safeVaultSegment(raw: string, fallback = "Untitled"): string {
  const cleaned = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 72);
  return cleaned || fallback;
}

function resolveInsideVault(vaultRealRoot: string, relativePath: string): string {
  const normalizedRel = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalizedRel || normalizedRel.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    throw new Error(`非法的 Vault 相对路径: ${relativePath}`);
  }
  const full = path.resolve(vaultRealRoot, normalizedRel);
  if (!full.startsWith(vaultRealRoot + path.sep)) {
    throw new Error("导出路径越界，已拒绝写入 Vault 外部");
  }
  // Check existing ancestors for symlinks.
  let cursor = vaultRealRoot;
  for (const part of normalizedRel.split("/")) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`导出路径包含符号链接，已拒绝: ${part}`);
    }
  }
  return full;
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function buildFrontmatter(fields: Record<string, string | string[]>): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      lines.push(`${k}:`);
      for (const item of v) {
        lines.push(`  - ${yamlScalar(item)}`);
      }
    } else if (v !== "") {
      lines.push(`${k}: ${yamlScalar(v)}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

function extractDiandianId(markdown: string): string | null {
  if (!markdown.startsWith("---\n")) return null;
  const end = markdown.indexOf("\n---\n", 4);
  if (end < 0) return null;
  const fm = markdown.slice(4, end);
  const match = /^diandian_id:\s*(.+)$/m.exec(fm);
  if (!match || !match[1]) return null;
  const raw = match[1].trim();
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "string" ? parsed : raw;
  } catch {
    return raw.replace(/^['"]|['"]$/g, "");
  }
}

/**
 * Scan the Vault for a file carrying the matching `diandian_id` frontmatter key
 * so user renames/moves inside Obsidian are reconciled without duplicates.
 */
function findExistingByStableId(vaultRealRoot: string, stableId: string): string | null {
  const stack = [vaultRealRoot];
  let visited = 0;
  const MAX_FILES = 4000;

  while (stack.length > 0 && visited < MAX_FILES) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.endsWith(".diandian-conflict.md")) {
        visited++;
        try {
          const head = fs.readFileSync(full, "utf8").slice(0, 1200);
          if (extractDiandianId(head) === stableId) {
            return path.relative(vaultRealRoot, full).replace(/\\/g, "/");
          }
        } catch {
          // Ignore unreadable files.
        }
      }
    }
  }
  return null;
}

export function buildObsidianDeepLink(vaultRealRoot: string, relativePath: string): string {
  const notePath = path.join(vaultRealRoot, relativePath);
  return `obsidian://open?path=${encodeURIComponent(notePath)}`;
}

function writeAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content, "utf8");
  fs.renameSync(tempPath, filePath);
}

function reconcileAndWrite(
  db: KnowledgeDatabase,
  vaultPath: string,
  stableId: string,
  defaultRelativePath: string,
  content: string,
): ObsidianExportOutcome {
  const vaultRoot = resolveObsidianVaultRoot(vaultPath);
  const nextHash = sha256(content);
  const existingMap = db.getObsidianMapping(stableId, vaultRoot);

  // 1. Reconcile location: prefer existing file matching stable_id even if renamed/moved.
  let targetRel = defaultRelativePath;
  if (existingMap) {
    const mappedFull = resolveInsideVault(vaultRoot, existingMap.relativePath);
    if (fs.existsSync(mappedFull)) {
      targetRel = existingMap.relativePath;
    } else {
      const relocated = findExistingByStableId(vaultRoot, stableId);
      if (relocated) targetRel = relocated;
    }
  } else {
    const discovered = findExistingByStableId(vaultRoot, stableId);
    if (discovered) targetRel = discovered;
  }

  const targetFull = resolveInsideVault(vaultRoot, targetRel);

  if (fs.existsSync(targetFull)) {
    const diskContent = fs.readFileSync(targetFull, "utf8");
    const diskHash = sha256(diskContent);
    if (diskHash === nextHash) {
      db.saveObsidianMapping({
        stableId,
        vaultPath: vaultRoot,
        relativePath: targetRel,
        lastExportedSha256: nextHash,
      });
      return {
        status: "unchanged",
        stableId,
        targetRelativePath: targetRel,
        writtenRelativePath: targetRel,
        deepLink: buildObsidianDeepLink(vaultRoot, targetRel),
        message: "内容未变化，已跳过写入",
      };
    }

    const ownedByUs =
      existingMap !== null && existingMap.lastExportedSha256 === diskHash;

    if (!ownedByUs) {
      // User manually edited this note — NEVER silently overwrite!
      const conflictRel = targetRel.replace(/\.md$/i, ".diandian-conflict.md");
      const conflictFull = resolveInsideVault(vaultRoot, conflictRel);
      writeAtomic(conflictFull, content);
      return {
        status: "conflict",
        stableId,
        targetRelativePath: targetRel,
        writtenRelativePath: conflictRel,
        deepLink: buildObsidianDeepLink(vaultRoot, conflictRel),
        message: `检测到你在 Obsidian 中手工修改过 ${targetRel}，已保留原文件并输出冲突副本 ${conflictRel}`,
      };
    }
  }

  writeAtomic(targetFull, content);
  db.saveObsidianMapping({
    stableId,
    vaultPath: vaultRoot,
    relativePath: targetRel,
    lastExportedSha256: nextHash,
  });
  return {
    status: "written",
    stableId,
    targetRelativePath: targetRel,
    writtenRelativePath: targetRel,
    deepLink: buildObsidianDeepLink(vaultRoot, targetRel),
    message: `已同步写入 ${targetRel}`,
  };
}

export function renderBookMarkdown(book: BookRecord, highlights: HighlightRecord[]): string {
  const fm = buildFrontmatter({
    diandian_id: `book:${book.id}`,
    title: book.title,
    author: book.author,
    isbn: book.isbn,
    publisher: book.publisher,
    published_year: book.publishedYear,
    source: book.source,
    tags: book.tags.length > 0 ? book.tags : ["reading", "diandian"],
  });

  const sections: string[] = [fm, `# ${book.title}`, ""];
  const metaParts = [
    book.author ? `**作者**：${book.author}` : "",
    book.publisher ? `**出版社**：${book.publisher}` : "",
    book.publishedYear ? `**年份**：${book.publishedYear}` : "",
    book.isbn ? `**ISBN**：${book.isbn}` : "",
  ].filter(Boolean);
  if (metaParts.length > 0) {
    sections.push(metaParts.join(" · "), "");
  }
  if (book.description) {
    sections.push("## 简介", "", book.description, "");
  }

  sections.push(`## 划线与想法（共 ${highlights.length} 条）`, "");
  if (highlights.length === 0) {
    sections.push("_暂无划线记录。_", "");
  } else {
    let lastChapter = "";
    for (const h of highlights) {
      if (h.chapter && h.chapter !== lastChapter) {
        sections.push(`### ${h.chapter}`, "");
        lastChapter = h.chapter;
      }
      const quoteLines = h.quote
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      sections.push(quoteLines, "");
      if (h.note) {
        sections.push(`**我的想法**：${h.note}`, "");
      }
    }
  }
  return sections.join("\n");
}

export function renderDraftMarkdown(draft: DraftRecord): string {
  const fm = buildFrontmatter({
    diandian_id: `draft:${draft.id}`,
    title: draft.title,
    book: draft.bookTitle,
    draft_kind: draft.kind,
    latest_revision: String(draft.latestRevisionNo),
    latest_author: draft.latestAuthorKind,
    tags: ["diandian-draft", draft.kind],
  });

  return [
    fm,
    `# ${draft.title}`,
    "",
    draft.bookTitle ? `> 来源书籍：《${draft.bookTitle}》 · 版本 v${draft.latestRevisionNo}（${draft.latestAuthorKind === "human" ? "人工修订" : "AI 初稿"}）` : `> 版本 v${draft.latestRevisionNo}（${draft.latestAuthorKind === "human" ? "人工修订" : "AI 初稿"}）`,
    "",
    draft.latestContent,
    "",
  ].join("\n");
}

export function exportBookToObsidian(
  db: KnowledgeDatabase,
  vaultPath: string,
  bookId: string,
): ObsidianExportOutcome {
  const book = db.getBook(bookId);
  if (!book) throw new Error(`书籍不存在: ${bookId}`);
  const highlights = db.listHighlights(bookId);
  const folder = safeVaultSegment(book.title, book.id);
  const rel = `DiandianReading/Books/${folder}/${folder} - 划线笔记.md`;
  return reconcileAndWrite(db, vaultPath, `book:${book.id}`, rel, renderBookMarkdown(book, highlights));
}

export function exportDraftToObsidian(
  db: KnowledgeDatabase,
  vaultPath: string,
  draftId: string,
): ObsidianExportOutcome {
  const draft = db.getDraft(draftId);
  if (!draft) throw new Error(`草稿不存在: ${draftId}`);
  const fileStem = safeVaultSegment(draft.title, draft.id);
  const rel = `DiandianReading/Drafts/${fileStem}.md`;
  return reconcileAndWrite(db, vaultPath, `draft:${draft.id}`, rel, renderDraftMarkdown(draft));
}
