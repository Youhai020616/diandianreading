import fs from "node:fs";
import path from "node:path";

export interface ObsidianVaultCandidate {
  name: string;
  path: string;
  lastOpened: number;
}

export function resolveObsidianVaultRoot(vaultPath: string): string {
  if (!path.isAbsolute(vaultPath)) {
    throw new Error("请选择笔记库所在的文件夹。");
  }
  const normalized = path.resolve(vaultPath);
  const stat = fs.lstatSync(normalized, { throwIfNoEntry: false });
  if (!stat) throw new Error("笔记库文件夹已移动或删除，请重新选择。");
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("请选择笔记库文件夹本身，不能使用符号链接。");
  }
  return fs.realpathSync.native(normalized);
}

export function availableObsidianVault(vaultPath: string): string {
  if (!vaultPath) return "";
  try {
    return resolveObsidianVaultRoot(vaultPath);
  } catch {
    return "";
  }
}

export async function listObsidianVaults(appDataDir: string): Promise<ObsidianVaultCandidate[]> {
  // Both apps use Electron's platform-specific appData directory.
  const registryPath = path.join(appDataDir, "obsidian", "obsidian.json");
  let registry: { vaults?: Record<string, unknown> } | null;
  try {
    registry = JSON.parse(await fs.promises.readFile(registryPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("暂时无法读取 Obsidian 的笔记库列表。", { cause: error });
  }
  if (!registry?.vaults || typeof registry.vaults !== "object" || Array.isArray(registry.vaults)) return [];

  const byPath = new Map<string, ObsidianVaultCandidate>();
  for (const entry of Object.values(registry.vaults)) {
    if (!entry || typeof entry !== "object" || !("path" in entry) || typeof entry.path !== "string") continue;
    const vaultPath = availableObsidianVault(entry.path);
    if (!vaultPath) continue;
    const timestamp = "ts" in entry ? entry.ts : undefined;
    const lastOpened = typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : 0;
    const previous = byPath.get(vaultPath);
    if (!previous || previous.lastOpened < lastOpened) {
      byPath.set(vaultPath, { name: path.basename(vaultPath) || vaultPath, path: vaultPath, lastOpened });
    }
  }
  return [...byPath.values()].sort((a, b) => b.lastOpened - a.lastOpened || a.path.localeCompare(b.path));
}
