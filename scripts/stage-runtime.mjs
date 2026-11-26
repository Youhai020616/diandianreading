/**
 * Stage the production node_modules that ship next to app.asar as resources/node_modules.
 *
 * electron-builder cannot collect this dependency tree itself: its pnpm collector runs
 * `pnpm list --depth Infinity`, which runs out of memory on the DeepSeek Harness tree, and its fallback
 * traversal skips peer dependencies (the Harness then fails with "Cannot find package"). Instead pnpm
 * installs the production dependencies from the same lockfile into a flat (hoisted) layout under
 * vendor/runtime/<os>-<arch>/node_modules. Node resolves packages there from both app.asar (main process)
 * and app.asar.unpacked (the Harness bridge and plugins) by walking up to resources/node_modules.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostTarget } from "./fetch-binaries.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * LibreOffice engines for the Harness's Office tools (native per platform plus a WASM fallback, ~300MB).
 * 点点读书 turns those tools off (DISABLED_HARNESS_PLUGINS in electron/agent/overlay.ts), so the engines are
 * dropped; the small @deepseek-ai/libreoffice-kit adapter stays because dsh-office-kit imports it.
 */
const DROPPED_SCOPE = "@deepseek-ai";
const DROPPED_PREFIX = "libreoffice-kit-";

/** Packages the app cannot start without; checked after the install. */
const REQUIRED = ["@deepseek-ai/dsh", "@deepseek-ai/dsh-sdk-client", "@deepseek-ai/dsh-sdk-protocol", "@deepseek-ai/dsh-tools", "sharp", "yauzl"];

export function stageRuntime(target) {
  // Native packages (sharp, koffi, sherpa-onnx…) are installed for the machine running pnpm.
  if (target !== hostTarget()) {
    throw new Error(`[stage-runtime] can only stage ${hostTarget()} on this machine, not ${target}`);
  }
  const stageDir = path.join(rootDir, "vendor", "runtime", target);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  for (const file of ["package.json", "pnpm-lock.yaml"]) {
    fs.copyFileSync(path.join(rootDir, file), path.join(stageDir, file));
  }
  fs.cpSync(path.join(rootDir, "patches"), path.join(stageDir, "patches"), { recursive: true });

  console.log(`[stage-runtime] installing production dependencies for ${target}`);
  execFileSync(
    "pnpm",
    ["install", "--prod", "--frozen-lockfile", "--ignore-scripts", "--config.node-linker=hoisted", "--reporter=append-only"],
    { cwd: stageDir, stdio: "inherit", shell: process.platform === "win32" },
  );

  const nodeModules = path.join(stageDir, "node_modules");
  for (const name of fs.readdirSync(path.join(nodeModules, DROPPED_SCOPE))) {
    if (!name.startsWith(DROPPED_PREFIX)) continue;
    fs.rmSync(path.join(nodeModules, DROPPED_SCOPE, name), { recursive: true, force: true });
    console.log(`[stage-runtime] dropped ${DROPPED_SCOPE}/${name}`);
  }
  const missing = REQUIRED.filter((name) => !fs.existsSync(path.join(nodeModules, name, "package.json")));
  if (missing.length > 0) throw new Error(`[stage-runtime] staged node_modules is missing ${missing.join(", ")}`);
  return nodeModules;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    stageRuntime(process.argv[2] || hostTarget());
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
