import { translationAttribute } from "./bilingual";

export const readerFonts = {
  serif: {
    label: "宋体",
    stack: '"Songti SC", "STSong", "Noto Serif CJK SC", "SimSun", serif',
  },
  sans: {
    label: "黑体",
    stack: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Hiragino Sans GB", Arial, sans-serif',
  },
  kai: {
    label: "楷体",
    stack: '"Kaiti SC", "STKaiti", "KaiTi", "DFKai-SB", "AR PL UKai CN", "FandolKai", "Baskerville", serif',
  },
  publisher: { label: "原书字体", stack: "serif" },
} as const;

export type ReaderFontFamily = keyof typeof readerFonts;

export function normalizeReaderFont(value: unknown): ReaderFontFamily {
  if (value === "sans" || value === "kai" || value === "publisher") return value;
  return "serif";
}

const keepBookFont = ':is(pre, code, kbd, samp, tt, svg, math, [role="img"], [aria-hidden="true"], .icon, .iconfont, .material-icons, [class^="icon-"], [class*=" icon-"])';

const overrideProperty = "--diandian-reader-font-family";

export function prepareInlineFonts(doc: Document): void {
  // Inline !important declarations (including a font shorthand) beat any
  // stylesheet. Keep their original family as the fallback in publisher mode.
  for (const element of doc.querySelectorAll<HTMLElement>("[style]")) {
    const style = element.style;
    if (style?.getPropertyPriority("font-family") !== "important" || element.closest(keepBookFont)) continue;
    const family = style.getPropertyValue("font-family");
    style.setProperty("font-family", `var(${overrideProperty}, ${family})`, "important");
  }
}

export function readerFontStyles(value: ReaderFontFamily | undefined): string {
  const font = normalizeReaderFont(value);
  if (font === "publisher") return "";
  // Layered important declarations outrank even ID-specific important rules
  // in ordinary publisher stylesheets. Change only the font family so that
  // emphasis, weight, and heading sizes can still come from the book.
  return `@layer diandian-reader-font {
    :root { ${overrideProperty}: ${readerFonts[font].stack} !important; }
    :where(body, body *):not(:where(${keepBookFont}, ${keepBookFont} *)) {
      font-family: var(${overrideProperty}) !important;
    }
    [${translationAttribute}]::after { font-family: inherit !important; }
  }`;
}
