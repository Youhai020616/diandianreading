# Vendored 第三方源码移除记录 / Removed Vendored Sources

> 状态:Active
>
> 最后更新:2026-08-03

## 1. 移除了什么

- `source/notebooklm-py/`:非官方 NotebookLM Python SDK 的 vendored 副本。上游:[teng-lin/notebooklm-py](https://github.com/teng-lin/notebooklm-py)。
- `source/zlibrary-to-notebooklm/`:Legacy Z-Library 脚本的 vendored 副本。上游:[zstmfhy/zlibrary-to-notebooklm](https://github.com/zstmfhy/zlibrary-to-notebooklm)。
- `.github/workflows/provider-auth.yml`:只针对上述 vendored 目录的登录单测 workflow。
- `pyproject.toml` 中 `[tool.uv.workspace]` 的 `exclude = ["source/*"]`。

## 2. 为什么移除

- 产品运行时依赖的是 **PyPI 上的 `notebooklm-py==0.8.0rc1`**(见 `pyproject.toml`),不是 vendored 副本;Z-Library 能力由自研的 `src/diandianreading/infrastructure/acquisition/zlibrary/` 实现,不调用 Legacy 脚本。
- vendored 副本约 65MB,且带一条独立 CI;其中的修改(见 §3)不在任何运行时路径上,持续维护只会加深"看似在用、实际没用"的误导。
- 参考价值由 git 历史与上游仓库完整保留,不需要工作区副本。

## 3. 曾经落在 vendored 副本里的修复

`fix(auth): stabilize provider login flows`(main 上的提交 `88d0da8`)修改过 vendored 副本的登录逻辑与测试,共 15 个文件、+630/-105,主要包括:

- `notebooklm-py`:`_auth/browser_capture.py`、`cli/services/playwright_login.py` 及对应单测;
- `zlibrary-to-notebooklm`:`scripts/login.py` 大幅重写(+203 行,加入 argparse 与稳定性处理)、`scripts/upload.py`、CI 依赖锁与文档。

**这些修复不在产品运行路径上**(运行时用 PyPI 包)。完整内容随时可从 git 历史恢复:

```bash
git show 88d0da8 -- source/
```

## 4. 待办

- [ ] 评估 `88d0da8` 中 notebooklm-py 侧的登录修复是否仍适用于上游最新版;若适用,向 [teng-lin/notebooklm-py](https://github.com/teng-lin/notebooklm-py) 提交上游 PR,或在确有运行时需要时改为依赖自维护 fork 的发布包。
- [ ] 升级 `notebooklm-py` 依赖版本时,核对上游是否已包含等价修复。

## 5. 对文档的影响

`docs/api.md`、`docs/architecture/integration-plan.md`、ADR-0002、ADR-0005 中原指向 `source/` 的相对链接已改为指向上游仓库;上游 `main` 分支内容可能随时间偏离本仓库固定的 `0.8.0rc1`,以 PyPI 固定版本为运行时事实。
