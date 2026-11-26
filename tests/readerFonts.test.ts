import { expect, it } from "vitest";
import { normalizeReaderFont, readerFontStyles } from "../src/reader/fonts";

it("opens older and unrecognized reader preferences with the existing serif family", () => {
  for (const stored of [undefined, null, "system", "__proto__", { family: "sans" }]) {
    expect(normalizeReaderFont(stored)).toBe("serif");
  }
  expect(readerFontStyles(undefined)).toBe(readerFontStyles("serif"));
});

it("only custom fonts issue a font override, so selecting publisher restores the book stylesheet", () => {
  for (const family of ["serif", "sans", "kai", "publisher"] as const) {
    expect(normalizeReaderFont(family)).toBe(family);
  }
  expect(readerFontStyles("publisher")).toBe("");
  expect(readerFontStyles("sans")).toContain("sans-serif");
  expect(readerFontStyles("kai")).toContain("KaiTi");
});
