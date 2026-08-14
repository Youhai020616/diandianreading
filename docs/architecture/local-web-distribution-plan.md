# 本地 Web 工具分发实施计划 / Local Web Tool Distribution Plan

> 状态：Active
>
> 目标：把 `diandianreading` 交付为通过终端一条命令启动、由浏览器访问的 local-first Web 工具，不再继续 Tauri 原生桌面交付轨
>
> 目标体验：`uvx diandianreading web` → 本地服务与 Worker 启动 → 自动打开 `http://localhost:3000`
>
> 架构决策：[ADR-0009](adr/0009-local-web-tool-distribution.md)，已正式替代 ADR-0006 的 desktop-first 决策
>
> 最后更新：2026-08-14

## 1. 决策摘要 / Decision Summary

本计划借鉴 DeepSeek Harness 的**分发体验**，不复制其 Node/Cordis/插件架构：用户通过包管理器在终端启动一个只监听回环地址的本地进程，再使用同源 Web UI 完成产品操作。

```text
uv / uvx
  → diandianreading web
    → FastAPI + React static assets + durable Worker
      → http://localhost:3000
        → SQLite + private local files + Provider adapters
```

长期产品形态调整为：

```text
local-first Web tool
+ Python modular monolith
+ React / TypeScript / Vite UI
+ FastAPI same-origin HTTP/SSE
+ embedded durable Worker
+ SQLite / private local files
+ explicit Playwright browser provisioning
```

明确停止继续投入：

```text
Tauri / Rust shell
macOS .app / .dmg
native single-instance/window lifecycle
codesign / notarization / Tauri Updater
Windows native bundle
```

这不是改成公共云服务，也不是改成纯前端 PWA。Python Runtime、SQLite、文档处理、Provider Session、Worker 与 Obsidian 文件访问仍在用户本机运行。

## 2. 第一原则 / First Principles

1. **复制使用体验，不复制技术栈**：DeepSeek Harness 的关键价值是“一条终端命令启动本地 Web UI”；`diandianreading` 已有适合自身领域的 Python/FastAPI/React 栈，无重写依据。
2. **终端只是启动与诊断入口**：阅读、导入、标注、Chat、创作和导出主要在 Web UI 完成；CLI 不发展为第二套产品 UI。
3. **浏览器不是安全边界**：服务只监听回环仍须保留 ADR-0005 的 Token、Session、Bootstrap、Host/Origin、CSRF、SSE 和资源限制。
4. **数据位置必须稳定**：默认 App Home 继续是 `~/.diandianreading/`，不能像代码工作区工具一样默认使用启动目录保存业务数据。
5. **安装简单不等于静默执行**：Playwright Chromium 体积大且会执行下载内容，必须显式授权、固定版本、写入私有目录并可诊断；不能在首次 `web` 启动时无提示下载。
6. **先替代，再删除**：D1 中可复用的浏览器 Provisioning、Artifact 校验和进程测试经验，在对应 Local Web 能力落地后再移除；不因停止桌面开发而先删掉唯一实现。
7. **没有发布证据就不宣称支持**：source-tree、Fake Provider 和 TestClient 通过，不等于 PyPI 安装、真实 Uvicorn 进程、真实浏览器和真实 Provider 已可用。

## 3. 目标用户体验 / Target User Experience

### 3.1 一次性运行

PyPI 包发布后，规范入口为：

```bash
uvx diandianreading web
```

含义：

- `uvx` 在隔离工具环境中解析并运行 `diandianreading` 包；
- `diandianreading` 是新增的规范 console script；
- `web` 是面向最终用户的本地 Web 启动命令；
- 用户数据不进入 uvx 临时环境，始终保存在 App Home；
- uvx 环境可重建，App Home 不随工具升级或卸载删除。

### 3.2 持久安装

高频使用者采用：

```bash
uv tool install diandianreading
diandianreading web
```

升级采用 uv 的工具升级机制：

```bash
uv tool upgrade diandianreading
```

项目不再实现 Tauri Updater 或自定义后台更新器。应用可以提示“存在新版本”，但未经独立安全设计不得自行下载并执行更新。

### 3.3 从 GitHub 版本运行

PyPI 正式发布前或用于特定版本诊断时：

