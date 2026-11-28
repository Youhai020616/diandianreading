// Each screenshot ships as WebP at its display width and twice that (for high-DPI screens), never
// larger than the original. The originals stay in docs/screenshots for the README.
import searchSet from "@shots/feature-1-search.png?w=640;1280&quality=82&format=webp&as=srcset";
import searchSrc from "@shots/feature-1-search.png?w=1280&quality=82&format=webp";
import sendSet from "@shots/feature-2-send.png?w=616;1232&quality=82&format=webp&as=srcset";
import sendSrc from "@shots/feature-2-send.png?w=1232&quality=82&format=webp";
import readerSet from "@shots/feature-3-reader.png?w=860;1720&quality=82&format=webp&as=srcset";
import readerSrc from "@shots/feature-3-reader.png?w=1720&quality=82&format=webp";
import themesSet from "@shots/feature-3-reader-themes.jpg?w=780;1560&quality=82&format=webp&as=srcset";
import themesSrc from "@shots/feature-3-reader-themes.jpg?w=1560&quality=82&format=webp";
import askSet from "@shots/feature-4-ask.png?w=394;788&quality=82&format=webp&as=srcset";
import askSrc from "@shots/feature-4-ask.png?w=788&quality=82&format=webp";
import visualSet from "@shots/feature-5-visual.png?w=860;1720&quality=82&format=webp&as=srcset";
import visualSrc from "@shots/feature-5-visual.png?w=1720&quality=82&format=webp";
import obsidianSet from "@shots/feature-6-obsidian.jpg?w=1000;2000&quality=82&format=webp&as=srcset";
import obsidianSrc from "@shots/feature-6-obsidian.jpg?w=2000&quality=82&format=webp";
import type { Lang } from "./i18n";

export const REPO = "https://github.com/Youhai020616/diandianreading";
export const VERSION = "2.0.0-alpha.0";
export const INSTALLERS = [
  { platform: "macOS", arch: "Apple Silicon", file: "mac-arm64.dmg" },
  { platform: "macOS", arch: "Intel", file: "mac-x64.dmg" },
  { platform: "Windows", arch: "x64", file: "win-x64.exe" },
  { platform: "Linux", arch: "x64", file: "linux-x86_64.AppImage" },
].map(({ platform, arch, file }) => ({
  platform,
  arch,
  url: `${REPO}/releases/download/v${VERSION}/diandianreading-${VERSION}-${file}`,
}));
export const RELEASES_URL = `${REPO}/releases`;
export const SECURITY_URL = `${REPO}/blob/main/SECURITY.md`;
export const PLUGINS_URL = `${REPO}/tree/main/plugins`;

export interface Shot {
  src: string;
  srcSet: string;
  alt: string;
  /** Natural CSS width the screenshot was taken at; caps how wide it is shown. */
  width: number;
}

export interface Feature {
  id: string;
  num: string;
  title: string;
  lede: string;
  points: string[];
  shots: Shot[];
  /** "split": text beside the picture. "wide": text above a full-width picture. */
  layout: "split" | "wide";
}

/** A headline line made of plain and highlighted runs. */
export type TitleLine = Array<{ text: string; mark?: boolean }>;

export interface SiteCopy {
  meta: { title: string; description: string };
  nav: { features: string; developers: string; faq: string; download: string; langLabel: string };
  hero: {
    eyebrow: string;
    title: TitleLine[];
    lede: string;
    download: string;
    source: string;
    meta: string;
    dayAlt: string;
    nightAlt: string;
    lampOff: string;
    lampOn: string;
    noteDay: string;
    noteNight: string;
  };
  fragments: { eyebrow: string; title: string; notes: string[]; answer: string; flow: string[]; flowLabel: string };
  features: { title: string; items: Feature[] };
  dev: { eyebrow: string; title: string; lede: string; notePrefix: string; noteSuffix: string; button: string; code: string };
  download: { title: string; meta: string; all: string; install: Record<"macOS" | "Windows" | "Linux", string>; firstLaunch: string };
  faq: { title: string; items: Array<{ q: string; a: string }> };
  footer: { tagline: string; releases: string; security: string; license: string; linksLabel: string };
}

