import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "diandian-reading-browser";
export const inject = ["tools"];

function readBridgeConfig() {
  const url = (process.env.DIANDIAN_BRIDGE_URL || "").replace(/\/+$/, "");
  const token = process.env.DIANDIAN_BRIDGE_TOKEN || "";
  if (!url || !token) {
    throw new Error("内置浏览器桥接服务未就绪（请在点点读书桌面应用内使用）");
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
    throw new Error(payload?.error || `Browser bridge ${routePath} failed (${res.status})`);
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
      name: "browser_state",
      description:
        "查看右侧内置阅读浏览器当前状态，包括当前账号、所有已打开标签页的标题与 URL、以及当前激活标签。绝不返回 Cookie 或登录凭据。",
      parameters: {},
      output: JSON_OBJECT_OUT,
      async execute() {
        return await callBridge("/browser/state", {});
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "browser_read_page",
      description:
        "读取右侧内置阅读浏览器当前激活页面（支持微信读书 Canvas 阅读页本地视觉 OCR 识别、微信读书笔记页、豆瓣书评、公众号文章）的标题、URL、用户鼠标选中的文字以及当前屏幕可见正文。当用户提到“当前页”、“这段话”、“右侧页面”或“帮我整理这页笔记”时优先调用。读取后直接基于返回的 text/selection 回答，不要擅自跳转用户页面或去外部盗版站拼凑正文。",
      parameters: {
        maxChars: {
          type: "integer",
          description: "返回正文的最大字符数（默认 12000，上限 30000）",
        },
        tabId: {
          type: "string",
          description: "可选指定标签页 ID；省略则读取当前激活标签",
        },
      },
      output: JSON_OBJECT_OUT,
      async execute(args) {
        return await callBridge("/browser/read", {
          ...(args.maxChars !== undefined ? { maxChars: args.maxChars } : {}),
          ...(args.tabId ? { tabId: args.tabId } : {}),
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "browser_open",
      description:
        "在右侧内置阅读浏览器打开指定 HTTP/HTTPS 网页（例如微信读书 https://weread.qq.com、豆瓣读书、小红书或公众号后台）。禁止 file:// 等本地协议。",
      parameters: {
        url: {
          type: "string",
          required: true,
          description: "要打开的 http:// 或 https:// 完整网址",
        },
        newTab: {
          type: "boolean",
          description: "是否在新标签页打开，默认 false（在当前标签跳转）",
        },
      },
      output: JSON_OBJECT_OUT,
      async execute(args) {
        const raw = String(args.url ?? "").trim();
        if (!/^https?:\/\//i.test(raw)) {
          throw new Error("browser_open 仅允许打开 http:// 或 https:// 网页地址");
        }
        return await callBridge("/browser/open", {
          url: raw,
          newTab: args.newTab === true,
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "browser_navigate",
      description: "控制右侧内置阅读浏览器执行基础导航：back（后退）、forward（前进）、reload（刷新）、home（起始页）、weread（直达微信读书）。",
      parameters: {
        action: {
          type: "string",
          required: true,
          enum: ["back", "forward", "reload", "home", "weread"],
          description: "导航动作",
        },
      },
      output: JSON_OBJECT_OUT,
      async execute(args) {
        return await callBridge("/browser/navigate", { action: args.action });
      },
    }),
  );
}
