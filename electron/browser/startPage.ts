import fs from "node:fs";
import path from "node:path";

export interface QuickSite {
  name: string;
  url: string;
  iconFile: string;
  glyph: string;
  bg: string;
  fg: string;
  tag: string;
}

export const DEFAULT_QUICK_SITES: readonly QuickSite[] = [
  {
    name: "微信读书",
    url: "https://weread.qq.com",
    iconFile: "weread.png",
    glyph: "读",
    bg: "#1b88ee",
    fg: "#ffffff",
    tag: "阅读 & 划线",
  },
  {
    name: "豆瓣读书",
    url: "https://book.douban.com",
    iconFile: "douban.png",
    glyph: "豆",
    bg: "#007722",
    fg: "#ffffff",
    tag: "书评 & 书目",
  },
  {
    name: "小红书创作",
    url: "https://creator.xiaohongshu.com/publish/publish",
    iconFile: "xiaohongshu.png",
    glyph: "红",
    bg: "#ff2442",
    fg: "#ffffff",
    tag: "读书卡片发布",
  },
  {
    name: "微信公众号",
    url: "https://mp.weixin.qq.com",
    iconFile: "wechat-mp.png",
    glyph: "公",
    bg: "#07c160",
    fg: "#ffffff",
    tag: "长文发布",
  },
  {
    name: "知乎",
    url: "https://www.zhihu.com",
    iconFile: "zhihu.png",
    glyph: "知",
    bg: "#0066ff",
    fg: "#ffffff",
    tag: "讨论 & 专栏",
  },
  {
    name: "B 站创作中心",
    url: "https://member.bilibili.com",
    iconFile: "bilibili.svg",
    glyph: "B",
    bg: "#fb7299",
    fg: "#ffffff",
    tag: "视频稿发布",
  },
];

export const DEFAULT_READING_URL = "https://weread.qq.com";
export const START_PAGE_TITLE = "新标签页";

export function isStartPageUrl(url?: string | null): boolean {
  return typeof url === "string" && url.startsWith("data:text/html");
}

const iconDataUriCache = new Map<string, string | null>();
let cachedStartPageUrl: string | null = null;

function loadSiteIconDataUri(fileName: string): string | null {
  if (iconDataUriCache.has(fileName)) {
    return iconDataUriCache.get(fileName) ?? null;
  }
  const candidates = [
    path.resolve(__dirname, "../assets/sites", fileName),
    path.resolve(__dirname, "../../src/assets/sites", fileName),
  ];
  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const buf = fs.readFileSync(filePath);
      const mime = fileName.endsWith(".svg") ? "image/svg+xml" : "image/png";
      const uri = `data:${mime};base64,${buf.toString("base64")}`;
      iconDataUriCache.set(fileName, uri);
      return uri;
    } catch {
      // Fall through to next candidate
    }
  }
  iconDataUriCache.set(fileName, null);
  return null;
}

