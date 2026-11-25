import { spawnSync } from "node:child_process";

export const MIN_NODE_MAJOR = 24;

export interface ResolvedNodeRuntime {
  bin: string;
  env: Record<string, string>;
  source: "override" | "system" | "electron-run-as-node";
  version?: string;
}

export function probeNodeBinary(bin: string): { ok: boolean; version: string } {
  try {
    const result = spawnSync(bin, ["-p", "process.versions.node"], {
      timeout: 5_000,
      encoding: "utf8",
    });
    if (result.status !== 0) return { ok: false, version: "" };
    const version = String(result.stdout ?? "").trim();
    const major = Number(version.split(".")[0]);
    return {
      ok: Number.isFinite(major) && major >= MIN_NODE_MAJOR,
      version,
    };
  } catch {
    return { ok: false, version: "" };
  }
}

export function resolveNodeRuntime(
  options: {
    overridePath?: string;
    systemNodeBin?: string;
    electronExecPath?: string;
    probe?: (bin: string) => { ok: boolean; version: string };
  } = {},
): ResolvedNodeRuntime {
  const probe = options.probe ?? probeNodeBinary;
  const override = (options.overridePath ?? process.env.DIANDIAN_NODE_PATH ?? "").trim();
  if (override) {
    return { bin: override, env: {}, source: "override" };
  }

  const candidates = options.systemNodeBin
    ? [options.systemNodeBin]
    : ["node", "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];

  let lastVersion = "";
  for (const sysBin of candidates) {
    const probed = probe(sysBin);
    if (probed.version) lastVersion = probed.version;
    if (probed.ok) {
      return {
        bin: sysBin,
        env: {},
        source: "system",
        version: probed.version,
      };
    }
  }

  return {
    bin: options.electronExecPath ?? process.execPath,
    env: { ELECTRON_RUN_AS_NODE: "1" },
    source: "electron-run-as-node",
    version: lastVersion || undefined,
  };
}
