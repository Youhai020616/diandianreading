import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

/**
 * The renderer API (src/types/desktop.d.ts) is enforced on preload with `satisfies DesktopBridgeApi`.
 * This test closes the other half of the contract: every channel preload uses must be served by the
 * main process, every handler must be reachable, and every pushed event must have an emitter.
 */
function electronSources(dir = "electron"): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return electronSources(full);
    return /\.(ts|mjs)$/.test(entry.name) && entry.name !== "preload.ts" ? [full] : [];
  });
}

function channels(source: string, pattern: RegExp): Set<string> {
  return new Set([...source.matchAll(pattern)].map(match => match[1]!));
}

const preload = fs.readFileSync("electron/preload.ts", "utf8");
const main = electronSources().map(file => fs.readFileSync(file, "utf8")).join("\n");

const invoked = channels(preload, /ipcRenderer\.(?:invoke|send)\(\s*"([^"]+)"/g);
const subscribed = channels(preload, /ipcRenderer\.on\(\s*"([^"]+)"/g);
const handled = channels(main, /\bipc\.(?:handle|on)\(\s*"([^"]+)"/g);
const emitted = channels(main, /\b(?:send|sendToMain|sendToAll)\(\s*"([^"]+)"/g);

it("serves every channel the renderer calls", () => {
  expect([...invoked].filter(channel => !handled.has(channel))).toEqual([]);
});

it("has no main-process handler the renderer can no longer reach", () => {
  expect([...handled].filter(channel => !invoked.has(channel))).toEqual([]);
});

it("emits every event channel the renderer subscribes to", () => {
  expect([...subscribed].filter(channel => !emitted.has(channel))).toEqual([]);
});
