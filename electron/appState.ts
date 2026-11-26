/**
 * Process-wide services and helpers shared by main.ts and the per-domain IPC modules in ./ipc.
 * Services are created in bootstrap(); handlers read them at call time.
 */
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow } from "electron";
import { LocalBridgeServer } from "./agent/bridgeServer";
import { AgentSupervisor } from "./agent/supervisor";
import { type AppMenuAction } from "./appMenu";
import { BrowserMenuWindowController } from "./browser/browserMenuWindow";
import { BrowserService } from "./browser/browserService";
import { type ParsedCookieBundle } from "./browser/cookieCodec";
import { CardBakerService } from "./cards/cardBaker";
import { availableObsidianVault, resolveObsidianVaultRoot } from "./export/obsidianVaults";
import { PetWindowController } from "./pet/petWindow";
import { KindleSettingsStore } from "./router/kindleSmtpService";
import { type BookMetadataCandidate } from "./router/metadataService";
import { DownloadedBookCovers } from "./router/downloadedBookCovers";
import { ReaderTranslationService } from "./router/readerTranslation";
import { ZlibCliService } from "./router/zlibCliService";
import { SafetyModeStore } from "./security/safetyPolicy";
import { ModelSettingsStore } from "./security/secretStore";
import { ReaderTranslationSettingsStore } from "./security/readerTranslationSettings";
import { TrustedIpcRegistry } from "./security/trustedIpc";
import { BookCoverCache } from "./storage/bookCoverCache";
import { KnowledgeDatabase } from "./storage/database";
import { TwinStore } from "./twin/twinStore";

export interface MainProcessState {
  mainWindow: BrowserWindow | null;
  browserService: BrowserService | null;
  browserMenuController: BrowserMenuWindowController | null;
  currentAppTheme: "light" | "dark";
  mainWindowActiveForPet: boolean;
  blurCheckTimer: NodeJS.Timeout | null;
  bridgeServer: LocalBridgeServer | null;
  supervisor: AgentSupervisor | null;
  settingsStore: ModelSettingsStore | null;
  kindleStore: KindleSettingsStore | null;
  safetyStore: SafetyModeStore | null;
  knowledgeDb: KnowledgeDatabase | null;
  readerTranslations: ReaderTranslationService;
  readerTranslationSettings: ReaderTranslationSettingsStore;
  bookCovers: BookCoverCache;
  downloadedCovers: DownloadedBookCovers;
  twinStore: TwinStore | null;
  cardBaker: CardBakerService | null;
  zlibService: ZlibCliService | null;
  petController: PetWindowController | null;
  pendingMenuAction: AppMenuAction | null;
}

export const state: MainProcessState = {
  mainWindow: null,
  browserService: null,
  browserMenuController: null,
  currentAppTheme: "light",
  mainWindowActiveForPet: true,
  blurCheckTimer: null,
  bridgeServer: null,
  supervisor: null,
  settingsStore: null,
  kindleStore: null,
  safetyStore: null,
  knowledgeDb: null,
  readerTranslations: undefined as unknown as ReaderTranslationService,
  readerTranslationSettings: undefined as unknown as ReaderTranslationSettingsStore,
  bookCovers: undefined as unknown as BookCoverCache,
  downloadedCovers: undefined as unknown as DownloadedBookCovers,
  twinStore: null,
  cardBaker: null,
  zlibService: null,
  petController: null,
  pendingMenuAction: null,
};

/** Late-bound entry points owned by main.ts, so IPC modules do not import main.ts. */
export const hooks = {
  createMainWindow: async (): Promise<void> => {
    throw new Error("Main window factory is not ready");
  },
};


export function syncPetMainContext(): void {
  if (!state.petController) return;
  const win = state.mainWindow;
  if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) {
    state.mainWindowActiveForPet = false;
    state.petController.setMainWindowContext({ active: false, bounds: null });
    return;
  }
  state.petController.setMainWindowContext({
    active: state.mainWindowActiveForPet,
    bounds: win.getBounds(),
  });
}

export function scheduleAppFocusCheck(): void {
  if (state.blurCheckTimer) clearTimeout(state.blurCheckTimer);
  state.blurCheckTimer = setTimeout(() => {
    state.blurCheckTimer = null;
    const focused = BrowserWindow.getFocusedWindow();
    if (!focused) {
      state.mainWindowActiveForPet = false;
      syncPetMainContext();
    }
  }, 90);
}

export const ipc = new TrustedIpcRegistry();
export const metadataLookups = new WeakMap<BrowserWindow, { id: string; bookId: string; candidates: BookMetadataCandidate[] }>();
export const pendingCookieImports = new Map<string, ParsedCookieBundle>();

export function stashPendingCookieImport(bundle: ParsedCookieBundle): string {
  if (pendingCookieImports.size >= 5) {
    const oldest = pendingCookieImports.keys().next().value;
    if (oldest) pendingCookieImports.delete(oldest);
  }
  const token = crypto.randomUUID();
  pendingCookieImports.set(token, bundle);
  return token;
}

export function resolveAppEntryUrl(): string {
  const devUrl = !app.isPackaged ? process.env.DIANDIAN_DEV_SERVER_URL : undefined;
  if (devUrl) return devUrl;
  return pathToFileURL(path.join(__dirname, "../dist/index.html")).href;
}

/**
 * Root that holds `plugins/`, `dist-electron/agent/` and `node_modules/` as real files. The Harness runs
 * in a separate Node process that cannot read app.asar, so an installed app unpacks these
 * (electron-builder `asarUnpack`) and the agent uses `app.asar.unpacked`.
 */
export function resolveProjectRoot(): string {
  return app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked") : path.resolve(__dirname, "..");
}

export function sendToMain(channel: string, payload: unknown): void {
  if (state.mainWindow && !state.mainWindow.isDestroyed() && !state.mainWindow.webContents.isDestroyed()) {
    state.mainWindow.webContents.send(channel, payload);
  }
}

export function sendToAll(channel: string, payload: unknown): void {
  sendToMain(channel, payload);
  const petWin = state.petController?.getWindow();
  if (petWin && !petWin.isDestroyed() && !petWin.webContents.isDestroyed()) {
    petWin.webContents.send(channel, payload);
  }
}

export function cleanPageBookTitle(rawTitle: string): string {
  return (
    rawTitle
      .replace(/\s*[-–—|]\s*(微信读书|WeRead|豆瓣读书|豆瓣|小红书).*$/i, "")
      .replace(/^《|》$/g, "")
      .trim() || "网页摘录"
  );
}

export function requireDb(): KnowledgeDatabase {
  if (!state.knowledgeDb) throw new Error("本地知识库尚未初始化");
  return state.knowledgeDb;
}

export function getObsidianVault(): string {
  return availableObsidianVault(requireDb().getSetting("obsidian.vaultPath") ?? "");
}

export function setObsidianVault(selected: string): string {
  const vaultPath = selected ? resolveObsidianVaultRoot(selected) : "";
  requireDb().setSetting("obsidian.vaultPath", vaultPath);
  return vaultPath;
}

export function requireObsidianVault(): string {
  const vault = getObsidianVault();
  if (!vault) {
    // The renderer offers a "去设置" shortcut when it sees this message; keep the two in sync.
    throw new Error("请先在「连接与偏好 → Obsidian 联动」中连接一个可用的 Obsidian 笔记库。");
  }
  return vault;
}
