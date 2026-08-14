# ADR-0006: 桌面优先采用 Tauri 2 壳与 Python Sidecar

## Status

`Superseded by ADR-0009`

## Date

2026-08-04

## Context

> 历史说明：本 ADR 的 D1/D2 实验代码曾落地，但长期桌面方向已于 2026-08-14 被 [ADR-0009](0009-local-web-tool-distribution.md) 替代。以下内容保留当时决策与证据，不再构成后续产品目标。

`diandianreading` 是个人优先的 AI 阅读、知识沉淀与内容发布工作台。其核心能力依赖本地 PDF/EPUB/Markdown、本地 SQLite 与私有文件存储、Provider 浏览器会话、可恢复后台任务、Obsidian Vault，以及 NotebookLM/Z-Library/发布平台 Adapter。Phase 0–5 已交付 local-first Python 模块化单体、统一 CLI、`http://localhost:3000` Web/API、持久 Worker、导入和整本书 Chat；当前 Web UI 是由 FastAPI 同源提供的原生 HTML/CSS/JavaScript。

长期产品需要普通用户可以安装、启动、升级和退出，而不是先安装 Python、`uv` 和浏览器依赖再运行 CLI。与此同时，NotebookLM、Playwright、文档处理和现有领域逻辑已经以 Python 实现，改写为 Rust 或 TypeScript 会制造新的 Provider、恢复和安全风险，不能为桌面外观重写已验证的业务核心。

Tauri 2 提供使用系统 WebView 的 Rust 桌面壳、Capability 权限模型、平台安装包、签名更新机制，以及将外部可执行文件声明为 `externalBin` Sidecar 的能力。官方文档明确支持把 Python CLI/API Server 打包为 Sidecar，但每个目标平台需要对应的可执行文件、目标 triple、权限和发布流水线。

本 ADR 只冻结长期产品形态和不可违反的边界。Tauri、React/Vite、Python Sidecar、Playwright 浏览器资源、签名/公证与升级尚未实现，因此状态保持 `Proposed`；只有完成本文 Validation 后才能改为 `Accepted`。

## Threat model

需要保护的资产包括：

- 本地书籍、解析结果、标注、笔记、草稿和导出内容；
- SQLite、WAL/SHM、对象存储、Job staging、备份和迁移状态；
- NotebookLM、Z-Library、Obsidian 与发布平台 Credential/Profile；
- Install Token、Browser Session、CSRF Token 与单次 Bootstrap Nonce；
- Tauri 原生能力、Sidecar 控制通道、安装包、更新清单和签名密钥。

需要覆盖的攻击者和失败包括：

- 恶意书籍、Markdown/HTML、Provider 响应或被注入脚本的 WebView 内容；
- 诱导 WebView 导航到远程页面后调用本地 Tauri Command；
- 同机普通进程抢占 `3000` 端口、伪造 `/healthz`、调用本地 API 或替换 Sidecar；
- 任意 shell 命令/参数注入、过宽 Tauri Plugin 权限和远程 Origin Capability；
- 被篡改、降级或签名无效的安装包/更新包；
- Tauri 崩溃后遗留 Worker/Sidecar，或 Sidecar 崩溃后 UI 继续误报可用；
- 数据迁移中断、应用降级读取新 Schema、更新失败或恢复时误删用户数据。

不覆盖已经取得当前用户完整权限、管理员/root 权限或控制操作系统内核的攻击者。Provider 自身被攻陷、账号政策和第三方服务可用性由对应 Adapter/风险文档继续约束，不因桌面壳而获得更高信任。

## Decision

### 1. 产品形态

- `diandianreading` 第一版正式产品采用 **desktop-first、single-user、local-first** 形态。
- Tauri 2 是目标桌面壳；macOS 是第一个正式支持平台，Windows 在 macOS 桌面链路通过后进入支持范围，Linux 支持时间由后续证据决定。
- CLI 和浏览器模式继续作为开发、诊断、自动化与桌面故障恢复入口；桌面端不得建立另一套业务数据或 Provider 实现。
- 多租户云 Web、公开注册、跨设备云同步与公共分享不是桌面 MVP 的隐含能力；进入这些范围前重新评审 ADR-0001、ADR-0003、ADR-0005 和本 ADR。

### 2. 前端与原生边界

