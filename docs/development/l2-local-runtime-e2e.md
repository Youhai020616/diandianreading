# L2 Browser Setup、Doctor 与安全 Reopen E2E

> 状态：Active
>
> 范围：App Home 管理的 Playwright Chromium、`setup notebooklm`、`doctor`、`open`、Install Token 丢失恢复与 Bearer nonce endpoint；真实 Provider 登录由维护者手工执行。

## 用户命令

```bash
diandianreading --home ~/.diandianreading setup notebooklm
diandianreading --home ~/.diandianreading doctor
diandianreading --home ~/.diandianreading open
```

自动化：

```bash
diandianreading --home <home> setup notebooklm --yes --json
diandianreading --home <home> doctor --json
diandianreading --home <home> open --json
```

`open --print-url` 只用于明确需要手工传递的场景；它会在 stderr 警告 URL 是短时一次性凭据。普通 `open` 不把 Nonce 写入 stdout。

## Browser Runtime

- Python 发行依赖固定 `playwright==1.61.0`；
- Chromium 不进入 wheel；
- setup 调用当前 Python 环境的 `python -m playwright install chromium`；
- `PLAYWRIGHT_BROWSERS_PATH` 指向 App Home 的 staging；
- 完整 revision 发布到 `browsers/playwright-1.61.0/`；
- manifest 记录格式、Playwright 版本、revision、executable 相对路径、SHA-256 与安装字节；
- executable 必须是 confinement 内的可执行普通文件；
- 旧版本替换采用同文件系统 rename，失败恢复上一完整版本；
- staging/previous 残留在成功或失败后清理；
- Web Runtime 只在 manifest 验证通过时设置 `PLAYWRIGHT_BROWSERS_PATH`。

## Doctor

Doctor 不访问 Provider 网络，输出：

- package 版本；
- App Home：missing/ready/unsafe；
- SQLite：missing/present；
- static assets：ready/missing；
- port 3000：available/occupied；
- Install Token：missing/ready/unsafe；
- NotebookLM profile：missing/present；
- Chromium：ready/missing/corrupt/version_mismatch/support_missing；
- Z-Library 默认状态。

Chromium missing 是非阻塞状态：本地阅读、标注和 Obsidian 仍可用。unsafe/corrupt/static missing 返回非零。

## 安全 Reopen

```text
local CLI reads private Install Token
→ POST /api/session/bootstrap-nonces with Bearer
→ server verifies Peer + Host + exact Bearer
→ browser-session caller is rejected
→ server returns one short-lived nonce with no-store
→ CLI places nonce in URL Fragment
→ browser consumes nonce once
```

`/healthz` 不参与身份判断。未知进程占用 3000、错误 Token、错误响应形状和超长/不安全 Nonce 都 fail closed。

## Token 丢失恢复

Runtime 在创建 InstallTokenStore 前检查 token file：

- 首次安装：创建新 Token，数据库没有旧凭据；
- 既有 Token 丢失：创建新随机 Token，并以 `security_recovery` 撤销数据库中全部 Browser Session、消费全部未使用 Bootstrap Nonce；
- Token 文件损坏/链接/权限错误：不重建、不降级无认证，启动失败；
- 旧 Bearer、Session、Nonce 均不可恢复使用。

## 自动化证据

- `tests/unit/test_browser_runtime.py`：安装、manifest/hash、损坏、版本漂移、原子替换、失败恢复和 symlink；
- `tests/unit/test_cli.py`：setup 确认、doctor、open Secret 输出；
- `tests/integration/test_local_api_app.py`：Bearer nonce endpoint、浏览器拒绝、one-time consume；
- `tests/integration/test_local_api_security.py`：Token 丢失后的 Session/Nonce 全撤销；
- `tests/web_process_smoke.py`：installed CLI 对真实已运行服务执行 `open --print-url` 并消费 Session。

## 手动验收

维护者最后执行：

```bash
uv run diandianreading --home .tmp/manual-home setup notebooklm
uv run diandianreading --home .tmp/manual-home web
```

检查真实下载大小、代理行为、Chromium 启动和 NotebookLM 登录。自动化不把 Fake Browser 结果描述为 live Provider 兼容。
