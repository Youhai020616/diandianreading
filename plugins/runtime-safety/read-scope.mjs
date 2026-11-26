/**
 * Keeps the agent's file-reading tools inside the directories 点点读书 gives it.
 *
 * The Harness sandbox policy only limits writes, so read/read_image/glob/grep/present accept any path the
 * user can read (`~` is expanded, relative paths resolve against the session workspace). The agent also
 * reads untrusted text (web pages, imported notes) and can reach the network, so an injected instruction
 * could otherwise read local files and send them out. The roots come from the supervisor
 * (DIANDIAN_AGENT_READ_ROOTS): the agent workspace first, then the spill and attachment directories.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Path arguments of each tool that reads the local filesystem. */
const PATH_ARGUMENTS = {
  read: (args) => [args.file_path],
  read_image: (args) => [args.file_path],
  glob: (args) => [args.path],
  grep: (args) => [args.path],
  present: (args) => (Array.isArray(args.files) ? args.files.map((file) => file?.path) : []),
};

/** Glob arguments, which must stay relative to the directory being searched. */
const PATTERN_ARGUMENTS = {
  glob: (args) => [args.pattern],
  grep: (args) => [args.include],
};

export const READ_SCOPE_TOOLS = Object.freeze(Object.keys(PATH_ARGUMENTS));

/** Parse DIANDIAN_AGENT_READ_ROOTS; anything malformed yields no roots, which denies every read. */
export function parseReadRoots(raw) {
  try {
    const roots = JSON.parse(raw ?? "");
    return Array.isArray(roots) ? roots.filter((root) => typeof root === "string" && path.isAbsolute(root)) : [];
  } catch {
    return [];
  }
}

/** The Harness filesystem backend's `~` handling (dsh-fs-local expandHomePrefix). */
function expandHome(value, home) {
  if (value === "~" || value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
    return `${home}${value.slice(1)}`;
  }
  return value;
}

function hasParentSegment(value) {
  return value.split(/[\\/]+/).includes("..");
}

/** Resolve symlinks along the longest existing prefix; the missing tail cannot contain a link yet. */
function physicalPath(absolute) {
  const missing = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...missing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isInside(target, root) {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..");
}

function denial(value) {
  return `安全守卫：点点读书只允许 AI 读取它自己的工作目录，"${value}" 不在允许范围内。阅读内容请通过 browser_read_page、library_* 等工具获取。`;
}

/**
 * Check one tool call against the read scope.
 * @param {string} toolName - the tool being called.
 * @param {unknown} args - its parsed arguments.
 * @param {{ roots: string[]; home?: string }} scope - allowed roots, workspace first.
 * @returns {string | undefined} a denial reason, or undefined when the call may proceed.
 */
export function checkReadScope(toolName, args, { roots, home = os.homedir() }) {
  const pathsOf = PATH_ARGUMENTS[toolName];
  const patternsOf = PATTERN_ARGUMENTS[toolName];
  if (!pathsOf && !patternsOf) return undefined;
  if (!Array.isArray(roots) || roots.length === 0) {
    return `安全守卫：没有配置 AI 可读取的目录，已阻止 "${toolName}"。`;
  }
  const input = args && typeof args === "object" ? args : {};
  const realRoots = roots.map((root) => physicalPath(path.resolve(root)));
  const workspace = realRoots[0];

  for (const value of pathsOf ? pathsOf(input) : []) {
    if (value === undefined || value === null || value === "") continue; // defaults to the workspace
    if (typeof value !== "string" || value.includes("\0")) return denial(String(value));
    let requested;
    try {
      requested = value.startsWith("file:") ? fileURLToPath(value) : expandHome(value, home);
    } catch {
      return denial(value);
    }
    if (hasParentSegment(requested)) return denial(value);
    const target = physicalPath(path.resolve(workspace, requested));
    if (!realRoots.some((root) => isInside(target, root))) return denial(value);
  }

  for (const value of patternsOf ? patternsOf(input) : []) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" || value.startsWith("~") || path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || hasParentSegment(value)) {
      return denial(String(value));
    }
  }
  return undefined;
}
