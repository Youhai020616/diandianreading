import { shell } from "electron";
import { normalizeSafetyMode, type SafetyMode } from "../security/safetyPolicy";
import { fetchAvailableModels } from "../security/modelCatalog";
import { normalizeBaseUrl } from "../security/secretStore";
import { state, ipc } from "../appState";

export function registerSettingsIpc(): void {
  // ---------- Model & Safety Settings ----------

  ipc.handle("settings:get-model", () => {
    if (!state.settingsStore) throw new Error("Settings store not initialized");
    return state.settingsStore.readPublic();
  });

  ipc.handle("settings:list-models", async () => {
    if (!state.settingsStore) throw new Error("Settings store not initialized");
    return fetchAvailableModels(state.settingsStore.readRaw());
  });

  ipc.handle(
    "settings:save-model",
    async (
      _win,
      input: {
        provider: "deepseek" | "openai-compatible";
        model: string;
        baseUrl: string;
        apiKey?: string;
        clearApiKey?: boolean;
        allowPlaintextKey?: boolean;
      },
    ) => {
      if (!state.settingsStore) throw new Error("Settings store not initialized");
      const saved = state.settingsStore.save(input);
      await state.supervisor?.reloadForSettingsChange();
      return saved;
    },
  );

  ipc.handle(
    "settings:test-model",
    async (
      _win,
      input: {
        baseUrl: string;
        model: string;
        apiKey?: string;
        useSavedKey?: boolean;
      },
    ) => {
      if (!state.settingsStore) throw new Error("Settings store not initialized");
      let cleanBaseUrl: string;
      try {
        cleanBaseUrl = normalizeBaseUrl(String(input?.baseUrl ?? ""));
      } catch (err) {
        return { ok: false as const, message: err instanceof Error ? err.message : "接口地址格式不正确" };
      }
      const cleanModel = String(input?.model ?? "").trim();
      if (!cleanModel) {
        return { ok: false as const, message: "请先选择或填写模型名称" };
      }
      const typedKey = String(input?.apiKey ?? "").trim();
      const effectiveKey = typedKey || (input?.useSavedKey ? state.settingsStore.readRaw().apiKey : "");
      const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(cleanBaseUrl);
      if (!effectiveKey && !isLocalhost) {
        return { ok: false as const, message: "请先输入 API 密钥再测试连接" };
      }

      const started = Date.now();
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (effectiveKey) headers.Authorization = `Bearer ${effectiveKey}`;
        const res = await fetch(`${cleanBaseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: cleanModel,
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 1,
          }),
          signal: AbortSignal.timeout(12_000),
        });
        const latencyMs = Date.now() - started;
        if (res.ok) {
          return { ok: true as const, latencyMs };
        }
        if (res.status === 401 || res.status === 403) {
          return { ok: false as const, message: "API 密钥无效或无权访问，请检查是否复制完整" };
        }
        if (res.status === 402) {
          return { ok: false as const, message: "账户余额不足，请前往服务商平台充值后再试" };
        }
        if (res.status === 404) {
          return { ok: false as const, message: `接口地址或模型「${cleanModel}」不可用，请检查高级设置` };
        }
        if (res.status === 429) {
          return { ok: false as const, message: "请求频率受限或额度已用完，请稍后重试" };
        }
        let detail = "";
        try {
          const body = (await res.json()) as { error?: { message?: string }; message?: string };
          detail = String(body?.error?.message || body?.message || "").slice(0, 120);
        } catch {
          // Ignore non-JSON error body
        }
        return {
          ok: false as const,
          message: detail ? `接口返回错误 (${res.status})：${detail}` : `接口返回异常状态 (${res.status})`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (/timeout|abort/i.test(msg)) {
          return { ok: false as const, message: "连接超时（12 秒无响应），请检查网络或接口地址" };
        }
        return { ok: false as const, message: "无法连接到接口地址，请检查网络、代理或 Base URL" };
      }
    },
  );

  ipc.handle("settings:open-key-portal", async (_win, presetId: string) => {
    const portals: Record<string, string> = {
      deepseek: "https://platform.deepseek.com/api_keys",
      kimi: "https://platform.moonshot.cn/console/api-keys",
      qwen: "https://bailian.console.aliyun.com/",
      glm: "https://open.bigmodel.cn/usercenter/apikeys",
      openai: "https://platform.openai.com/api-keys",
    };
    const url = portals[String(presetId ?? "")];
    if (!url) return { opened: false };
    await shell.openExternal(url);
    return { opened: true };
  });

  ipc.handle("safety:get-mode", () => {
    if (!state.safetyStore) throw new Error("Safety store not initialized");
    return { mode: state.safetyStore.read() };
  });

  ipc.handle("safety:set-mode", (_win, mode: SafetyMode) => {
    if (!state.safetyStore) throw new Error("Safety store not initialized");
    const saved = state.safetyStore.write(normalizeSafetyMode(mode));
    return { mode: saved };
  });
}
