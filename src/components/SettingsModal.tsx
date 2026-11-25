import React, { useEffect, useState } from "react";
import type { PublicModelSettings } from "../types/desktop";
import { CustomSelect } from "./CustomSelect";
import {
  IconCheck,
  IconChevronRight,
  IconClose,
  IconExternalLink,
  IconEye,
  IconShield,
  IconZap,
} from "./Icons";

interface SettingsModalProps {
  open: boolean;
  initial: PublicModelSettings | null;
  onClose: () => void;
  onSaved: (next: PublicModelSettings) => void;
}

type ProviderPresetId = "deepseek" | "kimi" | "qwen" | "glm" | "openai" | "custom";

interface ModelChoice {
  id: string;
  title: string;
  tag?: string;
  desc: string;
}

interface ProviderPreset {
  id: ProviderPresetId;
  label: string;
  description: string;
  backendProvider: "deepseek" | "openai-compatible";
  baseUrl: string;
  hasPortal: boolean;
  keyPlaceholder: string;
  models: ModelChoice[];
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek（推荐）",
    description: "性价比高，中文阅读理解与去 AI 味写作表现出色",
    backendProvider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    hasPortal: true,
    keyPlaceholder: "粘贴 DeepSeek 密钥（sk-...）",
    models: [
      { id: "deepseek-chat", title: "日常共读 · V3", tag: "推荐", desc: "响应迅速，适合划词讨论与写稿" },
      { id: "deepseek-reasoner", title: "深度思考 · R1", desc: "展示推理链，适合复杂跨书思辨" },
    ],
  },
  {
    id: "kimi",
    label: "Kimi（月之暗面）",
    description: "擅长长文本阅读、书摘梳理与多段落润色",
    backendProvider: "openai-compatible",
    baseUrl: "https://api.moonshot.cn/v1",
    hasPortal: true,
    keyPlaceholder: "粘贴 Kimi 密钥（sk-...）",
    models: [
      { id: "kimi-k2-0711-preview", title: "Kimi K2", tag: "推荐", desc: "新一代旗舰，逻辑与中文表达均衡" },
      { id: "moonshot-v1-128k", title: "Moonshot 128K", desc: "适合超长章节与多书整理" },
    ],
  },
  {
    id: "qwen",
    label: "通义千问（阿里云百炼）",
    description: "国内访问稳定，中文语义理解细腻",
    backendProvider: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    hasPortal: true,
    keyPlaceholder: "粘贴阿里云百炼密钥（sk-...）",
    models: [
      { id: "qwen-plus", title: "通义千问 Plus", tag: "推荐", desc: "速度与写作质量均衡" },
      { id: "qwen-max", title: "通义千问 Max", desc: "更强深度分析与长文写作" },
    ],
  },
  {
    id: "glm",
    label: "智谱清言（GLM）",
    description: "响应极速，适合高频共读与随手提问",
    backendProvider: "openai-compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    hasPortal: true,
    keyPlaceholder: "粘贴智谱开放平台密钥",
    models: [
      { id: "glm-4-plus", title: "GLM-4 Plus", tag: "推荐", desc: "综合理解与写作能力强" },
      { id: "glm-4-flash", title: "GLM-4 Flash", desc: "轻量极速，适合快速问答" },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    description: "GPT-4.1 系列官方接口（需自备网络环境）",
    backendProvider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    hasPortal: true,
    keyPlaceholder: "粘贴 OpenAI 密钥（sk-...）",
    models: [
      { id: "gpt-4.1-mini", title: "GPT-4.1 Mini", tag: "推荐", desc: "响应快、日常性价比高" },
      { id: "gpt-4.1", title: "GPT-4.1", desc: "旗舰深度理解与写作" },
    ],
  },
  {
    id: "custom",
    label: "自定义接口 / 本地 Ollama",
    description: "支持任意 OpenAI 兼容中转站或本机私有模型",
    backendProvider: "openai-compatible",
    baseUrl: "",
    hasPortal: false,
    keyPlaceholder: "粘贴接口密钥（本地 Ollama 可留空）",
    models: [],
  },
];

function detectPresetFromSettings(settings: PublicModelSettings | null): ProviderPresetId {
  if (!settings) return "deepseek";
  const url = (settings.baseUrl || "").trim().toLowerCase().replace(/\/+$/, "");
  if (settings.provider === "deepseek" && (!url || url.includes("api.deepseek.com"))) return "deepseek";
  if (url.includes("api.deepseek.com")) return "deepseek";
  if (url.includes("api.moonshot.cn")) return "kimi";
  if (url.includes("dashscope.aliyuncs.com")) return "qwen";
  if (url.includes("open.bigmodel.cn")) return "glm";
  if (url.includes("api.openai.com")) return "openai";
  return "custom";
}

