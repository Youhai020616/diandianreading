import fs from "node:fs";

export const name = "diandian-runtime-safety";
export const inject = ["tools", "systemPrompt"];

const ALWAYS_DENIED = new Set([
  "bash",
  "write",
  "edit",
  "multi_edit",
  "notebook_edit",
  "shell",
]);

const PLAN_DENIED = new Set([
  "library_save_highlight",
  "draft_create_or_revise",
  "obsidian_export_book",
  "obsidian_export_draft",
  "browser_open",
  "browser_navigate",
  "book_router_download",
]);

const CONFIRM_DENIED = new Set([
  "obsidian_export_book",
  "obsidian_export_draft",
  "book_router_download",
]);

function readCurrentMode() {
  const stateFile = (process.env.DIANDIAN_SAFETY_STATE_FILE || "").trim();
  if (stateFile) {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (parsed && (parsed.mode === "plan" || parsed.mode === "confirm" || parsed.mode === "auto")) {
        return parsed.mode;
      }
    } catch {
      // Fallback to env/default.
    }
  }
  const envMode = (process.env.DIANDIAN_SAFETY_MODE || "").trim();
  if (envMode === "plan" || envMode === "confirm" || envMode === "auto") {
    return envMode;
  }
  return "confirm";
}

export function apply(ctx) {
  ctx.tools.guard((exec) => {
    const toolName = String(exec?.name || "").trim();
    if (!toolName) return undefined;

    if (ALWAYS_DENIED.has(toolName)) {
      return {
        reason: `安全守卫已禁用底层系统工具 "${toolName}"，请使用点点读书内置阅读/知识库/草稿工具。`,
      };
    }

    const mode = readCurrentMode();
    if (mode === "plan" && PLAN_DENIED.has(toolName)) {
      return {
        reason: `当前处于「只读规划 (plan)」模式，已阻止写入或导航操作 "${toolName}"。请只给建议方案，不要尝试写入。`,
      };
    }
    if (mode === "confirm" && CONFIRM_DENIED.has(toolName)) {
      return {
        reason: `当前处于「安全确认 (confirm)」模式，外部磁盘导出或下载工具 "${toolName}" 需要用户点击界面按钮或切换到 auto 模式后执行。`,
      };
    }
    return undefined;
  });

  ctx.systemPrompt.section({
    name: "diandian:runtime-safety",
    order: 520,
    interpolate: false,
    text: () => {
      const mode = readCurrentMode();
      if (mode === "plan") {
        return "当前安全模式：plan（只读规划）。你可以阅读页面、检索书库与划线、分析讨论，但不得调用任何保存、新建草稿、导出 Obsidian 或跳转网页工具。";
      }
      if (mode === "auto") {
        return "当前安全模式：auto（全自动工作流）。你可以阅读页面、管理本地书库与 AI 草稿修订，也可以执行带冲突保护的 Obsidian 增量导出。";
      }
      return "当前安全模式：confirm（安全确认）。你可以读取右侧页面、检索/保存划线并生成独立的 AI 草稿版本（绝不覆盖用户手改版本）；涉及 Obsidian 外部写入或电子书下载时，请提醒用户在界面一键触发。";
    },
  });
}
