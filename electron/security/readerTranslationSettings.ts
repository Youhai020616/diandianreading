import type { SafeStorage } from "electron";
import type { ReaderTranslationProvider, ReaderTranslationSettings, ReaderTranslationSettingsInput } from "../../src/types/desktop";
import type { KnowledgeDatabase } from "../storage/database";

const settingName = "reader.translation-settings.v1";
type Vault = Pick<SafeStorage, "encryptString" | "decryptString" | "isEncryptionAvailable" | "getSelectedStorageBackend">;
interface StoredTranslationSettings {
  provider: ReaderTranslationProvider;
  encryptedKey: string;
}

export class ReaderTranslationSettingsStore {
  constructor(private readonly db: Pick<KnowledgeDatabase, "getSetting" | "setSetting">, private readonly vault: Vault) {}

  private stored(): StoredTranslationSettings {
    const value = this.db.getSetting(settingName);
    if (!value) return { provider: "deepl", encryptedKey: "" };
    const parsed = JSON.parse(value) as StoredTranslationSettings;
    if (!parsed || !["deepl", "model"].includes(parsed.provider) || typeof parsed.encryptedKey !== "string") {
      throw new Error("无法读取本机的翻译设置。");
    }
    return parsed;
  }

  readPublic(): ReaderTranslationSettings {
    const { provider, encryptedKey } = this.stored();
    return { provider, hasDeepLKey: Boolean(encryptedKey) };
  }

  private requireVault(): void {
    if (!this.vault.isEncryptionAvailable() || (process.platform === "linux" && this.vault.getSelectedStorageBackend() === "basic_text")) {
      throw new Error("系统钥匙串不可用，请解锁后重试。");
    }
  }

  readDeepLKey(): string {
    const { encryptedKey } = this.stored();
    if (!encryptedKey) return "";
    this.requireVault();
    try {
      return this.vault.decryptString(Buffer.from(encryptedKey, "base64"));
    } catch {
      throw new Error("无法解密 DeepL 密钥，请在双语设置中重新填写。");
    }
  }

  save(input: ReaderTranslationSettingsInput): ReaderTranslationSettings {
    if (!input || !["deepl", "model"].includes(input.provider) ||
      (input.apiKey !== undefined && typeof input.apiKey !== "string") ||
      (input.clearApiKey !== undefined && typeof input.clearApiKey !== "boolean")) {
      throw new Error("翻译设置无效。");
    }
    const next = { ...this.stored(), provider: input.provider };
    const key = input.apiKey?.trim();
    if (input.clearApiKey) {
      next.encryptedKey = "";
    } else if (key) {
      if (key.length > 2048 || /[^\x21-\x7e]/.test(key)) throw new Error("请粘贴完整的 DeepL API 密钥。");
      this.requireVault();
      try {
        next.encryptedKey = this.vault.encryptString(key).toString("base64");
      } catch {
        throw new Error("暂时无法安全保存 DeepL 密钥，请解锁系统钥匙串后重试。");
      }
    }
    this.db.setSetting(settingName, JSON.stringify(next));
    return { provider: next.provider, hasDeepLKey: Boolean(next.encryptedKey) };
  }
}
