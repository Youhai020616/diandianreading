/**
 * diandian-live-stream Cordis plugin
 * Subscribes to DeepSeek Harness's process-local `agent/assistant-stream` event
 * and forwards live `text-delta` & `reasoning-delta` frames over the authenticated
 * loopback bridge so Electron UI streams tokens in real time (~50fps micro-batched).
 */

export const name = "diandian-live-stream";

function createStreamForwarder() {
  const bridgeUrl = (process.env.DIANDIAN_BRIDGE_URL || "").replace(/\/+$/, "");
  const bridgeToken = process.env.DIANDIAN_BRIDGE_TOKEN || "";

  const pending = {
    assistant: "",
    reasoning: "",
    sessionId: null,
  };

  let flushTimer = null;
  let sendChain = Promise.resolve();

  const postDelta = (streamRole, text, sessionId) => {
    if (!bridgeUrl || !bridgeToken || !text) return;
    sendChain = sendChain
      .then(async () => {
        try {
          await fetch(`${bridgeUrl}/agent/stream`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${bridgeToken}`,
            },
            body: JSON.stringify({ streamRole, text, sessionId }),
            signal: AbortSignal.timeout(5_000),
          });
        } catch {
          // Non-fatal: final durable response still arrives via JSON-RPC.
        }
      })
      .catch(() => undefined);
  };

  const flushNow = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const sid = pending.sessionId;
    if (pending.reasoning) {
      const chunk = pending.reasoning;
      pending.reasoning = "";
      postDelta("reasoning", chunk, sid);
    }
    if (pending.assistant) {
      const chunk = pending.assistant;
      pending.assistant = "";
      postDelta("assistant", chunk, sid);
    }
  };

  const enqueue = (role, text, sessionId) => {
    if (!text) return;
    pending.sessionId = sessionId ?? pending.sessionId;
    if (role === "reasoning") {
      pending.reasoning += text;
    } else {
      pending.assistant += text;
    }
    if (!flushTimer) {
      flushTimer = setTimeout(flushNow, 18);
    }
  };

  const dispose = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    pending.assistant = "";
    pending.reasoning = "";
  };

  return { enqueue, flushNow, dispose };
}

export function apply(ctx) {
  const forwarder = createStreamForwarder();
  // Track per-session multi-step turns so post-tool text separates cleanly with \n\n
  const sessionState = new Map();

  const offStream = ctx.on("agent/assistant-stream", (payload) => {
    if (!payload || typeof payload !== "object") return;
    const { agent, frame } = payload;
    if (!frame || typeof frame !== "object") return;

    // Only forward root user-facing sessions, not internal background/subagent workers.
    if (agent?.session?.header?.origin === "subagent") return;
    const sessionId = agent?.session?.id ? String(agent.session.id) : null;
    const stateKey = sessionId || "__default__";

    if (frame.type === "start") {
      const prev = sessionState.get(stateKey);
      const isContinuationStep = prev && prev.turn === frame.turn && frame.step > prev.step;
      if (isContinuationStep) {
        prev.step = frame.step;
        prev.needsStepSeparator = prev.emittedText;
      } else {
        sessionState.set(stateKey, {
          turn: frame.turn ?? 0,
          step: frame.step ?? 1,
          emittedText: false,
          needsStepSeparator: false,
        });
      }
      return;
    }

    if (frame.type === "chunk" && frame.chunk && typeof frame.chunk === "object") {
      const { chunk } = frame;
      if (chunk.type === "text-delta" && typeof chunk.text === "string" && chunk.text) {
        let st = sessionState.get(stateKey);
        if (!st) {
          st = { turn: 0, step: 1, emittedText: false, needsStepSeparator: false };
          sessionState.set(stateKey, st);
        }
        const prefix = st.needsStepSeparator ? "\n\n" : "";
        st.needsStepSeparator = false;
        st.emittedText = true;
        forwarder.enqueue("assistant", `${prefix}${chunk.text}`, sessionId);
      } else if (chunk.type === "reasoning-delta" && typeof chunk.text === "string" && chunk.text) {
        forwarder.enqueue("reasoning", chunk.text, sessionId);
      }
      return;
    }

    if (frame.type === "end") {
      forwarder.flushNow();
    }
  });

  ctx.on("dispose", () => {
    if (typeof offStream === "function") offStream();
    forwarder.dispose();
  });
}