```bash
uvx \
  --from git+https://github.com/Youhai020616/diandianreading@<tag-or-commit> \
  diandianreading web
```

用户文档不得把未固定的 `main` 当作稳定安装源。正式说明使用 tag 或精确 commit。

### 3.4 启动反馈

默认人类可读输出：

```text
diandianreading 0.1.0

Local Web UI: http://localhost:3000
Data directory: ~/.diandianreading
Worker: running
NotebookLM browser: ready | setup required
Z-Library: disabled

Opening your browser...
Press Ctrl+C to stop.
```

约束：

- 不打印 Install Token、Cookie、CSRF Token、Bootstrap Nonce、Provider ID、账号或绝对书籍路径；
- 自动化通过显式 `--json` 获得有界、版本化且脱敏的启动状态；
- 默认只打印规范 Origin，不打印含 Bootstrap Secret 的完整 URL；
- Browser 只在服务 readiness 成立后打开，不能依赖固定睡眠时间冒充 readiness。

### 3.5 CLI 兼容性

新增：

```text
diandianreading web
diandianreading setup [notebooklm]
diandianreading doctor
diandianreading open
diandianreading --version
```

保留现有 `diandian` console script。至少一个兼容周期内：

```text
diandian serve  == diandianreading web
```

旧的 `auth`、`import`、`jobs`、`worker` 和 E2E 命令不在本计划中删除。`serve` 的弃用必须有 warning、迁移文档和明确版本窗口，不能静默破坏脚本。

## 4. 运行与数据契约 / Runtime and Data Contract

### 4.1 单进程产品 Runtime

一个 `web` 进程拥有：

- FastAPI HTTP/SSE；
- React/Vite 构建产物；
- embedded durable Worker；
- SQLite migration 与 repositories；
- LocalFileStore；
- NotebookLM 与可选 Z-Library Adapter 生命周期。

Worker 不监听第二端口，不要求用户另开终端。独立 `diandian worker` 仅保留给诊断和自动化，不作为普通使用步骤。

### 4.2 网络边界

首个公开版本固定：

```text
bind: 127.0.0.1:3000
canonical origin: http://localhost:3000
```

强制规则：

- 不支持 `0.0.0.0`、LAN、远程代理、容器共享入口或公网部署；
- 不因端口占用自动换端口、附着未知进程或终止占用者；
- `/healthz` 只证明 liveness，不能证明进程属于当前 App Home；
- 保留 `proxy_headers=False`、无 CORS、无 OpenAPI、无 WebSocket；
- 如未来需要动态端口或远程访问，先新增 ADR，不能以一个 `--host` 参数绕过 ADR-0005。

### 4.3 App Home

默认继续使用：

```text
~/.diandianreading/
├── state/app.sqlite3
├── objects/
├── credentials/
├── browsers/
├── staging/
├── uploads/
├── logs/       # 若启用，必须有大小/保留上限
└── backups/    # 后续恢复功能
```

`browsers/` 是本计划新增的应用管理 Playwright Runtime 位置。uvx/tool 环境与 App Home 生命周期分离。

允许显式覆盖：

```bash
diandianreading --home /private/path web
```

但不允许默认使用当前工作目录，也不允许升级时静默迁移既有 `~/.diandianreading`。

### 4.4 Browser Bootstrap 与重新打开

默认启动：

1. 端口预检；
2. migration 与 Runtime 初始化；
3. Uvicorn 真正进入 ready；
4. 签发短时、单次 Bootstrap Nonce；
5. 通过 URL Fragment 自动打开浏览器；
6. UI 换取 HttpOnly Session 后立即清除 Fragment。

`--no-open` 不得把 Secret 默默写入普通 stdout。L1 只把它定义为自动化/Bearer 场景；L2 提供 `diandianreading open`：

- CLI 从私有 App Home 读取 Install Token；
- 向已运行服务发送经过 Bearer 认证的本地 nonce 请求；
- 服务成功证明同一安装实例后签发一次性 Bootstrap；
- CLI 自动打开浏览器；
- 只有显式 `--print-url` 才允许把一次性 URL 输出到终端，并附带泄漏风险提示。

