/** Row shapes returned by KnowledgeDatabase and its storage modules. */
import type { ReaderHighlightColor } from "./highlightColors";

export type BookSource = "weread" | "kindle" | "local" | "zlib" | "manual";
export type DraftKind = "review" | "card_copy" | "thread" | "script" | "note";
export type RevisionAuthorKind = "ai" | "human";

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

export type BookPatch = Partial<Pick<BookRecord,
  "title" | "author" | "isbn" | "publisher" | "publishedYear" | "description" | "tags" | "coverUrl"
>>;
export type NewBook = BookPatch & { title: string; source?: BookSource; sourceLocator?: string };

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

export type NewHighlight = Pick<HighlightRecord, "bookId" | "quote"> &
  Partial<Pick<HighlightRecord, "chapter" | "note" | "source" | "createdAt">>;

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

export interface ObsidianExportMapping {
  stableId: string;
  vaultPath: string;
  relativePath: string;
  lastExportedSha256: string;
  updatedAt: string;
}

export interface RecallHighlightItem extends HighlightRecord {
  bookTitle: string;
  bookAuthor: string;
  daysAgo: number;
}

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

export interface ChatMessageToolState {
  name: string;
  status: "running" | "done";
}

export interface ChatMessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  text: string;
  reasoning: string;
  contexts: string[];
  tools: ChatMessageToolState[];
  createdAt: string;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  harnessSessionId: string;
  /** The book, page or draft the conversation started from; used to group history. */
  contextLabel: string;
  messageCount: number;
  preview: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSessionDetail extends ChatSessionSummary {
  messages: ChatMessageRecord[];
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
