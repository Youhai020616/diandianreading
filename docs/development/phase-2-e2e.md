# Phase 2 NotebookLM Adapter 端到端验证 / NotebookLM Adapter E2E

> 状态：Active
>
> 不启动浏览器，不访问真实 NotebookLM/Z-Library，不读取真实账号凭据，也不执行 live-provider smoke。

## 1. 验证目标 / Goal

本流程验证从合法本地 Markdown 到 NotebookLM Adapter 问答、生成与本地资产发布的完整进程内 Provider 边界：

```text
CLI
→ LocalFileAcquirer
→ LocalDocumentPreparationAdapter
→ SQLite import Job + pre-call RemoteOperation intent
→ NotebookLMAdapter
→ deterministic in-process NotebookLM SDK double
   ├→ Notebook create
   ├→ Source upload + wait
   ├→ grounded ask + citations
   ├→ report generate + wait
   └→ report download
→ private staging
→ LocalFileStore atomic publication
→ SQLite/Object Store reopen and invariant checks
```

真实边界包括 SQLite schema v3、Acquisition、Markdown Preparation、私有对象存储、公开 SDK Adapter 的调用形状、凭据路径解析、Client 生命周期、引用映射和生成资产发布。只有最外层 Provider RPC 被确定性 SDK double 替代。

## 2. 依赖与公开 API 边界 / Dependency Boundary

生产依赖固定为：

```toml
dependencies = ["notebooklm-py==0.8.0rc1"]
```

Phase 2 不复制只读参考 SDK 的 1,244 个文件，也不安装其浏览器 extra。主应用生产代码只导入：

- `notebooklm.NotebookLMClient`
- `notebooklm.exceptions`

`tests/unit/test_architecture_boundaries.py` 拒绝主应用中的任何 `notebooklm._*` 导入。Adapter 不执行 `notebooklm use`，不通过 shell/JSON stdout 集成，并为每次调用显式传入 Notebook ID。

`NotebookLMClientFactory` 只通过公开的 `NotebookLMClient.from_storage(path=...)` 上下文管理器创建 Client，并配置正数且有限的 RPC/chat timeout、rate-limit/server retry、上传并发与 RPC 并发。一个 `NotebookLMAdapter` 绑定一个 event loop，每个逻辑 Profile 最多缓存一个 Client，退出 Adapter 上下文时显式关闭。

## 3. 凭据隔离 / Credential Isolation

业务层只传递：

```python
CredentialRef(provider="notebooklm", profile="<opaque-profile>")
```

`CredentialPathResolver` 在 Infrastructure 内映射到：

```text
<credentials-root>/notebooklm/profiles/profile-<sha256(profile)前32位>/storage_state.json
```

Resolver 强制：

- provider 必须为 `notebooklm`；
- 所有对象位于受管凭据根目录内；
- Profile 原文不参与路径拼接；
- 目录为当前用户所有、非符号链接且权限不宽于 `0700`；
- storage state 为当前用户所有的普通非符号链接文件，权限不宽于 `0600`；
- 打开前后 inode/device 保持一致；
- JSON 非空、不超过 16 MiB，并包含 `cookies` 列表；
- 缺失或无效会话只返回固定脱敏 `AUTH_REQUIRED`，不泄露 Cookie、账号或绝对凭据路径。

E2E 创建的 storage state 仅是空 Cookie 的合成 fixture。它用于证明路径和生命周期边界，不代表已登录，也不证明真实 Google 会话有效。

## 4. 执行 E2E / Run

先安装锁定依赖：

```bash
uv sync --locked --all-groups
```

四个输出路径必须彼此分离且尚不存在：

```bash
uv run diandian phase2-e2e \
  --database .tmp/phase2-e2e/state/app.sqlite3 \
  --object-root .tmp/phase2-e2e/objects \
  --credentials-root .tmp/phase2-e2e/credentials \
  --workspace .tmp/phase2-e2e/workspace
```

成功时 stdout 返回结构化 JSON：

| 字段 | 不变量 |
| --- | --- |
| `status` | `ok` |
| `schema_version` | `3` |
| `book_count` | `1` |
| `part_count` | 至少 `1` |
| `source_count` | 等于 `part_count`，且全部 ready |
| `citation_count` | 等于 `source_count`，每条引用映射回本地 `DocumentPart` |
| `generated_content_count` | `1` |
| `downloaded_asset_count` | `1` |
| `remote_operation_count` | `source_count + 3`：Workspace、每个 Source、一次生成、一次下载 |
| `provider_write_intent_count` | 等于 `remote_operation_count` |
| `client_open_count` / `client_close_count` | 均为 `2`，覆盖 Adapter 关闭与重开 |
| `progress_event_count` | 大于 `0` |

输出只包含本次 E2E 数据库路径，不包含 credentials root、storage-state 路径、Cookie 或 Provider 响应。重复执行同一命令会拒绝覆盖任一路径，退出码为 `2`，并在 stderr 返回无 traceback 的结构化错误。

## 5. 问答、引用与重开 / Query and Citation Recovery

E2E 在完成导入后关闭第一个 Adapter，重新打开 SQLite，并创建第二个 Adapter。第二个 Adapter 必须：

1. 通过持久化 `external_workspaces`/`external_sources` 恢复 Workspace 和 Source 关系；
2. 执行带显式 Source ID 的 grounded ask；
3. 将 SDK citation `source_id` 反查为本地 `document_part_id`；
4. 保持 Provider conversation ID 与产品类型隔离。

这证明引用链可以跨 Adapter 生命周期恢复：

```text
NotebookLM citation source_id
→ external_sources.external_id
→ document_part_id
→ local DocumentPart
```

