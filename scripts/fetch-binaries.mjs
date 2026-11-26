/**
 * Download the third-party executables that ship inside the installer, verify each against the SHA-256
 * pinned below, and unpack it to vendor/<name>/<os>-<arch>/:
 *   zlib  heartleo/zlib CLI (MIT, https://github.com/heartleo/zlib): book search, download, Kindle, WeRead
 *   node  Node.js runtime for the DeepSeek Harness, which does not support Electron's built-in Node
 *
 *   node scripts/fetch-binaries.mjs zlib             # this machine's platform (`pnpm dev` runs this)
 *   node scripts/fetch-binaries.mjs node mac-x64     # a specific target
 *
 * scripts/before-build.mjs runs both for every platform/arch electron-builder packages; `extraResources`
 * in package.json then copies the folders to resources/zlib and resources/node.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unzipSync } from "fflate";

const ZLIB_VERSION = "0.0.16";
const NODE_VERSION = "24.22.3";

/** Target names follow electron-builder's `${os}-${arch}`. Hashes come from each release's checksum file. */
const BINARIES = {
  zlib: {
    label: `heartleo/zlib v${ZLIB_VERSION}`,
    url: (file) => `https://github.com/heartleo/zlib/releases/download/v${ZLIB_VERSION}/${file}`,
    targets: {
      "mac-arm64": ["zlib_0.0.16_darwin_arm64.tar.gz", "3dd8ed3a5fb0483f24a52eac893ae9377c16dbfa9e10f9b3d013030ef43857d8"],
      "mac-x64": ["zlib_0.0.16_darwin_x86_64.tar.gz", "efcb35edfbecec288b27bee85a865cd155c0059aafd3fe14515f6eb96e0c92d4"],
      "linux-arm64": ["zlib_0.0.16_linux_arm64.tar.gz", "e5784c41bc61f64c4b967ad21168ac4997793096b36801cf1949b9a9ed923453"],
      "linux-x64": ["zlib_0.0.16_linux_x86_64.tar.gz", "a9c91ea442f2fe58414a32ed2a457b4f7bed469c9069d880e60473fa5e338f58"],
      "win-arm64": ["zlib_0.0.16_windows_arm64.zip", "07f6c34fca6a0358aab07d26049a6aca0a94e822ef4308fdb7dd95d0fa61a7e4"],
      "win-x64": ["zlib_0.0.16_windows_x86_64.zip", "4f3126275f654890176f6d1c07b5ab18ddfbf03546304cbdd68b71152e9d1c49"],
    },
    /** Archive entry → file name in the output folder; the executable comes first. */
    entries: (_file, exe) => ({ [exe("zlib")]: exe("zlib"), LICENSE: "LICENSE" }),
  },
  node: {
    label: `Node.js v${NODE_VERSION}`,
    url: (file) => `https://nodejs.org/dist/v${NODE_VERSION}/${file}`,
    targets: {
      "mac-arm64": ["node-v24.22.3-darwin-arm64.tar.gz", "ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd"],
      "mac-x64": ["node-v24.22.3-darwin-x64.tar.gz", "977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7"],
      "linux-arm64": ["node-v24.22.3-linux-arm64.tar.gz", "261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8"],
      "linux-x64": ["node-v24.22.3-linux-x64.tar.gz", "061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2"],
      "win-arm64": ["node-v24.22.3-win-arm64.zip", "b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14"],
      "win-x64": ["node-v24.22.3-win-x64.zip", "e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f"],
    },
    entries: (file, exe) => {
      const dir = file.replace(/\.(tar\.gz|zip)$/, "");
      const binary = exe("node") === "node" ? `${dir}/bin/node` : `${dir}/node.exe`;
      return { [binary]: exe("node"), [`${dir}/LICENSE`]: "LICENSE" };
    },
  },
};

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function hostTarget() {
  const platform = { darwin: "mac", win32: "win", linux: "linux" }[process.platform] ?? process.platform;
  return `${platform}-${process.arch}`;
}

/** Make sure vendor/<name>/<target>/ holds the pinned build; downloads only when it is missing or stale. */
export async function fetchBinary(name, target) {
  const spec = BINARIES[name];
  if (!spec) throw new Error(`[fetch-binaries] unknown binary "${name}"; known: ${Object.keys(BINARIES).join(", ")}`);
  const asset = spec.targets[target];
  if (!asset) throw new Error(`[fetch-binaries] ${spec.label} has no build for ${target}; known: ${Object.keys(spec.targets).join(", ")}`);
  const [fileName, sha256] = asset;
  const exe = (base) => (target.startsWith("win-") ? `${base}.exe` : base);
  const entries = spec.entries(fileName, exe);
  const outputs = Object.values(entries);
  const outDir = path.join(rootDir, "vendor", name, target);
  const stamp = path.join(rootDir, "vendor", name, `${target}.sha256`);
  const upToDate = fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8").trim() === sha256
    && outputs.every((out) => fs.existsSync(path.join(outDir, out)));
  if (upToDate) return outDir;

  const url = spec.url(fileName);
  console.log(`[fetch-binaries] downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`[fetch-binaries] download failed (${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256) throw new Error(`[fetch-binaries] checksum mismatch for ${fileName}: expected ${sha256}, got ${actual}`);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  if (fileName.endsWith(".zip")) {
    const files = unzipSync(bytes, { filter: (file) => file.name in entries });
    for (const [entry, data] of Object.entries(files)) fs.writeFileSync(path.join(outDir, entries[entry]), data);
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fetch-binaries-"));
    try {
      const archive = path.join(tmp, fileName);
      fs.writeFileSync(archive, bytes);
      execFileSync("tar", ["-xzf", archive, "-C", tmp, ...Object.keys(entries)]);
      for (const [entry, out] of Object.entries(entries)) fs.renameSync(path.join(tmp, entry), path.join(outDir, out));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  for (const out of outputs) {
    if (!fs.existsSync(path.join(outDir, out))) throw new Error(`[fetch-binaries] ${fileName} has no ${out}`);
  }
  fs.chmodSync(path.join(outDir, outputs[0]), 0o755);
  fs.writeFileSync(stamp, `${sha256}\n`);
  console.log(`[fetch-binaries] ${spec.label} → ${path.relative(rootDir, outDir)}`);
  return outDir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // `--optional` (used by `pnpm dev`): a failed download only warns, e.g. a system zlib still works.
  const optional = process.argv.includes("--optional");
  const [name, target = hostTarget()] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  fetchBinary(name, target).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    if (!optional) process.exit(1);
  });
}
