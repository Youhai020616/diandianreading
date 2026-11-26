import React, { useState } from "react";
import deepseekLogo from "../assets/models/deepseek.png";
import kimiLogo from "../assets/models/kimi.png";
import openaiLogo from "../assets/models/openai.png";
import qwenLogo from "../assets/models/qwen.png";
import zhipuLogo from "../assets/models/zhipu.png";
import bilibiliLogo from "../assets/sites/bilibili.svg";
import doubanLogo from "../assets/sites/douban.png";
import wechatMpLogo from "../assets/sites/wechat-mp.png";
import wereadLogo from "../assets/sites/weread.png";
import xiaohongshuLogo from "../assets/sites/xiaohongshu.png";
import zhihuLogo from "../assets/sites/zhihu.png";

interface IconProps {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

const baseProps = (size: number, className?: string, style?: React.CSSProperties) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className,
  style,
  "aria-hidden": true as const,
});

export const IconSparkles: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <path d="M12 3l1.7 4.7L18.5 9.5l-4.8 1.8L12 16l-1.7-4.7-4.8-1.8 4.8-1.8L12 3z" />
    <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" />
  </svg>
);

export const IconBookOpen: React.FC<IconProps> = ({ size = 16, className, style }) => (
  <svg {...baseProps(size, className, style)}>
    <path d="M2 5.5A2.5 2.5 0 0 1 4.5 3H9a3 3 0 0 1 3 3v14a2 2 0 0 0-2-2H4.5A2.5 2.5 0 0 1 2 15.5v-10z" />
    <path d="M22 5.5A2.5 2.5 0 0 0 19.5 3H15a3 3 0 0 0-3 3v14a2 2 0 0 1 2-2h5.5a2.5 2.5 0 0 0 2.5-2.5v-10z" />
  </svg>
);

export const IconPenLine: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
  </svg>
);

export const IconLanguages: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <path d="M3 5h12M9 2v3m3 0c-1 5-4 9-9 12m2-9c1 3 4 6 7 8m1 5 4.5-12L22 21m-7-4h5" />
  </svg>
);

export const IconSquarePen: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.375 2.625a2.12 2.12 0 1 1 3 3L12 15l-4 1 1-4Z" />
  </svg>
);

export const IconCard: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <rect x="4" y="3" width="16" height="18" rx="2.5" />
    <path d="M8 8h8" />
    <path d="M8 12h6" />
    <path d="M8 17h4" />
  </svg>
);

export const IconCompass: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <circle cx="12" cy="12" r="9" />
    <polygon points="15.5 8.5 13.8 13.8 8.5 15.5 10.2 10.2 15.5 8.5" />
  </svg>
);

export const IconSettings: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);

export const IconSearch: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export const IconPlus: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </svg>
);

export const IconClose: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

export const IconArrowLeft: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <path d="m15 18-6-6 6-6" />
  </svg>
);

export const IconArrowRight: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <path d="m9 18 6-6-6-6" />
  </svg>
);

export const IconRefresh: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <path d="M21 12a9 9 0 1 1-2.6-6.4L21 8" />
    <path d="M21 3v5h-5" />
  </svg>
);

export const IconSend: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <path d="M22 2 11 13" />
    <path d="M22 2 15 22l-4-9-9-4 20-7z" />
  </svg>
);

export const IconStop: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
  </svg>
);

export const IconCopy: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

export const IconDownload: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

export const IconUpload: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);

export const IconTrash: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
  </svg>
);

export const IconShield: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);

export const IconFolder: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z" />
  </svg>
);

export const IconExternalLink: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </svg>
);

export const IconPanelRight: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="15" y1="4" x2="15" y2="20" />
  </svg>
);

export const IconCheck: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export const IconWand: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <path d="M15 4V2" />
    <path d="M15 16v-2" />
    <path d="M8 9h2" />
    <path d="M20 9h2" />
    <path d="M17.8 11.8 19 13" />
    <path d="M15 9h.01" />
    <path d="M17.8 6.2 19 5" />
    <path d="m3 21 9-9" />
    <path d="M12.2 6.2 11 5" />
  </svg>
);

export const IconEye: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const IconSplit: React.FC<IconProps> = ({ size = 16, className, style }) => (
  <svg {...baseProps(size, className, style)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="12" y1="4" x2="12" y2="20" />
  </svg>
);

export const IconGlobe: React.FC<IconProps> = ({ size = 16, className, style }) => (
  <svg {...baseProps(size, className, style)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z" />
  </svg>
);

export const IconKey: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="m21 2-9.6 9.6" />
    <path d="m15.5 7.5 3 3L22 7l-3-3" />
  </svg>
);

export const IconQrCode: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <rect x="3" y="3" width="6" height="6" rx="1" />
    <rect x="15" y="3" width="6" height="6" rx="1" />
    <rect x="3" y="15" width="6" height="6" rx="1" />
    <path d="M15 15h2v2h-2z" />
    <path d="M19 15h2v6h-6v-2" />
    <path d="M15 19h2" />
  </svg>
);

export const IconLink: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
);

export const IconPaw: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <circle cx="8" cy="7.5" r="1.7" />
    <circle cx="16" cy="7.5" r="1.7" />
    <circle cx="5" cy="11.5" r="1.6" />
    <circle cx="19" cy="11.5" r="1.6" />
    <path d="M12 11c-2.8 0-5 2.4-5 4.8 0 1.8 1.5 3.2 3.3 3.2 1 0 1.4-.4 1.7-.4s.7.4 1.7.4c1.8 0 3.3-1.4 3.3-3.2 0-2.4-2.2-4.8-5-4.8z" />
  </svg>
);

