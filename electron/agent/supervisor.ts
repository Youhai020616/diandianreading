import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline";
import type { ModelSettings } from "../security/secretStore";
import { resolveNodeRuntime } from "./nodeRuntime";
import { ROUTE_PROVIDER_ID, writeOverlayPatch } from "./overlay";

export type AgentEvent =
  | { kind: "engine-state"; state: "idle" | "booting" | "ready" | "error"; detail?: string }
  | { kind: "status"; running: boolean }
  | { kind: "stream"; streamRole: "assistant" | "reasoning"; text: string; sessionId: string | null }
  | { kind: "tool"; phase: "start" | "done"; name: string; callId?: string; sessionId: string | null }
  | { kind: "final"; sessionId: string | null; finalResponse: string; finishReason: string | null }
  | { kind: "session-reset" }
  | { kind: "error"; message: string; sessionId?: string | null };

export interface AgentSupervisorOptions {
  userDataDir: string;
  projectRoot: string;
  bridgeEndpoint: string;
  bridgeToken: string;
  twinDir: string;
  safetyStateFile: string;
  getSettings: () => ModelSettings;
  onEvent: (event: AgentEvent) => void;
}

export class AgentSupervisor {
  private readonly options: AgentSupervisorOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private readyPromise: Promise<void> | null = null;
  private running = false;
  private activeSessionId: string | null = null;
  private lastSettingsFingerprint = "";
  private stderrTail: string[] = [];

