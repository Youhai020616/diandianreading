import { useEffect, useState } from "react";
import {
  clampLeftWidth, DEFAULT_AI_WIDTH, DEFAULT_RAIL_WIDTH, MAX_AI_WIDTH, MAX_RAIL_WIDTH, MIN_AI_WIDTH, MIN_BROWSER_WIDTH,
  MIN_BROWSER_WIDTH_TRIPLE, MIN_LEFT_WIDTH, MIN_LEFT_WIDTH_TRIPLE, MIN_RAIL_WIDTH, SPLIT_HANDLE_WIDTH,
} from "../app/workspace";
import { usePaneDrag } from "./usePaneDrag";

/** Which panes are open, their widths, and the drag handles between them. */
export function useWorkspaceLayout() {
  const [railOpen, setRailOpen] = useState(true);
  const [railWidth, setRailWidth] = useState(DEFAULT_RAIL_WIDTH);
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [browserOpen, setBrowserOpen] = useState(true);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiWidth, setAiWidth] = useState(DEFAULT_AI_WIDTH);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1440,
  );
  // Split width (center workspace width in px when right browser is open)
  const [leftWidth, setLeftWidth] = useState(660);

  const railDrag = usePaneDrag((clientX, start, end) => {
    const desired = start.width + (clientX - start.x);
    if (desired < 108) {
      end();
      setRailWidth(DEFAULT_RAIL_WIDTH);
      setRailOpen(false);
      return;
    }
    const maxAllowed = Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, window.innerWidth - MIN_LEFT_WIDTH - (browserOpen ? MIN_BROWSER_WIDTH : 0) - 20));
    setRailWidth(Math.max(MIN_RAIL_WIDTH, Math.min(maxAllowed, Math.round(desired))));
  });

  const splitDrag = usePaneDrag((clientX, start, end) => {
    const railW = railOpen ? railWidth : 0;
    const aiReserved = aiOpen ? aiWidth + SPLIT_HANDLE_WIDTH : 0;
    const desiredLeft = start.width + (clientX - start.x);
    if (desiredLeft < 200) {
      end();
      setWorkspaceOpen(false);
      return;
    }
    const remainingRight = window.innerWidth - railW - aiReserved - SPLIT_HANDLE_WIDTH - desiredLeft;
    if (remainingRight < 170) {
      end();
      setLeftWidth(clampLeftWidth(Math.min(start.width, 640), window.innerWidth, railOpen, railWidth, aiOpen, aiWidth));
      setBrowserOpen(false);
      setWorkspaceOpen(true);
      return;
    }
    setLeftWidth(clampLeftWidth(desiredLeft, window.innerWidth, railOpen, railWidth, aiOpen, aiWidth));
  }, { endWhenHidden: true });

  const aiDrag = usePaneDrag((clientX, start, end) => {
    const desired = start.width - (clientX - start.x);
    if (desired < 220) {
      end();
      setAiWidth(DEFAULT_AI_WIDTH);
      setAiOpen(false);
      return;
    }
    const railW = railOpen ? railWidth : 0;
    const minOther = browserOpen
      ? workspaceOpen
        ? MIN_LEFT_WIDTH_TRIPLE + MIN_BROWSER_WIDTH_TRIPLE + SPLIT_HANDLE_WIDTH
        : MIN_BROWSER_WIDTH
      : MIN_LEFT_WIDTH;
    const maxAllowed = Math.min(MAX_AI_WIDTH, Math.max(MIN_AI_WIDTH, window.innerWidth - railW - minOther - SPLIT_HANDLE_WIDTH));
    setAiWidth(Math.max(MIN_AI_WIDTH, Math.min(maxAllowed, Math.round(desired))));
  });

  // Keep split width clamped on window resize or side-panel toggles
  useEffect(() => {
    const syncClamp = () => {
      setViewportWidth(window.innerWidth);
      setLeftWidth((curr) => clampLeftWidth(curr, window.innerWidth, railOpen, railWidth, aiOpen, aiWidth));
    };
    syncClamp();
    window.addEventListener("resize", syncClamp);
    return () => window.removeEventListener("resize", syncClamp);
  }, [railOpen, railWidth, aiOpen, aiWidth]);

  const effectiveLeftWidth = clampLeftWidth(leftWidth, viewportWidth, railOpen, railWidth, aiOpen, aiWidth);
  const resetLeftWidth = () => setLeftWidth(clampLeftWidth(660, window.innerWidth, railOpen, railWidth, aiOpen, aiWidth));

  return {
    railOpen, setRailOpen, railWidth, setRailWidth,
    workspaceOpen, setWorkspaceOpen, browserOpen, setBrowserOpen,
    aiOpen, setAiOpen, aiWidth, setAiWidth,
    leftWidth, effectiveLeftWidth, resetLeftWidth,
    railDrag, splitDrag, aiDrag,
  };
}
