# 阅读器与标注实施计划 / Reader and Annotation Plan

> 状态:Proposed
>
> 目标:交付 PDF/EPUB/Markdown 阅读、划线与笔记,并把它们接入 AI Chat,补齐产品核心差异化
>
> 架构决策:[ADR-0007](adr/0007-reader-annotation-anchor-model.md)
>
> 最后更新:2026-08-03

## 1. 决策摘要 / Decision Summary

```text
Reading surface
+ derived whole-book markdown (EPUB/MD) / original bytes via PDF.js (PDF)
+ single locator contract: anchor_sha256 + offsets + text quote
+ local-first annotations (highlight / note) with re-anchoring
+ citation → jump-to-text, selection → ask, notes → chat scope
```

本计划补齐产品核心的阅读与标注能力，并为 [AI 对话功能设计](../features/ai-chat.md) §4 的章节/选区/笔记范围提供其依赖的本地阅读器标识与 Note 存储。

与 Roadmap 的关系:R 轨对应产品 Roadmap 的 **P3(个人 Alpha:阅读与标注)** 与 **P4 的入口部分(选区/笔记问答)**;R3 验收产出 Gate 2("阅读器和标注稳定")的进入证据。R 编号独立于 git 历史的 phase-0..5 与桌面 D0–D6,避免再引入一套冲突编号。

## 2. 范围 / Scope

### 2.1 目标

- 用户可以在应用内连续阅读已导入的 PDF/EPUB/Markdown,章节导航,进度自动保存。
- 用户可以划线、改色、写想法、删除与撤销;标注在重新导入后不静默丢失或错位。
- AI 引用可以跳回正文位置;选中文本可以发起带上下文的提问;笔记集合可以作为 Chat 范围。
- 标注与进度是纯本地数据,默认不进入 Provider、日志与诊断包。

### 2.2 非目标

- 不实现 EPUB 原生渲染(epub.js)与 `epub_cfi` 生产。
- 不实现 PDF 文本抽取、跨书搜索、主题聚合、AI 发现、Obsidian 导出与任何发布能力。
- 不实现标注多端实时同步与协作。
- 不在现有 vanilla `app.js` 上开发过渡版阅读器 UI。
- 不把笔记自动上传为 Provider Text Source(后续显式 opt-in 另行评审)。

## 3. 当前基线 / Current Baseline

已有(可直接复用):

- 派生整本 Markdown 资产与 `parts/` 分块(EPUB→MD 已在导入管线完成);
- `LocalFileStore` 安全读取(0600/属主/no-symlink/TOCTOU);
- `CatalogRepository.list_assets/list_parts`、migration runner(下一编号 `0007`)、`UnitOfWork` 事务边界;
- `authorize()`/CSRF/Session/限流外壳、`ApiProblem` 错误模型、SSE 基础设施;
- `ChatReferenceLocation` 三层通道(domain/schema/serializer,尚无生产者);
- `policy.markdown_chapters()` 确定性章节切分与 `chapter_refs`。

缺失(本计划新建):

- 正文与书籍详情端点(现无任何内容可读端点);
- `Annotation`/`reading_progress` 领域模型、migration、Repository、Use Case、API;
- 锚点与再锚定引擎;
- React 阅读器 UI（复用已完成的 React/Vite 工程）；
- ChatReference 位置生产者与选区/笔记 Chat 入口。

## 4. 交付阶段 / Delivery Phases

R1/R2 是纯 Python 后端，用 API 级测试与 offline E2E 验收；R3 复用 React 工程。每阶段独立分支、PR、review、CI，前一阶段退出标准通过后才开始下一阶段。多工作单元并行执行本计划时，遵循 [并行交付策略](../development/parallel-delivery-strategy.md) 的契约冻结、串行区与评审纪律。

### R1:正文与章节服务(Python)

交付:

- 书籍详情用例与端点:资产清单、章节索引(由派生 Markdown 确定性推导)、阅读进度、标注计数;
- 正文内容端点:派生 Markdown / 原始 PDF 字节,ETag=`anchor_sha256`,条件请求,大小防线;
- `reading_progress` 表(migration `0007` 第一部分)与进度读写用例、服务端合并策略;
- `WebRuntime` 注入只读内容用例;serializer 与错误类型;
- `docs/development/r1-e2e.md`:导入 → 详情 → 取正文 → 章节 → 进度全链路 offline E2E。

退出标准:

- EPUB/MD/PDF 三种来源均可经 API 取回正文且校验和一致;权属/路径/越权/条件请求负向测试通过;
- 章节索引对同一派生资产可重复推导且与 `chapter_refs` 一致;
- 进度写入合并生效,不占用既有 mutation 配额;
- 既有 Phase 0–5 E2E 不回归,PR CI 绿色。

### R2:标注核心与再锚定(Python)

交付:

- `Annotation` 领域模型与不变量(ADR-0007 §3),migration `0007` 第二部分;
- `AnnotationRepository` port + SQLite 实现 + CRUD/列表/软删除用例;
- 再锚定引擎:内容哈希比对 → quote 唯一命中改写 → 孤儿标记;逐条幂等、可重入;
- 标注 API(独立限流池)与 serializer;
- 锚点属性测试(稳定/局部变更/重排/重复文本多义)与突发写入限流测试;
- `docs/development/r2-e2e.md`:划线 → 重新导入 → 再锚定/孤儿 全链路 offline E2E。

