/** Books, highlights, drafts, notebooks and Obsidian export. */
import type { ReaderHighlightColor } from "./reader";

export type BookSource = "weread" | "kindle" | "local" | "zlib" | "manual";

export type DraftKind = "review" | "card_copy" | "thread" | "script" | "note";

export type RevisionAuthorKind = "ai" | "human";

export interface RelatedHighlightItem extends HighlightRecord {
  bookTitle: string;
  bookAuthor: string;
  matchedTerms: string[];
}

export type NotebookItemKind = "book" | "draft" | "web";

export interface NotebookItemRecord {
  id: string;
  notebookId: string;
  itemKind: NotebookItemKind;
  itemRef: string;
  title: string;
  meta: string;
  createdAt: string;
}

export interface NotebookRecord {
  id: string;
  name: string;
  icon: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  items: NotebookItemRecord[];
}

export interface BookRecord {
  id: string;
  title: string;
  author: string;
  isbn: string;
  publisher: string;
  publishedYear: string;
  description: string;
  tags: string[];
  coverUrl: string;
  source: BookSource;
  sourceLocator: string;
  createdAt: string;
  updatedAt: string;
  highlightCount: number;
  draftCount: number;
}

export interface HighlightRecord {
  id: string;
  bookId: string;
  chapter: string;
  quote: string;
  note: string;
  source: BookSource;
  fingerprint: string;
  cfi?: string;
  isHighlighted?: boolean;
  color?: ReaderHighlightColor;
  createdAt: string;
}

export interface DraftRevisionRecord {
  id: string;
  draftId: string;
  revisionNo: number;
  authorKind: RevisionAuthorKind;
  content: string;
  sourceHighlightIds: string[];
  promptSummary: string;
  createdAt: string;
}

export interface DraftRecord {
  id: string;
  bookId: string | null;
  bookTitle: string;
  title: string;
  kind: DraftKind;
  createdAt: string;
  updatedAt: string;
  latestRevisionNo: number;
  latestAuthorKind: RevisionAuthorKind;
  latestContent: string;
  revisions?: DraftRevisionRecord[];
}

export interface ImportNotesResult {
  format: "kindle" | "weread" | "generic";
  booksTouched: number;
  importedCount: number;
  deduplicatedCount: number;
  bookIds: string[];
}

export type BookMetadataSource = "openlibrary" | "google-books" | "weread";

export interface BookMetadataCandidate {
  source: BookMetadataSource;
  title: string;
  author: string;
  isbn: string;
  publisher: string;
  publishedYear: string;
  description: string;
  coverUrl: string;
}

export interface BookMetadataSearchResult {
  candidates: BookMetadataCandidate[];
  issues: Array<{ source: BookMetadataSource; reason: "rate-limited" | "unavailable" }>;
  invalidIsbn?: true;
}

export interface ObsidianVaultCandidate {
  name: string;
  path: string;
  lastOpened: number;
}

export interface ObsidianExportOutcome {
  status: "written" | "unchanged" | "conflict";
  stableId: string;
  targetRelativePath: string;
  writtenRelativePath: string;
  deepLink: string;
  message: string;
}

export interface WeReadNotebookBook {
  bookId: string;
  title: string;
  author: string;
  coverUrl: string;
  publisher: string;
  isbn: string;
  intro: string;
  publishedYear: string;
  noteCount: number;
  reviewCount: number;
  bookmarkCount: number;
  sortTime: number;
}

export interface WeReadSyncOutcome {
  booksSynced: number;
  importedCount: number;
  deduplicatedCount: number;
  details: Array<{
    bookId: string;
    localBookId: string;
    title: string;
    importedCount: number;
    deduplicatedCount: number;
  }>;
}

export interface RecallHighlightItem extends HighlightRecord {
  bookTitle: string;
  bookAuthor: string;
  daysAgo: number;
}

export interface ReadingStatsSummary {
  monthKey: string;
  totalBooks: number;
  totalHighlights: number;
  totalDrafts: number;
  monthBooksCount: number;
  monthHighlightsCount: number;
  monthBooks: Array<{ id: string; title: string; author: string; highlightCount: number }>;
  featuredQuotes: Array<{ quote: string; note: string; bookTitle: string; bookAuthor: string }>;
  suggestedKeywords: string[];
}
