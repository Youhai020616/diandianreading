# R2 标注核心 E2E / Annotation Core E2E

> 状态:Active
>
> 最后更新:2026-08-03
>
> 本阶段不启动真实浏览器、不访问任何 Provider。划线交互 UI 属 R3;真实浏览器验收由维护者手工执行。

## 1. 目标 / Goal

R2 交付标注系统的数据核心([实施计划](../architecture/reader-annotation-plan.md) §4 R2):

```text
authenticated session + imported book
→ POST /api/books/{id}/annotations   highlight(服务端切片校验)/ note
→ GET  /api/books/{id}/annotations   keyset 分页 + 状态过滤(默认隐藏已删除)
→ PATCH /api/annotations/{id}        body/color 编辑(乐观版本)
→ DELETE + /restore                  软删除与恢复;非法状态迁移 → 409
+ application/services/reanchor.py   再锚定引擎(sha 变化 → quote 检索/消歧/孤儿)
```

## 2. 运行方式 / How to Run

```bash
uv run diandian r2-e2e --app-home <fresh-dir> --workspace <fresh-dir>
```

自动化断言:

- 单元:`tests/unit/test_reanchor.py`(ADR-0007 Validation §1 全场景:不变/局部变更/重排/重复文本多义/上下文消歧/幂等重入)
- 集成:`tests/integration/test_sqlite_annotations.py`(仓库:乐观锁、分页、级联、CHECK 一致性)
- 集成:`tests/integration/test_annotation_service.py`(用例:切片校验、PDF 路径、生命周期、冲突)
- 集成:`tests/integration/test_local_api_annotations.py`(HTTP 契约:201/404/409/422、状态过滤)
- E2E:`tests/e2e/test_r2_annotations.py`(安装入口全链路)

## 3. 关键保证 / Key Guarantees

1. **划线不可伪造**:highlight 必须携带 quote,且服务端验证锚点 sha 与当前阅读文档一致、`text[start:end]` 与 `selected_text` 逐字相等(markdown);任一不符 → 409,过期锚点永远写不进合法划线。
2. **quote ≡ selected_text**(域不变量)是再锚定正确性的根:引擎用 quote 在新文档检索,prefix/suffix 消歧,唯一命中才改写,否则孤儿——孤儿保留原 locator 与全文,永不静默删除。
3. **软删除**:默认列表隐藏 deleted;显式 `?status=deleted` 可见;restore 可逆;对 deleted 的编辑/二次删除 → 409。
4. **写入走独立限流池**(与阅读进度共享 240/分钟 reader 池),不挤占导入/Chat 配额。

## 4. 已知边界 / Known Boundaries

- **再锚定引擎尚无生产调用方**:当前产品内容哈希只在重新导入(产生新 Book)时变化,跨 Book 的标注迁移编排与章节级 `chapter_ref` 重算在 R4 仲裁;引擎本身已按 ADR-0007 验收。
- 章节级 note(schema 允许、域模型未表达)与"可见标注计数进书籍详情"仍为记录在案的后续项。
- PDF 划线无法做服务端文本校验(无文本抽取),仅校验 sha 与页码合法性(ADR-0007 既定代价)。

## 5. 明确未验证 / Explicitly Not Verified

- 浏览器中的选区交互与划线渲染(R3)。
- 真实 Provider 行为;标注进入 Chat 上下文(R4)。