export const IconChevronDown: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export const IconChevronRight: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);

export const IconPanelLeft: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="9" y1="4" x2="9" y2="20" />
  </svg>
);

export const IconZap: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...baseProps(size, className)}>
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);

export const IconFileText: React.FC<IconProps> = ({ size = 16, className, style }) => (
  <svg {...baseProps(size, className, style)}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="8" y1="13" x2="16" y2="13" />
    <line x1="8" y1="17" x2="13" y2="17" />
  </svg>
);

export const IconList: React.FC<IconProps> = ({ size = 16, className, style }) => (
  <svg {...baseProps(size, className, style)}>
    <line x1="8" y1="6" x2="20" y2="6" />
    <line x1="8" y1="12" x2="20" y2="12" />
    <line x1="8" y1="18" x2="20" y2="18" />
    <circle cx="4.5" cy="6" r="0.8" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="12" r="0.8" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="18" r="0.8" fill="currentColor" stroke="none" />
  </svg>
);

export const IconMoreHorizontal: React.FC<IconProps> = ({ size = 16, className, style }) => (
  <svg {...baseProps(size, className, style)}>
    <circle cx="6" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="18" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);

export const IconArrowUp: React.FC<IconProps> = ({ size = 16, className, style }) => (
  <svg {...baseProps(size, className, style)}>
    <line x1="12" y1="19" x2="12" y2="5" />
    <polyline points="6 11 12 5 18 11" />
  </svg>
);

export const IconHistory: React.FC<IconProps> = ({ size = 16, className, style }) => (
  <svg {...baseProps(size, className, style)}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l3 2" />
  </svg>
);

export type ModelBrand = "deepseek" | "kimi" | "qwen" | "glm" | "openai";

// Logos with dark marks on a transparent background get a light plate in dark mode.
const MODEL_BRAND_LOGOS: Record<ModelBrand, { src: string; plate: boolean }> = {
  deepseek: { src: deepseekLogo, plate: true },
  kimi: { src: kimiLogo, plate: false },
  qwen: { src: qwenLogo, plate: false },
  glm: { src: zhipuLogo, plate: true },
  openai: { src: openaiLogo, plate: true },
};

function modelBrandFromHint(hint: string): ModelBrand | null {
  if (hint.includes("deepseek")) return "deepseek";
  if (hint.includes("moonshot") || hint.includes("kimi")) return "kimi";
  if (hint.includes("dashscope") || hint.includes("qwen") || hint.includes("tongyi")) return "qwen";
  if (hint.includes("bigmodel") || hint.includes("glm") || hint.includes("zhipu")) return "glm";
  if (hint.includes("openai") || /(^|[-/])(gpt-|o1|o3|o4|chatgpt)/.test(hint)) return "openai";
  return null;
}

/** Bundled vendor logo for a model provider. */
export const ModelBrandLogo: React.FC<{ brand: ModelBrand; size?: number }> = ({ brand, size = 14 }) => {
  const { src, plate } = MODEL_BRAND_LOGOS[brand];
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      draggable={false}
      className={`model-brand-icon ${plate ? "has-plate" : ""}`}
      style={{ width: size, height: size }}
    />
  );
};

export const ModelBrandIcon: React.FC<{
  baseUrl?: string;
  model?: string;
  size?: number;
}> = ({ baseUrl = "", model = "", size = 14 }) => {
  const brand = modelBrandFromHint(`${baseUrl} ${model}`.toLowerCase());
  return brand ? <ModelBrandLogo brand={brand} size={size} /> : <IconSparkles size={Math.max(12, size - 1)} />;
};

export const SiteBrandIcon: React.FC<{ url?: string; faviconUrl?: string; size?: number }> = ({
  url = "",
  faviconUrl,
  size = 14,
}) => {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const lower = url.toLowerCase();

  if (lower.startsWith("data:")) {
    return <IconCompass size={size} style={{ flexShrink: 0, opacity: 0.72 }} />;
  }

  let bundledSrc: string | null = null;
  if (lower.includes("weread.qq.com")) {
    bundledSrc = wereadLogo;
  } else if (lower.includes("douban.com")) {
    bundledSrc = doubanLogo;
  } else if (lower.includes("xiaohongshu.com")) {
    bundledSrc = xiaohongshuLogo;
  } else if (lower.includes("mp.weixin.qq.com") || lower.includes("weixin.qq.com")) {
    bundledSrc = wechatMpLogo;
  } else if (lower.includes("zhihu.com")) {
    bundledSrc = zhihuLogo;
  } else if (lower.includes("bilibili.com")) {
    bundledSrc = bilibiliLogo;
  }

  const resolvedSrc =
    bundledSrc
    || (faviconUrl && /^https?:\/\//i.test(faviconUrl) && failedSrc !== faviconUrl ? faviconUrl : null);

  if (resolvedSrc) {
    return (
      <img
        src={resolvedSrc}
        alt=""
        width={size}
        height={size}
        draggable={false}
        referrerPolicy="no-referrer"
        onError={() => {
          if (!bundledSrc && faviconUrl) setFailedSrc(faviconUrl);
        }}
        style={{
          width: size,
          height: size,
          borderRadius: Math.max(3, Math.round(size * 0.25)),
          objectFit: "cover",
          flexShrink: 0,
          display: "block",
        }}
      />
    );
  }

  return <IconGlobe size={size} style={{ flexShrink: 0, opacity: 0.72 }} />;
};
