# L5 维护者真实验收交接

> 状态：Ready for maintainer execution
>
> 代码侧已完成 L0–L4 可自动化部分；本文件只安排必须在维护者 Mac、真实浏览器、真实账号和真实 Vault 中观察的事项，不预填“通过”。

## 1. 建议环境

先选择一个不会覆盖日常数据的私有 App Home：

```bash
export DIANDIAN_HOME="$HOME/.diandianreading-acceptance"
chmod 700 "$DIANDIAN_HOME" 2>/dev/null || true
```

如果要验证既有生产 App Home 升级，先按 [运维 runbook](../operations/install-upgrade-backup.md) 停机备份；不要直接拿唯一副本做首次测试。

记录：

- macOS 版本与 CPU 架构；
- Python/uv/浏览器版本；
- git commit 或 Preview tag；
- `diandianreading --version`；
- `doctor --json` 的**脱敏类别**（不要附 Token、Cookie、路径或 Profile 文件）。

## 2. 执行顺序

### A. 发行与启动

1. 按当前可用渠道从 source/local wheel/TestPyPI 运行固定版本；
2. 在无源码目录启动 `web`；
3. 验证 readiness 后浏览器才打开；
4. 关闭页面后执行 `open`，确认可建立新 Session；
5. Ctrl+C 后确认服务和 Worker 退出；
6. 测试未知进程占用 3000 时 fail closed，且占用进程未被杀死。

### B. 真实 Chromium setup

```bash
diandianreading setup notebooklm
diandianreading doctor --json
```

记录真实下载耗时、代理行为、最终 installed bytes、Playwright/revision 和冷启动。中途取消一次时，不应留下被识别为 ready 的半成品。

### C. 离线 UI

按 [手动验收总清单](manual-acceptance-checklist.md) §1 完成 Markdown、EPUB、PDF、阅读进度、标注、窄窗、键盘与恶意内容样本。

### D. 真实 NotebookLM

```bash
diandian auth login notebooklm
diandian auth status
```

只导入你有权使用的资料。完成整书/选区/笔记范围问答、断网恢复，并抽样 10 条引用定位。不要在记录中复制账号、Cookie、Provider request、完整回答或书籍正文。

### E. 真实 Obsidian

使用专门的测试 Vault，完成首次导出、文件重命名后重导出、手改冲突保护和 `obsidian://` 深链接。确认产品没有写出 Vault 根。

### F. 内容质量

至少生成三种模板，保留 AI 原稿后各做一次人工修订；记录是否达到“可继续编辑/可发布”，不要把 Fake Provider 文案算作通过。

### G. 可选 Z-Library

只在明确权利边界后启用；验证默认关闭和显式 attestation。不得测试或记录任何绕过 DRM、付费限制、验证码或访问控制的路径。

## 3. 结果文件

在同目录创建 `manual-acceptance-YYYYMMDD.md`：

```markdown
# Manual acceptance YYYY-MM-DD

- Commit/tag:
- macOS/arch:
- Python/uv:
- Browser:
- App Home: isolated / upgraded copy

| Area | Result | Evidence (redacted) | Issue |
| --- | --- | --- | --- |
| Distribution/start/stop | PASS/FAIL/BLOCKED | | |
| Chromium setup | PASS/FAIL/BLOCKED | | |
| Reader/annotation | PASS/FAIL/BLOCKED | | |
| NotebookLM login/import | PASS/FAIL/BLOCKED | | |
| Citation sample (n=10) | x/10 located | | |
| Obsidian reconciliation | PASS/FAIL/BLOCKED | | |
| Three content templates | PASS/FAIL/BLOCKED | | |
| Backup/restore | PASS/FAIL/BLOCKED | | |

## Blocking findings

## Non-blocking observations

## Secrets/privacy review
```

失败项先记录并继续其余无依赖项目；不要在真实环境里边测边临时改数据库或 Credential。

## 4. Stable 判定

只有以下事实同时成立，才能把 L5/Stable 标为完成：

- Preview 索引 clean-machine 安装通过；
- 真实 Chromium/NotebookLM/Obsidian 阻塞项为 0；
- App Home 升级与恢复不丢数据；
- License 与 package ownership 已明确；
- 没有 Secret 出现在 release artifact、日志、截图或验收记录；
- Fake E2E 与 live 结果在发布说明中明确区分。
