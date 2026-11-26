/** Share cards, carousels, posters and concept visuals. */

export type CardTemplateId =
  | "editorial-paper"
  | "swiss-grid"
  | "nocturne-ink"
  | "botanical-green"
  | "magazine-glass";

export type ConceptVisualLayout = "cover" | "mindmap" | "infographic";

export type ConceptVisualTheme =
  | "editorial-paper"
  | "memo-grid"
  | "botanical-mist"
  | "nocturne-ink"
  | "cloud-blue";

export interface ConceptBranch {
  heading: string;
  points: string[];
}

export interface ConceptVisualPayload {
  layout: ConceptVisualLayout;
  theme: ConceptVisualTheme;
  title: string;
  subtitle: string;
  callout?: string;
  branches: ConceptBranch[];
  showColophon?: boolean;
}

export interface CardTemplateMeta {
  id: CardTemplateId;
  name: string;
  subtitle: string;
  aspect: "3:4";
  width: number;
  height: number;
  swatchBg: string;
  swatchAccent: string;
}

export interface ReadingCardPayload {
  templateId: CardTemplateId;
  quote: string;
  comment: string;
  bookTitle: string;
  author: string;
  tag: string;
  dateLabel?: string;
}

export type CarouselSlideKind = "cover" | "body" | "outro";

export interface CarouselSlide {
  id: string;
  kind: CarouselSlideKind;
  heading: string;
  body: string;
  accentNote?: string;
}

export interface CarouselDeckPayload {
  templateId: CardTemplateId;
  bookTitle: string;
  author: string;
  tag: string;
  slides: CarouselSlide[];
}

export type PosterThemeId = "editorial-paper" | "nocturne-ink" | "botanical-green";

export interface MonthlyPosterPayload {
  themeId: PosterThemeId;
  monthLabel: string;
  headline: string;
  booksCount: number;
  highlightsCount: number;
  draftsCount: number;
  books: Array<{ title: string; author: string }>;
  quotes: Array<{ quote: string; bookTitle: string }>;
  keywords: string[];
  showWatermark?: boolean;
}
