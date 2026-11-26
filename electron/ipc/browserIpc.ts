import fs from "node:fs";
import path from "node:path";
import { clipboard, dialog, shell } from "electron";
import { type BrowserBounds } from "../browser/browserService";
import { filterCookiesByDomains, parseCookieInput } from "../browser/cookieCodec";
import {
  extractLocalBrowserCookies,
  inspectLocalBrowserProfile,
  listLocalBrowserProfiles,
  type ReadingSiteGroupId,
} from "../browser/localBrowserImporter";
import { state, ipc, pendingCookieImports, stashPendingCookieImport } from "../appState";

export function registerBrowserIpc(): void {
  // ---------- Native Embedded Browser ----------

  ipc.handle("browser:get-state", () => state.browserService?.getState());

  ipc.handle("browser:open-url", async (_win, input: { url?: string; newTab?: boolean }) => {
    if (!state.browserService) throw new Error("Browser service unavailable");
    return state.browserService.openUrl(input?.url, { newTab: input?.newTab === true });
  });

  ipc.handle(
    "browser:navigate",
    async (_win, action: "back" | "forward" | "reload" | "stop" | "home" | "weread") => {
      if (!state.browserService) throw new Error("Browser service unavailable");
      return state.browserService.navigate(action);
    },
  );

  ipc.handle("browser:select-tab", (_win, tabId: string) => {
    if (!state.browserService) throw new Error("Browser service unavailable");
    return state.browserService.selectTab(tabId);
  });

  ipc.handle("browser:close-tab", (_win, tabId: string) => {
    if (!state.browserService) throw new Error("Browser service unavailable");
    return state.browserService.closeTab(tabId);
  });

  ipc.handle("browser:add-account", (_win, label: string) => {
    if (!state.browserService) throw new Error("Browser service unavailable");
    return state.browserService.addAccount(label);
  });

  ipc.handle("browser:switch-account", (_win, accountId: string) => {
    if (!state.browserService) throw new Error("Browser service unavailable");
    return state.browserService.switchAccount(accountId);
  });

  ipc.handle("browser:read-page", async (_win, input?: { maxChars?: number }) => {
    if (!state.browserService) throw new Error("Browser service unavailable");
    return state.browserService.readPageContent({ maxChars: input?.maxChars });
  });

  ipc.on("browser:set-bounds", (_win, rect: BrowserBounds) => {
    state.browserService?.setBounds(rect);
  });

  ipc.handle("browser:set-visible", (_win, visible: boolean) => {
    if (!state.browserService) throw new Error("Browser service unavailable");
    return state.browserService.setVisible(Boolean(visible));
  });

  ipc.on("browser:set-suppressed", (_win, suppressed: boolean) => {
    state.browserService?.setSuppressed(Boolean(suppressed));
  });

  ipc.handle("browser:show-more-menu", async (_win, pos: { x?: number; y?: number }) => {
    if (!state.browserService || !state.browserMenuController) throw new Error("Browser menu unavailable");
    const snapshot = state.browserService.getState();
    const activeTab = snapshot.tabs.find((t) => t.id === snapshot.activeTabId) ?? null;
    const x = typeof pos?.x === "number" && Number.isFinite(pos.x) ? pos.x : 1120;
    const y = typeof pos?.y === "number" && Number.isFinite(pos.y) ? pos.y : 40;
    await state.browserMenuController.openAt(x, y, {
      url: activeTab?.url ?? "",
      zoomPercent: state.browserService.getZoomPercent(),
      theme: state.currentAppTheme,
    });
    return { opened: true };
  });

  ipc.handle("browser-menu:zoom", (_win, action: "in" | "out" | "reset") => {
    if (!state.browserService) throw new Error("Browser service unavailable");
    const zoomPercent = state.browserService.adjustZoom(action);
    return { zoomPercent };
  });

  ipc.handle(
    "browser-menu:action",
    async (
      _win,
      action: "copy-url" | "open-external" | "import-cookie" | "open-downloads" | "open-settings",
    ) => {
      state.browserMenuController?.hide();
      const activeUrl = state.browserService?.getActiveTabUrl() ?? "";
      if (action === "copy-url") {
        if (/^https?:\/\//i.test(activeUrl)) {
          clipboard.writeText(activeUrl);
          state.browserMenuController?.dispatchToMain({ kind: "notified", message: "已复制当前页面网址" });
        }
        return { ok: true };
      }
      if (action === "open-external") {
        if (/^https?:\/\//i.test(activeUrl)) {
          await shell.openExternal(activeUrl);
        }
        return { ok: true };
      }
      if (action === "open-downloads") {
        if (state.zlibService) {
          const dir = path.resolve(state.zlibService.getDownloadDir());
          fs.mkdirSync(dir, { recursive: true });
          await shell.openPath(dir);
        }
        return { ok: true };
      }
      if (action === "import-cookie") {
        state.browserMenuController?.dispatchToMain({ kind: "import-cookie" });
        return { ok: true };
      }
      if (action === "open-settings") {
        state.browserMenuController?.dispatchToMain({ kind: "open-settings" });
        return { ok: true };
      }
      return { ok: false };
    },
  );

  ipc.handle("browser-menu:close", () => {
    state.browserMenuController?.hide();
    return { closed: true };
  });

  ipc.handle("browser:pick-cookie-file", async (win) => {
    const res = await dialog.showOpenDialog(win, {
      title: "选择外部浏览器导出的单站点 Cookie 文件（Netscape .txt 或 JSON）",
      properties: ["openFile"],
      filters: [
        { name: "Cookie 文件 (TXT / JSON)", extensions: ["txt", "json"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    if (res.canceled || !res.filePaths[0]) {
      return { canceled: true as const };
    }
    const raw = fs.readFileSync(res.filePaths[0], "utf8");
    const bundle = parseCookieInput(raw);
    const importToken = stashPendingCookieImport(bundle);
    return {
      canceled: false as const,
      fileName: path.basename(res.filePaths[0]),
      importToken,
      format: bundle.format,
      totalCount: bundle.cookies.length,
      domains: bundle.domains,
    };
  });

  ipc.handle("browser:parse-cookie-text", (_win, rawText: string) => {
    const bundle = parseCookieInput(String(rawText ?? ""));
    const importToken = stashPendingCookieImport(bundle);
    return {
      importToken,
      format: bundle.format,
      totalCount: bundle.cookies.length,
      domains: bundle.domains,
    };
  });

  ipc.handle(
    "browser:apply-cookie-import",
    async (_win, input: { importToken: string; selectedDomains: string[] }) => {
      if (!state.browserService) throw new Error("Browser service unavailable");
      const bundle = pendingCookieImports.get(input.importToken);
      if (!bundle) throw new Error("导入会话已过期，请重新选择或粘贴 Cookie");
      const selected = filterCookiesByDomains(bundle.cookies, input.selectedDomains ?? []);
      if (selected.length === 0) {
        throw new Error("请至少勾选一个要导入的站点域名");
      }
      pendingCookieImports.delete(input.importToken);
      return state.browserService.importCookiesIntoActiveAccount(selected);
    },
  );

  ipc.handle("browser:discard-cookie-import", (_win, importToken: string) => {
    pendingCookieImports.delete(importToken);
    return { discarded: true };
  });

  ipc.handle("browser:list-local-browsers", () => {
    return listLocalBrowserProfiles();
  });

  ipc.handle("browser:inspect-local-browser", (_win, profileId: string) => {
    return inspectLocalBrowserProfile(String(profileId ?? ""));
  });

  ipc.handle(
    "browser:import-local-browser",
    async (_win, input: { profileId: string; groups: ReadingSiteGroupId[] }) => {
      if (!state.browserService) throw new Error("Browser service unavailable");
      const allowed = new Set<ReadingSiteGroupId>([
        "weread",
        "douban",
        "xiaohongshu",
        "wechat_mp",
        "zlib",
        "other",
      ]);
      const safeGroups = Array.isArray(input?.groups)
        ? input.groups.filter((g): g is ReadingSiteGroupId => allowed.has(g))
        : [];
      const extracted = await extractLocalBrowserCookies(String(input?.profileId ?? ""), safeGroups);
      if (extracted.cookies.length === 0) {
        return {
          browserName: extracted.profile.browserName,
          profileName: extracted.profile.profileName,
          accountId: state.browserService.getState().activeAccountId,
          imported: 0,
          failed: 0,
          domains: [] as string[],
        };
      }
      const res = await state.browserService.importCookiesIntoActiveAccount(extracted.cookies);
      return {
        browserName: extracted.profile.browserName,
        profileName: extracted.profile.profileName,
        ...res,
      };
    },
  );
}
