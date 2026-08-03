# diandianreading web UI (`apps/web`)

React + TypeScript + Vite 版本的本地工作区 UI，等价迁移自
`src/diandianreading/interfaces/web/static/{index.html,app.js,app.css}`（D3 阶段，
见 `docs/architecture/desktop-application-plan.md` §14 D3 与 ADR-0006 §2）。

HTTP/SSE 契约一字未改：接口事实以 `src/diandianreading/interfaces/web/app.py`
与 `serializers.py` 为准。UI 仍是同源单页应用，凭 cookie 会话 + CSRF
double-submit 调用 `/api/*`，用原生 `EventSource` 订阅 Jobs / Chat Run 事件流。

## 工具链决策

- **包管理器：pnpm**。理由：本机已可用（pnpm 10，随 Node 24 的 corepack 亦可复现）；
  单一锁文件 `pnpm-lock.yaml`（仓库规定不得同时维护多个前端锁文件，见 desktop plan §6）；
  原生 workspace 支持，后续 `apps/desktop`（Tauri）可直接并入同一 workspace 而不换工具。
  版本钉在 `package.json#packageManager`。
- **Node 24**：`.nvmrc` 与 `package.json#engines` 记录（本机 v24.18.0）。
- **TypeScript strict**（`~5.9`，`tsc --noEmit` 为构建门槛）；Vite 8 + @vitejs/plugin-react 6；
  vitest 4 + @testing-library/react 16。

## 常用命令

```bash
pnpm install        # 安装依赖（node_modules 不入库）
pnpm dev            # Vite dev server（/api 代理到 127.0.0.1:3000，见下方限制）
pnpm build          # tsc --noEmit && vite build → dist/（纯静态、相对路径）
pnpm test           # vitest run（jsdom）
pnpm typecheck      # 仅类型检查
```

Dev server 限制：Python 侧边界（ADR-0005）校验 Origin/Host，跨端口开发时
mutating 请求可能被拒；完整验证请以 `pnpm build` 产物由 FastAPI 同源托管进行。
生产 CSP 不允许 dev 模式所需的 inline preamble，因此 CSP `<meta>` 只在 build 时注入。

## 构建产物与 CSP / Trusted Types

`pnpm build` 产出 `dist/`：

- `index.html` 注入与旧 `static/index.html` **逐字相同**的 CSP `<meta>`
  （含 `script-src 'self'`、`style-src 'self'`、`trusted-types 'none'`、
  `require-trusted-types-for 'script'`）；
- 资产以相对路径（`base: "./"`）引用，可被 FastAPI 从任意挂载点同源托管；
- 无远程 CDN / 字体 / 脚本，无 inline script/style，无 `eval` / `new Function`，
  未启用 module preload polyfill（单一入口、无动态 import）。

**React 19 与 Trusted Types 兼容性结论**：兼容，无需调整现有 CSP。
`react-dom` 产物中唯一的 Trusted Types 敏感 sink 是 `innerHTML` 赋值，仅在
(1) `dangerouslySetInnerHTML` 或 (2) 渲染原生 `<script>` 元素这两条路径触发；
本应用两者皆禁用/未使用（全部内容经 React 文本节点渲染，等价旧代码的
`textContent`），运行时不会触达该 sink，因此
`require-trusted-types-for 'script'` + `trusted-types 'none'` 下可正常工作。
若未来引入 `dangerouslySetInnerHTML` 或第三方在运行时写 `innerHTML`，则需要
在 CSP 中声明具名 policy（例如 `trusted-types react-html`）并接入
Trusted Types policy——当前不需要。

## 结构

```text
apps/web/
├── index.html            # Vite 入口（CSP meta 在 build 时注入）
├── vite.config.ts        # base ./、CSP 注入插件、vitest 配置、dev 代理
├── vitest.setup.ts       # jsdom matchMedia / EventSource 桩
└── src/
    ├── main.tsx          # 启动：先取 URL fragment nonce（一次性），再挂载 React
    ├── App.tsx           # 壳层：topbar / nav / 离线横幅 / 视图 / chat 面板 / aria-live
    ├── app.css           # 逐字拷贝自 static/app.css
    ├── lib/              # api client、bootstrap、错误映射、归一化、文案（纯函数）
    ├── state/            # Store（useSyncExternalStore）+ AppController（app.js 行为 1:1 移植）
    ├── components/       # Connections / Import / Jobs / ChatPanel / MessageLog
    └── test/             # fetch mock 与 FakeEventSource 测试工具
```

行为契约（bootstrap、CSRF、错误码映射、SSE 断线走持久快照轮询、幂等提交、
IME composition 下 Enter 不发送、tabs/dialog/log 等 aria 语义、移动端历史栈
返回关闭对话等）均按 `static/app.js` 逐段移植；SSE 使用原生 `EventSource`，
出错时不销毁连接对象，保留浏览器自动带 `Last-Event-ID` 重连的续传语义
（服务端事件含 `id:`，见 `app.py` `_sse_event` / `_last_event_id`）。

## 与 FastAPI 的集成（由后续集成单元执行）

1. 将 `pnpm build` 的 `dist/` 拷入 Python 包（例如
   `src/diandianreading/interfaces/web/static/`），`/` 返回 `dist/index.html`，
   `./assets/*` 以正确的 MIME 同源托管（当前 app.py 是逐文件路由，需改为
   托管 `assets/` 目录或枚举构建产物）。
2. 删除旧 `static/app.js`、`app.css` 与旧 `index.html`（被 dist 取代）。
3. 服务端 CSP header（`app.py` `_CSP`）无需修改：产物不含 inline/eval，
   `script-src 'self'`/`style-src 'self'` 即可；`<meta>` 里更严格的
   Trusted Types 指令随 `index.html` 一同交付。
