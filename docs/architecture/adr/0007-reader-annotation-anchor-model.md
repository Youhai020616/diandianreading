# ADR-0007: 阅读器以派生 Markdown 为正文源,标注采用本地可再锚定位置模型

## Status

`Proposed`

## Date

2026-08-03

## Context

Phase 0–5 交付了导入、NotebookLM 集成、可恢复 Workflow 与整本书 Chat,但产品尚无阅读器和标注。PRD 将"以用户划线和想法为 AI 生成的中心"定义为核心差异化；Roadmap Gate 2 要求先有稳定的阅读与标注，再扩大 AI 集成。本 ADR 冻结阅读器与标注的架构决策，交付排期见 [阅读器与标注实施计划](../reader-annotation-plan.md)。

现有基础决定了设计空间:

- 导入管线已把 EPUB 转换为**整本派生 Markdown**(`derived/{root_asset_id}/{sha256}.md` 的 `DocumentAsset`),Markdown 原文直接保存,PDF 不做文本抽取(单一 `DocumentPart` 指向原始字节)。
- `DocumentPart` 分块尺寸由 NotebookLM `TargetCapabilities` 决定,会随 Provider 限制变化;`TextChapter`/`chapter_refs` 不携带字符偏移。**Part 边界不是稳定的阅读或定位单位。**
- `ChatReferenceLocationType`(`epub_cfi`/`pdf_page`/`markdown_offset`)、`chat_references.location_*` 列与序列化器三层已备好位置通道,但没有生产者,`location` 恒为 `None`。
- [AI 对话功能设计](../../features/ai-chat.md) §4 已定义章节/选区/笔记的 `QueryScope` 语义(Proposed),依赖"本地阅读器标识"和"本地 Note ID"这两个尚不存在的前置。
- 现有 Web CSP 为 `default-src 'none'` + `frame-src 'none'` + `worker-src 'none'`,排除了 iframe 型渲染器(epub.js)与 Worker 型渲染器(PDF.js)的默认用法。
- 历史 D3 已完成 React/Vite 迁移；该构建现由 FastAPI 同源托管，vanilla `app.js` 已被替代。

## Threat model

新增资产:书籍正文的可读端点、用户划线与笔记(高敏个人数据)、阅读进度、标注与引用的位置数据。

需要覆盖的攻击与失败:

- 恶意书籍内容(Markdown/HTML/PDF)在阅读器中执行脚本、突破 CSP 或通过标注回流注入 Chat Prompt;
- 通过正文端点越权读取任意文件、跨 Book 读取或泄漏对象物理路径;
- 高频标注/进度写入耗尽本地 API 或数据库(自伤型 DoS);
- 重新导入/重新分块后锚点漂移导致标注静默错位或丢失;
- 标注、选区文本进入日志、诊断包或 Provider 遥测;
- 引用位置推导失败时伪造定位,违背 ai-chat.md "不在没有来源映射的情况下伪造引用"的非目标。

不覆盖:已获得当前用户完整权限的攻击者;Provider 侧数据处理(由 ADR-0002/0003 约束)。

## Decision

### 1. 阅读正文源:派生 Markdown 优先,不引入 epub.js

- EPUB 与 Markdown 书籍的阅读正文是**派生整本 Markdown 资产**,阅读器渲染该资产,不在前端解析 EPUB 容器,不使用 epub.js/iframe。
- PDF 书籍渲染**原始 PDF 字节**,使用 PDF.js;PDF 文本抽取不进入本版本。
- 章节索引由 `policy.markdown_chapters()` 对派生 Markdown 确定性推导,章节 ID 沿用既有 `chapter_refs` 规则(`markdown-heading-NNNN` 等),不新建 chapters 表;PDF 的章节索引在本版本退化为单章。
- 渲染前必须消毒:Markdown 按纯文本/受限标记渲染,原文中的内嵌 HTML 一律转义,不执行脚本、不加载远程资源;该规则与 ai-chat.md 对 AI 回答的渲染约束一致。

### 2. 位置模型:单一锚点契约,Annotation/进度/ChatReference 共用

所有"指向正文中某处"的数据使用同一 locator 契约:

```json
{
  "type": "markdown_offset",
  "anchor_sha256": "<派生资产内容哈希>",
  "start": 10240,
  "end": 10388,
  "chapter_ref": "markdown-heading-0007",
  "quote": {"exact": "<选中文本>", "prefix": "<≤64字符>", "suffix": "<≤64字符>"}
}
```

