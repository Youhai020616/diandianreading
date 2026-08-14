# ADR-0008: 内容资产以本地版本化草稿为事实源,Obsidian 导出按稳定 ID 增量对账

## Status

`Proposed`

## Date

2026-08-04

## Context

R1–R4 交付了阅读、标注与带本地引用的 Chat,产品能产生 AI 回答,但回答**没有出口**:既不能沉淀为可编辑的个人知识,也不能变成可发布的内容。PRD §6.5 定义了创作工作台与七类内容,§7.4 把 Obsidian 定位为"用户长期知识的可拥有出口",Roadmap P5 的退出标准要求"生成结果可以编辑而不是只能重新生成""用户能够区分 AI 原始稿和自己的修改稿""Obsidian 文件可重复同步,不产生大量重复文件"。

现有基础决定了设计空间:

- `annotations` 已有 `AnnotationKind.NOTE`,但它**强制绑定 `ContentAnchor`**——那是"正文某处的想法"。AI 回答没有正文锚点,`save-as-note` 无法复用该表而不破坏锚点不变量。
- Phase 3 的持久化 Saga/Job 状态机(`ADR-0004`)、Lease/fencing Worker 与 `AMBIGUOUS_PROVIDER_OUTCOME` 协议已就绪,`generate-content` 不需要另立一套任务机制。
- `ai-chat.md` §8.6 已把 `save-as-note`(以 message ID 为幂等键)和 `generate-content`(返回 `202` + `job_id`)写为目标契约,但两者都是 Proposed,没有路由。
- ADR-0005/0009 冻结了 local Web 安全边界：浏览器不获得原生壳能力，产品不注册自定义 URL scheme。任何“从 Obsidian 跳回应用”的设计不能假设 native handler 存在。

## Threat model

Obsidian 导出是本产品**第一个向用户文件系统写入的功能**,风险与之前的模块不同类:

- **路径逃逸**:导出目录名来自书名/内容标题,是不可信文本(来自 EPUB 元数据或 Provider)。`../` 或绝对路径会写出 Vault 之外。
- **静默覆盖用户劳动**:Vault 是用户会**手动编辑**的可变外部目标。把导出实现成无条件写入,等于每次同步都可能抹掉用户在 Obsidian 里的修改,且不可恢复(Obsidian 无内建版本历史)。
- **Frontmatter 注入**:AI 生成正文若含 `---` 分隔线或 `diandian_id:` 这类键,会污染 YAML frontmatter,使后续对账读到伪造的身份。
- **身份漂移**:用户重命名 Obsidian 文件是正常操作。以文件名为身份的对账会把重命名判定为"新文件",于是重复导出——正是退出标准禁止的"大量重复文件"。
- **AI 内容混入个人知识**:若草稿不区分作者,用户几个月后无法判断哪段是自己写的、哪段是模型生成的(PRD §11.4 的 AI 内容风险)。

## Decision

### 1. `KnowledgeNote` 是独立实体,不复用 `Annotation`

新建 `notes` 表,领域类型为 `KnowledgeNote`。它有 `source_kind`(`chat_message` / `annotation` / `manual`)与 `source_id`,不要求锚点。`save-as-note` 以 `source_kind='chat_message'` + `source_id=message_id` 作为**唯一约束**,因此"重复请求返回同一 Note"由数据库保证,而不是靠应用层查重。

锚定在正文的想法仍然是 `Annotation`;由 Annotation 派生 KnowledgeNote 时保留 `source_id` 指回,两者不互相替代。

**由此产品里存在两种"笔记",且两者都出现在 API 表面**,必须在词汇上分开:

| 概念 | 领域类型 | 存储 | 出现位置 |
| --- | --- | --- | --- |
| 锚定在正文某处的想法 | `Annotation`(`kind='note'`) | `annotations` | ai-chat.md `query_scope.note_ids`(R4) |
| 独立的知识条目 | `KnowledgeNote` | `notes` | `save-as-note` 的产物 |

R4 的 `query_scope.note_ids` 解析的是**标注 ID**,不是 `notes` 表的行。领域类型命名为 `KnowledgeNote` 而非 `Note`,是为了让两者不必靠上下文区分——只叫 `Note` 会让维护者拿着 `note_ids` 去 `notes` 表里查,然后一无所获。路由名 `save-as-note` 沿用 ai-chat.md 已冻结的契约,不单方面改动。