端点与命令实现前，不能宣称关闭浏览器后可无重启安全恢复 Session。

### 4.5 关闭

`SIGINT`/`SIGTERM` 的有界顺序：

```text
stop accepting new work
→ stop Worker polling
→ wait for bounded safe point
→ persist lease/checkpoint state
→ close Provider clients
→ close HTTP server
→ process exits
```

不得把取消本地进程等同于撤销远程 Provider 操作；重启后继续按 ADR-0004 reconciliation。

## 5. Provider Browser Provisioning

### 5.1 目标命令

```bash
diandianreading setup notebooklm
diandianreading doctor
```

`setup notebooklm`：

- 在下载前显示版本、来源、预计下载量和目标目录；
- 需要显式用户确认，非交互模式要求 `--yes`；
- 将 Playwright Chromium 写入 `~/.diandianreading/browsers/<version>/`；
- 使用固定 Playwright/Chromium revision；
- 写入有版本的 manifest，并校验 executable confinement；
- 原子发布完整目录，失败清理 staging；
- 不回退到开发机 `~/Library/Caches`；
- 不读取系统 PATH 上任意 Chromium 作为“已验证”结果。

`doctor` 只输出脱敏类别：ready、missing、corrupt、version-mismatch、permission-error、disk-space 等，不打印 Credential 或用户路径细节。

### 5.2 依赖策略 Gate

L0/L1 必须用可复现实验决定：

1. `notebooklm-py[browser]` 是否进入默认发行依赖；
2. 或通过 `diandianreading[notebooklm]` extra 安装。

判定标准：

- `uvx diandianreading web` 必须始终可以启动本地阅读、标注和 Obsidian 能力；
- 用户不能在 UI 点“连接 NotebookLM”后才遇到无法解释的 `ImportError`；
- 若采用 extra，UI/CLI 必须给出精确升级命令，并在重启后检测成功；
- Chromium 二进制不进入基础 wheel。

在测量 wheel 大小、首次 setup 时间和 uvx 重启行为前，不提前宣称哪种依赖布局胜出。

### 5.3 D1 资产复用

删除 `packaging/sidecar/` 前，先评估并迁移其中可复用的：

- browser manifest；
- executable confinement；
- staging/atomic publish；
- Artifact smoke 的资源完整性检查。

PyInstaller onedir、Sidecar 控制帧和 Tauri Bundle 专属逻辑不进入新产品 Runtime。

## 6. 分发与发布 / Distribution and Release

### 6.1 Python 包

目标包必须：

- wheel 内包含 migrations；
- wheel 内包含 React production assets、PDF.js worker 和 MIME 所需资源；
- 安装时不运行网络脚本、不下载 Chromium、不写 App Home；
- 首次命令执行时才初始化私有 App Home；
- `diandianreading --version` 不初始化数据库或 Provider；
- sdist 与 wheel 都可从锁定构建工具产生；
- console script 包名与 `uvx diandianreading web` 契约一致。

### 6.2 发布渠道

```text
source      开发者从 checkout 运行
preview     TestPyPI / GitHub pre-release
stable      PyPI + GitHub Release + immutable tag
```

第一版不建设自定义更新服务。PyPI 发布采用 Trusted Publishing/OIDC 时，禁止长期 API Token 进入普通 CI；若条件不满足，先手工受控发布，不为自动化牺牲凭据边界。

### 6.3 发布前必须决定

- PyPI 包名是否可用；
- License：当前 `Proprietary` 是否符合预期分发方式；
- 支持平台与 Python 版本；
- Provider live smoke 的责任边界；
- Release 保留和撤回策略；
- schema downgrade 拒绝与备份说明。

没有 License 决定，不进入公开 PyPI Stable。

### 6.4 Release 内容

每个版本至少提供：

- immutable git tag；
- changelog；
- Python/OS 支持矩阵；
- wheel/sdist hash；
- schema version 与迁移说明；
- Playwright/Chromium revision；
- 已验证与未验证 Provider 列表；
- 数据目录、升级、备份和卸载说明；
- Secret 扫描和依赖清单结果。

## 7. 桌面轨退场 / Desktop Track Retirement

### 7.1 文档语义

L0 完成后：

