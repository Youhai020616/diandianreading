import React, { useEffect, useId, useRef, useState } from "react";
import type { ObsidianVaultCandidate } from "../types/desktop";
import { formatUserError } from "../utils/formatError";
import { IconFolder } from "./Icons";
import "./ObsidianVaultPicker.css";

interface ObsidianVaultPickerProps {
  actionLabel: string;
  manualActionLabel?: string;
  onConnect: (vaultPath: string) => Promise<void>;
  busy?: boolean;
  onCancel?: () => void;
  cancelLabel?: string;
}

export function ObsidianVaultPicker({
  actionLabel,
  manualActionLabel,
  onConnect,
  busy = false,
  onCancel,
  cancelLabel = "取消",
}: ObsidianVaultPickerProps) {
  const [vaults, setVaults] = useState<ObsidianVaultCandidate[] | null>(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [scanAttempt, setScanAttempt] = useState(0);
  const [scanFailed, setScanFailed] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const actionPending = useRef(false);
  const radioGroup = useId();
  const disabled = busy || connecting;

  useEffect(() => {
    let current = true;
    async function findVaults() {
      setVaults(null);
      setScanFailed(false);
      setError("");
      try {
        const found = await window.diandian.obsidian.listVaults();
        if (!current) return;
        setSelectedPath(found[0]?.path ?? "");
        setVaults(found);
      } catch {
        if (!current) return;
        setScanFailed(true);
        setVaults([]);
      }
    }
    void findVaults();
    return () => { current = false; };
  }, [scanAttempt]);

  async function connect(path?: string) {
    if (actionPending.current || busy) return;
    actionPending.current = true;
    setConnecting(true);
    setError("");
    try {
      const api = window.diandian.obsidian;
      if (path) {
        const saved = await api.setVault(path);
        await onConnect(saved.vaultPath);
      } else {
        const chosen = await api.pickVault();
        if (!chosen.canceled) await onConnect(chosen.vaultPath);
      }
    } catch (cause) {
      setError(formatUserError(cause, "连接失败，请重试或选择其他文件夹。"));
    } finally {
      actionPending.current = false;
      setConnecting(false);
    }
  }

  const multiple = Boolean(vaults && vaults.length > 1);
  const Row = multiple ? "label" : "div";
  return (
    <div className="vault-picker" aria-busy={disabled}>
      {vaults === null ? (
        <p className="vault-picker-hint" role="status">正在查找 Obsidian 笔记库…</p>
      ) : vaults.length === 0 ? (
        <p className="vault-picker-hint" role="status">
          {scanFailed ? "暂时无法读取 Obsidian 的笔记库列表。" : "没有找到在这台电脑上打开过的 Obsidian 笔记库。"}
        </p>
      ) : (
        <fieldset className="vault-picker-group" disabled={disabled}>
          <legend>{multiple ? "选择要连接的笔记库" : "找到了你的笔记库"}</legend>
          <div className="vault-picker-list">
            {vaults.map((vault) => (
              <Row key={vault.path} className="vault-picker-row" data-selected={vault.path === selectedPath}>
                {multiple ? (
                  <input
                    type="radio"
                    name={radioGroup}
                    value={vault.path}
                    checked={vault.path === selectedPath}
                    onChange={() => { setSelectedPath(vault.path); setError(""); }}
                  />
                ) : (
                  <span className="vault-picker-folder" aria-hidden="true"><IconFolder size={19} /></span>
                )}
                <span className="vault-picker-details">
                  <strong>{vault.name}</strong>
                  <span>{vault.path}</span>
                </span>
              </Row>
            ))}
          </div>
        </fieldset>
      )}
      {error && <p className="vault-picker-error" role="alert">{error}</p>}
      <div className="vault-picker-actions">
        {vaults && vaults.length > 0 && (
          <button type="button" className="btn primary" disabled={disabled} onClick={() => void connect(selectedPath)}>
            {actionLabel}
          </button>
        )}
        {vaults !== null && (
          <button type="button" className={vaults.length ? "btn ghost" : "btn primary"} disabled={disabled} onClick={() => void connect()}>
            <IconFolder size={14} />{manualActionLabel ?? (vaults.length ? "选择其他位置" : "选择笔记库文件夹")}
          </button>
        )}
        {vaults?.length === 0 && (
          <button type="button" className="btn ghost" disabled={disabled} onClick={() => setScanAttempt((n) => n + 1)}>
            重新查找
          </button>
        )}
        {onCancel && (
          <button type="button" className="btn ghost" disabled={disabled} onClick={onCancel}>{cancelLabel}</button>
        )}
      </div>
    </div>
  );
}
