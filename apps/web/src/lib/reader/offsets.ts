/**
 * Unicode codepoint <-> UTF-16 code unit offset conversion for one document.
 *
 * The R1/R2 anchor contract (ADR-0007 §2) addresses the normalized markdown
 * as *codepoint* intervals `[start, end)` — the same indexing Python uses.
 * JavaScript strings are UTF-16, so every supplementary character (emoji,
 * rare CJK, etc.) occupies two code units but one codepoint. This map records
 * the UTF-16 index of every surrogate pair once and converts in O(log n).
 */
export class OffsetMap {
  /** UTF-16 indices of the leading surrogate of each surrogate pair, ascending. */
  private readonly pairStarts: number[];
  readonly u16Length: number;

  constructor(text: string) {
    const pairStarts: number[] = [];
    for (let index = 0; index < text.length; index += 1) {
      const unit = text.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          pairStarts.push(index);
          index += 1;
        }
      }
    }
    this.pairStarts = pairStarts;
    this.u16Length = text.length;
  }

  get cpLength(): number {
    return this.u16Length - this.pairStarts.length;
  }

  /** Number of surrogate pairs that start strictly before the UTF-16 index. */
  private pairsBeforeU16(u16: number): number {
    let low = 0;
    let high = this.pairStarts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.pairStarts[middle] as number) < u16) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  /** Codepoint offset for a UTF-16 index (clamped to the document bounds). */
  cpFromU16(u16: number): number {
    const clamped = Math.max(0, Math.min(u16, this.u16Length));
    return clamped - this.pairsBeforeU16(clamped);
  }

  /** UTF-16 index for a codepoint offset (clamped to the document bounds). */
  u16FromCp(cp: number): number {
    const clamped = Math.max(0, Math.min(cp, this.cpLength));
    // Pair k (0-based) sits at codepoint index pairStarts[k] - k. Count how
    // many pairs have a codepoint index < clamped via binary search.
    let low = 0;
    let high = this.pairStarts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.pairStarts[middle] as number) - middle < clamped) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return clamped + low;
  }
}