const IMG = {
  search: { src: searchSrc, srcSet: searchSet, width: 640 },
  send: { src: sendSrc, srcSet: sendSet, width: 616 },
  reader: { src: readerSrc, srcSet: readerSet, width: 860 },
  themes: { src: themesSrc, srcSet: themesSet, width: 780 },
  ask: { src: askSrc, srcSet: askSet, width: 394 },
  visual: { src: visualSrc, srcSet: visualSet, width: 860 },
  obsidian: { src: obsidianSrc, srcSet: obsidianSet, width: 1000 },
};

const pluginCode = (description: string, registerNote: [string, string]) => `// plugins/my-plugin/index.mjs
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "my-plugin";
export const inject = ["tools"];

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: "my_tool",
      description: "${description}",
      parameters: { query: { type: "string" } },
      async execute(args) {
        return { echo: args.query ?? "" };
      },
    }),
  );
}

// ${registerNote[0]}
// ${registerNote[1]}`;

const ZH: SiteCopy = {
  meta: {
    title: "点点读书 · 个人读书创作发布工作台",
    description: "点点读书把找书、传书、阅读、划线、问 AI、写作、出图和导出 Obsidian 收进一个桌面应用。前一步留下的划线和想法，直接成为下一步的素材。",
  },
  nav: { features: "功能", developers: "开发者", faq: "常见问题", download: "下载", langLabel: "切换语言" },
  hero: {
    eyebrow: "DIANDIAN READING · 点点读书",
    title: [[{ text: "个人读书" }], [{ text: "创作发布", mark: true }, { text: "工作台" }]],
    lede: "找书、传书、阅读、划线、问 AI、写作、出图、导出 Obsidian——原本散在六七个工具里的事，点点读书把它们收进一张书桌。前一步留下的划线和想法，直接成为下一步的素材。",
    download: "下载桌面版",
    source: "在 GitHub 查看源码",
    meta: `v${VERSION} · macOS · Windows · Linux · 免费开源（MIT）`,
    dayAlt: "点点读书的搜书页、右侧微信读书和 AI 伴读面板（白天模式）",
    nightAlt: "同一画面的夜读模式",
    lampOff: "拉绳关灯，切换夜读模式",
    lampOn: "拉绳开灯，切换白天模式",
    noteDay: "拉一下灯绳\n切换夜读 →",
    noteNight: "再拉一下\n开灯 →",
  },
  fragments: {
    eyebrow: "为什么做点点读书",
    title: "以前，一本书要经过六七个工具。",
    notes: [
      "去书源网站找书",
      "想办法传进微信读书或 Kindle",
      "复制段落，贴进聊天窗口问 AI",
      "忍受满屏「AI 腔」的总结",
      "打开排版工具做小红书配图",
      "再整理一遍，塞进 Obsidian",
    ],
    answer: "现在，它们在同一张书桌上。",
    flow: ["找书", "传书", "阅读", "问 AI", "写作", "出图", "沉淀"],
    flowLabel: "使用流程",
  },
  features: {
    title: "主要功能",
    items: [
      {
        id: "search",
        num: "01",
        title: "搜书与下载",
        lede: "登录一次，之后只管找书。",
        points: [
          "在右侧内置浏览器登录你自己的 Z-Library 账号，登录状态自动同步。",
          "按书名、作者、ISBN 搜索，按格式和排序筛选，随时看到当天剩余的下载次数。",
          "书籍详情页一键在右侧打开豆瓣评分和书评。",
        ],
        shots: [{ ...IMG.search, alt: "搜书结果：格式和排序筛选、当天剩余下载次数" }],
        layout: "split",
      },
      {
        id: "send",
        num: "02",
        title: "一键传到微信读书或 Kindle",
        lede: "下载好的书，留在你习惯的地方读。",
        points: [
          "EPUB / PDF / MOBI / AZW3 / TXT 一键传进微信读书书架。",
          "网页版微信读书没有传书接口：第一次传书时扫码开通传书通道，扫完自动接着上传那本书。",
          "也可以通过邮件推送到 Kindle，邮箱授权码用系统钥匙串加密保存。",
        ],
        shots: [{ ...IMG.send, alt: "微信读书传书通道与 Kindle 邮件推送" }],
        layout: "split",
      },
      {
        id: "read",
        num: "03",
        title: "两种阅读方式，内置中英互译",
        lede: "右边读微信读书网页版，或者在本地慢慢读。",
        points: [
          "右侧内置浏览器直接读微信读书网页版，不同账号的 Cookie 互相隔离；选中文字可存为笔记、发给问点点或写进草稿。",
          "本地 EPUB 阅读器逐段中英互译：自动识别原文语言，用 DeepL 或你配置的大模型翻译，译文缓存在本地。",
          "划线 5 种颜色、写想法、划词翻译；日夜模式、9 套配色和纸张质感随时切换。",
        ],
        shots: [
          { ...IMG.reader, alt: "本地阅读器：中文原文与英文译文对照" },
          { ...IMG.themes, alt: "划词工具条、夜间模式、主题面板与划词翻译" },
        ],
        layout: "wide",
      },
      {
        id: "ask",
        num: "04",
        title: "AI 伴读「问点点」",
        lede: "它记得你划过什么、想过什么。",
        points: [
          "能读你右侧正在看的页面；微信读书网页版这类图片式渲染的页面，先在本机用 macOS 自带的文字识别读出这一屏。",
          "检索你书库里的旧划线和想法，做跨书对照和讲解，比如「和我读过的书碰一碰」。",
          "几本书、网页和草稿可以放进同一个主题空间，一起当作上下文。",
        ],
        shots: [{ ...IMG.ask, alt: "问点点把《窄门》和你在其他书里的划线做对照" }],
        layout: "split",
      },
      {
        id: "write",
        num: "05",
        title: "从读书笔记到小红书、公众号",
        lede: "像你本人动笔，而不是像一个聊天机器人。",
        points: [
          "划线一键写入草稿，或让 AI 读完一本书的全部划线和想法，起草一篇书评。",
          "创作工作台保留 AI 原稿和你的每一次修改；从你的改动里提炼写作习惯，经你确认后写进 STYLE.md。",
          "生成 3:4 小红书配图（4 种版式、5 套配色、自动匹配真实书封），或复制富文本，到右侧打开的小红书、公众号后台粘贴发布。",
        ],
        shots: [{ ...IMG.visual, alt: "小红书配图工坊：书封首图版式，自动匹配真实书封" }],
        layout: "split",
      },
      {
        id: "obsidian",
        num: "06",
        title: "一键导出到 Obsidian",
        lede: "读过的书，沉淀成你自己的知识库。",
        points: [
          "划线和想法存在本机 SQLite，支持中英文全文检索；Kindle 和微信读书的划线也能导入进来。",
          "一本书的笔记或一篇草稿一键导出为 Markdown；你在 Obsidian 里改过的那一篇，会另存一份冲突副本，不会被覆盖。",
          "桌面上的小金毛每天推一条旧划线给你，⌘⇧D 随手摘录剪贴板里的句子。",
        ],
        shots: [{ ...IMG.obsidian, alt: "左边是点点读书的阅读笔记，右边是导出到 Obsidian 的同一本书" }],
        layout: "wide",
      },
    ],
  },
  dev: {
    eyebrow: "给开发者 · 基于 DeepSeek Harness",
    title: "兼容 Harness 插件生态",
    lede: "点点读书的 AI 能力都是 Harness 原生插件。照同样的格式写一个，登记一行就能加载。",
    notePrefix: "出于安全，默认关闭了 shell、workflow 等自带能力，原因见",
    noteSuffix: "。",
    button: "看看 5 个现成插件",
    code: pluginCode("告诉模型这个工具做什么", ["最后在 pluginEntries 里登记一行", "（electron/agent/supervisor.ts）"]),
  },
  download: {
    title: "下载点点读书",
    meta: `v${VERSION}（预发布）· 选择适合你电脑的安装包`,
    all: "全部版本",
    install: {
      macOS: "在「关于本机」查看芯片型号。打开对应的 DMG，把「点点读书」拖入「应用程序」。",
      Windows: "运行下载的 x64 安装程序（.exe）。",
      Linux: "在文件属性中允许 AppImage 作为程序执行，然后双击打开。",
    },
    firstLaunch: "要使用 AI 伴读，请在左下角「模型」填入 DeepSeek 或兼容 OpenAI 接口的 API Key。",
  },
  faq: {
    title: "常见问题",
    items: [
      {
        q: "为什么提示「无法验证开发者」？",
        a: "安装包还没有经过 Apple 签名和公证。先打开一次，再到「系统设置 → 隐私与安全性」点「仍要打开」；也可以在终端执行 xattr -dr com.apple.quarantine \"/Applications/点点读书.app\"。",
      },
      {
        q: "支持哪些电脑？",
        a: "支持 Apple Silicon 和 Intel Mac，以及使用 Intel 或 AMD 64 位处理器的 Windows 和 Linux 电脑。图像文字识别和从本机浏览器导入登录状态目前仅支持 macOS；其他系统可直接在应用内登录。",
      },
      {
        q: "需要准备什么？",
        a: "一个 DeepSeek 或任意 OpenAI 兼容接口的 API Key。搜书需要你自己的 Z-Library 账号，传微信读书需要扫码开通传书通道，推送 Kindle 需要一个发件邮箱。书源组件和 AI 引擎需要的 Node.js 都已内置。",
      },
      {
        q: "我的数据存在哪里？",
        a: "书库、划线、草稿和修改记录存在你电脑上的 SQLite；阅读画像和写作风格是两份本地文本文件。使用 AI 功能时，相关内容会发送给你自己配置的模型服务，详见 SECURITY.md。",
      },
      { q: "收费吗？", a: "应用免费，以 MIT 协议开源。模型调用按你自己的服务商计费。" },
    ],
  },
  footer: { tagline: "点点读书 · 个人读书创作发布工作台", releases: "Releases", security: "安全说明", license: "MIT 协议", linksLabel: "页脚链接" },
};

