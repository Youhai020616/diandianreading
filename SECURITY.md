# Security Policy

## Supported versions

`diandianreading` v2 是一个 Electron 桌面应用，当前处于 Alpha（`2.0.0-alpha`），尚未发布稳定版本或建立长期支持窗口。

| Version | Support |
| --- | --- |
| `main`（v2 Electron 工作台） | Best-effort security fixes |
| v1 Python/FastAPI 版本（仅存在于 git 历史，最后提交 `9e9328f`） | Not supported |

## Reporting a vulnerability

请不要在公开 issue、Discussion、PR、截图或日志中披露以下内容：

- 模型服务 API Key、DeepL API Key，或 `config/model-settings.json` 的内容；
- 微信读书、豆瓣、小红书等站点的 Cookie / 登录态，Z-Library 账号或 Kindle 邮箱配置；
- 本地桥 token（`DIANDIAN_BRIDGE_TOKEN`）或 Harness 子进程的环境变量；
- 私有书籍正文、划线、想法、草稿、对话记录或 Obsidian 笔记库内容；
- 应用数据目录（`~/Library/Application Support/点点读书` 等）的归档、SQLite 数据库或可识别本机路径。

优先使用 GitHub 仓库 **Security → Report a vulnerability**（如果该入口已启用）。如果没有私密报告入口，请先通过仓库所有者的 GitHub 资料请求一个私密沟通渠道，不要在初次公开消息中附带漏洞细节或密钥。

报告应尽量包含：

1. 受影响的 commit 与操作系统、Electron 版本；
2. 不含真实个人数据的最小复现步骤；
3. 预期边界与实际行为；
4. 影响范围和已知前置条件；
5. 使用临时应用数据目录与测试账号生成的脱敏证据。

项目目前没有可公开记录的专用安全邮箱或响应 SLA，因此不能承诺固定回复时限。

## Threat model

单用户、本地优先的桌面应用，不提供 LAN 或公网服务。需要防范的是：用户打开的网页与电子书、第三方服务返回的数据、本机其他用户，以及被诱导执行危险操作的 AI 工具调用。与当前用户同权限运行的恶意程序不在防护范围内：它本来就能直接读写本机的数据库和配置文件（见下文「已知剩余风险」）。

## Security boundaries

### 渲染进程与 IPC

- 所有窗口（主窗口、宠物窗、内嵌浏览器标签页）都使用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
- 主进程的每个 `ipcMain` 处理器都经 `TrustedIpcRegistry`（`electron/security/trustedIpc.ts`）注册：只接受已登记窗口的主框架、且页面 URL 与入口地址精确匹配的请求。子框架、被导航走的页面和内嵌网页都无法调用 `window.diandian`。
- 主窗口禁止 `window.open`，并拦截离开应用页面的导航（`will-navigate`）。打包后的应用菜单不提供「重新载入」和开发者工具。
- 生产构建的主页面带 CSP：`default-src 'none'`，脚本仅允许 `'self'`。

### 内嵌浏览器

- 右侧网页运行在独立的 `WebContentsView` 中，按账号使用独立的 `persist:` 分区，不加载应用的 preload，网页拿不到应用 API。
- 只允许打开 `http(s)` 地址；新窗口请求转为受控标签页。
- AI 工具只能读取页面正文和选区，不能读取 Cookie 或密码。

### 本地电子书与外部内容

- EPUB 阅读器运行在单独的 iframe 中：章节文档不允许执行脚本（iframe sandbox 不含 `allow-scripts`），每个章节注入禁止脚本、禁止外部网络的 CSP，并在渲染前移除脚本、表单、事件属性和外部链接。
- 主进程和阅读器共用一份解压上限（`electron/router/epubLimits.ts`：文件 128 MB、条目数、单个资源与总解压大小），防止压缩炸弹。
- 渲染层传来的文件路径都限制在下载目录内（`resolveDownloadedBook` 用真实路径比对，拒绝符号链接越界）；文件夹导入有深度、条目数和单次导入数量上限。
- 封面下载只访问白名单域名，逐跳检查重定向，限制字节数与像素数后再解码。
- 卡片在 `htmlcard://` 沙盒分区中离屏渲染，禁止外部网络。
- Obsidian 导出只写入用户选择的笔记库目录（拒绝符号链接），用 frontmatter `diandian_id` 跟踪改名；检测到手工修改时写出 `.diandian-conflict.md` 冲突副本，绝不静默覆盖。导出是单向的，笔记库里的修改不会写回点点。

