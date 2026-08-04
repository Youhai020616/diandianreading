# 内容与创作工作台实施计划 / Content and Workbench Plan

> 状态:Proposed
>
> 目标:把 AI 结果变成可编辑、可复用、可持续积累的内容资产,并给用户一个可拥有的 Obsidian 出口
>
> 架构决策:[ADR-0008](adr/0008-content-and-obsidian-export-model.md)
>
> 最后更新:2026-08-04

## 1. 决策摘要 / Decision Summary

P5 交付 Roadmap 的**知识沉淀与创作 Beta**。本计划把它拆成四个可独立评审、独立 CI 的阶段(C0–C3),编号独立于 git 历史的 phase-0..5、桌面 D0–D6 与阅读器 W0/R1–R4,避免再引入一套冲突编号。

与 Roadmap 的关系:C 轨对应产品 Roadmap 的 **P5(知识沉淀与创作 Beta)**,并补齐 `ai-chat.md` §8.6 中 `save-as-note` 与 `generate-content` 两条 Proposed 路由。

## 2. 范围 / Scope

### 2.1 目标

- 把 AI 回答保存为可编辑的本地 Note,保留来源与幂等;
- 从书籍、章节、笔记或主题生成七类内容,带修订历史与作者归属;
- 导出 Book/Highlights/Notes/Summary/Social Posts 到用户 Obsidian Vault,可重复同步;
- 创作工作台 UI:来源选择、类型选择、语气与长度、结果编辑、版本历史、来源引用、预览、导出。

### 2.2 非目标

- 发布到社交平台(P6 发布轨);`scheduled`/`published` 状态在 domain 中保留但由用例拒绝;
- Obsidian 双向同步与文件监听;
- 冲突文件的合并 UI;
- 自定义 URL scheme(见 ADR-0008 §8,留待 D4);
- 幻灯片 PDF/PPTX 与图片序列渲染(内容类型冻结,但首版只产出 Markdown 结构)。

## 3. 当前基线 / Current Baseline

- `annotations` 与再锚定引擎(R2)、正文与章节服务(R1)已可提供 Highlights 与 Notes 的数据来源。
- `chat_messages` 与本地 `chat_references`(R4)可提供 AI 回答与其引用定位。
- Job/Saga、Lease/fencing Worker 与模糊结果协议(Phase 3,ADR-0004)可直接承载生成任务。
- `schema_version` 当前为 `8`(migration `0008`)。
- **尚不存在**:`notes` 表、内容资产模型、任何文件系统导出能力、Vault 配置。

## 4. 交付阶段 / Delivery Phases

每阶段独立分支、PR、review、CI,前一阶段退出标准通过后才开始下一阶段。串行区文件(migrations、`interfaces/runtime.py`、`interfaces/web/app.py`、`serializers.py`、锁文件、文档索引)遵循[并行交付策略](../development/parallel-delivery-strategy.md)。

### C0:契约冻结(本 PR)

交付:

- ADR-0008;
- 本计划;
- `domain/content.py`:`Note`、`NoteSource`、`GeneratedContent`、`ContentType`、`ContentStatus`、`ContentRevision`、`RevisionAuthor`、`ExportTarget`、`ExportOutcome`;
- migration `0009`:`notes`、`generated_contents`、`content_sources`、`content_revisions`、`obsidian_vaults`、`obsidian_export_state`;
- `schema_version` 推进到 `9`,unit/integration/e2e 三层断言同步;
- 领域不变量单元测试(状态机越界拒绝、作者归属、来源判别式)。

退出标准:

- 只新增表,不改写既有表结构;既有 E2E 不回归;
- 状态机拒绝 `scheduled`/`published` 与所有非法转移;
- `schema_version` 断言三层一致;
- PR CI 绿色。

### C1:Note 与内容生成(Python)

交付:

