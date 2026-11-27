import React, { useCallback, useEffect, useState } from "react";
import type {
  ConnectionsSnapshot,
  ZlibDomainHealth,
} from "../types/desktop";
import { CustomSelect } from "./CustomSelect";
import {
  IconCheck,
  IconCompass,
  IconGlobe,
  IconLink,
  IconQrCode,
  IconRefresh,
  IconSettings,
} from "./Icons";
import { KindleConfigModal } from "./KindleConfigModal";
import { WeReadQrModal } from "./WeReadQrModal";
import { EbookToolsSection } from "./settings/EbookToolsSection";
import { ObsidianExportSettings } from "./settings/ObsidianExportSettings";
import { TwinProfileSection } from "./settings/TwinProfileSection";

interface RouterViewProps {
  onBookMetadataChanged: (previousPath: string, updatedPath: string, title: string) => void;
  initialSection?: "twin" | "obsidian" | "router";
  onModalToggle: (open: boolean) => void;
  onEnsureBrowserOpen: () => void;
  onNotify: (msg: string, tone?: "info" | "success" | "error") => void;
}

export const RouterView: React.FC<RouterViewProps> = ({
  onBookMetadataChanged,
  initialSection = "router",
  onModalToggle,
  onEnsureBrowserOpen,
  onNotify,
}) => {
  const [section, setSection] = useState<"twin" | "obsidian" | "router">(initialSection);

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

  const [busyAction, setBusyAction] = useState<string | null>(null);

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
    void refreshConnections();
    return window.diandian.router.onConnectionsChanged(({ snapshot, origin }) => {
      setConnections(snapshot);
      setLoadingConn(false);
      // Only a Z-Library login carries an origin; other broadcasts must not clobber typing.
      if (origin) setDomainInput(origin);
    });
  }, [refreshConnections]);


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
      if (res.reachable === false) {
        onNotify(
          `正在右侧尝试打开 ${res.openedUrl}；若页面无法加载，请点「检测可用镜像」或检查代理设置`,
          "info",
        );
      } else if (res.switched) {
        onNotify(
          `原镜像不可达，已自动切换并在右侧打开可用镜像 ${res.openedUrl}；登录完成后将自动同步！`,
          "info",
        );
      } else {
        onNotify(
          `已在右侧浏览器打开 ${res.openedUrl}，完成登录后会自动同步（也可点第 2 步手动同步）`,
          "info",
        );
      }
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
          {/* Kept mounted while hidden so unsaved PROFILE.md / STYLE.md edits survive tab switches. */}
          <div hidden={section !== "twin"}><TwinProfileSection onNotify={onNotify} /></div>

        {section === "obsidian" && <ObsidianExportSettings />}

        {/* Kept mounted while hidden so the picked ebook and unsaved metadata survive tab switches. */}
          <div style={{ display: section === "router" ? "flex" : "none", flexDirection: "column", gap: 16 }}>
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
                  书源组件缺失（不影响阅读、笔记、创作与卡片）
                </div>
                <div>{zlibStatus.installHint} 电子书搜索、发送到 Kindle 和导入微信读书书架需要它。</div>
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
                      : "在右侧浏览器登录后将自动识别并同步镜像凭据（支持 SingleLogin 自动重定向）"}
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
                      <span>{busyAction === "open-zlib" ? "探测镜像中…" : "1. 右侧打开登录"}</span>
                    </button>
                    <button
                      type="button"
                      className="btn sm primary"
                      disabled={busyAction !== null}
                      onClick={() => void handleSyncZlibFromBrowser()}
                    >
                      <IconCheck size={12} />
                      <span>{busyAction === "sync-zlib" ? "同步中…" : "2. 手动同步登录态"}</span>
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
                  当前传书组件版本不支持修改书籍信息，可在终端执行 zlib update 升级
                </span>
              </div>
            )}

            {zlibStatus?.installed && (
              <EbookToolsSection
                supportsMeta={zlibStatus.supportsMeta}
                onBookMetadataChanged={onBookMetadataChanged}
                onNotify={onNotify}
              />
            )}
          </div>
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
