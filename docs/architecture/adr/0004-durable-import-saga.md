# ADR-0004: 资料导入使用持久化 Saga/Job 状态机

## Status

`Accepted`

## Date

2026-08-03

## Context

完整资料导入包含多个本地和远程步骤：

```text
获取文件
→ 原子保存
→ 解析/转换
→ 分块
→ 创建 Notebook
→ 上传多个 Source
→ 等待处理
→ 验证
```

每一步都可能耗时、失败或产生部分副作用。当前 `zlibrary-to-notebooklm` 在单个进程调用中顺序执行全部步骤，存在以下问题：

- 进程退出后无法恢复。
- Notebook 创建成功但本地尚未记录时，重试可能重复创建。
- 部分分块失败时，只要一个成功就把整体标为成功。
- HTTP 页面关闭会丢失进度。
- 固定 sleep 不能表达真实状态。
- 临时文件与远程资源没有明确补偿策略。

Roadmap P2 要求任务系统，P4 要求长任务可离开页面继续、失败可重试并显示明确状态。

## Decision

资料导入实现为 **SQLite 持久化 Saga/Job 状态机**，由独立 Worker 执行。API 创建 Job 后立即返回 `job_id`，不在 HTTP 请求生命周期内执行完整导入。

### 正交且穷尽的状态维度

Job 的生命周期、业务步骤、阻塞原因、取消请求和 Worker 租约是不同字段，不能把 `acquiring`、`auth_required` 或 `failed_retryable` 混进同一个状态枚举：

| 维度 | 闭集 | 约束 |
| --- | --- | --- |
| `status` | `queued`、`running`、`blocked`、`completed`、`failed`、`cancelled` | 唯一生命周期状态；未知值由数据库 `CHECK` 与 Domain 拒绝 |
| `current_step` | `acquiring`、`storing`、`preparing`、`creating_workspace`、`uploading`、`processing`、`verifying` | 表示当前或最后执行的业务步骤，不表示成功/失败 |
| `blocked_reason` | `AUTH_REQUIRED`、`REMOTE_OUTCOME_AMBIGUOUS` | 仅 `status=blocked` 时非空；新增值必须同步 Schema、API 与 UI |
| `cancel_requested_at` | nullable timestamp | 与 `status/current_step` 正交；非空只表示已请求，不表示已停止 |
| Lease | `lease_owner`、`lease_expires_at`、`lease_generation` | 仅 `running` 时存在有效值 |
| Error | `last_error_code`、`last_error_detail_redacted`、`retriable` | 诊断/策略字段，不是 Job status |

每个 `job_steps` 行另有闭集 `pending`、`running`、`blocked`、`completed`、`failed`、`cancelled`、`skipped`，并保存输入指纹、attempt、进度、起止时间和输出引用。Job status 是聚合状态，Step status 是某一步执行记录；二者不能互相替代。

允许的 Job 转换穷尽如下：

| From | To | 唯一触发条件 |
| --- | --- | --- |
| `queued` | `running` | Worker 原子 claim 成功并取得新 Lease |
| `queued` | `cancelled` | 尚未执行且取消请求已持久化 |
| `running` | `running` | 仅 Lease heartbeat，或过期 Lease 被原子接管并递增 generation；接管后先 reconciliation |
| `running` | `queued` | 可重试错误已记录，未超过 attempt/max elapsed，并设置 `not_before` |
| `running` | `blocked` | 需要外部动作；设置闭集中的 `blocked_reason` 并释放 Lease |
| `running` | `completed` | 全部完成条件验证通过 |
| `running` | `failed` | Terminal 错误或重试预算耗尽 |
| `running` | `cancelled` | 到达安全点、无待判定远程结果且清理完成 |
| `blocked` | `queued` | 阻塞条件被明确验证已解除；从原 Step 恢复 |
| `blocked` | `cancelled` | 无待判定远程结果且取消清理完成 |
| `failed` | `queued` | 仅显式用户重试；创建新的 attempt 记录并保留历史 |

`completed` 与 `cancelled` 不再转换；任何未列出的转换都非法。Provider 认证失败记录 `last_error_code=AUTH_REQUIRED` 并进入 `status=blocked, blocked_reason=AUTH_REQUIRED`，不消耗后台无限重试。Provider 健康检查确认重新认证后才可回到 `queued`。

### Claim、Lease 与失效 Worker

- Worker 通过单个条件更新 claim 到期可运行的 `queued` Job；第一阶段允许单 Worker，但 Schema 必须保留 Lease 语义。
- `running` Job 持有 owner、到期时间和单调递增的 `lease_generation`（fencing token）。Heartbeat 与所有 checkpoint 更新都必须匹配 owner + generation；旧 Worker 恢复运行后不能覆盖新 Worker 的状态。
- Lease 到期不等于失败、取消，也不证明远程调用没有发生。新 Worker 以原子 compare-and-swap 接管并递增 generation 后，必须先检查当前 Step 和所有未决远程 Intent，再继续工作。
- 转入 `queued`、`blocked` 或终态时清空 Lease。`not_before` 只控制可重试调度，不承担认证等待或取消语义。

