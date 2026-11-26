import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ReaderTranslationMode } from "../reader/types";
import type { PublicModelSettings, ReaderTranslationProvider, ReaderTranslationSettings } from "../types/desktop";
import { formatUserError } from "../utils/formatError";
import { IconClose, IconExternalLink } from "./Icons";

type Direction = Exclude<ReaderTranslationMode, "off">;

interface ReaderTranslationPanelProps {
  canTranslate: boolean;
  enabled: boolean;
  activeProvider: ReaderTranslationProvider;
  direction: Direction;
  model: PublicModelSettings | null;
  onEnable(provider: ReaderTranslationProvider, direction: Direction): void;
  onDisable(): void;
  onClose(): void;
  onOpenModelSettings(): void;
}

export function ReaderTranslationPanel({ canTranslate, enabled, activeProvider, direction, model,
  onEnable, onDisable, onClose, onOpenModelSettings }: ReaderTranslationPanelProps) {
  const [settings, setSettings] = useState<ReaderTranslationSettings | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [choice, setChoice] = useState<ReaderTranslationProvider | null>(null);
  const [target, setTarget] = useState(direction);
  const [editingKey, setEditingKey] = useState(false);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const savingRef = useRef(false);
  const provider = choice ?? (enabled ? activeProvider : settings?.provider) ?? "deepl";
  const usesDeepL = provider === "deepl";
  const needsKey = usesDeepL && (!settings?.hasDeepLKey || editingKey);
  const changed = provider !== activeProvider || target !== direction || (usesDeepL && editingKey);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    if (canTranslate) {
      void (async () => {
        try {
          const saved = await window.diandian.reader.getTranslationSettings();
          if (active) setSettings(saved);
        } catch (cause) {
          if (active) setError(formatUserError(cause, "读取翻译设置失败"));
        }
      })();
    }
    return () => { active = false; mounted.current = false; };
  }, [canTranslate, attempt]);

  async function apply(event: FormEvent) {
    event.preventDefault();
    if (!settings || savingRef.current || (needsKey && !key.trim()) || (enabled && !changed)) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      if (settings.provider !== provider || needsKey) {
        await window.diandian.reader.saveTranslationSettings({
          provider,
          apiKey: needsKey ? key.trim() : undefined,
        });
      }
      if (mounted.current) onEnable(provider, target);
    } catch (cause) {
      if (mounted.current) setError(formatUserError(cause, "保存翻译设置失败"));
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  async function openPortal() {
    try { await window.diandian.reader.openDeepLPortal(); }
    catch (cause) { if (mounted.current) setError(formatUserError(cause, "打开 DeepL 密钥页面失败")); }
  }

  return <aside className="lr-settings lr-translation" aria-label="中英对照设置">
    <header className="lr-panel-heading"><h2>中英对照</h2>
      <button type="button" className="lr-icon" aria-label="关闭双语设置" onClick={onClose}><IconClose size={16} /></button>
    </header>
    {!canTranslate ? <p>这本书使用固定版式，暂不支持段落翻译。</p> : !settings ? <>
      <p role="status">{error || "正在读取翻译设置…"}</p>
      {error && <button type="button" className="lr-secondary" onClick={() => { setError(""); setAttempt(n => n + 1); }}>重新读取</button>}
    </> : <form onSubmit={event => void apply(event)}>
      <fieldset className="lr-provider-picker" disabled={saving}>
        <legend>翻译服务</legend>
        <div className="lr-provider-options">
          {(["deepl", "model"] as const).map(value => <label key={value}>
            <input type="radio" name="reader-translation-provider" value={value} checked={provider === value}
              onChange={() => { setChoice(value); setKey(""); setEditingKey(false); setError(""); }} />
            {value === "deepl" ? "DeepL" : model?.provider === "openai-compatible" ? "AI 模型" : "DeepSeek"}
          </label>)}
        </div>
      </fieldset>
      {usesDeepL ? <div className="lr-deepl-key">
        <div className="lr-key-heading">
          <label htmlFor="reader-deepl-key">DeepL API Key</label>
          <button className="lr-link" type="button" onClick={() => void openPortal()}>获取 API Key <IconExternalLink size={12} /></button>
        </div>
        {needsKey ? <>
          <input id="reader-deepl-key" type="password" autoComplete="off" spellCheck={false} value={key}
            placeholder="粘贴 DeepL API 密钥" disabled={saving} onChange={event => setKey(event.target.value)} />
          {editingKey && <button type="button" className="lr-link" disabled={saving} onClick={() => { setEditingKey(false); setKey(""); }}>取消更换</button>}
        </> : <div className="lr-saved-key"><span>密钥已保存在本机</span>
          <button className="lr-link" type="button" onClick={() => setEditingKey(true)}>更换密钥</button></div>}
      </div> : <div className="lr-setting-row lr-model-row"><span>翻译模型</span>
        <button type="button" title="打开模型设置" onClick={onOpenModelSettings}>{model?.model || "设置模型"}</button></div>}
      <label className="lr-setting-row"><span>翻译方向</span>
        <select value={target} disabled={saving} onChange={event => setTarget(event.target.value as Direction)}>
          <option value="auto">中英自动互译</option><option value="zh">译为中文</option><option value="en">译为英文</option>
        </select>
      </label>
      <p>{usesDeepL ? "开启后，当前页附近的段落和打开的目录标题会发送给 DeepL，使用你账户的翻译额度。" :
        "开启后，当前页附近的段落和打开的目录标题会发送给所选模型翻译。"}</p>
      {error && <p className="lr-panel-error" role="alert">{error}</p>}
      <div className="lr-translation-actions">
        {enabled && <button type="button" className="lr-secondary" disabled={saving} onClick={onDisable}>关闭双语</button>}
        {(!enabled || changed) && <button type="submit" className="lr-save" disabled={saving || (needsKey && !key.trim())}>
          {saving ? "正在保存…" : enabled ? "应用更改" : needsKey ? "保存并开启双语" : "开启双语"}
        </button>}
      </div>
    </form>}
  </aside>;
}