## 6. 生成与下载格式 / Generated Content

Adapter 当前支持以下 provider-neutral 类型；连字符输入会在指纹中规范化为下划线：

| 类型 | 本地后缀 | MIME |
| --- | --- | --- |
| `audio` | `.mp3` | `audio/mpeg` |
| `video` | `.mp4` | `video/mp4` |
| `report` | `.md` | `text/markdown` |
| `study_guide` / `study-guide` | `.md` | `text/markdown` |
| `quiz` | `.json` | `application/json` |
| `flashcards` | `.json` | `application/json` |
| `infographic` | `.png` | `image/png` |
| `slide_deck` / `slide-deck` | `.pdf` | `application/pdf` |
| `data_table` / `data-table` | `.csv` | `text/csv` |

生成指纹绑定规范化类型和裁剪后的 instructions；下载指纹绑定 `GeneratedContent` 的全部字段（content ID、workspace ID、规范化类型、title、text、remote URL）和目标 `StorageKey`。持久化的只有 SHA-256，不包含正文或 URL 原值。不支持的类型在调用 SDK 前 fail closed。

下载不允许 SDK 直接写入对象存储：Adapter 在私有 `0700` staging root 中创建临时文件，验证普通文件/无符号链接后交给 `FileStore.put()` 原子发布，随后清理 staging。最终 `DocumentAsset` 的 SHA-256 与字节数必须和对象存储重新读取结果一致。

## 7. Intent、幂等与当前恢复边界 / Intent and Recovery Boundary

Schema v3 将 `remote_operations.kind` 扩展为：

```text
ensure_workspace
add_source
generate_content
download_content
```

每个 Adapter 写方法都要求 `RemoteOperationRef`，并校验 kind、local resource ID、完整输入指纹和已知 external ID。E2E 的 `before_call_observer` 在每个 fake Provider 写调用发生前直接查询 SQLite，只有对应 kind 已存在 pending intent 时才允许继续。

已完成的 Workspace/Source operation 会按持久 external ID 调用公开 lookup API 协调；生成 handle 与已发布下载对象也可按 completed operation replay，避免在已知完成时盲目重建。

Phase 2 **不声称完整的 durable workflow recovery 已完成**：

- 生成/下载 E2E intent 暂关联到已完成的导入 Job，因为当前没有独立的 Generation Job state machine；
- `pending → dispatched → completed/reconciliation_required` 的崩溃边界尚未全部建模；
- Lease heartbeat、generation fencing、retry/cancel/resume、部分上传恢复和 ambiguous remote outcome 人工解歧属于 Phase 3；
- 真实 Provider 在“请求已落地但响应丢失”时的可探测性尚未通过 live smoke 证明。

因此，本 E2E 证明“调用前有 intent、已知完成不盲目重建”的 Phase 2 Adapter 契约，不替代 Phase 3 的进程终止恢复测试。

## 8. 自动化验证 / Automated Checks

主要测试：

- `tests/contract/test_knowledge_adapters.py`：Fake 与 NotebookLM Adapter 共用的 ingestion/query/generation/download 契约、九类格式和 completed-operation reconciliation；
- `tests/unit/test_notebooklm_client_factory.py`：公开 context manager、超时/重试/并发配置与生命周期；
- `tests/unit/test_notebooklm_credentials.py`：哈希 Profile、confinement、权限、所有权、符号链接、TOCTOU 与 storage-state JSON；
- `tests/unit/test_notebooklm_errors.py`：公开 SDK 异常到固定脱敏产品错误的映射；
- `tests/unit/test_notebooklm_adapter_security.py`：输入绑定、错误状态、staging/download、防路径泄漏、event-loop 和 close 失败；
- `tests/e2e/test_phase2_notebooklm_adapter.py`：子进程 CLI、SQLite reopen、引用恢复、Intent 顺序、Client close、对象校验和拒绝覆盖；
- `tests/unit/test_architecture_boundaries.py`：禁止所有 `notebooklm._*` 私有模块依赖。

完整本地门禁：

```bash
uv run ruff format --check src tests
uv run ruff check src tests
uv run mypy src/diandianreading
uv run pytest
uv run --isolated --python 3.11 pytest
uv run --isolated --python 3.14 pytest
uv lock --check
uv build --no-build-isolation
```

CI 将 wheel 连同生产依赖安装到新的 Python 3.12 虚拟环境，并依次运行 `phase0-e2e`、`phase1-e2e` 与 `phase2-e2e`。默认测试和 CI 不安装浏览器、不发起 live-provider 调用，也不注入真实凭据。

## 9. 当前验证证据 / Validation Evidence

2026-08-03 的 Phase 2 本地门禁：

- Ruff format/lint：通过；
- strict mypy：44 个 source files 无问题；
- Python 3.11、3.12、3.14：各 `141 passed`；
- branch coverage：`90.36%`；
- `uv lock --check`：通过；
- sdist/wheel build：通过；
- source Phase 0、1、2 E2E：全部通过；Phase 2 为 2 Parts、2 ready Sources、2 Citations、1 份生成内容、1 个下载资产、5 个 completed remote intents；
- isolated installed-wheel Phase 0、1、2 E2E：全部通过，且实际解析安装 `notebooklm-py==0.8.0rc1` 及其生产依赖；
- wheel 内容：包含 `0001_initial.sql`、`0002_document_preparation.sql`、`0003_notebooklm_operations.sql`、`epub_worker.py` 和全部 NotebookLM Adapter 模块。

这些证据不包含浏览器或真实 Provider 测试。GitHub CI 状态以 Phase 2 PR checks 为最终依据。
