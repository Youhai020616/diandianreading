/** Local EPUB reader annotations and translation. */
import type { HighlightRecord } from "./library";

export type ReaderHighlightColor = import("../../../electron/storage/highlightColors").ReaderHighlightColor;

export type ReaderAnnotation = HighlightRecord & { cfi: string; isHighlighted: boolean; color: ReaderHighlightColor };

export type ReaderTranslationProvider = "deepl" | "model";

export interface ReaderTranslationSettings {
  provider: ReaderTranslationProvider;
  hasDeepLKey: boolean;
}

export interface ReaderTranslationSettingsInput {
  provider: ReaderTranslationProvider;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface ReaderTranslationInput {
  provider?: ReaderTranslationProvider;
  target: "en" | "zh";
  texts: string[];
  requestId?: string;
}

export interface ReaderAnnotationInput {
  documentId: string;
  title: string;
  author?: string;
  isbn?: string;
  chapter: string;
  quote: string;
  note?: string;
  cfi: string;
  color?: ReaderHighlightColor;
}

export interface OpenReaderBook {
  bytes: Uint8Array;
  documentId: string;
  location: string;
  annotations: ReaderAnnotation[];
}
