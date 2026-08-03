/**
 * DOM Selection -> source offset mapping.
 *
 * The markdown renderer wraps every rendered text node in an element carrying
 * `data-su`, the UTF-16 source offset of the node's first character; rendered
 * text is a verbatim source slice, so `data-su + offsetInTextNode` is an exact
 * UTF-16 source position. Codepoint conversion happens through the document's
 * OffsetMap at the anchor boundary.
 */
import type { MarkdownDocument } from "./markdown";

export const SOURCE_OFFSET_ATTRIBUTE = "data-su";
export const QUOTE_CONTEXT_MAX_CODEPOINTS = 64;
export const SELECTED_TEXT_MAX_CODEPOINTS = 2000;

export interface SourceRangeU16 {
  startU16: number;
  endU16: number;
}

interface DomPoint {
  container: Node;
  offset: number;
}

function mappedParentOffset(node: Node): number | null {
  const parent = node.parentElement;
  if (parent === null) {
    return null;
  }
  const raw = parent.getAttribute(SOURCE_OFFSET_ATTRIBUTE);
  if (raw === null) {
    return null;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function textNodesWithin(root: Node): Text[] {
  const nodes: Text[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      nodes.push(node as Text);
      return;
    }
    for (let child = node.firstChild; child !== null; child = child.nextSibling) {
      walk(child);
    }
  };
  walk(root);
  return nodes;
}

function documentOrderedTextNodes(root: HTMLElement): Text[] {
  return textNodesWithin(root).filter((node) => mappedParentOffset(node) !== null);
}

function resolvePoint(point: DomPoint, root: HTMLElement, edge: "start" | "end"): number | null {
  const { container, offset } = point;
  if (!root.contains(container)) {
    return null;
  }
  if (container.nodeType === 3) {
    const base = mappedParentOffset(container);
    if (base === null) {
      return null;
    }
    return base + Math.max(0, Math.min(offset, (container as Text).length));
  }
  if (container.nodeType !== 1) {
    return null;
  }
  // Element container: snap to the nearest mapped text node in the walk order.
  const element = container as Element;
  const allMapped = documentOrderedTextNodes(root);
  if (allMapped.length === 0) {
    return null;
  }
  const children = element.childNodes;
  if (edge === "start") {
    for (let index = Math.max(0, Math.min(offset, children.length)); index < children.length; index += 1) {
      const child = children.item(index);
      if (child === null) {
        continue;
      }
      const inside = textNodesWithin(child).filter((node) => mappedParentOffset(node) !== null);
      const firstInside = inside[0];
      if (firstInside !== undefined) {
        return mappedParentOffset(firstInside) as number;
      }
    }
    // Nothing after the point inside this element: use the next mapped node
    // in the whole reader, if any.
    const marker = children.item(Math.min(offset, children.length - 1)) ?? element;
    for (const candidate of allMapped) {
      const position = marker.compareDocumentPosition(candidate);
      if ((position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) {
        return mappedParentOffset(candidate) as number;
      }
    }
    return null;
  }
  for (let index = Math.min(offset, children.length) - 1; index >= 0; index -= 1) {
    const child = children.item(index);
    if (child === null) {
      continue;
    }
    const inside = textNodesWithin(child).filter((node) => mappedParentOffset(node) !== null);
    const lastInside = inside[inside.length - 1];
    if (lastInside !== undefined) {
      return (mappedParentOffset(lastInside) as number) + lastInside.length;
    }
  }
  const marker = children.item(0) ?? element;
  for (let index = allMapped.length - 1; index >= 0; index -= 1) {
    const candidate = allMapped[index] as Text;
    const position = marker.compareDocumentPosition(candidate);
    if ((position & Node.DOCUMENT_POSITION_PRECEDING) !== 0) {
      return (mappedParentOffset(candidate) as number) + candidate.length;
    }
  }
  return null;
}

export interface RangeLike {
  startContainer: Node;
  startOffset: number;
  endContainer: Node;
  endOffset: number;
  collapsed: boolean;
}

/**
 * Map a DOM Range inside the reader content to a UTF-16 source interval.
 * Returns null when the range is collapsed, escapes the reader, or touches
 * only unmapped nodes (toolbar text, decorations, …).
 */
export function rangeToSourceOffsets(range: RangeLike, root: HTMLElement): SourceRangeU16 | null {
  if (range.collapsed) {
    return null;
  }
  const start = resolvePoint(
    { container: range.startContainer, offset: range.startOffset },
    root,
    "start",
  );
  const end = resolvePoint({ container: range.endContainer, offset: range.endOffset }, root, "end");
  if (start === null || end === null || end <= start) {
    return null;
  }
  return { startU16: start, endU16: end };
}

export interface QuotePayload {
  exact: string;
  prefix: string;
  suffix: string;
}

/**
 * Build the re-anchoring quote for a source interval: exact is the verbatim
 * source slice, prefix/suffix are up to 64 *codepoints* of surrounding
 * context (ADR-0007 §2 / TextQuote invariants).
 */
export function quoteForRange(doc: MarkdownDocument, startU16: number, endU16: number): QuotePayload {
  const startCp = doc.map.cpFromU16(startU16);
  const endCp = doc.map.cpFromU16(endU16);
  const prefixStartU16 = doc.map.u16FromCp(Math.max(0, startCp - QUOTE_CONTEXT_MAX_CODEPOINTS));
  const suffixEndU16 = doc.map.u16FromCp(
    Math.min(doc.map.cpLength, endCp + QUOTE_CONTEXT_MAX_CODEPOINTS),
  );
  return {
    exact: doc.source.slice(startU16, endU16),
    prefix: doc.source.slice(prefixStartU16, startU16),
    suffix: doc.source.slice(endU16, suffixEndU16),
  };
}

/** Codepoint length of a source interval. */
export function rangeCodepointLength(doc: MarkdownDocument, startU16: number, endU16: number): number {
  return doc.map.cpFromU16(endU16) - doc.map.cpFromU16(startU16);
}
