import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeRejection, LocalBridgeServer } from "../electron/agent/bridgeServer";
import { resolveNodeRuntime } from "../electron/agent/nodeRuntime";
import { buildOverlayYaml, ROUTE_PROVIDER_ID, writeOverlayPatch } from "../electron/agent/overlay";
import { normalizeAllowedWebUrl } from "../electron/browser/urlPolicy";
import { ModelSettingsStore, normalizeBaseUrl, PLAINTEXT_KEY_CONSENT_REQUIRED } from "../electron/security/secretStore";
import { matchesTrustedAppUrl } from "../electron/security/urlMatch";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diandian-v2-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("Trusted IPC URL matching", () => {
  it("accepts identical file or http URLs ignoring hash fragments", () => {
    expect(matchesTrustedAppUrl("file:///app/dist/index.html#chat", "file:///app/dist/index.html")).toBe(true);
    expect(matchesTrustedAppUrl("http://127.0.0.1:5173/#settings", "http://127.0.0.1:5173/")).toBe(true);
  });

  it("rejects mismatched origins, paths, or malformed URLs", () => {
    expect(matchesTrustedAppUrl("https://evil.example/", "http://127.0.0.1:5173/")).toBe(false);
    expect(matchesTrustedAppUrl("file:///etc/passwd", "file:///app/dist/index.html")).toBe(false);
    expect(matchesTrustedAppUrl("not-a-url", "file:///app/dist/index.html")).toBe(false);
  });
});

describe("Browser URL allowlist", () => {
  it("normalizes bare domains and preserves valid https URLs", () => {
    expect(normalizeAllowedWebUrl("weread.qq.com")).toBe("https://weread.qq.com/");
    expect(normalizeAllowedWebUrl("https://book.douban.com/subject/123")).toBe(
      "https://book.douban.com/subject/123",
    );
  });

  it("rejects file://, javascript:, and empty URLs", () => {
    expect(() => normalizeAllowedWebUrl("file:///etc/passwd")).toThrow();
    expect(() => normalizeAllowedWebUrl("javascript:alert(1)")).toThrow();
    expect(() => normalizeAllowedWebUrl("   ")).toThrow();
  });
});