const EN: SiteCopy = {
  meta: {
    title: "点点读书 diandianreading · A personal studio for reading, writing & publishing",
    description: "点点读书 puts finding books, sending them to your reader, reading, highlighting, asking AI, writing, making images and exporting to Obsidian into one desktop app.",
  },
  nav: { features: "Features", developers: "Developers", faq: "FAQ", download: "Download", langLabel: "Switch language" },
  hero: {
    eyebrow: "DIANDIAN READING · 点点读书",
    title: [[{ text: "A personal studio for" }], [{ text: "reading, " }, { text: "writing & publishing", mark: true }]],
    lede: "Finding books, sending them to your reader, reading, highlighting, asking AI, writing, making images and exporting to Obsidian used to take six or seven tools. 点点读书 puts them on one desk, so every highlight and thought becomes material for the next step.",
    download: "Download the desktop app",
    source: "View source on GitHub",
    meta: `v${VERSION} · macOS · Windows · Linux · Free, open source (MIT) · Chinese interface`,
    dayAlt: "点点读书's discover page, the WeRead web reader and the AI companion (day mode)",
    nightAlt: "The same screen in night-reading mode",
    lampOff: "Pull the cord to turn the lamp off and switch to night reading",
    lampOn: "Pull the cord to turn the lamp on and switch to day mode",
    noteDay: "Pull the cord\nfor night reading →",
    noteNight: "Pull again\nfor the lights →",
  },
  fragments: {
    eyebrow: "Why 点点读书",
    title: "A book used to pass through six or seven tools.",
    notes: [
      "Hunt for the book on a book-source site",
      "Find a way to get it onto WeRead or Kindle",
      "Copy passages into a chat window to ask AI",
      "Put up with summaries that sound like AI",
      "Open a design tool for Xiaohongshu images",
      "Tidy it all up again for Obsidian",
    ],
    answer: "Now they share one desk.",
    flow: ["Find", "Send", "Read", "Ask AI", "Write", "Design", "Keep"],
    flowLabel: "Workflow",
  },
  features: {
    title: "Features",
    items: [
      {
        id: "search",
        num: "01",
        title: "Find and download books",
        lede: "Log in once, then just look for books.",
        points: [
          "Log in to your own Z-Library account in the built-in browser on the right; the session syncs automatically.",
          "Search by title, author or ISBN, filter by format and sort order, and see how many downloads you have left today.",
          "Open a book's Douban rating and reviews in the right-hand browser with one click.",
        ],
        shots: [{ ...IMG.search, alt: "Search results with format and sort filters and today's remaining downloads" }],
        layout: "split",
      },
      {
        id: "send",
        num: "02",
        title: "Send books to WeRead or Kindle",
        lede: "Read your downloads wherever you already read.",
        points: [
          "Send EPUB / PDF / MOBI / AZW3 / TXT files to your WeRead shelf in one click.",
          "WeRead's web version has no upload API: the first upload shows a QR code, and once you scan it the book you were sending uploads right after.",
          "Or email books to your Kindle; the mailbox authorization code is encrypted with the system keychain.",
        ],
        shots: [{ ...IMG.send, alt: "WeRead upload channel and Kindle email delivery" }],
        layout: "split",
      },
      {
        id: "read",
        num: "03",
        title: "Two ways to read, with Chinese–English translation",
        lede: "Read WeRead's web version on the right, or take your time locally.",
        points: [
          "The built-in browser on the right opens WeRead's web reader directly, with each account's cookies kept apart; select text to save a note, ask 问点点 or drop it into a draft.",
          "The local EPUB reader translates paragraph by paragraph between Chinese and English: it detects the source language, uses DeepL or your configured model, and caches translations locally.",
          "Highlights in 5 colors, notes and selection translation; day and night modes, 9 color themes and paper textures.",
        ],
        shots: [
          { ...IMG.reader, alt: "Local reader with the Chinese original and its English translation" },
          { ...IMG.themes, alt: "Selection toolbar, night mode, theme panel and selection translation" },
        ],
        layout: "wide",
      },
      {
        id: "ask",
        num: "04",
        title: "AI reading companion 问点点",
        lede: "It remembers what you highlighted and what you thought.",
        points: [
          "Reads the page open on the right; image-rendered pages such as WeRead's web reader are first read on your Mac with macOS's built-in text recognition.",
          "Searches your past highlights and thoughts to compare and explain ideas across books, e.g. “compare with books I've read”.",
          "Put several books, web pages and drafts into one topic notebook to use them together as context.",
        ],
        shots: [{ ...IMG.ask, alt: "问点点 comparing 《窄门》 with highlights from your other books" }],
        layout: "split",
      },
      {
        id: "write",
        num: "05",
        title: "From reading notes to Xiaohongshu and WeChat posts",
        lede: "Sounds like you wrote it, not like a chatbot.",
        points: [
          "Send a highlight to a draft, or let the AI read all of a book's highlights and thoughts and draft a review.",
          "The writing studio keeps the AI's original and every revision you make; it suggests writing habits drawn from your edits, and the ones you accept go into STYLE.md.",
          "Make 3:4 Xiaohongshu images (4 layouts, 5 color themes, real book covers matched automatically), or copy rich text and paste it into Xiaohongshu or the WeChat Official Accounts dashboard in the right-hand browser.",
        ],
        shots: [{ ...IMG.visual, alt: "Xiaohongshu image studio: cover layout with the real book cover" }],
        layout: "split",
      },
      {
        id: "obsidian",
        num: "06",
        title: "One-click export to Obsidian",
        lede: "Turn what you've read into your own knowledge base.",
        points: [
          "Highlights and thoughts live in a local SQLite database with Chinese and English full-text search; Kindle and WeRead highlights can be imported too.",
          "Export a book's notes or a draft as Markdown in one click; if you edited the same note in Obsidian, a conflict copy is written instead of overwriting it.",
          "The desktop golden retriever brings back one old highlight a day, and ⌘⇧D captures whatever sentence is on your clipboard.",
        ],
        shots: [{ ...IMG.obsidian, alt: "Reading notes in 点点读书 (left) and the same book exported to Obsidian (right)" }],
        layout: "wide",
      },
    ],
  },
  dev: {
    eyebrow: "For developers · built on DeepSeek Harness",
    title: "Compatible with Harness plugins",
    lede: "点点读书's AI features are native Harness plugins. Write one in the same format and register it with one line to load it.",
    notePrefix: "For safety, built-in capabilities such as shell and workflow are off by default; see",
    noteSuffix: " for why.",
    button: "See the 5 built-in plugins",
    code: pluginCode("Tell the model what this tool does", ["Then register it with one line in pluginEntries", "(electron/agent/supervisor.ts)"]),
  },
  download: {
    title: "Download 点点读书",
    meta: `v${VERSION} (pre-release) · Choose your installer`,
    all: "All releases",
    install: {
      macOS: "Check your chip in About This Mac. Open the matching DMG and drag 点点读书 to Applications.",
      Windows: "Run the downloaded x64 installer (.exe).",
      Linux: "Mark the AppImage as executable in its file properties, then open it.",
    },
    firstLaunch: "To use the AI companion, add a DeepSeek or OpenAI-compatible API key under 模型 (Model) in the bottom-left corner.",
  },
  faq: {
    title: "FAQ",
    items: [
      {
        q: "Why does macOS say it can't verify the developer?",
        a: "The installer is not yet signed or notarized by Apple. Try to open it once, then click Open Anyway in System Settings → Privacy & Security, or run xattr -dr com.apple.quarantine \"/Applications/点点读书.app\" in Terminal.",
      },
      {
        q: "Is the app in English?",
        a: "Not yet: the interface is in Chinese. The local reader translates books both ways between Chinese and English.",
      },
      {
        q: "Which computers are supported?",
        a: "Installers are available for Apple Silicon and Intel Macs, and for Windows and Linux PCs with 64-bit Intel or AMD processors. Image-based page OCR and importing a local browser profile are available on macOS. On other platforms you can sign in using the built-in browser.",
      },
      {
        q: "What do I need?",
        a: "A DeepSeek or OpenAI-compatible API key. Searching needs your own Z-Library account, sending to WeRead needs a QR scan, and Kindle delivery needs a sending mailbox. The book-source component and the Node.js the AI engine needs are bundled.",
      },
      {
        q: "Where is my data stored?",
        a: "Your library, highlights, drafts and revision history are in SQLite on your computer; your reading profile and writing style are two local text files. When you use AI features, the relevant content is sent to the model provider you configured; see SECURITY.md.",
      },
      { q: "Does it cost anything?", a: "The app is free and open source under the MIT License. Model usage is billed by your own provider." },
    ],
  },
  footer: { tagline: "点点读书 · A personal studio for reading, writing & publishing", releases: "Releases", security: "Security", license: "MIT License", linksLabel: "Footer links" },
};

export const COPY: Record<Lang, SiteCopy> = { zh: ZH, en: EN };
export const META: Record<Lang, SiteCopy["meta"]> = { zh: ZH.meta, en: EN.meta };
