import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkReadScope, parseReadRoots, READ_SCOPE_TOOLS } from "../plugins/runtime-safety/read-scope.mjs";

let base: string;
let workspace: string;
let spill: string;
let home: string;
let secret: string;
let scope: { roots: string[]; home: string };

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "dd-read-scope-"));
  workspace = path.join(base, "data", "workspace");
  spill = path.join(base, "data", "harness-home", "spill");
  home = path.join(base, "home");
  for (const dir of [workspace, spill, path.join(home, ".ssh")]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(workspace, "notes.md"), "# 笔记");
  fs.writeFileSync(path.join(spill, "page-1.txt"), "long output");
  secret = path.join(home, ".ssh", "id_ed25519");
  fs.writeFileSync(secret, "PRIVATE KEY");
  fs.symlinkSync(path.join(home, ".ssh"), path.join(workspace, "linked-ssh"));
  // The attachments root does not exist until the Harness stores an image.
  scope = { roots: [workspace, spill, path.join(base, "data", "harness-home", "attachments")], home };
});

afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe("agent read scope", () => {
  it("allows the workspace, spill and attachment directories", () => {
    expect(checkReadScope("read", { file_path: "notes.md" }, scope)).toBeUndefined();
    expect(checkReadScope("read", { file_path: path.join(workspace, "notes.md") }, scope)).toBeUndefined();
    expect(checkReadScope("read", { file_path: path.join(spill, "page-1.txt") }, scope)).toBeUndefined();
    expect(checkReadScope("read_image", { file_path: path.join(base, "data", "harness-home", "attachments", "v1", "a.webp") }, scope)).toBeUndefined();
    expect(checkReadScope("read", { file_path: "drafts/not-yet-created.md" }, scope)).toBeUndefined();
    expect(checkReadScope("glob", { pattern: "**/*.md" }, scope)).toBeUndefined();
    expect(checkReadScope("grep", { pattern: "笔记", path: spill, include: "*.txt" }, scope)).toBeUndefined();
  });

  it("denies absolute, home-relative and file: paths outside those directories", () => {
    expect(checkReadScope("read", { file_path: secret }, scope)).toMatch(/不在允许范围内/);
    expect(checkReadScope("read", { file_path: "~/.ssh/id_ed25519" }, scope)).toMatch(/不在允许范围内/);
    expect(checkReadScope("read", { file_path: "~" }, scope)).toMatch(/不在允许范围内/);
    expect(checkReadScope("read", { file_path: pathToFileURL(secret).href }, scope)).toMatch(/不在允许范围内/);
    expect(checkReadScope("read_image", { file_path: "/etc/hosts" }, scope)).toMatch(/不在允许范围内/);
    expect(checkReadScope("present", { files: [{ path: "notes.md" }, { path: secret }] }, scope)).toMatch(/不在允许范围内/);
  });

  it("denies parent traversal and symlinks that leave the workspace", () => {
    expect(checkReadScope("read", { file_path: "../../home/.ssh/id_ed25519" }, scope)).toMatch(/不在允许范围内/);
    expect(checkReadScope("read", { file_path: `${workspace}/../workspace/notes.md` }, scope)).toMatch(/不在允许范围内/);
    expect(checkReadScope("read", { file_path: "linked-ssh/id_ed25519" }, scope)).toMatch(/不在允许范围内/);
    expect(checkReadScope("grep", { pattern: "KEY", path: "linked-ssh" }, scope)).toMatch(/不在允许范围内/);
  });

  it("keeps glob patterns and grep filters relative to the searched directory", () => {
    expect(checkReadScope("glob", { pattern: "/Users/*/.ssh/*" }, scope)).toMatch(/不在允许范围内/);
    expect(checkReadScope("glob", { pattern: "../**/*" }, scope)).toMatch(/不在允许范围内/);
    expect(checkReadScope("glob", { pattern: "~/**" }, scope)).toMatch(/不在允许范围内/);
    expect(checkReadScope("glob", { pattern: "*.md", path: home }, scope)).toMatch(/不在允许范围内/);
    expect(checkReadScope("grep", { pattern: "x", include: "../*" }, scope)).toMatch(/不在允许范围内/);
  });

  it("fails closed without roots and ignores tools that read no files", () => {
    expect(checkReadScope("read", { file_path: "notes.md" }, { roots: [], home })).toMatch(/没有配置/);
    expect(checkReadScope("read", { file_path: 42 }, scope)).toMatch(/不在允许范围内/);
    expect(checkReadScope("library_list_books", {}, { roots: [], home })).toBeUndefined();
    expect(checkReadScope("web_fetch", { url: "https://example.com/" }, scope)).toBeUndefined();
    expect(READ_SCOPE_TOOLS).toEqual(["read", "read_image", "glob", "grep", "present"]);
  });

  it("parses the roots the supervisor passes and rejects anything malformed", () => {
    expect(parseReadRoots(JSON.stringify(["/a", "relative", 3, "/b"]))).toEqual(["/a", "/b"]);
    expect(parseReadRoots("not json")).toEqual([]);
    expect(parseReadRoots(undefined)).toEqual([]);
  });
});
