# C1b 内容生成 E2E

> 状态：Active
>
> 范围：C1b 的内容生成任务、修订历史与作者归属；不包含 Obsidian 导出（C2）与创作工作台 UI（C3）。

## 交付边界

- **内容资产就是可恢复任务单元**。C0 只按"内容资产"的形状冻结了 `generated_contents`，遗漏了它还要扛住 Worker 崩溃、过期 Lease、取消竞态与模糊结果。migration `0010` 补齐 lease/fencing、取消与 Provider 操作绑定列；**不改写 `0009`**——它已合并且带 checksum 校验，编辑会让所有已迁移数据库校验失败。
- **不复用导入 saga 的 `jobs`/`remote_operations`**。`remote_operations.job_id` 是指向 `jobs` 的 NOT NULL 外键，而 `jobs` 的 `JobStep` 词汇（`acquiring`/`uploading`/…）是文档导入专用的。Chat 早已用同样方式解决过——`chat_runs` 自带意图列——生成沿用该先例，而不是把两条互不相干的生命周期挤进一张表。
- **Fencing 按 generation 而非仅按 owner**。一个卡住的 Worker 超过租约后醒来，仍持有旧 generation，其写入被拒绝，不会覆盖接手者的结果。
- **失败不进入终态**。冻结的生命周期没有 `failed`；一次失败的首次尝试把资产退回 `queued`（仍是可认领任务），已有草稿时则保留 `draft`。这样"重试"不需要额外状态，也不会出现零修订的资产。
- **取消在派发前免费，派发后从晚**。派发后远程产物已经存在，此时中断只会留下孤儿远程任务，因此该次尝试跑完，取消被记录为迟到——与 ai-chat.md 对 Chat 取消竞态的处理一致。
- **修订只追加**。用户编辑产生新的 `human` 修订，模型原稿逐字保留。`author_kind` 进入 API 响应而不是内部字段：用户几个月后必须能回答"这段是不是我写的"。

## 内容类型到 Provider 能力的映射

只有 `quiz` 有直接对应的 Provider 能力；其余六类由 Provider 的 briefing report 产出，靠指令模板区分——播客脚本与分享卡片是同一份摘要的不同编辑形态，不是不同的 Provider 特性。

指令文本是**确定性**拼装的，因为它进入 `generation_input_hash`：这个指纹让重试被识别为同一意图，而不是创建第二份远程产物。

## 本地复现

```bash
uv run --frozen diandian c1b-e2e \
  --app-home .tmp/c1b/app-home \
  --workspace .tmp/c1b/workspace
```

预期输出：

```json
{
  "ai_draft_preserved": true,
  "revision_authors": ["ai", "human"],
  "schema_version": 10,
  "settled_asset_not_reclaimed": true,
  "status": "ok",
  "unknown_message_rejected": true
}
```

链路：导入 → Worker → 提问 → Worker → 回答 → `generate-content`（`202` + `job_id` + 状态 URL）→ Worker 认领并生成 → `draft` 且首个修订 `author_kind='ai'` → 编辑 → `editing` 且修订为 `["ai","human"]`、**AI 原稿逐字未变** → 再跑一轮 Worker 不重复认领已结算资产 → 未知 message 返回 `404`。

## 退出标准与证据

| 退出标准 | 证据 |
| --- | --- |
| 取消竞态不重复创建远程资源 | `test_local_api_content_generation.py::test_cancelling_before_dispatch_stops_the_attempt`、`test_content_generation_repository.py::TestCancellation` |
| 过期 Lease 被重新认领且旧持有者被隔离 | `test_content_generation_repository.py::test_an_expired_lease_is_reclaimed_with_a_new_generation`、`::test_a_stale_owner_cannot_write_after_being_fenced_out` |
| 模糊结果不重复创建远程资源 | `provider_operation_id` 唯一索引 + `ContentFailureCode.PROVIDER_OUTCOME_AMBIGUOUS` 分类 |
| 首个修订 `author_kind='ai'`，用户编辑追加 `human` 修订且原始稿不可变 | `test_editing_appends_a_human_revision_and_keeps_the_original`、本 E2E 的 `ai_draft_preserved` |
| 越界状态转移返回 `422` | `test_content_domain.py::TestPublishingGate`、`test_unknown_content_and_editing_before_a_draft_are_refused` |

## 仍未由本阶段证明的

`scheduled`/`published` 属于 P6 发布轨，domain 保留判别式但由用例拒绝。七类内容里哪些真能"直接用于发布"只能由维护者人工判定，Fake Provider 证明不了——该判断留在 `manual-acceptance-checklist.md`。
