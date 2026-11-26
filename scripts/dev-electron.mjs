/**
 * `pnpm dev`: every edit reaches the running app without pulling it in front of other apps.
 *
 *   src/**                          Vite hot-updates the open window in place.
 *   plugins/**, electron/agent/sdkBridge.mjs
 *                                   the main process restarts only the agent engine (electron/devReload.ts).
 *   electron/**\/*.ts               tsc --watch recompiles; after a clean build Electron restarts hidden
 *                                   (DIANDIAN_START_HIDDEN=1). Its windows appear when you switch back to it,
 *                                   on the default page.
 *
 * `DIANDIAN_START_HIDDEN=1 pnpm dev` starts the first instance hidden as well.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const DEV_URL = "http://127.0.0.1:5173";
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const electronBinary = require("electron");
// Run tools straight from their entry files so stopping them never leaves a watcher behind a pnpm wrapper.
const binOf = (pkg, file) => path.join(path.dirname(require.resolve(`${pkg}/package.json`)), file);
const node = (entry, args, options) => spawn(process.execPath, [entry, ...args], { cwd: rootDir, ...options });
const log = (message) => console.log(`[dev] ${message}`);

function waitForPort(port, host = "127.0.0.1", timeoutMs = 30_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ port, host });
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`Timed out waiting for ${host}:${port}`));
          return;
        }
        setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

const children = new Set();
function track(child) {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// ---- Electron, restartable without stealing focus ----
let electron = null;
let restarting = false;
let restartQueued = false;

function startElectron(hidden) {
  electron = track(
    spawn(electronBinary, ["."], {
      cwd: rootDir,
      stdio: "inherit",
      env: {
        ...process.env,
        DIANDIAN_DEV_SERVER_URL: DEV_URL,
        ...(hidden ? { DIANDIAN_START_HIDDEN: "1" } : {}),
      },
    }),
  );
  const current = electron;
  current.once("exit", (code) => {
    // Quitting the app ends `pnpm dev`; a restart we asked for does not.
    if (!restarting && current === electron) shutdown(code ?? 0);
  });
}

async function restartElectron() {
  if (restarting) {
    restartQueued = true;
    return;
  }
  restarting = true;
  const old = electron;
  if (old && old.exitCode === null) {
    await new Promise((resolve) => {
      old.once("exit", resolve);
      old.kill("SIGTERM");
    });
  }
  startElectron(true);
  restarting = false;
  log("main process rebuilt; Electron restarted in the background (switch to the app to see it)");
  if (restartQueued) {
    restartQueued = false;
    void restartElectron();
  }
}

// ---- main-process compiler ----
function watchMainProcess() {
  const tsc = track(
    node(binOf("typescript", "bin/tsc"), ["-p", "tsconfig.electron.json", "--watch", "--preserveWatchOutput"], {
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  let initialBuildDone = false;
  let buffer = "";
  tsc.stdout.setEncoding("utf8");
  tsc.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const match = /Found (\d+) errors?\. Watching for file changes/.exec(line);
      if (!match) continue;
      if (!initialBuildDone) {
        initialBuildDone = true; // `pnpm dev` compiled already; this pass re-emits the same files.
        continue;
      }
      if (match[1] === "0") void restartElectron();
      else log("main process has type errors; the app keeps running the previous build");
    }
  });
}

// ---- SDK bridge (plain .mjs, copied rather than compiled) ----
function watchSdkBridge() {
  const source = path.join(rootDir, "electron", "agent", "sdkBridge.mjs");
  const target = path.join(rootDir, "dist-electron", "agent", "sdkBridge.mjs");
  let timer = null;
  fs.watch(source, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      fs.copyFileSync(source, target);
      log("sdkBridge.mjs updated; the agent engine reloads in place");
    }, 150);
  });
}

track(node(binOf("vite", "bin/vite.js"), [], { stdio: "inherit", env: process.env }));

try {
  await waitForPort(5173);
  startElectron(process.env.DIANDIAN_START_HIDDEN === "1");
  watchMainProcess();
  watchSdkBridge();
} catch (error) {
  console.error(error);
  shutdown(1);
}