- 用户界面演进为 React + TypeScript + Vite SPA。Node.js 只用于开发与构建，正式桌面运行时不依赖 Node Server。
- 不采用 Next.js Server、React Server Components、Server Actions 或第二套 Web Backend。若未来建设公开云站点，应建立独立决策和部署边界，不能把桌面本地 API 暴露为公网服务。
- Tauri/Rust 只负责窗口、单实例、Sidecar 启停、受限原生集成、签名更新和平台打包；Domain/Application/Job/Provider 逻辑继续属于 Python。
- 初始桌面版本由 Python Sidecar 在 `127.0.0.1:3000` 同源提供 UI、API 和 SSE，Tauri WebView 只导航到规范 Origin `http://localhost:3000`。这样复用 ADR-0005，而不是在首个桌面版本同时重写为 Tauri IPC。
- WebView 初始不获得任何远程 Origin Tauri Capability。业务操作只经过已认证的 Local API；后续确需原生文件选择、通知或打开外部链接时，每项能力必须单独 ADR/权限评审并限制到具体 Window、Origin、Command 和参数 Schema。

### 3. Python Sidecar

- Tauri Bundle 只执行构建时声明的 `externalBin`，不搜索系统 `PATH`，不依赖用户已安装 Python，也不接受 WebView 提供的任意可执行路径或任意参数。
- Sidecar 从当前 `src/diandianreading` 构建，复用同一 composition root、Schema migration、FileStore、Provider Adapter、Worker 和关闭逻辑。
- Sidecar 构建工具（例如 PyInstaller 或 Nuitka）必须通过正式 PoC 比较后决定；在可重复构建、Playwright 资源、启动时间、签名、漏洞扫描和跨平台 E2E 未有证据前不提前固化。
- 每个平台/架构生成与 Tauri target triple 对应的 Sidecar Artifact；壳、Sidecar、静态前端和数据库兼容版本必须写入同一 Release Manifest。
- Playwright Chromium 是独立于 Tauri 系统 WebView 的运行依赖。采用随包分发还是首次运行受验证下载，必须在桌面计划的 Provisioning Gate 中决定；不能静默依赖开发机缓存。

### 4. 启动、Bootstrap 与关闭协议

桌面运行状态至少包含：

```text
launching
→ sidecar_starting
→ sidecar_ready
→ window_ready
→ stopping
→ stopped
```

任何阶段都可以进入类型化 `failed`，但不能把 `/healthz` 成功等同于已证明该进程属于当前安装实例。

- Tauri 先取得单实例锁，再探测固定端口；如果是同一安装实例已运行，则聚焦已有窗口；如果 `3000` 被无法证明身份的进程占用，必须 fail closed，不附着、不终止对方，也不自动换端口。
- Tauri 作为父进程启动 Sidecar，通过父子匿名管道/受限 stdio 控制帧等待 readiness。Bootstrap Secret 不得出现在命令行参数、环境变量、持久文件、普通日志、崩溃报告或遥测中。
- Sidecar stdout 在桌面模式保留为有界、版本化控制协议，不能原样转发到日志；stderr 只输出脱敏诊断。Tauri 严格验证协议版本、事件顺序、字段类型与长度。
- Sidecar ready 后签发短时、单次 Bootstrap Nonce；Tauri 只在内存中把它放入 URL Fragment，导航成功/失败后都清除本地副本。现有 Session/CSRF/Origin/Host/Peer/限额约束继续生效。
- 正常退出由 Tauri 请求 Sidecar 停止领取新任务、等待有界安全点、关闭 Provider Client 和 SQLite，再等待子进程退出。超时后只能终止自己创建且仍能证明身份的 Child，不扫描或杀死同名进程。
- Sidecar 意外退出时，UI 进入明确离线/恢复页面，不缓存“任务已完成”状态；重新启动必须遵守 Lease/Intent/reconciliation 规则。

### 5. 数据与兼容性

- 桌面首版继续读取现有 `~/.diandianreading/`，避免仅为换壳静默搬迁数据。采用平台标准数据目录需要独立、可恢复迁移和回滚设计。
- Tauri/Rust 不直接打开业务 SQLite、Provider Credential 或对象存储；所有数据访问仍经过 Python Application/Infrastructure。
- 桌面更新前执行兼容性检查；破坏性 Schema migration 前创建不含 Credential 的私有原子备份，并声明最低可回滚应用版本。
- 降级版本不得盲目打开更新后的 Schema。迁移失败保留原始数据和诊断，不初始化空数据库伪装成功。
- CLI、浏览器模式和桌面模式使用同一个 App Home 时必须执行单 Writer/单 Worker 约束，不能并行启动两个主 Runtime。

