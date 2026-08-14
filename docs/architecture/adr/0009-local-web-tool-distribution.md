# ADR-0009: 通过终端启动 local-first Web 工具

## Status

`Accepted`

## Date

2026-08-14

## Context

`diandianreading` 已经以 Python 模块化单体实现本地 SQLite、私有 FileStore、持久 Worker、Provider Adapter、FastAPI HTTP/SSE 与 React/Vite UI。`diandian serve` 可以在 `127.0.0.1:3000` 启动同源 Web 产品，并把数据保存在稳定的 `~/.diandianreading/` App Home。

ADR-0006 曾选择 Tauri 2 + Python Sidecar 作为长期 desktop-first 交付形态。D1/D2 已证明 Sidecar 与未签名 Tauri 壳可构建，但继续交付签名、公证、Updater、Windows Bundle 和原生生命周期会引入与核心产品价值无直接关系的 Rust、平台 SDK、浏览器分发和发布维护成本。维护者已决定不再继续原生桌面轨，而采用类似 DeepSeek Harness 的使用体验：用户在终端运行一个包管理器命令，启动只监听回环地址的本地 Web UI。

该变化只调整**分发与启动形态**，不改变 local-first 数据所有权、Python 业务核心、React UI、SQLite、Provider Credential 隔离、持久任务或 Obsidian 本地导出。

## Threat model

本决策继续保护：

- 本地书籍、标注、笔记、内容草稿、SQLite 与对象文件；
- Install Token、Browser Session、CSRF Token、Bootstrap Nonce 和 Provider Credential；
- Provider 远程操作及其持久 Intent/reconciliation；
- 用户主动下载并执行的 Python 包与 Playwright Chromium。

主要威胁：

- 恶意网页、DNS rebinding 或同机普通进程调用回环 API；
- 用户误把本地服务暴露到 LAN/公网；
- 未知进程占用固定端口并伪造 `/healthz`；
- Bootstrap Secret 出现在命令行、日志、Shell 历史或普通输出；
- uvx/tool 环境重建导致用户误以为数据被删除；
- Chromium 静默下载、版本漂移、路径逃逸或依赖开发机缓存；
- 被篡改的 Python 包、Git 分支或发布凭据导致本机代码执行。

不覆盖已取得当前操作系统用户权限并可读取 App Home 或注入进程的恶意软件。公共云、多用户远程访问、反向代理与 LAN 部署不在本决策范围内。

## Decision

### 1. 产品形态

- 正式产品采用 **single-user、local-first Web tool**。
- 用户通过 uv/uvx 或持久 tool install 在终端启动本地进程，浏览器承载产品 UI。
- 目标命令为 `uvx diandianreading web`；持久安装为 `uv tool install diandianreading` 后运行 `diandianreading web`。
- `diandian` 旧 console script 与 `serve` 命令在兼容窗口内保留。
- 不继续 Tauri、Electron、`.app`/`.dmg`、Windows native bundle、代码签名、公证或应用内 Updater。

### 2. Runtime 边界

- 一个 Python 进程拥有 FastAPI、同源 React 静态资源、HTTP/SSE、embedded Worker、SQLite、FileStore 和 Provider Client 生命周期。
- 固定绑定 `127.0.0.1:3000`，规范 Origin 为 `http://localhost:3000`。
- 不支持 `0.0.0.0`、LAN、远程代理、公共部署或任意 `--host`。
- Worker 不监听独立端口；普通用户不需要第二个终端。
- 端口被未知进程占用时 fail closed：不换端口、不附着、不终止对方。

### 3. 数据与工具环境

- 默认 App Home 保持 `~/.diandianreading/`，可通过显式 `--home` 覆盖。
- uvx/tool 隔离环境可删除和重建；用户数据、Credential、浏览器资源和备份不进入工具环境。
- 启动目录不作为默认数据目录。
- 现有 Schema、对象与 Provider mapping 原地兼容，不因分发调整新增数据迁移。

### 4. 浏览器与 Session

- 沿用 ADR-0005 的 Peer、Host、Install Token、Session、Bootstrap、Origin、CSRF、SSE 与资源限制。
- 默认在服务 readiness 后创建短时单次 Bootstrap Nonce，并通过 URL Fragment 自动打开系统浏览器。
- 普通输出只显示规范 Origin，不显示 Bootstrap Secret。
- 已运行服务的重新打开必须由读取私有 Install Token 的本机 CLI 经过认证后签发新 Nonce；`/healthz` 不能证明实例身份。

### 5. Playwright Provisioning

- Chromium 不进入基础 wheel，也不在首次 `web` 启动时静默下载。
- `setup notebooklm` 经显式确认把固定 revision 下载到 App Home 下的版本化私有目录，写 manifest 并验证 executable confinement。
- `doctor` 提供脱敏的 missing/corrupt/version-mismatch/permission/disk-space 诊断。
- 不依赖开发机 Playwright Cache，不把 PATH 上任意浏览器当成已验证 Runtime。

### 6. 分发与更新

- Python wheel 必须包含 migrations 与 React production assets，但不得包含用户数据、Credential 或 Chromium。
- 正式版本从不可变 tag 构建，通过 PyPI/GitHub Release 分发；从 GitHub 运行时文档必须固定 tag 或 commit。
- 更新由 `uv tool upgrade` 或重新执行固定版本的 uvx 命令完成；应用不自行下载并执行更新。
- 公开 PyPI Stable 前必须明确 License、包名、支持矩阵和发布凭据边界。

