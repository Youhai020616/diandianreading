import { READER_HIGHLIGHT_COLORS, isReaderHighlightColor, type ReaderHighlightColor } from "../../electron/storage/highlightColors";

export type { ReaderHighlightColor };

/** Reading themes: each palette has a day and a night variant; the mode picks one. */
export type ReaderThemeId = "default" | "sepia" | "gray" | "grass" | "sky" | "cherry" | "solarized" | "nord" | "contrast";
export type ReaderThemeMode = "auto" | "light" | "dark";
export type ReaderTexture = "none" | "fine" | "rough";

export interface ReaderColors {
  dark: boolean;
  paper: string;
  ink: string;
  muted: string;
  line: string;
  panel: string;
  soft: string;
  accent: string;
}

type Palette = Omit<ReaderColors, "dark">;

function variant(light: Palette, dark: Palette) {
  return { light: { ...light, dark: false }, dark: { ...dark, dark: true } };
}

export const READER_THEMES: Record<ReaderThemeId, { label: string; light: ReaderColors; dark: ReaderColors }> = {
  default: { label: "白纸", ...variant(
    { paper: "#ffffff", ink: "#252730", muted: "#657081", line: "#e2e5eb", panel: "#ffffff", soft: "#f1f4f9", accent: "#2c5aa8" },
    { paper: "#1e2025", ink: "#dedfe3", muted: "#9a9ea8", line: "#3a3d44", panel: "#272a30", soft: "#33363d", accent: "#a8c7ff" },
  ) },
  sepia: { label: "暖纸", ...variant(
    { paper: "#faf7f0", ink: "#302d28", muted: "#736c60", line: "#dfd9ce", panel: "#fffdf8", soft: "#f2eee5", accent: "#2c5aa8" },
    { paper: "#29251f", ink: "#e6dccb", muted: "#b3a893", line: "#463f35", panel: "#332e27", soft: "#3d372f", accent: "#e2bd7a" },
  ) },
  gray: { label: "浅灰", ...variant(
    { paper: "#e9e9e7", ink: "#2a2a2a", muted: "#6b6b6b", line: "#d2d2cf", panel: "#f3f3f1", soft: "#dcdcda", accent: "#3b5f99" },
    { paper: "#2a2b2d", ink: "#d8d8d8", muted: "#9b9b9b", line: "#424346", panel: "#333437", soft: "#3d3e41", accent: "#a8c0e8" },
  ) },
  grass: { label: "青草", ...variant(
    { paper: "#e2e9d6", ink: "#2c3a24", muted: "#5f6e54", line: "#c9d3ba", panel: "#eef3e6", soft: "#d5dec6", accent: "#3f6b2f" },
    { paper: "#1f261c", ink: "#d3dcc6", muted: "#9aa78c", line: "#39432f", panel: "#283124", soft: "#323c2c", accent: "#a6cf8a" },
  ) },
  sky: { label: "天青", ...variant(
    { paper: "#e0e9f5", ink: "#1f2f47", muted: "#566780", line: "#c6d3e6", panel: "#edf3fa", soft: "#d2deef", accent: "#2b5ea7" },
    { paper: "#1b2230", ink: "#cfdbec", muted: "#8e9cb3", line: "#313b4d", panel: "#232c3c", soft: "#2c3648", accent: "#93b8ef" },
  ) },
  cherry: { label: "樱粉", ...variant(
    { paper: "#f4e6e6", ink: "#47282b", muted: "#85646a", line: "#e2cdcf", panel: "#faefef", soft: "#ebd8d9", accent: "#a23d55" },
    { paper: "#2a1f21", ink: "#ecd6d8", muted: "#b39498", line: "#46363a", panel: "#33272a", soft: "#3d3033", accent: "#f0a3b4" },
  ) },
  solarized: { label: "Solarized", ...variant(
    { paper: "#fdf6e3", ink: "#4a5d64", muted: "#7f8f8f", line: "#e6dfc8", panel: "#fffbef", soft: "#eee8d5", accent: "#268bd2" },
    { paper: "#002b36", ink: "#a7b6b8", muted: "#6d8389", line: "#0f3d49", panel: "#073642", soft: "#0d4250", accent: "#6cb4e8" },
  ) },
  nord: { label: "Nord", ...variant(
    { paper: "#eceff4", ink: "#2e3440", muted: "#4c566a", line: "#d8dee9", panel: "#f4f6f9", soft: "#e5e9f0", accent: "#5e81ac" },
    { paper: "#2e3440", ink: "#d8dee9", muted: "#8f9bb0", line: "#434c5e", panel: "#3b4252", soft: "#434c5e", accent: "#88c0d0" },
  ) },
  contrast: { label: "高对比", ...variant(
    { paper: "#ffffff", ink: "#000000", muted: "#333333", line: "#8a8a8a", panel: "#ffffff", soft: "#ececec", accent: "#0033cc" },
    { paper: "#000000", ink: "#ffffff", muted: "#cccccc", line: "#7a7a7a", panel: "#111111", soft: "#222222", accent: "#8fb4ff" },
  ) },
};

export const READER_THEME_IDS = Object.keys(READER_THEMES) as ReaderThemeId[];

export function isReaderThemeId(value: unknown): value is ReaderThemeId {
  return typeof value === "string" && value in READER_THEMES;
}

export function resolveReaderColors(theme: ReaderThemeId, mode: ReaderThemeMode, appDark: boolean): ReaderColors {
  const dark = mode === "dark" || (mode === "auto" && appDark);
  return READER_THEMES[theme][dark ? "dark" : "light"];
}

export const READER_TEXTURES: Record<ReaderTexture, string> = { none: "无", fine: "细纸纹", rough: "粗纸纹" };

/** Seamless paper grain generated in SVG, so no image assets are bundled. */
export function readerTextureImage(texture: ReaderTexture, dark: boolean): string | null {
  if (texture === "none") return null;
  // Tuned against warm paper and Nord night: visible up close, quiet at reading distance.
  const [frequency, gain, offset] = texture === "fine" ? [0.85, 0.12, -0.02] : [0.42, 0.16, -0.045];
  const tone = dark ? 1 : 0;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220"><filter id="g">`
    + `<feTurbulence type="fractalNoise" baseFrequency="${frequency}" numOctaves="3" stitchTiles="stitch"/>`
    + `<feColorMatrix values="0 0 0 0 ${tone} 0 0 0 0 ${tone} 0 0 0 0 ${tone} 0 0 0 ${gain} ${offset}"/>`
    + `</filter><rect width="100%" height="100%" filter="url(#g)"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export const HIGHLIGHT_COLORS: Record<ReaderHighlightColor, { label: string; hex: string }> = {
  yellow: { label: "黄色", hex: "#f2c94c" },
  red: { label: "红色", hex: "#eb6f6f" },
  green: { label: "绿色", hex: "#5fcf8a" },
  blue: { label: "蓝色", hex: "#6ea8fe" },
  violet: { label: "紫色", hex: "#b28df5" },
};

export const HIGHLIGHT_COLOR_IDS = READER_HIGHLIGHT_COLORS;
export const isHighlightColor = isReaderHighlightColor;
