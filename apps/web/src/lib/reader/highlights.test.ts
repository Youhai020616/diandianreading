import { describe, expect, it } from "vitest";
import { segmentText, type HighlightSpan } from "./highlights";

function span(
  id: string,
  startU16: number,
  endU16: number,
  createdAtMs: number,
  color = "yellow",
): HighlightSpan {
  return { id, startU16, endU16, color, createdAtMs };
}

describe("segmentText", () => {
  it("returns a single plain piece when nothing overlaps", () => {
    const pieces = segmentText(10, 20, [span("a", 30, 40, 1)]);
    expect(pieces).toEqual([{ startU16: 10, endU16: 20, top: null, ids: [] }]);
  });

  it("splits at highlight boundaries and tiles the segment exactly", () => {
    const highlight = span("a", 12, 16, 1);
    const pieces = segmentText(10, 20, [highlight]);
    expect(pieces.map((piece) => [piece.startU16, piece.endU16])).toEqual([
      [10, 12],
      [12, 16],
      [16, 20],
    ]);
    expect(pieces[0]?.top).toBeNull();
    expect(pieces[1]?.top?.id).toBe("a");
    expect(pieces[2]?.top).toBeNull();
  });

  it("gives the later-created highlight the visual layer in overlaps", () => {
    const older = span("older", 0, 10, 1000, "yellow");
    const newer = span("newer", 5, 15, 2000, "blue");
    const pieces = segmentText(0, 20, [older, newer]);
    expect(pieces.map((piece) => [piece.startU16, piece.endU16, piece.top?.id ?? null])).toEqual([
      [0, 5, "older"],
      [5, 10, "newer"],
      [10, 15, "newer"],
      [15, 20, null],
    ]);
    // The overlap piece still records both covering ids.
    expect(pieces[1]?.ids).toEqual(["newer", "older"]);
  });

  it("breaks creation-time ties on the larger id", () => {
    const pieces = segmentText(0, 4, [span("a", 0, 4, 7), span("b", 0, 4, 7)]);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]?.top?.id).toBe("b");
  });

  it("clips highlights that extend beyond the segment", () => {
    const pieces = segmentText(10, 20, [span("a", 0, 40, 1)]);
    expect(pieces).toEqual([
      { startU16: 10, endU16: 20, top: span("a", 0, 40, 1), ids: ["a"] },
    ]);
  });

  it("ignores empty ranges and returns nothing for empty segments", () => {
    expect(segmentText(5, 5, [span("a", 0, 9, 1)])).toEqual([]);
    const pieces = segmentText(0, 10, [span("empty", 4, 4, 1)]);
    expect(pieces).toEqual([{ startU16: 0, endU16: 10, top: null, ids: [] }]);
  });
});
