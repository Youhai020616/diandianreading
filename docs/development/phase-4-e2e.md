# Phase 4 Z-Library 可选 Adapter E2E / Optional Adapter E2E

> 状态：Active
>
> 本阶段不启动真实浏览器、不访问 Z-Library/NotebookLM、不读取真实账号凭据，也不执行 live-provider smoke。真实页面兼容性由用户后续手工验证。

## 1. 目标 / Goal

Phase 4 将旧脚本中的“浏览器触发下载”思路重构为一个默认关闭、受权利声明和不可信输入策略约束的 Acquisition Adapter：

```text
explicit per-item RightsProvenance
→ Application gate persists attestation
→ real browser session marker check
→ versioned selector + expect_download()
→ cancel Playwright transfer
→ pinned HTTPS bounded streamer
→ PDF/EPUB identity + archive preflight
→ private FileStore atomic publish
→ bind final SHA-256 to RightsProvenance
```

Z-Library Adapter 不导入、不调用 NotebookLM，也不提供任意 URL 的通用下载接口。NotebookLM 上传仍通过独立 Knowledge Adapter；Phase 5 已在保持该边界的前提下把二者编排进统一用户入口。

## 2. 已实现边界 / Implemented Boundaries

### 2.1 Rights gate

`ZLibraryAcquisitionUseCase` 在任何 Adapter 调用前要求：

- Adapter 和 `CredentialRef` 的 Provider 都是 `zlibrary`；
- 功能由调用方显式启用，默认值为关闭；
- `rights_confirmed` 必须逐项显式为 `true`，没有默认确认；
- `attestation_version` 必须等于当前 `zlibrary-rights-v1`；
- `rights_basis` 属于闭集，并满足 license/evidence 策略；
- 来源定位经过 Adapter canonicalization/redaction；
- `RightsProvenance` 先提交 SQLite，再允许 Adapter 下载；
- 成功 Asset 的 origin、脱敏 locator 和 rights ID 必须与请求一致；
- 最终下载 SHA-256 通过版本化 transition 绑定，并写入 append-only event history。

Adapter 失败时保留未绑定的审计记录，但不会返回成功 Asset。

### 2.2 URL、DNS 与浏览器网络

`ZLibraryNetworkPolicy` 对初始 URL、每次 Redirect、浏览器导航/子请求和最终下载重复执行：

- HTTPS only、端口仅 `443`；
- 精确、规范、小写 ASCII Host allowlist；
- 拒绝 userinfo、IP literal、控制字符、反斜线、模糊 path、Traversal 和未批准 Host；
- 每次解析的所有 DNS 地址都必须是公网地址；
- Downloader 直接连接本次验证的 IP，TLS SNI/证书校验仍使用原 Host；
- Chromium 使用预解析 `--host-resolver-rules` 固定允许 Host，并禁用代理/PAC；
- Browser Context 使用 `service_workers="block"` 和全量 `route("**/*", ...)`；
- Cookie 只按目标 domain/path/secure 属性转发，不跨 Origin 携带；
- URL Query 只用于实际请求，不进入 Rights、Asset、CLI E2E 输出或错误消息。

默认生产配置仅允许 `z-library.sk`。如果实际登录或下载需要其他 Host，必须作为显式精确 allowlist 变更评审，不能切换成 wildcard。

### 2.3 Session/Profile

Z-Library Profile 映射为：

```text
<credentials-root>/zlibrary/profiles/profile-<sha256(profile)[:32]>/
├── browser_profile/
└── storage_state.json
```

规则：

- `browser_profile/` 是会话 source of truth；
- `storage_state.json` 只作为私有 snapshot/诊断，不以文件存在判定登录成功；
- 登录和健康检查必须访问受策略保护的页面，并命中版本化 authenticated marker；
- Profile 目录/文件要求当前用户所有、`0700/0600`、无符号链接且位于 Provider 根目录；
- Z-Library logout 只删除对应哈希 Profile，不删除 NotebookLM 根目录；
- Domain、Application、SQLite 和 CLI 输出只看到 `CredentialRef(provider, profile)`，不看到物理路径。

