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
- **pdfjs-dist（R3 唯一新增运行时依赖）**：本地打包渲染 PDF（ADR-0007 §1：PDF 渲染原始
  字节）。主库经动态 import 独立成 chunk，worker 以 `?url` 资产随构建发布，均为同源静态
  文件，无 CDN。markdown 渲染器为自研（见下文"R3 阅读器"），不引入任何渲染/消毒依赖。

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

- `index.html` 注入 CSP `<meta>`（内容见 `vite.config.ts` 的 `CSP_META`）。R3 之前它与旧
  `static/index.html` 逐字相同；R3 为 PDF.js 做了两处**最小放宽**，逐项理由见下节
  "CSP changes for R3"；
- 资产以相对路径（`base: "./"`）引用，可被 FastAPI 从任意挂载点同源托管；
- 无远程 CDN / 字体 / 脚本，无 inline script/style，无 `eval` / `new Function`、无
  `wasm-unsafe-eval`（pdf.js 以 `useWasm: false` 运行）。R3 起 pdfjs 主库为动态 import
  的独立 chunk；目标为 ES2022 原生 dynamic import，module preload polyfill 仍不需要
  （只影响预加载优化，不影响正确性）。

### CSP changes for R3（相对旧 meta 的精确 delta）

| 指令 | 旧值 | 新值 | 理由 |
| --- | --- | --- | --- |
| `worker-src` | `'none'` | `'self'` | pdf.js 在专用 Worker 中解析渲染 PDF；worker 脚本是构建产物中的同源静态资产（`assets/pdf.worker.min-*.mjs`）。仍禁止 `blob:`/`data:` worker。 |
| `trusted-types` | `'none'` | `pdfjs-worker` | `require-trusted-types-for 'script'` 下 `new Worker(url)` 需要 TrustedScriptURL。`src/lib/pdf.ts` 注册**唯一**具名 policy，且只接受打包的 worker 资产 URL，其余输入抛错。强制项 `require-trusted-types-for 'script'` 不变。 |

未放宽项（显式决定，非遗漏）：

- `img-src 'self'` 不加 `blob:`：本实现只做 canvas 逐页渲染（无 viewer 缩略图/图片
  sink），未触达 blob: 图片 URL。若维护者真机验收发现特定 PDF 需要，再以负向测试为
  前提补充 `img-src 'self' blob:`。
- `font-src 'none'` 不变：内嵌字体经 `FontFace(ArrayBuffer)` 加载，不产生 font-src
  URL 拉取。
- 不加 `wasm-unsafe-eval`：以 `useWasm: false` 关闭 pdf.js 的 WebAssembly 解码路径。
  代价：依赖 JPX（JPEG2000）/ICC wasm 解码器的图片可能缺失，见"PDF 能力边界"。
- `frame-src 'none'`、无 inline、无远程、无 `unsafe-eval` 全部保持（ADR-0007 §6）。

**运行时降级**：若真实浏览器中 Worker/Trusted Types 初始化仍失败（例如宿主注入了更严
policy），PDF 视图自动降级为"下载 / 外部打开"提示（`PdfReaderView` fallback 分支），
不会为此偷偷放宽 CSP。

**React 19 与 Trusted Types 兼容性结论**：兼容。
`react-dom` 产物中唯一的 Trusted Types 敏感 sink 是 `innerHTML` 赋值，仅在
(1) `dangerouslySetInnerHTML` 或 (2) 渲染原生 `<script>` 元素这两条路径触发；
本应用两者皆禁用/未使用（全部内容经 React 文本节点渲染，等价旧代码的
`textContent`，R3 阅读器渲染书籍正文同样只走文本节点），运行时不会触达该
sink。R3 起 `trusted-types` 从 `'none'` 改为具名 `pdfjs-worker`（仅用于 Worker
构造，见上表）；React 本身仍不需要任何 policy。若未来引入
`dangerouslySetInnerHTML` 或第三方在运行时写 `innerHTML`，需另行声明并评审新的
具名 policy——当前不需要。

## 结构

```text
apps/web/
├── index.html            # Vite 入口（CSP meta 在 build 时注入）
├── vite.config.ts        # base ./、CSP 注入插件、vitest 配置、dev 代理
├── vitest.setup.ts       # jsdom matchMedia / EventSource / scrollIntoView / canvas 桩
└── src/
    ├── main.tsx          # 启动：先取 URL fragment nonce（一次性），再挂载 React
    ├── App.tsx           # 壳层：topbar / nav / 离线横幅 / 视图 / chat 面板 / aria-live
    ├── app.css           # static/app.css + R3 阅读器样式（文件尾部追加段）
    ├── lib/              # api client、bootstrap、错误映射、归一化、文案（纯函数）
    │   ├── pdf.ts        # pdfjs-dist 引擎封装（worker + Trusted Types policy）
    │   └── reader/       # R3 纯逻辑：offsets / markdown / highlights / selection / model / api
    ├── state/            # Store + AppController（app.js 1:1）+ ReaderController（R3）
    ├── components/       # Connections / Import / Jobs / ChatPanel / MessageLog
    │   └── reader/       # Library / Reader / MarkdownContent / 侧栏 / 工具条 / PDF 视图
    └── test/             # fetch mock 与 FakeEventSource 测试工具
```

## R3 阅读器 / Reader

### 偏移保真的 markdown 渲染（划线正确性的根）

- `lib/reader/markdown.ts` 是**自研 markdown 子集解析器**（标题/段落/扁平列表/引用/
  围栏代码块/行内代码/粗斜体/链接），不引入渲染依赖、绝不使用
  `dangerouslySetInnerHTML`；书籍内嵌 HTML 一律按字面文本渲染（等价转义）。
