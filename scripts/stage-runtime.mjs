/**
 * Stage the production node_modules that ship next to app.asar as resources/node_modules.
 *
 * electron-builder cannot collect this dependency tree itself: its pnpm collector runs
 * `pnpm list --depth Infinity`, which runs out of memory on the DeepSeek Harness tree, and its fallback
 * traversal skips peer dependencies (the Harness then fails with "Cannot find package"). Instead pnpm
 * installs the production dependencies from the same lockfile into a flat (hoisted) layout under
 * vendor/runtime/<os>-<arch>/node_modules. Node resolves packages there from both app.asar (main process)
 * and app.asar.unpacked (the Harness bridge and plugins) by walking up to resources/node_modules.
 *
 * The install is then pruned to what 点点读书 runs. @deepseek-ai/dsh declares every dsh surface (Web UI,
 * ACP, inspector, voice input, computer use, terminals…), but the app only boots the `sdk` profile: the
 * dsh-base and dsh-sdk-app bundles plus electron/agent/overlay.ts. Evaluated on Harness 0.2.2-rc.5 by
 * tracing module loads in the packaged app (boot, a full turn and 23 tool calls) and by reading which
 * plugins the sdk profile names; re-check both lists when upgrading the Harness.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostTarget } from "./fetch-binaries.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Dependencies of @deepseek-ai/dsh that the sdk profile neither names nor loads. Only the launcher's own
 * edge to them is cut: a package stays whenever anything still kept depends on it.
 */
const LAUNCHER_ONLY = [
  // Other dsh profiles and their surfaces.
  "@deepseek-ai/dsh-web-app", // Web UI profile: web frontend, document preview, settings UI…
  "@deepseek-ai/dsh-acp-app",
  "@deepseek-ai/dsh-headless",
  "@deepseek-ai/dsh-sdk-minimal",
  "@deepseek-ai/dsh-experimental-inspector-profile", // session log inspector (~24MB)
  "@deepseek-ai/dsh-client-ui-agent-preset",
  "@deepseek-ai/dsh-client-ui-cordis",
  "@deepseek-ai/dsh-cordis-client-runner",
  // Optional bundles a user enables from the dsh UI.
  "@deepseek-ai/dsh-experimental-voice-input-bundle", // local SenseVoice speech recognition (sherpa-onnx, ~34MB)
  "@deepseek-ai/dsh-cua-bundle", // macOS computer use
  "@deepseek-ai/dsh-experimental-auto-review",
  "@deepseek-ai/dsh-experimental-cot-translation-bundle",
  "@deepseek-ai/dsh-experimental-badge-skill-bundle",
  "@deepseek-ai/dsh-experimental-ralph-bundle",
  "@deepseek-ai/dsh-experimental-session-titles-bundle",
  "@deepseek-ai/dsh-experimental-terminal-bundle",
  "@deepseek-ai/dsh-experimental-liveshare",
  "@deepseek-ai/dsh-experimental-session-search",
  "@deepseek-ai/dsh-experimental-tool-worktree",
  "@deepseek-ai/dsh-experimental-plugin-market-bundle",
  "@deepseek-ai/dsh-experimental-forge-bundle",
  "@deepseek-ai/dsh-personalized-recommendations",
  "@deepseek-ai/dsh-deepseek-chat-import",
  // Plugins no layer of the sdk profile mounts.
  "@deepseek-ai/dsh-mcp-client",
  "@deepseek-ai/dsh-terminal",
  "@deepseek-ai/dsh-terminal-bash",
  "@deepseek-ai/dsh-tmux-context",
  "@deepseek-ai/dsh-tool-bash-persistent",
  "@deepseek-ai/dsh-tool-pwsh-persistent",
  "@deepseek-ai/dsh-tool-cordis",
  "@deepseek-ai/dsh-tool-str-replace-editor",
  "@deepseek-ai/dsh-pwsh-local",
  "@deepseek-ai/dsh-persona",
  "@deepseek-ai/dsh-session-reference",
  "@deepseek-ai/dsh-agent-preset",
  "@deepseek-ai/dsh-agent-tool-presentation", // deprecated upstream
];

