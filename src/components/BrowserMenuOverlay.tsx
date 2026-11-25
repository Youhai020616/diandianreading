import React, { useEffect, useState } from "react";
import {
  IconCopy,
  IconExternalLink,
  IconFolder,
  IconKey,
  IconRefresh,
} from "./Icons";

export const BrowserMenuOverlay: React.FC = () => {
  const [url, setUrl] = useState("");
  const [zoomPercent, setZoomPercent] = useState(100);

  useEffect(() => {
    const applyTheme = (theme: "light" | "dark") => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.classList.toggle("dark", theme === "dark");
      document.documentElement.classList.toggle("light", theme === "light");
    };

    const offData = window.diandian.browserMenu.onData((data) => {
      if (typeof data.url === "string") setUrl(data.url);
      if (typeof data.zoomPercent === "number") setZoomPercent(data.zoomPercent);
      if (data.theme === "light" || data.theme === "dark") applyTheme(data.theme);
    });

    const offTheme = window.diandian.app.onThemeChanged(({ theme }) => applyTheme(theme));

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void window.diandian.browserMenu.close();
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      offData();
      offTheme();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const hasWebUrl = /^https?:\/\//i.test(url);

  const handleZoom = async (action: "in" | "out" | "reset") => {
    try {
      const res = await window.diandian.browserMenu.zoom(action);
      setZoomPercent(res.zoomPercent);
    } catch {
      // Ignore transient errors
    }
  };

  const runAction = async (
    action: "copy-url" | "open-external" | "import-cookie" | "open-downloads",
  ) => {
    try {
      await window.diandian.browserMenu.runAction(action);
    } catch {
      // Ignore
    }
  };

  return (
    <div className="bmenu-stage">
      <div className="bmenu-card" role="menu" aria-label="浏览器更多选项">
        {/* Inline Deta Surf / Chrome-style Zoom Row */}
        <div className="bmenu-zoom-row">
          <span className="bmenu-zoom-label">页面缩放</span>
          <div className="bmenu-zoom-controls">
            <div className="bmenu-zoom-pill">
              <button
                type="button"
                className="bmenu-zoom-step"
                disabled={zoomPercent <= 70}
                onClick={() => void handleZoom("out")}
                title="缩小页面"
              >
                −
              </button>
              <span className="bmenu-zoom-val">{zoomPercent}%</span>
              <button
                type="button"
                className="bmenu-zoom-step"
                disabled={zoomPercent >= 150}
                onClick={() => void handleZoom("in")}
                title="放大页面"
              >
                +
              </button>
            </div>
            <button
              type="button"
              className="bmenu-zoom-reset"
              disabled={zoomPercent === 100}
              onClick={() => void handleZoom("reset")}
              title="重置为 100%"
            >
              <IconRefresh size={12} />
            </button>
          </div>
        </div>

        <div className="bmenu-sep" />

        <button
          type="button"
          role="menuitem"
          className="bmenu-item"
          disabled={!hasWebUrl}
          onClick={() => void runAction("copy-url")}
        >
          <IconCopy size={14} />
          <span>复制当前网址</span>
        </button>

        <button
          type="button"
          role="menuitem"
          className="bmenu-item"
          disabled={!hasWebUrl}
          onClick={() => void runAction("open-external")}
        >
          <IconExternalLink size={14} />
          <span>在系统浏览器中打开</span>
        </button>

        <div className="bmenu-sep" />

        <button
          type="button"
          role="menuitem"
          className="bmenu-item"
          onClick={() => void runAction("import-cookie")}
        >
          <IconKey size={14} />
          <span>从本机浏览器导入登录态…</span>
        </button>

        <button
          type="button"
          role="menuitem"
          className="bmenu-item"
          onClick={() => void runAction("open-downloads")}
        >
          <IconFolder size={14} />
          <span>打开下载目录</span>
        </button>
      </div>
    </div>
  );
};
