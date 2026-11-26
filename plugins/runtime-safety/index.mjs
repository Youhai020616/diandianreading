import fs from "node:fs";

export const name = "diandian-runtime-safety";
export const inject = ["tools", "systemPrompt"];

// One policy file shared with electron/security/safetyPolicy.ts.
const policy = JSON.parse(fs.readFileSync(new URL("./tool-policy.json", import.meta.url), "utf8"));
const ALWAYS_DENIED = new Set(policy.alwaysDenied);
const PLAN_DENIED = new Set(policy.planDenied);
const CONFIRM_DENIED = new Set(policy.confirmDenied);

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
        reason: `当前处于「安全确认 (confirm)」模式，外部磁盘导出工具 "${toolName}" 需要用户点击界面按钮或切换到 auto 模式后执行。`,
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
        return "当前安全模式：plan（只读规划）。你可以阅读页面、检索阅读笔记中的书目与划线、分析讨论，但不得调用任何保存、新建草稿、导出 Obsidian 或跳转网页工具。";
      }
      if (mode === "auto") {
        return "当前安全模式：auto（全自动工作流）。你可以阅读页面、管理阅读笔记与 AI 草稿修订，也可以执行带冲突保护的 Obsidian 增量导出。";
      }
      return "当前安全模式：confirm（安全确认）。你可以读取右侧页面、检索/保存划线并生成独立的 AI 草稿版本（绝不覆盖用户手改版本）；涉及 Obsidian 外部写入时，请提醒用户在界面一键触发；电子书下载只能由用户在界面操作。";
    },
  });
}