### 6. 分发与更新

- 开发构建、未签名内部构建和正式发布使用不同 Channel/标识；未签名构建不得向用户声称可以安全自动更新。
- macOS 正式 Artifact 必须完成应用签名、Hardened Runtime（如适用）、公证和 Gatekeeper 验证；Apple 凭据只存在于受保护 CI Environment。
- 自动更新只有在 Tauri Updater 的 Artifact 签名、公钥固定、TLS、版本/平台匹配、下载上限、失败恢复和人工回滚演练全部通过后才启用。
- Updater 私钥不得进入仓库、普通 CI 日志、Cache 或构建 Artifact。签名失败、版本降级、平台不匹配或清单异常时拒绝安装。
- Release 至少提供版本、平台、架构、Sidecar/API/Schema 兼容信息、SHA-256、SBOM、签名结果、迁移说明和已知回滚边界。

## Security and privacy

- 沿用 ADR-0003 的 Provider 凭据物理隔离和 ADR-0005 的 Local API 安全边界；Tauri 壳不读取 Cookie、账号邮箱或 Provider 内部 ID。
- 默认无远程 Tauri Capability、无任意 Shell、无 `args: true`、无通配文件系统权限、无远程 CDN/脚本。Deny 规则优先，新增 Capability 必须有负向测试。
- Tauri CSP 与 FastAPI CSP 都采用最小 allowlist；WebView 禁止导航到非规范本地 Origin。外部帮助/Provider 页面在系统浏览器或专用受控 Playwright Context 中打开，不在具有本地能力的主 WebView 加载。
- Sidecar 路径、Bundle Resource 和 Update Artifact 必须可验证；不从用户可写通用目录加载代码、插件或 Python Module。
- 文件导入仍由 Python 的受管 FileStore、no-symlink、owner/type、大小/类型/Archive/Parser 限制处理；桌面文件选择器只提供用户意图，不提高文件信任级别。
- 正式版遥测默认关闭；未来若增加崩溃报告或指标，必须 opt-in、脱敏，并单独说明保留与删除策略。

## Operational rollback and recovery

- Tauri 壳是现有 CLI/Web Runtime 的增量封装。桌面构建不可用时，兼容版本仍可通过 CLI/浏览器模式打开同一 App Home；这条恢复路径必须在每个 RC 演练。
- 首个桌面阶段不引入仅 Rust 可读的数据格式。壳回滚和 UI 回滚不得要求回滚用户内容。
- 数据迁移遵循“先备份、再迁移、验证后提交”；失败保留原始数据库、对象与 Job 状态，不删除远程 NotebookLM 资源，也不 blind recreation。
- 更新失败时保留最后一个已签名兼容 Bundle；如果 Schema 已超出旧版支持范围，只允许前向修复或从迁移前备份显式恢复，不能让旧版冒险打开。
- Sidecar/Playwright Provisioning 失败时显示可操作诊断和离线本地能力，不自动从非固定来源下载安装可执行内容。

## Consequences

### Positive

- 提供符合普通用户预期的安装、启动、窗口、单实例和升级体验。
- 最大化复用 Phase 0–5 已验证的 Python 领域、持久 Job、Provider 与安全边界。
- React/Vite UI 可同时服务浏览器开发模式和桌面端，不形成两套产品。
- Tauri Capability、Bundle 签名和受控 Sidecar 比任意 Shell/系统 Python 更容易建立明确边界。
- 桌面不可用时仍保留 CLI/浏览器恢复入口，降低一次性迁移风险。

### Negative

- 开发工具链增加 Rust、Node、平台 SDK、Python 打包、签名/公证和多架构 CI。
- Tauri 使用系统 WebView，但 Playwright 仍可能要求分发 Chromium，安装包体积不会只由 Tauri 决定。
- 固定 `localhost:3000` 继续要求端口占用、进程身份和 Bootstrap 保护；桌面壳并不会自动消除本地 Web 威胁。
- macOS、Windows 的 Sidecar、路径权限、签名和安装行为不同，需要真实平台 E2E。
- 第一阶段不通过 Tauri IPC 执行业务操作，部分原生体验需要后续逐项增加。

### Follow-up

