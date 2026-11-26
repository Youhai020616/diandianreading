import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

export type AppTheme = "light" | "dark";

const THEME_STORAGE_KEY = "diandian.theme";

function readInitialTheme(): AppTheme {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
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

/** Day/night theme driven by the pull-cord lamp, with a light wave that starts at the bulb. */
export function useAppTheme() {
  const [theme, setTheme] = useState<AppTheme>(() => readInitialTheme());
  const [lampPulse, setLampPulse] = useState<{ id: number; mode: "on" | "off" } | null>(null);
  const lampDockRef = useRef<HTMLDivElement | null>(null);
  const activeViewTransitionRef = useRef<{ skipTransition?: () => void } | null>(null);

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

  return { theme, lampPulse, lampDockRef, handleLampThemeChange };
}
