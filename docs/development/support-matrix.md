# Distribution Support Matrix

> 状态：Preview candidate；不是 Stable 支持承诺
>
> 原则：区分自动化证据、维护者本机证据与尚未验证，不用 pure-Python wheel 推断完整 Provider 兼容性。

## Python

| Python | 默认 CI | Wheel/process smoke | 状态 |
| --- | --- | --- | --- |
| 3.11 | Ubuntu | unit/integration/offline E2E | Preview candidate |
| 3.12 | Ubuntu；维护者 macOS arm64 | build、isolated install、真实 Uvicorn/static/reopen/SIGTERM | Primary preview candidate |
| 3.13 | Ubuntu | unit/integration/offline E2E | Preview candidate |
| 3.14 | Ubuntu | unit/integration/offline E2E | Preview candidate |

`Requires-Python` 为 `>=3.11,<3.15`，与当前 CI 矩阵一致。增加新 Python 版本前先加入 CI 与 wheel/process smoke，而不是让未知版本安装后失败。

## Operating systems

| OS | 本地 Web/SQLite 自动化 | 受管 Chromium setup | NotebookLM live | 发行结论 |
| --- | --- | --- | --- | --- |
| Ubuntu GitHub runner | 是 | Fake/manifest tests；未做真实下载 | 未验证 | 可作为 Python CI 平台，不等于完整产品支持 |
| macOS arm64（维护者机器） | 是 | 代码/manifest 自动化；真实下载待手工 | 待维护者验收 | Preview candidate |
| macOS x86_64 | 未验证 | 未验证 | 未验证 | 不宣称支持 |
| Windows | 未验证 | 未验证 | 未验证 | 不宣称支持 |

wheel 标记为 `py3-none-any` 只说明项目自身没有编译扩展；Playwright Chromium、Provider 登录、文件权限与浏览器行为仍是 OS-specific。

## Provider 与外部工具

| 集成 | Contract/Fake CI | Live 验证 | 发布表述 |
| --- | --- | --- | --- |
| NotebookLM | 是 | 待维护者手工 | Experimental integration；不承诺第三方持续兼容 |
| Z-Library | 是，默认关闭 | 待合法资料手工 | Optional / disabled by default |
| Obsidian | 路径、冲突与对账自动化 | 真实 Vault 待手工 | Local export preview |
| Chromium | 安装器、hash、confinement、替换恢复测试 | 下载、代理、冷启动待手工 | Explicit setup required |

## Stable Gate

正式支持某个平台前至少需要：

1. 无项目源码的 clean-machine `uvx diandianreading web`；
2. `setup notebooklm` 真实下载与 `doctor` ready；
3. 浏览器 UI 基本流程、Provider 登录和退出；
4. App Home 备份、升级、恢复；
5. installed artifact hash 与版本记录；
6. 对应平台失败后的诊断与回滚记录。

当前没有找到 Windows、macOS x86_64 或真实 NotebookLM 的相关通过依据，因此不把它们包装为已支持。
