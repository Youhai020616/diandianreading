import { expect, it, vi } from "vitest";
import { ReaderTranslationSettingsStore } from "../electron/security/readerTranslationSettings";

function createFixture() {
  const db = new Map<string, string>();
  const storage = {
    getSetting: (key: string) => db.get(key) ?? null,
    setSetting: (key: string, value: string) => { db.set(key, value); },
  };
  const vault = {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: () => "gnome_libsecret" as const,
    encryptString: vi.fn((key: string) => Buffer.from([...key].reverse().join(""))),
    decryptString: vi.fn((key: Buffer) => [...key.toString()].reverse().join("")),
  };
  return { db, vault, open: () => new ReaderTranslationSettingsStore(storage, vault) };
}

it("starts on DeepL and only exposes key presence while switching services or re-opening settings", () => {
  const { db, vault, open } = createFixture();
  const settings = open();
  expect(settings.readPublic()).toEqual({ provider: "deepl", hasDeepLKey: false });
  expect(settings.readDeepLKey()).toBe("");
  const saved = settings.save({ provider: "deepl", apiKey: " example-key:fx  " });
  expect(saved).toEqual({ provider: "deepl", hasDeepLKey: true });
  expect([...db.values()].join("")).not.toContain("example-key");
  expect(vault.encryptString).toHaveBeenCalledWith("example-key:fx");
  expect(open().save({ provider: "model" })).toEqual({ provider: "model", hasDeepLKey: true });
  expect(open().readPublic()).toEqual({ provider: "model", hasDeepLKey: true });
  expect(vault.decryptString).not.toHaveBeenCalled();
  expect(open().readDeepLKey()).toBe("example-key:fx");
  expect(open().save({ provider: "deepl", clearApiKey: true })).toEqual({ provider: "deepl", hasDeepLKey: false });
  expect(open().readDeepLKey()).toBe("");
});

it("retains previous credentials and provider if replacement fails", () => {
  const { vault, open } = createFixture();
  const settings = open();
  settings.save({ provider: "model", apiKey: "old" });
  vault.isEncryptionAvailable.mockReturnValue(false);
  expect(() => settings.save({ provider: "deepl", apiKey: "replacement" })).toThrow("系统钥匙串");
  expect(settings.readPublic()).toEqual({ provider: "model", hasDeepLKey: true });
  expect(() => settings.readDeepLKey()).toThrow("系统钥匙串");
  vault.isEncryptionAvailable.mockReturnValue(true);
  expect(settings.readDeepLKey()).toBe("old");
  expect(() => settings.save({ provider: "model", apiKey: "malformed\nheader" })).toThrow("粘贴完整");
  expect(settings.readDeepLKey()).toBe("old");
});
