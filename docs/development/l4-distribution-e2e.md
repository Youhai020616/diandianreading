# L4 Distribution E2E

> 状态：Code-complete / External gates blocked
>
> 范围：root README、发行 metadata、wheel/sdist 审计、本地 wheel uvx process smoke、GitHub pre-release 与 TestPyPI OIDC 工作流；不把未执行的公开上传描述为完成。
>
> Artifact-only Distribution Preview 已在 main commit `5092f3d` 通过：[Actions run 31801072914](https://github.com/Youhai020616/diandianreading/actions/runs/31801072914)。该 run 未创建 tag、GitHub Release 或 PyPI/TestPyPI 上传。

## 自动化链路

```text
build React → verify committed static
→ Python quality gates
→ build wheel + sdist from locked tools
→ inspect archive paths/resources/entry points/private-state exclusions
→ emit release-manifest.json with SHA-256/dependencies/schema
→ uvx --from <local wheel> outside source tree
→ readiness/static/secure reopen/SIGTERM
```

相关实现：

- `tests/distribution_artifact_smoke.py`；
- `tests/markdown_link_smoke.py`；
- `tests/web_process_smoke.py --command-arg ... --working-directory ...`；
- `.github/workflows/ci.yml` 的 local-wheel uvx lane；
- `.github/workflows/release-preview.yml`；
- `.github/workflows/publish-testpypi.yml`。

## Artifact 不变量

- wheel 含 migration `0001`–`0010`、React index/JS、PDF.js worker 与 browser setup 代码；
- wheel 的 console scripts 精确为 `diandianreading` 与兼容 `diandian`；FastAPI、Uvicorn、NotebookLM SDK 与 Playwright direct versions 精确固定；
- wheel 不含 App Home、Credential、Token、SQLite、Chromium revision 或 native executable；wheel/sdist 对私钥头与常见高置信 token 格式执行扫描；
- Chromium 只由用户后续执行 `setup notebooklm` 下载；
- sdist 含 README、CHANGELOG、SECURITY、docs、tests 与构建 metadata；
- release manifest 记录版本、Python 要求、schema、Playwright、direct requirements、build/test lock inventory、文件大小与 SHA-256；不把它误称为终端用户动态解析环境的 SBOM。

## 发布权限

- 默认 CI 权限保持 `contents: read`，不持有 Provider 或 PyPI Secret；
- GitHub pre-release job 仅在手动 boolean 开启后获得 `contents: write`，并要求既有 tag 指向当前 commit；
- TestPyPI publish job 与 build job隔离，只有 publish job 获得 `id-token: write`；
- TestPyPI workflow 要求精确确认字符串、既有 `v<version>` tag、GitHub Environment 与 Trusted Publisher；
- 不提供 Stable PyPI workflow，避免在 License 未决定时误发布。

## 尚未通过的外部 Gate

1. 维护者决定 License 并提交 `LICENSE`；
2. 确认/取得 PyPI 与 TestPyPI package ownership；
3. 配置 `testpypi` Environment、reviewer 与 OIDC Trusted Publisher；
4. 创建不可变 tag 并实际运行 Preview workflows；
5. 在无源码机器从 TestPyPI/PyPI 执行 `uvx diandianreading web`；
6. 完成真实 Chromium、NotebookLM、Obsidian 和浏览器 UI 验收。

PyPI project URL 在 2026-08-14 的检查结果为 404；它只表示当时没有公开项目页，不能当作名称 reservation 或 ownership 证据。

## 本地验证命令

见 [发布流程](release-process.md)。平台证据见 [支持矩阵](support-matrix.md)，升级与数据恢复见 [运维 runbook](../operations/install-upgrade-backup.md)。