### 2. `ContentAsset` 冻结全状态机,P5 只实现到 `approved`

状态机按 PRD §6.5 冻结为 `queued → generating → draft → editing → approved → scheduled → published`。P5 实现到 `approved`;`scheduled` 与 `published` 属于 P6 发布轨,**在 domain 中保留判别式但由用例显式拒绝**,与 `QueryScopeType.CHAPTERS` 的处理方式一致——保留判别式让越界请求成为显式错误,而不是被静默放宽。

`generate-content` 复用既有 Job/Saga 基础设施,新增 `content_generation` Job 类型,继承 Lease/fencing、取消竞态与模糊结果协议;不新建第二套任务机制。

### 2b. 内容资产同时是可恢复任务单元(C1b 补充)

C0 只按"内容资产"的形状冻结了 `generated_contents`,遗漏了它还要承担**可恢复任务**的职责:C1b 的退出标准要求生成过程能扛住 Worker 崩溃、过期 Lease、取消竞态与模糊结果。`chat_runs` 早已具备这些列,而 `generated_contents` 没有。

migration `0010` 补齐 `lease_owner`/`lease_expires_at`/`lease_generation`/`attempt`/`cancel_requested_at`/`provider_request_started_at`/`provider_operation_id`/`failure_code`/`completed_at`。**不改写 `0009`**:它已合并且带 checksum 校验,编辑会让所有已迁移数据库校验失败。

SQLite 无法给既有表追加 CHECK,重建表又会重写 `0009` 刚建的表。因此 Lease 不变量由仓储与两个部分唯一索引保证——`generated_contents_single_lease` 让一行同时只能有一个持有者,`generated_contents_provider_operation` 让一次远程生成只对应一个操作 ID,重试不会产生第二份远程产物。

**任务单元即内容资产**:`generate-content` 返回的 `job_id` 就是内容资产 ID,状态 URL 指向该资产。不复用 `jobs` 表,因为它的 `JobStep` 枚举(`acquiring`/`storing`/`uploading`/…)是导入专用的,塞进生成步骤要拓宽其 CHECK 约束,把两条互不相干的生命周期挤进一张表。

### 3. 每个修订标注作者归属

`content_revisions` 每行带 `author_kind`(`ai` / `human`)。首个修订必为 `ai`;用户编辑产生新的 `human` 修订,原始稿不可变。这直接满足"用户能够区分 AI 原始稿和自己的修改稿",并让"重新生成"成为追加修订而非覆盖。

### 4. Obsidian 对账以 `diandian_id` 为身份,文件名只是展示

导出文件的 YAML frontmatter 写入稳定的 `diandian_id`。对账流程:

1. 读取 `obsidian_export_state` 中该实体上次导出的相对路径;
2. 若该路径不存在,**扫描 Vault 内 frontmatter 的 `diandian_id`** 重新定位(处理用户重命名);
3. 仍找不到才视为新文件。

以内容身份而非文件名为准,重命名不会产生重复文件。

### 5. 手动修改优先:检测到用户编辑就不覆盖

`obsidian_export_state` 记录上次导出内容的 SHA-256。导出前重新计算目标文件的哈希:

- 与记录一致 → 用户未改,正常覆盖;
- 不一致 → **用户改过,不覆盖**。写入同目录的 `<name>.diandian-conflict.md` 并在响应中报告冲突,由用户决定合并。

宁可留下一个冲突文件,也不静默销毁用户在自己 Vault 里的劳动。这是对 PRD"不产生大量重复文件"的收紧解读:重复文件是可清理的噪音,被覆盖的手写内容不可恢复。

### 6. 路径消毒与 Vault 封闭

Vault 根目录由用户显式配置。所有导出路径由 Vault 根 + 消毒后的相对段拼接,消毒规则:剥离路径分隔符与 `..`、限制长度、拒绝空串与保留名。写入前 canonicalize 并断言仍在 Vault 根内，与项目其他受管文件路径采用同一 confinement 原则。

### 7. Frontmatter 与正文严格分离

正文写入前扫描并转义可能终止 frontmatter 的行(行首 `---`)。frontmatter 只由导出器构造,不接受任何来自 Provider 或书籍元数据的原样键值。

### 8. 反向深链接使用本地 HTTP URL,不引入自定义 scheme

