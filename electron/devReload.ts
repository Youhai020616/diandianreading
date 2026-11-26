/**
 * Development helpers that keep reloads out of the user's way.
 *
 * - DIANDIAN_START_HIDDEN=1 starts the app without showing the main window or the pet; both appear the
 *   first time the user switches to the app. scripts/dev-electron.mjs sets it when it restarts Electron
 *   after a main-process change, and automated tests set it so nothing jumps in front of other apps.
 * - In an unpackaged run, edits to the Harness plugins or the SDK bridge restart only the agent engine.
 */
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

/** Whether this run should stay hidden until the user activates the app (macOS only). */
export function shouldStartHidden(): boolean {
  return process.env.DIANDIAN_START_HIDDEN === "1" && process.platform === "darwin";
}

/** Run `reveal` the first time the app becomes active (Dock click, Cmd-Tab or clicking a window). */
export function revealWhenActivated(reveal: () => void): void {
  app.once("did-become-active", reveal);
}

/** Restart the agent engine (never a window) when the Harness plugins or the SDK bridge change. */
export function watchAgentSources(projectRoot: string, reload: () => void): void {
  let timer: NodeJS.Timeout | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      reload();
    }, 300);
  };
  for (const target of [path.join(projectRoot, "plugins"), path.join(projectRoot, "dist-electron", "agent")]) {
    try {
      fs.watch(target, { recursive: true }, (_event, file) => {
        if (target.endsWith("agent") && file !== "sdkBridge.mjs") return; // compiled main-process code restarts Electron instead
        schedule();
      });
    } catch {
      // A missing directory simply has nothing to watch.
    }
  }
}
