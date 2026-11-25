import { normalizeBaseUrl, type ModelSettings } from "./secretStore";

export interface AvailableModelOption {
  id: string;
  label: string;
  tag?: string;
  desc?: string;
  source: "api" | "preset" | "current";
}

export interface AvailableModelsResult {
  models: AvailableModelOption[];
  source: "api" | "preset";
  providerLabel: string;
  error?: string;
}

interface PresetModelMeta {
  id: string;
  tag?: string;
  desc: string;
}

interface ProviderCatalogEntry {
  id: "deepseek" | "kimi" | "qwen" | "glm" | "openai" | "custom";
  label: string;
  matchHost: (urlLower: string, provider: ModelSettings["provider"]) => boolean;
  models: PresetModelMeta[];
}

const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    matchHost: (url, provider) => url.includes("api.deepseek.com") || (provider === "deepseek" && !url),
    models: [
      { id: "deepseek-chat", tag: "推荐", desc: "日常共读 · V3，响应迅速、表达自然" },
      { id: "deepseek-reasoner", tag: "推理", desc: "深度思考 · R1，适合跨书思辨与长文拆解" },
    ],
  },
  {
    id: "kimi",
    label: "Kimi（月之暗面）",
    matchHost: (url) => url.includes("api.moonshot.cn"),
    models: [
      { id: "kimi-k2-0711-preview", tag: "推荐", desc: "新一代旗舰，逻辑与中文表达均衡" },
      { id: "moonshot-v1-128k", desc: "超长上下文，适合多书与长章节整理" },
      { id: "moonshot-v1-32k", desc: "速度与长文本均衡" },
      { id: "moonshot-v1-8k", desc: "轻量日常问答" },
    ],
  },
  {
    id: "qwen",
    label: "通义千问（阿里云百炼）",
    matchHost: (url) => url.includes("dashscope.aliyuncs.com"),
    models: [
      { id: "qwen-plus", tag: "推荐", desc: "速度与写作质量均衡" },
      { id: "qwen-max", desc: "更强深度分析与长文写作" },
      { id: "qwen-turbo", desc: "轻量极速，适合高频问答" },
      { id: "qwq-plus", tag: "推理", desc: "深度思考推理模型" },
    ],
  },
  {
    id: "glm",
    label: "智谱清言（GLM）",
    matchHost: (url) => url.includes("open.bigmodel.cn"),
    models: [
      { id: "glm-4-plus", tag: "推荐", desc: "综合理解与写作能力强" },
      { id: "glm-4-air", desc: "响应与效果均衡" },
      { id: "glm-4-flash", desc: "轻量极速，适合随手提问" },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    matchHost: (url) => url.includes("api.openai.com"),
    models: [
      { id: "gpt-4.1-mini", tag: "推荐", desc: "响应快、日常性价比高" },
      { id: "gpt-4.1", desc: "旗舰深度理解与写作" },
      { id: "gpt-4o", desc: "通用旗舰模型" },
      { id: "o4-mini", tag: "推理", desc: "轻量推理模型" },
    ],
  },
];

const NON_CHAT_MODEL_RE =
  /(^|[-_/])(embedding|text-embedding|whisper|tts|dall-e|moderation|omni-moderation|sora|gpt-image|babbage|davinci|rerank|cogview|cogvideo|wanx|paraformer|cosyvoice|sambert|realtime|transcribe|audio-preview)/i;

export function isChatCompatibleModelId(modelId: string): boolean {
  const clean = modelId.trim();
  if (!clean) return false;
  return !NON_CHAT_MODEL_RE.test(clean);
}

export function detectProviderCatalog(settings: Pick<ModelSettings, "provider" | "baseUrl">): {
  id: ProviderCatalogEntry["id"];
  label: string;
  presets: PresetModelMeta[];
} {
  const urlLower = (settings.baseUrl || "").trim().toLowerCase().replace(/\/+$/, "");
  for (const entry of PROVIDER_CATALOG) {
    if (entry.matchHost(urlLower, settings.provider)) {
      return { id: entry.id, label: entry.label, presets: entry.models };
    }
  }
  const hostLabel = (() => {
    try {
      return new URL(settings.baseUrl).host || "自定义接口";
    } catch {
      return "自定义接口";
    }
  })();
  return { id: "custom", label: hostLabel, presets: [] };
}