- ADR-0009 正式选择 local-web-first；
- ADR-0006 标记 `Superseded`，保留历史，不删除编号；
- `desktop-application-plan.md` 标记 `Deprecated/Historical`；
- D1/D2 E2E 文档保留为历史实现证据，不再作为产品退出门；
- PRD/Roadmap 删除签名 `.app`、Updater、Windows Bundle 等成功标准；
- React/Vite 的 D3 成果重新描述为 Web UI 基线，而不是桌面依赖。

### 7.2 代码退场顺序

只能在 L1/L2 替代能力已合并后删除：

1. `apps/desktop/`；
2. Tauri/Rust/macOS Bundle CI；
3. `diandian-desktop-sidecar` console script；
4. `interfaces/desktop_sidecar.py` 与其测试；
5. PyInstaller 及 Sidecar-only build dependencies；
6. `packaging/sidecar/` 中未被 Local Web setup/doctor 复用的部分；
7. D1/D2 手动桌面验收项。

删除必须是独立 PR，不与 Web CLI 功能实现混合，便于确认没有误删浏览器 provisioning 或 package resources。

### 7.3 数据兼容

退场不新增 schema migration。现有 App Home、数据库、对象、Credential 和 Provider mapping 必须可由新 `web` 命令原地读取。

旧未签名 `.app` 若曾被本地运行，只给出停止使用说明；不自动删除 App、浏览器资源或用户数据。

## 8. 实施阶段 / Delivery Phases

每阶段单独分支、PR、review、offline E2E 与 CI。串行区继续遵守 `parallel-delivery-strategy.md`。

### L0：方向与契约冻结（已完成）

交付：

- ADR-0009：local-web-first，通过 uv/uvx 分发；
- 本计划评审定稿；
- PRD、Roadmap、文档索引和 `CLAUDE.md` 同步；
- ADR-0006/Desktop Plan 的 Superseded/Deprecated 状态；
- CLI 名称、兼容周期、App Home、固定 Origin 和非目标冻结；
- License/PyPI 名称作为阻塞 Gate 记录。

退出标准：

- 不再把 Tauri、签名 `.app` 或 Updater 描述为未来必做；
- 不把 local Web 描述为公共云或纯前端；
- ADR-0005、ADR-0004 与 App Home 兼容边界无冲突；
- 文档链接和状态一致；
- 既有测试不回归。

### L1：Web CLI 产品化与真实进程 E2E（已完成）

交付：

- `diandianreading` console script；
- `web` 子命令与 `diandian serve` 兼容别名；
- `--version`、`--json`、`--no-open`、`--home`；
- readiness 后自动打开浏览器；
- 人类可读且脱敏的启动/关闭诊断；
- 安装 wheel 后启动真实 Uvicorn 的进程 E2E。

真实进程 E2E：

```text
build wheel
→ install into isolated tool environment
→ start diandianreading web --no-open
→ wait for bounded readiness
→ verify /healthz
→ authenticate through supported CLI/Bearer path
→ fetch index + JS + PDF worker
→ execute one offline import/reading snapshot
→ SIGTERM
→ verify process and Worker stop
```

退出标准：

- 仅安装 wheel 后可启动，不依赖 source tree、Node 或 pnpm；
- migration 与静态资源完整；
- 浏览器不早于 readiness 打开；
- 固定端口冲突 fail closed；
- Ctrl+C/SIGTERM 后无 Worker 残留且远程 Intent 不被误判回滚；
- 输出无 Secret、Credential、正文与敏感路径；
- Python/Web 既有质量门全绿。

### L2：Setup、Doctor 与安全重新打开

交付：

- App Home 下版本化 Chromium provisioning；
- `setup notebooklm`；
- `doctor`；
- `open` 与经过 Bearer 认证的 nonce 发行路径；
- Token 损坏/丢失的 fail-closed 诊断与恢复设计；
- Provider 缺失浏览器时的 UI 类型化错误。

退出标准：

- 全新用户仅安装 uv 后可完成 web 启动；
- 未安装 Chromium 时本地阅读/标注/Obsidian 仍可用；
- setup 中断不发布半成品；
- doctor 可区分 missing/corrupt/version mismatch 且不泄密；
- 已运行服务可由 `open` 安全重新打开，不以 `/healthz` 作为身份；
- 未知进程占用 3000 时不附着、不杀进程。

