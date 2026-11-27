import React, { useEffect, useState } from "react";
import type { QrMatrix, WeReadQrEvent } from "../types/desktop";
import { IconCheck, IconClose, IconQrCode, IconRefresh } from "./Icons";

interface WeReadQrModalProps {
  open: boolean;
  pendingBookTitle?: string | null;
  /** true: a previous binding expired; false: first binding; undefined: unknown. */
  expiredRetry?: boolean;
  onClose: () => void;
  onSuccess: (name: string) => void;
}

const QrSvg: React.FC<{ matrix: QrMatrix }> = ({ matrix }) => {
  const quiet = 2;
  const rows = matrix.rows;
  const cols = rows[0]?.length ?? matrix.size;
  const viewW = cols + quiet * 2;
  const viewH = rows.length + quiet * 2;

  return (
    <svg
      viewBox={`0 0 ${viewW} ${viewH}`}
      width={216}
      height={216}
      shapeRendering="crispEdges"
      style={{ display: "block", background: "#ffffff", borderRadius: 12, border: "1px solid #e5ddd0" }}
      aria-label="微信读书书架登录二维码"
    >
      <rect width={viewW} height={viewH} fill="#ffffff" />
      {rows.map((row, y) =>
        row.map((dark, x) =>
          dark ? <rect key={`${x}-${y}`} x={x + quiet} y={y + quiet} width={1} height={1} fill="#141414" /> : null,
        ),
      )}
    </svg>
  );
};

export const WeReadQrModal: React.FC<WeReadQrModalProps> = ({
  open,
  pendingBookTitle,
  expiredRetry,
  onClose,
  onSuccess,
}) => {
  const [stage, setStage] = useState<"starting" | "qr" | "success" | "error">("starting");
  const [qr, setQr] = useState<QrMatrix | null>(null);
  const [message, setMessage] = useState("正在向微信读书请求扫码二维码…");

  const startScan = () => {
    setStage("starting");
    setQr(null);
    setMessage("正在向微信读书请求扫码二维码…");
    void window.diandian.router.startWeReadQr();
  };

  useEffect(() => {
    // Closing is handled by the cleanup below; cancelling here on mount would abort a scan
    // started by another (open) instance of this modal.
    if (!open) return;

    let closeTimer: number | null = null;
    const off = window.diandian.router.onWeReadQrEvent((ev: WeReadQrEvent) => {
      if (ev.kind === "starting") {
        setStage("starting");
        setMessage("正在生成微信读书传书通道二维码…");
      } else if (ev.kind === "qr") {
        setStage("qr");
        setQr(ev.qr);
        setMessage(
          pendingBookTitle
            ? `请用手机微信扫一扫确认，成功后将自动上传《${pendingBookTitle}》`
            : ev.hint,
        );
      } else if (ev.kind === "success") {
        setStage("success");
        setMessage(
          pendingBookTitle
            ? `已开通传书通道（${ev.name}），正在自动继续上传《${pendingBookTitle}》…`
            : `绑定成功！当前微信读书传书账号：${ev.name}`,
        );
        if (pendingBookTitle) {
          closeTimer = window.setTimeout(() => {
            onSuccess(ev.name);
          }, 320);
        } else {
          onSuccess(ev.name);
        }
      } else if (ev.kind === "error") {
        setStage("error");
        setMessage(ev.message);
      }
    });

    startScan();
    return () => {
      if (closeTimer !== null) window.clearTimeout(closeTimer);
      off();
      void window.diandian.router.cancelWeReadQr();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const explainBanner = pendingBookTitle
    ? expiredRetry === true
      ? `传书授权已过期，重新扫码后会自动续传《${pendingBookTitle}》（网页版无传书接口，与右侧阅读登录互不影响）。`
      : expiredRetry === false
        ? `微信读书网页版不开放传书接口，首次传书需扫码开启独立传书通道（开通一次后续免扫直传，与右侧阅读态互不影响）。`
        : `传书通道未开通或授权已过期，扫码后会自动续传《${pendingBookTitle}》（网页版无传书接口，与右侧阅读登录互不影响）。`
    : "微信读书网页版不开放传书接口；此处通过官方墨水屏通道将电子书传入你的书架，绑定一次后续免扫直传。";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ width: 420, textAlign: "center" }}>
        <div className="modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <IconQrCode size={17} />
            <h3>{pendingBookTitle ? "扫码开通传书通道 · 自动续传" : "微信扫码开通传书通道"}</h3>
          </div>
          <button type="button" className="btn icon-only ghost" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>

        <div
          style={{
            margin: "2px 0 8px",
            padding: "8px 11px",
            borderRadius: 10,
            background: "var(--accent-soft)",
            border: "1px solid var(--accent-border)",
            fontSize: 11.5,
            lineHeight: 1.55,
            color: "var(--ink-secondary)",
            textAlign: "left",
          }}
        >
          {explainBanner}
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "10px 0 6px" }}>
          {stage === "qr" && qr ? (
            <QrSvg matrix={qr} />
          ) : stage === "success" ? (
            <div
              style={{
                width: 72,
                height: 72,
                borderRadius: "50%",
                background: "var(--sage-soft)",
                color: "var(--sage)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <IconCheck size={32} />
            </div>
          ) : (
            <div className="muted-box" style={{ width: 216, height: 216, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {stage === "error" ? "二维码获取失败" : "正在获取二维码…"}
            </div>
          )}

          <p style={{ margin: 0, fontSize: 12.5, color: stage === "error" ? "var(--danger)" : "var(--ink-secondary)", lineHeight: 1.6 }}>
            {message}
          </p>
        </div>

        <div className="modal-footer" style={{ justifyContent: "center" }}>
          {stage === "error" && (
            <button type="button" className="btn soft" onClick={startScan}>
              <IconRefresh size={13} />
              <span>重新获取二维码</span>
            </button>
          )}
          <button type="button" className={`btn ${stage === "success" ? "primary" : ""}`} onClick={onClose}>
            {stage === "success" ? "完成" : "取消"}
          </button>
        </div>
      </div>
    </div>
  );
};
