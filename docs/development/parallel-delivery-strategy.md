# 并行交付策略 / Parallel Delivery Strategy

> 状态：Active principles / Historical D-track examples
>
> 适用范围：后续多轨开发；文中的 D1/D2 波次只记录已终止桌面轨当时的协作实例，不再是当前执行指令
>
> 关联:[阅读器与标注实施计划](../architecture/reader-annotation-plan.md)、[Local Web 分发计划](../architecture/local-web-distribution-plan.md)
>
> 最后更新:2026-08-03

## 1. 目标 / Goal

用多个并行工作单元(子 agent / 并行分支)缩短独立工作流的墙钟时间，同时不破坏本仓库既有的质量约束：线性历史、逐 PR 评审、mypy strict、覆盖率门槛、架构边界测试与 migration checksum 校验。R1/R2/D1/D2 只作为历史案例。

预期收益按依赖结构估算为 **2–3 倍墙钟压缩**,不随并行单元数量线性增长。并行的目的是把独立子系统的等待时间重叠,不是提高单位时间代码产量;产出必须以"已通过验证门"计量,不以行数计量。

## 2. 原则 / Principles

1. **契约先行**:任何并行波次开始前,所涉及的 Port 签名、领域模型形状、migration DDL、API 请求/响应结构必须已合并进基线分支。并行单元只依赖已冻结契约,不依赖彼此的未合并代码。
2. **串行区保护**:§4 列出的热点文件在任何并行波次中只允许一个工作单元修改;其余单元对这些文件只读。
3. **评审对齐**:并行度向评审吞吐对齐。产生代码的波次必须配套评审波次;不允许"CI 绿即合并"绕过人工确认。
4. **隔离执行**:每个并行单元在独立 git worktree 与独立分支上工作,禁止共享工作区。
5. **验证门串行**：每个阶段的 exit criteria 逐个通过，不因并行而合批豁免。

## 3. 波次模型 / Wave Model

```text
W0 契约冻结(串行,小)
   0007 migration DDL、Annotation/Progress Port 签名、
   正文 API 形状、locator JSON Schema
   → 一个小 PR,先评审先合并,成为并行基线

W1 并行建造(3–4 路)
   ├── R1 实现:正文/章节/进度用例与端点
   ├── R1+R2 测试:锚点属性测试、端点安全测试、E2E 脚手架
   ├── R2 领域:Annotation 模型、Repository、再锚定引擎
   └── D1:Sidecar Builder PoC(独立工具链,零共享文件)

W2 集成(串行,小)
   runtime.py 装配、app.py 挂路由、serializers 汇总、
   解决 rebase、全量 CI

W3 对抗评审(并行,按 PR)
   每个待合并 PR 由 ≥3 个独立视角(正确性/安全/契约一致性)
   分别验证,汇总为结论供人工评审
```

波次间是屏障:W1 的所有单元完成或明确放弃后才进入 W2。单元失败不阻塞同波次其他单元,但其交付物顺延至下一轮 W1。

## 4. 串行区 / Serial Zones

以下文件/序列在并行波次中只允许指定的集成单元修改:

| 串行区 | 原因 |
| --- | --- |
| `infrastructure/persistence/migrations/*.sql` | 编号严格递增 + checksum 校验,双分支同号必然冲突且不可自动合并 |
| `interfaces/runtime.py` | composition root,所有装配汇聚点 |
| `interfaces/web/app.py` | 全部路由单文件,任何端点新增都触碰 |
| `interfaces/web/serializers.py` | 视图序列化汇聚点 |
| `pyproject.toml` / `uv.lock` | 依赖与锁文件,合并冲突高发 |
| `docs/README.md` / `docs/architecture/README.md` | 文档索引,W2 统一登记 |

W0 阶段应把并行单元需要的新表 DDL 与新路由占位一次性进入串行区,使 W1 期间串行区尽量零改动。

## 5. 分支与合并纪律 / Branch and Merge Discipline

- 分支命名:`feature/r1-content-service`、`feature/r2-annotation-core`、`test/r1-r2-harness`、`feature/d1-sidecar-poc`;评审产物不建分支。
- 合并顺序在 W2 决定,原则是"被依赖者先合";全部经 rebase 保持线性历史,与现有仓库惯例一致。
- 契约变更是例外事件:W1 期间发现契约错误,立即中止受影响单元,回到 W0 出修正 PR,其余单元继续。禁止在功能分支上私改契约再"顺手"合并。
- 每个 PR 保持单一交付物(与 phase-0..5 的单 commit 惯例对齐),便于评审与回滚。

## 6. 评审纪律 / Review Discipline

- W3 的对抗评审是人工评审的前置过滤,不是替代:每个 PR 的最终合并决定由维护者作出。
- 对抗视角至少覆盖:实现正确性(含边界与并发)、安全(注入/越权/泄漏,对照 ADR-0005/0007 threat model)、契约一致性(实现是否偏离 W0 冻结的契约与 ADR)。
- 评审结论按"发现 → 复核 → 确认/驳回"记录在 PR 内;未确认的发现不阻塞,已确认的发现必须修复或显式接受。
- 存量债务消化:在无新建造波次的间隙,评审产能优先用于 phase-0..5 存量代码的补评审。

## 7. 失败与回退 / Failure Handling

- 单元产出未达退出标准:不合并,交付物降级为下一轮输入;不因"已经写了"而放宽标准。
- W2 集成发现跨单元不一致:以契约为准;两侧都偏离时回 W0 仲裁,禁止在集成 PR 里临时定义新契约。
- 并行期间基线推进(如紧急修复合入 main):所有 W1 单元立即 rebase,冲突超过阈值的单元评估重做成本,必要时缩小该单元范围。
- 任何波次可整体中止回退到纯串行交付;本策略是加速器,不是交付的前提条件。

## 8. 度量与止损 / Metrics and Stop Rules

每轮波次结束记录:墙钟时间、返工量(因契约/冲突重做的比例)、评审积压(已产出未合并的 PR 数)、验证门一次通过率。

出现以下信号时降低并行度或退回串行:

- 返工量连续两轮超过 20%;
- 评审积压超过 2 个未处理 PR;
- 串行区在 W1 期间被迫修改超过一次;
- 验证门一次通过率低于一半。

## 9. 明确不做 / Non-goals

- 不并行修改串行区文件。
- 不跳过或合批验证门与人工评审。
- 不以并行为由拆散"单一交付物对应单一 PR"的粒度。
- 不在契约未冻结时启动建造波次。
- 真实 Provider 联调、签名/公证等受控人工验收不进入并行波次(按桌面计划测试矩阵执行)。
