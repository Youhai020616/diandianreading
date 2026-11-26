import type { ReaderFontFamily } from "./fonts";
import type { ReaderColors, ReaderHighlightColor, ReaderTexture, ReaderThemeId, ReaderThemeMode } from "./themes";

export type ReaderTranslationTarget = "en" | "zh";
export type ReaderTranslationMode = "off" | "auto" | ReaderTranslationTarget;

/** What the reader remembers between books. */
export interface ReaderPreferences {
  fontFamily?: ReaderFontFamily;
  fontSize: number;
  lineHeight: number;
  columns: 1 | 2;
  theme: ReaderThemeId;
  mode: ReaderThemeMode;
  texture: ReaderTexture;
}

/** Preferences plus colors resolved by the host, so the frame does not depend on the app theme. */
export interface ReaderAppearance extends ReaderPreferences {
  colors: ReaderColors;
}

export interface ReaderLocation {
  locator: string;
  chapter: string;
  fraction: number;
  /** Rendered pages of the current chapter; absent for fixed-layout books. */
  sectionPage?: { current: number; total: number };
}
export interface SelectionAnchor { x: number; y: number; bottom?: number }
export interface ReaderSelection extends SelectionAnchor {
  locator: string;
  quote: string;
  chapter: string;
}
export interface ReaderInfo {
  title: string;
  author: string;
  layout?: "reflowable" | "fixed";
  canTranslate?: boolean;
  toc: { label: string; href: string; depth: number }[];
}

export interface ReaderMark {
  locator: string;
  isHighlighted: boolean;
  color?: ReaderHighlightColor;
}

export type ReaderCommand =
  | { type: "open"; bytes: Uint8Array; initialLocator?: string | null; appearance: ReaderAppearance; highlights: ReaderMark[]; translation?: ReaderTranslationMode; translationRevision?: number }
  | { type: "translation"; mode: ReaderTranslationMode; revision: number }
  | { type: "translationResult"; id: number; values: string[] }
  | { type: "retryTranslation" }
  | { type: "appearance"; value: ReaderAppearance }
  | { type: "highlights"; values: ReaderMark[] }
  | { type: "goTo"; locator: string }
  | { type: "goToFraction"; fraction: number }
  | { type: "clearSelection" | "prev" | "next" };

export type ReaderEvent =
  | { type: "translate"; id: number; target: ReaderTranslationTarget; mode: ReaderTranslationMode; revision: number; texts: string[] }
  | { type: "cancelTranslation"; id: number }
  | { type: "ready"; info: ReaderInfo }
  | { type: "location"; location: ReaderLocation }
  | { type: "selection"; selection: ReaderSelection | null }
  | { type: "footnote"; text: string; anchor: SelectionAnchor }
  | { type: "escape" }
  | { type: "error"; message: string };
