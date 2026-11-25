import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  CookieImportPreview,
  PublicLocalBrowserProfile,
  ReadingSiteGroupId,
  ReadingSiteGroupSummary,
  SupportedBrowserId,
} from "../types/desktop";
import {
  IconArrowLeft,
  IconBookOpen,
  IconCheck,
  IconChevronDown,
  IconClose,
  IconCompass,
  IconDownload,
  IconGlobe,
  IconPenLine,
  IconRefresh,
  IconSparkles,
  IconUpload,
} from "./Icons";

interface CookieImportModalProps {
  open: boolean;
  activeAccountLabel: string;
  onClose: () => void;
  onNotify: (msg: string, tone?: "info" | "success" | "error") => void;
}

function formatIpcError(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const cleaned = raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, "").trim();
  return cleaned || fallback;
}

const BrowserBrandIcon: React.FC<{ browserId: SupportedBrowserId; size?: number }> = ({
  browserId,
  size = 18,
}) => {
  if (browserId === "chrome") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="bimport-brand-svg">
        <path fill="#EA4335" d="M12 2a10 10 0 0 1 8.66 5H12a5 5 0 0 0-4.33 2.5L4.35 3.74A9.96 9.96 0 0 1 12 2Z" />
        <path fill="#34A853" d="M4.35 3.74 7.67 9.5a5 5 0 0 0 4.33 7.5h.01l-3.34 5.77A10 10 0 0 1 4.35 3.74Z" />
        <path fill="#FBBC05" d="M20.66 7A10 10 0 0 1 8.67 22.77L12 17a5 5 0 0 0 4.33-7.5H20.66Z" />
        <circle cx="12" cy="12" r="4.8" fill="#FFFFFF" />
        <circle cx="12" cy="12" r="3.6" fill="#4285F4" />
      </svg>
    );
  }
  if (browserId === "chromium") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="bimport-brand-svg">
        <path fill="#2B6CB0" d="M12 2a10 10 0 0 1 8.66 5H12a5 5 0 0 0-4.33 2.5L4.35 3.74A9.96 9.96 0 0 1 12 2Z" />
        <path fill="#63B3ED" d="M4.35 3.74 7.67 9.5a5 5 0 0 0 4.33 7.5h.01l-3.34 5.77A10 10 0 0 1 4.35 3.74Z" />
        <path fill="#90CDF4" d="M20.66 7A10 10 0 0 1 8.67 22.77L12 17a5 5 0 0 0 4.33-7.5H20.66Z" />
        <circle cx="12" cy="12" r="4.8" fill="#FFFFFF" />
        <circle cx="12" cy="12" r="3.6" fill="#3182CE" />
      </svg>
    );
  }
  if (browserId === "arc") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="bimport-brand-svg">
        <circle cx="12" cy="12" r="10" fill="#5A67F2" />
        <path
          d="M7.5 16.5c.8-4.8 2.6-8.3 4.5-8.3s3.7 3.5 4.5 8.3"
          fill="none"
          stroke="#FFFFFF"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
        <path d="M9.5 13.5h5" stroke="#C7D2FE" strokeWidth="1.9" strokeLinecap="round" />
      </svg>
    );
  }
  if (browserId === "brave") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="bimport-brand-svg">
        <path fill="#FB542B" d="M12 2 4.5 5.2 5.7 15.8 12 22l6.3-6.2L19.5 5.2 12 2Z" />
        <path fill="#FFFFFF" d="M8.7 9.5 12 7.4l3.3 2.1-.9 4.7-2.4 2-2.4-2-.9-4.7Z" />
      </svg>
    );
  }
  if (browserId === "edge") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="bimport-brand-svg">
        <circle cx="12" cy="12" r="10" fill="#0A78D6" />
        <path fill="#38BDF8" d="M12 2a10 10 0 0 1 9.5 6.9c-2.5-1.5-5.7-1.6-8.4-.2-2.4 1.2-3.4 3.5-2.6 5.4.6 1.5 2.4 2.4 4.5 2.2-1.8 2.2-4.6 3.1-7.4 2.1A9.9 9.9 0 0 1 2 12 10 10 0 0 1 12 2Z" />
      </svg>
    );
  }
  if (browserId === "firefox") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="bimport-brand-svg">
        <circle cx="12" cy="12" r="10" fill="#FF7139" />
        <circle cx="12.6" cy="12.6" r="5.6" fill="#7542E5" />
        <path fill="#FFBD4F" d="M16.6 6.2a7.5 7.5 0 0 1 1.7 9.4 6.2 6.2 0 0 1-9.6 1.3c2.8.8 5.8-.5 6.8-3.1.9-2.2.3-4.9-1.3-6.4.8-.6 1.6-1 2.4-1.2Z" />
      </svg>
    );
  }
  if (browserId === "vivaldi") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="bimport-brand-svg">
        <circle cx="12" cy="12" r="10" fill="#EF3939" />
        <path fill="#FFFFFF" d="M7.3 8.5a1.5 1.5 0 0 1 2.7-.6l2.1 4.1 2.1-4.1a1.5 1.5 0 1 1 2.7 1.3l-3.6 7a1.5 1.5 0 0 1-2.6 0l-3.4-6.7c-.1-.3-.1-.7 0-1Z" />
      </svg>
    );
  }
  // Dia / fallback
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="bimport-brand-svg">
      <circle cx="12" cy="12" r="10" fill="#1E293B" />
      <circle cx="12" cy="12" r="5" fill="none" stroke="#93C5FD" strokeWidth="2.4" />
    </svg>
  );
};

