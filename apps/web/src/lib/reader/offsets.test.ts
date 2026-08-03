import { describe, expect, it } from "vitest";
import { OffsetMap } from "./offsets";

function cpLength(text: string): number {
  return Array.from(text).length;
}

describe("OffsetMap", () => {
  it("is the identity for BMP-only text (ASCII and CJK)", () => {
    const text = "# 第一章\nplain ascii 中文混排。";
    const map = new OffsetMap(text);
    expect(map.cpLength).toBe(text.length);
    for (const index of [0, 1, 5, text.length - 1, text.length]) {
      expect(map.cpFromU16(index)).toBe(index);
      expect(map.u16FromCp(index)).toBe(index);
    }
  });

  it("counts supplementary characters as one codepoint", () => {
    const text = "a😀b𝄞c";
    const map = new OffsetMap(text);
    expect(text.length).toBe(7);
    expect(map.cpLength).toBe(5);
    // "a" | 😀 | "b" | 𝄞 | "c"  at utf16 0,1,3,4,6 and cp 0,1,2,3,4.
    expect(map.cpFromU16(0)).toBe(0);
    expect(map.cpFromU16(1)).toBe(1);
    expect(map.cpFromU16(3)).toBe(2);
    expect(map.cpFromU16(4)).toBe(3);
    expect(map.cpFromU16(6)).toBe(4);
    expect(map.cpFromU16(7)).toBe(5);
    expect(map.u16FromCp(0)).toBe(0);
    expect(map.u16FromCp(1)).toBe(1);
    expect(map.u16FromCp(2)).toBe(3);
    expect(map.u16FromCp(3)).toBe(4);
    expect(map.u16FromCp(4)).toBe(6);
    expect(map.u16FromCp(5)).toBe(7);
  });

  it("round-trips every codepoint boundary in mixed text", () => {
    const text = "序😀言 emoji 🇨🇳 与 𝕏 符号 combining é́ done";
    const map = new OffsetMap(text);
    expect(map.cpLength).toBe(cpLength(text));
    let u16 = 0;
    let cp = 0;
    for (const character of text) {
      expect(map.cpFromU16(u16)).toBe(cp);
      expect(map.u16FromCp(cp)).toBe(u16);
      u16 += character.length;
      cp += 1;
    }
    expect(map.cpFromU16(u16)).toBe(cp);
    expect(map.u16FromCp(cp)).toBe(u16);
  });

  it("clamps out-of-range inputs to the document bounds", () => {
    const map = new OffsetMap("ab😀");
    expect(map.cpFromU16(-5)).toBe(0);
    expect(map.cpFromU16(99)).toBe(3);
    expect(map.u16FromCp(-1)).toBe(0);
    expect(map.u16FromCp(99)).toBe(4);
  });
});