function getPresetById(id: ProviderPresetId): ProviderPreset {
  return PROVIDER_PRESETS.find((p) => p.id === id) ?? PROVIDER_PRESETS[0]!;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ open, initial, onClose, onSaved }) => {
  const [initialPresetId, setInitialPresetId] = useState<ProviderPresetId>("deepseek");
  const [presetId, setPresetId] = useState<ProviderPresetId>("deepseek");
  const [model, setModel] = useState("deepseek-chat");
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [editingKey, setEditingKey] = useState(false);
  const [pendingClear, setPendingClear] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    const detected = detectPresetFromSettings(initial);
    const preset = getPresetById(detected);
    setInitialPresetId(detected);
    setPresetId(detected);
    setModel(initial?.model || preset.models[0]?.id || "deepseek-chat");
    setBaseUrl(initial?.baseUrl || preset.baseUrl || "https://api.deepseek.com/v1");
    setApiKey("");
    setShowKey(false);
    setEditingKey(!initial?.hasApiKey);
    setPendingClear(false);
    setAdvancedOpen(detected === "custom");
    setTestResult(null);
    setError("");
  }, [open, initial]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving && !testing) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, saving, testing, onClose]);

  if (!open) return null;

  const activePreset = getPresetById(presetId);
  const switchedProvider = presetId !== initialPresetId;
  const canReuseSavedKey = Boolean(initial?.hasApiKey) && !switchedProvider && !pendingClear;
  const showSavedKeyBar = canReuseSavedKey && !editingKey;

  const handlePresetChange = (nextId: ProviderPresetId) => {
    const nextPreset = getPresetById(nextId);
    setPresetId(nextId);
    setTestResult(null);
    setError("");
    if (nextId === "custom") {
      setAdvancedOpen(true);
      if (!baseUrl || PROVIDER_PRESETS.some((p) => p.baseUrl && p.baseUrl === baseUrl)) {
        setBaseUrl("http://127.0.0.1:11434/v1");
      }
      if (!model || PROVIDER_PRESETS.some((p) => p.models.some((m) => m.id === model))) {
        setModel("qwen2.5:7b");
      }
    } else {
      setBaseUrl(nextPreset.baseUrl);
      setModel(nextPreset.models[0]?.id ?? "deepseek-chat");
      setAdvancedOpen(false);
    }
    if (nextId !== initialPresetId) {
      setEditingKey(true);
      setPendingClear(false);
    } else if (initial?.hasApiKey) {
      setEditingKey(false);
      setPendingClear(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    setError("");
    try {
      const res = await window.diandian.settings.testModel({
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        useSavedKey: canReuseSavedKey && !apiKey.trim(),
      });
      if (res.ok) {
        setTestResult({ ok: true, message: `连接正常（响应 ${res.latencyMs}ms），可以安心保存使用` });
      } else {
        setTestResult({ ok: false, message: res.message });
      }
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : "测试连接失败，请稍后重试",
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!model.trim()) {
      setError("请选择或填写模型名称");
      return;
    }
    if (!baseUrl.trim()) {
      setError("请填写接口地址（Base URL）");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const saved = await window.diandian.settings.saveModel({
        provider: activePreset.backendProvider,
        model: model.trim(),
        baseUrl: baseUrl.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(pendingClear ? { clearApiKey: true } : {}),
      });
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const isCustomModelForPreset =
    activePreset.models.length > 0 && !activePreset.models.some((m) => m.id === model);

  return (
    <div className="modal-backdrop" onClick={() => !saving && !testing && onClose()}>
      <div className="modal-card mset-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mset-header">
          <div>
            <h3 className="mset-title">AI 模型设置</h3>
            <p className="mset-subtitle">填写你自己的大模型 API 密钥，共读与创作均由本机直连</p>
          </div>
          <button
            type="button"
            className="btn icon-only ghost"
            disabled={saving || testing}
            onClick={onClose}
            aria-label="关闭"
          >
            <IconClose size={16} />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)}>
          {/* 1. AI Service Preset */}
          <div className="field-group">
            <label className="field-label">AI 服务</label>
            <CustomSelect
              value={presetId}
              onChange={(val) => handlePresetChange(val as ProviderPresetId)}
              ariaLabel="AI 服务"
              options={PROVIDER_PRESETS.map((p) => ({
                value: p.id,
                label: p.label,
                description: p.description,
              }))}
            />
          </div>

          {/* 2. Human-friendly Model Picker Cards (for preset services) */}
          {activePreset.models.length > 0 && (
            <div className="field-group">
              <label className="field-label">
                使用模式{isCustomModelForPreset ? `（当前自定义：${model}）` : ""}
              </label>
              <div className="mset-model-grid">
                {activePreset.models.map((opt) => {
                  const selected = model === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      className={`mset-model-card ${selected ? "active" : ""}`}
                      onClick={() => {
                        setModel(opt.id);
                        setTestResult(null);
                      }}
                    >
                      <div className="mset-model-card-top">
                        <span className="mset-model-card-title">{opt.title}</span>
                        {opt.tag && <span className="mset-model-tag">{opt.tag}</span>}
                      </div>
                      <div className="mset-model-card-desc">{opt.desc}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 3. Clean API Key Section */}
          <div className="field-group">
            <div className="mset-label-row">
              <label className="field-label" style={{ margin: 0 }}>
                API 密钥
              </label>
              {activePreset.hasPortal && (
                <button
                  type="button"
                  className="mset-portal-link"
                  onClick={() => void window.diandian.settings.openKeyPortal(activePreset.id)}
                >
                  <span>去获取密钥</span>
                  <IconExternalLink size={11} />
                </button>
              )}
            </div>

            {showSavedKeyBar ? (
              <div className="mset-saved-bar">
                <div className="mset-saved-left">
                  <span className="mset-saved-dot" />
                  <span>
                    {initial?.apiKeySource === "env" ? "已读取本机环境变量密钥" : "已加密保存在本机"}
                  </span>
                </div>
                <div className="mset-saved-actions">
                  <button
                    type="button"
                    className="mset-inline-btn"
                    onClick={() => {
                      setEditingKey(true);
                      setTestResult(null);
                    }}
                  >
                    更换
                  </button>
                  {initial?.apiKeySource === "saved" && (
                    <button
                      type="button"
                      className="mset-inline-btn danger"
                      onClick={() => {
                        setPendingClear(true);
                        setApiKey("");
                        setTestResult(null);
                      }}
                    >
                      清除
                    </button>
                  )}
                </div>
              </div>
            ) : pendingClear ? (
              <div className="mset-cleared-bar">
                <span>保存后将移除本机已保存的密钥</span>
                <button
                  type="button"
                  className="mset-inline-btn"
                  onClick={() => {
                    setPendingClear(false);
                    setEditingKey(false);
                  }}
                >
                  撤销
                </button>
              </div>
            ) : (
              <div className="mset-key-input-wrap">
                <div className="mset-key-field">
                  <input
                    type={showKey ? "text" : "password"}
                    className="input mset-key-input"
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setTestResult(null);
                    }}
                    placeholder={activePreset.keyPlaceholder}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="mset-key-eye"
                    onClick={() => setShowKey((v) => !v)}
                    title={showKey ? "隐藏密钥" : "显示密钥"}
                    aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                  >
                    <IconEye size={14} />
                  </button>
                </div>
                {canReuseSavedKey && (
                  <button
                    type="button"
                    className="mset-inline-btn"
                    onClick={() => {
                      setEditingKey(false);
                      setApiKey("");
                    }}
                  >
                    取消
                  </button>
                )}
              </div>
            )}

            <div className="mset-privacy-note">
              <IconShield size={12} />
              <span>密钥仅使用系统加密保存在本机，不会上传至任何第三方服务器</span>
            </div>
          </div>

          {/* 4. Collapsible Advanced Options (hidden by default for presets) */}
          <div className="mset-advanced-wrap">
            {presetId !== "custom" && (
              <button
                type="button"
                className={`mset-advanced-toggle ${advancedOpen ? "open" : ""}`}
                onClick={() => setAdvancedOpen((v) => !v)}
              >
                <IconChevronRight size={13} />
                <span>高级设置（自定义接口地址与模型名）</span>
              </button>
            )}

            {(advancedOpen || presetId === "custom") && (
              <div className="mset-advanced-panel">
                <div className="field-group" style={{ marginBottom: 10 }}>
                  <label className="field-label">模型代号</label>
                  <input
                    className="input"
                    value={model}
                    onChange={(e) => {
                      setModel(e.target.value);
                      setTestResult(null);
                    }}
                    placeholder="例如 deepseek-chat / gpt-4.1-mini / qwen2.5:7b"
                  />
                </div>
                <div className="field-group" style={{ marginBottom: 0 }}>
                  <label className="field-label">接口地址（Base URL）</label>
                  <input
                    className="input"
                    value={baseUrl}
                    onChange={(e) => {
                      setBaseUrl(e.target.value);
                      setTestResult(null);
                    }}
                    placeholder="https://api.deepseek.com/v1"
                  />
                </div>
              </div>
            )}
          </div>

          {testResult && (
            <div className={`mset-feedback ${testResult.ok ? "ok" : "error"}`}>
              {testResult.ok ? <IconCheck size={14} /> : null}
              <span>{testResult.message}</span>
            </div>
          )}

          {error && <div className="mset-feedback error">{error}</div>}

          <div className="mset-footer">
            <button
              type="button"
              className="btn mset-test-btn"
              disabled={testing || saving}
              onClick={() => void handleTestConnection()}
            >
              <IconZap size={13} />
              <span>{testing ? "测试中…" : "测试连接"}</span>
            </button>

            <div className="mset-footer-right">
              <button type="button" className="btn" disabled={saving} onClick={onClose}>
                取消
              </button>
              <button type="submit" className="btn primary" disabled={saving || testing}>
                <IconCheck size={14} />
                <span>{saving ? "保存中…" : "保存并生效"}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