describe("ModelSettingsStore", () => {
  it("encrypts API key with safeStorage and never leaks plaintext in public snapshot", () => {
    const dir = makeTempDir();
    const fakeSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (v: string) => Buffer.from(`enc:${v}`, "utf8"),
      decryptString: (b: Buffer) => b.toString("utf8").replace(/^enc:/, ""),
    };
    const store = new ModelSettingsStore(dir, fakeSafeStorage);

    const saved = store.save({
      provider: "deepseek",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1/",
      apiKey: "sk-secret-value-123456",
    });

    expect(saved.hasApiKey).toBe(true);
    expect(saved.apiKeySource).toBe("saved");
    expect(saved.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(JSON.stringify(saved)).not.toContain("sk-secret-value-123456");

    const diskContent = fs.readFileSync(path.join(dir, "config", "model-settings.json"), "utf8");
    expect(diskContent).not.toContain("sk-secret-value-123456");
    expect(store.readRaw().apiKey).toBe("sk-secret-value-123456");

    const cleared = store.save({
      provider: "deepseek",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1",
      clearApiKey: true,
    });
    expect(cleared.apiKeySource).not.toBe("saved");
  });

  it("asks before storing a new key in plain text and reports how the key is stored", () => {
    const dir = makeTempDir();
    const noKeychain = {
      isEncryptionAvailable: () => false,
      encryptString: () => { throw new Error("unavailable"); },
      decryptString: () => { throw new Error("unavailable"); },
    };
    const store = new ModelSettingsStore(dir, noKeychain);
    const base = { provider: "deepseek", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1" } as const;
    expect(store.readPublic()).toMatchObject({ apiKeyStorage: "none", secureStorageAvailable: false });
    expect(() => store.save({ ...base, apiKey: "sk-plain-123456" })).toThrow(PLAINTEXT_KEY_CONSENT_REQUIRED);
    expect(fs.existsSync(path.join(dir, "config", "model-settings.json"))).toBe(false);

    const saved = store.save({ ...base, apiKey: "sk-plain-123456", allowPlaintextKey: true });
    expect(saved).toMatchObject({ apiKeyStorage: "plain", apiKeySource: "saved", hasApiKey: true });
    expect(JSON.stringify(saved)).not.toContain("sk-plain-123456");
    // Switching models keeps the consented key without asking again.
    expect(store.save({ ...base, model: "deepseek-reasoner" }).apiKeyStorage).toBe("plain");
  });

  it("never writes a key that only came from the environment", () => {
    const dir = makeTempDir();
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "sk-env-only-987654";
    try {
      const store = new ModelSettingsStore(dir, {
        isEncryptionAvailable: () => true,
        encryptString: (v: string) => Buffer.from(`enc:${v}`, "utf8"),
        decryptString: (b: Buffer) => b.toString("utf8").replace(/^enc:/, ""),
      });
      const saved = store.save({ provider: "deepseek", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1" });
      expect(saved).toMatchObject({ apiKeySource: "env", apiKeyStorage: "none", hasApiKey: true, secureStorageAvailable: true });
      const disk = fs.readFileSync(path.join(dir, "config", "model-settings.json"), "utf8");
      expect(disk).not.toContain("sk-env-only-987654");
      expect(disk).not.toContain(Buffer.from("enc:sk-env-only-987654").toString("base64"));
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
    }
  });

  it("rejects credentials embedded in baseUrl", () => {
    expect(() => normalizeBaseUrl("https://user:pass@api.example.com/v1")).toThrow();
    expect(() => normalizeBaseUrl("ftp://api.example.com")).toThrow();
  });
});

describe("Node runtime resolution", () => {
  it("falls back to ELECTRON_RUN_AS_NODE=1 when system node is older than v24", () => {
    const resolved = resolveNodeRuntime({
      overridePath: "",
      electronExecPath: "/Applications/Diandian.app/Contents/MacOS/Diandian",
      probe: () => ({ ok: false, version: "20.18.0" }),
    });
    expect(resolved.source).toBe("electron-run-as-node");
    expect(resolved.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(resolved.bin).toBe("/Applications/Diandian.app/Contents/MacOS/Diandian");
  });

  it("uses system node when version >= 24", () => {
    const resolved = resolveNodeRuntime({
      overridePath: "",
      probe: () => ({ ok: true, version: "26.13.1" }),
    });
    expect(resolved.source).toBe("system");
    expect(resolved.bin).toBe("node");
    expect(resolved.env).toEqual({});
  });
});

describe("Cordis overlay generation", () => {
  it("wires llm-pi-ai and reading-browser plugin without embedding API keys", () => {
    const dir = makeTempDir();
    const pluginPath = path.join(dir, "plugin.mjs");
    fs.writeFileSync(pluginPath, "export const name = 'test'; export function apply() {}\n", "utf8");

    const yaml = buildOverlayYaml({
      dshHome: dir,
      pluginEntryPath: pluginPath,
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-must-not-appear-in-yaml",
      },
    });

    expect(yaml).toContain(ROUTE_PROVIDER_ID);
    expect(yaml).toContain("api: openai-completions");
    expect(yaml).toContain("apiKeyEnv: DIANDIAN_LLM_API_KEY");
    expect(yaml).toContain("diandian-reading-browser");
    expect(yaml).not.toContain("sk-must-not-appear-in-yaml");

    const written = writeOverlayPatch({
      dshHome: dir,
      pluginEntryPath: pluginPath,
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-must-not-appear-in-yaml",
      },
    });
    expect(fs.existsSync(written)).toBe(true);
  });
});

describe("LocalBridgeServer authentication & routing", () => {
  it("enforces Bearer token auth and dispatches valid requests", async () => {
    const bridge = new LocalBridgeServer(async (req) => {
      if (req.path === "/browser/state") return { activeTabId: "tab-1" };
      throw new BridgeRejection("not allowed", 403);
    });

    const endpoint = await bridge.start();
    try {
      const unauth = await fetch(`${endpoint}/browser/state`, { method: "POST", body: "{}" });
      expect(unauth.status).toBe(401);

      const okRes = await fetch(`${endpoint}/browser/state`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridge.token}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(okRes.status).toBe(200);
      expect(await okRes.json()).toEqual({ ok: true, data: { activeTabId: "tab-1" } });

      const forbidden = await fetch(`${endpoint}/forbidden`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridge.token}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(forbidden.status).toBe(403);
    } finally {
      await bridge.stop();
    }
  });

  it("streams live text-delta and reasoning-delta chunks in order via diandian-live-stream plugin", async () => {
    const received: Array<{ streamRole: string; text: string; sessionId: string | null }> = [];
    const bridge = new LocalBridgeServer(async (req) => {
      if (req.path === "/agent/stream") {
        received.push({
          streamRole: String(req.body.streamRole),
          text: String(req.body.text),
          sessionId: typeof req.body.sessionId === "string" ? req.body.sessionId : null,
        });
        return { accepted: true };
      }
      throw new BridgeRejection("unknown", 404);
    });

    const endpoint = await bridge.start();
    const prevUrl = process.env.DIANDIAN_BRIDGE_URL;
    const prevToken = process.env.DIANDIAN_BRIDGE_TOKEN;
    process.env.DIANDIAN_BRIDGE_URL = endpoint;
    process.env.DIANDIAN_BRIDGE_TOKEN = bridge.token;

    try {
      const listeners = new Map<string, Array<(payload: unknown) => void>>();
      const fakeCtx = {
        on(eventName: string, fn: (payload: unknown) => void) {
          const list = listeners.get(eventName) ?? [];
          list.push(fn);
          listeners.set(eventName, list);
          return () => {
            listeners.set(
              eventName,
              (listeners.get(eventName) ?? []).filter((x) => x !== fn),
            );
          };
        },
      };

      const pluginUrl = pathToFileURL(path.resolve("plugins/live-stream/index.mjs")).href;
      const mod = (await import(pluginUrl)) as { apply: (ctx: unknown) => void };
      mod.apply(fakeCtx);

      const emitStream = (payload: unknown) => {
        for (const fn of listeners.get("agent/assistant-stream") ?? []) fn(payload);
      };

      const rootAgent = { session: { id: "sess-1", header: { origin: "user" } } };
      const childAgent = { session: { id: "sess-child", header: { origin: "subagent" } } };

      emitStream({ agent: rootAgent, frame: { type: "start", turn: 1, step: 1 } });
      emitStream({ agent: rootAgent, frame: { type: "chunk", chunk: { type: "reasoning-delta", text: "先思考" } } });
      emitStream({ agent: rootAgent, frame: { type: "chunk", chunk: { type: "text-delta", text: "你好" } } });
      emitStream({ agent: rootAgent, frame: { type: "chunk", chunk: { type: "text-delta", text: "世界" } } });
      // Subagent stream must be ignored
      emitStream({ agent: childAgent, frame: { type: "chunk", chunk: { type: "text-delta", text: "子代理勿发" } } });
      emitStream({ agent: rootAgent, frame: { type: "end" } });

      // Continuation step after tool call inserts paragraph break
      emitStream({ agent: rootAgent, frame: { type: "start", turn: 1, step: 2 } });
      emitStream({ agent: rootAgent, frame: { type: "chunk", chunk: { type: "text-delta", text: "第二段" } } });
      emitStream({ agent: rootAgent, frame: { type: "end" } });

      await new Promise((r) => setTimeout(r, 80));

      const assistantJoined = received
        .filter((r) => r.streamRole === "assistant")
        .map((r) => r.text)
        .join("");
      const reasoningJoined = received
        .filter((r) => r.streamRole === "reasoning")
        .map((r) => r.text)
        .join("");

      expect(reasoningJoined).toBe("先思考");
      expect(assistantJoined).toBe("你好世界\n\n第二段");
      expect(assistantJoined).not.toContain("子代理勿发");

      for (const fn of listeners.get("dispose") ?? []) fn(undefined);
    } finally {
      if (prevUrl === undefined) delete process.env.DIANDIAN_BRIDGE_URL;
      else process.env.DIANDIAN_BRIDGE_URL = prevUrl;
      if (prevToken === undefined) delete process.env.DIANDIAN_BRIDGE_TOKEN;
      else process.env.DIANDIAN_BRIDGE_TOKEN = prevToken;
      await bridge.stop();
    }
  });
});
