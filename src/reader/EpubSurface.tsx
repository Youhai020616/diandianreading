import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { ReaderAppearance, ReaderCommand, ReaderEvent, ReaderInfo, ReaderLocation, ReaderMark, ReaderSelection, ReaderTranslationMode, ReaderTranslationTarget, SelectionAnchor } from "./types";

export interface EpubSurfaceHandle {
  prev(): void;
  next(): void;
  goTo(locator: string): void;
  goToFraction(fraction: number): void;
  clearSelection(): void;
  retryTranslation(): void;
}
interface EpubSurfaceProps {
  bytes: Uint8Array;
  initialLocator?: string | null;
  appearance: ReaderAppearance;
  highlights: ReaderMark[];
  translation?: ReaderTranslationMode;
  translationRevision?: number;
  onTranslate?(texts: string[], target: ReaderTranslationTarget, signal: AbortSignal): Promise<string[]>;
  onTranslationError?(message: string): void;
  onReady(info: ReaderInfo): void;
  onRelocate(location: ReaderLocation): void;
  onSelection(selection: ReaderSelection | null): void;
  onFootnote(text: string, anchor?: SelectionAnchor): void;
  onEscape?(): void;
  onError(message: string): void;
}

export const EpubSurface = forwardRef<EpubSurfaceHandle, EpubSurfaceProps>(function EpubSurface(props, ref) {
  const container = useRef<HTMLDivElement>(null);
  const port = useRef<MessagePort | null>(null);
  const activeRequest = useRef<{ id: number; controller: AbortController } | null>(null);
  const latest = useRef(props);
  latest.current = props;

  function send(command: ReaderCommand) { port.current?.postMessage(command); }
  useImperativeHandle(ref, () => ({
    prev: () => send({ type: "prev" }),
    next: () => send({ type: "next" }),
    goTo: locator => send({ type: "goTo", locator }),
    goToFraction: fraction => send({ type: "goToFraction", fraction }),
    clearSelection: () => send({ type: "clearSelection" }),
    retryTranslation: () => send({ type: "retryTranslation" }),
  }), []);

  useEffect(() => {
    const frame = document.createElement("iframe");
    frame.title = "电子书正文";
    frame.setAttribute("sandbox", "allow-same-origin allow-scripts");
    Object.assign(frame.style, { display: "block", width: "100%", height: "100%", border: "0" });
    frame.src = new URL("./src/reader/frame.html", document.baseURI).href;
    const channel = new MessageChannel();
    channel.port1.onmessage = (event: MessageEvent<ReaderEvent>) => {
      const result = event.data;
      const p = latest.current;
      const rect = frame.getBoundingClientRect();
      switch (result.type) {
        case "translate": {
          if (!p.onTranslate || !p.translation || p.translation === "off" || p.translation !== result.mode
            || (p.translationRevision ?? 0) !== result.revision) break;
          activeRequest.current?.controller.abort();
          const controller = new AbortController();
          activeRequest.current = { id: result.id, controller };
          const current = () => !controller.signal.aborted && latest.current.translation === result.mode
            && (latest.current.translationRevision ?? 0) === result.revision;
          void Promise.resolve().then(() => p.onTranslate!(result.texts, result.target, controller.signal)).then(values => {
            if (current()) channel.port1.postMessage({ type: "translationResult", id: result.id, values } satisfies ReaderCommand);
          }).catch((error: unknown) => {
            if (!current()) return;
            channel.port1.postMessage({ type: "translationResult", id: result.id, values: [] } satisfies ReaderCommand);
            latest.current.onTranslationError?.(error instanceof Error ? error.message : "翻译暂时不可用，请稍后重试。");
          }).finally(() => {
            if (activeRequest.current?.controller === controller) activeRequest.current = null;
          });
          break;
        }
        case "cancelTranslation":
          if (activeRequest.current?.id === result.id) activeRequest.current.controller.abort();
          break;
        case "ready": p.onReady(result.info); break;
        case "error": p.onError(result.message); break;
        case "location": p.onRelocate(result.location); break;
        case "selection": {
          const s = result.selection;
          p.onSelection(s && { ...s, x: rect.left + s.x, y: rect.top + s.y });
          break;
        }
        case "footnote": p.onFootnote(result.text, { x: rect.left + result.anchor.x, y: rect.top + result.anchor.y }); break;
        case "escape": p.onEscape?.(); break;
      }
    };
    frame.addEventListener("load", () => {
      if (!frame.isConnected) return;
      port.current = channel.port1;
      frame.contentWindow?.postMessage("diandian:init-epub", "*", [channel.port2]);
      const { bytes, initialLocator, appearance, highlights, translation, translationRevision } = latest.current;
      send({ type: "open", bytes, initialLocator, appearance, highlights, translation, translationRevision });
    }, { once: true });
    container.current?.append(frame);
    return () => {
      activeRequest.current?.controller.abort();
      port.current = null;
      channel.port1.close();
      channel.port2.close();
      frame.remove();
    };
  }, [props.bytes]);

  useEffect(() => {
    activeRequest.current?.controller.abort();
    send({ type: "translation", mode: props.translation ?? "off", revision: props.translationRevision ?? 0 });
  }, [props.translation, props.translationRevision]);
  useEffect(() => send({ type: "appearance", value: props.appearance }), [props.appearance]);
  useEffect(() => send({ type: "highlights", values: props.highlights }), [props.highlights]);
  return <div className="epub-surface" ref={container} style={{ flex: 1, minHeight: 0, minWidth: 0, width: "100%", height: "100%" }} />;
});
