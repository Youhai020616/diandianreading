import fs from "node:fs";
import path from "node:path";

export interface ModelSettings {
  provider: "deepseek" | "openai-compatible";
  model: string;
  baseUrl: string;
  apiKey: string;
}

export interface PublicModelSettings {
  provider: "deepseek" | "openai-compatible";
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeySource: "saved" | "env" | "none";
}

interface StoredSecretEnvelope {
  version: 1;
  provider: "deepseek" | "openai-compatible";
  model: string;
  baseUrl: string;
  apiKeyEncoding: "safeStorage" | "plain" | "none";
  apiKeyPayload: string;
  updatedAt: string;
}

interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export const DEFAULT_MODEL_SETTINGS: Readonly<ModelSettings> = {
  provider: "deepseek",
  model: "deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "",
};

function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_MODEL_SETTINGS.baseUrl;
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Base URL 仅支持 http:// 或 https://");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Base URL 不得包含内嵌账号密码");
  }
  return parsed.toString().replace(/\/+$/, "");
}

export class ModelSettingsStore {
  private readonly filePath: string;
  private readonly safeStorage?: SafeStorageLike;

  constructor(userDataDir: string, safeStorage?: SafeStorageLike) {
    this.filePath = path.join(userDataDir, "config", "model-settings.json");
    this.safeStorage = safeStorage;
  }

  readRaw(): ModelSettings {
    const envKey = (process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || "").trim();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<StoredSecretEnvelope>;
      let apiKey = "";
      if (parsed.apiKeyEncoding === "safeStorage" && parsed.apiKeyPayload && this.safeStorage?.isEncryptionAvailable()) {
        apiKey = this.safeStorage.decryptString(Buffer.from(parsed.apiKeyPayload, "base64"));
      } else if (parsed.apiKeyEncoding === "plain" && parsed.apiKeyPayload) {
        apiKey = parsed.apiKeyPayload;
      }
      return {
        provider: parsed.provider === "openai-compatible" ? "openai-compatible" : "deepseek",
        model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : DEFAULT_MODEL_SETTINGS.model,
        baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() ? parsed.baseUrl.trim() : DEFAULT_MODEL_SETTINGS.baseUrl,
        apiKey: apiKey || envKey,
      };
    } catch {
      return {
        ...DEFAULT_MODEL_SETTINGS,
        apiKey: envKey,
      };
    }
  }

  readPublic(): PublicModelSettings {
    const envKey = (process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || "").trim();
    let savedHasKey = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<StoredSecretEnvelope>;
      savedHasKey = parsed.apiKeyEncoding !== "none" && Boolean(parsed.apiKeyPayload);
    } catch {
      savedHasKey = false;
    }
    const raw = this.readRaw();
    return {
      provider: raw.provider,
      model: raw.model,
      baseUrl: raw.baseUrl,
      hasApiKey: Boolean(raw.apiKey),
      apiKeySource: savedHasKey ? "saved" : envKey ? "env" : "none",
    };
  }

  save(input: {
    provider: "deepseek" | "openai-compatible";
    model: string;
    baseUrl: string;
    apiKey?: string;
    clearApiKey?: boolean;
  }): PublicModelSettings {
    const existing = this.readRaw();
    const model = input.model.trim();
    if (!model) throw new Error("模型名称不能为空");
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const nextKey = input.clearApiKey
      ? ""
      : input.apiKey !== undefined && input.apiKey.trim() !== ""
        ? input.apiKey.trim()
        : existing.apiKey;

    let apiKeyEncoding: StoredSecretEnvelope["apiKeyEncoding"] = "none";
    let apiKeyPayload = "";
    if (nextKey) {
      if (this.safeStorage?.isEncryptionAvailable()) {
        apiKeyEncoding = "safeStorage";
        apiKeyPayload = this.safeStorage.encryptString(nextKey).toString("base64");
      } else {
        apiKeyEncoding = "plain";
        apiKeyPayload = nextKey;
      }
    }

    const envelope: StoredSecretEnvelope = {
      version: 1,
      provider: input.provider === "openai-compatible" ? "openai-compatible" : "deepseek",
      model,
      baseUrl,
      apiKeyEncoding,
      apiKeyPayload,
      updatedAt: new Date().toISOString(),
    };
    writeFileAtomic(this.filePath, JSON.stringify(envelope, null, 2));
    return this.readPublic();
  }
}
