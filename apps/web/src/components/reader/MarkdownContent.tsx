/**
 * Renders the parsed markdown subset. Security invariants:
 * - all book text goes through React text nodes (never dangerouslySetInnerHTML);
 * - links are non-navigable spans; the URL is displayed via CSS from a data
 *   attribute, so it is never part of the selectable text;
 * - every rendered text node sits in an element carrying `data-su` (UTF-16
 *   source offset) and every block carries `data-start`/`data-end`
 *   (codepoint offsets of the anchor contract).
 */
import { Fragment, type ReactElement, type ReactNode } from "react";
import { segmentText, type HighlightSpan } from "../../lib/reader/highlights";
import type {
  BlockNode,
  InlineNode,
  ListItemNode,
  MarkdownDocument,
} from "../../lib/reader/markdown";

export interface MarkdownContentProps {
  doc: MarkdownDocument;
  highlights: HighlightSpan[];
  activeAnnotationId: string | null;
  onMarkClick: (annotationId: string) => void;
}

interface RenderContext {
  doc: MarkdownDocument;
  highlights: HighlightSpan[];
  activeAnnotationId: string | null;
  onMarkClick: (annotationId: string) => void;
}

function renderTextRange(context: RenderContext, startU16: number, endU16: number): ReactNode[] {
  const { doc } = context;
  const pieces = segmentText(startU16, endU16, context.highlights);
  return pieces.map((piece) => {
    const text = doc.source.slice(piece.startU16, piece.endU16);
    if (piece.top === null) {
      return (
        <span data-su={piece.startU16} key={piece.startU16}>
          {text}
        </span>
      );
    }
    const active = piece.top.id === context.activeAnnotationId;
    const annotationId = piece.top.id;
    return (
      <mark
        className={`reader-mark hl-${piece.top.color}${active ? " is-active" : ""}`}
        data-su={piece.startU16}
        data-annotation-id={annotationId}
        key={piece.startU16}
        onClick={(event) => {
          event.stopPropagation();
          context.onMarkClick(annotationId);
        }}
      >
        {text}
      </mark>
    );
  });
}

function renderInline(context: RenderContext, nodes: InlineNode[]): ReactNode[] {
  return nodes.map((node) => {
    if (node.kind === "text") {
      return <Fragment key={node.start}>{renderTextRange(context, node.start, node.end)}</Fragment>;
    }
    if (node.kind === "inline_code") {
      return (
        <code className="md-inline-code" key={node.start}>
          {renderTextRange(context, node.contentStart, node.contentEnd)}
        </code>
      );
    }
    if (node.kind === "link") {
      return (
        <span className="md-link" data-url={node.url} key={node.start}>
          {renderInline(context, node.children)}
        </span>
      );
    }
    if (node.kind === "strong") {
      return <strong key={node.start}>{renderInline(context, node.children)}</strong>;
    }
    return <em key={node.start}>{renderInline(context, node.children)}</em>;
  });
}

const HEADING_TAGS = ["h2", "h3", "h4", "h5", "h6", "h6"] as const;

function blockDataAttributes(
  context: RenderContext,
  block: { start: number; end: number },
): { "data-start": number; "data-end": number } {
  return {
    "data-start": context.doc.map.cpFromU16(block.start),
    "data-end": context.doc.map.cpFromU16(block.end),
  };
}

function renderListItem(context: RenderContext, item: ListItemNode): ReactElement {
  return (
    <li
      data-start={context.doc.map.cpFromU16(item.start)}
      data-end={context.doc.map.cpFromU16(item.end)}
      key={item.start}
    >
      {renderInline(context, item.children)}
    </li>
  );
}

function renderBlock(context: RenderContext, block: BlockNode): ReactElement {
  const attributes = blockDataAttributes(context, block);
  if (block.kind === "heading") {
    const Tag = HEADING_TAGS[Math.min(block.level - 1, HEADING_TAGS.length - 1)] as
      | "h2"
      | "h3"
      | "h4"
      | "h5"
      | "h6";
    return (
      <Tag
        className="md-block md-heading"
        data-level={block.level}
        {...attributes}
        key={block.start}
      >
        {renderInline(context, block.children)}
      </Tag>
    );
  }
  if (block.kind === "paragraph") {
    return (
      <p className="md-block md-paragraph" {...attributes} key={block.start}>
        {renderInline(context, block.children)}
      </p>
    );
  }
  if (block.kind === "list") {
    const items = block.items.map((item) => renderListItem(context, item));
    return block.ordered ? (
      <ol className="md-block md-list" {...attributes} key={block.start}>
        {items}
      </ol>
    ) : (
      <ul className="md-block md-list" {...attributes} key={block.start}>
        {items}
      </ul>
    );
  }
  if (block.kind === "quote") {
    return (
      <blockquote className="md-block md-quote" {...attributes} key={block.start}>
        {block.lines.map((line, index) => (
          <p className="md-quote-line" key={line.start === line.end ? `e${index}` : line.start}>
            {renderInline(context, line.children)}
          </p>
        ))}
      </blockquote>
    );
  }
  return (
    <pre
      className="md-block md-code-block"
      {...attributes}
      data-language={block.language}
      key={block.start}
    >
      <code>
        {block.contentEnd > block.contentStart
          ? renderTextRange(context, block.contentStart, block.contentEnd)
          : null}
      </code>
    </pre>
  );
}

export function MarkdownContent({
  doc,
  highlights,
  activeAnnotationId,
  onMarkClick,
}: MarkdownContentProps): ReactElement {
  const context: RenderContext = { doc, highlights, activeAnnotationId, onMarkClick };
  return <>{doc.blocks.map((block) => renderBlock(context, block))}</>;
}
