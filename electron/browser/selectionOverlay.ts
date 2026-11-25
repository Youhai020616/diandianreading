export type BrowserSelectionActionKind = "save" | "ask" | "draft";

export interface BrowserSelectionActionEvent {
  action: BrowserSelectionActionKind;
  text: string;
  title: string;
  url: string;
}

export const SELECTION_SIGNAL_PREFIX = "__DIANDIAN_SEL__:";

/**
 * Build a self-contained Shadow-DOM selection toolbar injected into pages inside
 * our right-hand WebContentsView. Uses a closure-scoped per-tab secret nonce so
 * third-party pages cannot spoof actions and never receive Node/IPC privileges.
 */
export function buildSelectionToolbarScript(nonce: string): string {
  const safeNonce = JSON.stringify(nonce);
  const safePrefix = JSON.stringify(SELECTION_SIGNAL_PREFIX);

  return `(() => {
    if (window.__diandianSelOverlayInstalled) return;
    window.__diandianSelOverlayInstalled = true;

    const NONCE = ${safeNonce};
    const PREFIX = ${safePrefix};
    let lastSelectedText = "";

    const host = document.createElement("div");
    host.id = "diandian-selection-host";
    host.style.position = "fixed";
    host.style.zIndex = "2147483647";
    host.style.display = "none";
    host.style.pointerEvents = "auto";
    const shadow = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = \`
      .bar {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        padding: 4px;
        border-radius: 999px;
        background: #1d1a16;
        border: 1px solid rgba(255, 244, 230, 0.16);
        box-shadow: 0 8px 22px rgba(0, 0, 0, 0.28);
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
      }
      button {
        border: none;
        background: transparent;
        color: #f6f0e6;
        font-size: 12px;
        font-weight: 500;
        padding: 5px 10px;
        border-radius: 999px;
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.12s ease;
      }
      button:hover {
        background: rgba(217, 139, 95, 0.24);
        color: #ffd7bd;
      }
      .sep {
        width: 1px;
        height: 12px;
        background: rgba(255, 244, 230, 0.16);
      }
    \`;

    const bar = document.createElement("div");
    bar.className = "bar";

    const makeBtn = (label, action) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const sel = (window.getSelection ? window.getSelection().toString() : "").trim() || lastSelectedText;
        if (!sel) return;
        window.__diandianLastSelection = sel.slice(0, 4000);
        console.debug(PREFIX + NONCE + ":" + action);
        hideBar();
      });
      return btn;
    };

    const sep1 = document.createElement("span");
    sep1.className = "sep";
    const sep2 = document.createElement("span");
    sep2.className = "sep";

    bar.appendChild(makeBtn("存书库", "save"));
    bar.appendChild(sep1);
    bar.appendChild(makeBtn("问小金毛", "ask"));
    bar.appendChild(sep2);
    bar.appendChild(makeBtn("写草稿", "draft"));

    shadow.appendChild(style);
    shadow.appendChild(bar);
    document.documentElement.appendChild(host);

    const hideBar = () => {
      host.style.display = "none";
    };

    const positionBar = () => {
      const sel = window.getSelection ? window.getSelection() : null;
      const text = sel ? sel.toString().trim() : "";
      if (!sel || sel.isCollapsed || text.length < 4 || sel.rangeCount === 0) {
        hideBar();
        return;
      }
      lastSelectedText = text;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        hideBar();
        return;
      }
      const barW = 224;
      const left = Math.max(10, Math.min(window.innerWidth - barW - 10, rect.left + rect.width / 2 - barW / 2));
      const top = rect.top > 48 ? rect.top - 42 : Math.min(window.innerHeight - 44, rect.bottom + 8);
      host.style.left = Math.round(left) + "px";
      host.style.top = Math.round(top) + "px";
      host.style.display = "block";
    };

    document.addEventListener("mouseup", () => {
      setTimeout(positionBar, 30);
    });
    document.addEventListener("keyup", () => {
      setTimeout(positionBar, 30);
    });
    document.addEventListener("scroll", hideBar, true);
    document.addEventListener("mousedown", (e) => {
      if (e.target !== host) hideBar();
    });
  })();`;
}
