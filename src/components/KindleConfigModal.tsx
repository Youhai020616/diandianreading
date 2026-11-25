import React, { useEffect, useState } from "react";
import type { ConnectionsSnapshot, PublicKindleSettings } from "../types/desktop";
import { CustomSelect } from "./CustomSelect";
import { IconCheck, IconChevronRight, IconClose, IconEye, IconShield } from "./Icons";

interface KindleConfigModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: (snapshot: ConnectionsSnapshot | null) => void;
  onNotify: (msg: string, tone?: "info" | "success" | "error") => void;
}

interface SmtpPreset {
  id: string;
  name: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: "tls" | "starttls";
  fromPlaceholder: string;
  passHint: string;
}

const SMTP_PRESETS: SmtpPreset[] = [
  {
    id: "qq",
    name: "QQ 邮箱",
    smtpHost: "smtp.qq.com",
    smtpPort: 465,
    smtpSecurity: "tls",
    fromPlaceholder: "例如 123456@qq.com",
    passHint: "在 QQ 邮箱「设置 → 账号 → POP3/SMTP 服务」中生成的 16 位授权码",
  },
  {
    id: "163",
    name: "网易 163",
    smtpHost: "smtp.163.com",
    smtpPort: 465,
    smtpSecurity: "tls",
    fromPlaceholder: "例如 yourname@163.com",
    passHint: "在网易邮箱「设置 → POP3/SMTP/IMAP」中开启并生成的授权密码",
  },
  {
    id: "gmail",
    name: "Gmail",
    smtpHost: "smtp.gmail.com",
    smtpPort: 587,
    smtpSecurity: "starttls",
    fromPlaceholder: "例如 yourname@gmail.com",
    passHint: "开启两步验证后，在 Google 账号「应用专用密码」中生成 16 位密码",
  },
  {
    id: "outlook",
    name: "Outlook",
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    smtpSecurity: "starttls",
    fromPlaceholder: "例如 yourname@outlook.com",
    passHint: "填写 Outlook 邮箱应用密码（需开启 SMTP AUTH）",
  },
  {
    id: "custom",
    name: "自定义",
    smtpHost: "",
    smtpPort: 465,
    smtpSecurity: "tls",
    fromPlaceholder: "发件邮箱地址",
    passHint: "请填写该邮箱服务商提供的 SMTP 授权码或应用专用密码",
  },
];

function detectPresetId(host: string): string {
  const clean = host.trim().toLowerCase();
  const hit = SMTP_PRESETS.find((p) => p.id !== "custom" && p.smtpHost === clean);
  if (hit) return hit.id;
  return clean ? "custom" : "qq";
}