export function parseOpenAiModelsPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const rec = payload as {
    data?: unknown;
    models?: unknown;
  };
  const rawList = Array.isArray(rec.data)
    ? rec.data
    : Array.isArray(rec.models)
      ? rec.models
      : [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of rawList) {
    let id = "";
    if (typeof item === "string") {
      id = item.trim();
    } else if (item && typeof item === "object") {
      const obj = item as { id?: unknown; name?: unknown; model?: unknown };
      const candidate = obj.id ?? obj.model ?? obj.name;
      if (typeof candidate === "string") id = candidate.trim();
    }
    if (!id || seen.has(id) || !isChatCompatibleModelId(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function buildFallbackPresets(
  presets: PresetModelMeta[],
  currentModel: string,
): AvailableModelOption[] {
  const list: AvailableModelOption[] = presets.map((p) => ({
    id: p.id,
    label: p.id,
    ...(p.tag ? { tag: p.tag } : {}),
    desc: p.desc,
    source: "preset",
  }));
  const trimmedCurrent = currentModel.trim();
  if (trimmedCurrent && !list.some((m) => m.id === trimmedCurrent)) {
    list.unshift({
      id: trimmedCurrent,
      label: trimmedCurrent,
      desc: "当前已配置模型",
      source: "current",
    });
  }
  return list;
}

export async function fetchAvailableModels(
  settings: ModelSettings,
  fetchImpl: typeof fetch = fetch,
): Promise<AvailableModelsResult> {
  const catalog = detectProviderCatalog(settings);
  const presetMap = new Map(catalog.presets.map((p, idx) => [p.id, { ...p, order: idx }]));
  const fallback = buildFallbackPresets(catalog.presets, settings.model);

  let cleanBaseUrl: string;
  try {
    cleanBaseUrl = normalizeBaseUrl(settings.baseUrl);
  } catch (err) {
    return {
      models: fallback,
      source: "preset",
      providerLabel: catalog.label,
      error: err instanceof Error ? err.message : "接口地址格式不正确",
    };
  }

  const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(cleanBaseUrl);
  const apiKey = settings.apiKey.trim();
  if (!apiKey && !isLocalhost) {
    return {
      models: fallback,
      source: "preset",
      providerLabel: catalog.label,
    };
  }

  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const res = await fetchImpl(`${cleanBaseUrl}/models`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(6_000),
    });

    if (!res.ok) {
      const reason =
        res.status === 401 || res.status === 403
          ? "API 密钥无权拉取模型列表，已显示内置预设"
          : `接口暂不支持拉取模型列表 (${res.status})，已显示内置预设`;
      return {
        models: fallback,
        source: "preset",
        providerLabel: catalog.label,
        error: reason,
      };
    }

    const body = (await res.json()) as unknown;
    const ids = parseOpenAiModelsPayload(body);
    if (ids.length === 0) {
      return {
        models: fallback,
        source: "preset",
        providerLabel: catalog.label,
      };
    }

    const currentId = settings.model.trim();
    const merged: AvailableModelOption[] = ids.map((id) => {
      const meta = presetMap.get(id);
      return {
        id,
        label: id,
        ...(meta?.tag ? { tag: meta.tag } : {}),
        ...(meta?.desc ? { desc: meta.desc } : {}),
        source: "api",
      };
    });

    // Sort curated provider presets first in preferred order, then remaining API models alphabetically.
    merged.sort((a, b) => {
      const ma = presetMap.get(a.id);
      const mb = presetMap.get(b.id);
      if (ma && mb) return ma.order - mb.order;
      if (ma) return -1;
      if (mb) return 1;
      return a.id.localeCompare(b.id);
    });

    if (currentId && !merged.some((m) => m.id === currentId)) {
      const meta = presetMap.get(currentId);
      merged.unshift({
        id: currentId,
        label: currentId,
        ...(meta?.tag ? { tag: meta.tag } : {}),
        desc: meta?.desc ?? "当前已配置模型",
        source: "current",
      });
    }

    return {
      models: merged,
      source: "api",
      providerLabel: catalog.label,
    };
  } catch {
    return {
      models: fallback,
      source: "preset",
      providerLabel: catalog.label,
      error: "拉取在线模型列表超时或失败，已显示预设模型",
    };
  }
}