### 2.4 Playwright 下载边界

`PlaywrightZLibraryBrowser` 通过 lazy import 使用固定 optional dependency `playwright==1.61.0`：

```python
async with page.expect_download() as download_info:
    await reviewed_locator.click()
download = await download_info.value
url = download.url
await download.cancel()
```

Playwright 只负责把本次已验证用户动作关联到下载 URL；捕获后立即取消其 transfer。实际字节由应用自己的 bounded downloader 获取，避免依赖浏览器临时下载和扫描 `~/Downloads`。

默认安装不导入或安装浏览器二进制。需要手工验证真实页面时，显式安装：

```bash
uv sync --extra zlibrary
uv run playwright install chromium
```

本仓库自动化没有执行上述浏览器安装命令。

### 2.5 Bounded download 与文档检查

Downloader 执行：

- 手动 Redirect 和有限跳数；
- DNS pinning、系统 CA、Host/SNI 校验；
- 无代理、无 Authorization fallback；
- Header 数量/总字节、`Content-Length` 和实际流式字节硬上限；
- connect、first-byte、idle、total timeout；
- 仅接受 `application/pdf` 与 `application/epub+zip`；
- 拒绝压缩 Content-Encoding、HTML 登录页、空文件、长度冲突和 filename/MIME/magic 冲突；
- 私有随机 staging，远程 filename 只生成清洗后的 display metadata；
- SHA-256、`FileStore.put()` 原子发布和任意失败清理。

EPUB 在发布前检查中央目录、Entry 数量/单项/总解压大小、压缩比、深度、名称长度、Traversal、Unicode/大小写碰撞、加密 Entry 和 symlink/device 等非普通 Entry。它不提取 Archive，也不递归解析内嵌 Archive。后续正文解析继续使用 Phase 1 的隔离 Worker、无网络与资源上限。

### 2.6 Legacy migration

`ZLibraryLegacyProfileMigrator`：

1. `inspect()` 只通过 metadata 检测 `browser_profile/`、`storage_state.json` 和 `config.json`；
2. `config.json` 可能含明文邮箱/密码，只告警，绝不打开、复制、打印或写入数据库；
3. dry-run 不创建目标 Profile，也不调用浏览器；
4. 正式迁移要求独立显式确认；
5. 拒绝 symlink、错误类型/owner/权限；
6. 复制到 managed-root 私有 staging；
7. 使用真实 session marker validator 检查副本；
8. 只有验证成功才 atomic rename 发布；失败时清理 staging，旧目录保持不变；
9. 源目录默认保留；删除 `config.json` 是另一项独立确认操作，仍只检查 metadata 后 unlink。

普通 unlink 不能保证 SSD、快照或备份中的历史副本被安全擦除；如果旧密码可能暴露，应在 Provider 侧轮换。

## 3. 本地 E2E / Local E2E

```bash
uv run diandian phase4-e2e \
  --database .tmp/phase4-e2e/state/app.sqlite3 \
  --object-root .tmp/phase4-e2e/objects \
  --credentials-root .tmp/phase4-e2e/credentials \
  --workspace .tmp/phase4-e2e/workspace
```

四个路径必须彼此分离且尚不存在。命令只使用 `.invalid` URL、Fake Browser、Fake DNS 和 Fake pinned transport，不启动浏览器、不访问网络。

确定性输出验证：

| 字段 | 不变量 |
| --- | --- |
| `schema_version` | `5` |
| `default_disabled_gate_verified` | Application 在 Adapter 前拒绝默认关闭请求 |
| `rights_record_count` / `rights_event_count` | `2 / 4` |
| `bound_content_hash_count` | `2` |
| `published_pdf_count` / `published_epub_count` | `1 / 1` |
| `expect_download_count` / `bounded_download_count` | `2 / 2` |
| `legacy_plaintext_config_detected` | `true` |
| `legacy_config_read_count` | `0` |
| `provider_isolation_verified` | `true` |
| `staging_entry_count` | `0` |