- **锚定文档身份**是内容哈希(`anchor_sha256` = 派生 Markdown 的 sha256;PDF 为原始资产 sha256),不是 `DocumentPart`。Part 边界随 Provider 变化,禁止作为锚点坐标系。
- `markdown_offset` 的规范语义:规范化后派生 Markdown 的 Unicode 码点偏移区间 `[start, end)`。
- `pdf_page` 语义:1 起始页码,`quote` 取自 PDF.js 文本层,可选。
- `epub_cfi` 保留为合法类型但本版本**不生产**(没有 EPUB 原生渲染器,生产它就是伪造)。
- **再锚定规则**:重新导入产生新 `anchor_sha256` 时,偏移失效,按 `quote` 在新文档中检索;唯一命中则改写偏移与哈希,零命中或多义命中则标注进入 `orphaned` 状态。孤儿标注可列出、可读、可手工重定位,**永不静默删除**。
- ChatReference 的 `location` 由本地生产:用 Provider 返回的 `excerpt` 在派生 Markdown 中做文本匹配,唯一命中才写入位置;匹配失败时 `location` 保持 `None`,界面明示"未能定位到原文"。禁止模糊匹配置信度伪装成精确定位。

### 3. Annotation 领域模型

- 新增聚合 `Annotation`:`id, book_id, kind(highlight|note), locator(如上), selected_text(≤2000 码点), body(笔记正文,≤10000 码点,highlight 可空), color(固定枚举), status(active|orphaned|deleted), created_at, updated_at, version`。
- `highlight` 必须携带 locator 与 `selected_text`;`note` 可锚定到 locator、章节或整本书。删除为软删除(`deleted`),支持撤销与后续 Obsidian 增量同步;物理清除策略延后单独决定。
- 新增 `reading_progress`:每书一行,`book_id, locator, percent, updated_at, version`,last-write-wins + 乐观锁。
- 以上均为本地数据,遵循 domain 分层规则,以 `ChatRun` 的 frozen dataclass + 不变量 + `replace()` 范式建模;新增 migration 从 `0007` 起编号。

### 4. 正文与标注 API

- 新增只读端点:书籍详情(资产/章节索引/进度/标注计数)与正文内容(派生 Markdown 或原始 PDF 字节)。内容响应以 `anchor_sha256` 作 ETag,`Cache-Control: private, no-store` 之外允许条件请求;不暴露对象物理路径与 StorageKey 内部结构。
- 标注 CRUD 与进度写入走既有 `authorize()`/CSRF/Session 边界;`FileStore` 仍只在 Python Infrastructure 层,Web 层经新增只读用例访问,`WebRuntime` 不直接持有文件句柄语义之外的能力。
- **限流分池**:标注与进度写入使用独立于既有 `mutation_limiter` 的配额池。划线是高频合法操作,不能与导入/Chat 抢同一配额;进度写入客户端去抖 + 服务端合并。
- SSE 不新增:标注是单用户本地数据,首版不需要跨端推送。

### 5. 与 Chat 的缝合遵循 ai-chat.md §4,不另立语义

- 选区问答、笔记集合问答的范围语义、`EffectiveScope`、`SOURCE_NOT_READY` 与防扩大规则**以 ai-chat.md 为准**,本 ADR 只提供其前置:阅读器产生合法 locator,`Annotation` 充当 `note_ids` 的本地存储。
- 标注默认**不上传** Provider。选区与未同步笔记按 ai-chat.md 以定界后的补充上下文进入 Prompt;"笔记同步为 Provider Text Source"是后续显式 opt-in,启用前需扩展 ADR-0003 的凭据与数据边界评审。

### 6. UI 落点:React 一次到位

- 阅读器 UI 只在 React/Vite 工程中实现，不在旧 vanilla `app.js` 上开发过渡版。标注后端(§3/§4)不依赖前端，可用 API 级测试独立验收。
- CSP 演进:为 PDF.js 增加 `worker-src 'self'` 与受限 `blob:` 用途,保持无 inline、无远程、无 `unsafe-eval`;每项放宽必须有对应的负向测试。`frame-src 'none'` 不变。

## Security and privacy

- 标注、笔记、选区、阅读进度是高敏个人数据:不进入日志、诊断包默认排除、不进入遥测,依 ADR-0005/0006 的脱敏规则执行。
- 正文端点只接受本 Book 归属校验通过的请求;路径解析继续走 `LocalFileStore` 的 no-symlink/owner/TOCTOU 校验,Web 层不拼接物理路径。
- 标注文本进入 Chat Prompt 时按 ai-chat.md §4.5 作为不可信内容定界,不允许其改变系统指令或触发产品操作。
- 渲染层禁止把书籍内容当 HTML 注入;React 侧禁用 `dangerouslySetInnerHTML` 于未消毒内容,配 lint 规则与测试。

## Operational rollback and recovery