### 取消语义

- 取消 API 是幂等的，只持久化 `cancel_requested_at`；不能直接声称已终止 Provider 请求或回滚远程副作用。
- `queued/blocked` 且没有未决远程结果时可以清理 Job 临时区后进入 `cancelled`。
- `running` Worker 在每个安全点以及远程调用前后检查取消请求；一旦看到请求，不再启动新的远程操作。
- 如果取消发生在远程调用进行中或结果不确定时，先持久化已返回的外部 ID，或进入 reconciliation。结果仍不明确时保持 `blocked/REMOTE_OUTCOME_AMBIGUOUS`；确认远程结果并记录后才进入 `cancelled`。
- 只有 Provider 明确提供可安全重放的取消契约时才调用远程 cancel，并把它作为独立远程 Intent。取消本地 Job 默认不删除已创建 Notebook/Source。

### 远程操作 Intent、关联键与 reconciliation

每个可能产生远程副作用的逻辑操作（创建 Notebook、添加每个 Source、生成 Artifact、导出、分享、远程取消等）都必须有持久 `remote_operation_intents` 行，至少包含：

```text
id, job_id, step_id, provider, credential_profile,
operation_kind, correlation_key, input_fingerprint,
probe_strategy, baseline_snapshot_redacted,
state, dispatch_attempt, external_id,
request_summary_redacted, created_at, dispatched_at, resolved_at
```

`correlation_key` 对同一 Job execution generation 内的逻辑操作唯一且可确定重建，例如由 Job、Step、Part 与操作类型组成；它首先是本地审计/去重键。除非 Provider 文档和当前 SDK 明确支持对应 idempotency key，不能假设该键会被 Provider 去重。

Intent `state` 是闭集：`prepared`、`dispatched`、`ambiguous`、`succeeded`、`reconciled`、`failed_terminal`、`cancelled_before_dispatch`。`dispatched/ambiguous` 都是未决状态；`succeeded/reconciled/failed_terminal/cancelled_before_dispatch` 是已解析状态。未知值由数据库和 Domain 拒绝。

调用协议固定为：

1. 在数据库事务中创建或读取唯一 Intent，保存输入指纹和脱敏请求摘要，提交 `state=prepared`；这一步发生在任何 Provider 调用之前。
2. 调用前提交 `state=dispatched`、attempt 和时间，再发出请求。即使进程在提交后、实际网络调用前崩溃，恢复时也按“结果未知”保守处理。
3. 收到成功响应后，先把 `external_id` 与 `state=succeeded` 持久化，再完成 Step checkpoint 或启动下一次远程操作。
4. 超时、断连、取消、进程终止或 Lease 丢失留下 `dispatched`/`ambiguous` Intent；恢复时禁止直接重发 create。
5. Reconciliation 优先按已知 `external_id` probe；没有 ID 时使用调用前 baseline、Provider 可观测的稳定标识和 `input_fingerprint` 缩小候选。找到唯一匹配则持久化为 `reconciled`；多个候选或无法证明唯一性则进入 `blocked/REMOTE_OUTCOME_AMBIGUOUS`，等待显式选择。
6. 只有 probe 能可靠证明远程操作未落地时，才允许在同一 Intent 下记录新 dispatch attempt。Probe 本身失败、不可用或无稳定匹配键时不等于“远程不存在”。

因此 SDK 的单进程 probe-then-create、传输重试或幂等 delete 只是底层能力，不能替代本地 Intent。任何恢复路径都遵守“先 reconciliation，后决定是否重发”，不存在根据“本地 ID 为空”盲目重建。

其他规则：

- 原始文件和成功远程资源默认保留；临时文件必须在成功、确定失败和完成取消时清理。
- 删除远程 Notebook/Source 是显式清理动作，并使用自己的 Intent；不作为普通失败的自动补偿。
- Adapter 抛出类型化异常；Application 记录统一 error code、`retriable`、attempt 和最大 elapsed time。
- 429/临时网络错误执行有界退避；Provider 协议漂移进入 `failed`，不无限重试。
- Job Progress 通过持久记录和事件接口提供给 UI；进程内事件不是唯一状态来源。

建议基础表：

```text
import_jobs
job_attempts
job_steps
remote_operation_intents
document_assets
document_parts
external_workspaces
external_sources
```

Job 完成的必要条件是所有预期 Source ready、每个 Part 映射已持久化且不存在未决 Intent；不能使用“至少一个分块成功”作为完成标准。

## Consequences

### Positive

- 页面关闭和进程重启不会丢失任务。
- 部分副作用可被识别并继续使用，避免重复 Notebook/Source。
- UI 能展示真实 Step、进度、失败原因和重试入口。
- 单个分块可以独立重试。
- 为后续 Artifact 生成、Obsidian 同步和发布 Job 提供一致模式。
- 第三方失败不会回滚或删除本地书籍和用户笔记。

### Negative

