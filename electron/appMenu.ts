import type { MenuItemConstructorOptions } from "electron";

export const APP_REPO_URL = "https://github.com/Youhai020616/diandianreading";

/** Commands the native menu forwards to the main renderer over the "app:menu-action" channel. */
export type AppMenuAction =
  | "preferences"
  | "new-book"
  | "import-notes"
  | "sync-obsidian"
  | "open-downloads";

export interface AppMenuDeps {
  appName: string;
  isMac: boolean;
  sendAction: (action: AppMenuAction) => void;
  openExternal: (url: string) => void;
}

/**
 * Native application menu. Labels follow the in-app wording (连接与偏好 / 我的书库 …);
 * Edit/Window use standard roles so clipboard shortcuts and window controls work everywhere.
 */
export function buildAppMenuTemplate(deps: AppMenuDeps): MenuItemConstructorOptions[] {
  const { appName, isMac, sendAction, openExternal } = deps;
  const action = (id: AppMenuAction) => () => sendAction(id);

  const preferences: MenuItemConstructorOptions = {
    label: "偏好设置…",
    accelerator: "CmdOrCtrl+,",
    click: action("preferences"),
  };

  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { role: "about", label: `关于${appName}` },
        { type: "separator" },
        preferences,
        { type: "separator" },
        { role: "services", label: "服务" },
        { type: "separator" },
        { role: "hide", label: `隐藏${appName}` },
        { role: "hideOthers", label: "隐藏其他" },
        { role: "unhide", label: "全部显示" },
        { type: "separator" },
        { role: "quit", label: `退出${appName}` },
      ],
    });
  }

  template.push({
    label: "文件",
    submenu: [
      { label: "新建书目…", accelerator: "CmdOrCtrl+N", click: action("new-book") },
      { label: "导入 Kindle 或微信读书笔记…", click: action("import-notes") },
      { label: "同步到 Obsidian", accelerator: "CmdOrCtrl+Shift+O", click: action("sync-obsidian") },
      { type: "separator" },
      { label: "打开下载目录", click: action("open-downloads") },
      ...(isMac
        ? []
        : ([
            { type: "separator" },
            preferences,
            { type: "separator" },
            { role: "quit", label: "退出" },
          ] satisfies MenuItemConstructorOptions[])),
    ],
  });

  template.push({
    label: "编辑",
    submenu: [
      { role: "undo", label: "撤销" },
      { role: "redo", label: "重做" },
      { type: "separator" },
      { role: "cut", label: "剪切" },
      { role: "copy", label: "拷贝" },
      { role: "paste", label: "粘贴" },
      ...(isMac
        ? ([{ role: "pasteAndMatchStyle", label: "粘贴并匹配样式" }] satisfies MenuItemConstructorOptions[])
        : []),
      { role: "delete", label: "删除" },
      { role: "selectAll", label: "全选" },
    ],
  });

  template.push({
    label: "视图",
    submenu: [
      { role: "reload", label: "重新载入" },
      { role: "toggleDevTools", label: "开发者工具" },
      { type: "separator" },
      { role: "resetZoom", label: "实际大小" },
      { role: "zoomIn", label: "放大" },
      { role: "zoomOut", label: "缩小" },
      { type: "separator" },
      { role: "togglefullscreen", label: "切换全屏" },
    ],
  });

  template.push({
    label: "窗口",
    role: "windowMenu",
    submenu: [
      { role: "minimize", label: "最小化" },
      ...(isMac
        ? ([
            { role: "zoom", label: "缩放" },
            { type: "separator" },
            { role: "front", label: "前置全部窗口" },
          ] satisfies MenuItemConstructorOptions[])
        : ([{ role: "close", label: "关闭窗口" }] satisfies MenuItemConstructorOptions[])),
    ],
  });

  template.push({
    label: "帮助",
    role: "help",
    submenu: [
      { label: "GitHub 项目主页", click: () => openExternal(APP_REPO_URL) },
      { label: "反馈问题", click: () => openExternal(`${APP_REPO_URL}/issues`) },
      ...(isMac
        ? []
        : ([
            { type: "separator" },
            { role: "about", label: `关于${appName}` },
          ] satisfies MenuItemConstructorOptions[])),
    ],
  });

  return template;
}
