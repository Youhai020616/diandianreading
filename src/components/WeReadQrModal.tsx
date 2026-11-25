import React, { useEffect, useState } from "react";
import type { QrMatrix, WeReadQrEvent } from "../types/desktop";
import { IconCheck, IconClose, IconQrCode, IconRefresh } from "./Icons";

interface WeReadQrModalProps {
  open: boolean;
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

export const WeReadQrModal: React.FC<WeReadQrModalProps> = ({ open, onClose, onSuccess }) => {
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
    if (!open) {
      void window.diandian.router.cancelWeReadQr();
      return;
    }

    const off = window.diandian.router.onWeReadQrEvent((ev: WeReadQrEvent) => {
      if (ev.kind === "starting") {
        setStage("starting");
        setMessage("正在生成微信读书登录二维码…");
      } else if (ev.kind === "qr") {
        setStage("qr");
        setQr(ev.qr);
        setMessage(ev.hint);
      } else if (ev.kind === "success") {
        setStage("success");
        setMessage(`绑定成功！当前微信读书书架账号：${ev.name}`);
        onSuccess(ev.name);
      } else if (ev.kind === "error") {
        setStage("error");
        setMessage(ev.message);
      }
    });

    startScan();
    return () => {
      off();
      void window.diandian.router.cancelWeReadQr();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ width: 400, textAlign: "center" }}>
        <div className="modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <IconQrCode size={17} />
            <h3>微信扫码绑定书架通道</h3>
          </div>
          <button type="button" className="btn icon-only ghost" onClick={onClose}>
            <IconClose size={16} />
          </button>
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
