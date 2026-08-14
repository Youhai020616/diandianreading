# Phase 5 统一产品 E2E / Unified Product E2E

> 状态：Active
>
> 最后更新：2026-08-03
>
> 本阶段不启动真实浏览器、不访问 Z-Library/NotebookLM、不读取真实账号凭据，也不执行 live-provider smoke。真实页面与登录流程由用户后续手工验证。

## 1. 目标 / Goal

Phase 5 把前四个阶段的独立能力组合成一个可安装、可恢复、local-first 的产品入口：

```text
single-use browser bootstrap
→ authenticated Session + CSRF
→ bounded raw local import
→ durable import_source.v2 Job
→ Worker + NotebookLM Knowledge Port
→ ready local Book
→ durable whole-book Conversation/ChatRun
→ grounded answer + local citation
→ reconnectable Job/Chat SSE
```

同一 composition root 也提供独立 NotebookLM/Z-Library Session 管理、CLI、静态 Web UI 和安全本地 API。Z-Library 仍是默认关闭的可选 Adapter，不与 NotebookLM 共享凭据，也不在 HTTP 提交阶段访问 Provider。

## 2. 已实现产品入口 / Implemented Entrypoints

### 2.1 统一 CLI

真实交互登录需要显式安装浏览器 extras；基础 wheel 与默认 CI 不安装浏览器：

```bash
uv sync --extra notebooklm-login --extra zlibrary
uv run playwright install chromium
```

```text
diandian auth login notebooklm [--profile default]
diandian auth login zlibrary [--profile default]
diandian auth status
diandian auth logout <provider> [--profile default]

diandian import <local-path> --rights-basis <basis> --rights-confirmed
diandian import <url> --provider zlibrary --enable-zlibrary --title <title> ...

diandian jobs list [--status <status>] [--limit 50]
diandian jobs retry <job-id>

diandian worker [--once]
diandianreading web [--no-open] [--enable-zlibrary] [--json]
diandian serve [--no-open] [--enable-zlibrary]  # compatibility alias
```

全局 Home 覆盖必须位于子命令之前：

```bash
diandian --home /private/app-home auth status
```

`diandianreading web` 固定绑定 `127.0.0.1:3000`，规范浏览器 Origin 为 `http://localhost:3000`。如果端口已占用，它会拒绝启动第二个实例；L1 起 installed-wheel CI 会启动真实 Uvicorn 进程并验证 readiness、静态资源与 SIGTERM。旧 `diandian serve` 保持兼容。

### 2.2 应用私有目录

```text
~/.diandianreading/
├── state/app.sqlite3
├── objects/
├── credentials/
│   ├── local-api/
│   ├── notebooklm/
│   └── zlibrary/
├── staging/
└── uploads/
```

业务数据库和 API 只保存/返回逻辑 ID、`StorageKey`、安全展示名和逻辑 Provider Profile。Install Token、Cookie、Provider 内部 ID、凭据文件路径和上传临时物理路径不进入普通响应。

### 2.3 Web/API

主路由：

```text
GET    /healthz
GET    / + /static/app.css + /static/app.js
POST   /api/session/bootstrap
GET    /api/session
POST   /api/session/logout
GET    /api/auth/status
POST   /api/imports
GET    /api/jobs[/{id}]
POST   /api/jobs/{id}/retry
GET    /api/jobs/{id}/events
GET    /api/books
GET    /api/books/{id}/conversation
PUT    /api/books/{id}/conversation
GET    /api/conversations/{id}/messages
POST   /api/conversations/{id}/messages
GET    /api/chat-runs/{id}
POST   /api/chat-runs/{id}/cancel
POST   /api/chat-runs/{id}/retry
GET    /api/chat-runs/{id}/events
```

API docs/OpenAPI、CORS 和 WebSocket 均关闭。Phase 5 只提供 durable SSE，不提供逐 Token Streaming。

## 3. ADR-0005 安全边界 / Security Boundary

自动化覆盖：

- 实际 TCP Peer 与精确 Host allowlist；非回环、DNS-rebinding Host 和重复 Host fail closed；
- 所有 `Forwarded`/`X-Forwarded-*` Header 拒绝，Uvicorn `proxy_headers=False`；
- 每安装实例 Bearer Token；短时、单次 Bootstrap Nonce；服务端 Session；双提交 CSRF；
- Cookie 与 Bearer 混搭、重复 Cookie/Authorization/Origin、安全 Cookie 重复均拒绝；
- exact Origin、same-origin fetch evidence、跨 Origin 和 CORS Preflight 拒绝；
- Header 数量/字节、request target、JSON、raw upload、Bootstrap/mutation 速率与 SSE 连接/时长上限；
- `Content-Length` 预检加 raw body 流式硬上限；失败和成功后都清理随机 upload 临时文件；
- Session/Token 轮换与 logout 撤销；SSE 重连和持续连接重新检查 Session；
- 严格 CSP、安全响应 Header、无 inline JS/CSS、无 CDN、无 `innerHTML`；
- 关闭访问日志、Server Header、交互式异常页、OpenAPI 与 WebSocket（`ws="none"`）。

`/healthz` 是唯一无需认证的最小 liveness，只返回 `{"status":"ok"}`。

## 4. Durable Import 与 Worker

本地 HTTP 上传不接受客户端文件路径，而是接收 raw bytes 与安全 basename。API 在请求生命周期内把内容捕获到私有对象存储，再持久化 `import_source.v2` payload；payload 不包含原始 Path、随机 upload 名或应用 Home。

Z-Library JSON 提交只执行：

```text
feature gate
→ rights/attestation validation
→ canonical URL/reference
→ durable Job/payload
```

