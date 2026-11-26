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
  /** How the saved key sits on disk; "plain" means the system keychain was unavailable. */
  apiKeyStorage: "encrypted" | "plain" | "none";
  /** Whether a new key would be encrypted; otherwise saving one needs explicit consent. */
  secureStorageAvailable: boolean;
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
  getSelectedStorageBackend?(): string;
}

export const PLAINTEXT_KEY_CONSENT_REQUIRED =
  "这台电脑的系统钥匙串不可用，API Key 只能以明文保存在本机。请在设置中确认后再保存。";

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

  /** Linux "basic_text" stores with a hard-coded password, so it does not count as encryption. */
  private canEncrypt(): boolean {
    if (!this.safeStorage?.isEncryptionAvailable()) return false;
    return !(process.platform === "linux" && this.safeStorage.getSelectedStorageBackend?.() === "basic_text");
  }

  private readEnvelope(): Partial<StoredSecretEnvelope> | null {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<StoredSecretEnvelope>;
    } catch {
      return null;
    }
  }

  /** The key saved by the user, ignoring any key supplied through the environment. */
  private readSavedKey(parsed: Partial<StoredSecretEnvelope> | null): string {
    if (!parsed?.apiKeyPayload) return "";
    if (parsed.apiKeyEncoding === "safeStorage" && this.safeStorage?.isEncryptionAvailable()) {
      return this.safeStorage.decryptString(Buffer.from(parsed.apiKeyPayload, "base64"));
    }
    return parsed.apiKeyEncoding === "plain" ? parsed.apiKeyPayload : "";
  }

  readRaw(): ModelSettings {
    const envKey = (process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || "").trim();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<StoredSecretEnvelope>;
      const apiKey = this.readSavedKey(parsed);
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
    const parsed = this.readEnvelope();
    const savedHasKey = Boolean(parsed && parsed.apiKeyEncoding !== "none" && parsed.apiKeyPayload);
    const raw = this.readRaw();
    return {
      provider: raw.provider,
      model: raw.model,
      baseUrl: raw.baseUrl,
      hasApiKey: Boolean(raw.apiKey),
      apiKeySource: savedHasKey ? "saved" : envKey ? "env" : "none",
      apiKeyStorage: !savedHasKey ? "none" : parsed?.apiKeyEncoding === "safeStorage" ? "encrypted" : "plain",
      secureStorageAvailable: this.canEncrypt(),
    };
  }

  save(input: {
    provider: "deepseek" | "openai-compatible";
    model: string;
    baseUrl: string;
    apiKey?: string;
    clearApiKey?: boolean;
    /** Required to store a newly entered key when the keychain is unavailable. */
    allowPlaintextKey?: boolean;
  }): PublicModelSettings {
    const model = input.model.trim();
    if (!model) throw new Error("模型名称不能为空");
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const enteredKey = input.apiKey?.trim() ?? "";
    // Keep only a key the user saved before; a key from the environment is never written to disk.
    const nextKey = input.clearApiKey ? "" : enteredKey || this.readSavedKey(this.readEnvelope());

    let apiKeyEncoding: StoredSecretEnvelope["apiKeyEncoding"] = "none";
    let apiKeyPayload = "";
    if (nextKey) {
      if (this.canEncrypt()) {
        apiKeyEncoding = "safeStorage";
        apiKeyPayload = this.safeStorage!.encryptString(nextKey).toString("base64");
      } else {
        if (enteredKey && input.allowPlaintextKey !== true) throw new Error(PLAINTEXT_KEY_CONSENT_REQUIRED);
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
