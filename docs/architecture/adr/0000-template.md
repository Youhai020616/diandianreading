# ADR-NNNN: 标题

## Status

`Proposed`

## Date

YYYY-MM-DD

## Context

说明需要解决的问题、约束和现状。引用相关 PRD、Roadmap、源码或其他 ADR，使未来读者能够复现当时的判断依据。

只保留会影响决策的事实；背景材料过长时链接到独立设计文档。

## Threat model

说明该决策涉及的信任边界、受保护资产、攻击者能力、滥用场景和明确不覆盖的威胁。若决策不改变安全边界，也要写明理由，不能留空。

## Decision

用明确、可验证的陈述记录选择。避免“可能”“暂时也许”等无法约束实现的表述。

必要时列出：

- 适用范围。
- 强制边界。
- 数据或接口契约。
- 何时重新评审。

## Security and privacy

记录最小权限、认证/授权、输入验证、Secret 与个人数据处理、日志脱敏、保留/删除及滥用防护。区分已经由现有控制覆盖的风险和本 ADR 新增的控制。

## Operational rollback and recovery

说明触发回滚的信号、兼容窗口、数据库/文件迁移恢复顺序、远程副作用和 Secret 轮换。若决策不可逆，明确停止条件和前向修复方案；禁止把“回滚代码”写成会盲目删除远程资源或覆盖用户数据的补偿。

## Consequences

### Positive

- 记录预期收益。

### Negative

- 记录已接受的成本、限制和维护负担。

### Follow-up

- 记录落地该决策必须完成的工作。

## Alternatives considered

### 方案 A

说明为什么没有选择。

### 方案 B

说明为什么没有选择。

## Validation

说明用哪些构建、测试、指标或退出标准证明决策可行。至少覆盖正常路径、威胁模型中的关键滥用路径，以及一次可演练的回滚/恢复路径。

## Related

- 相关文档或 ADR。

---

作者注意事项：

- ADR 编号只增不减，不复用。
- 文件名使用 `NNNN-lowercase-kebab-case.md`。
- 新增或修改状态时同步更新 `docs/architecture/README.md`。
- 首次实现验证前使用 `Proposed`；通过评审和测试后改为 `Accepted`。
- 被替代的 ADR 保留原文件，并标为 `Superseded by ADR-NNNN`。
