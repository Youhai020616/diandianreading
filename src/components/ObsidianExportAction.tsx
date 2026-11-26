import { useEffect, useRef, useState } from "react";
import type { ObsidianExportOutcome } from "../types/desktop";
import { formatUserError } from "../utils/formatError";
import { IconBookOpen, IconExternalLink } from "./Icons";
import { ObsidianVaultPicker } from "./ObsidianVaultPicker";

interface ObsidianExportActionProps {
  kind: "book" | "draft";
  itemId: string;
  title: string;
}

export function ObsidianExportAction({ kind, itemId, title }: ObsidianExportActionProps) {
  const [phase, setPhase] = useState<"idle" | "checking" | "choosing" | "exporting">("idle");
  const [result, setResult] = useState<ObsidianExportOutcome | null>(null);
  const [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const pickerHeading = useRef<HTMLHeadingElement>(null);
  const api = window.diandian.obsidian;

  useEffect(() => {
    if (phase === "choosing") pickerHeading.current?.focus();
  }, [phase]);

  async function exportItem() {
    if (!trigger.current) return;
    setPhase("exporting");
    try {
      const outcome = kind === "book" ? await api.exportBook(itemId) : await api.exportDraft(itemId);
      setResult(outcome);
    } catch (cause) {
      setError(formatUserError(cause, "导出失败，请重试。"));
    } finally {
      setPhase("idle");
    }
  }

  async function startExport() {
    setResult(null);
    setError("");
    setPhase("checking");
    try {
      const { vaultPath } = await api.getVault();
      if (!trigger.current) return;
      if (vaultPath) await exportItem();
      else setPhase("choosing");
    } catch (cause) {
      setError(formatUserError(cause, "无法读取已连接的笔记库，请重试。"));
      setPhase("idle");
    }
  }

  const itemLabel = kind === "book" ? `《${title}》的划线` : `草稿《${title}》`;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="btn sm"
        disabled={phase !== "idle"}
        onClick={() => void startExport()}
      >
        <IconBookOpen size={12} />
        {phase === "exporting" ? "正在导出…" : "导出到 Obsidian"}
      </button>
      {phase === "choosing" && (
        <section className="obsidian-export-setup">
          <h4 ref={pickerHeading} tabIndex={-1}>选择笔记库，导出{itemLabel}</h4>
          <ObsidianVaultPicker
            actionLabel="连接并导出"
            manualActionLabel="选择文件夹并导出"
            onConnect={exportItem}
            onCancel={() => {
              setPhase("idle");
              requestAnimationFrame(() => trigger.current?.focus());
            }}
          />
        </section>
      )}
      {result && (
        <div className="obsidian-export-receipt" data-status={result.status} role="status">
          <span>{result.status === "written" ? `${itemLabel}已导出。` : result.message}</span>
          <button type="button" className="btn sm" onClick={() => {
            void api.openDeepLink(result.deepLink).catch(cause => setError(formatUserError(cause, "无法打开 Obsidian。")));
          }}>
            <IconExternalLink size={12} /> 在 Obsidian 中打开
          </button>
        </div>
      )}
      {error && <div className="obsidian-export-error" role="alert">{error}</div>}
    </>
  );
}