stdout 不包含 Cookie、Token、真实/合成 URL Query、credentials root 或 Provider Profile 物理路径。重复使用同一路径返回退出码 `2`，不覆盖已有数据。

## 4. 自动化测试 / Automated Tests

主要覆盖：

- `tests/unit/test_rights.py`：rights basis、evidence、hash/job binding；
- `tests/integration/test_sqlite_persistence.py`：schema v5、v4→v5、CAS 和 event history；
- `tests/integration/test_zlibrary_acquisition_use_case.py`：Application pre-call rights gate；
- `tests/unit/test_zlibrary_network.py`：URL、Redirect、DNS、Cookie、finite config；
- `tests/unit/test_zlibrary_playwright_browser.py`：fake `expect_download()`、cancel、route 和真实 marker 逻辑；
- `tests/unit/test_zlibrary_downloader.py`：pinned TLS、Redirect、Header、byte/time limits 和清理；
- `tests/unit/test_zlibrary_validation.py`：PDF/EPUB magic 与 Archive attack fixtures；
- `tests/unit/test_zlibrary_credentials_session_migration.py`：Profile 隔离、health、logout 和 no-read migration；
- `tests/integration/test_zlibrary_adapter.py`：完整 Adapter 组合；
- `tests/e2e/test_phase4_zlibrary_adapter.py`：子进程 CLI、结构化输出和拒绝覆盖。

完整门禁：

```bash
uv run ruff format --check src tests
uv run ruff check src tests
uv run mypy src/diandianreading
uv run coverage erase && uv run pytest
uv run --isolated --python 3.11 pytest
uv run --isolated --python 3.14 pytest
uv lock --check
uv build --no-build-isolation
```

还需分别从 source tree 和安装后的 wheel 执行 Phase 0–4 E2E。

## 5. 当前证据与未验证项 / Evidence and Limits

截至 2026-08-03，Phase 4 PR 前本地最终门禁结果：

- Python 3.11.13：`280 passed`，branch coverage `90.20%`；
- Python 3.12.11：`280 passed`，branch coverage `90.20%`；
- Python 3.14.2：`280 passed`，branch coverage `90.20%`；
- `ruff format`、`ruff check`：通过；
- strict mypy：61 个 source files，0 errors；
- `uv lock --check`：通过；
- `uv build --no-build-isolation`：成功生成 sdist 和 wheel；
- source tree Phase 0–4 CLI E2E：全部返回 `status: ok`；
- 仅安装基础 wheel、不安装 Playwright extra 的隔离环境中，Phase 0–4 CLI E2E：全部返回 `status: ok`。

GitHub CI 只能在 Phase 4 PR 创建后确认；本节不将尚未运行的远端 checks 声明为通过。

明确未验证：

- 没有启动真实 Playwright/Chromium；
- 没有访问 `z-library.sk`；
- 没有使用真实 Cookie/Profile；
- 没有验证当前 live DOM 是否仍匹配 `zlibrary-dom-v1`；
- 没有执行真实下载或 NotebookLM 上传。

因此当前结论是“安全边界与离线契约通过”，不是“真实 Provider 页面兼容性已通过”。

## 6. Phase 5 接口边界 / Delivered Integration

Phase 4 本身仍不公开用户下载命令或 HTTP 下载 API。Phase 5 已交付：

```text
diandian auth login zlibrary
diandian auth status
diandian import --provider zlibrary <approved-book-url>
diandian jobs ...
/api/imports
/api/jobs/{id}
Web progress UI
```

这些正式入口继续执行相同 rights、credential、network 和 Job 策略，不绕过 Adapter 调用底层 downloader。Z-Library 仍默认关闭，真实 Provider 页面兼容性仍未由自动化验证；详见 [Phase 5 统一产品 E2E](phase-5-e2e.md)。
