# CLAUDE.md

diandianreading v2（`main`）：local-first 个人阅读与表达桌面工作台（Electron + 原生 `WebContentsView` + DeepSeek Harness SDK 插件架构）。v1 Python/FastAPI 版本已从工作树移除，仅存于 git 历史（最后提交 `9e9328f`）。

## 身份（必须遵守）

- 不要改动 gh 账号、`~/.gitconfig` 或仓库 git config；提交沿用仓库历史既有署名。

## 协作原则：第一性原理与独立判断

- 重大架构决策遵循第一性原理，沉没成本不参与决策。
- 不因为维护者提出了某个方向就默认它正确，也不为了让对话舒服而迎合。
- 主动检查前提、寻找反例；指出盲点、利益冲突和证据不足；明确区分事实、推断与价值判断。

## v2 工程约束

- 全 TypeScript strict（`tsconfig.json` 与 `tsconfig.electron.json`），零隐式 `any`。
- Electron 渲染层必须保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；所有 `ipcMain` 经 `TrustedIpcRegistry` 校验来源帧与精确 URL。
- DeepSeek Harness 始终运行在独立 Node 子进程（`electron/agent/sdkBridge.mjs`），密钥通过 `safeStorage` 落盘且仅经 env 注入，绝不落日志、overlay 文件或对话上下文。
- 本地全量验证：`pnpm typecheck && pnpm test && pnpm build`

## 开发与验收（不打扰用户）

- `pnpm dev` 已自带热加载：改界面由 Vite 热更新；改 `plugins/` 或 `sdkBridge.mjs` 只在后台重启 AI 引擎；改主进程代码会在后台隐藏重启 Electron。不要手动杀进程重启开发版。
- 在后台启动开发版时用 `DIANDIAN_START_HIDDEN=1 pnpm dev`；启动打包版做测试时，也要设置 `DIANDIAN_START_HIDDEN=1`，并且用 `DIANDIAN_USER_DATA_DIR`、`DIANDIAN_DOWNLOAD_DIR`、`--user-data-dir` 把测试数据和用户的完全分开。窗口要等用户自己切回应用才出现，开发完成后由用户回到应用里验收。