export function buildStartPageUrl(): string {
  if (cachedStartPageUrl) return cachedStartPageUrl;

  const cards = DEFAULT_QUICK_SITES.map((s) => {
    const iconUri = loadSiteIconDataUri(s.iconFile);
    const visual = iconUri
      ? `<img class="ava-img" src="${iconUri}" alt="" />`
      : `<span class="ava" style="background:${s.bg};color:${s.fg}">${s.glyph}</span>`;
    return (
      `<a class="card" href="${s.url}">`
      + visual
      + `<span class="meta"><b>${s.name}</b><span class="tag">${s.tag}</span></span>`
      + `<span class="go">&rarr;</span></a>`
    );
  }).join("");

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${START_PAGE_TITLE}</title>
<style>
  :root {
    --bg: #f7faff;
    --surface: #ffffff;
    --surface-hover: #ffffff;
    --border: #e3eaf5;
    --border-hover: #bdd0f2;
    --text: #16243d;
    --muted: #64748b;
    --subtle: #94a3b8;
    --accent: #2563eb;
    --accent-ring: rgba(37, 99, 235, 0.14);
    --shadow: 0 2px 10px rgba(22, 36, 61, 0.04);
    --shadow-hover: 0 8px 22px rgba(37, 99, 235, 0.09);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #131722;
      --surface: #1b2131;
      --surface-hover: #21293d;
      --border: #2a344c;
      --border-hover: #3f5278;
      --text: #e6ecf8;
      --muted: #98a8c3;
      --subtle: #6e7f9e;
      --accent: #60a5fa;
      --accent-ring: rgba(96, 165, 250, 0.18);
      --shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
      --shadow-hover: 0 8px 24px rgba(0, 0, 0, 0.36);
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg);
    color: var(--text);
    padding: 36px 24px;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", sans-serif;
  }
  .wrap { width: 100%; max-width: 680px; }
  .eyebrow {
    font-size: 11px;
    letter-spacing: 0.22em;
    color: var(--subtle);
    margin-bottom: 10px;
    text-transform: uppercase;
  }
  h1 { font-size: 24px; font-weight: 700; letter-spacing: -0.01em; }
  h1 span { color: var(--accent); }
  .sub { margin-top: 7px; font-size: 13px; color: var(--muted); line-height: 1.55; }
  .search {
    margin: 22px 0 24px;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 46px;
    padding: 0 16px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    box-shadow: var(--shadow);
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .search:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-ring);
  }
  .search input {
    flex: 1;
    border: none;
    outline: none;
    background: transparent;
    font-size: 14px;
    color: var(--text);
  }
  .search input::placeholder { color: var(--subtle); }
  .search kbd {
    font-size: 11px;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 2px 7px;
  }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 11px; }
  .card {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 13px 14px;
    text-decoration: none;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 13px;
    transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
  }
  .card:hover {
    transform: translateY(-2px);
    background: var(--surface-hover);
    border-color: var(--border-hover);
    box-shadow: var(--shadow-hover);
  }
  .ava, .ava-img {
    width: 34px;
    height: 34px;
    border-radius: 9px;
    flex-shrink: 0;
  }
  .ava {
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 15px;
  }
  .ava-img {
    object-fit: cover;
    display: block;
    box-shadow: 0 1px 3px rgba(15, 23, 42, 0.1);
  }
  .meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .meta b { font-size: 13.5px; font-weight: 600; }
  .tag { font-size: 11px; color: var(--muted); }
  .go { margin-left: auto; color: var(--subtle); font-size: 14px; }
  .card:hover .go { color: var(--accent); }
  .foot { margin-top: 20px; font-size: 12px; color: var(--subtle); line-height: 1.6; }
  @media (max-width: 520px) { .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="wrap">
  <div class="eyebrow">DIANDIANREADING · NEW TAB</div>
  <h1>点点读书 · <span>新标签页</span></h1>
  <p class="sub">选择一个常用阅读或创作站点，或直接输入网址与书名开始阅读。登录态仅保存在本地分区。</p>
  <div class="search">
    <input id="q" placeholder="输入网址（如 book.douban.com）或书名后按 Enter" autofocus />
    <kbd>Enter</kbd>
  </div>
  <div class="grid">${cards}</div>
  <p class="foot">提示：在任意阅读页划词即可一键存摘录、问点点或写初稿；登录态与 Cookie 永不上传给 AI 模型。</p>
</div>
<script>
  const input = document.getElementById('q');
  function go() {
    const v = input.value.trim();
    if (!v) return;
    if (/^https?:\\/\\//i.test(v)) { location.href = v; return; }
    if (/^[a-z0-9-]+(\\.[a-z0-9-]+)+(\\/\\S*)?$/i.test(v)) { location.href = 'https://' + v; return; }
    location.href = 'https://book.douban.com/subject_search?search_text=' + encodeURIComponent(v);
  }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
</script>
</body>
</html>`;

  cachedStartPageUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  return cachedStartPageUrl;
}
