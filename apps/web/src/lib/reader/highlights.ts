/**
 * Split a rendered text segment into pieces so overlapping highlights can be
 * drawn as flat <mark> runs. When several highlights cover the same interval,
 * the one created last wins the visual layer (ADR-0007 has no z-order rule;
 * "later covers earlier" is the agreed R3 behaviour).
 */
export interface HighlightSpan {
  id: string;
  /** UTF-16 offsets into the document source. */
  startU16: number;
  endU16: number;
  color: string;
  /** Milliseconds since epoch; later wins. Ties break on larger id. */
  createdAtMs: number;
}

export interface TextPiece {
  startU16: number;
  endU16: number;
  /** Topmost highlight covering the piece, or null for plain text. */
  top: HighlightSpan | null;
  /** Every highlight id covering the piece (for hit metadata). */
  ids: string[];
}

function winner(a: HighlightSpan, b: HighlightSpan): HighlightSpan {
  if (a.createdAtMs !== b.createdAtMs) {
    return a.createdAtMs > b.createdAtMs ? a : b;
  }
  return a.id > b.id ? a : b;
}

/**
 * Partition `[segmentStart, segmentEnd)` at every highlight boundary and
 * label each piece with the covering highlights. Pieces are returned in
 * document order and tile the segment exactly.
 */
export function segmentText(
  segmentStart: number,
  segmentEnd: number,
  highlights: readonly HighlightSpan[],
): TextPiece[] {
  if (segmentEnd <= segmentStart) {
    return [];
  }
  const overlapping = highlights.filter(
    (span) => span.endU16 > segmentStart && span.startU16 < segmentEnd && span.endU16 > span.startU16,
  );
  if (overlapping.length === 0) {
    return [{ startU16: segmentStart, endU16: segmentEnd, top: null, ids: [] }];
  }

  const boundaries = new Set<number>([segmentStart, segmentEnd]);
  for (const span of overlapping) {
    boundaries.add(Math.max(segmentStart, span.startU16));
    boundaries.add(Math.min(segmentEnd, span.endU16));
  }
  const sorted = Array.from(boundaries).sort((left, right) => left - right);

  const pieces: TextPiece[] = [];
  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const start = sorted[index] as number;
    const end = sorted[index + 1] as number;
    if (end <= start) {
      continue;
    }
    const covering = overlapping.filter((span) => span.startU16 <= start && span.endU16 >= end);
    let top: HighlightSpan | null = null;
    for (const span of covering) {
      top = top === null ? span : winner(top, span);
    }
    pieces.push({
      startU16: start,
      endU16: end,
      top,
      ids: covering.map((span) => span.id).sort(),
    });
  }
  return pieces;
}
