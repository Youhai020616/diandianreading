import React, { useCallback, useEffect, useState } from "react";
import type {
  ConnectionsSnapshot,
  LocalBookMetadata,
  TwinProfileState,
  ZlibDomainHealth,
} from "../types/desktop";
import { CustomSelect } from "./CustomSelect";
import { MarkdownText } from "./MarkdownText";
import {
  IconCheck,
  IconCompass,
  IconCopy,
  IconFolder,
  IconGlobe,
  IconLink,
  IconQrCode,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconUpload,
  IconWand,
} from "./Icons";
import { KindleConfigModal } from "./KindleConfigModal";
import { WeReadQrModal } from "./WeReadQrModal";

interface RouterViewProps {
  initialSection?: "twin" | "obsidian" | "router";
  onModalToggle: (open: boolean) => void;
  onEnsureBrowserOpen: () => void;
  onNotify: (msg: string, tone?: "info" | "success" | "error") => void;
}

export const RouterView: React.FC<RouterViewProps> = ({
  initialSection = "router",
  onModalToggle,
  onEnsureBrowserOpen,
  onNotify,
}) => {
  const [section, setSection] = useState<"twin" | "obsidian" | "router">(initialSection);

  // Twin state
  const [twin, setTwin] = useState<TwinProfileState | null>(null);
  const [profileMd, setProfileMd] = useState("");
  const [styleMd, setStyleMd] = useState("");
  const [twinViewMode, setTwinViewMode] = useState<"preview" | "edit">("preview");
  const [savingTwin, setSavingTwin] = useState(false);

  // Obsidian Vault
  const [vaultPath, setVaultPath] = useState("");

  // Connections Hub + Optional zlib CLI Router
  const [connections, setConnections] = useState<ConnectionsSnapshot | null>(null);
  const [loadingConn, setLoadingConn] = useState(true);
  const [connectionError, setConnectionError] = useState("");
  const [healthyDomains, setHealthyDomains] = useState<ZlibDomainHealth[]>([]);
  const [domainInput, setDomainInput] = useState("");
  const [doctorError, setDoctorError] = useState<string | null>(null);
  const [wereadQrOpen, setWeReadQrOpen] = useState(false);
  const [kindleModalOpen, setKindleModalOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState<"zlib" | "weread" | "kindle" | null>(null);

  // Local file dispatch & metadata repair
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [selectedEbookPath, setSelectedEbookPath] = useState("");
  const [routerLog, setRouterLog] = useState("");

  // Local EPUB/PDF metadata repair (zlib v0.0.16+ meta)
  const [metaDraft, setMetaDraft] = useState<LocalBookMetadata | null>(null);
  const [metaMatches, setMetaMatches] = useState<LocalBookMetadata[]>([]);
  const [renameOnApply, setRenameOnApply] = useState(false);

  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  useEffect(() => {
    const anyModal = wereadQrOpen || kindleModalOpen;
    onModalToggle(anyModal);
    return () => {
      if (anyModal) onModalToggle(false);
    };
  }, [wereadQrOpen, kindleModalOpen, onModalToggle]);

  const refreshConnections = useCallback(async () => {
    setLoadingConn(true);
    setConnectionError("");
    try {
      const snap = await window.diandian.router.connections();
      setConnections(snap);
      if (snap.zlib.currentDomain) {
        setDomainInput(snap.zlib.currentDomain);
      }
    } catch {
      setConnectionError("未能读取连接状态，请点击「刷新状态」重试。");
    } finally {
      setLoadingConn(false);
    }
  }, []);

  useEffect(() => {
    void window.diandian.twin.get().then((t) => {
      setTwin(t);
      setProfileMd(t.profileMd);
      setStyleMd(t.styleMd);
    });
    void window.diandian.obsidian.getVault().then((res) => setVaultPath(res.vaultPath));
    void refreshConnections();
  }, [refreshConnections]);

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

  const handlePickVault = async () => {
    try {
      const res = await window.diandian.obsidian.pickVault();
      if (!res.canceled) {
        setVaultPath(res.vaultPath);
        onNotify(`已绑定 Obsidian Vault: ${res.vaultPath}`, "success");
      }
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "选择 Vault 失败", "error");
    }
  };

  const handleDoctor = async () => {
    setBusyAction("doctor");
    setDoctorError(null);
    try {
      const res = await window.diandian.router.doctor();
      if (res.domains.length > 0) {
        setHealthyDomains(res.domains);
        if (!domainInput) {
          const first = res.domains.find((d) => d.status === "healthy") ?? res.domains[0];
          if (first) setDomainInput(first.domain);
        }
        onNotify(`检测到 ${res.domains.length} 个可用镜像域名`, "success");
      } else {
        setDoctorError(res.output || "当前网络暂未测出可用镜像，请检查代理或稍后重试");
      }
    } catch (error) {
      setDoctorError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const handleApplyDomain = async (nextDomain: string) => {
    setDomainInput(nextDomain);
    if (!nextDomain.trim()) return;
    try {
      const res = await window.diandian.router.setDomain(nextDomain);
      onNotify(`已切换默认镜像为 ${res.domain}`, "success");
      await refreshConnections();
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "切换镜像失败", "error");
    }
  };

  const handleOpenZlibLogin = async () => {
    setBusyAction("open-zlib");
    onEnsureBrowserOpen();
    try {
      const res = await window.diandian.router.openZlibLogin(domainInput || undefined);
      setDomainInput(res.openedUrl);
      onNotify(
        `已在右侧浏览器打开 ${res.openedUrl}，请完成登录后回来点击「同步右侧登录态」`,
        "info",
      );
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "打开登录页失败", "error");
    } finally {
      setBusyAction(null);
    }
  };

  const handleSyncZlibFromBrowser = async () => {
    setBusyAction("sync-zlib");
    try {
      const res = await window.diandian.router.syncZlibFromBrowser(domainInput || undefined);
      setConnections(res.snapshot);
      setDomainInput(res.origin);
      onNotify(
        `已从右侧浏览器安全同步 ${res.cookieCount} 条 Cookie 到书源引擎（${res.origin}）`,
        "success",
      );
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "同步登录态失败", "error");
    } finally {
      setBusyAction(null);
    }
  };

  const handleLogoutZlib = async () => {
    setBusyAction("logout-zlib");
    try {
      const res = await window.diandian.router.logoutZlib();
      setConnections(res.snapshot);
      setConfirmLogout(null);
      onNotify("已退出 Z-Library 书源登录", "success");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "退出 Z-Library 登录失败", "error");
    } finally {
      setBusyAction(null);
    }
  };

  const handleLogoutWeRead = async () => {
    setBusyAction("logout-weread");
    try {
      const res = await window.diandian.router.logoutWeRead();
      setConnections(res.snapshot);
      setConfirmLogout(null);
      onNotify("已解除微信读书书架绑定（不影响右侧网页阅读态）", "success");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "解除微信读书书架绑定失败", "error");
    } finally {
      setBusyAction(null);
    }
  };

  const handleClearKindleConfig = async () => {
    setBusyAction("clear-kindle");
    try {
      const res = await window.diandian.router.saveKindleConfig({ clearAll: true });
      if (res.snapshot) setConnections(res.snapshot);
      else await refreshConnections();
      setConfirmLogout(null);
      onNotify("已清除本机保存的 Kindle 推送配置", "success");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "清除 Kindle 配置失败", "error");
    } finally {
      setBusyAction(null);
    }
  };

  const handlePickEbook = async () => {
    const res = await window.diandian.router.pickEbookFile();
    if (!res.canceled) {
      setSelectedEbookPath(res.filePath);
      setMetaDraft(null);
      setMetaMatches([]);
    }
  };

  const handleReadLocalMeta = async () => {
    if (!selectedEbookPath) return;
    setBusyAction("meta-read");
    try {
      const m = await window.diandian.router.readBookMeta(selectedEbookPath);
      setMetaDraft(m);
      setMetaMatches([]);
      onNotify("已读取本地电子书内置元数据", "success");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "读取元数据失败", "error");
    } finally {
      setBusyAction(null);
    }
  };

  const handleFetchLocalMeta = async () => {
    if (!selectedEbookPath) return;
    setBusyAction("meta-fetch");
    try {
      const list = await window.diandian.router.fetchBookMetaMatches(selectedEbookPath, [
        "douban",
        "weread",
        "openlibrary",
        "google",
      ]);
      setMetaMatches(list);
      if (list.length === 0) {
        onNotify("未在线匹配到候选元数据，可直接手工编辑后写回", "info");
      } else {
        onNotify(`从豆瓣/微信读书/Open Library 匹配到 ${list.length} 条元数据候选`, "success");
      }
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "在线匹配失败", "error");
    } finally {
      setBusyAction(null);
    }
  };

  const handleApplyLocalMeta = async () => {
    if (!selectedEbookPath || !metaDraft) return;
    setBusyAction("meta-apply");
    try {
      const res = await window.diandian.router.applyBookMeta({
        filePath: selectedEbookPath,
        ...metaDraft,
        rename: renameOnApply,
      });
      setMetaDraft(res.metadata);
      setRouterLog(res.output);
      onNotify("已原子写回电子书元数据（失败自动保持原文件无损）", "success");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "写回元数据失败", "error");
    } finally {
      setBusyAction(null);
    }
  };

  const handleDispatchEbook = async (target: "kindle" | "weread") => {
    if (!selectedEbookPath) return;
    setBusyAction(target);
    try {
      const res =
        target === "kindle"
          ? await window.diandian.router.sendKindle(selectedEbookPath)
          : await window.diandian.router.importWeRead(selectedEbookPath);
      setRouterLog(res.output);
      onNotify(target === "kindle" ? "已触发推送到 Kindle" : "已触发导入微信读书书架", "success");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "分发失败", "error");
    } finally {
      setBusyAction(null);
    }
  };

  const zlibStatus = connections?.status ?? null;

  return (
    <div className="chat-view">
      <header className="view-header">
        <div className="view-header-left">
          <h1 className="view-title">连接与偏好</h1>
          <span className="badge">本地优先</span>
        </div>
      </header>

      <div className="section-tabs">
        <button
          type="button"
          className={`section-tab ${section === "router" ? "active" : ""}`}
          onClick={() => setSection("router")}
        >
          账号连接与书源
        </button>
        <button
          type="button"
          className={`section-tab ${section === "twin" ? "active" : ""}`}
          onClick={() => setSection("twin")}
        >
          个人画像 (Twin)
        </button>
        <button
          type="button"
          className={`section-tab ${section === "obsidian" ? "active" : ""}`}
          onClick={() => setSection("obsidian")}
        >
          Obsidian 联动
        </button>
      </div>

      <div className="studio-scroll">
        <div className="surf-doc-container">
          {section === "twin" && (
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
        )}

        {section === "obsidian" && (
          <section className="editorial-card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <h3 style={{ margin: 0, fontFamily: "var(--font-serif)", fontSize: 16 }}>Obsidian 增量双向同步</h3>
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-secondary)", lineHeight: 1.65 }}>
              点点读书将书籍划线与成稿写入你的 Obsidian Vault。每次导出都会通过 frontmatter 中的{" "}
              <span className="code-inline">diandian_id</span> 自动追踪你在 Obsidian 里的改名或移动，绝不产生重复文件；
              如果检测到你在 Obsidian 里手工修改过原笔记，系统会保留你的修改并输出{" "}
              <span className="code-inline">.diandian-conflict.md</span> 冲突副本，绝不静默覆盖。
            </p>

            <div className="field-group" style={{ marginBottom: 0 }}>
              <label className="field-label">已绑定的 Vault 根目录</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  className="input"
                  value={vaultPath}
                  onChange={(e) => setVaultPath(e.target.value)}
                  placeholder="尚未绑定目录，请点击右侧按钮选择…"
                  readOnly
                />
                <button type="button" className="btn primary" onClick={() => void handlePickVault()}>
                  <IconFolder size={14} />
                  <span>选择 Vault 文件夹</span>
                </button>
              </div>
            </div>
          </section>
        )}

        {section === "router" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Flat macOS Preferences-Style Connections Group */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <div className="pref-section-label" style={{ margin: 0, display: "inline-flex", alignItems: "center", gap: 6 }}>
                <IconLink size={12} />
                <span>账号连接</span>
              </div>
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => void refreshConnections()}
                disabled={loadingConn}
              >
                <IconRefresh size={12} />
                <span>{loadingConn ? "刷新中…" : "刷新状态"}</span>
              </button>
            </div>

            {connectionError && <div className="muted-box" role="alert">{connectionError}</div>}
            {loadingConn && !zlibStatus && (
              <div className="muted-box" role="status">正在检测书源组件和账号连接…</div>
            )}
            {zlibStatus?.installed === false && (
              <div className="muted-box" style={{ textAlign: "left" }}>
                <div style={{ fontWeight: 600, color: "var(--ink)", marginBottom: 4 }}>
                  未检测到本机可选组件 heartleo/zlib CLI（不影响阅读、笔记、创作与卡片核心功能）
                </div>
                <div style={{ marginBottom: 8 }}>
                  如需使用个人自有账号的电子书搜索、Kindle SMTP 推送或微信读书书架上传，可在终端安装后点击上方「刷新状态」：
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="code-inline">brew install heartleo/tap/zlib-cli</span>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={async () => {
                      await navigator.clipboard.writeText("brew install heartleo/tap/zlib-cli");
                      onNotify("已复制安装命令", "success");
                    }}
                  >
                    <IconCopy size={12} />
                    <span>复制命令</span>
                  </button>
                </div>
              </div>
            )}
            {zlibStatus?.installed && (
              <section className="conn-group">
                {/* Row 1: Z-Library */}
                <div className="conn-row">
                  <div className="conn-card-head">
                    <span className="conn-card-title">
                      <span className={`status-dot ${connections?.zlib.loggedIn ? "ok" : ""}`} />
                      Z-Library 书源
                    </span>
                    <span className={`badge ${connections?.zlib.loggedIn ? "sage" : "amber"}`}>
                      {connections?.zlib.loggedIn
                        ? `已登录 · ${connections.zlib.userName || "账号有效"}`
                        : "未登录"}
                    </span>
                  </div>
                  <div className="conn-card-meta">
                    {connections?.zlib.loggedIn && connections.zlib.dailyRemaining !== null
                      ? `今日剩余下载额度：${connections.zlib.dailyRemaining} / ${connections.zlib.dailyAllowed ?? 10}`
                      : "在右侧浏览器登录后，一键同步当前镜像 Cookie 到本地书源引擎"}
                  </div>

                  <div style={{ display: "flex", gap: 6, marginTop: 4, alignItems: "center" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {healthyDomains.length > 0 ? (
                        <CustomSelect
                          size="sm"
                          value={domainInput}
                          onChange={(val) => void handleApplyDomain(val)}
                          ariaLabel="镜像域名选择"
                          options={healthyDomains.map((d) => ({
                            value: d.domain,
                            label: d.domain,
                            description: d.status === "healthy" ? "测速健康可用" : d.status,
                          }))}
                        />
                      ) : (
                        <input
                          className="input"
                          style={{ height: 30, padding: "0 10px", fontSize: 12 }}
                          value={domainInput}
                          onChange={(e) => setDomainInput(e.target.value)}
                          onBlur={() => {
                            if (domainInput.trim()) void handleApplyDomain(domainInput);
                          }}
                          placeholder="镜像域名，如 https://z-lib.by"
                        />
                      )}
                    </div>
                    <button
                      type="button"
                      className="btn sm soft"
                      style={{ height: 30 }}
                      onClick={() => void handleDoctor()}
                      disabled={busyAction === "doctor"}
                      title="测速并筛选当前网络可用的 Z-Library 镜像域名"
                    >
                      <span>{busyAction === "doctor" ? "测速中…" : "检测可用镜像"}</span>
                    </button>
                  </div>

                  {healthyDomains.length > 0 && (
                    <div className="mirror-results-box">
                      <div className="mirror-results-head">
                        <span>
                          <span className="status-dot ok" style={{ marginRight: 6 }} />
                          检测到 {healthyDomains.length} 个可用镜像，点选切换
                        </span>
                      </div>
                      <div className="mirror-pill-list">
                        {healthyDomains.map((d) => {
                          const active = domainInput.replace(/\/+$/, "") === d.domain.replace(/\/+$/, "");
                          const shortHost = d.domain.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
                          return (
                            <button
                              key={d.domain}
                              type="button"
                              className={`mirror-pill ${active ? "active" : ""}`}
                              onClick={() => void handleApplyDomain(d.domain)}
                              title={`点击切换为 ${d.domain}`}
                            >
                              {active && <IconCheck size={11} />}
                              <span>{shortHost}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {doctorError && (
                    <div className="mset-feedback error" style={{ marginTop: 4 }}>
                      {doctorError}
                    </div>
                  )}

                  <div className="conn-card-actions">
                    <button
                      type="button"
                      className="btn sm soft"
                      disabled={busyAction !== null}
                      onClick={() => void handleOpenZlibLogin()}
                    >
                      <IconGlobe size={12} />
                      <span>1. 右侧打开登录</span>
                    </button>
                    <button
                      type="button"
                      className="btn sm primary"
                      disabled={busyAction !== null}
                      onClick={() => void handleSyncZlibFromBrowser()}
                    >
                      <IconCheck size={12} />
                      <span>{busyAction === "sync-zlib" ? "同步中…" : "2. 同步右侧登录态"}</span>
                    </button>
                    {connections?.zlib.loggedIn && (
                      confirmLogout === "zlib" ? (
                        <>
                          <button
                            type="button"
                            className="btn sm danger"
                            disabled={busyAction !== null}
                            onClick={() => void handleLogoutZlib()}
                          >
                            {busyAction === "logout-zlib" ? "退出中…" : "确认退出"}
                          </button>
                          <button
                            type="button"
                            className="btn sm ghost"
                            disabled={busyAction !== null}
                            onClick={() => setConfirmLogout(null)}
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn sm ghost-danger"
                          disabled={busyAction !== null}
                          onClick={() => setConfirmLogout("zlib")}
                        >
                          退出登录
                        </button>
                      )
                    )}
                  </div>
                </div>

                {/* Row 2: WeRead Shelf Upload */}
                <div className="conn-row">
                  <div className="conn-card-head">
                    <span className="conn-card-title">
                      <span className={`status-dot ${connections?.weread.loggedIn ? "ok" : ""}`} />
                      微信读书书架上传
                    </span>
                    <span className={`badge ${connections?.weread.loggedIn ? "sage" : "amber"}`}>
                      {connections?.weread.loggedIn ? `已绑定 · ${connections.weread.name}` : "未绑定"}
                    </span>
                  </div>
                  <div className="conn-card-meta">
                    独立于右侧网页阅读态，用于将本地 EPUB / PDF 一键上传到微信读书书架。
                  </div>
                  <div className="conn-card-actions">
                    <button
                      type="button"
                      className="btn sm soft"
                      disabled={busyAction !== null}
                      onClick={() => {
                        setConfirmLogout(null);
                        setWeReadQrOpen(true);
                      }}
                    >
                      <IconQrCode size={12} />
                      <span>{connections?.weread.loggedIn ? "重新扫码绑定" : "微信扫码绑定"}</span>
                    </button>
                    {connections?.weread.loggedIn && (
                      confirmLogout === "weread" ? (
                        <>
                          <button
                            type="button"
                            className="btn sm danger"
                            disabled={busyAction !== null}
                            onClick={() => void handleLogoutWeRead()}
                          >
                            {busyAction === "logout-weread" ? "解绑中…" : "确认解除绑定"}
                          </button>
                          <button
                            type="button"
                            className="btn sm ghost"
                            disabled={busyAction !== null}
                            onClick={() => setConfirmLogout(null)}
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn sm ghost-danger"
                          disabled={busyAction !== null}
                          onClick={() => setConfirmLogout("weread")}
                        >
                          解除绑定
                        </button>
                      )
                    )}
                  </div>
                </div>

                {/* Row 3: Kindle SMTP */}
                <div className="conn-row">
                  <div className="conn-card-head">
                    <span className="conn-card-title">
                      <span className={`status-dot ${connections?.kindle.configured ? "ok" : ""}`} />
                      Kindle 邮件推送
                    </span>
                    <span className={`badge ${connections?.kindle.configured ? "sage" : "amber"}`}>
                      {connections?.kindle.configured ? "已配置" : "待配置"}
                    </span>
                  </div>
                  <div className="conn-card-meta">
                    {connections?.kindle.configured
                      ? `收件：${connections.kindle.to} · 发件：${connections.kindle.from} (${connections.kindle.smtpHost}:${connections.kindle.smtpPort})`
                      : "绑定发件邮箱（QQ / 163 / Gmail / Outlook）与 @kindle.com 地址，即可将电子书一键推到 Kindle。"}
                  </div>
                  <div className="conn-card-actions">
                    <button
                      type="button"
                      className="btn sm soft"
                      disabled={busyAction !== null}
                      onClick={() => {
                        setConfirmLogout(null);
                        setKindleModalOpen(true);
                      }}
                    >
                      <IconSettings size={12} />
                      <span>{connections?.kindle.configured ? "修改推送配置" : "配置 Kindle 推送"}</span>
                    </button>
                    {connections?.kindle.configured && (
                      confirmLogout === "kindle" ? (
                        <>
                          <button
                            type="button"
                            className="btn sm danger"
                            disabled={busyAction !== null}
                            onClick={() => void handleClearKindleConfig()}
                          >
                            {busyAction === "clear-kindle" ? "清除中…" : "确认清除配置"}
                          </button>
                          <button
                            type="button"
                            className="btn sm ghost"
                            disabled={busyAction !== null}
                            onClick={() => setConfirmLogout(null)}
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn sm ghost-danger"
                          disabled={busyAction !== null}
                          onClick={() => setConfirmLogout("kindle")}
                        >
                          清除配置
                        </button>
                      )
                    )}
                  </div>
                </div>
              </section>
            )}

            {zlibStatus?.installed && !zlibStatus.supportsMeta && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", fontSize: 11.5 }}>
                <IconCompass size={13} />
                <span className="badge amber">
                  当前 CLI 版本不含本地 EPUB meta 重写（可在终端执行 zlib update 升级）
                </span>
              </div>
            )}

            {zlibStatus?.installed && (
              <>
                <div className="pref-section-label">本机电子书元数据修复与分发</div>
                <section className="editorial-card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      className="input"
                      readOnly
                      value={selectedEbookPath}
                      placeholder="选择本机 EPUB / PDF / MOBI / AZW3 文件…"
                    />
                    <button type="button" className="btn" onClick={() => void handlePickEbook()}>
                      <IconFolder size={14} />
                      <span>选择文件</span>
                    </button>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {zlibStatus.supportsMeta && (
                      <>
                        <button
                          type="button"
                          className="btn sm soft"
                          disabled={!selectedEbookPath || busyAction !== null}
                          onClick={() => void handleReadLocalMeta()}
                        >
                          <IconWand size={13} />
                          <span>{busyAction === "meta-read" ? "读取中…" : "读取文件元数据"}</span>
                        </button>
                        <button
                          type="button"
                          className="btn sm"
                          disabled={!selectedEbookPath || busyAction !== null}
                          onClick={() => void handleFetchLocalMeta()}
                        >
                          <IconSearch size={13} />
                          <span>{busyAction === "meta-fetch" ? "匹配中…" : "豆瓣 / 微信读书在线匹配"}</span>
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="btn sm primary"
                      disabled={!selectedEbookPath || busyAction !== null}
                      onClick={() => void handleDispatchEbook("kindle")}
                    >
                      <IconUpload size={13} />
                      <span>{busyAction === "kindle" ? "发送中…" : "推送到 Kindle"}</span>
                    </button>
                    <button
                      type="button"
                      className="btn sm sage"
                      disabled={!selectedEbookPath || busyAction !== null}
                      onClick={() => void handleDispatchEbook("weread")}
                    >
                      <IconUpload size={13} />
                      <span>{busyAction === "weread" ? "导入中…" : "导入微信读书书架"}</span>
                    </button>
                  </div>

                  {metaMatches.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-secondary)" }}>
                        在线匹配候选（点击即可填入下方编辑框）：
                      </div>
                      {metaMatches.slice(0, 5).map((m, idx) => (
                        <div
                          key={`mm-${idx}`}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: 8,
                            padding: "8px 10px",
                            borderRadius: 8,
                            border: "1px solid var(--border)",
                            background: "var(--surface-tint)",
                          }}
                        >
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 12.5 }}>{m.title}</div>
                            <div style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                              {[m.authors, m.publisher, m.date, m.isbn, m.source].filter(Boolean).join(" · ")}
                            </div>
                          </div>
                          <button
                            type="button"
                            className="btn sm soft"
                            onClick={() => setMetaDraft(m)}
                          >
                            采用
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {metaDraft && (
                    <div
                      style={{
                        padding: 12,
                        borderRadius: 10,
                        border: "1px solid var(--border)",
                        background: "var(--surface-tint)",
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                      }}
                    >
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                        <div className="field-group" style={{ marginBottom: 0 }}>
                          <label className="field-label">书名</label>
                          <input
                            className="input"
                            value={metaDraft.title}
                            onChange={(e) => setMetaDraft((d) => (d ? { ...d, title: e.target.value } : d))}
                          />
                        </div>
                        <div className="field-group" style={{ marginBottom: 0 }}>
                          <label className="field-label">作者（多位用 &amp; 分隔）</label>
                          <input
                            className="input"
                            value={metaDraft.authors}
                            onChange={(e) => setMetaDraft((d) => (d ? { ...d, authors: e.target.value } : d))}
                          />
                        </div>
                        <div className="field-group" style={{ marginBottom: 0 }}>
                          <label className="field-label">出版社</label>
                          <input
                            className="input"
                            value={metaDraft.publisher}
                            onChange={(e) => setMetaDraft((d) => (d ? { ...d, publisher: e.target.value } : d))}
                          />
                        </div>
                        <div className="field-group" style={{ marginBottom: 0 }}>
                          <label className="field-label">ISBN / 出版日期</label>
                          <input
                            className="input"
                            value={metaDraft.isbn}
                            onChange={(e) => setMetaDraft((d) => (d ? { ...d, isbn: e.target.value } : d))}
                            placeholder="ISBN"
                          />
                        </div>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ink-secondary)" }}>
                          <input
                            type="checkbox"
                            checked={renameOnApply}
                            onChange={(e) => setRenameOnApply(e.target.checked)}
                          />
                          同时规范重命名为「书名 - 作者.ext」
                        </label>
                        <button
                          type="button"
                          className="btn sm primary"
                          disabled={busyAction !== null}
                          onClick={() => void handleApplyLocalMeta()}
                        >
                          <IconCheck size={12} />
                          <span>{busyAction === "meta-apply" ? "写回中…" : "原子写回电子书文件"}</span>
                        </button>
                      </div>
                    </div>
                  )}

                  {routerLog && (
                    <pre className="md-code-block" style={{ margin: 0 }}>
                      {routerLog}
                    </pre>
                  )}
                </section>
              </>
            )}
          </div>
        )}
        </div>
      </div>

      <WeReadQrModal
        open={wereadQrOpen}
        onClose={() => setWeReadQrOpen(false)}
        onSuccess={(name) => {
          onNotify(`微信读书书架通道已绑定：${name}`, "success");
          void refreshConnections();
        }}
      />

      <KindleConfigModal
        open={kindleModalOpen}
        onClose={() => setKindleModalOpen(false)}
        onSaved={(snap) => {
          if (snap) setConnections(snap);
          else void refreshConnections();
        }}
        onNotify={onNotify}
      />
    </div>
  );
};