/** Removed even though a kept package depends on them. */
const CUT = {
  // Required lazily by dsh-subprocess-local for PTY terminals only, which just the terminal plugins above
  // use; without it the service reports SUBPROCESS_PTY_UNAVAILABLE instead of failing to load (~27MB).
  "node-pty": true,
  // Office engine adapter plus its LibreOffice engines (~300MB) and font stack; its only user,
  // dsh-office-kit, is off (DISABLED_HARNESS_PLUGINS in electron/agent/overlay.ts).
  "@deepseek-ai/libreoffice-kit": true,
};

const LAUNCHER = "@deepseek-ai/dsh";

/** Packages the app cannot start without; checked after pruning. */
const REQUIRED = ["@deepseek-ai/dsh", "@deepseek-ai/dsh-sdk-client", "@deepseek-ai/dsh-sdk-protocol", "@deepseek-ai/dsh-tools", "sharp", "yauzl"];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Top-level package directories of a hoisted node_modules, by package name. */
function topLevelPackages(nodeModules) {
  const dirs = new Map();
  for (const entry of fs.readdirSync(nodeModules)) {
    if (entry.startsWith(".")) continue;
    const full = path.join(nodeModules, entry);
    const names = entry.startsWith("@") ? fs.readdirSync(full).map((sub) => `${entry}/${sub}`) : [entry];
    for (const name of names) dirs.set(name, path.join(nodeModules, name));
  }
  return dirs;
}

/** name → every dependency, optional dependency and peer any installed copy of it declares. */
function dependencyGraph(nodeModules) {
  const graph = new Map();
  const visit = (dir) => {
    for (const [name, pkgDir] of topLevelPackages(dir)) {
      const manifest = readJson(path.join(pkgDir, "package.json"));
      if (manifest?.name !== name) continue;
      const deps = graph.get(name) ?? new Set();
      for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
        for (const dep of Object.keys(manifest[field] ?? {})) deps.add(dep);
      }
      graph.set(name, deps);
      const nested = path.join(pkgDir, "node_modules");
      if (fs.existsSync(nested)) visit(nested);
    }
  };
  visit(nodeModules);
  return graph;
}

/** Plugins named by the sdk profile's bundle layers; they must survive pruning even when disabled. */
function sdkProfilePlugins(nodeModules) {
  const names = new Set();
  for (const bundle of ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"]) {
    const patch = fs.readFileSync(path.join(nodeModules, bundle, "cordis.patch.yml"), "utf8");
    for (const [, name] of patch.matchAll(/^\s*name:\s*'?([@\w./-]+)'?\s*$/gm)) names.add(name);
  }
  return names;
}

function directorySize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directorySize(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

/** Delete every top-level package that the app's dependencies no longer reach. */
export function pruneRuntime(nodeModules, rootDependencies) {
  const graph = dependencyGraph(nodeModules);
  const launcherOnly = new Set(LAUNCHER_ONLY);
  const keep = new Set();
  const stack = [...rootDependencies];
  while (stack.length > 0) {
    const name = stack.pop();
    if (keep.has(name) || CUT[name] || !graph.has(name)) continue;
    keep.add(name);
    for (const dep of graph.get(name)) {
      if (name === LAUNCHER && launcherOnly.has(dep)) continue;
      stack.push(dep);
    }
  }

  const installed = topLevelPackages(nodeModules);
  const lostPlugins = [...sdkProfilePlugins(nodeModules)].filter((name) => installed.has(name) && !keep.has(name));
  if (lostPlugins.length > 0) {
    throw new Error(`[stage-runtime] pruning would remove plugins the sdk profile names: ${lostPlugins.join(", ")}`);
  }

  let removed = 0;
  let bytes = 0;
  for (const [name, dir] of installed) {
    if (keep.has(name)) continue;
    bytes += directorySize(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    removed += 1;
  }
  for (const entry of fs.readdirSync(nodeModules)) {
    const scope = path.join(nodeModules, entry);
    if (entry.startsWith("@") && fs.readdirSync(scope).length === 0) fs.rmdirSync(scope);
  }
  console.log(`[stage-runtime] pruned ${removed} packages the sdk profile does not use (${(bytes / 1e6).toFixed(0)} MB)`);
}

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
  const rootDependencies = Object.keys(readJson(path.join(rootDir, "package.json")).dependencies ?? {});
  pruneRuntime(nodeModules, rootDependencies);
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
