import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";
import { APP_REPO_URL, buildAppMenuTemplate, type AppMenuAction } from "../electron/appMenu";

function submenuOf(item: MenuItemConstructorOptions | undefined): MenuItemConstructorOptions[] {
  return Array.isArray(item?.submenu) ? item.submenu : [];
}

function build(isMac: boolean, developerTools = true) {
  const sent: AppMenuAction[] = [];
  const opened: string[] = [];
  const template = buildAppMenuTemplate({
    appName: "点点读书",
    isMac,
    developerTools,
    sendAction: (a) => sent.push(a),
    openExternal: (u) => opened.push(u),
  });
  const byLabel = (label: string) => template.find((m) => m.label === label);
  const click = (item: MenuItemConstructorOptions | undefined) =>
    (item?.click as unknown as (() => void) | undefined)?.();
  return { template, byLabel, click, sent, opened };
}

describe("app menu template", () => {
  it("has a macOS app menu with about / preferences ⌘, / hide / quit", () => {
    const { template, click, sent } = build(true);
    const appMenu = submenuOf(template[0]);
    expect(template[0]?.label).toBe("点点读书");
    expect(appMenu.map((i) => i.role).filter(Boolean)).toEqual(
      expect.arrayContaining(["about", "hide", "quit"]),
    );
    const prefs = appMenu.find((i) => i.label === "偏好设置…");
    expect(prefs?.accelerator).toBe("CmdOrCtrl+,");
    click(prefs);
    expect(sent).toEqual(["preferences"]);
  });

  it("wires every 文件 item to a renderer action", () => {
    const { byLabel, click, sent } = build(false);
    const items = submenuOf(byLabel("文件")).filter((i) => i.click);
    items.forEach((i) => click(i));
    expect(sent).toEqual(["new-book", "import-notes", "sync-obsidian", "open-downloads", "preferences"]);
  });

  it("gives 编辑 and 窗口 real content and links 帮助 to the repo", () => {
    for (const isMac of [true, false]) {
      const { byLabel, click, opened } = build(isMac);
      const edit = submenuOf(byLabel("编辑")).map((i) => i.role);
      expect(edit).toEqual(expect.arrayContaining(["undo", "redo", "cut", "copy", "paste", "selectAll"]));
      expect(submenuOf(byLabel("窗口")).length).toBeGreaterThan(0);
      click(submenuOf(byLabel("帮助"))[0]);
      expect(opened).toEqual([APP_REPO_URL]);
    }
  });

  it("does not hijack devtools shortcuts", () => {
    const { template } = build(false);
    const accels = template.flatMap((m) => submenuOf(m)).map((i) => i.accelerator).filter(Boolean);
    expect(accels).not.toContain("CmdOrCtrl+Shift+I");
    expect(new Set(accels).size).toBe(accels.length);
  });

  it("keeps reload and DevTools out of a packaged app", () => {
    const roles = (developerTools: boolean) =>
      submenuOf(build(true, developerTools).byLabel("视图")).map((i) => i.role).filter(Boolean);
    expect(roles(true)).toEqual(expect.arrayContaining(["reload", "toggleDevTools"]));
    expect(roles(false)).not.toContain("reload");
    expect(roles(false)).not.toContain("toggleDevTools");
    expect(roles(false)).toEqual(expect.arrayContaining(["resetZoom", "zoomIn", "zoomOut", "togglefullscreen"]));
  });
});