- Migration `0007` 只做加法(新表、新列),不改写既有表;回滚即忽略新表,Phase 5 功能不受影响。
- 标注表损坏或再锚定批量失败时,阅读与 Chat 继续可用;孤儿标注保留原始 locator 与文本,可导出后人工恢复。
- 派生资产被重建时,旧 `anchor_sha256` 的标注全部走再锚定流程;流程中断可重入(逐条幂等)。
- 正文端点故障不影响导入与 Chat;阅读器显示类型化错误并允许重试。

## Consequences

### Positive

- EPUB 不需要前端容器解析,渲染、锚定、引用定位共用一份规范化正文,单一事实源。
- 锚点以内容哈希 + 文本指纹双保险,重新导入不静默丢标注。
- ChatReference 位置通道从"预留"变为"生产",引用可跳回原文,兑现 PRD 来源可追溯原则。
- 标注后端不依赖前端栈，可独立测试和演进。

### Negative

- PDF 无文本抽取,PDF 标注只有页级 + 文本引述精度,跨版式重排不可再锚定。
- 派生 Markdown 与 EPUB 原始排版有差异(脚注、图片、复杂表格),阅读保真度低于原生 EPUB 渲染器;接受此代价换取锚定与安全的确定性。
- `epub_cfi` 类型短期空置;若未来引入原生 EPUB 渲染,需要新的锚点迁移设计。
- 再锚定的 quote 检索在极端重复文本(如法条、诗歌)下会产生多义孤儿,需要 UI 承接。

### Follow-up

- 按 [阅读器与标注实施计划](../reader-annotation-plan.md) 交付 R1–R4。
- Roadmap 增补 R 轨并与 D 轨对齐;Gate 2 的进入证据由 R3 验收产出。
- 笔记同步为 Provider Source、Obsidian 导出、PDF 文本抽取各自需要后续设计(不在本 ADR 内定论)。

## Alternatives considered

### epub.js + iframe 渲染 EPUB

不采用。与现有 CSP(`frame-src 'none'`)直接冲突;iframe 内定位产生 CFI 坐标系,与已有 Markdown 派生管线形成两套正文事实源;划线锚点绑定渲染器内部结构,重排即漂移。

### 以 DocumentPart 为锚点坐标系

不采用。Part 边界由 NotebookLM 容量参数决定,Provider 限制变化或重新导入即漂移;把 Provider 细节泄漏进用户数据模型,违反分层。

### PDF 转 Markdown 统一渲染

本版本不采用。PDF 文本抽取质量不可控,版式/公式/扫描件失真严重;统一坐标系的收益不足以抵消保真度损失。保留为后续可选增强。

### 标注以 Obsidian Vault 文件为事实源

不采用。文件系统无事务、无乐观锁、外部编辑不可控;SQLite 为系统记录,Obsidian 是导出目标(PRD 数据归属一致)。

### 首版即把笔记上传为 Provider Text Source

不采用。扩大数据出境面且绑定 Provider 可用性;ai-chat.md 已设计"未同步笔记作为补充上下文"的降级路径,首版用它。

## Validation

本 ADR 满足以下证据后改为 `Accepted`:

1. 锚点属性测试:同文档偏移稳定;重新导入(内容不变/局部变更/章节重排)下,再锚定命中与孤儿判定符合规则,无静默错位。
2. 正文端点在权属、路径、大小、条件请求与错误类型上的自动化测试通过;不泄漏物理路径。
3. 标注 CRUD 在独立限流池下的突发写入测试通过,且不影响导入/Chat 配额。
4. ChatReference 位置生产者:唯一命中/零命中/多义命中三类用例正确,失败不伪造定位。
5. React 阅读器在放宽后 CSP 下渲染恶意样本(脚本、HTML、超长行、巨型文档)无执行、无注入,负向测试在 CI。
6. R1–R4 各阶段 offline E2E 与既有 Phase 0–5 E2E 全部通过；installed-wheel local Web 链路独立验收。

## Related

- [阅读器与标注实施计划](../reader-annotation-plan.md)
- [AI 对话功能设计](../../features/ai-chat.md)
- [Local Web 分发实施计划](../local-web-distribution-plan.md)
- [ADR-0001:local-first Python 模块化单体](0001-local-first-modular-monolith.md)
- [ADR-0004:持久化导入 Saga](0004-durable-import-saga.md)
- [ADR-0005:本地 API 安全](0005-local-api-security.md)
- [ADR-0009:Local Web 工具分发](0009-local-web-tool-distribution.md)
- [产品 PRD](../../../diandianreading-PRD.md)
- [产品 Roadmap](../../../diandianreading-ROADMAP.md)
