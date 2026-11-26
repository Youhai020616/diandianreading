/** Desktop pet and app-level events. */

export type PetWindowMode = "collapsed" | "nudge" | "expanded";

export interface PetWindowState {
  visible: boolean;
  expanded: boolean;
  mode: PetWindowMode;
  showJumpToMain?: boolean;
}

export interface AppQuickActionEvent {
  kind: "saved" | "draft" | "ask";
  text: string;
  title: string;
  comment?: string;
  author?: string;
  url?: string;
  deduplicated?: boolean;
}

export interface AppMenuActionEvent {
  action: "preferences" | "new-book" | "import-notes" | "sync-obsidian" | "open-downloads";
}

export interface PetQuickQuoteEvent {
  text: string;
  title: string;
  url?: string;
  source: "selection" | "shortcut";
}
