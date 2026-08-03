# R4 Chat 缝合 E2E / Scoped Chat E2E

> 状态:Active
>
> 最后更新:2026-08-03
>
> 本阶段不访问任何真实 Provider;真实 excerpt 形态对引用定位假设的实证见手动验收清单 §2。

## 1. 目标 / Goal

R4 把阅读与标注接入 AI 对话([实施计划](../architecture/reader-annotation-plan.md) §4 R4,语义规范为 [ai-chat.md](../features/ai-chat.md) §4):

```text
selection scope   选区(服务端逐字校验 → supplemental=selection;
                  校验不过 → selection_unverified,绝不伪称已定位)
notes scope       本地标注作为定界补充上下文(note_ids 归属校验、快照+哈希落盘)
citation location Provider excerpt → 本地唯一匹配 → markdown_offset 位置
                  ("sha256:start:end");零/多义命中 → location 保持 null
```

## 2. 运行方式 / How to Run

```bash
uv run diandian r4-e2e --app-home <fresh-dir> --workspace <fresh-dir>
```

自动化断言:

- 集成:`tests/integration/test_chat_scope_use_case.py`(范围解析、三态 source_ids、定界与超限、快照恢复——R4 核心单元交付)
- 集成:`tests/integration/test_local_api_chat_scopes.py`(HTTP:selection 验证/未验证双路径、notes 归属与 worker 期 NOT_FOUND、422 契约、**引用定位全链路**)
- 单元:`tests/unit/test_citation_locator.py`(唯一/零/多义/空白规整/短引述拒绝)
- E2E:`tests/e2e/test_r4_chat_scopes.py`(安装入口全链路)

## 3. 关键决策 / Key Decisions

1. **位置值编码**:`ChatReferenceLocation.value = "{anchor_sha256}:{start}:{end}"`——携带文档身份,客户端可检测 sha 过期后重取正文再跳转。
2. **定位只在完成时本地推导**:Provider 不提供位置;excerpt 在派生 Markdown 中唯一命中(先精确、再确定性空白规整)才写入,失败保持 null 并由 UI 明示,符合 ai-chat.md"不伪造引用"的非目标。
3. **`selection_unverified`**:ai-chat.md §4.4 的 supplemental 枚举新增值——服务端无法在声称的 Part 中确认选区时的如实标记(已在 §4.4 注记)。
4. **chapters 范围仍未开放**(422):EPUB 的章节词汇(解析器 refs)与阅读章节索引(markdown-heading refs)尚未统一,开放会产生错误映射;留待章节统一后实现。
5. 选区→Part 的归属由客户端按章节 ref 匹配提交,服务端以 Part 文本包含性复核;复核失败降级为 `selection_unverified` 而非拒绝(§4.1"不能验证时标记为用户提供的补充上下文")。

## 4. 明确未验证 / Explicitly Not Verified

- 真实 NotebookLM excerpt 的定位命中率(手动验收清单 §2 的抽样项,是本阶段最重要的待实证假设)。
- 30 天上下文快照清理任务(§14.1)尚未实现(`chat_run_contexts.updated_at` 已预留)。
- 阅读器内的选区提问与引用跳转 UI(R4 UI 缝合阶段交付)。
