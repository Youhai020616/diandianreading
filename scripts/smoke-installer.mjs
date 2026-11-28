// Run against the installed (or mounted) package, using a fresh Chromium profile and database.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [app, resources] = process.argv.slice(2);
const suffix = process.platform === "win32" ? ".exe" : "";
const node = path.join(resources, "node", "node" + suffix);
const zlib = path.join(resources, "zlib", "zlib" + suffix);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "diandian-smoke-"));
const profile = path.join(temp, "profile");
const run = { cwd: resources, encoding: "utf8", timeout: 30_000 };
assert.equal(execFileSync(node, ["-p", "process.platform + '-' + process.arch"], run).trim(), process.platform + "-" + process.arch);
execFileSync(node, ["-e", "require('sharp'); require('node:sqlite')"], run);
assert.match(execFileSync(zlib, ["--version"], run), /zlib version/);

// Boot the SDK with the shipped plugins and a loopback-only provider. No model request is made.
const unpacked = path.join(resources, "app.asar.unpacked");
const { writeOverlayPatch, ROUTE_PROVIDER_ID } = createRequire(import.meta.url)(path.join(unpacked, "dist-electron/agent/overlay.js"));
const dshHome = path.join(temp, "dsh");
const plugins = ["reading-browser", "reading-studio", "twin-context", "runtime-safety", "live-stream"];
const patch = writeOverlayPatch({
  dshHome,
  settings: { provider: "openai-compatible", baseUrl: "http://127.0.0.1:9/v1", model: "offline-test" },
  pluginEntries: plugins.map(name => ({ id: "diandian-" + name, entryPath: path.join(unpacked, "plugins", name, "index.mjs") })),
});
const boot = `
  import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
  const [patch, home, provider] = process.argv.slice(1);
  const sdk = new DeepSeekHarness({ patches: [patch], dshHome: home, cwd: home, processCwd: home, provider, model: 'offline-test' });
  try { await sdk.start(); } finally { await sdk.close(); }
`;
execFileSync(node, ["--input-type=module", "-e", boot, patch, dshHome, ROUTE_PROVIDER_ID], {
  ...run, timeout: 100_000, stdio: "inherit",
  env: { ...process.env, DSH_HOME: dshHome, DIANDIAN_LLM_API_KEY: "offline-test" },
});

const child = spawn(app, [`--user-data-dir=${profile}`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"], {
  cwd: temp,
  env: { ...process.env, DIANDIAN_START_HIDDEN: "1", DIANDIAN_USER_DATA_DIR: temp, DIANDIAN_DOWNLOAD_DIR: path.join(temp, "downloads") },
  stdio: "inherit",
});
const stopped = new Promise(resolve => child.once("exit", resolve));

async function hasWorkspace(page) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Renderer probe timed out")), 5000);
      socket.addEventListener("open", () => socket.send(JSON.stringify({
        id: 1, method: "Runtime.evaluate", params: { expression: "!!document.querySelector('.app-shell .main-stage')" },
      })));
      socket.addEventListener("message", ({ data }) => {
        const message = JSON.parse(data);
        if (message.id === 1) { clearTimeout(timeout); resolve(message.result?.result?.value === true); }
      });
      socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Renderer probe disconnected")); });
    });
  } finally {
    socket.close();
  }
}

try {
  let ready = false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !ready) {
    if (child.exitCode !== null || child.signalCode) throw new Error("Desktop app exited before rendering");
    await delay(500);
    const portFile = path.join(profile, "DevToolsActivePort");
    if (!fs.existsSync(portFile)) continue;
    const port = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0];
    if (!/^\d+$/.test(port)) continue;
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const main = pages.find(page => page.type === "page" && page.url.startsWith("file:") && page.url.endsWith("/dist/index.html"));
    if (main) ready = await hasWorkspace(main);
  }
  assert.ok(ready, "The installed app did not render its main workspace");
  assert.ok(fs.statSync(path.join(temp, "state", "diandian.sqlite3")).size > 0);
  console.log("Installed runtime, book CLI, main workspace and database verified.");
} finally {
  child.kill();
  await stopped;
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