const SiteGroupIcon: React.FC<{ groupId: ReadingSiteGroupId }> = ({ groupId }) => {
  switch (groupId) {
    case "weread":
      return <IconBookOpen size={16} />;
    case "douban":
      return <IconCompass size={16} />;
    case "xiaohongshu":
      return <IconSparkles size={16} />;
    case "wechat_mp":
      return <IconPenLine size={16} />;
    case "zlib":
      return <IconDownload size={16} />;
    default:
      return <IconGlobe size={16} />;
  }
};

interface BrowserProfileDropdownProps {
  profiles: PublicLocalBrowserProfile[];
  value: string;
  disabled?: boolean;
  onChange: (profileId: string) => void;
}

const BrowserProfileDropdown: React.FC<BrowserProfileDropdownProps> = ({
  profiles,
  value,
  disabled = false,
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const selected = profiles.find((p) => p.id === value) ?? null;

  const updatePos = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = Math.max(rect.width, 260);
    setCoords({
      top: rect.bottom + 6,
      left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      width,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePos();
  }, [open, updatePos, profiles.length]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", updatePos);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", updatePos);
    };
  }, [open, updatePos]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`bimport-picker-trigger ${open ? "open" : ""}`}
        disabled={disabled || profiles.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {selected ? (
          <span className="bimport-picker-selected">
            <BrowserBrandIcon browserId={selected.browserId} size={18} />
            <span className="bimport-picker-browser">{selected.browserName}</span>
            <span className="bimport-picker-profile">{selected.profileName}</span>
          </span>
        ) : (
          <span className="bimport-picker-placeholder">未检测到本机浏览器</span>
        )}
        <span className="bimport-picker-chevron">
          <IconChevronDown size={15} />
        </span>
      </button>

      {open &&
        coords &&
        createPortal(
          <div
            ref={menuRef}
            className="bimport-picker-menu"
            role="listbox"
            style={{ top: coords.top, left: coords.left, width: coords.width }}
          >
            {profiles.map((p) => {
              const isSelected = p.id === value;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`bimport-picker-item ${isSelected ? "selected" : ""}`}
                  title={p.profileEmail ? `${p.browserName} · ${p.profileName} (${p.profileEmail})` : undefined}
                  onClick={() => {
                    onChange(p.id);
                    setOpen(false);
                  }}
                >
                  <BrowserBrandIcon browserId={p.browserId} size={18} />
                  <span className="bimport-picker-item-main">
                    <span className="bimport-picker-browser">{p.browserName}</span>
                    <span className="bimport-picker-profile">{p.profileName}</span>
                  </span>
                  {isSelected && (
                    <span className="bimport-picker-check">
                      <IconCheck size={14} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
};

export const CookieImportModal: React.FC<CookieImportModalProps> = ({
  open,
  activeAccountLabel,
  onClose,
  onNotify,
}) => {
  const [mode, setMode] = useState<"browser" | "file">("browser");

  // Local browser auto-import state
  const [profiles, setProfiles] = useState<PublicLocalBrowserProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [loadingProfiles, setLoadingProfiles] = useState(false);
  const [loadingInspect, setLoadingInspect] = useState(false);
  const [groups, setGroups] = useState<ReadingSiteGroupSummary[]>([]);
  const [enabledGroups, setEnabledGroups] = useState<ReadingSiteGroupId[]>([]);

  // File fallback state
  const [filePreview, setFilePreview] = useState<(CookieImportPreview & { fileName?: string }) | null>(null);
  const [selectedDomains, setSelectedDomains] = useState<string[]>([]);

  // Shared action state
  const [busy, setBusy] = useState(false);
  const [statusHint, setStatusHint] = useState("");
  const [error, setError] = useState("");
  const inspectSeqRef = useRef(0);

  const loadProfiles = useCallback(async () => {
    setLoadingProfiles(true);
    setError("");
    try {
      const list = await window.diandian.browser.listLocalBrowsers();
      setProfiles(list);
      if (list.length > 0) {
        setSelectedProfileId((prev) => (list.some((p) => p.id === prev) ? prev : list[0]!.id));
      } else {
        setSelectedProfileId("");
        setGroups([]);
        setEnabledGroups([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "扫描本机浏览器配置失败");
    } finally {
      setLoadingProfiles(false);
    }
  }, []);

  const inspectProfile = useCallback(async (profileId: string) => {
    if (!profileId) {
      setGroups([]);
      setEnabledGroups([]);
      return;
    }
    const seq = ++inspectSeqRef.current;
    setLoadingInspect(true);
    setError("");
    try {
      const res = await window.diandian.browser.inspectLocalBrowser(profileId);
      if (seq !== inspectSeqRef.current) return;
      setGroups(res.groups);
      setEnabledGroups(
        res.groups.filter((g) => g.defaultEnabled && g.cookieCount > 0).map((g) => g.id),
      );
    } catch (err) {
      if (seq !== inspectSeqRef.current) return;
      setGroups([]);
      setEnabledGroups([]);
      setError(err instanceof Error ? err.message : "读取浏览器站点概览失败");
    } finally {
      if (seq === inspectSeqRef.current) {
        setLoadingInspect(false);
      }
    }
  }, []);

  useEffect(() => {
    if (open) {
      setMode("browser");
      setError("");
      setStatusHint("");
      void loadProfiles();
    } else {
      if (filePreview?.importToken) {
        void window.diandian.browser.discardCookieImport(filePreview.importToken);
      }
      setFilePreview(null);
      setSelectedDomains([]);
      setStatusHint("");
      setError("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || mode !== "browser" || !selectedProfileId) return;
    void inspectProfile(selectedProfileId);
  }, [open, mode, selectedProfileId, inspectProfile]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, busy, onClose]);

  if (!open) return null;

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId) ?? null;
  const selectedCookieCount = groups
    .filter((g) => enabledGroups.includes(g.id))
    .reduce((sum, g) => sum + g.cookieCount, 0);

  const toggleGroup = (group: ReadingSiteGroupSummary) => {
    if (group.cookieCount === 0 || busy) return;
    setEnabledGroups((prev) =>
      prev.includes(group.id) ? prev.filter((id) => id !== group.id) : [...prev, group.id],
    );
  };

  const handleImportFromBrowser = async () => {
    if (!selectedProfile || enabledGroups.length === 0 || selectedCookieCount === 0) return;
    setBusy(true);
    setError("");
    setStatusHint(
      selectedProfile.requiresKeychain
        ? "正在等待 macOS 钥匙串授权，请在系统弹窗中点击「允许」…"
        : "正在同步选中站点的登录态…",
    );
    try {
      const res = await window.diandian.browser.importLocalBrowser({
        profileId: selectedProfile.id,
        groups: enabledGroups,
      });
      if (res.imported === 0) {
        setError("未找到可导入的有效登录态，请先在源浏览器中登录对应站点后重试。");
        return;
      }
      const pickedLabels = groups
        .filter((g) => enabledGroups.includes(g.id) && g.cookieCount > 0)
        .map((g) => g.label);
      const summaryLabel =
        pickedLabels.length <= 2
          ? pickedLabels.join("、")
          : `${pickedLabels.slice(0, 2).join("、")}等 ${pickedLabels.length} 项`;
      onNotify(
        `已从 ${res.browserName} (${res.profileName}) 导入 ${res.imported} 条登录态（${summaryLabel}）`,
        "success",
      );
      onClose();
    } catch (err) {
      setError(formatIpcError(err, "导入本机浏览器登录态失败"));
    } finally {
      setBusy(false);
      setStatusHint("");
    }
  };

  const handlePickFile = async () => {
    setError("");
    try {
      const res = await window.diandian.browser.pickCookieFile();
      if (res.canceled) return;
      if (filePreview?.importToken) {
        void window.diandian.browser.discardCookieImport(filePreview.importToken);
      }
      const nextPreview: CookieImportPreview & { fileName?: string } = {
        importToken: res.importToken,
        format: res.format,
        totalCount: res.totalCount,
        domains: res.domains,
        fileName: res.fileName,
      };
      setFilePreview(nextPreview);
      const rec = nextPreview.domains.filter((d) => d.recommended).map((d) => d.domain);
      setSelectedDomains(
        rec.length > 0
          ? rec
          : nextPreview.domains.length === 1 && nextPreview.domains[0]
            ? [nextPreview.domains[0].domain]
            : [],
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleDomain = (domain: string) => {
    setSelectedDomains((prev) =>
      prev.includes(domain) ? prev.filter((d) => d !== domain) : [...prev, domain],
    );
  };

  const handleApplyFile = async () => {
    if (!filePreview || selectedDomains.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const res = await window.diandian.browser.applyCookieImport({
        importToken: filePreview.importToken,
        selectedDomains,
      });
      setFilePreview(null);
      onNotify(
        `已向「${activeAccountLabel}」导入 ${res.imported} 条登录态（覆盖 ${res.domains.length} 个站点）`,
        "success",
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal-card bimport-modal" onClick={(e) => e.stopPropagation()}>
        <div className="bimport-header">
          <div>
            <h3 className="bimport-title">
              {mode === "browser" ? "从本机浏览器导入登录态" : "从 Cookie 文件导入"}
            </h3>
            <p className="bimport-subtitle">
              {mode === "browser"
                ? `选择要同步到内置浏览器的阅读与创作站点（仅本机解密，不经过云端）`
                : `支持 Netscape cookies.txt 或 JSON 导出文件，写入当前空间「${activeAccountLabel}」`}
            </p>
          </div>
          <button
            type="button"
            className="btn icon-only ghost bimport-close"
            disabled={busy}
            onClick={onClose}
            aria-label="关闭"
          >
            <IconClose size={16} />
          </button>
        </div>

        {mode === "browser" ? (
          <>
            <div className="bimport-body">
              <div className="bimport-from-row">
                <span className="bimport-from-label">来源</span>
                <BrowserProfileDropdown
                  profiles={profiles}
                  value={selectedProfileId}
                  disabled={busy || loadingProfiles}
                  onChange={(id) => setSelectedProfileId(id)}
                />
                <button
                  type="button"
                  className="bimport-refresh-btn"
                  title="重新扫描本机浏览器"
                  disabled={busy || loadingProfiles}
                  onClick={() => {
                    void loadProfiles().then(() => {
                      if (selectedProfileId) void inspectProfile(selectedProfileId);
                    });
                  }}
                >
                  <IconRefresh size={14} />
                </button>
              </div>

              {selectedProfile && (
                <div className="bimport-hint-line">
                  {selectedProfile.requiresKeychain
                    ? `首次从 ${selectedProfile.browserName} 导入时，macOS 会弹出钥匙串授权，点「允许」即可`
                    : `${selectedProfile.browserName} 登录态可直接同步，无需额外授权`}
                </div>
              )}

              <div className="bimport-list-card">
                {loadingProfiles || loadingInspect ? (
                  <div className="bimport-empty-state">正在读取本机浏览器站点列表…</div>
                ) : profiles.length === 0 ? (
                  <div className="bimport-empty-state">
                    <div>暂未检测到 Chrome / Arc / Brave / Edge / Dia / Firefox 的本地配置文件。</div>
                    <button
                      type="button"
                      className="btn sm soft"
                      style={{ marginTop: 10 }}
                      onClick={() => setMode("file")}
                    >
                      <IconUpload size={13} />
                      <span>改用 Cookie 文件导入</span>
                    </button>
                  </div>
                ) : (
                  groups.map((group) => {
                    const checked = enabledGroups.includes(group.id);
                    const disabled = group.cookieCount === 0 || busy;
                    return (
                      <div
                        key={group.id}
                        role="switch"
                        aria-checked={checked}
                        aria-disabled={disabled}
                        tabIndex={disabled ? -1 : 0}
                        className={`bimport-row ${disabled ? "disabled" : ""} ${checked ? "active" : ""}`}
                        onClick={() => toggleGroup(group)}
                        onKeyDown={(e) => {
                          if (!disabled && (e.key === "Enter" || e.key === " ")) {
                            e.preventDefault();
                            toggleGroup(group);
                          }
                        }}
                      >
                        <span className="bimport-row-icon">
                          <SiteGroupIcon groupId={group.id} />
                        </span>
                        <span className="bimport-row-text">
                          <span className="bimport-row-label">{group.label}</span>
                          <span className="bimport-row-meta">
                            {group.cookieCount > 0
                              ? `${group.subtitle} · ${group.cookieCount} 条`
                              : `${group.subtitle} · 未检测到`}
                          </span>
                        </span>
                        <span className={`surf-toggle ${checked ? "on" : ""} ${disabled ? "disabled" : ""}`}>
                          <span className="surf-toggle-thumb" />
                        </span>
                      </div>
                    );
                  })
                )}
              </div>

              {statusHint && <div className="bimport-banner info">{statusHint}</div>}
              {error && <div className="bimport-banner error">{error}</div>}
            </div>

            <div className="bimport-footer">
              <button
                type="button"
                className="bimport-fallback-link"
                disabled={busy}
                onClick={() => {
                  setError("");
                  setMode("file");
                }}
              >
                或从 Cookie 文件导入
              </button>
              <div className="bimport-footer-actions">
                <button type="button" className="btn bimport-cancel-btn" disabled={busy} onClick={onClose}>
                  取消
                </button>
                <button
                  type="button"
                  className="btn primary bimport-submit-btn"
                  disabled={
                    busy ||
                    loadingProfiles ||
                    loadingInspect ||
                    !selectedProfile ||
                    enabledGroups.length === 0 ||
                    selectedCookieCount === 0
                  }
                  onClick={() => void handleImportFromBrowser()}
                >
                  {busy ? "导入中…" : "一键导入"}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            {!filePreview ? (
              <div className="bimport-file-drop">
                <p className="bimport-file-desc">
                  适合使用 Safari 或其他小众浏览器导出的 Netscape <code>cookies.txt</code> / JSON 文件。
                </p>
                <button type="button" className="btn soft" onClick={() => void handlePickFile()}>
                  <IconUpload size={14} />
                  <span>选择本地 Cookie 文件…</span>
                </button>
              </div>
            ) : (
              <>
                <div className="bimport-file-bar">
                  <span>
                    已读取 {filePreview.fileName ? `「${filePreview.fileName}」` : "文件"} · 共 {filePreview.totalCount} 条
                  </span>
                  <button type="button" className="btn sm ghost" onClick={() => void handlePickFile()}>
                    重新选择
                  </button>
                </div>
                <div className="cookie-domain-list">
                  {filePreview.domains.map((item) => {
                    const checked = selectedDomains.includes(item.domain);
                    return (
                      <label key={item.domain} className={`cookie-domain-row ${checked ? "selected" : ""}`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleDomain(item.domain)}
                        />
                        <span className="cookie-domain-name">{item.domain}</span>
                        {item.recommended && <span className="badge sage">推荐</span>}
                        <span className="badge mono">{item.count} 条</span>
                      </label>
                    );
                  })}
                </div>
              </>
            )}

            {error && <div className="bimport-banner error">{error}</div>}

            <div className="bimport-footer">
              <button
                type="button"
                className="bimport-fallback-link"
                disabled={busy}
                onClick={() => {
                  setError("");
                  setMode("browser");
                }}
              >
                <IconArrowLeft size={13} />
                <span>返回本机浏览器导入</span>
              </button>
              <div className="bimport-footer-actions">
                <button type="button" className="btn bimport-cancel-btn" disabled={busy} onClick={onClose}>
                  取消
                </button>
                <button
                  type="button"
                  className="btn primary bimport-submit-btn"
                  disabled={busy || !filePreview || selectedDomains.length === 0}
                  onClick={() => void handleApplyFile()}
                >
                  {busy ? "导入中…" : "导入勾选站点"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
