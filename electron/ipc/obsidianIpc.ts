import { app, dialog, shell } from "electron";
import { exportBookToObsidian, exportDraftToObsidian } from "../export/obsidianExporter";
import { listObsidianVaults } from "../export/obsidianVaults";
import { ipc, requireDb, getObsidianVault, setObsidianVault, requireObsidianVault } from "../appState";

export function registerObsidianIpc(): void {
  // ---------- Obsidian Vault Export & Deep Link ----------

  ipc.handle("obsidian:get-vault", () => ({ vaultPath: getObsidianVault() }));
  ipc.handle("obsidian:list-vaults", () => listObsidianVaults(app.getPath("appData")));

  ipc.handle("obsidian:set-vault", (_win, vaultPath: string) => {
    return { vaultPath: setObsidianVault(vaultPath) };
  });

  ipc.handle("obsidian:pick-vault", async (win) => {
    const res = await dialog.showOpenDialog(win, {
      title: "选择 Obsidian 笔记库文件夹",
      defaultPath: getObsidianVault() || app.getPath("documents"),
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || !res.filePaths[0]) {
      return { canceled: true as const, vaultPath: getObsidianVault() };
    }
    return { canceled: false as const, vaultPath: setObsidianVault(res.filePaths[0]) };
  });

  ipc.handle("obsidian:export-book", (_win, bookId: string) =>
    exportBookToObsidian(requireDb(), requireObsidianVault(), bookId),
  );

  ipc.handle("obsidian:export-draft", (_win, draftId: string) =>
    exportDraftToObsidian(requireDb(), requireObsidianVault(), draftId),
  );

  ipc.handle("obsidian:open-deep-link", async (_win, deepLink: string) => {
    const trimmed = String(deepLink ?? "").trim();
    if (!trimmed.startsWith("obsidian://open?")) {
      throw new Error("仅允许打开安全的 obsidian://open 深链接");
    }
    await shell.openExternal(trimmed);
    return { opened: true };
  });
}
