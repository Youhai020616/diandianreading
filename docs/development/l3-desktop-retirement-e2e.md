# L3 Desktop Track Retirement E2E

> 状态：Active
>
> 范围：在 L2 Browser Provisioning 与安全 reopen 替代完成后，删除 Tauri/Rust/PyInstaller Sidecar 产品代码和专属 CI。

## 删除范围

- `apps/desktop/`：Cargo workspace、launcher-core、Tauri shell、capabilities、icons；
- `packaging/sidecar/`：PyInstaller build、browser provision、artifact smoke；
- `interfaces/desktop_sidecar.py` 与对应 Python 测试；
- `diandian-desktop-sidecar` console script；
- `desktop-sidecar`、`notebooklm-login`、`zlibrary` 旧 extras；
- PyInstaller dev dependency；
- GitHub Actions 的 desktop change detector、Rust launcher、macOS Sidecar 与 `.app` jobs；
- `.gitignore` 中只服务于 Tauri build 的路径。

D1/D2 E2E 与 ADR-0006/Desktop Plan 不删除：它们被标记为 Historical，用于说明试验结果和退场理由；其中旧命令明确不可在当前仓库执行。

## 保留与替代证据

| 历史能力 | L2/L3 替代 |
| --- | --- |
| Sidecar bundled Chromium | App Home `BrowserRuntimeManager` + `setup notebooklm` |
| Sidecar browser manifest/hash/confinement | `browser-manifest.json` + executable SHA-256 + version-root confinement |
| Sidecar ready control frame | Uvicorn readiness + Bootstrap Nonce |
| 再次启动桌面窗口 | Install Token-authenticated `diandianreading open` |
| Tauri process supervision | 单 Python 进程管理 FastAPI + Worker，SIGTERM process smoke |
| macOS `.app` artifact CI | Linux wheel build + isolated install + real Uvicorn/static/reopen smoke |

## 质量门

```bash
uv lock --check
uv run --frozen ruff format --check .
uv run --frozen ruff check .
uv run --frozen mypy src/diandianreading
uv run --frozen pytest -q
(cd apps/web && pnpm test && pnpm build)
```

额外静态检查：

```bash
test ! -e apps/desktop
test ! -e packaging/sidecar
test ! -e src/diandianreading/interfaces/desktop_sidecar.py
! grep -qE 'desktop-sidecar|pyinstaller' pyproject.toml
! grep -qE 'desktop-(sidecar|launcher|shell)|macos-latest|cargo tauri' .github/workflows/ci.yml
```

## 非目标

- 不删除历史 ADR、计划或 E2E 证据；
- 不恢复 Homebrew、standalone binary 或其他原生壳；
- 不声称完成真实浏览器/NotebookLM/Obsidian 验收；这些仍由维护者按手动清单执行。
