import { useCallback, useEffect, useState } from "react";

export type Lang = "zh" | "en";
const KEY = "diandian-site-lang";

/** `?lang=en|zh` wins (shareable links), then the last choice, then the browser's language. */
function initialLang(): Lang {
  const param = new URLSearchParams(window.location.search).get("lang");
  if (param === "en" || param === "zh") return param;
  const saved = window.localStorage.getItem(KEY);
  if (saved === "en" || saved === "zh") return saved;
  return (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function useLang(meta: Record<Lang, { title: string; description: string }>) {
  const [lang, setLang] = useState<Lang>(initialLang);

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.title = meta[lang].title;
    document.querySelector('meta[name="description"]')?.setAttribute("content", meta[lang].description);
  }, [lang, meta]);

  const choose = useCallback((next: Lang) => {
    setLang(next);
    window.localStorage.setItem(KEY, next);
  }, []);

  return { lang, choose };
}
