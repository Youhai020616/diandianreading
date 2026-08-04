# CLAUDE.md

diandianreading:个人优先的 AI 阅读、知识沉淀与内容发布工作台(local-first Python 模块化单体,目标形态 Tauri 2 桌面应用)。

## 身份(必须遵守)


- 仓库 local git config 已固定 Youhai 署名与专用 SSH key;不要改动全局 gh 账号与 `~/.gitconfig`。

## 协作原则:独立判断

- 不因为维护者提出了某个方向就默认它正确,也不为了让对话舒服而迎合。
- 主动检查前提、寻找反例;指出盲点、利益冲突和证据不足。
- 明确区分事实、推断与价值判断。

## 开发运行约定(2026-08-03 与维护者确认)

- 按 phase 自主连续开发:每 phase 跑 offline E2E → 开 PR → CI 绿即合并 → 进入下一 phase,直至任务完成。
- 浏览器 UI 功能测试与真实 NotebookLM/Z-Library 联调由维护者最后在自己的 Mac 上手动执行;代码侧负责逻辑审查,并维护手动冒烟验证清单文档。
- 执行顺序:W0 契约冻结(已完成)→ R1 正文与章节服务 → R2 标注核心 → D3 React 迁移 → R3 阅读器 UI → R4 Chat 缝合;D1/D2/D5(Sidecar/Tauri 壳/签名)等 macOS 资源可用时再做。
- Z-Library 模块保留在仓库、默认关闭;`source/` vendored 副本已移除,依赖走 PyPI(见 docs/development/removed-vendored-sources.md)。

## 关键文档

- 设计:`docs/architecture/adr/0007-reader-annotation-anchor-model.md`、`docs/architecture/reader-annotation-plan.md`
- 流程:`docs/development/parallel-delivery-strategy.md`(契约冻结、串行区清单、止损规则)
- 桌面:`docs/architecture/desktop-application-plan.md`(D0–D6)与 ADR-0006

## 工程约束

- 线性历史(rebase 合并),单一交付物对应单一 PR,提交信息遵循 `type(scope): subject`。
- 质量门:mypy strict(范围 `src/diandianreading`)、ruff format/check、pytest 覆盖率 ≥90%、架构边界 AST 测试(`tests/unit/test_architecture_boundaries.py`)。
- migration 编号严格递增且带 checksum 校验;新增 schema 版本时同步更新 unit/integration/e2e 各层的 `schema_version` 断言。
- 串行区文件(migrations、`interfaces/runtime.py`、`interfaces/web/app.py`、`serializers.py`、锁文件、文档索引)并行开发时只允许单一工作单元修改。
- 本地全量验证:`uv run --frozen ruff format --check . && uv run --frozen ruff check . && uv run --frozen mypy src/diandianreading && uv run --frozen pytest -q`
