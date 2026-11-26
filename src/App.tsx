import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type {
  BookRecord,
  BrowserStateSnapshot,
  DraftRecord,
  NotebookItemKind,
  NotebookRecord,
  PublicModelSettings,
  SafetyMode,
} from "./types/desktop";
import { BrowserPane } from "./components/BrowserPane";
import { CookieImportModal } from "./components/CookieImportModal";
import { DiscoverView } from "./components/DiscoverView";
import type { ContextAttachment } from "./components/DockedAskBar";
import {
  IconBookOpen,
  IconChevronRight,
  IconClose,
  IconCompass,
  IconPanelLeft,
  IconPanelRight,
  IconPaw,
  IconPenLine,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSparkles,
  SiteBrandIcon,
} from "./components/Icons";
import { LeftWorkspace, type PendingPromptPayload } from "./components/LeftWorkspace";
import { LibraryView } from "./components/LibraryView";
import { NotebookView } from "./components/NotebookView";
import { RouterView } from "./components/RouterView";
import { SettingsModal } from "./components/SettingsModal";
import { StudioView } from "./components/StudioView";
import { PullCordLamp } from "./components/ui/pull-cord-lamp";
import { cleanQuoteDraftTitle, prepareDraftFromAssistantReply } from "./lib/draftCleanup";
import brandLogoUrl from "./assets/brand/logo-small.svg";
import { formatUserError } from "./utils/formatError";

type StudioTab = "discover" | "library" | "studio" | "notebook" | "router";
type AppTheme = "light" | "dark";

const THEME_STORAGE_KEY = "diandian.theme";

