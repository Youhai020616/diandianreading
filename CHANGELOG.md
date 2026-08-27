# Changelog

本文件记录 `diandianreading` 面向用户和运维者的重要变化。项目尚未创建公开 release 或 immutable tag；以下内容属于计划中的 `0.1.0` Alpha。

## [Unreleased]

### Added

- `diandianreading web` 本地 Web 入口：单进程管理 FastAPI、React 静态资源、持久 Worker、SQLite 与 Provider Adapter。
- readiness 后自动打开浏览器；支持 `--no-open` 和脱敏 `--json` 启动记录。
- `diandianreading setup notebooklm`：将固定 Playwright Chromium revision 显式安装到 App Home，验证 manifest、SHA-256 与 executable confinement。
- `diandianreading doctor`：被动诊断 App Home、SQLite、静态资源、3000 端口、Install Token、NotebookLM Profile、Chromium 和 Z-Library 默认状态。
- `diandianreading open`：用私有 Install Token 向运行实例申请一次性 Bootstrap Nonce，不在普通输出中暴露 Secret。
- installed-wheel 真实 Uvicorn、静态资源、安全 reopen 与 SIGTERM smoke。
- Markdown/EPUB/PDF 导入与阅读、进度、标注、再锚定和引用定位。
- NotebookLM 整书/选区/笔记范围 Chat，KnowledgeNote、可恢复内容生成、修订作者归属与 React 创作工作台。
- Obsidian 稳定 ID 增量导出、重命名对账和手工编辑冲突保护。

### Changed

- 产品分发方向由 Tauri desktop-first 改为 uv/uvx 启动的 local-first Web 工具（ADR-0009）。
- Playwright Python 支持进入基础发行依赖；Chromium 二进制仍不进入 wheel，也不在安装时下载。
- App Home 固定为 `~/.diandianreading/`，独立于 uvx/tool 环境与工作目录。

### Security

- 保留 Install Token、Browser Session、CSRF、Peer/Host/Origin、Bootstrap Nonce、SSE 与资源限额边界。
- Install Token 丢失后生成新 Token，并以 `security_recovery` 撤销旧 Browser Session、消费未使用 Nonce；损坏或不安全 Token 不静默重建。
- Obsidian 导出拒绝路径逃逸和符号链接边界，不静默覆盖用户手工修改。

### Removed

- Tauri/Rust desktop shell、launcher-core 与 macOS `.app` CI。
- PyInstaller Sidecar、`diandian-desktop-sidecar` 入口和 desktop-only dependencies。
- Tauri 签名、公证、Updater 与 Windows native bundle 路线。
- 旧静态 HTML 原型 `ai-reading-ecosystem-demo/`；视觉方向已由 `apps/web/` 的 React UI 承接。
