import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildOverlayYaml } from "../electron/agent/overlay";
import {
  bundledZlibCandidates,
  extractDownloadedFilePath,
  isValidZlibBookRef,
  parseZlibSearchJson,
} from "../electron/router/zlibCliService";
import { evaluateToolSafety, SafetyModeStore, TOOL_POLICY_FILE } from "../electron/security/safetyPolicy";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Runtime safety policy", () => {
  it("always blocks raw shell/file mutation tools across all modes", () => {
    for (const mode of ["plan", "confirm", "auto"] as const) {
      expect(evaluateToolSafety(mode, "bash")).toBeTruthy();
      expect(evaluateToolSafety(mode, "write")).toBeTruthy();
      expect(evaluateToolSafety(mode, "edit")).toBeTruthy();
    }
  });

  it("enforces graduated restrictions across plan, confirm and auto modes", () => {
    expect(evaluateToolSafety("plan", "browser_read_page")).toBeNull();
    expect(evaluateToolSafety("plan", "library_list_books")).toBeNull();
    expect(evaluateToolSafety("plan", "library_save_highlight")).toBeTruthy();
    expect(evaluateToolSafety("plan", "draft_create_or_revise")).toBeTruthy();

    expect(evaluateToolSafety("confirm", "library_save_highlight")).toBeNull();
    expect(evaluateToolSafety("confirm", "draft_create_or_revise")).toBeNull();
    expect(evaluateToolSafety("confirm", "obsidian_export_book")).toBeTruthy();
    expect(evaluateToolSafety("confirm", "obsidian_export_draft")).toBeTruthy();

    expect(evaluateToolSafety("auto", "obsidian_export_book")).toBeNull();
    expect(evaluateToolSafety("auto", "browser_navigate")).toBeNull();
  });

  it("guards only tools the plugins actually register, from one shared policy file", () => {
    const registered = new Set<string>();
    for (const plugin of fs.readdirSync(path.resolve("plugins"))) {
      const file = path.resolve("plugins", plugin, "index.mjs");
      if (!fs.existsSync(file)) continue;
      for (const match of fs.readFileSync(file, "utf8").matchAll(/defineTool\(\{\s*name:\s*"([a-z_]+)"/g)) registered.add(match[1]!);
    }
    const policy = JSON.parse(fs.readFileSync(TOOL_POLICY_FILE, "utf8")) as { planDenied: string[]; confirmDenied: string[] };
    for (const tool of [...policy.planDenied, ...policy.confirmDenied]) expect(registered, tool).toContain(tool);
    expect(registered).not.toContain("book_router_download");
    // The enforcing guard in the Harness reads the same file instead of keeping its own list.
    const guard = fs.readFileSync(path.resolve("plugins/runtime-safety/index.mjs"), "utf8");
    expect(guard).toContain("tool-policy.json");
    expect(guard).not.toMatch(/new Set\(\[/);
  });

  it("persists safety mode atomically", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diandian-safety-"));
    tempDirs.push(dir);
    const store = new SafetyModeStore(dir);
    expect(store.read()).toBe("confirm");
    store.write("plan");
    expect(store.read()).toBe("plan");
    store.write("auto");
    expect(store.read()).toBe("auto");
  });
});

describe("Bundled zlib CLI location", () => {
  it("looks in the installed app's resources first, then the checkout's vendor folder", () => {
    const [installed, checkout] = bundledZlibCandidates("/Applications/Diandian.app/Contents/Resources", "darwin", "arm64");
    expect(installed).toBe(path.join("/Applications/Diandian.app/Contents/Resources", "zlib", "zlib"));
    expect(checkout).toBe(path.resolve(__dirname, "..", "vendor", "zlib", "mac-arm64", "zlib"));
  });

  it("uses electron-builder's ${os}-${arch} folder names and .exe on Windows", () => {
    const candidates = bundledZlibCandidates("C:\\App\\resources", "win32", "x64");
    expect(candidates[0]).toBe(path.join("C:\\App\\resources", "zlib", "zlib.exe"));
    expect(candidates[1]).toBe(path.resolve(__dirname, "..", "vendor", "zlib", "win-x64", "zlib.exe"));
  });

  it("skips the resources folder outside Electron", () => {
    expect(bundledZlibCandidates(undefined, "linux", "x64")).toEqual([
      path.resolve(__dirname, "..", "vendor", "zlib", "linux-x64", "zlib"),
    ]);
  });
});

describe("Zlib CLI validation & multi-plugin overlay", () => {
  it("validates strict bookRef tokens and parses JSON search output", () => {
    expect(isValidZlibBookRef("123456:ab98cd")).toBe(true);
    expect(isValidZlibBookRef("123456:ab98cd; rm -rf /")).toBe(false);
    expect(isValidZlibBookRef("../etc/passwd")).toBe(false);

    const parsed = parseZlibSearchJson(
      JSON.stringify([
        {
          id: "118429543:bfe70e",
          hash: "bfe70e",
          isbn: "9780345807014",
          name: "The Autobiography of Red",
          authors: ["Anne Carson"],
          extension: "EPUB",
          filesizeString: "2.1 MB",
          year: 1998,
        },
        {
          id: 98765,
          hash: "f00ba1",
          title: "Designing Data-Intensive Applications",
          author: "Martin Kleppmann",
          extension: "PDF",
        },
      ]),
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.bookRef).toBe("118429543:bfe70e");
    expect(parsed[0]?.title).toBe("The Autobiography of Red");
    expect(parsed[0]?.author).toBe("Anne Carson");
    expect(parsed[0]?.extension).toBe("epub");
    expect(parsed[1]?.bookRef).toBe("98765:f00ba1");
    expect(parsed[1]?.extension).toBe("pdf");

    // Also verifies HTML entity decoding, { items } wrapper, cover-not-exists filtering, and year="0" cleanup
    const feedParsed = parseZlibSearchJson(
      JSON.stringify({
        items: [
          {
            id: "128370132:1cc817",
            hash: "1cc817",
            name: "Claude AI &amp; Prompting &#39;Guide&#39;",
            authors: ["Stephen &amp; Clear"],
            cover: "/img/cover-not-exists.png",
            year: "0",
            url: "https://z-lib.gd/book/abc",
            rating: "5.0",
          },
        ],
      }),
    );
    expect(feedParsed).toHaveLength(1);
    expect(feedParsed[0]?.title).toBe("Claude AI & Prompting 'Guide'");
    expect(feedParsed[0]?.author).toBe("Stephen & Clear");
    expect(feedParsed[0]?.coverUrl).toBe("");
    expect(feedParsed[0]?.year).toBe("");
    expect(feedParsed[0]?.url).toBe("https://z-lib.gd/book/abc");
    expect(feedParsed[0]?.rating).toBe("5.0");

    // Downloaded file path extraction only trusts files inside targetDir
    const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), "diandian-dl-"));
    tempDirs.push(dlDir);
    const savedBook = path.join(dlDir, "窄门.epub");
    fs.writeFileSync(savedBook, "epub-bytes", "utf8");
    expect(extractDownloadedFilePath(JSON.stringify({ path: savedBook }), dlDir)).toBe(savedBook);
    expect(extractDownloadedFilePath(JSON.stringify({ path: "/etc/passwd" }), dlDir)).toBeUndefined();
  });

  it("mounts all existing Cordis plugins without leaking API keys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diandian-overlay-"));
    tempDirs.push(dir);
    const p1 = path.join(dir, "p1.mjs");
    const p2 = path.join(dir, "p2.mjs");
    fs.writeFileSync(p1, "export const name = 'p1';", "utf8");
    fs.writeFileSync(p2, "export const name = 'p2';", "utf8");

    const yaml = buildOverlayYaml({
      dshHome: dir,
      pluginEntries: [
        { id: "diandian-reading-browser", entryPath: p1 },
        { id: "diandian-reading-studio", entryPath: p2 },
      ],
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-must-not-leak",
      },
    });

    expect(yaml).toContain("diandian-reading-browser");
    expect(yaml).toContain("diandian-reading-studio");
    expect(yaml).not.toContain("sk-must-not-leak");
    for (const id of ["office-kit", "tool-office", "skill-office"]) {
      expect(yaml).toContain(`- id: ${id}\n  disabled: true`);
    }
  });
});