- 需要数据库状态机、Intent ledger、Worker、Lease fencing 和 stale-job recovery。
- 每个 Step 与远程操作都必须设计重入、reconciliation 和歧义处理语义，代码量高于顺序脚本。
- 本地和远程没有真正分布式事务，只能通过 Saga 和 reconciliation 保证最终一致。
- 保留失败的远程 Notebook 可能产生孤儿资源，需要清理界面和审计。
- SQLite 单 Worker 简化了并发，但限制吞吐量。

### Follow-up

- 定义带数据库 `CHECK` 的 Job/Step/blocked reason Schema、穷尽转换和错误分类。
- 实现 SQLite claim、Heartbeat、Lease generation fencing 与进程崩溃后的 stale recovery。
- 为每个 Step 定义输入指纹、输出引用和 resume probe。
- 为每类远程写定义 operation kind、唯一 correlation key、调用前 Intent 和 reconciliation strategy。
- 建立进度事件与 `/api/jobs/{id}`，分别返回 `status/current_step/blocked_reason/cancel_requested_at`。
- 实现显式 ambiguous-result resolve、orphan audit 和 cleanup 命令。
- 为关键信号添加 failure-injection tests。

## Step 恢复规则

| Step | 恢复依据 |
| --- | --- |
| `acquiring` | 临时文件完整性和 provider download record |
| `storing` | 原始资产 SHA-256 与原子目标路径 |
| `preparing` | 派生 asset/part manifest 与 checksum |
| `creating_workspace` | 对应 remote Intent、`external_workspaces.external_id`、调用前 Notebook baseline 与远程 probe；未决 Intent 先 reconciliation |
| `uploading` | 每个 Part 独立 Intent、`external_sources` 映射、调用前 Source baseline 与远程列表；不按标题猜测多个候选 |
| `processing` | `wait_for_sources`/Source status；等待超时不创建新 Source |
| `verifying` | 所有预期 Part 与 ready Source 一一对应，且无 `prepared/dispatched/ambiguous` Intent |

## Alternatives considered

### 在 HTTP 请求中同步执行

拒绝。下载、上传和 Source processing 可能超过请求超时，用户离开页面后也无法继续观察或恢复。

### FastAPI `BackgroundTasks`

拒绝作为唯一机制。它没有持久队列、重启恢复、跨进程协调或可靠 checkpoint，适合短暂附带工作，不适合核心导入流程。

### 进程内 `asyncio.Queue`

拒绝作为 source of truth。进程崩溃会丢失排队与运行状态；可作为 Worker 内调度优化，但状态必须落 SQLite。

### 立即使用 Redis + Celery/RQ

暂不采用。local-first 单用户阶段没有吞吐需求；先通过 `JobQueuePort` 和 SQLite 实现验证语义，未来可替换基础设施。

### 失败时自动删除所有远程资源

拒绝。删除可能失败或误删已完成部分，也会让可恢复任务变成必须重做；默认保留并显式清理更安全。

## Validation

本 ADR 的接受条件由 [Phase 3 可恢复 Workflow E2E](../../development/phase-3-e2e.md) 的浏览器无关故障注入实现验证：

- 在 Intent 提交前、`dispatched` 提交后但调用前、Provider commit 后响应丢失、响应返回后 ID checkpoint 前分别终止进程；恢复都不盲目重复创建。
- Notebook 创建后和第 N 个分块上传后终止，恢复时复用已确认资源，不重复前 N 个 Source。
- Source 创建请求超时但远程实际成功时 reconciliation 能识别；零候选、多候选和 probe 失败分别按契约处理，后两者不得重发。
- Job lifecycle、Step、`blocked_reason`、取消请求和 Lease 字段可独立序列化，所有非法转换被拒绝。
- Lease 过期接管会递增 fencing token；旧 Worker 的 Heartbeat、checkpoint 和远程结果写入均失败，接管者先 reconciliation。
- 429、5xx 和网络断开按操作策略重试且有 attempt/max elapsed 上限。
- 认证过期进入 `status=blocked, blocked_reason=AUTH_REQUIRED`，清除 Lease；重新登录经健康检查后从同一 Step 继续。
- 取消在 queued、blocked、远程调用前、调用中和响应后均有故障注入；`cancel_requested_at` 不会把未决远程结果误标为已取消。
- Source processing 超时不会误报完成或新建 Source。
- 用户取消后临时文件被清理，本地原始资产与已记录远程 ID 保留。
- 所有预期 Source ready 且没有未决 Intent 前 Job 不进入 `completed`。

当前自动化覆盖 11 个持久化故障边界、到期 Lease takeover、旧 generation 的 Job/Step/operation fencing、认证恢复、authoritative/ambiguous/confirmed-absence reconciliation、部分 Source 断点恢复和取消解歧。真实 NotebookLM Provider 的 live probe 可观测性仍不作未经验证的保证；`probe_strategy=unsupported` 时按本 ADR 要求进入人工解歧。

## Related

- [集成计划](../integration-plan.md)
- [AI 对话功能设计](../../features/ai-chat.md)
- [ADR-0001](0001-local-first-modular-monolith.md)
- [ADR-0002](0002-notebooklm-public-python-api.md)
- [ADR-0003](0003-provider-credential-isolation.md)
- [ADR-0005](0005-local-api-security.md)