function readInitialTheme(): AppTheme {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

interface ToastItem {
  id: number;
  message: string;
  tone: "info" | "success" | "error";
}

const DEFAULT_RAIL_WIDTH = 196;
const MIN_RAIL_WIDTH = 160;
const MAX_RAIL_WIDTH = 340;
const DEFAULT_AI_WIDTH = 396;
const MIN_AI_WIDTH = 320;
const MAX_AI_WIDTH = 560;
const SPLIT_HANDLE_WIDTH = 5;
const MIN_LEFT_WIDTH = 440;
const MIN_LEFT_WIDTH_TRIPLE = 360;
const MIN_BROWSER_WIDTH = 340;
const MIN_BROWSER_WIDTH_TRIPLE = 290;

const QUICK_WEB_LINKS = [
  { label: "微信读书", url: "https://weread.qq.com", matchHosts: ["weread.qq.com"] },
  { label: "豆瓣", url: "https://book.douban.com", matchHosts: ["douban.com"] },
  { label: "小红书", url: "https://creator.xiaohongshu.com/publish/publish", matchHosts: ["xiaohongshu.com"] },
  { label: "公众号", url: "https://mp.weixin.qq.com", matchHosts: ["mp.weixin.qq.com"] },
] as const;

function isStartPageTabUrl(url?: string | null): boolean {
  return typeof url === "string" && url.startsWith("data:text/html");
}

function tabMatchesSite(tabUrl: string, matchHosts: readonly string[]): boolean {
  try {
    const host = new URL(tabUrl).hostname.toLowerCase();
    return matchHosts.some((target) => host === target || host.endsWith(`.${target}`));
  } catch {
    return false;
  }
}

const TAB_LABELS: Record<StudioTab, string> = {
  discover: "搜书发现",
  library: "我的书库",
  studio: "创作草稿",
  notebook: "主题空间",
  router: "连接与偏好",
};

function clampLeftWidth(
  desired: number,
  viewportWidth: number,
  railOpen: boolean,
  railWidth: number,
  aiOpen = false,
  aiWidth = DEFAULT_AI_WIDTH,
): number {
  const railW = railOpen ? railWidth : 0;
  const aiReserved = aiOpen ? aiWidth + SPLIT_HANDLE_WIDTH : 0;
  const minLeft = aiOpen ? MIN_LEFT_WIDTH_TRIPLE : MIN_LEFT_WIDTH;
  const minBrowser = aiOpen ? MIN_BROWSER_WIDTH_TRIPLE : MIN_BROWSER_WIDTH;
  const usable = Math.max(minLeft + minBrowser, viewportWidth - railW - aiReserved - SPLIT_HANDLE_WIDTH);
  const maxLeft = Math.max(minLeft, usable - minBrowser);
  return Math.max(minLeft, Math.min(maxLeft, desired));
}

function applyThemeToDocument(theme: AppTheme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage quota errors
  }
  void window.diandian?.app?.setTheme?.(theme).catch(() => {});
}

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<StudioTab>("discover");
  const [theme, setTheme] = useState<AppTheme>(() => readInitialTheme());
  const [lampPulse, setLampPulse] = useState<{ id: number; mode: "on" | "off" } | null>(null);
  const lampDockRef = useRef<HTMLDivElement | null>(null);
  const activeViewTransitionRef = useRef<{ skipTransition?: () => void } | null>(null);
  const [routerInitialSection, setRouterInitialSection] = useState<"twin" | "obsidian" | "router">("router");
  const [modelSettings, setModelSettings] = useState<PublicModelSettings | null>(null);
  const [safetyMode, setSafetyMode] = useState<SafetyMode>("confirm");
  const [browserState, setBrowserState] = useState<BrowserStateSnapshot | null>(null);

  // Surf layout visibility & resizable widths
  const [railOpen, setRailOpen] = useState(true);
  const [railWidth, setRailWidth] = useState(DEFAULT_RAIL_WIDTH);
  const [draggingRail, setDraggingRail] = useState(false);
  const railDragStartRef = useRef<{ x: number; width: number; pointerId: number } | null>(null);
  const railHandleRef = useRef<HTMLDivElement | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [browserOpen, setBrowserOpen] = useState(true);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiWidth, setAiWidth] = useState(DEFAULT_AI_WIDTH);
  const [draggingAi, setDraggingAi] = useState(false);
  const aiDragStartRef = useRef<{ x: number; width: number; pointerId: number } | null>(null);
  const aiHandleRef = useRef<HTMLDivElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1440,
  );

  const [petVisible, setPetVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cookieModalOpen, setCookieModalOpen] = useState(false);
  const [childModalOpen, setChildModalOpen] = useState(false);

  // Shared library + draft + Surf notebook summaries
  const [books, setBooks] = useState<BookRecord[]>([]);
  const [drafts, setDrafts] = useState<DraftRecord[]>([]);
  const [notebooks, setNotebooks] = useState<NotebookRecord[]>([]);
  const [activeNotebookId, setActiveNotebookId] = useState<string | null>(null);
  const [creatingNotebook, setCreatingNotebook] = useState(false);
  const [newNotebookName, setNewNotebookName] = useState("");
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);
  const [libraryMode, setLibraryMode] = useState<"shelf" | "collision">("shelf");

  // Split width (center workspace width in px when right browser is open)
  const [leftWidth, setLeftWidth] = useState(660);
  const [draggingSplit, setDraggingSplit] = useState(false);
  const dragStartRef = useRef<{ x: number; width: number; pointerId: number } | null>(null);
  const splitHandleRef = useRef<HTMLDivElement | null>(null);

  // Cross-view handoff states
  const [pendingPrompt, setPendingPrompt] = useState<PendingPromptPayload | null>(null);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [libraryRefreshSignal, setLibraryRefreshSignal] = useState(0);

  // Toast stack
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastIdRef = useRef(1);

  const notify = useCallback((message: string, tone: "info" | "success" | "error" = "info") => {
    const cleanMsg = tone === "error" ? formatUserError(message, message) : message;
    const id = toastIdRef.current++;
    setToasts((prev) => [...prev.slice(-3), { id, message: cleanMsg, tone }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, tone === "error" ? 5200 : 3600);
  }, []);

  const refreshWorkspaceData = useCallback(async () => {
    try {
      const [bookList, draftList, nbList] = await Promise.all([
        window.diandian.library.listBooks(""),
        window.diandian.drafts.list(),
        window.diandian.notebooks.list(),
      ]);
      setBooks(bookList);
      setDrafts(draftList);
      setNotebooks(nbList);
      setSelectedBookId((prev) => {
        if (prev && bookList.some((b) => b.id === prev)) return prev;
        return bookList[0]?.id ?? null;
      });
      setActiveDraftId((prev) => {
        if (prev && draftList.some((d) => d.id === prev)) return prev;
        return draftList[0]?.id ?? null;
      });
      setActiveNotebookId((prev) => {
        if (prev && nbList.some((n) => n.id === prev)) return prev;
        return nbList[0]?.id ?? null;
      });
    } catch {
      // Ignore transient load error during boot
    }
  }, []);

  useEffect(() => {
    void refreshWorkspaceData();
  }, [refreshWorkspaceData, libraryRefreshSignal]);

  const handleSendQuoteToDraft = useCallback(
    async (data: { quote: string; comment?: string; bookTitle?: string; author?: string }) => {
      const cleanQuote = data.quote.trim();
      const title = cleanQuoteDraftTitle(data.bookTitle, cleanQuote);
      const rawBookLabel = (data.bookTitle || "").trim();
      const showBookHeader = rawBookLabel && !/^(微信读书|豆瓣读书|小红书|微信公众号|新标签页)$/i.test(rawBookLabel);
      const lines = [
        showBookHeader ? `## 摘自《${rawBookLabel}》${data.author ? ` · ${data.author}` : ""}` : "## 读书摘录",
        "",
        `> ${cleanQuote}`,
        "",
      ];
      if (data.comment?.trim()) {
        lines.push("## 我的批注", "", data.comment.trim(), "");
      } else {
        lines.push("## 我的思考", "", "在这里写下你的延伸观点或亲身经历…", "");
      }
      try {
        const created = await window.diandian.drafts.create({
          title,
          kind: "thread",
          authorKind: "human",
          content: lines.join("\n"),
          promptSummary: "从书摘一键写入草稿",
        });
        await refreshWorkspaceData();
        setActiveDraftId(created.id);
        setActiveTab("studio");
        setWorkspaceOpen(true);
        notify("已将这段摘录写入创作草稿", "success");
      } catch (error) {
        notify(error instanceof Error ? error.message : "写入草稿失败", "error");
      }
    },
    [notify, refreshWorkspaceData],
  );

  useEffect(() => {
    void window.diandian.settings.getModel().then(setModelSettings);
    void window.diandian.safety.getMode().then((res) => setSafetyMode(res.mode));
    void window.diandian.browser.getState().then(setBrowserState);
    void window.diandian.pet.getState().then((st) => setPetVisible(st.visible));
    const offBrowser = window.diandian.browser.onStateChanged(setBrowserState);
    const offPet = window.diandian.pet.onStateChanged((st) => setPetVisible(st.visible));
    const offQuick = window.diandian.app.onQuickAction((ev) => {
      if (ev.kind === "saved") {
        setLibraryRefreshSignal((n) => n + 1);
        notify(
          ev.deduplicated
            ? `该划线已在《${ev.title}》中，已自动去重`
            : `已一键存入《${ev.title}》本地书库`,
          "success",
        );
      } else if (ev.kind === "draft") {
        void handleSendQuoteToDraft({
          quote: ev.text,
          comment: ev.comment ?? "",
          bookTitle: ev.title,
          author: ev.author ?? "",
        });
      } else if (ev.kind === "ask") {
        setPendingPrompt({
          text: `关于《${ev.title}》中我选中的这段话：\n\n「${ev.text}」\n\n请帮我深度解读并给一个延伸反问。`,
          autoSend: true,
        });
        setAiOpen(true);
      }
    });
    return () => {
      offBrowser();
      offPet();
      offQuick();
    };
  }, [notify, handleSendQuoteToDraft]);

  // Ensure initial theme class/attribute stays synced on mount
  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  // Clear temporary warm tungsten bloom pulse after animation finishes
  useEffect(() => {
    if (!lampPulse) return;
    const timer = window.setTimeout(() => setLampPulse(null), 1080);
    return () => window.clearTimeout(timer);
  }, [lampPulse]);

  // Cinematic slow, feathered radial light-wave transition originating from the exact pendant bulb
  const handleLampThemeChange = useCallback((lit: boolean) => {
    const nextTheme: AppTheme = lit ? "light" : "dark";

    const reducedMotion =
      typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const docWithVT = document as Document & {
      startViewTransition?: (cb: () => void) => {
        ready: Promise<void>;
        finished: Promise<void>;
        skipTransition?: () => void;
      };
    };

    if (reducedMotion || typeof docWithVT.startViewTransition !== "function") {
      applyThemeToDocument(nextTheme);
      setTheme(nextTheme);
      setLampPulse({ id: Date.now(), mode: lit ? "on" : "off" });
      return;
    }

    // Cancel any overlapping transition cleanly if user pulls rapidly
    try {
      activeViewTransitionRef.current?.skipTransition?.();
    } catch {
      // Ignore already finished transitions
    }

    const rect = lampDockRef.current?.getBoundingClientRect();
    const bx = rect ? rect.left + rect.width * 0.5 : window.innerWidth - 40;
    const by = rect ? rect.top + rect.height * 0.52 : 112;
    // Add 240px headroom so the 220px soft-feathered edge clears the farthest corner completely
    const maxR =
      Math.hypot(
        Math.max(bx, window.innerWidth - bx),
        Math.max(by, window.innerHeight - by),
      ) + 240;

    const root = document.documentElement;
    root.style.setProperty("--vt-x", `${bx.toFixed(1)}px`);
    root.style.setProperty("--vt-y", `${by.toFixed(1)}px`);
    root.style.setProperty("--vt-max-r", `${maxR.toFixed(1)}px`);
    root.classList.remove("theme-to-light", "theme-to-dark");
    root.classList.add("theme-transitioning", lit ? "theme-to-light" : "theme-to-dark");

    const vt = docWithVT.startViewTransition(() => {
      applyThemeToDocument(nextTheme);
      flushSync(() => {
        setTheme(nextTheme);
        setLampPulse({ id: Date.now(), mode: lit ? "on" : "off" });
      });
    });
    activeViewTransitionRef.current = vt;

    void vt.finished.finally(() => {
      if (activeViewTransitionRef.current === vt) {
        activeViewTransitionRef.current = null;
      }
      root.classList.remove("theme-transitioning", "theme-to-light", "theme-to-dark");
    });
  }, []);

  // Native WebContentsView always sits above HTML overlays; suppress whenever ANY modal opens.
  useEffect(() => {
    window.diandian.browser.setSuppressed(settingsOpen || cookieModalOpen || childModalOpen);
  }, [settingsOpen, cookieModalOpen, childModalOpen]);

  // Sync browser visibility when user toggles collapse/expand.
  useEffect(() => {
    void window.diandian.browser.setVisible(browserOpen);
  }, [browserOpen]);

  // Keyboard shortcuts: Cmd/Ctrl + \ toggles right browser, Cmd/Ctrl + B toggles left rail,
  // Cmd/Ctrl + Shift + B toggles left workspace (focus reading mode), Cmd/Ctrl + L toggles AI drawer
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setBrowserOpen((v) => {
          if (v) setWorkspaceOpen(true);
          return !v;
        });
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setWorkspaceOpen((v) => (browserOpen ? !v : true));
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setRailOpen((v) => !v);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") {
        e.preventDefault();
        setAiOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [browserOpen]);

  const endRailDrag = useCallback(() => {
    const start = railDragStartRef.current;
    const handleEl = railHandleRef.current;
    if (start && handleEl && handleEl.hasPointerCapture(start.pointerId)) {
      try {
        handleEl.releasePointerCapture(start.pointerId);
      } catch {
        // Ignore
      }
    }
    railDragStartRef.current = null;
    setDraggingRail(false);
    document.body.classList.remove("is-dragging-split");
  }, []);

  const handleRailPointerMove = useCallback(
    (clientX: number, buttons: number) => {
      const start = railDragStartRef.current;
      if (!start) return;
      if ((buttons & 1) === 0) {
        endRailDrag();
        return;
      }
      const desired = start.width + (clientX - start.x);
      if (desired < 108) {
        endRailDrag();
        setRailWidth(DEFAULT_RAIL_WIDTH);
        setRailOpen(false);
        return;
      }
      const maxAllowed = Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, window.innerWidth - MIN_LEFT_WIDTH - (browserOpen ? MIN_BROWSER_WIDTH : 0) - 20));
      const clamped = Math.max(MIN_RAIL_WIDTH, Math.min(maxAllowed, Math.round(desired)));
      setRailWidth(clamped);
    },
    [endRailDrag, browserOpen],
  );

  useEffect(() => {
    if (!draggingRail) return;
    document.body.classList.add("is-dragging-split");
    const onPointerMove = (e: PointerEvent) => handleRailPointerMove(e.clientX, e.buttons);
    const onMouseMove = (e: MouseEvent) => handleRailPointerMove(e.clientX, e.buttons);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") endRailDrag();
    };
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("pointerup", endRailDrag, true);
    window.addEventListener("mouseup", endRailDrag, true);
    window.addEventListener("pointercancel", endRailDrag, true);
    window.addEventListener("blur", endRailDrag);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.classList.remove("is-dragging-split");
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("pointerup", endRailDrag, true);
      window.removeEventListener("mouseup", endRailDrag, true);
      window.removeEventListener("pointercancel", endRailDrag, true);
      window.removeEventListener("blur", endRailDrag);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [draggingRail, endRailDrag, handleRailPointerMove]);

  const endSplitDrag = useCallback(() => {
    const start = dragStartRef.current;
    const handleEl = splitHandleRef.current;
    if (start && handleEl && handleEl.hasPointerCapture(start.pointerId)) {
      try {
        handleEl.releasePointerCapture(start.pointerId);
      } catch {
        // Ignore if pointer already released
      }
    }
    dragStartRef.current = null;
    setDraggingSplit(false);
    document.body.classList.remove("is-dragging-split");
  }, []);

  const handleSplitPointerMove = useCallback(
    (clientX: number, buttons: number) => {
      const start = dragStartRef.current;
      if (!start) return;
      if ((buttons & 1) === 0) {
        endSplitDrag();
        return;
      }
      const railW = railOpen ? railWidth : 0;
      const aiReserved = aiOpen ? aiWidth + SPLIT_HANDLE_WIDTH : 0;
      const desiredLeft = start.width + (clientX - start.x);
      if (desiredLeft < 200) {
        endSplitDrag();
        setWorkspaceOpen(false);
        return;
      }
      const remainingRight = window.innerWidth - railW - aiReserved - SPLIT_HANDLE_WIDTH - desiredLeft;
      if (remainingRight < 170) {
        endSplitDrag();
        setLeftWidth(clampLeftWidth(Math.min(start.width, 640), window.innerWidth, railOpen, railWidth, aiOpen, aiWidth));
        setBrowserOpen(false);
        setWorkspaceOpen(true);
        return;
      }
      setLeftWidth(clampLeftWidth(desiredLeft, window.innerWidth, railOpen, railWidth, aiOpen, aiWidth));
    },
    [endSplitDrag, railOpen, railWidth, aiOpen, aiWidth],
  );

  // Global safety nets so split-handle drag can NEVER stay stuck even when crossing native WebContentsView.
  useEffect(() => {
    if (!draggingSplit) return;
    document.body.classList.add("is-dragging-split");

    const onWindowPointerMove = (e: PointerEvent) => handleSplitPointerMove(e.clientX, e.buttons);
    const onWindowMouseMove = (e: MouseEvent) => handleSplitPointerMove(e.clientX, e.buttons);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") endSplitDrag();
    };
    const onVisibility = () => {
      if (document.hidden) endSplitDrag();
    };

    window.addEventListener("pointermove", onWindowPointerMove, true);
    window.addEventListener("mousemove", onWindowMouseMove, true);
    window.addEventListener("pointerup", endSplitDrag, true);
    window.addEventListener("mouseup", endSplitDrag, true);
    window.addEventListener("pointercancel", endSplitDrag, true);
    window.addEventListener("blur", endSplitDrag);
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.body.classList.remove("is-dragging-split");
      window.removeEventListener("pointermove", onWindowPointerMove, true);
      window.removeEventListener("mousemove", onWindowMouseMove, true);
      window.removeEventListener("pointerup", endSplitDrag, true);
      window.removeEventListener("mouseup", endSplitDrag, true);
      window.removeEventListener("pointercancel", endSplitDrag, true);
      window.removeEventListener("blur", endSplitDrag);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [draggingSplit, endSplitDrag, handleSplitPointerMove]);

  const endAiDrag = useCallback(() => {
    const start = aiDragStartRef.current;
    const handleEl = aiHandleRef.current;
    if (start && handleEl && handleEl.hasPointerCapture(start.pointerId)) {
      try {
        handleEl.releasePointerCapture(start.pointerId);
      } catch {
        // Ignore
      }
    }
    aiDragStartRef.current = null;
    setDraggingAi(false);
    document.body.classList.remove("is-dragging-split");
  }, []);

  const handleAiPointerMove = useCallback(
    (clientX: number, buttons: number) => {
      const start = aiDragStartRef.current;
      if (!start) return;
      if ((buttons & 1) === 0) {
        endAiDrag();
        return;
      }
      const desired = start.width - (clientX - start.x);
      if (desired < 220) {
        endAiDrag();
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
    },
    [endAiDrag, railOpen, railWidth, browserOpen, workspaceOpen],
  );

  useEffect(() => {
    if (!draggingAi) return;
    document.body.classList.add("is-dragging-split");
    const onPointerMove = (e: PointerEvent) => handleAiPointerMove(e.clientX, e.buttons);
    const onMouseMove = (e: MouseEvent) => handleAiPointerMove(e.clientX, e.buttons);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") endAiDrag();
    };
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("pointerup", endAiDrag, true);
    window.addEventListener("mouseup", endAiDrag, true);
    window.addEventListener("pointercancel", endAiDrag, true);
    window.addEventListener("blur", endAiDrag);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.classList.remove("is-dragging-split");
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("pointerup", endAiDrag, true);
      window.removeEventListener("mouseup", endAiDrag, true);
      window.removeEventListener("pointercancel", endAiDrag, true);
      window.removeEventListener("blur", endAiDrag);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [draggingAi, endAiDrag, handleAiPointerMove]);

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

  const handleSaveReplyAsDraft = async (content: string): Promise<string | null> => {
    const activeTabNow = browserState?.tabs.find((t) => t.id === browserState.activeTabId) ?? null;
    const prepared = prepareDraftFromAssistantReply(content, {
      bookHint: selectedBook?.title ?? null,
      pageTitle: activeTabNow && !isStartPageTabUrl(activeTabNow.url) ? activeTabNow.title : null,
    });
    const matchedBook = prepared.bookTitle
      ? books.find(
          (b) =>
            b.title === prepared.bookTitle
            || b.title.includes(prepared.bookTitle!)
            || prepared.bookTitle!.includes(b.title),
        )
      : undefined;
    try {
      const created = await window.diandian.drafts.create({
        title: prepared.title,
        kind: prepared.kind,
        ...(matchedBook ? { bookId: matchedBook.id } : {}),
        authorKind: "ai",
        content: prepared.content,
        promptSummary: "从共读对话一键沉淀（已自动去除对话寒暄）",
      });
      setActiveDraftId(created.id);
      setActiveTab("studio");
      setWorkspaceOpen(true);
      void refreshWorkspaceData();
      notify(`已存入创作工作台：《${created.title}》`, "success");
      return created.id;
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存草稿失败", "error");
      return null;
    }
  };

  const handleOpenDraftFromChat = (draftId: string) => {
    setActiveDraftId(draftId);
    setActiveTab("studio");
    setWorkspaceOpen(true);
  };

  const handleSelectSafety = useCallback(
    async (mode: SafetyMode) => {
      try {
        const res = await window.diandian.safety.setMode(mode);
        setSafetyMode(res.mode);
        const label = res.mode === "plan" ? "只读规划" : res.mode === "auto" ? "全自动工作流" : "安全确认";
        notify(`工具执行守卫已切换为「${label}」（实时生效）`, "success");
      } catch (error) {
        notify(error instanceof Error ? error.message : "切换安全模式失败", "error");
      }
    },
    [notify],
  );

  const handleSelectModel = useCallback(
    async (nextModelId: string) => {
      if (!modelSettings) return;
      const trimmed = nextModelId.trim();
      if (!trimmed || trimmed === modelSettings.model) return;
      try {
        const saved = await window.diandian.settings.saveModel({
          provider: modelSettings.provider,
          model: trimmed,
          baseUrl: modelSettings.baseUrl,
        });
        setModelSettings(saved);
        notify(`已切换模型为 ${saved.model}`, "success");
      } catch (error) {
        notify(error instanceof Error ? error.message : "切换模型失败", "error");
      }
    },
    [modelSettings, notify],
  );

  const handleSendToChat = (prompt: string, autoSend = false) => {
    setPendingPrompt({ text: prompt, autoSend });
    setAiOpen(true);
  };

  const handleOpenBrowserUrl = async (url?: string, newTab = false) => {
    setBrowserOpen(true);
    try {
      await window.diandian.browser.openUrl(url, newTab);
    } catch (error) {
      notify(error instanceof Error ? error.message : "打开网页失败", "error");
    }
  };

  const handleOpenQuickSite = async (site: (typeof QUICK_WEB_LINKS)[number]) => {
    setBrowserOpen(true);
    const tabs = browserState?.tabs ?? [];
    const current = tabs.find((t) => t.id === browserState?.activeTabId) ?? null;

    // 1. If currently sitting on a blank "新标签页", open directly inside it without leaving an empty tab behind.
    if (current && isStartPageTabUrl(current.url)) {
      await handleOpenBrowserUrl(site.url, false);
      return;
    }

    // 2. If this site is already open in a tab, switch straight to it instead of duplicating or overwriting.
    const existing = tabs.find((t) => tabMatchesSite(t.url, site.matchHosts));
    if (existing) {
      try {
        await window.diandian.browser.selectTab(existing.id);
      } catch (error) {
        notify(error instanceof Error ? error.message : "切换标签页失败", "error");
      }
      return;
    }

    // 3. Otherwise open in a fresh tab so the current reading page stays intact.
    await handleOpenBrowserUrl(site.url, true);
  };

  const selectedBook = useMemo(
    () => books.find((b) => b.id === selectedBookId) ?? null,
    [books, selectedBookId],
  );

  const selectedDraft = useMemo(
    () => drafts.find((d) => d.id === activeDraftId) ?? null,
    [drafts, activeDraftId],
  );

  const selectedNotebook = useMemo(
    () => notebooks.find((n) => n.id === activeNotebookId) ?? null,
    [notebooks, activeNotebookId],
  );

  const handleCreateNotebook = async () => {
    const clean = newNotebookName.trim();
    if (!clean) {
      setCreatingNotebook(false);
      return;
    }
    try {
      const created = await window.diandian.notebooks.create({ name: clean, icon: "✦" });
      await refreshWorkspaceData();
      setActiveNotebookId(created.id);
      setActiveTab("notebook");
      setWorkspaceOpen(true);
      setNewNotebookName("");
      setCreatingNotebook(false);
      notify(`已新建主题空间「${created.name}」`, "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "新建主题空间失败", "error");
    }
  };

  const handleAddNotebookItem = async (
    notebookId: string,
    item: { itemKind: NotebookItemKind; itemRef: string; title: string; meta?: string },
  ) => {
    try {
      await window.diandian.notebooks.addItem({ notebookId, ...item });
      await refreshWorkspaceData();
      notify(`已将「${item.title}」收入主题空间`, "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "添加素材失败", "error");
    }
  };

  const handleRemoveNotebookItem = async (notebookId: string, itemId: string) => {
    try {
      await window.diandian.notebooks.removeItem(notebookId, itemId);
      await refreshWorkspaceData();
    } catch (error) {
      notify(error instanceof Error ? error.message : "移除失败", "error");
    }
  };

  const handleDeleteNotebook = async (notebookId: string) => {
    try {
      await window.diandian.notebooks.delete(notebookId);
      await refreshWorkspaceData();
      setActiveTab("discover");
      notify("主题空间已删除", "info");
    } catch (error) {
      notify(error instanceof Error ? error.message : "删除失败", "error");
    }
  };

  const buildNotebookPromptSummary = useCallback((nb: NotebookRecord): string => {
    const bList = nb.items
      .filter((i) => i.itemKind === "book")
      .map((i) => `《${i.title}》(bookId: ${i.itemRef})`);
    const dList = nb.items
      .filter((i) => i.itemKind === "draft")
      .map((i) => `「${i.title}」(draftId: ${i.itemRef})`);
    const wList = nb.items
      .filter((i) => i.itemKind === "web")
      .map((i) => `${i.title} (${i.itemRef})`);
    const parts = [
      bList.length ? `关联书目：${bList.join("、")}` : "",
      dList.length ? `关联草稿：${dList.join("、")}` : "",
      wList.length ? `收录网页：${wList.join("、")}` : "",
    ].filter(Boolean);
    return `- [主题空间] 「${nb.name}」${parts.length ? `（${parts.join("；")}，请综合调取这些书的划线与草稿上下文回答）` : ""}`;
  }, []);

  const breadcrumbDetail = useMemo(() => {
    if (activeTab === "library") {
      return libraryMode === "collision" ? "跨书观点碰撞" : selectedBook?.title || "书架";
    }
    if (activeTab === "studio") {
      return selectedDraft?.title || "草稿箱";
    }
    if (activeTab === "notebook") {
      return selectedNotebook?.name || "主题空间";
    }
    return null;
  }, [activeTab, libraryMode, selectedBook?.title, selectedDraft?.title, selectedNotebook?.name]);

  const activeBrowserTab = useMemo(
    () => browserState?.tabs.find((t) => t.id === browserState.activeTabId) ?? null,
    [browserState?.tabs, browserState?.activeTabId],
  );

  // Dynamic Surf-style "Active Context" chip automatically attached inside the AI drawer
  const autoContext = useMemo<ContextAttachment | null>(() => {
    if (workspaceOpen && activeTab === "notebook" && selectedNotebook) {
      return {
        id: `notebook:${selectedNotebook.id}`,
        kind: "notebook",
        label: `主题：${selectedNotebook.name.slice(0, 14)} (${selectedNotebook.items.length})`,
        promptSummary: buildNotebookPromptSummary(selectedNotebook),
      };
    }
    if (workspaceOpen && activeTab === "studio" && selectedDraft) {
      return {
        id: `draft:${selectedDraft.id}`,
        kind: "draft",
        label: `草稿：${selectedDraft.title.slice(0, 16)}`,
      };
    }
    if (workspaceOpen && activeTab === "library" && selectedBook) {
      return {
        id: `book:${selectedBook.id}`,
        kind: "book",
        label: `《${selectedBook.title.slice(0, 15)}》`,
      };
    }
    if (browserOpen && activeBrowserTab && !isStartPageTabUrl(activeBrowserTab.url)) {
      const cleanedTitle = (activeBrowserTab.title || "阅读页")
        .replace(/\s*[-–—|]\s*(微信读书|WeRead|豆瓣读书|豆瓣|小红书|知乎|哔哩哔哩).*$/i, "")
        .replace(/^《|》$/g, "")
        .split(/\s+[-–—]\s+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 2)
        .join(" · ");
      const compactTitle =
        cleanedTitle.length > 20 ? `${cleanedTitle.slice(0, 19).replace(/[·\-—\s]+$/, "")}…` : cleanedTitle;
      return {
        id: `web:${activeBrowserTab.id}`,
        kind: "web",
        label: `当前页：${compactTitle || "阅读页"}`,
        meta: activeBrowserTab.url,
      };
    }
    return null;
  }, [
    workspaceOpen,
    activeTab,
    selectedNotebook,
    buildNotebookPromptSummary,
    selectedDraft,
    selectedBook,
    browserOpen,
    activeBrowserTab,
  ]);

  const navItems: Array<{ id: StudioTab; label: string; icon: React.ReactNode; count?: number }> = [
    { id: "discover", label: "搜书发现", icon: <IconSearch size={15} /> },
    { id: "library", label: "我的书库", icon: <IconBookOpen size={15} />, count: books.length || undefined },
    { id: "studio", label: "创作草稿", icon: <IconPenLine size={15} />, count: drafts.length || undefined },
    { id: "router", label: "连接与偏好", icon: <IconCompass size={15} /> },
  ];

  const effectiveLeftWidth = clampLeftWidth(leftWidth, viewportWidth, railOpen, railWidth, aiOpen, aiWidth);

  return (
    <div className="app-shell">
      {/* 1. Far-Left Resizable Frosted Cloud-Blue Surf Sidebar */}
      {railOpen && (
        <>
          <aside
            className="surf-rail"
            aria-label="主导航与网页标签"
            style={{ width: `${railWidth}px`, minWidth: `${railWidth}px` }}
          >
          <div className="surf-brand-row">
            <div className="surf-brand-left">
              <img className="surf-brand-mark" src={brandLogoUrl} alt="" aria-hidden="true" />
              <span className="surf-brand-name">点点读书</span>
            </div>
          </div>

          <nav className="surf-nav-list">
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`surf-nav-item ${workspaceOpen && activeTab === item.id ? "active" : ""}`}
                onClick={() => {
                  setActiveTab(item.id);
                  setWorkspaceOpen(true);
                }}
              >
                {item.icon}
                <span className="surf-nav-label">{item.label}</span>
                {item.count !== undefined && <span className="surf-nav-count">{item.count}</span>}
              </button>
            ))}
          </nav>

          <div className="surf-rail-divider" />

          {/* Deta Surf-Style Topic Notebooks */}
          <div className="surf-section-head">
            <span>主题空间</span>
            <button
              type="button"
              className="btn icon-only ghost"
              style={{ width: 22, height: 22 }}
              onClick={() => setCreatingNotebook((v) => !v)}
              title="新建主题空间（把书目、草稿与网页打包共读）"
            >
              <IconPlus size={12} />
            </button>
          </div>

          {creatingNotebook && (
            <form
              className="surf-nb-create"
              onSubmit={(e) => {
                e.preventDefault();
                void handleCreateNotebook();
              }}
            >
              <input
                className="surf-nb-input"
                autoFocus
                value={newNotebookName}
                onChange={(e) => setNewNotebookName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setCreatingNotebook(false);
                    setNewNotebookName("");
                  }
                }}
                placeholder="输入主题名，回车创建…"
              />
            </form>
          )}

          {notebooks.length > 0 && (
            <div className="surf-nb-list">
              {notebooks.map((nb) => {
                const isNbActive = workspaceOpen && activeTab === "notebook" && activeNotebookId === nb.id;
                return (
                  <button
                    key={nb.id}
                    type="button"
                    className={`surf-tab-item ${isNbActive ? "active" : ""}`}
                    onClick={() => {
                      setActiveNotebookId(nb.id);
                      setActiveTab("notebook");
                      setWorkspaceOpen(true);
                    }}
                    title={`${nb.name}（${nb.items.length} 项素材）`}
                  >
                    <span className="surf-nb-icon">{nb.icon || "✦"}</span>
                    <span className="surf-nav-label">{nb.name}</span>
                    {nb.items.length > 0 && <span className="surf-nav-count">{nb.items.length}</span>}
                  </button>
                );
              })}
            </div>
          )}

          <div className="surf-rail-divider" />

          {/* Vertical Browser Tabs unified into Left Surf Sidebar */}
          <div className="surf-section-head">
            <span>阅读标签</span>
            <button
              type="button"
              className="btn icon-only ghost"
              style={{ width: 22, height: 22 }}
              onClick={() => void handleOpenBrowserUrl(undefined, true)}
              title="新建空白标签页（可选择站点或输入网址）"
            >
              <IconPlus size={12} />
            </button>
          </div>

          <div className="surf-rail-tabs">
            {(browserState?.tabs ?? []).map((tab) => {
              const isCurrent = browserOpen && tab.id === browserState?.activeTabId;
              const isStart = isStartPageTabUrl(tab.url);
              const displayTitle = isStart ? "新标签页" : tab.title || "加载中…";
              return (
                <div
                  key={tab.id}
                  className={`surf-tab-item ${isCurrent ? "active" : ""}`}
                  onClick={() => {
                    setBrowserOpen(true);
                    void window.diandian.browser.selectTab(tab.id);
                  }}
                  title={isStart ? "新标签页" : tab.title || tab.url}
                >
                  <SiteBrandIcon url={tab.url} faviconUrl={tab.faviconUrl} size={14} />
                  <span className="surf-nav-label">{displayTitle}</span>
                  {(browserState?.tabs.length ?? 0) > 1 && (
                    <button
                      type="button"
                      className="surf-tab-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        void window.diandian.browser.closeTab(tab.id);
                      }}
                      title="关闭标签页"
                    >
                      <IconClose size={11} />
                    </button>
                  )}
                </div>
              );
            })}

            <div className="surf-quick-links">
              {QUICK_WEB_LINKS.map((site) => {
                const alreadyOpen = (browserState?.tabs ?? []).some((t) =>
                  tabMatchesSite(t.url, site.matchHosts),
                );
                const onStartPage = Boolean(activeBrowserTab && isStartPageTabUrl(activeBrowserTab.url));
                const tooltip = onStartPage
                  ? `在当前新标签页打开${site.label}`
                  : alreadyOpen
                    ? `切换到已打开的${site.label}标签页`
                    : `在新标签页打开${site.label}`;
                return (
                  <button
                    key={site.label}
                    type="button"
                    className="surf-quick-pill"
                    onClick={() => void handleOpenQuickSite(site)}
                    title={tooltip}
                  >
                    <SiteBrandIcon url={site.url} size={14} />
                    <span>{site.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="surf-rail-footer">
            <button
              type="button"
              className="surf-footer-btn"
              onClick={() => void window.diandian.pet.toggle()}
              title={petVisible ? "隐藏桌面伴读小金毛" : "召唤桌面伴读小金毛"}
            >
              <IconPaw size={14} />
              <span>小金毛</span>
              {petVisible && <span className="surf-status-dot" />}
            </button>

            <button
              type="button"
              className="surf-footer-btn"
              onClick={() => setSettingsOpen(true)}
              title="模型与 API Key 设置"
            >
              <IconSettings size={14} />
              <span>模型</span>
            </button>
          </div>
        </aside>
        <div
          ref={railHandleRef}
          className={`rail-resize-handle ${draggingRail ? "dragging" : ""}`}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              // Ignore
            }
            railDragStartRef.current = { x: e.clientX, width: railWidth, pointerId: e.pointerId };
            setDraggingRail(true);
          }}
          onPointerMove={(e) => {
            if (!railDragStartRef.current) return;
            handleRailPointerMove(e.clientX, e.buttons);
          }}
          onPointerUp={() => endRailDrag()}
          onPointerCancel={() => endRailDrag()}
          onLostPointerCapture={() => endRailDrag()}
          onDoubleClick={() => setRailWidth(DEFAULT_RAIL_WIDTH)}
          title="拖动调整左侧栏宽度（拖至最左自动收起，双击重置）"
        />
        </>
      )}

      {/* 2. Main Split Stage */}
      <main className={`main-stage ${railOpen ? "" : "rail-collapsed"} ${aiOpen ? "ai-open" : ""}`}>
        <div
          className={`workspace-column ${browserOpen ? "" : "full-width"}`}
          style={{
            display: workspaceOpen ? "flex" : "none",
            ...(browserOpen ? { width: `${effectiveLeftWidth}px`, flex: "0 0 auto" } : {}),
          }}
        >
          {/* Razor-Thin 38px Surf Breadcrumb Topbar */}
          <div className={`surf-topbar ${railOpen ? "" : "rail-collapsed"}`}>
            <div className="surf-topbar-left">
              <button
                type="button"
                className="btn icon-only ghost"
                onClick={() => setRailOpen((v) => !v)}
                title={railOpen ? "收起左侧栏（⌘B）" : "展开左侧栏（⌘B）"}
              >
                <IconPanelLeft size={14} />
              </button>

              <div className="surf-breadcrumbs">
                <span className="surf-crumb-root">点点读书</span>
                <span className="surf-crumb-sep">
                  <IconChevronRight size={12} />
                </span>
                <span className="surf-crumb-mid" onClick={() => setActiveTab(activeTab)}>
                  {TAB_LABELS[activeTab]}
                </span>
                {breadcrumbDetail && (
                  <>
                    <span className="surf-crumb-sep">
                      <IconChevronRight size={12} />
                    </span>
                    <span className="surf-crumb-current">{breadcrumbDetail}</span>
                  </>
                )}
              </div>
            </div>

            <div className="surf-topbar-drag" />

            <div className="surf-topbar-right">
              {browserOpen && (
                <button
                  type="button"
                  className="btn sm ghost"
                  style={{ height: 25, padding: "0 8px", fontSize: 11.5 }}
                  onClick={() => setWorkspaceOpen(false)}
                  title="收起左侧工作台，专注大视野阅读右侧网页（快捷键 ⌘⇧B）"
                >
                  <IconPanelLeft size={12} />
                  <span>收起</span>
                </button>
              )}
              {!browserOpen && (
                <button
                  type="button"
                  className="btn sm soft"
                  onClick={() => setBrowserOpen(true)}
                  title="展开右侧阅读浏览器（快捷键 ⌘\）"
                >
                  <IconPanelRight size={13} />
                  <span>展开阅读窗</span>
                </button>
              )}
              {!browserOpen && !aiOpen && (
                <button
                  type="button"
                  className="surf-ask-pill"
                  onClick={() => setAiOpen(true)}
                  title="打开右侧「问点点」AI 共读面板（快捷键 ⌘L）"
                >
                  <span className="surf-ask-pill-badge">
                    <IconSparkles size={12} />
                  </span>
                  <span>问点点</span>
                </button>
              )}
            </div>
          </div>

          {/* Body Row: Full-Width Active Canvas */}
          <div className="surf-body-row">
            <div className="surf-canvas-shell">
              {/* Warm Tungsten Aura Bloom Synchronized With Lamp Toggle */}
              {lampPulse && (
                <div
                  key={lampPulse.id}
                  className={`lamp-light-burst ${lampPulse.mode === "on" ? "is-on" : "is-off"}`}
                  aria-hidden="true"
                />
              )}

              {/* Ceiling-Mounted Tactile Pull-Cord Reading Lamp (Light <-> Dark Theme Switch) */}
              <div
                ref={lampDockRef}
                className="theme-lamp-dock"
                title={theme === "light" ? "拉绳关灯 · 切换暗黑夜读模式" : "拉绳开灯 · 切换云蓝白昼模式"}
              >
                <PullCordLamp
                  size="fill"
                  shade="dome"
                  bulb="clear"
                  finish="theme"
                  cord={0.85}
                  warmth={2650}
                  sound
                  on={theme === "light"}
                  onChange={handleLampThemeChange}
                  label={theme === "light" ? "拉绳关灯切换夜间模式" : "拉绳开灯切换白昼模式"}
                />
              </div>

              <div style={{ display: activeTab === "discover" ? "flex" : "none", flexDirection: "column", height: "100%" }}>
                <DiscoverView
                  onSendToChat={(prompt, autoSend) => handleSendToChat(prompt, autoSend)}
                  onOpenBrowserUrl={(url, newTab) => void handleOpenBrowserUrl(url, newTab)}
                  onEnsureBrowserOpen={() => setBrowserOpen(true)}
                  onOpenRouterSettings={() => {
                    setRouterInitialSection("router");
                    setActiveTab("router");
                  }}
                  onNotify={notify}
                />
              </div>

              {activeTab === "library" && (
                <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                  <LibraryView
                    refreshSignal={libraryRefreshSignal}
                    selectedBookId={selectedBookId}
                    onSelectBookId={setSelectedBookId}
                    viewMode={libraryMode}
                    onViewModeChange={setLibraryMode}
                    onDataChanged={() => void refreshWorkspaceData()}
                    onModalToggle={setChildModalOpen}
                    onSendToChat={(p) => handleSendToChat(p, false)}
                    onSendToDraft={(data) => void handleSendQuoteToDraft(data)}
                    onNotify={notify}
                  />
                </div>
              )}

              {activeTab === "studio" && (
                <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                  <StudioView
                    activeDraftId={activeDraftId}
                    onSelectDraftId={setActiveDraftId}
                    onDataChanged={() => void refreshWorkspaceData()}
                    onModalToggle={setChildModalOpen}
                    onSendToChat={(p) => handleSendToChat(p, false)}
                    onOpenBrowserUrl={(url) => void handleOpenBrowserUrl(url)}
                    onNotify={notify}
                  />
                </div>
              )}

              {activeTab === "notebook" && selectedNotebook && (
                <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                  <NotebookView
                    notebook={selectedNotebook}
                    books={books}
                    drafts={drafts}
                    activeBrowserTab={activeBrowserTab}
                    onAddItem={handleAddNotebookItem}
                    onRemoveItem={handleRemoveNotebookItem}
                    onDeleteNotebook={handleDeleteNotebook}
                    onOpenBook={(bookId) => {
                      setSelectedBookId(bookId);
                      setLibraryMode("shelf");
                      setActiveTab("library");
                    }}
                    onOpenDraft={(draftId) => {
                      setActiveDraftId(draftId);
                      setActiveTab("studio");
                    }}
                    onOpenWebUrl={(url) => void handleOpenBrowserUrl(url, false)}
                    onAskNotebook={(nb) => {
                      handleSendToChat(
                        `请基于主题空间「${nb.name}」的关联素材：\n${buildNotebookPromptSummary(nb)}\n\n帮我做一次跨书与跨素材的结构化整合，梳理核心共识、矛盾观点，并给出一个适合写成深度长文或小红书干货的切入角度。`,
                        false,
                      );
                    }}
                  />
                </div>
              )}

              {activeTab === "router" && (
                <RouterView
                  initialSection={routerInitialSection}
                  onModalToggle={setChildModalOpen}
                  onEnsureBrowserOpen={() => setBrowserOpen(true)}
                  onNotify={notify}
                />
              )}
            </div>
          </div>
        </div>

        {/* 3. Right Native Split Browser (38px matching chrome) */}
        {browserOpen && (
          <>
            {workspaceOpen && (
              <div
                ref={splitHandleRef}
                className={`split-handle ${draggingSplit ? "dragging" : ""}`}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  try {
                    e.currentTarget.setPointerCapture(e.pointerId);
                  } catch {
                    // Ignore if capture unsupported
                  }
                  dragStartRef.current = { x: e.clientX, width: leftWidth, pointerId: e.pointerId };
                  setDraggingSplit(true);
                }}
                onPointerMove={(e) => {
                  if (!dragStartRef.current) return;
                  handleSplitPointerMove(e.clientX, e.buttons);
                }}
                onPointerUp={() => endSplitDrag()}
                onPointerCancel={() => endSplitDrag()}
                onLostPointerCapture={() => endSplitDrag()}
                onDoubleClick={() =>
                  setLeftWidth(clampLeftWidth(660, window.innerWidth, railOpen, railWidth, aiOpen, aiWidth))
                }
                title="拖动调整左右宽度（拖至最左收起工作台，拖至最右收起阅读窗，双击重置）"
              />
            )}
            <BrowserPane
              browserState={browserState}
              layoutKey={
                (workspaceOpen ? effectiveLeftWidth : 1) +
                (railOpen ? railWidth * 100 : 0) +
                (aiOpen ? aiWidth * 10000 : 0) +
                (workspaceOpen ? 0 : 7777777)
              }
              railOpen={railOpen}
              workspaceOpen={workspaceOpen}
              aiOpen={aiOpen}
              onToggleRail={() => setRailOpen((v) => !v)}
              onToggleWorkspace={() => setWorkspaceOpen((v) => !v)}
              onToggleAi={() => setAiOpen((v) => !v)}
              onCollapse={() => {
                setBrowserOpen(false);
                setWorkspaceOpen(true);
              }}
              onOpenCookieImport={() => setCookieModalOpen(true)}
              onOpenRouterSettings={() => {
                setRouterInitialSection("router");
                setActiveTab("router");
                setWorkspaceOpen(true);
              }}
              onNotify={notify}
            />
          </>
        )}
      </main>

      {/* 4. Far-Right Floating Deta Surf AI Co-Reading Card (⌘L) */}
      {aiOpen && (
        <div
          ref={aiHandleRef}
          className={`ai-split-handle ${draggingAi ? "dragging" : ""}`}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              // Ignore
            }
            aiDragStartRef.current = { x: e.clientX, width: aiWidth, pointerId: e.pointerId };
            setDraggingAi(true);
          }}
          onPointerMove={(e) => {
            if (!aiDragStartRef.current) return;
            handleAiPointerMove(e.clientX, e.buttons);
          }}
          onPointerUp={() => endAiDrag()}
          onPointerCancel={() => endAiDrag()}
          onLostPointerCapture={() => endAiDrag()}
          onDoubleClick={() => setAiWidth(DEFAULT_AI_WIDTH)}
          title="拖动调整问点点宽度（拖至最右自动收起，双击重置）"
        />
      )}
      <aside
        className={`ai-drawer-pane ${aiOpen ? "open" : ""}`}
        style={{
          display: aiOpen ? "flex" : "none",
          width: `${aiWidth}px`,
          flex: "0 0 auto",
        }}
        aria-label="问点点 AI 共读侧栏"
      >
        <LeftWorkspace
          books={books}
          drafts={drafts}
          browserState={browserState}
          modelSettings={modelSettings}
          safetyMode={safetyMode}
          autoContext={autoContext}
          pendingPrompt={pendingPrompt}
          onConsumePendingPrompt={() => setPendingPrompt(null)}
          onClose={() => setAiOpen(false)}
          onOpenSettings={() => setSettingsOpen(true)}
          onSelectModel={(modelId) => handleSelectModel(modelId)}
          onSelectSafety={(mode) => void handleSelectSafety(mode)}
          onSaveAsDraft={(text) => handleSaveReplyAsDraft(text)}
          onOpenDraft={handleOpenDraftFromChat}
          onNotify={notify}
        />
      </aside>

      <SettingsModal
        open={settingsOpen}
        initial={modelSettings}
        onClose={() => setSettingsOpen(false)}
        onSaved={(saved) => {
          setModelSettings(saved);
          notify("模型设置已保存", "success");
        }}
      />

      <CookieImportModal
        open={cookieModalOpen}
        activeAccountLabel={
          browserState?.accounts.find((a) => a.id === browserState.activeAccountId)?.label ?? "主账号"
        }
        onClose={() => setCookieModalOpen(false)}
        onNotify={notify}
      />

      {toasts.length > 0 && (
        <div className="toast-stack" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast-item ${t.tone}`}>
              {t.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
