/** Message shapes, tool-trace summaries, starters and history labels for the ask panel. */

export interface PendingPromptPayload {
  text: string;
  autoSend?: boolean;
}

export interface ToolTraceEntry {
  callId?: string;
  name: string;
  status: "running" | "done";
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  contexts?: string[];
  reasoning?: string;
  tools?: ToolTraceEntry[];
  streaming?: boolean;
}

export const TOOL_LABEL_MAP: Record<string, string> = {
  browser_read_page: "读取当前阅读页",
  browser_read_content: "读取当前阅读页",
  browser_state: "查看浏览器标签",
  browser_open: "打开网页",
  browser_navigate: "控制浏览器页面",
  library_list_books: "查看阅读笔记书目",
  library_search_highlights: "检索历史划线",
  library_get_book_notes: "读取书籍笔记",
  library_save_highlight: "存入本地划线",
  library_import_highlights: "导入读书划线",
  draft_list: "查看创作草稿",
  draft_read: "读取草稿内容",
  draft_create_or_revise: "写入创作草稿",
  obsidian_status: "检查 Obsidian 状态",
  obsidian_sync_book: "同步到 Obsidian",
  web_fetch: "查阅网页资料",
  web_search: "搜索公开资料",
  read: "读取本地资料",
  grep: "检索本地资料",
  glob: "查找本地文件",
};

export function formatToolLabel(rawName: string): string {
  const clean = rawName.trim();
  if (!clean || clean === "tool") return "执行操作";
  return TOOL_LABEL_MAP[clean] ?? clean.replace(/[_-]+/g, " ");
}

export function cleanReadablePageTitle(rawTitle: string): string {
  const stripped = rawTitle
    .replace(/\s*[-–—|]\s*(微信读书|WeRead|豆瓣读书|豆瓣|小红书|知乎|哔哩哔哩).*$/i, "")
    .replace(/^《|》$/g, "")
    .trim();
  const parts = stripped.split(/\s+[-–—]\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    // e.g. ["人类简史：从动物到上帝", "推荐序", "尤瓦尔·赫拉利"] -> "人类简史：从动物到上帝 · 推荐序"
    return `${parts[0]} · ${parts[1]}`;
  }
  return stripped || "当前阅读页";
}

export function normalizeDisplayTools(
  rawTools: ToolTraceEntry[] | undefined,
  isStreaming: boolean,
): ToolTraceEntry[] {
  if (!rawTools || rawTools.length === 0) return [];
  const hasNamed = rawTools.some((t) => t.name && t.name !== "tool");
  const filtered = hasNamed ? rawTools.filter((t) => t.name && t.name !== "tool") : rawTools;
  return filtered.map((t) => (isStreaming ? t : { ...t, status: "done" }));
}

export function summarizeToolTrace(tools: ToolTraceEntry[], isStreaming: boolean): {
  headline: string;
  isActive: boolean;
  grouped: Array<{ label: string; rawName: string; count: number; status: "running" | "done" }>;
} {
  const runningTool = [...tools].reverse().find((t) => t.status === "running");
  const grouped: Array<{ label: string; rawName: string; count: number; status: "running" | "done" }> = [];
  for (const t of tools) {
    const label = formatToolLabel(t.name);
    const prev = grouped[grouped.length - 1];
    if (prev && prev.label === label) {
      prev.count += 1;
      if (t.status === "running") prev.status = "running";
    } else {
      grouped.push({ label, rawName: t.name, count: 1, status: t.status });
    }
  }

  if (isStreaming && runningTool) {
    return {
      headline: `正在${formatToolLabel(runningTool.name)}…（第 ${tools.length} 步）`,
      isActive: true,
      grouped,
    };
  }

  const labelCounts = new Map<string, number>();
  for (const t of tools) {
    const label = formatToolLabel(t.name);
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  const summaryParts = [...labelCounts.entries()]
    .slice(0, 3)
    .map(([label, count]) => (count > 1 ? `${label} ×${count}` : label));
  const extra = labelCounts.size > 3 ? "等" : "";
  return {
    headline: `已完成 ${tools.length} 步操作 · ${summaryParts.join("、")}${extra}`,
    isActive: false,
    grouped,
  };
}

export const STARTERS = [
  {
    title: "和我读过的书碰一碰",
    desc: "把眼前观点与你阅读笔记里的历史划线做跨书对照、挑刺与印证",
    prompt:
      "请结合右侧当前页面或我最近读的书，检索我的阅读笔记里的历史划线与个人批注，找找我以前读过的书里有哪些观点能与它互相印证、又有哪些地方存在明显冲突，给我一份简洁的跨书对照思考。",
  },
  {
    title: "按我的口吻写小红书长文",
    desc: "结合阅读笔记中的划线与个人批注，按 STYLE.md 生成可一键排版的初稿",
    prompt:
      "请先查看我的阅读笔记里最近更新的书目、划线与个人批注，严格遵守我的 STYLE.md 去 AI 味要求，写一篇结构清晰（带 H2 小标题、原文引用与个人观点）的小红书读书长文初稿，并调用 draft_create_or_revise 存入创作工作台。",
  },
  {
    title: "给当前草稿加论据 & 去 AI 味",
    desc: "从阅读笔记中找出书摘支撑论点，并按你的个人风格打磨修订",
    prompt:
      "请先查看我创作工作台里最新的一篇草稿，再从我的阅读笔记里检索 2-3 条最能支撑或反转文章论点的历史划线，结合我的 STYLE.md 提出具体修改建议，并可追加一版更自然、更有个人锋芒的修订稿。",
  },
  {
    title: "把网页摘录存入阅读笔记",
    desc: "把豆瓣、微信读书或任意网页的选中灵感附点评直接存入本地知识库",
    prompt:
      "请读取右侧页面我刚刚选中的文字（若无选区则读取当前页核心段落），结合我的个人阅读画像写一句克制、有个人角度的短评，并帮我存入阅读笔记。",
  },
];

export function deriveSessionTitle(msgs: ChatMessage[]): string {
  const firstUser = msgs.find((m) => m.role === "user" && m.text.trim());
  const raw = (firstUser?.text ?? "新对话").replace(/\s+/g, " ").trim();
  return raw.length > 26 ? `${raw.slice(0, 26)}…` : raw || "新对话";
}

export function formatSessionTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diffMin = Math.floor((Date.now() - t) / 60_000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const d = new Date(t);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  ) {
    return "昨天";
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