- 每个产生文本的节点记录源文档的 UTF-16 区间，且**渲染文本 = 源码切片逐字相同**；
  标记符（`#`、`**`、围栏、链接括号等）落在区间空隙里、不进入 DOM 文本。
- 块级元素携带 `data-start`/`data-end`（**码点**偏移，即 ADR-0007 anchor 契约的
  `[start, end)` 语义，与 Python 端一致）；每个文本叶子的包裹元素携带 `data-su`
  （UTF-16 源偏移，映射实现细节）。`lib/reader/offsets.ts` 的 `OffsetMap` 负责
  码点 ↔ UTF-16 双向换算（代理对二分）。
- DOM Selection → 源区间由 `lib/reader/selection.ts` 完成：文本节点内偏移 + `data-su`
  即精确源位置；quote 的 prefix/suffix 按**码点**截取 ≤64。往返正确性由
  `markdown.test.ts`（解析不变量）与 `selectionMap.test.tsx`（渲染 DOM ↔ Range 往返）
  锁定。
- 链接渲染为纯文本 span，URL 经 `data-url` 由 CSS `::after` 展示——URL 不进入可选中
  文本，也不存在可导航元素。
- 划线以 `<mark>` 分段渲染（`lib/reader/highlights.ts`）：重叠区间由**后创建**的划线
  占据视觉层级；点击 mark 激活侧栏对应标注。

### 进度与 409

- 滚动/翻页去抖 **5s**（`PROGRESS_DEBOUNCE_MS`）后 `PUT /api/books/{id}/progress`；
  markdown 用可视首块的码点偏移作 caret（`start == end`），PDF 用 1 起始页码。
- 收到 409（stale anchor / 乐观锁冲突）时**静默**重取 detail（必要时整体重载正文与
  标注），用新 `anchor_sha256` 与钳制后的位置**重试一次**；再失败保持静默（进度是
  尽力而为，不打断阅读）。
- 正文获取带显式 `If-None-Match` 再验证：内存缓存按书保存 `{etag, text}`，304 复用
  缓存（`fetch` 本身 `cache: no-store`，避免浏览器隐式缓存干扰契约测试）。

### PDF 能力边界（如实记录）

- 渲染：canvas 逐页渲染 + pdf.js `TextLayer` 文本层；文本层可用时选区可直接生成
  `pdf_page` 页级划线（quote.exact = 选区文本）；文本层不可用（扫描件等）时降级为
  **页 + 手输引述**创建划线。`pdf_page` 锚点只有页级精度（ADR-0007 已知负面）。
- 未配置 `cMapUrl` / `standardFontDataUrl` / wasm：依赖外置 CMap 的老式 CJK 编码
  PDF 文本层可能缺字，Base-14 非嵌入字体退化渲染，JPX/ICC 图片可能缺失。这些是
  "不再放宽 CSP/不增打包体积"的显式取舍，待真实样本验收后再议。
- 引擎初始化失败（Worker/Trusted Types 被宿主环境拒绝）→ 视图降级为下载提示。

行为契约（bootstrap、CSRF、错误码映射、SSE 断线走持久快照轮询、幂等提交、
IME composition 下 Enter 不发送、tabs/dialog/log 等 aria 语义、移动端历史栈
返回关闭对话等）均按 `static/app.js` 逐段移植；SSE 使用原生 `EventSource`，
出错时不销毁连接对象，保留浏览器自动带 `Last-Event-ID` 重连的续传语义
（服务端事件含 `id:`，见 `app.py` `_sse_event` / `_last_event_id`）。

## 与 FastAPI 的集成（由后续集成单元执行）

1. 将 `pnpm build` 的 `dist/` 拷入 Python 包（例如
   `src/diandianreading/interfaces/web/static/`），`/` 返回 `dist/index.html`，
   `./assets/*` 以正确的 MIME 同源托管（当前 app.py 是逐文件路由，需改为
   托管 `assets/` 目录或枚举构建产物）。R3 起 `assets/` 含多个 JS chunk 与
   `pdf.worker.min-*.mjs`（约 1.2 MB），`.mjs` 必须以 `text/javascript` 托管。
2. 删除旧 `static/app.js`、`app.css` 与旧 `index.html`（被 dist 取代）。
3. **服务端 CSP header（`app.py` `_CSP`，串行区，须由集成单元修改）**。现状分析：
   header 未声明 `worker-src`，按 CSP 回退链 `worker-src → child-src → script-src`
   落到已有的 `script-src 'self'`，因此同源 worker 脚本在 header 层面**当前已被允许**，
   PDF Worker 不会被 header 挡住；Trusted Types 指令只存在于 `<meta>`，header 无需
   镜像。但为了让 worker 策略显式、不再依赖回退链（防止未来改动 `script-src` 时
   误伤），建议同步以下精确 diff：

   ```diff
    _CSP = "; ".join(
        (
            "default-src 'none'",
            "script-src 'self'",
            "style-src 'self'",
            "img-src 'self'",
            "font-src 'self'",
            "connect-src 'self'",
   +        "worker-src 'self'",
            "base-uri 'none'",
            "form-action 'self'",
            "frame-ancestors 'none'",
            "object-src 'none'",
        )
    )
   ```

   注意：header **绝不能**声明 `worker-src 'none'`（多重 policy 取交集，会直接禁用
   PDF 渲染）。worker 脚本响应自身携带的 `_CSP` 会成为 worker 全局作用域的 policy；
   本实现的 worker 不发起 fetch、不用 eval/wasm（`useWorkerFetch: false`、
   `useWasm: false`），在 `default-src 'none'` 下可正常工作。该变更应进入 D4 的
   CSP 负向测试范围（ADR-0007 §6：每项放宽必须有对应负向测试）。
