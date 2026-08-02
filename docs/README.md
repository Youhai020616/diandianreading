# diandianreading 文档

> 状态：Active
>
> 最后更新：2026-08-03

本目录保存 `diandianreading` 的产品、架构、集成和功能设计文档。运行代码尚未建立时，文档中的 `Proposed` 表示目标设计，不代表已经实现。

## 文档地图

| 文档 | 作用 | 状态 |
| --- | --- | --- |
| [产品 PRD](../diandianreading-PRD.md) | 产品定位、用户流程、功能范围和数据模型 | Draft v0.1 |
| [产品 Roadmap](../diandianreading-ROADMAP.md) | P0-P9 阶段目标与退出标准 | Draft v0.1 |
| [API 参考](api.md) | `notebooklm-py`、`zlibrary-to-notebooklm` 及现有集成契约 | Active |
| [架构文档索引](architecture/README.md) | 架构阅读顺序、ADR 状态和规则 | Active |
| [两项目集成计划](architecture/integration-plan.md) | 目标架构、抽象边界、重构路径和分阶段迁移 | Proposed |
| [本地 API 安全 ADR](architecture/adr/0005-local-api-security.md) | 每安装实例认证、同源浏览器边界、SSE/WS 与资源限制 | Proposed |
| [AI 对话功能设计](features/ai-chat.md) | 可视化对话、引用、会话与 API 设计 | Proposed |
| [Phase 0 本地 E2E](development/phase-0-e2e.md) | Fake Adapter、SQLite 与 Job 全链路验证 | Proposed |

## 推荐阅读顺序

1. [产品 PRD](../diandianreading-PRD.md)：理解产品为什么存在。
2. [产品 Roadmap](../diandianreading-ROADMAP.md)：理解功能进入产品的顺序。
3. [API 参考](api.md)：了解两个现有项目真实提供的能力与限制。
4. [两项目集成计划](architecture/integration-plan.md)：了解主项目如何吸收这些能力。
5. [架构决策记录](architecture/README.md)：了解关键选择及其代价；实现本地 API 前阅读 [ADR-0005](architecture/adr/0005-local-api-security.md)。
6. [AI 对话功能设计](features/ai-chat.md)：了解第一个 NotebookLM 用户界面。
7. [Phase 0 本地 E2E](development/phase-0-e2e.md)：验证架构地基的可执行链路。

## 状态词

| 状态 | 含义 |
| --- | --- |
| `Draft` | 内容仍在快速变化 |
| `Proposed` | 已有明确方案，尚未通过实现验证 |
| `Accepted` | 已确认并作为实现约束 |
| `Active` | 当前有效的事实或参考文档 |
| `Deprecated` | 不再推荐使用，但仍可能存在 |
| `Superseded` | 已被另一份文档或 ADR 替代 |

## 维护规则

- 产品需求写入 PRD，阶段顺序写入 Roadmap。
- 稳定接口事实写入 `api.md`，不要在功能文档复制完整 API 参考。
- 跨模块且难以逆转的选择写成 ADR。
- 功能文档描述用户体验、业务规则、接口契约和验收标准。
- 文档中的源码事实必须能够指向当前工作区文件。
- 凭据、Cookie、Token、账号邮箱和本地会话内容不得写入文档。
- 实现与文档不一致时，先确认哪一方是目标，再更新状态或建立迁移项，不能静默忽略。
