# C1 KnowledgeNote 与 save-as-note E2E

> 状态：Active
>
> 范围：C1 的知识笔记存储、`save-as-note` 幂等与笔记列表；不包含内容生成（C1b）、Obsidian 导出（C2）与创作工作台 UI（C3）。

## 交付边界

- `KnowledgeNote` 是**独立实体**，不是 R2 的锚定标注。产品里有两种"笔记"，且两者都出现在 API 表面：

  | 概念 | 领域类型 | 存储 | 出现位置 |
  | --- | --- | --- | --- |
  | 锚定在正文某处的想法 | `Annotation`（`kind='note'`） | `annotations` | ai-chat.md `query_scope.note_ids`（R4） |
  | 独立的知识条目 | `KnowledgeNote` | `notes` | `save-as-note` 的产物 |

  响应键名是 `knowledge_note` 而非 `note`，路由名 `save-as-note` 沿用 ai-chat.md 已冻结的契约。

- **幂等由数据库保证**。`notes` 上的 `(source_kind, source_id)` 部分唯一索引使同一 message 只可能解析到同一条笔记。仓储在 INSERT 冲突后于**同一 immediate 事务内**回读既有行，因此两个并发请求不会各自认为自己创建了笔记。
- 重复保存返回 `200` 而非 `201`：第二次调用没有创建任何资源，用 `201` 会谎报一次不存在的创建。响应体的 `created` 字段显式区分两者。
- 正文取自 assistant 消息，**用户消息被拒绝**（`422`）。空内容被拒绝；超长正文截断而非报错——用户不该因为模型话多而丢失整条笔记。
- 标题从正文首个非空行派生（折叠空白、剥离 Markdown 标题标记、按码点截断），显式传入的 `title` 优先。Provider 文本是不可信输入，因此标题是**派生**出来的而不是原样复制。

## 本地复现

```bash
uv run --frozen diandian c1-e2e \
  --app-home .tmp/c1/app-home \
  --workspace .tmp/c1/workspace
```

预期输出：

```json
{
  "annotation_notes_excluded": true,
  "knowledge_note_count": 1,
  "repeat_returned_same_note": true,
  "schema_version": 9,
  "status": "ok",
  "unknown_message_rejected": true
}
```

链路：导入 → Worker → Book ready → Conversation → 整本书提问 → Worker → assistant 回答 → `save-as-note`（`201`）→ 再次 `save-as-note`（`200`，同一 ID）→ 列表只含该笔记 → 新建一条**标注**笔记后列表不变 → 未知 message 返回 `404`。

## 退出标准与证据

| 退出标准 | 证据 |
| --- | --- |
| 同一 message 重复 `save-as-note` 返回同一 KnowledgeNote，且不覆盖已存正文 | `test_local_api_knowledge_notes.py::test_saves_an_answer_and_repeats_to_the_same_note`、`test_knowledge_notes.py::test_a_repeat_does_not_overwrite_the_stored_body`、本 E2E |
| 空内容被拒绝，超长正文截断而非报错 | `test_knowledge_notes.py::test_empty_content_is_refused`、`::test_an_oversized_body_is_truncated_rather_than_rejected` |
| 列表按 `(created_at, id)` 确定性分页 | `test_knowledge_notes.py::test_lists_newest_first_and_pages_deterministically` |
| 未知 Book 被拒绝 | `test_knowledge_notes.py::test_an_unknown_book_is_refused` |
| 两种"笔记"不混淆 | 本 E2E 的 `annotation_notes_excluded` |

## 不属于本阶段

内容生成 Job、修订历史与作者归属属于 C1b；Obsidian 导出属于 C2。`ai-chat.md` §3.3 中 `generate-content` 仍标记为 Proposed，`save-as-note` 随本阶段移出。
