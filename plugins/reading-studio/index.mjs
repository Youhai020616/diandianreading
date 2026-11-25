import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "diandian-reading-studio";
export const inject = ["tools"];

function readBridgeConfig() {
  const url = (process.env.DIANDIAN_BRIDGE_URL || "").replace(/\/+$/, "");
  const token = process.env.DIANDIAN_BRIDGE_TOKEN || "";
  if (!url || !token) {
    throw new Error("点点读书本地知识库桥接服务未就绪");
  }
  return { url, token };
}

async function callBridge(routePath, body = {}) {
  const { url, token } = readBridgeConfig();
  const res = await fetch(`${url}${routePath}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await res.json();
  if (!res.ok || !payload.ok) {
    throw new Error(payload?.error || `Bridge ${routePath} failed (${res.status})`);
  }
  return payload.data;
}

const JSON_OBJECT_OUT = {
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
};

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: "library_list_books",
      description: "列出用户本地点点书库中的书籍（含书名、作者、划线数量、草稿数量与 bookId），支持按关键词筛选。",
      parameters: {
        query: {
          type: "string",
          description: "可选筛选关键词（匹配书名、作者、ISBN 或标签）",
        },
      },
      output: JSON_OBJECT_OUT,
      async execute(args) {
        return await callBridge("/library/books/list", { query: args.query ?? "" });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "library_get_highlights",
      description: "读取指定书籍（bookId）在本地知识库中的全部划线与个人想法。",
      parameters: {
        bookId: {
          type: "string",
          required: true,
          description: "书籍 ID（例如 bk_xxx，可先由 library_list_books 获取）",
        },
        query: {
          type: "string",
          description: "可选章节/关键词筛选",
        },
      },
      output: JSON_OBJECT_OUT,
      async execute(args) {
        return await callBridge("/library/highlights/list", {
          bookId: args.bookId,
          query: args.query ?? "",
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "library_search_highlights",
      description: "跨全部书籍全文检索用户的历史划线与想法，适合做主题串联或对比不同书的观点。",
      parameters: {
        query: {
          type: "string",
          required: true,
          description: "检索关键词",
        },
        limit: {
          type: "integer",
          description: "最多返回条数（默认 20，上限 50）",
        },
      },
      output: JSON_OBJECT_OUT,
      async execute(args) {
        return await callBridge("/library/highlights/search", {
          query: args.query,
          limit: args.limit ?? 20,
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "library_save_highlight",
      description: "把一条有价值的金句划线及想法沉淀到本地 SQLite 书库（自动去重，如书目不存在则自动建档）。",
      parameters: {
        bookTitle: {
          type: "string",
          required: true,
          description: "书名",
        },
        quote: {
          type: "string",
          required: true,
          description: "原文金句或划线段落",
        },
        author: {
          type: "string",
          description: "作者（可选）",
        },
        chapter: {
          type: "string",
          description: "章节名称（可选）",
        },
        note: {
          type: "string",
          description: "用户个人想法或点评（可选）",
        },
      },
      output: JSON_OBJECT_OUT,
      async execute(args) {
        return await callBridge("/library/highlights/save", args);
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "draft_list",
      description: "查看创作工作台中已有的书评/卡片文案/长文草稿列表及最新版本号。",
      parameters: {
        bookId: {
          type: "string",
          description: "可选按书籍 ID 过滤",
        },
      },
      output: JSON_OBJECT_OUT,
      async execute(args) {
        return await callBridge("/drafts/list", {
          ...(args.bookId ? { bookId: args.bookId } : {}),
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "draft_create_or_revise",
      description:
        "在创作工作台新建一篇 AI 原稿，或为已有草稿追加一条新的不可变 AI 修订版本（绝不覆盖用户人工修改过的版本）。写入的 title 必须简短明确，content 必须是可直接阅读/发布的纯净正文，不要包含“已存入书库”“需要的话我再…”等对话寒暄。",
      parameters: {
        draftId: {
          type: "string",
          description: "省略则新建草稿；传入已有 draftId 则追加新 AI 修订版本",
        },
        bookId: {
          type: "string",
          description: "关联的书籍 ID（可选）",
        },
        title: {
          type: "string",
          required: true,
          description: "草稿标题",
        },
        kind: {
          type: "string",
          enum: ["review", "card_copy", "thread", "script", "note"],
          description: "体裁：review(书评)、card_copy(卡片文案)、thread(小红书/帖子)、script(口播稿)、note(读书随笔)",
        },
        content: {
          type: "string",
          required: true,
          description: "完整的 Markdown 正文内容",
        },
        promptSummary: {
          type: "string",
          description: "一句话说明本次生成或修改的侧重点",
        },
      },
      output: JSON_OBJECT_OUT,
      async execute(args) {
        return await callBridge("/drafts/ai-save", {
          ...args,
          kind: args.kind || "review",
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "obsidian_export_book",
      description: "将指定书籍的元数据与全部划线增量导出到用户配置的 Obsidian Vault（自带改名对账与手工修改冲突保护）。",
      parameters: {
        bookId: {
          type: "string",
          required: true,
          description: "书籍 ID",
        },
      },
      output: JSON_OBJECT_OUT,
      async execute(args) {
        return await callBridge("/obsidian/export-book", { bookId: args.bookId });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "obsidian_export_draft",
      description: "将创作工作台中的指定草稿增量导出到用户配置的 Obsidian Vault（带冲突保护，绝不覆盖用户手工笔记）。",
      parameters: {
        draftId: {
          type: "string",
          required: true,
          description: "草稿 ID",
        },
      },
      output: JSON_OBJECT_OUT,
      async execute(args) {
        return await callBridge("/obsidian/export-draft", { draftId: args.draftId });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "book_router_status",
      description: "检查本机可选电子书路由组件 heartleo/zlib CLI 的安装状态与能力。",
      parameters: {},
      output: JSON_OBJECT_OUT,
      async execute() {
        return await callBridge("/router/status", {});
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "book_router_search",
      description: "当本机已安装并配置可选组件 heartleo/zlib CLI 时，通过用户自有账号检索书目候选。",
      parameters: {
        query: {
          type: "string",
          required: true,
          description: "检索书名、作者或 ISBN",
        },
        format: {
          type: "string",
          description: "可选格式过滤（如 epub、pdf）",
        },
        limit: {
          type: "integer",
          description: "返回数量上限（默认 8）",
        },
      },
      output: JSON_OBJECT_OUT,
      async execute(args) {
        return await callBridge("/router/search", args);
      },
    }),
  );
}
