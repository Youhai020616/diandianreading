import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export interface PaneDragStart {
  x: number;
  width: number;
  pointerId: number;
}

/** Called for each pointer move; call `end` to stop the drag (e.g. when the pane collapses). */
type PaneDragMove = (clientX: number, start: PaneDragStart, end: () => void) => void;

/**
 * Drag a pane edge. Window-level listeners keep the drag from getting stuck when the pointer
 * crosses the native browser view, which swallows pointer events.
 */
export function usePaneDrag(onMove: PaneDragMove, { endWhenHidden = false } = {}) {
  const start = useRef<PaneDragStart | null>(null);
  const handle = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const move = useRef(onMove);
  move.current = onMove;

  const end = useCallback(() => {
    const current = start.current;
    const el = handle.current;
    if (current && el && el.hasPointerCapture(current.pointerId)) {
      try {
        el.releasePointerCapture(current.pointerId);
      } catch {
        // The pointer was already released.
      }
    }
    start.current = null;
    setDragging(false);
    document.body.classList.remove("is-dragging-split");
  }, []);

  const handleMove = useCallback((clientX: number, buttons: number) => {
    const current = start.current;
    if (!current) return;
    if ((buttons & 1) === 0) {
      end();
      return;
    }
    move.current(clientX, current, end);
  }, [end]);

  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add("is-dragging-split");
    const onPointerMove = (e: PointerEvent) => handleMove(e.clientX, e.buttons);
    const onMouseMove = (e: MouseEvent) => handleMove(e.clientX, e.buttons);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") end();
    };
    const onVisibility = () => {
      if (document.hidden) end();
    };
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("mouseup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("blur", end);
    window.addEventListener("keydown", onKeyDown);
    if (endWhenHidden) document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.body.classList.remove("is-dragging-split");
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("mouseup", end, true);
      window.removeEventListener("pointercancel", end, true);
      window.removeEventListener("blur", end);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [dragging, end, handleMove, endWhenHidden]);

  /** Props for the drag handle element; `width` is the pane width when the drag starts. */
  const handleProps = (width: number) => ({
    ref: handle,
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Pointer capture is unavailable; window listeners still track the drag.
      }
      start.current = { x: e.clientX, width, pointerId: e.pointerId };
      setDragging(true);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (start.current) handleMove(e.clientX, e.buttons);
    },
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
  });

  return { dragging, handleProps };
}
