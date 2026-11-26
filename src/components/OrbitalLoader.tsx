import React, { useEffect, useMemo, useState } from "react";

interface OrbitalLoaderProps {
  url?: string;
  suppressed?: boolean;
}

function resolveSiteDisplay(url?: string): { name: string; host: string } {
  if (!url) return { name: "内置阅读窗", host: "" };
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host.includes("weread.qq.com")) return { name: "微信读书", host };
    if (host.includes("douban.com")) return { name: "豆瓣读书", host };
    if (host.includes("xiaohongshu.com")) return { name: "小红书创作", host };
    if (host.includes("mp.weixin.qq.com")) return { name: "微信公众号", host };
    if (host.includes("z-lib") || host.includes("zlib")) return { name: "Z-Library", host };
    return { name: host || "阅读页面", host };
  } catch {
    return { name: "阅读页面", host: "" };
  }
}

/**
 * 21st.dev-inspired Twin Orbital Loader + Shimmering Status Text
 * (Orbital Loader / Twin Orbit + @ibelick Text Shimmer + ElevenLabs cycling status)
 */
export const OrbitalLoader: React.FC<OrbitalLoaderProps> = ({ url, suppressed = false }) => {
  const site = useMemo(() => resolveSiteDisplay(url), [url]);
  const phrases = useMemo(
    () => [
      `正在连接 ${site.name}…`,
      "正在加载页面内容…",
      "正在为你铺开沉浸阅读页…",
    ],
    [site.name],
  );

  const [phraseIdx, setPhraseIdx] = useState(0);

  useEffect(() => {
    setPhraseIdx(0);
    if (suppressed) return;
    const timer = window.setInterval(() => {
      setPhraseIdx((prev) => (prev + 1) % phrases.length);
    }, 2200);
    return () => window.clearInterval(timer);
  }, [phrases, suppressed]);

  return (
    <div className={`orbital-stage ${suppressed ? "is-paused" : ""}`} role="status" aria-live="polite">
      <div className="orbital-visual" aria-hidden="true">
        <div className="orbital-halo" />
        <div className="orbital-ring-outer">
          <span className="orbital-satellite" />
        </div>
        <div className="orbital-ring-inner" />
        <div className="orbital-core" />
      </div>

      <div className="orbital-copy">
        {suppressed ? (
          <div className="orbital-paused-text">弹窗打开中 · 阅读页已妥善暂留</div>
        ) : (
          <div key={phraseIdx} className="shimmer-status-text">
            {phrases[phraseIdx]}
          </div>
        )}
        {site.host && <div className="orbital-host-pill">{site.host}</div>}
      </div>
    </div>
  );
};