它不会在 `POST /api/imports` 中下载。Worker 才会使用独立 Z-Library Session/Network/Downloader Adapter；完成 Acquisition/Preparation 后，再调用独立 NotebookLM Knowledge Adapter。

`WorkerRunner` 同时轮询 Import Job 与 ChatRun：

- `run_once()` 每类最多领取一个工作项（最多一个 Import Job 加一个 ChatRun）；
- `run_forever()` 使用有限 poll interval 和显式 stop event；
- Import 与 Chat 都使用 SQLite lease/generation fencing；
- 进程生命周期关闭时显式 `aclose()` NotebookLM clients。

## 5. Whole-book AI Chat

Phase 5 当前只接受：

```json
{"type":"book"}
```

已实现：

- 每本 Book 一个活跃 Conversation；
- user/assistant placeholder 成对事务写入；
- `(conversation_id, client_message_id)` 幂等；
- 每个 Conversation 最多一个 queued/running ChatRun；
- Provider attempt 在 dispatch 前持久化；
- Lease heartbeat/takeover/fencing、显式取消/重试与模糊结果拒绝盲重试；
- 完整回答、`effective_scope`、本地 Reference 与终态 Event 原子持久化；
- Provider Source/Conversation ID 不进入普通 Chat API/SSE。

`chapters`、`notes`、`selection`、保存为 Note、内容生成、Conversation archive/delete/reset 仍为 Proposed，不在 Phase 5 验收范围。

## 6. 本地 E2E / Local E2E

```bash
uv run --locked diandian phase5-e2e \
  --app-home .tmp/phase5/app-home \
  --workspace .tmp/phase5/workspace
```

两个路径必须彼此分离且尚不存在。命令使用 Fake Knowledge/Z-Library 边界和 FastAPI `TestClient`，不会启动真实 Uvicorn、浏览器或网络请求。

验证步骤：

1. 从 wheel/package resources 提供 `index.html`、`app.css` 和 `app.js`；
2. 生成并消费一次性 Bootstrap Nonce，建立 Session + CSRF；
3. raw Markdown 上传并创建 durable Job；
4. Worker 完成导入，Job 关联 ready Book；
5. 创建 whole-book Conversation 并幂等提交问题；
6. Worker 完成 ChatRun，返回 grounded answer 和本地 citation；
7. Job/Chat SSE 包含终态事件；
8. 跨 Origin 请求被拒绝；
9. Provider status 只返回安全逻辑状态。

成功输出：

```json
{
  "book_count": 1,
  "chat_sse_verified": true,
  "chat_status": "completed",
  "citation_count": 1,
  "cross_origin_rejected": true,
  "job_sse_verified": true,
  "job_status": "completed",
  "provider_status_verified": true,
  "schema_version": 6,
  "session_bootstrap_verified": true,
  "status": "ok"
}
```

重复使用任一路径返回结构化 validation error，不覆盖已有数据。

## 7. Installed-wheel E2E

构建后在隔离环境安装 wheel，并运行 Phase 0–5：

```bash
uv build --no-build-isolation
uv venv --python 3.12 .tmp/wheel-venv
uv pip install \
  --python .tmp/wheel-venv/bin/python \
  ./dist/diandianreading-0.1.0-py3-none-any.whl

.tmp/wheel-venv/bin/diandian phase5-e2e \
  --app-home .tmp/wheel/phase5/app-home \
  --workspace .tmp/wheel/phase5/workspace
```

Phase 5 E2E 会读取静态路由并执行 schema v6 migration，因此缺失以下 wheel resources 会直接失败：

```text
diandianreading/interfaces/web/static/index.html
diandianreading/interfaces/web/static/app.css
diandianreading/interfaces/web/static/app.js
diandianreading/infrastructure/persistence/migrations/0006_unified_product.sql
```

GitHub `quality` Job 运行同一 installed-wheel Phase 5 命令；Python 3.11/3.12/3.14 matrix 运行完整 pytest。

## 8. 本地质量门禁 / Quality Gate

```bash
uv lock --check
uv run --locked ruff format --check src tests
uv run --locked ruff check src tests
uv run --locked mypy src/diandianreading
uv run --locked pytest
node --check src/diandianreading/interfaces/web/static/app.js
uv build --no-build-isolation
```

当前本地证据：

- `uv lock --check`：通过；
- Ruff format/lint：通过；
- strict mypy：78 个 source files，0 errors；
- Python 3.11.13：`680 passed`，branch coverage `90.30%`，无 warning；
- Python 3.12.11：`680 passed`，branch coverage `90.32%`，无 warning；
- Python 3.14.2：`680 passed`，branch coverage `90.32%`，无 warning；
- `node --check`：通过；
- sdist/wheel build：通过；
- 隔离安装 wheel 后，静态资源与 `0006_unified_product.sql` resource 检查通过；
- installed-wheel Phase 0–5 CLI E2E：全部返回 `status: ok`。

GitHub CI 结果只在 Phase 5 PR 创建后复核；未实际运行的远端 check 不在本文提前声明为通过。

## 9. 明确未验证 / Explicitly Not Verified

- 未启动真实 Playwright/Chromium；
- 未访问 `z-library.sk` 或验证 live DOM selector；
- 未使用真实 Z-Library Cookie/Profile 或执行真实下载；
- 未使用真实 Google/NotebookLM Cookie、Notebook、Source 或 Chat；
- 未进行真实浏览器响应式、键盘、焦点、读屏或视觉走查；
- 未验证 chapters/notes/selection Chat、保存为 Note 或内容生成 UI；
- 未把 Fake/contract 结果包装成真实 Provider 可用性结论。

因此 Phase 5 的结论是“统一产品代码、安全边界、durable workflow 与离线安装包契约通过”，不是“当前真实 Provider 页面和浏览器体验已经通过”。