### L3：桌面代码退场与 CI 简化

交付：

- 按 §7.2 删除 Tauri、Rust、Sidecar-only 代码；
- 删除 macOS Bundle/Sidecar Artifact CI；
- 保留 Python 3.11/3.12/3.14、Web、wheel、installed-process E2E；
- 更新架构边界测试和依赖锁；
- 更新手动验收清单。

退出标准：

- 仓库不再需要 Rust/Tauri/Xcode 构建；
- 用户 Runtime 不依赖系统 Node；
- setup/doctor 已承接所需 browser provisioning；
- `rg` 不再出现把桌面壳描述为当前或目标产品的有效文档；
- 全量质量门通过，覆盖率不低于 90%。

### L4：Preview 与 Stable 分发

交付：

- 根目录用户 README；
- TestPyPI/GitHub pre-release；
- clean-machine 安装清单；
- PyPI Trusted Publishing 或受控发布流程；
- immutable tag、hash、changelog、支持矩阵；
- `uvx diandianreading web` 发布后 smoke。

退出标准：

- 全新、无项目源码的受支持机器通过 `uvx diandianreading web` 打开 UI；
- App Home 在工具环境重建/升级后保持完整；
- 重复升级不重复迁移或丢数据；
- wheel 不含 Token、Cookie、用户数据或 Chromium；
- License 与分发渠道一致；
- Preview 反馈中的阻塞安装问题为 0 后才发布 Stable。

### L5：产品验收并回到功能 Roadmap

交付：

- 真实浏览器 R3/R4 验收；
- 真实 NotebookLM 登录、引用定位和回答质量抽样；
- 真实 Obsidian Vault 与三个内容模板验收；
- 安装、启动、升级、备份、恢复手册；
- P3/P4/P5 未完成项重新排序。

退出标准：

- 用户能从终端启动完成“导入 → 阅读 → 标注 → AI → 内容 → Obsidian”；
- Provider 失败不影响本地能力；
- 重启与升级无数据丢失；
- 真实验收结果已记录，Fake E2E 不被描述为 live compatibility；
- 后续功能开发以用户证据排序，不再以桌面打包门排序。

## 9. 测试矩阵 / Test Matrix

| 层级 | 默认 CI | 发布 CI | 手工验收 |
| --- | --- | --- | --- |
| Python unit/integration/E2E | 是 | 是 | 否 |
| Ruff/mypy/架构边界 | 是 | 是 | 否 |
| React type/unit/build | 是 | 是 | 视觉/键盘 |
| wheel resource smoke | 是 | 是 | 否 |
| installed real-process E2E | 是 | 是 | 进程观察 |
| uvx from local wheel | 是 | 是 | 否 |
| uvx from TestPyPI/PyPI | 否 | 是 | clean machine |
| Chromium setup/manifest | fake + isolated | 是 | 首次下载 |
| NotebookLM live | 否 | 受控且人工批准 | 是 |
| Z-Library live | 否 | 默认关闭 | 合法资料、显式启用 |
| Obsidian real Vault | 否 | 否 | 是 |

默认 PR CI 不持有 Provider、PyPI 或发布 Secret。公开发布凭据不能因“终端安装更简单”而降低保护等级。

## 10. Definition of Done

Local Web 分发完成当且仅当：

- 用户在受支持的干净机器上只准备 uv，即可执行 `uvx diandianreading web`；
- 命令从已发布的不可变版本安装并启动真实本地服务；
- 浏览器在 readiness 后自动打开并安全建立 Session；
- FastAPI、React UI、Worker、SQLite、FileStore 与 Provider Adapter 在一个受控 Runtime 中工作；
- 数据始终保存在稳定 App Home，工具升级/重建不删除用户数据；
- Chromium 由显式 setup 安装和验证，不进入基础 wheel、不静默下载；
- 固定端口、未知进程、Token 损坏、migration 失败与 Provider 缺失均 fail closed 且有可操作诊断；
- source-tree、installed-wheel、installed-process、Preview install 与真实浏览器验收均有证据；
- 桌面专属代码和 CI 已退场，ADR/PRD/Roadmap 不再承诺 Tauri 发布；
- License、版本、hash、changelog、支持矩阵、备份和升级说明完整。

