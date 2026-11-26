import React, { useEffect, useState } from "react";
import type { TwinProfileState } from "../../types/desktop";
import { IconCheck } from "../Icons";
import { MarkdownText } from "../MarkdownText";

interface TwinProfileSectionProps {
  onNotify(msg: string, tone?: "info" | "success" | "error"): void;
}

/** PROFILE.md and STYLE.md: the reading profile and writing style the agent follows. */
export const TwinProfileSection: React.FC<TwinProfileSectionProps> = ({ onNotify }) => {
  const [twin, setTwin] = useState<TwinProfileState | null>(null);
  const [profileMd, setProfileMd] = useState("");
  const [styleMd, setStyleMd] = useState("");
  const [twinViewMode, setTwinViewMode] = useState<"preview" | "edit">("preview");
  const [savingTwin, setSavingTwin] = useState(false);


  useEffect(() => {
    void window.diandian.twin.get().then((t) => {
      setTwin(t);
      setProfileMd(t.profileMd);
      setStyleMd(t.styleMd);
    });
  }, []);

  const handleSaveTwin = async () => {
    setSavingTwin(true);
    try {
      const saved = await window.diandian.twin.save({ profileMd, styleMd });
      setTwin(saved);
      onNotify("个人画像与表达风格已保存，下一轮 AI 对话即时生效（无需重启）", "success");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "保存失败", "error");
    } finally {
      setSavingTwin(false);
    }
  };

  return (
    <section className="editorial-card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0, fontFamily: "var(--font-serif)", fontSize: 16 }}>
            个人阅读画像与去 AI 味风格
          </h3>
          <div style={{ fontSize: 12.5, color: "var(--ink-muted)", marginTop: 3, lineHeight: 1.45 }}>
            保存后即刻生效，让每次共读与写作都更懂你的背景和表达习惯。
          </div>
        </div>
        <div className="cvis-seg" style={{ flexShrink: 0 }}>
          <button
            type="button"
            className={`cvis-seg-btn ${twinViewMode === "preview" ? "active" : ""}`}
            onClick={() => setTwinViewMode("preview")}
          >
            预览
          </button>
          <button
            type="button"
            className={`cvis-seg-btn ${twinViewMode === "edit" ? "active" : ""}`}
            onClick={() => setTwinViewMode("edit")}
          >
            编辑
          </button>
        </div>
      </div>

      <div className="field-group">
        <label className="field-label">PROFILE.md · 你的关注领域、身份与阅读目标</label>
        {twinViewMode === "preview" ? (
          <div
            className="md-preview-box"
            onDoubleClick={() => setTwinViewMode("edit")}
          >
            <MarkdownText content={profileMd || "暂无内容"} />
          </div>
        ) : (
          <textarea
            className="textarea md-textarea"
            rows={6}
            value={profileMd}
            onChange={(e) => setProfileMd(e.target.value)}
          />
        )}
      </div>

      <div className="field-group">
        <label className="field-label">STYLE.md · 你的写作口吻与去 AI 味习惯</label>
        {twinViewMode === "preview" ? (
          <div
            className="md-preview-box"
            onDoubleClick={() => setTwinViewMode("edit")}
          >
            <MarkdownText content={styleMd || "暂无内容"} />
          </div>
        ) : (
          <textarea
            className="textarea md-textarea"
            rows={9}
            value={styleMd}
            onChange={(e) => setStyleMd(e.target.value)}
          />
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
          {twin?.updatedAt ? `上次保存：${new Date(twin.updatedAt).toLocaleString("zh-CN")}` : ""}
        </span>
        <button
          type="button"
          className="btn primary"
          onClick={() => void handleSaveTwin()}
          disabled={savingTwin}
        >
          <IconCheck size={14} />
          <span>{savingTwin ? "保存中…" : "保存并生效"}</span>
        </button>
      </div>
    </section>
  );
};
