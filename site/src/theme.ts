import { useCallback, useEffect, useState } from "react";

export type Theme = "day" | "night";
const KEY = "diandian-site-theme";

/** `?theme=night|day` wins (handy for sharing and screenshots), then the last choice, then the system. */
function initialTheme(): Theme {
  const param = new URLSearchParams(window.location.search).get("theme");
  if (param === "night" || param === "dark") return "night";
  if (param === "day" || param === "light") return "day";
  const saved = window.localStorage.getItem(KEY);
  if (saved === "night" || saved === "day") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "day";
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "night");
    root.style.colorScheme = theme === "night" ? "dark" : "light";
  }, [theme]);

  const choose = useCallback((next: Theme) => {
    setTheme(next);
    window.localStorage.setItem(KEY, next);
  }, []);

  return { theme, choose };
}