## 11. 明确非目标 / Non-goals

- 不提供 Tauri/Electron/macOS `.app`/Windows installer；
- 不建设公共云、多租户账号、云数据库或跨设备同步；
- 不把本地 API 绑定到 LAN/公网；
- 不提供 Docker 远程部署作为默认产品入口；
- 不用 PWA/浏览器扩展替代 Python Runtime；
- 不在基础 wheel 内捆绑 Chromium；
- 不实现后台常驻 daemon、系统托盘、自启动或无人值守自动更新；
- 不因分发调整重写 Domain/Application/SQLite/Worker；
- 不把当前工作目录当作默认数据目录。

## 12. 风险与止损 / Risks and Stop Rules

| 风险 | 信号 | 处理 |
| --- | --- | --- |
| uv 对目标用户仍太技术化 | clean-machine 测试无法在文档内完成 | 先改善 setup/doctor；不要立刻回到 Tauri，重新评估 Homebrew/安装脚本 |
| Chromium setup 过重 | 下载失败率、代理问题或磁盘占用不可接受 | 支持受验证系统 Channel 前先新增 ADR；不静默回退 |
| uvx 临时环境造成版本漂移 | 同一命令不同时间行为不同 | Stable 文档提供 pin/tag；高频用户推荐 `uv tool install` |
| 固定端口频繁冲突 | Preview 中重复出现 | 收集证据后设计可认证动态 Origin；不先随机换端口 |
| Web UI 无法覆盖必要本地操作 | 用户必须频繁回终端 | 优先补 UI/安全本地 endpoint；不以宽泛文件权限解决 |
| PyPI/License 无法公开 | Stable Gate 阻塞 | 采用 GitHub tag + 明确授权的分发方式，不能模糊许可 |
| 删除桌面代码误删 Provisioning | setup/doctor 出现能力倒退 | 严格执行“先替代、后删除”，L2 是 L3 前置屏障 |

若 L4 clean-machine 测试证明 uv 安装本身仍是主要阻力，再比较 Homebrew formula、官方安装脚本或 standalone Python Artifact；没有该证据前不恢复原生桌面轨。

## 13. 仍需证据决定的问题 / Open Evidence Gates

1. PyPI 最终包名与 console script 名称是否均使用 `diandianreading`。
2. `notebooklm-py[browser]` 进入默认依赖还是 extra。
3. 第一批正式支持的 OS/Python 组合；当前 Python matrix 不能替代 OS 级 Provider 验收。
4. Chromium 的下载大小、冷启动、代理与清理策略。
5. `diandianreading open` 的 nonce endpoint 具体 HTTP 契约。
6. 是否为端口冲突后的“已认证同实例”提供只打开浏览器的行为；不得附着未知服务。
7. PyPI Stable 前采用何种 License。
8. 是否需要 Homebrew formula；先由 uv clean-machine 反馈决定。
9. 日志目录、保留期与用户主动诊断包的最小范围。

每项必须由构建、测量或用户测试决定；需要改变安全/数据边界时新增 ADR。

## 14. 依据 / References

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：`npx @deepseek-ai/dsh web` 启动回环 Web UI 的交付体验参考。
- [uv tools guide](https://docs.astral.sh/uv/guides/tools/)：`uvx`/`uv tool run`、`--from`、持久 tool install 与 upgrade 的官方语义。
- [ADR-0001](adr/0001-local-first-modular-monolith.md)：local-first Python 模块化单体。
- [ADR-0003](adr/0003-provider-credential-isolation.md)：Provider Credential 物理隔离。
- [ADR-0004](adr/0004-durable-import-saga.md)：持久任务与远程结果 reconciliation。
- [ADR-0005](adr/0005-local-api-security.md)：回环 API 的认证、同源与资源边界。
- [ADR-0006](adr/0006-desktop-first-tauri-python-sidecar.md)：将由 L0 的 ADR-0009 正式替代的历史桌面决策。
- [Phase 5 E2E](../development/phase-5-e2e.md)：当前 `diandian serve`、App Home、Local API 与 installed-wheel 基线。
