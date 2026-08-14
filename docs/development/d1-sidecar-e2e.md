# D1 Sidecar 与 Playwright 可行性 E2E

> 状态：Historical
>
> L3 已删除这里记录的 Sidecar/PyInstaller 实现与 CI；下列命令只用于追溯当时实验，不再能在当前仓库执行。
>
> 范围：D1 的 Python Sidecar、打包资源和 Playwright Chromium 分发可行性；不包含 Tauri 窗口、单实例或签名/公证。

## 交付边界

- `diandian-desktop-sidecar` 是独立于普通 CLI 的入口；它只接受 `--home`。
- 成功启动时 stdout **只**输出一条长度受限的 `diandian-desktop-v1` `ready` NDJSON 控制帧。该帧含单次 bootstrap nonce，普通日志不得写入 stdout。
- Sidecar 在 frozen 运行时仅从自身 `_internal/playwright-browsers/` 读取 Chromium manifest；资源缺失、清单非法或可执行文件逃逸时 fail closed，绝不回退到开发机或用户的 Playwright cache。
- `packaging/sidecar/build.py` 创建 macOS target-specific PyInstaller `onedir` Artifact，并生成包含所有文件 SHA-256 的 `sidecar-manifest.json`。

## Builder 比较记录

| 候选 | D1 实测 | 结果 | 决定 |
| --- | --- | --- | --- |
| PyInstaller 6.14.1 | macOS 15.4.1 / arm64 / Python 3.12.11；可生成 `Mach-O 64-bit arm64` Sidecar，资源存在、Artifact ready/healthz/shutdown smoke 通过 | 可用 | D1 选择 `onedir`；它允许单独校验 Python、静态资源、浏览器和后续签名输入。|
| Nuitka 2.7.14 | 在同一 macOS arm64 主机执行 `nuitka --version`，识别 Python 3.12.11 和系统 clang 17 | 未进入 Artifact 实验 | D1 明确不选用：它不在锁定依赖集合中，若用 `uvx` 构建会引入与项目锁文件分离的 builder 环境，不满足“干净 CI 可复现依赖集合”门槛。只有将其加入锁定构建工具并完成与同一资源集的 Artifact 实验后，才可重新比较。|

这不是对 Nuitka 的性能否定；只是当前没有满足 D1 可复现性约束的证据，不能将其作为已验证 Builder。

## Playwright 分发决定

D1 测试过浏览器随 Artifact 复制：Playwright Chromium 1228 在源目录约 539 MiB，而复制到 Sidecar 后的实际磁盘占用约 1.2 GiB，完整 Artifact 约 1.4 GiB（macOS App bundle 内的硬链接在复制时展开）。因此：

1. **不将 Chromium 作为默认安装包内容。**
2. 首次受控登录前，由未来 D2 Launcher 调用 `provision_browser.py` 从 Playwright 固定官方来源下载，保存到应用私有、版本化目录并写入 `browser-manifest.json`。
3. 完成 manifest 与可执行文件校验前不启动需要浏览器的 Sidecar 模式；不回退到 `~/Library/Caches` 或开发机已执行的 `playwright install`。
4. 当前 `build.py --browser-root` 仍用于离线 Artifact / CI 可行性验证，验证 PyInstaller 与 Chromium 资源能共存；它不是默认 release packaging 策略。

下载源、代理、升级、磁盘容量提示和清理 UX 归 D2/D4 实现，不能在 D1 假定完成。

## 本地复现

```bash
uv sync --locked --all-groups --extra desktop-sidecar
rm -rf .tmp/d1-browser .tmp/d1-artifact
uv run --locked --extra desktop-sidecar python packaging/sidecar/provision_browser.py \
  --output .tmp/d1-browser
uv run --locked --extra desktop-sidecar python packaging/sidecar/build.py \
  --output .tmp/d1-artifact \
  --browser-root .tmp/d1-browser
uv run --locked python packaging/sidecar/smoke_artifact.py \
  --artifact .tmp/d1-artifact/diandian-desktop-sidecar
rm -rf .tmp/d1-browser .tmp/d1-artifact
```

CI 在 `macos-latest` 重复相同的 provision → build → smoke 流程。真实 NotebookLM/Z-Library 登录、Tauri 生命周期与签名/公证不属于本 E2E，仍需按 D2/D5 受控手工验收。