  constructor(options: AgentSupervisorOptions) {
    this.options = options;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async send(prompt: string, opts: { newSession?: boolean; sessionId?: string | null } = {}): Promise<void> {
    const trimmed = prompt.trim();
    if (!trimmed) throw new Error("消息不能为空");
    if (this.running) throw new Error("当前正在回复中，请稍候或先点击停止");

    const settings = this.options.getSettings();
    if (!settings.apiKey) {
      throw new Error("尚未配置 API Key，请先点击右上角「模型设置」填入 DeepSeek 或 OpenAI 兼容 API Key。");
    }

    await this.ensureReady(settings);
    if (!this.child || this.child.killed) {
      throw new Error("Agent 引擎未就绪");
    }

    if (opts.newSession) {
      this.activeSessionId = null;
    } else if (typeof opts.sessionId === "string" && opts.sessionId.trim()) {
      this.activeSessionId = opts.sessionId.trim();
    }

    this.writeCommand({
      cmd: "send",
      prompt: trimmed,
      sessionId: this.activeSessionId,
      newSession: opts.newSession === true,
    });
  }

  selectSession(sessionId: string | null): void {
    this.activeSessionId = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
    if (this.child && !this.child.killed) {
      this.writeCommand({ cmd: "select", sessionId: this.activeSessionId });
    }
  }

  async stopCurrentTurn(): Promise<void> {
    if (!this.child) return;
    // In M0 (stock npm sdk-app without custom cancel RPC), cleanly restart the bridge
    // subprocess to immediately abort an in-flight turn and release resources.
    this.running = false;
    await this.dispose();
    this.options.onEvent({ kind: "status", running: false });
    this.options.onEvent({ kind: "engine-state", state: "idle", detail: "已停止当前生成" });
  }

  resetSession(): void {
    this.activeSessionId = null;
    if (this.child && !this.child.killed) {
      this.writeCommand({ cmd: "reset" });
    } else {
      this.options.onEvent({ kind: "session-reset" });
    }
  }

  async reloadForSettingsChange(): Promise<void> {
    if (this.child) {
      await this.dispose();
    }
    this.lastSettingsFingerprint = "";
    this.options.onEvent({ kind: "engine-state", state: "idle" });
  }

  async dispose(): Promise<void> {
    const target = this.child;
    this.child = null;
    this.readyPromise = null;
    this.running = false;
    if (!target) return;

    try {
      target.stdin.write(`${JSON.stringify({ cmd: "dispose" })}\n`);
      target.stdin.end();
    } catch {
      // Ignore broken pipe.
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          target.kill("SIGKILL");
        } catch {
          // Ignore already exited.
        }
        done();
      }, 2_000);
      target.once("exit", () => {
        clearTimeout(timer);
        done();
      });
    });
  }

  private async ensureReady(settings: ModelSettings): Promise<void> {
    const fingerprint = `${settings.provider}|${settings.baseUrl}|${settings.model}|${settings.apiKey.length}:${settings.apiKey.slice(-4)}`;
    if (this.child && !this.child.killed && this.readyPromise && this.lastSettingsFingerprint === fingerprint) {
      return this.readyPromise;
    }

    if (this.child) {
      await this.dispose();
    }

    this.lastSettingsFingerprint = fingerprint;
    this.stderrTail = [];
    this.options.onEvent({ kind: "engine-state", state: "booting", detail: "正在启动 DeepSeek Harness 引擎…" });

    const dshHome = path.join(this.options.userDataDir, "harness-home");
    const workspaceDir = path.join(this.options.userDataDir, "workspace");
    fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });

    const pluginEntries = [
      {
        id: "diandian-reading-browser",
        entryPath: path.join(this.options.projectRoot, "plugins", "reading-browser", "index.mjs"),
      },
      {
        id: "diandian-reading-studio",
        entryPath: path.join(this.options.projectRoot, "plugins", "reading-studio", "index.mjs"),
      },
      {
        id: "diandian-twin-context",
        entryPath: path.join(this.options.projectRoot, "plugins", "twin-context", "index.mjs"),
      },
      {
        id: "diandian-runtime-safety",
        entryPath: path.join(this.options.projectRoot, "plugins", "runtime-safety", "index.mjs"),
      },
      {
        id: "diandian-live-stream",
        entryPath: path.join(this.options.projectRoot, "plugins", "live-stream", "index.mjs"),
      },
    ];
    const overlayPath = writeOverlayPatch({ dshHome, pluginEntries, settings });

    const bridgeScript = path.join(__dirname, "sdkBridge.mjs");
    const runtime = resolveNodeRuntime();

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...runtime.env,
      DSH_HOME: dshHome,
      DIANDIAN_LLM_API_KEY: settings.apiKey,
      DIANDIAN_BRIDGE_URL: this.options.bridgeEndpoint,
      DIANDIAN_BRIDGE_TOKEN: this.options.bridgeToken,
      DIANDIAN_TWIN_DIR: this.options.twinDir,
      DIANDIAN_SAFETY_STATE_FILE: this.options.safetyStateFile,
    };

    const child = spawn(runtime.bin, [bridgeScript], {
      cwd: this.options.projectRoot,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    this.readyPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const bootTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("DeepSeek Harness 引擎启动超时（90s）"));
      }, 95_000);

      const failBoot = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(bootTimer);
        this.options.onEvent({ kind: "engine-state", state: "error", detail: message });
        reject(new Error(message));
      };

      child.stderr.on("data", (chunk: Buffer) => {
        const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
        for (const l of lines) {
          this.stderrTail.push(l);
          if (this.stderrTail.length > 30) this.stderrTail.shift();
        }
      });

      rl.on("line", (line) => {
        let msg: AgentEvent | { kind: "ready" };
        try {
          msg = JSON.parse(line) as AgentEvent | { kind: "ready" };
        } catch {
          return;
        }
        if (msg.kind === "ready") {
          if (!settled) {
            settled = true;
            clearTimeout(bootTimer);
            this.options.onEvent({ kind: "engine-state", state: "ready" });
            resolve();
          }
          return;
        }
        if (msg.kind === "status") {
          this.running = msg.running;
        } else if (msg.kind === "final" && msg.sessionId) {
          this.activeSessionId = msg.sessionId;
        } else if (msg.kind === "error" && !settled) {
          failBoot(msg.message);
          return;
        }
        this.options.onEvent(msg);
      });

      child.once("exit", (code) => {
        rl.close();
        if (this.child === child) {
          this.child = null;
          this.readyPromise = null;
          this.running = false;
        }
        const tail = this.stderrTail.slice(-6).join("\n");
        if (!settled) {
          failBoot(`Harness 进程提前退出 (code=${code ?? "signal"})${tail ? `\n${tail}` : ""}`);
        } else {
          this.options.onEvent({ kind: "status", running: false });
          this.options.onEvent({
            kind: "engine-state",
            state: "idle",
            detail: code && code !== 0 ? `引擎进程已退出 (code=${code})` : undefined,
          });
        }
      });

      child.once("error", (err) => {
        failBoot(`无法启动 Node 运行时 (${runtime.bin}): ${err.message}`);
      });

      this.writeCommand({
        cmd: "init",
        patches: [overlayPath],
        dshHome,
        cwd: workspaceDir,
        provider: ROUTE_PROVIDER_ID,
        model: settings.model,
      });
    });

    return this.readyPromise;
  }

  private writeCommand(payload: Record<string, unknown>): void {
    if (!this.child || this.child.killed) return;
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }
}
