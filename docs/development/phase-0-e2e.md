# Phase 0 本地端到端验证

> 状态：Active
>
> 不使用浏览器、真实 NotebookLM、Z-Library 或任何账号凭据。

## 1. 验证目标

本流程验证以下真实边界，而不是只调用单个函数：

```text
CLI
→ FakeDocumentPreparationAdapter
→ 验证确定性的 PreparedDocument / manifest StorageKey
→ ImportBookUseCase
→ FakeKnowledgeAdapter
→ 持久化 RemoteOperation intent
→ FakeKnowledgeAdapter 幂等创建
→ SQLite Unit of Work / migrations / repositories
→ 关闭并重新打开数据库
→ 验证 Book、Job、DocumentPart、Workspace、Source、RemoteOperation 与 JobEvent
```

它对应 [`integration-plan.md`](../architecture/integration-plan.md) 的 Phase 0 退出标准。

## 2. 准备环境

在仓库根目录运行：

```bash
uv sync --locked --all-groups
```

## 3. 执行 E2E

数据库路径和 workspace 目录都必须尚不存在：

```bash
uv run diandian phase0-e2e \
  --database .tmp/phase0-e2e/app.sqlite3 \
  --workspace .tmp/phase0-e2e/workspace
```

命令会先规范化 `~` 和相对路径，并以排他方式创建私有数据库文件与 workspace；任何路径已存在、是符号链接或权限不安全时都会拒绝执行。重复执行前请改用新的路径或手动清理专用测试目录。失败时 stderr 返回结构化 JSON，不输出 Python traceback。

成功时输出 JSON：

```json
{
  "status": "ok",
  "schema_version": 5,
  "part_count": 2,
  "source_count": 2,
  "preparation_manifest_key": "manifests/<asset-id>.json",
  "remote_operation_count": 3,
  "job_event_count": 21
}
```

ID、数据库绝对路径和 progress 数量会随本次运行输出。

## 4. 验证内容

命令只有在以下条件全部满足时才返回退出码 `0`：

- migration 升级到当前 schema version 5（Phase 1 增加文档派生与 manifest，Phase 2 增加生成/下载远程操作类型，Phase 3 增加 Lease、Step checkpoint、Job payload 与远程 Intent lifecycle，Phase 4 增加 Rights audit）；
- Fake Preparation 根据 `TargetCapabilities` 返回确定性的两个 `DocumentPart` 和受限 `manifest StorageKey`；
- Fake Knowledge Adapter 创建 workspace；
- 两个已准备的 `DocumentPart` 均保存并生成 Source 映射；
- 每次远程创建前已保存稳定的 operation intent/idempotency key；
- Source 从 `processing` 进入 `ready`，且 ID、workspace、Part 与 checksum 保持一一对应；
- Job 按顺序完成全部步骤并保存包含 attempt、progress 和错误快照的事件历史；
- Book 最终状态为 `ready`；
- 数据库关闭并重新打开后，所有状态仍可读取；
- `PRAGMA integrity_check` 返回 `ok`；
- business schema 仅保存不透明 `credential_profile`，不存在凭据物理路径或凭据内容字段。

Phase 0 只验证 Fake Preparation 返回的 manifest **逻辑引用**，不伪造 manifest 文件。真实 manifest 内容、原子写入与 `FileStore` 持久化由 Phase 1 的文档处理实现交付。

## 5. 自动化测试

同一链路由以下测试覆盖：

- `tests/e2e/test_phase0_fake_import.py`：子进程 CLI E2E；
- `tests/integration/test_import_workflow.py`：成功、认证/歧义阻塞、有界重试、终止失败、安全取消与 observer 断开；
- `tests/integration/test_sqlite_persistence.py`：事务回滚、migration 校验和、repository、Lease takeover、generation fencing 与乐观锁；
- `tests/contract/test_fake_document_preparation_adapter.py`：Preparation 成功路径、MIME、资产归属、词数和 Source 数量限制；
- `tests/contract/test_fake_knowledge_adapter.py`：Knowledge Ingestion 契约；
- `tests/unit/test_architecture_boundaries.py`：分层依赖约束。

完整执行：

```bash
uv run pytest
```

测试不会安装或启动浏览器，也不会访问真实 Provider。
