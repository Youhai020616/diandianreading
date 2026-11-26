import { useCallback, useRef, useState } from "react";
import { formatUserError } from "../utils/formatError";

export type ToastTone = "info" | "success" | "error";

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  action?: { label: string; onClick: () => void };
}

/** Main-process error thrown when an Obsidian action runs before a vault is configured (electron/appState.ts). */
const OBSIDIAN_VAULT_MISSING_RE = /请先在「连接与偏好 → Obsidian 联动」中连接/;

/** App-wide toast stack. Errors about a missing Obsidian vault get a shortcut to its settings. */
export function useToasts(openObsidianSettings: () => void) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const openSettings = useRef(openObsidianSettings);
  openSettings.current = openObsidianSettings;

  const notify = useCallback((message: string, tone: ToastTone = "info") => {
    const cleanMsg = tone === "error" ? formatUserError(message, message) : message;
    const id = nextId.current++;
    const dismiss = () => setToasts((prev) => prev.filter((t) => t.id !== id));
    const action = OBSIDIAN_VAULT_MISSING_RE.test(cleanMsg)
      ? {
          label: "去设置",
          onClick: () => {
            dismiss();
            openSettings.current();
          },
        }
      : undefined;
    setToasts((prev) => [...prev.slice(-3), { id, message: cleanMsg, tone, ...(action ? { action } : {}) }]);
    setTimeout(dismiss, action ? 9000 : tone === "error" ? 5200 : 3600);
  }, []);

  const stack = toasts.length > 0 ? (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast-item ${t.tone}`}>
          <span>{t.message}</span>
          {t.action && (
            <button type="button" className="toast-action" onClick={t.action.onClick}>
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  ) : null;

  return { notify, stack };
}
