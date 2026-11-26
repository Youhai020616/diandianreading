import { useEffect, useRef, useState } from "react";
import { translationTarget } from "../reader/bilingual";
import type { ReaderInfo, ReaderTranslationMode, ReaderTranslationTarget } from "../reader/types";

interface ReaderContentsProps {
  toc: ReaderInfo["toc"];
  chapter?: string;
  mode: ReaderTranslationMode;
  translate(texts: string[], target: ReaderTranslationTarget, signal: AbortSignal): Promise<string[]>;
  onNavigate(href: string): void;
}

export function ReaderContents({ toc, chapter, mode, translate, onNavigate }: ReaderContentsProps) {
  const list = useRef<HTMLDivElement>(null);
  const [captions, setCaptions] = useState<Map<string, string>>(() => new Map());

  useEffect(() => {
    const container = list.current;
    if (mode === "off" || !container) return;
    const controller = new AbortController();
    const visible = new Set<number>();
    const attempted = new Set<string>();
    let busy = false;
    async function fillVisible() {
      if (busy || controller.signal.aborted) return;
      busy = true;
      try {
        while (!controller.signal.aborted) {
          const texts: string[] = [];
          let batchTarget: ReaderTranslationTarget | null = null;
          let length = 0;
          for (const index of visible) {
            const label = toc[index]?.label.trim();
            if (!label || attempted.has(label) || label.length > 9000) continue;
            const target = translationTarget(label, mode);
            if (!target || (batchTarget && batchTarget !== target)) continue;
            if (texts.length === 12 || length + label.length > 9000) break;
            batchTarget = target;
            attempted.add(label);
            texts.push(label);
            length += label.length;
          }
          if (!batchTarget) break;
          const values = await translate(texts, batchTarget, controller.signal);
          if (controller.signal.aborted) break;
          setCaptions(current => {
            const next = new Map(current);
            texts.forEach((label, i) => { if (values[i]) next.set(label, values[i]!); });
            return next;
          });
        }
      } catch {
        // The shared translation callback displays service errors in the reader.
      } finally {
        busy = false;
      }
    }
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const index = Number((entry.target as HTMLElement).dataset.index);
        if (entry.isIntersecting) visible.add(index);
        else visible.delete(index);
      }
      void fillVisible();
    }, { root: container.parentElement, rootMargin: "40px 0px" });
    for (const button of container.children) observer.observe(button);
    return () => { controller.abort(); observer.disconnect(); };
  }, [mode, toc, translate]);

  if (!toc.length) return <p className="lr-muted">这本书没有目录。</p>;
  return <div ref={list}>{toc.map((item, index) => {
    const caption = captions.get(item.label.trim());
    return <button type="button" className="lr-toc-item" key={index} data-index={index}
      style={{ paddingInlineStart: 12 + Math.min(item.depth, 4) * 13 }}
      aria-current={item.label === chapter ? "location" : undefined} onClick={() => onNavigate(item.href)}>
      {item.label}
      {caption && <small lang={translationTarget(item.label, mode) || undefined}>{caption}</small>}
    </button>;
  })}</div>;
}