退出标准:

- 属性测试覆盖 ADR-0007 Validation §1 全部场景,零静默错位;
- 高频划线突发不影响导入/Chat 配额;
- 标注数据不出现在日志与诊断输出;
- 既有 E2E 不回归,PR CI 绿色。

### R3:React 阅读器 UI

交付:

- 阅读器视图:派生 Markdown 渲染(消毒、长文性能策略)、PDF.js 渲染(CSP 按 ADR-0007 §6 收紧放宽)、章节导航、进度恢复;
- 选区 → 划线/改色/写想法/删除/撤销交互;标注侧栏(本书维度列表与跳转);孤儿标注的展示与手工重定位入口;
- 恶意样本负向测试(脚本/HTML/巨型文档)进 CI;键盘、焦点与可访问性对齐 ai-chat.md §5.4 基线;
- Library 视图从"仅列表"升级为可进入阅读器的书籍入口。

退出标准:

- 三种格式真实样本人工验收:连续阅读、划线、进度恢复、窄窗口与高 DPI;
- CSP 负向测试全绿,无 inline/远程/`unsafe-eval`;
- Browser 使用 FastAPI 同源托管的唯一生产构建；
- 本阶段产出 Roadmap Gate 2 进入证据清单。

### R4:Chat 缝合(Python + React)

交付:

- ChatReference 位置生产者(excerpt 本地匹配,唯一命中才写入;失败保持 `None`);
- 引用 → 阅读器跳转;阅读器选区 → 按 ai-chat.md §4.1 `selection` 范围提问;标注笔记 → `notes` 范围;
- `EffectiveScope`/`SOURCE_NOT_READY`/防扩大规则按 ai-chat.md 执行的契约测试;
- `docs/development/r4-e2e.md`:Fake Provider 下 引用定位 → 跳转 → 选区提问 → 笔记范围 全链路 offline E2E。

退出标准:

- 位置生产者三类用例(唯一/零/多义)正确,UI 对未定位引用明示;
- 选区与笔记范围的越权、跨书、空范围、注入定界测试通过;
- ai-chat.md 对应小节状态从 Proposed 更新为与实现一致;
- 既有全部 E2E 不回归,PR CI 绿色。

## 5. 与 Local Web 运行时的关系

```text
Python R1/R2 services → FastAPI contracts → React R3/R4 UI
                               ↓
                    diandianreading web
```

- Python、React 与 Worker 由同一 local Web Runtime 管理，不存在桌面壳或第二套业务核心；
- R3 的 CSP 由 FastAPI 同源静态资源和浏览器负向测试共同验证；
- 浏览器 UI 与 CLI 使用同一 App Home、SQLite、Session 和 Provider Adapter。

## 6. 测试矩阵 / Test Matrix

| 层级 | 默认 CI | 手工验收 |
| --- | --- | --- |
| 锚点属性测试(R2) | 是 | 否 |
| 正文端点安全/权属(R1) | 是 | 否 |
| 标注限流与隐私(R2) | 是 | 否 |
| R1/R2/R4 offline E2E | 是 | 否 |
| 阅读器恶意样本/CSP(R3) | 是 | 视觉确认 |
| 阅读体验/可访问性(R3) | 静态检查 | 键盘/窄窗/高 DPI |
| 引用定位正确性(R4) | 是 | 真实书籍抽样 |
| 真实 Provider 下引用/选区 | 否 | 维护者受控验收 |

## 7. Definition of Done

R 轨完成当且仅当:

- 一本真实 EPUB 与一本真实 PDF 可完成:导入 → 连续阅读 → 划线写想法 → 重新导入后标注完好 → AI 引用跳回原文 → 选区提问 → 笔记范围对话;
- 全程无标注丢失/错位,失败路径均有类型化错误与恢复入口;
- 标注/进度/选区未出现在日志、诊断包与 Provider 请求之外的任何出口;
- ADR-0007 Validation 全部通过并改为 `Accepted`;
- Roadmap Gate 2 证据完备,ai-chat.md 相关小节状态与实现一致。

## 8. 仍需证据决定的问题 / Open Evidence Gates

1. 长文渲染策略:整页渲染的性能上限与虚拟化方案(按真实大部头测量后定,不预选库)。
2. Markdown 渲染与消毒的具体实现(React 生态内比较,负向样本集驱动)。
3. PDF 大文件是否需要 Range/流式读取(按真实 PDF 体积分布测量)。
4. 标注限流池的具体配额数值(按真实划线行为测量)。
5. 章节索引是否需要落库缓存(先按每次推导实现,测量后决定)。
6. 孤儿标注手工重定位的交互形态(R3 用户测试后定)。

每项须以测量或测试证据决定,并在需要时回写本计划或新增 ADR。

## 9. 官方依据 / Primary References

- [ADR-0007:阅读器与标注锚点模型](adr/0007-reader-annotation-anchor-model.md)
- [ADR-0009:Local Web 工具分发](adr/0009-local-web-tool-distribution.md)
- [Local Web 分发实施计划](local-web-distribution-plan.md)
- [AI 对话功能设计](../features/ai-chat.md)
- [产品 PRD](../../diandianreading-PRD.md) §6.3/§6.4/§8.3
- [产品 Roadmap](../../diandianreading-ROADMAP.md) P3/P4 与 Gate 2
