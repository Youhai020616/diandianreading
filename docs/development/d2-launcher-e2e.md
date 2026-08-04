# D2 Tauri 壳与生命周期 E2E

> 状态：Active
>
> 范围：D2 的 Tauri 壳、单实例、Sidecar 生命周期、Capability 边界与未签名 `.app`；不包含签名、公证、Updater、Windows 与真实 Provider 联调。

## 交付边界

- 桌面壳分为两层：`apps/desktop/launcher-core`（纯 Rust，无 Tauri 依赖）承担全部有安全后果的判断，`apps/desktop/src-tauri` 只做与 Tauri 运行时的顺序编排。这样端口策略、控制帧解析、状态机与子进程回收可以在**任意主机**上单元测试，不需要 WebView、窗口服务器或 macOS Bundle。
- 主 WebView 加载 `http://localhost:3000`。从 Tauri 视角这是远程 Origin，因此 `capabilities/default.json` 的 `permissions` 为**空数组**：不授予任何 Tauri Command，不启用 Shell Plugin，不开放 `assetProtocol`。
- 窗口只在 Sidecar 通过父子控制通道完成身份验证后创建；`on_navigation` 只允许 `http://localhost:3000`，其余导航一律拒绝。
- Bootstrap nonce 从 stdout 控制帧读出后立即转成一次性 URL fragment 交给 WebView，不落参数、环境变量、文件与日志；`ReadyFrame` 的 `Debug` 实现固定输出 `<redacted>`。
- Sidecar 只从 Bundle `Resources/sidecar/` 解析，且要求 canonical 路径仍在资源目录内；符号链接逃逸被拒绝。

## 控制协议一致性

Rust 侧 `launcher_core::control` 与 Python 侧 `desktop_sidecar.parse_ready_control_frame` 实现同一套拒绝规则，两边都不接受前向兼容字段：

| 规则 | Python | Rust |
| --- | --- | --- |
| 单帧上限 4096 字节 | `MAX_CONTROL_FRAME_BYTES` | `MAX_CONTROL_FRAME_BYTES` |
| nonce 上限 512 字节 | `MAX_BOOTSTRAP_BYTES` | `MAX_BOOTSTRAP_BYTES` |
| 字段集合必须恰好为四项 | `set(payload) != expected` | `object.len() != 4` + 逐字段取值 |
| `protocol`/`event`/`origin` 精确匹配 | 是 | 是 |
| nonce 仅允许 `0x21`–`0x7E` 且非空 | 是 | 是 |
| 累计字节超限即 fail closed | 由 stdout 单行保证 | `Read::take` 上限 + 无换行即 `Truncated` |

## 端口与附着策略

`launcher_core::port` 把 desktop-application-plan §8.3 的**拒绝**编码成可测试的函数，而不是"没写相应代码"：

- `probe` 用 bind 而非 connect 判断占用：能连上只证明有人在听，不构成允许采取动作的证据；
- `may_adopt` 要求 own-child、控制帧验证、安装实例身份、Session 轮换四项**全部**成立；`healthz_ok` 被刻意排除在合取之外，单测 `healthz_alone_never_authorises_adoption` 锁定这一点；
- `ForbiddenPortAction` 的三项（换端口、结束占用进程、无证据附着）由 `permits` 恒定返回 `false`。

## 无孤儿进程

`SupervisedChild` 在 `Drop` 中 kill 并 wait，因此 panic 展开路径同样回收子进程；release profile **刻意不使用** `panic = "abort"`，否则 Drop 不会执行。`shutdown` 幂等：第一次调用即释放 handle，第二次不会向已被复用的 PID 重复发信号。

## 本地复现

`launcher-core` 不需要 WebKit 系统库，可在 Linux/macOS 任意主机执行：

```bash
cd apps/desktop
cargo fmt --all -- --check
cargo clippy -p launcher-core --all-targets --locked -- -D warnings
cargo test -p launcher-core --locked
```

完整 Bundle 需要 macOS（`src-tauri` 依赖 WebKit 与 macOS Bundle 工具链）：

```bash
uv run --locked --extra desktop-sidecar python packaging/sidecar/provision_browser.py \
  --output .tmp/shell-browser
uv run --locked --extra desktop-sidecar python packaging/sidecar/build.py \
  --output .tmp/shell-artifact --browser-root .tmp/shell-browser
mkdir -p apps/desktop/src-tauri/resources
mv .tmp/shell-artifact/diandian-desktop-sidecar apps/desktop/src-tauri/resources/sidecar
cargo install tauri-cli --version 2.11.4 --locked
(cd apps/desktop && cargo tauri build)
uv run --locked python packaging/sidecar/smoke_artifact.py \
  --artifact apps/desktop/target/release/bundle/macos/diandianreading.app/Contents/Resources/sidecar
```

`smoke_artifact.py` 接收 onedir **目录**（内部再定位可执行文件与 `sidecar-manifest.json`），不是可执行文件路径。

## CI 覆盖

| Job | 平台 | 验证内容 |
| --- | --- | --- |
| `Desktop launcher core (Rust)` | ubuntu-latest | `launcher-core` 的 fmt、clippy `-D warnings`、全部单元测试 |
| `Desktop shell bundle (macOS arm64)` | macos-latest | 未签名 `.app` 可构建；Bundle 内含 `Contents/Resources/sidecar/`；对 Bundle **内部**的 Sidecar 执行 D1 Artifact smoke |

## 退出标准与当前证据

desktop-application-plan §14 D2 的退出标准分两类。可由代码与 CI 判定的：

| 退出标准 | 证据 |
| --- | --- |
| WebView 无任意 Tauri Command/Shell | `capabilities/default.json` `permissions: []`；无 shell plugin 依赖；`withGlobalTauri: false` |
| 无关进程占用 3000 时不附着、不杀进程 | `port` 模块单测（`healthz_alone_never_authorises_adoption`、`adoption_requires_every_proof`、`forbidden_actions_stay_forbidden`） |
| 崩溃与退出无孤儿进程（逻辑层） | `supervisor` 单测（`drop_terminates_and_reaps`、`a_panic_still_reaps_the_child`、`shutdown_is_idempotent_and_drop_does_not_repeat_it`） |
| 未签名内部 `.app` | macOS CI 构建产物与 Bundle 内 Sidecar smoke |

**仍需在真实 macOS 桌面会话人工验收的**，CI 无法提供证据：

- 冷启动、重复启动、Sidecar/Tauri 崩溃后的**实际**进程表检查（`pgrep` 无残留）；
- 单实例第二次启动只聚焦既有窗口、不启动第二个 Sidecar；
- 打包 App 内完成 local import、Job、Chat、Citation 的 offline E2E；
- 3000 端口被无关进程占用时的诊断显示与退出行为。

这些条目已进入 `manual-acceptance-checklist.md`。在它们通过之前，D2 不视为退出，desktop-application-plan 的状态也不改为 `Accepted`——`docs/architecture/README.md` 明确要求不得用规划状态替代验证证据。