- 按 [桌面应用实施计划](../desktop-application-plan.md) 完成 D1–D6。
- 为 Sidecar 控制协议、单实例、端口身份、关闭与崩溃恢复定义可测试接口。
- 完成 React/Vite UI 迁移，但保持现有 HTTP/SSE 契约。
- 完成 Python Sidecar + Playwright Artifact PoC，并记录工具选择证据。
- 建立 macOS 签名、公证、Updater 签名和 Release Manifest 流程。
- 通过 packaged-app E2E 和真实 Provider 手工验收后，将本 ADR 改为 `Accepted`。

## Alternatives considered

### Next.js 全栈 Web

不采用作为个人桌面 MVP 的主架构。项目不需要 SSR/SEO，完整 Next.js 会与 FastAPI 形成第二套 Server、Session、代理和部署边界；静态导出又不能提供需要 Server 的 Next.js 能力。若未来建设多用户云产品，另行设计云身份、租户隔离、PostgreSQL、对象存储、队列和 Secret Vault。

### Electron + Python Sidecar

暂不采用。Electron 会额外分发 Node/Chromium，而核心后端仍是 Python；当前没有必须依赖 Electron API 或一致 Chromium UI 的证据。若 Tauri 系统 WebView 兼容性或 Sidecar 限制导致关键功能无法通过 Validation，可用正式 ADR 重新评估。

### 业务核心重写为 Rust

不采用。NotebookLM、Playwright、文档处理、持久恢复和 Adapter 已在 Python 中实现并测试，重写不能直接改善用户价值，反而扩大 Provider 与数据一致性风险。Rust 只承担桌面壳和必要原生集成。

### 永久保留浏览器 + CLI，不提供安装包

不采用作为长期正式产品。它适合开发和恢复，但要求普通用户管理 Python、依赖、终端和服务进程，不满足稳定个人工作台的分发与升级体验。

## Validation

本 ADR 只有在以下证据全部通过后才能改为 `Accepted`：

1. **构建**：干净 macOS CI 能构建 React Assets、目标架构 Python Sidecar 和 Tauri Bundle；Sidecar 名称/target triple、Bundle Resource 和版本 Manifest 可验证。
2. **启动**：冷启动、重复启动、正常退出、Tauri 崩溃、Sidecar 崩溃和系统重启场景没有孤儿 Worker、重复 Runtime 或误附着进程。
3. **端口与身份**：同实例聚焦、无关进程占用 `3000`、伪造 `/healthz`、过期/重放 Bootstrap、错误 Host/Origin/Peer 均按预期 fail closed。
4. **Capability**：主 WebView 无远程 Tauri Command；任意 Shell、任意参数、未声明 Sidecar、越界文件和导航到远程内容的调用被自动化测试拒绝。
5. **数据**：现有 `~/.diandianreading` 可被桌面兼容版本安全打开；中断 migration、备份恢复、CLI fallback 和不支持降级都有演练。
6. **业务 E2E**：打包后的 App 完成本地文件导入、Job/SSE、ready Book、whole-book Chat、Citation、重试和退出恢复，不依赖开发机 Python/Node/浏览器缓存。
7. **Provider**：在用户控制的真实环境完成 NotebookLM 与可选 Z-Library 登录、Session 恢复和至少一次合法资料导入；Fake E2E 不替代该证据。
8. **Playwright**：全新机器上的 Chromium Provisioning、校验、升级、离线提示和清理策略通过，且不从未固定来源执行代码。
9. **发布**：macOS App 签名、公证、Gatekeeper、Updater Artifact 签名校验、错误签名拒绝、更新中断和上一兼容版本恢复通过。
10. **质量**：Rust、TypeScript、Python lint/type/test、Wheel/Sidecar/Bundle 构建、SBOM/Secret 扫描、direct review 和 CI 全部通过。

## Related

- [桌面应用实施计划](../desktop-application-plan.md)
- [ADR-0001：local-first Python 模块化单体](0001-local-first-modular-monolith.md)
- [ADR-0003：Provider 凭据物理隔离](0003-provider-credential-isolation.md)
- [ADR-0004：持久化导入 Saga](0004-durable-import-saga.md)
- [ADR-0005：本地 API 安全](0005-local-api-security.md)
- [产品 PRD](../../../diandianreading-PRD.md)
- [产品 Roadmap](../../../diandianreading-ROADMAP.md)
- [Tauri Sidecar 官方文档](https://v2.tauri.app/develop/sidecar/)
- [Tauri Security 官方文档](https://v2.tauri.app/security/)
- [Tauri Updater 官方文档](https://v2.tauri.app/plugin/updater/)