- `POST /api/messages/{message_id}/save-as-note`,以 `(chat_message, message_id)` 唯一约束保证幂等;
- `POST /api/messages/{message_id}/generate-content` 返回 `202` + `job_id` + 状态 URL;
- `content_generation` Job 类型与 Worker 处理器,复用 Lease/fencing 与取消/模糊结果协议;
- 生成请求字段(来源、格式、语言、目标平台、语气、长度、是否保留引用、是否第一人称)的校验与规范化;
- `docs/development/c1-e2e.md`:Fake Provider 下 保存笔记 → 生成内容 → 修订历史 全链路 offline E2E。

退出标准:

- 同一 message 重复 `save-as-note` 返回同一 Note;
- 生成 Job 的取消竞态、过期 Lease、模糊结果不重复创建远程资源;
- 首个修订 `author_kind='ai'`,用户编辑追加 `human` 修订且原始稿不可变;
- 越界状态转移返回 `422`。

### C2:Obsidian 导出(Python)

交付:

- Vault 路径配置与校验;
- `Book.md`/`Highlights.md`/`Notes.md`/`Summary.md`/`Social Posts/` 导出器与 YAML frontmatter;
- 按 `diandian_id` 的增量对账(路径优先、frontmatter 扫描兜底);
- 手改检测与 `.diandian-conflict.md` 产出;
- 路径消毒与 Vault 封闭断言;
- `obsidian://` 深链接生成;
- `docs/development/c2-e2e.md`:重复导出、重命名、手改冲突、路径逃逸的 offline E2E。

退出标准:

- 同一本书重复导出不新增文件;
- 用户重命名导出文件后再次导出仍定位到原文件;
- 用户手改后再次导出不覆盖,产出冲突文件并在响应中报告;
- 路径逃逸与 frontmatter 注入被拒绝;
- 导出不上传任何数据。

### C3:创作工作台 UI(React)

交付:

- 来源选择(书籍/章节/笔记/主题)、内容类型选择、语气与长度控制;
- 结果编辑器、版本历史与作者归属可视化、来源引用查看、预览;
- 导出到 Obsidian 的入口与冲突提示;
- Vitest 覆盖生成、编辑、修订切换与冲突展示。

退出标准:

- 生成结果可编辑而非只能重新生成;
- AI 原始稿与人工修改稿在 UI 中可区分;
- 至少 3 个内容模板可真实用于发布(由维护者人工判定);
- 浏览器功能测试进入 `manual-acceptance-checklist.md`。

## 5. 测试矩阵 / Test Matrix

| 层 | C0 | C1 | C2 | C3 |
| --- | --- | --- | --- | --- |
| unit | 领域不变量、状态机 | 请求规范化 | 路径消毒、frontmatter 转义 | — |
| contract | — | 幂等与错误码 | 导出响应形状 | — |
| integration | migration 与 schema 版本 | Job 恢复与取消 | 对账与冲突 | — |
| e2e | 既有链路不回归 | c1-e2e | c2-e2e | — |
| vitest | — | — | — | 工作台交互 |

## 6. Definition of Done

- C0–C3 全部退出标准通过,`schema_version` 三层一致;
- Roadmap P5 的四条退出标准有对应证据;
- `ai-chat.md` §3.3 中 `save-as-note`、`generate-content` 移出 Proposed;
- 覆盖率不低于 90% 门槛。

## 7. 仍需证据决定的问题 / Open Evidence Gates

- **生成质量**:七类内容里哪些真能"直接用于发布",只能由维护者人工判定,不能由 Fake Provider 证明。
- **冲突频率**:手改冲突若频繁发生,说明单向导出的定位不成立,需要在 P5 之后重新评估双向同步的必要性。
- **模板落点**:模板是产品内置还是用户可编辑,取决于前三个模板的实际使用反馈。

## 8. 官方依据 / Primary References

- [ADR-0008](adr/0008-content-and-obsidian-export-model.md)
- [ADR-0004](adr/0004-durable-import-saga.md):Job/Saga 与恢复协议
- [AI 对话功能设计](../features/ai-chat.md) §8.6
- [产品 PRD](../../diandianreading-PRD.md) §6.5、§7.4
- [产品 Roadmap](../../diandianreading-ROADMAP.md) P5
