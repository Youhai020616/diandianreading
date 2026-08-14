# L1 本地 Web CLI 与真实进程 E2E

> 状态：Active
>
> 范围：`diandianreading web`、旧 `diandian serve` 兼容入口、readiness 后浏览器打开、installed-wheel 真实 Uvicorn 进程；不包含 Chromium setup/doctor/open（L2）。

## 用户入口

规范入口：

```bash
uvx diandianreading web
```

从源码：

```bash
uv run diandianreading --home .tmp/manual-home web
```

持久安装后：

```bash
diandianreading web
```

兼容入口 `diandian serve` 至少保留一个兼容周期，默认继续输出旧 JSON startup record，并在 stderr 提示迁移到 `diandianreading web`。

## 启动契约

- 固定绑定 `127.0.0.1:3000`，规范 Origin 为 `http://localhost:3000`；
- 端口预检失败时不创建 Runtime，不换端口、不附着、不杀占用者；
- 默认输出人类可读的版本、Origin、App Home、Worker 与 Z-Library 状态；
- `--json` 输出有界 startup record；
- `--no-open` 不创建 Bootstrap Nonce；
- 默认模式由 daemon opener 等待 `uvicorn.Server.started`，readiness 成立后才签发一次性 Nonce 并打开浏览器；
- opener 超时或 Server 提前退出时不签发 Secret；
- stdout/stderr 不输出 Bootstrap、Authorization 或 Cookie。

## installed-wheel 真实进程 smoke

CI 从锁定构建工具生成 wheel，安装到隔离 venv 后执行：

```bash
python tests/web_process_smoke.py \
  --command .tmp/ci-wheel-venv/bin/diandianreading \
  --home .tmp/ci-wheel/web/app-home
```

链路：

```text
installed console script
→ real TCP bind
→ /healthz readiness
→ index.html
→ built JavaScript asset
→ SIGTERM
→ FastAPI lifespan stops Worker and closes Runtime
→ process exits
```

Uvicorn 0.52 在完成 graceful lifespan shutdown 后会重新抛出已捕获的终止信号，因此 POSIX 下 `-SIGTERM`/`143` 与 `0` 都是允许的进程返回形态；smoke 仍要求有界时间内退出，超时会 kill 并失败。

## 自动化证据

- `tests/unit/test_cli.py`：CLI 名称、版本、web/serve 输出、端口拒绝、readiness opener 与 Secret 不提前签发；
- `tests/web_process_smoke.py`：安装后真实 TCP/Uvicorn/static asset/termination；
- `.github/workflows/ci.yml`：wheel isolated install 后运行 process smoke；
- 既有 Phase/R/C installed-wheel E2E 继续验证 migration 与业务资源。

## 不属于 L1

- `diandianreading setup notebooklm`；
- `diandianreading doctor`；
- `diandianreading open` 与 Bearer nonce endpoint；
- PyPI/TestPyPI 实际发布；
- 真实 NotebookLM/Obsidian 浏览器验收。