export const KindleConfigModal: React.FC<KindleConfigModalProps> = ({
  open,
  onClose,
  onSaved,
  onNotify,
}) => {
  const [loading, setLoading] = useState(false);
  const [presetId, setPresetId] = useState("qq");
  const [to, setTo] = useState("");
  const [from, setFrom] = useState("");
  const [smtpHost, setSmtpHost] = useState("smtp.qq.com");
  const [smtpPort, setSmtpPort] = useState("465");
  const [smtpSecurity, setSmtpSecurity] = useState<"tls" | "starttls">("tls");

  const [hasSavedPass, setHasSavedPass] = useState(false);
  const [editingPass, setEditingPass] = useState(true);
  const [clearPass, setClearPass] = useState(false);
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testState, setTestState] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setErrorMsg(null);
    setTestState(null);
    setPassword("");
    setShowPass(false);
    setClearPass(false);

    void window.diandian.router
      .getKindleConfig()
      .then((cfg: PublicKindleSettings) => {
        if (!active) return;
        const detected = detectPresetId(cfg.smtpHost);
        const preset = SMTP_PRESETS.find((p) => p.id === detected) ?? SMTP_PRESETS[0]!;
        setPresetId(detected);
        setTo(cfg.to || "");
        setFrom(cfg.from || "");
        setSmtpHost(cfg.smtpHost || preset.smtpHost);
        setSmtpPort(String(cfg.smtpPort || preset.smtpPort));
        setSmtpSecurity(cfg.smtpHost ? cfg.smtpSecurity : preset.smtpSecurity);
        setHasSavedPass(cfg.hasPassword);
        setEditingPass(!cfg.hasPassword);
        setAdvancedOpen(detected === "custom");
      })
      .catch(() => {
        if (!active) return;
        setPresetId("qq");
        setSmtpHost("smtp.qq.com");
        setSmtpPort("465");
        setSmtpSecurity("tls");
        setHasSavedPass(false);
        setEditingPass(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving && !testing) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, saving, testing, onClose]);

  if (!open) return null;

  const activePreset = SMTP_PRESETS.find((p) => p.id === presetId) ?? SMTP_PRESETS[0]!;

  const handleSelectPreset = (preset: SmtpPreset) => {
    setPresetId(preset.id);
    setErrorMsg(null);
    setTestState(null);
    if (preset.id !== "custom") {
      setSmtpHost(preset.smtpHost);
      setSmtpPort(String(preset.smtpPort));
      setSmtpSecurity(preset.smtpSecurity);
      setAdvancedOpen(false);
    } else {
      setAdvancedOpen(true);
    }
  };

  const handleFromBlur = () => {
    const clean = from.trim().toLowerCase();
    if (!clean.includes("@")) return;
    const domain = clean.split("@")[1] ?? "";
    if (domain === "qq.com" || domain === "foxmail.com") {
      handleSelectPreset(SMTP_PRESETS[0]!);
    } else if (domain === "163.com") {
      handleSelectPreset(SMTP_PRESETS[1]!);
    } else if (domain === "gmail.com") {
      handleSelectPreset(SMTP_PRESETS[2]!);
    } else if (domain === "outlook.com" || domain === "hotmail.com" || domain === "live.com") {
      handleSelectPreset(SMTP_PRESETS[3]!);
    }
  };

  const handleTest = async () => {
    setErrorMsg(null);
    setTestState(null);
    const trimmedFrom = from.trim();
    const trimmedHost = smtpHost.trim();
    const parsedPort = Number(smtpPort);
    const useSaved = hasSavedPass && !editingPass && !clearPass;
    if (!trimmedFrom || !trimmedHost) {
      setErrorMsg("请先填写发件邮箱和 SMTP 服务器");
      return;
    }
    if (!useSaved && !password.trim()) {
      setErrorMsg("请先输入邮箱 SMTP 授权码再测试连接");
      return;
    }
    setTesting(true);
    try {
      const res = await window.diandian.router.testKindleConfig({
        from: trimmedFrom,
        smtpHost: trimmedHost,
        smtpPort: parsedPort,
        smtpSecurity,
        password: password.trim() || undefined,
        useSavedPassword: useSaved,
      });
      if (res.ok) {
        setTestState({ ok: true, text: `SMTP 认证成功（耗时 ${res.latencyMs}ms）` });
      } else {
        setTestState({ ok: false, text: res.message });
      }
    } catch (error) {
      setTestState({ ok: false, text: error instanceof Error ? error.message : "测试连接失败" });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    const useSaved = hasSavedPass && !clearPass && !password.trim();
    if (!to.trim()) {
      setErrorMsg("请填写 Kindle 收件邮箱（如 xxx@kindle.com）");
      return;
    }
    if (!from.trim()) {
      setErrorMsg("请填写发件邮箱地址");
      return;
    }
    if (!smtpHost.trim()) {
      setErrorMsg("请填写 SMTP 服务器地址");
      return;
    }
    if (!useSaved && !password.trim()) {
      setErrorMsg("请填写发件邮箱的 SMTP 授权码");
      return;
    }

    setSaving(true);
    try {
      const res = await window.diandian.router.saveKindleConfig({
        to: to.trim(),
        from: from.trim(),
        smtpHost: smtpHost.trim(),
        smtpPort: Number(smtpPort) || 465,
        smtpSecurity,
        password: password.trim() || undefined,
        clearPassword: clearPass,
      });
      onSaved(res.snapshot);
      onNotify("Kindle 邮件推送配置已加密保存", "success");
      onClose();
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => !saving && !testing && onClose()}>
      <div className="modal-card mset-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mset-header">
          <div>
            <h3 className="mset-title">Kindle 邮件推送设置</h3>
            <p className="mset-subtitle">配置后，下载的电子书可直接通过本机加密 SMTP 推送到 Kindle</p>
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

        <form onSubmit={(e) => void handleSave(e)}>
          {loading ? (
            <div className="muted-box" style={{ padding: "24px 12px", marginBottom: 14 }}>
              正在读取已保存配置…
            </div>
          ) : (
            <>
              {/* 1. Email Provider Presets */}
              <div className="field-group">
                <div className="mset-label-row">
                  <label className="field-label" style={{ marginBottom: 0 }}>
                    发件邮箱服务商
                  </label>
                  <span style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                    选好后自动填入服务器与端口
                  </span>
                </div>
                <div className="kindle-preset-grid">
                  {SMTP_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={`kindle-preset-pill ${presetId === p.id ? "active" : ""}`}
                      onClick={() => handleSelectPreset(p)}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* 2. Kindle & Sender Addresses */}
              <div className="field-group">
                <label className="field-label" htmlFor="kindle-to-input">
                  Kindle 收件邮箱
                </label>
                <input
                  id="kindle-to-input"
                  className="input"
                  type="email"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="例如 yourname@kindle.com 或 yourname@kindle.cn"
                  autoComplete="off"
                />
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="kindle-from-input">
                  发件邮箱
                </label>
                <input
                  id="kindle-from-input"
                  className="input"
                  type="email"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  onBlur={handleFromBlur}
                  placeholder={activePreset.fromPlaceholder}
                  autoComplete="off"
                />
              </div>

              {/* 3. Encrypted SMTP Auth Code */}
              <div className="field-group">
                <label className="field-label" htmlFor="kindle-pass-input">
                  邮箱 SMTP 授权码
                </label>

                {hasSavedPass && !editingPass && !clearPass ? (
                  <div className="mset-saved-bar">
                    <div className="mset-saved-left">
                      <span className="mset-saved-dot" />
                      <span>已通过系统级安全存储加密保存</span>
                    </div>
                    <div className="mset-saved-actions">
                      <button
                        type="button"
                        className="mset-inline-btn"
                        onClick={() => {
                          setEditingPass(true);
                          setClearPass(false);
                        }}
                      >
                        更换
                      </button>
                      <button
                        type="button"
                        className="mset-inline-btn danger"
                        onClick={() => {
                          setClearPass(true);
                          setEditingPass(true);
                          setPassword("");
                          setTestState(null);
                        }}
                      >
                        清除
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mset-key-input-wrap">
                    <div className="mset-key-field">
                      <input
                        id="kindle-pass-input"
                        type={showPass ? "text" : "password"}
                        className="input mset-key-input"
                        value={password}
                        onChange={(e) => {
                          setPassword(e.target.value);
                          setClearPass(false);
                          setTestState(null);
                        }}
                        placeholder="粘贴邮箱 SMTP 授权码 / 应用专用密码…"
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        className="mset-key-eye"
                        onClick={() => setShowPass((v) => !v)}
                        title={showPass ? "隐藏授权码" : "显示授权码"}
                        aria-label={showPass ? "隐藏授权码" : "显示授权码"}
                      >
                        <IconEye size={14} />
                      </button>
                    </div>
                    {hasSavedPass && (
                      <button
                        type="button"
                        className="mset-inline-btn"
                        onClick={() => {
                          setEditingPass(false);
                          setClearPass(false);
                          setPassword("");
                        }}
                      >
                        取消
                      </button>
                    )}
                  </div>
                )}

                <div className="mset-privacy-note">
                  <IconShield size={12} />
                  <span>{activePreset.passHint}；授权码仅保存在本机系统钥匙串加密区。</span>
                </div>
              </div>

              {/* 4. Collapsible Advanced SMTP Settings */}
              <div className="mset-advanced-wrap">
                <button
                  type="button"
                  className={`mset-advanced-toggle ${advancedOpen ? "open" : ""}`}
                  onClick={() => setAdvancedOpen((v) => !v)}
                >
                  <IconChevronRight size={13} />
                  <span>
                    高级 SMTP 设置（{smtpHost || "未填"}:{smtpPort} · {smtpSecurity.toUpperCase()}）
                  </span>
                </button>
                {advancedOpen && (
                  <div className="mset-advanced-panel">
                    <div className="field-group" style={{ marginBottom: 10 }}>
                      <label className="field-label">SMTP 服务器地址</label>
                      <input
                        className="input"
                        value={smtpHost}
                        onChange={(e) => setSmtpHost(e.target.value)}
                        placeholder="smtp.qq.com"
                      />
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <div className="field-group" style={{ marginBottom: 0 }}>
                        <label className="field-label">端口</label>
                        <input
                          className="input"
                          type="number"
                          value={smtpPort}
                          onChange={(e) => setSmtpPort(e.target.value)}
                          placeholder="465"
                        />
                      </div>
                      <div className="field-group" style={{ marginBottom: 0 }}>
                        <label className="field-label">加密方式</label>
                        <CustomSelect
                          size="sm"
                          value={smtpSecurity}
                          onChange={(val) => {
                            const sec = val === "starttls" ? "starttls" : "tls";
                            setSmtpSecurity(sec);
                            if (sec === "tls" && smtpPort === "587") setSmtpPort("465");
                            if (sec === "starttls" && smtpPort === "465") setSmtpPort("587");
                          }}
                          ariaLabel="SMTP 加密方式"
                          options={[
                            { value: "tls", label: "SSL / TLS（465）" },
                            { value: "starttls", label: "STARTTLS（587）" },
                          ]}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="kindle-whitelist-tip">
                首次推送前，请确认发件邮箱已加入亚马逊「管理我的内容和设备 → 首选项 → 已认可的发件人电子邮箱列表」。
              </div>

              {testState && (
                <div className={`mset-feedback ${testState.ok ? "ok" : "error"}`}>
                  {testState.ok && <IconCheck size={14} />}
                  <span>{testState.text}</span>
                </div>
              )}

              {errorMsg && <div className="mset-feedback error">{errorMsg}</div>}
            </>
          )}

          <div className="mset-footer">
            <button
              type="button"
              className="btn mset-test-btn"
              disabled={loading || testing || saving}
              onClick={() => void handleTest()}
            >
              {testing ? "测试中…" : "测试 SMTP 连接"}
            </button>
            <div className="mset-footer-right">
              <button
                type="button"
                className="btn"
                disabled={saving || testing}
                onClick={onClose}
              >
                取消
              </button>
              <button type="submit" className="btn primary" disabled={loading || saving || testing}>
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