### AI 引擎与工具守卫

- DeepSeek Harness 始终运行在独立的 Node 子进程（`electron/agent/sdkBridge.mjs`）。模型密钥只通过环境变量注入该子进程，不写入日志、overlay 配置文件或对话上下文。
- `plugins/runtime-safety` 在 Harness 内用 `ctx.tools.guard` 拦截工具调用：底层系统工具（`bash`、`shell`、`write`、`edit` 等）在所有模式下禁用；`plan` 模式禁止写入和导航，`confirm` 模式禁止 Obsidian 外部写入。名单只有一份：`plugins/runtime-safety/tool-policy.json`，主进程的 `safetyPolicy.ts` 读取同一文件，测试会检查名单里的工具确实已注册。
- 电子书下载不是 AI 工具，只能由用户在界面上触发。

### 密钥存储

- 模型 API Key 用 Electron `safeStorage`（系统钥匙串）加密后写入 `config/model-settings.json`（目录 `0700`、文件 `0600`、原子写）。
- 钥匙串不可用时（包括 Linux 的 `basic_text` 后端），新填写的密钥只有在用户明确同意后才会以明文保存，设置界面会提前警告。
- 通过 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` 环境变量提供的密钥只在运行时使用，不会被写入磁盘。
- DeepL 密钥必须加密保存；钥匙串不可用时拒绝保存。
- 渲染层只能拿到「是否已有密钥、如何存储」这类状态，拿不到密钥本身。

### 本地桥（Harness 插件 → 主进程）

插件通过 `http://127.0.0.1:<随机端口>` 调用主进程的书库、草稿、Obsidian 和浏览器接口：

- 只监听回环地址，端口每次启动随机分配；
- 每个应用会话生成 24 字节随机 token，`Authorization: Bearer` 头用定长时间比较校验；
- 请求体上限 1 MiB；
- token 与地址通过环境变量 `DIANDIAN_BRIDGE_URL` / `DIANDIAN_BRIDGE_TOKEN` 交给 Harness 子进程。

回环地址本身不是授权，token 才是。网页无法读取子进程的环境变量，也无法伪造带 Bearer 头的跨域请求，所以网页和本机其他用户都调用不了本地桥。

**关于改用 Unix socket 或继承文件描述符的评估（issue #46）：**

- Unix socket 只靠文件权限把关，同一用户的任何进程都能连接，和「能读取子进程环境变量的同用户进程」是同一个攻击者，安全性没有实质提升。
- 继承已连接的文件描述符确实能让「只有子进程持有通道」，但插件运行在 Harness SDK 再派生出的运行时进程里，SDK 目前没有把额外文件描述符传给运行时的接口。
- 因此暂时保留「回环地址 + 随机 token」。

### 书源与内置程序

- 安装包内置 `heartleo/zlib` CLI 与 Node.js（用于 Harness），两者都从官方发布页下载，打包时按写死在 `scripts/fetch-binaries.mjs` 里的 SHA-256 校验，不匹配就中止打包。
- 书源只使用用户自己的 Z-Library 账号，不支持绕过 DRM、付费限制、验证码或访问控制。调用 CLI 时参数先经格式校验，再以参数数组传给 `execFile`，不经过 shell。

## 已知剩余风险

- **同用户进程：** 与应用同一用户运行的程序可以读取 Harness 子进程的环境变量（拿到本地桥 token 和模型密钥），也可以直接读写应用数据目录。这超出了本地优先应用能防护的范围。
- **明文密钥：** 用户同意明文保存后，密钥以明文存在配置文件中，直到系统钥匙串恢复可用并重新保存。
- **停止回复会重启引擎：** Harness SDK（`@deepseek-ai/dsh-sdk-client@0.2.2-rc.5`）没有中途取消正在进行的回复的接口，点「停止」时只能结束子进程，并在后台重新启动引擎。
