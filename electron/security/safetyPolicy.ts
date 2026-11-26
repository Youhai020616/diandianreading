import fs from "node:fs";
import path from "node:path";

export type SafetyMode = "plan" | "confirm" | "auto";

export const VALID_SAFETY_MODES: readonly SafetyMode[] = ["plan", "confirm", "auto"] as const;

interface ToolPolicy {
  alwaysDenied: string[];
  planDenied: string[];
  confirmDenied: string[];
}

/** The guard that actually enforces this runs in the Harness process and reads the same file. */
export const TOOL_POLICY_FILE = path.resolve(__dirname, "..", "..", "plugins", "runtime-safety", "tool-policy.json");
const policy = JSON.parse(fs.readFileSync(TOOL_POLICY_FILE, "utf8")) as ToolPolicy;

export const ALWAYS_DENIED_TOOLS: ReadonlySet<string> = new Set(policy.alwaysDenied);
export const PLAN_DENIED_TOOLS: ReadonlySet<string> = new Set(policy.planDenied);
export const CONFIRM_DENIED_TOOLS: ReadonlySet<string> = new Set(policy.confirmDenied);

export function normalizeSafetyMode(raw: unknown): SafetyMode {
  if (raw === "plan" || raw === "confirm" || raw === "auto") return raw;
  return "confirm";
}

export function evaluateToolSafety(mode: SafetyMode, toolName: string): string | null {
  const name = toolName.trim();
  if (ALWAYS_DENIED_TOOLS.has(name)) {
    return `安全策略已禁止直接调用底层系统工具 "${name}"，请仅使用点点读书受控工作台工具。`;
  }
  if (mode === "plan" && PLAN_DENIED_TOOLS.has(name)) {
    return `当前处于「只读规划（plan）」安全模式，已拦截写入/导航类工具 "${name}"。请先输出方案，或请用户切换到 confirm / auto 模式。`;
  }
  if (mode === "confirm" && CONFIRM_DENIED_TOOLS.has(name)) {
    return `当前处于「安全确认（confirm）」模式，已拦截外部文件写入工具 "${name}"。请引导用户点击界面按钮手动触发，或切换到 auto 模式。`;
  }
  return null;
}

export class SafetyModeStore {
  readonly stateFilePath: string;

  constructor(userDataDir: string) {
    this.stateFilePath = path.join(userDataDir, "state", "safety-mode.json");
  }

  read(): SafetyMode {
    try {
      const raw = fs.readFileSync(this.stateFilePath, "utf8");
      const parsed = JSON.parse(raw) as { mode?: unknown };
      return normalizeSafetyMode(parsed.mode);
    } catch {
      return "confirm";
    }
  }

  write(mode: SafetyMode): SafetyMode {
    const normalized = normalizeSafetyMode(mode);
    fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.stateFilePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ mode: normalized, updatedAt: new Date().toISOString() }, null, 2),
      { encoding: "utf8", mode: 0o600 },
    );
    fs.renameSync(tmp, this.stateFilePath);
    return normalized;
  }
}
