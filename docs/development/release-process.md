# Distribution and Release Process

> 状态：Preview-ready / Stable blocked
>
> 当前版本：`0.1.0`（尚无公开 release/tag）

## 1. 当前 Gate

| Gate | 状态 | 依据 |
| --- | --- | --- |
| Canonical package/command `diandianreading` | Candidate | `pyproject.toml` 与 CLI 已一致；2026-08-14 检查 PyPI project URL 返回 404，但这**不证明名称已保留或可由本仓库取得** |
| License | **Blocked** | 当前 metadata 是 `Proprietary`，没有开源 License；维护者尚未决定公开 Stable 分发授权 |
| Python | Preview candidate | 3.11/3.12/3.13/3.14 CI，见 [Support Matrix](support-matrix.md) |
| OS / Provider | Partial | Ubuntu 自动化、维护者 macOS arm64 代码验证；真实 Chromium/NotebookLM/Obsidian 待手工 |
| TestPyPI Trusted Publisher | Needs repository setup | workflow 已准备，但 TestPyPI project/environment/OIDC trust 需维护者配置 |
| PyPI Stable Trusted Publisher | Not configured | License 与 Preview gate 通过前不创建 Stable publish workflow |

因此：可以构建、审计本地 candidate 和创建 GitHub pre-release；不能把 Stable PyPI 描述为完成。

## 2. 本地构建

```bash
uv sync --locked --all-groups
(cd apps/web && pnpm install --frozen-lockfile && pnpm test && pnpm build)

# 确认 committed static 与 build 一致后
uv run --frozen ruff format --check .
uv run --frozen ruff check .
uv run --frozen mypy src/diandianreading
uv run --frozen pytest -q
uv build --no-build-isolation

uv run --frozen python tests/distribution_artifact_smoke.py \
  --wheel dist/diandianreading-0.1.0-py3-none-any.whl \
  --sdist dist/diandianreading-0.1.0.tar.gz \
  --output dist/release-manifest.json
```

artifact smoke 验证：

- migration、React index/JS、PDF.js worker 与 Browser Runtime 代码存在；
- console scripts 只有 `diandianreading` 和兼容 `diandian`；四个 direct runtime requirements 与已评审版本精确一致；
- wheel 不含 App Home、Credential、SQLite、Chromium 或 native executable；wheel/sdist 还执行私钥头与常见高置信 token 格式扫描；
- wheel 保持有界大小；
- sdist 包含 README、CHANGELOG、SECURITY、docs 与构建 metadata；
- manifest 输出 wheel/sdist/lockfile SHA-256、大小、版本、Python 要求、schema version、Playwright、direct runtime requirements 与完整 build/test lock inventory；后者不是终端用户动态解析环境的 SBOM。

## 3. 本地 uvx candidate smoke

必须在 source tree 外运行，避免 editable import 或当前目录遮蔽 wheel：

```bash
repo="$PWD"
rm -rf .tmp/manual-uvx-home .tmp/manual-uvx-work
mkdir -p .tmp/manual-uvx-work

UV_TOOL_DIR="$repo/.tmp/manual-uvx-tools" \
UV_CACHE_DIR="$repo/.tmp/manual-uvx-cache" \
uvx --from "$repo/dist/diandianreading-0.1.0-py3-none-any.whl" \
  diandianreading --home "$repo/.tmp/manual-uvx-home" web
```

CI 的 `tests/web_process_smoke.py` 会在同类环境验证真实 TCP readiness、静态资源、安全 reopen 与 SIGTERM。

## 4. GitHub Distribution Preview

`.github/workflows/release-preview.yml` 是手动 workflow：

1. 重跑 Python/Web 全量门；
2. 构建 wheel/sdist；
3. 生成 release manifest 与 hashes；
4. 在 source tree 外做 local-wheel uvx process smoke；
5. 上传保留 14 天的 candidate artifact；
6. 只有显式选择 `create_github_prerelease` 时，才允许从**已存在**且指向当前 commit 的 `v<version>` tag 创建 GitHub pre-release。

Workflow 不创建 tag、不移动 tag、不发布 PyPI。创建 tag 前必须确认：

```bash
git status --short
git pull --ff-only origin main
version=$(uv run python - <<'PY'
import tomllib
with open("pyproject.toml", "rb") as source:
    print(tomllib.load(source)["project"]["version"])
PY
)
git tag -s "v$version" -m "diandianreading $version preview"
git push origin "v$version"
```

若维护者没有可用签名 key，不要伪造 `-s` 成功；先决定并记录 tag signing policy。GitHub 侧应保护 release tag，避免移动。

## 5. TestPyPI Preview（OIDC）

`.github/workflows/publish-testpypi.yml` 只接受手动触发：

- 必须输入既有 `v<version>` tag；
- 必须输入精确确认字符串 `publish-testpypi`；
- build 与 publish 分 job；只有 publish job 获得 `id-token: write`；
- 使用 GitHub Environment `testpypi`，建议配置 required reviewer；
- 使用 TestPyPI Trusted Publisher/OIDC，不保存长期 API Token；
- 不允许 `skip-existing`，同版本不可变，失败必须提升版本。

维护者需先在 TestPyPI 完成 project ownership 与 Trusted Publisher 映射：repository、workflow filename `publish-testpypi.yml`、environment `testpypi` 必须精确匹配。未完成配置时 workflow 应失败，而不是退回长期 Token。

上传后在无源码目录验证：

```bash
UV_DEFAULT_INDEX=https://test.pypi.org/simple \
UV_INDEX=https://pypi.org/simple \
uvx --from 'diandianreading==<version>' diandianreading --version
```

TestPyPI 依赖可能不完整，因此使用 PyPI 作为附加依赖索引；必须确认解析到的 `diandianreading` 本体来自 TestPyPI，而不是仅看命令成功。

## 6. Stable PyPI（当前禁止）

以下条件全部满足后才能新增/启用 Stable publish workflow：

1. 维护者明确 License，更新 `pyproject.toml` 并提交对应 `LICENSE`；
2. 确认 PyPI `diandianreading` ownership；
3. TestPyPI clean-machine smoke 通过；
4. [Support Matrix](support-matrix.md) 至少一个 OS 达到 Stable Gate；
5. [手动验收清单](manual-acceptance-checklist.md) 的真实浏览器/NotebookLM/Obsidian 阻塞项为 0；
6. GitHub `pypi` environment 和 PyPI Trusted Publisher 配好 review/OIDC；
7. release manifest、dependency inventory、Secret 扫描结果和 changelog 已归档。

Stable 发布也不得使用长期 PyPI API Token。

## 7. Release 内容

每个 candidate/release 至少附带：

- immutable tag 与 commit；
- CHANGELOG；
- wheel/sdist 和 `release-manifest.json`；
- SHA-256、schema version、migration 说明；
- Python/OS [Support Matrix](support-matrix.md)；
- Playwright 版本与 Chromium setup 方式；
- 已验证/未验证 Provider；
- [安装、升级、备份、恢复与卸载](../operations/install-upgrade-backup.md)；
- 已知问题和撤回策略。

## 8. Yank、撤回与回滚

- 已发布文件和 tag 不覆盖、不重写；修复使用新版本。
- 严重安装/安全问题优先 yank 对应 PyPI 版本并在 GitHub Release 标明，不删除审计证据。
- package 代码回退不等于 schema downgrade；使用已被新版本迁移的 App Home 前先评审 schema compatibility。
- Provider 远程资源不因 release 撤回自动删除。
- GitHub artifact 保留期不是用户备份；用户数据只按运维 runbook 处理。