从产品跳到 Obsidian 用 `obsidian://open?vault=<name>&file=<path>`(Obsidian 官方 scheme)。从 Obsidian 跳回产品使用 `http://localhost:3000/...`。**不注册产品自定义 scheme**：local Web 工具没有原生壳，新增系统级 URL handler 会扩大安装与不可信 URL 解析边界；若未来需要，必须另立 ADR。

### 9. 导出是显式动作,不做后台自动同步

P5 不实现文件监听或双向同步。Obsidian 是**单向出口**:产品数据库是阅读进度、任务与内容状态的事实源,Vault 是用户长期知识的事实源,两者不做自动合并。

## Security and privacy

- 导出只写用户显式配置的 Vault 根之内;路径逃逸在写入前 fail closed。
- 生成内容与笔记全部本地存储;不因导出而上传任何数据。
- `content_revisions` 保留原始 AI 稿,使"这段是不是模型写的"永远可回答。
- Provider 返回文本按不可信内容处理:转义 frontmatter 边界,渲染时不执行其中的链接、脚本或图片。

## Operational rollback and recovery

- migration `0009` 只新增表,不改写既有表结构,回滚即删除新表,不影响 Phase 0–5 与 R1–R4 数据。
- 导出失败或冲突不改变数据库中的内容状态;重试幂等。
- `obsidian_export_state` 丢失时降级为"全部视为新文件",配合 §4 的 frontmatter 扫描仍不会产生重复。

## Consequences

### Positive

- Note 与 Annotation 语义清晰,锚点不变量不被 AI 回答破坏。
- 复用 Job/Saga 基础设施,`generate-content` 直接继承已验证的恢复与模糊结果协议。
- 修订作者归属让 AI 内容风险可审计。
- 以 ID 对账 + 手改优先,使重复导出安全且可重复。

### Negative

- 新增四张表与一个 Job 类型,schema 版本推进到 `9`,各层断言需同步。
- 冲突文件需要用户手工处理,首版不提供合并 UI。
- 单向导出意味着用户在 Obsidian 的编辑不会回流到产品数据库。

### Follow-up

- P6 发布轨实现 `scheduled`/`published` 状态转移与平台版本。
- 按真实使用反馈评估是否需要产品自定义 URL scheme；如需新增，先独立评审系统 handler 安全边界。
- 合并 UI 与 Vault 内冲突文件清理留待 P5 之后按实际冲突频率决定。

## Alternatives considered

### 复用 `annotations` 表承载 AI 回答笔记

需要把 `ContentAnchor` 改为可空,破坏 R2 再锚定引擎"每条标注都能定位"的不变量,并让锚点相关查询处处判空。收益仅是少一张表。

### 以文件名作为 Obsidian 对账身份

实现简单,但用户重命名是常规操作,会立刻产生重复文件——直接违反退出标准。

### 无条件覆盖 Vault 文件

最简单的"可重复同步",但会静默销毁用户手动编辑且不可恢复。把不可恢复的破坏换取实现简化,不可接受。

### 双向同步 Obsidian

需要文件监听、冲突解决与外部编辑器竞态处理,复杂度远超 P5 目标,且会让"哪边是事实源"变得不可回答。

### 为 `generate-content` 新建独立任务机制

会出现第二套 Lease、取消与模糊结果语义,与 ADR-0004 的恢复协议分叉,是纯粹的重复成本。

## Validation

- 契约测试覆盖:`save-as-note` 幂等(同一 message 重复调用返回同一 Note)、越界状态转移被拒、`content_generation` Job 的取消与恢复。
- 导出测试覆盖:重命名后不重复导出、手改后不覆盖并产出冲突文件、路径逃逸被拒、frontmatter 注入被转义。
- 各层 `schema_version` 断言更新为 `9`。
- 详细排期见 [内容与创作工作台实施计划](../content-workbench-plan.md)。

## Related

- [ADR-0004](0004-durable-import-saga.md):Job/Saga 与恢复协议。
- [ADR-0005](0005-local-api-security.md):本地 API 安全边界。
- [ADR-0009](0009-local-web-tool-distribution.md)：local Web 分发与无原生壳边界。
- [ADR-0007](0007-reader-annotation-anchor-model.md):Annotation 与锚点不变量。
- [AI 对话功能设计](../../features/ai-chat.md) §8.6:`save-as-note` 与 `generate-content` 目标契约。