### 7. 桌面轨退场

- ADR-0006 被本 ADR 替代。
- React/Vite D3 成果保留为 Web UI 基线。
- D1 中浏览器 manifest、路径封闭与资源校验先迁移到 setup/doctor，再删除 Sidecar-only 构建代码。
- Tauri/Rust/macOS CI、Sidecar control protocol 与 PyInstaller desktop artifact 在替代能力通过后移除。

## Security and privacy

- ADR-0003 与 ADR-0005 继续完整适用；停止桌面壳不降低本地 API 认证要求。
- 默认无 CORS、无 trusted proxy、无 WebSocket、无远程 Origin。
- CLI 和启动日志不记录 Token、Nonce、Cookie、正文、账号或 Provider 内部 ID。
- Python 包安装不执行浏览器下载或 App Home 初始化脚本；网络和文件副作用只在用户执行明确命令后发生。
- PyPI 发布优先使用 Trusted Publishing/OIDC；长期发布 Token 不进入普通 CI、Cache 或 Artifact。
- Z-Library 保持默认关闭和显式权利确认。

## Operational rollback and recovery

- 分发迁移不改变 Schema；新入口失败时，兼容期内可回到 `diandian serve` 打开同一 App Home。
- L3 删除桌面代码前保留可复用 Provisioning，并要求 installed-process E2E 通过。
- 工具升级失败不得初始化空 App Home、删除旧数据库或清理 Provider 远程资源。
- Schema 不兼容时拒绝旧版打开；通过备份或前向修复恢复，不 blind downgrade。
- Chromium setup 中断只清理 staging，不覆盖上一个完整版本。

## Consequences

### Positive

- 最大化复用已实现的 Python/FastAPI/React 产品核心。
- 用户只需一个终端命令，不需要 Node、Rust、Tauri 或平台构建工具。
- 删除签名、公证、Updater、系统 WebView 和多平台 native bundle 的长期成本。
- source、wheel、uvx 与自动化使用同一 Runtime，减少环境差异。

### Negative

- 用户仍需理解终端与 uv，普通非技术用户的首次体验弱于签名原生应用。
- 没有原生窗口、系统托盘、应用内更新和原生文件选择能力。
- Playwright Chromium 仍是大体积运行依赖，需要独立 setup。
- 固定 localhost 服务继续暴露回环 API 威胁，必须维护 ADR-0005。

### Follow-up

- 按 [本地 Web 工具分发实施计划](../local-web-distribution-plan.md) 完成 L0–L5。
- 建立 `diandianreading web/setup/doctor/open`。
- 增加 installed-wheel 真实进程 E2E。
- 迁移 Browser Provisioning 后删除桌面专属代码与 CI。
- 完成 License/PyPI Gate 和 clean-machine 手工验收。

## Alternatives considered

### 继续 Tauri 2 桌面轨

拒绝。它改善原生安装体验，但签名、公证、Updater、Sidecar、系统 WebView、Rust 与多平台 Bundle 的持续成本超过当前个人优先阶段的证据收益。

### 纯前端 PWA

拒绝。浏览器不能替代 Python 文档处理、SQLite、持久 Worker、Provider Playwright Session 与受控 Obsidian 文件写入。

### 公共云 Web/SaaS

拒绝。它要求多用户身份、租户隔离、云数据库、对象存储、队列与 Credential Vault，会推翻 local-first 单用户边界。

### standalone PyInstaller Web Server

不作为首选。它可能减少 uv 前置，但会重新引入跨平台二进制构建、浏览器资源与签名维护。只有 clean-machine 证据表明 uv 是主要采用障碍时再评估。

## Validation

本决策已有基础证据：

- `diandian serve` 已在 `127.0.0.1:3000` 提供同源 React UI、API、SSE 与 embedded Worker；
- installed-wheel E2E 已验证 migrations 与静态资源进入 wheel；
- ADR-0005 的本地 API 安全边界有 unit/integration/E2E 覆盖；
- Python strict mypy、Ruff、pytest 覆盖率门与 React build/test 已通过。

完整分发验证按实施计划 Definition of Done：

- clean machine 仅准备 uv 后运行已发布的 `uvx diandianreading web`；
- readiness、Bootstrap、真实 Uvicorn、SIGINT/SIGTERM 与 Worker 关闭进程 E2E；
- setup/doctor 的中断、损坏、路径逃逸和版本漂移测试；
- 工具环境重建/升级不影响 App Home；
- 未知端口进程、错误 Host/Origin、无认证 reopen 全部 fail closed；
- 真实浏览器、NotebookLM 与 Obsidian 由维护者在自己的 Mac 上手工验收。

## Related

- [本地 Web 工具分发实施计划](../local-web-distribution-plan.md)
- [ADR-0001](0001-local-first-modular-monolith.md)
- [ADR-0003](0003-provider-credential-isolation.md)
- [ADR-0004](0004-durable-import-saga.md)
- [ADR-0005](0005-local-api-security.md)
- [ADR-0006](0006-desktop-first-tauri-python-sidecar.md)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [uv tools guide](https://docs.astral.sh/uv/guides/tools/)
