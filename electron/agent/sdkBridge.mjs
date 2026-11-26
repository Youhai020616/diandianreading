/**
 * Independent Node >=24 subprocess hosting @deepseek-ai/dsh-sdk-client.
 * Protocol: newline-delimited JSON on stdin/stdout.
 * Secrets (API keys, bridge tokens) arrive via process.env only — never logged or echoed.
 */
import * as readline from "node:readline";

let harness = null;
let activeSessionId = null;
const openSessions = new Set();
let busy = false;
const pendingToolNamesByCallId = new Map();
const pendingToolNameQueue = [];

function redact(input) {
  const text = String(input ?? "");
  const secrets = [
    process.env.DIANDIAN_LLM_API_KEY,
    process.env.DEEPSEEK_API_KEY,
    process.env.DIANDIAN_BRIDGE_TOKEN,
  ].filter((v) => typeof v === "string" && v.length >= 6);
  let out = text;
  for (const secret of secrets) {
    out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

function emit(payload) {
  const safePayload =
    payload && payload.kind === "error"
      ? { ...payload, message: redact(payload.message) }
      : payload;
  process.stdout.write(`${JSON.stringify(safePayload)}\n`);
}

function forwardNotification(notification, expectedSessionId) {
  if (!notification || typeof notification !== "object") return;
  const { method, params } = notification;
  if (method !== "session.event" || !params || typeof params !== "object") return;
  const eventSessionId = typeof params.sessionId === "string" ? params.sessionId : null;
  if (expectedSessionId && eventSessionId && eventSessionId !== expectedSessionId) return;

  const evt = params.event;
  if (!evt || typeof evt !== "object") return;

  if (evt.type === "assistant/chunk" && evt.data && typeof evt.data === "object") {
    const chunk = evt.data.chunk;
    if (!chunk || typeof chunk !== "object") return;
    if (chunk.type === "text-delta" && typeof chunk.text === "string" && chunk.text) {
      emit({ kind: "stream", streamRole: "assistant", text: chunk.text, sessionId: eventSessionId });
    } else if (chunk.type === "reasoning-delta" && typeof chunk.text === "string" && chunk.text) {
      emit({ kind: "stream", streamRole: "reasoning", text: chunk.text, sessionId: eventSessionId });
    }
    return;
  }

  if (evt.type === "tool/call" && evt.data && typeof evt.data === "object") {
    const toolName =
      typeof evt.data.name === "string" && evt.data.name.trim()
        ? evt.data.name.trim()
        : typeof evt.data.toolName === "string" && evt.data.toolName.trim()
          ? evt.data.toolName.trim()
          : "tool";
    const callId =
      typeof evt.data.callId === "string" && evt.data.callId.trim()
        ? evt.data.callId.trim()
        : typeof evt.data.id === "string" && evt.data.id.trim()
          ? evt.data.id.trim()
          : null;
    if (callId) {
      pendingToolNamesByCallId.set(callId, toolName);
    } else {
      pendingToolNameQueue.push(toolName);
    }
    emit({
      kind: "tool",
      phase: "start",
      name: toolName,
      ...(callId ? { callId } : {}),
      sessionId: eventSessionId,
    });
    return;
  }

  if (evt.type === "tool/result" && evt.data && typeof evt.data === "object") {
    const callId =
      typeof evt.data.callId === "string" && evt.data.callId.trim()
        ? evt.data.callId.trim()
        : typeof evt.data.message?.source?.callId === "string" && evt.data.message.source.callId.trim()
          ? evt.data.message.source.callId.trim()
          : typeof evt.data.id === "string" && evt.data.id.trim()
            ? evt.data.id.trim()
            : null;
    const mappedName = callId ? pendingToolNamesByCallId.get(callId) : undefined;
    if (callId) pendingToolNamesByCallId.delete(callId);

    const directName =
      typeof evt.data.name === "string" && evt.data.name.trim()
        ? evt.data.name.trim()
        : typeof evt.data.toolName === "string" && evt.data.toolName.trim()
          ? evt.data.toolName.trim()
          : typeof evt.data.message?.source?.toolName === "string" && evt.data.message.source.toolName.trim()
            ? evt.data.message.source.toolName.trim()
            : typeof evt.data.message?.name === "string" && evt.data.message.name.trim()
              ? evt.data.message.name.trim()
              : null;

    const toolName = directName || mappedName || pendingToolNameQueue.shift() || "tool";
    emit({
      kind: "tool",
      phase: "done",
      name: toolName,
      ...(callId ? { callId } : {}),
      sessionId: eventSessionId,
    });
  }
}

async function handleInit(cmd) {
  if (harness) {
    try {
      await harness.close();
    } catch {
      // Ignore cleanup errors on re-init.
    }
    harness = null;
    activeSessionId = null;
    openSessions.clear();
  }

  const { DeepSeekHarness } = await import("@deepseek-ai/dsh-sdk-client");
  harness = new DeepSeekHarness({
    ...(cmd.dshBin ? { dshBin: cmd.dshBin } : {}),
    patches: Array.isArray(cmd.patches) && cmd.patches.length > 0 ? cmd.patches : undefined,
    dshHome: cmd.dshHome,
    processCwd: cmd.cwd,
    cwd: cmd.cwd,
    provider: cmd.provider,
    model: cmd.model,
    initializeTimeoutMs: Number(process.env.DIANDIAN_ENGINE_BOOT_TIMEOUT_MS) || 90_000,
  });

  await harness.start();
  emit({ kind: "ready" });
}

async function handleSend(cmd) {
  if (!harness) {
    emit({ kind: "error", message: "Harness 引擎尚未初始化" });
    return;
  }
  if (busy) {
    emit({ kind: "error", message: "当前已有对话轮次正在运行，请等待完成或先停止" });
    return;
  }

  const prompt = String(cmd.prompt ?? "").trim();
  if (!prompt) {
    emit({ kind: "error", message: "请输入消息内容" });
    return;
  }

  busy = true;
  pendingToolNamesByCallId.clear();
  pendingToolNameQueue.length = 0;
  emit({ kind: "status", running: true });

  const requestedSessionId = cmd.newSession ? undefined : (cmd.sessionId || activeSessionId || undefined);
  try {
    // A session persisted by a previous SDK process must be resumed before its next prompt.
    const session = requestedSessionId && !openSessions.has(requestedSessionId)
      ? await harness.resumeSession(requestedSessionId)
      : harness.session(requestedSessionId);
    openSessions.add(session.id);
    const result = await session.run(prompt, {
      onNotification: (notification) => forwardNotification(notification, session.id),
    });
    activeSessionId = result.sessionId || activeSessionId;
    emit({
      kind: "final",
      sessionId: activeSessionId,
      finalResponse: result.finalResponse ?? "",
      finishReason: result.finishReason ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({
      kind: "error",
      sessionId: activeSessionId,
      message,
    });
  } finally {
    busy = false;
    emit({ kind: "status", running: false });
  }
}

async function handleDispose() {
  if (harness) {
    try {
      await harness.close();
    } catch {
      // Best-effort teardown.
    }
    harness = null;
  }
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let cmd;
  try {
    cmd = JSON.parse(trimmed);
  } catch {
    emit({ kind: "error", message: "Invalid JSON line on bridge stdin" });
    return;
  }

  if (cmd.cmd === "init") {
    void handleInit(cmd).catch((err) => {
      emit({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    });
  } else if (cmd.cmd === "send") {
    void handleSend(cmd);
  } else if (cmd.cmd === "reset") {
    activeSessionId = null;
    emit({ kind: "session-reset" });
  } else if (cmd.cmd === "select") {
    activeSessionId = typeof cmd.sessionId === "string" && cmd.sessionId.trim() ? cmd.sessionId.trim() : null;
  } else if (cmd.cmd === "dispose") {
    void handleDispose();
  }
});

rl.on("close", () => {
  void handleDispose();
});

process.on("SIGTERM", () => {
  void handleDispose();
});
process.on("SIGINT", () => {
  void handleDispose();
});
