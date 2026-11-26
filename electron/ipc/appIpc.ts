import { app, nativeTheme } from "electron";
import { state, ipc, sendToAll } from "../appState";

export function registerAppIpc(): void {
  ipc.handle("app:take-menu-action", () => {
    const action = state.pendingMenuAction;
    state.pendingMenuAction = null;
    return action ? { action } : null;
  });

  ipc.handle("app:info", () => ({
    name: app.getName(),
    version: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
  }));

  ipc.handle("app:set-theme", (win, mode: "light" | "dark") => {
    const clean = mode === "dark" ? "dark" : "light";
    state.currentAppTheme = clean;
    nativeTheme.themeSource = clean;
    if (!win.isDestroyed()) {
      win.setBackgroundColor(clean === "dark" ? "#12161f" : "#ffffff");
    }
    sendToAll("app:theme-changed", { theme: clean });
    state.browserMenuController?.updateData({ theme: clean });
    state.browserService?.syncThemeBackground(clean === "dark");
    return { theme: clean };
  });
}
