# diandianreading 文档

> 状态：Active
>
> 最后更新：2026-08-04

本目录保存 `diandianreading` 的产品、架构、集成和功能设计文档。Phase 0–5 已有可执行实现；Phase 5 已交付统一 CLI、本地 Web/API、持久导入/Job 与整本书 AI Chat。长期产品方向已收敛为 Tauri 2 桌面优先，但 React/Vite、Tauri、Python Sidecar、签名和桌面安装包仍是 `Proposed`，不能描述为已经实现。

## 文档地图

| 文档 | 作用 | 状态 |
| --- | --- | --- |
| [产品 PRD](../diandianreading-PRD.md) | 产品定位、用户流程、功能范围和数据模型 | Draft v0.2 |
| [产品 Roadmap](../diandianreading-ROADMAP.md) | P0-P9 产品阶段与 D0-D6 桌面交付轨 | Draft v0.2 |
| [API 参考](api.md) | `notebooklm-py`、`zlibrary-to-notebooklm` 及 Phase 5 统一产品契约 | Active |
| [架构文档索引](architecture/README.md) | 架构阅读顺序、ADR 状态和规则 | Active |
| [两项目集成计划](architecture/integration-plan.md) | 目标架构、抽象边界、重构路径和分阶段迁移 | Active |
| [Tauri 2 桌面应用实施计划](architecture/desktop-application-plan.md) | React/Vite UI、Python Sidecar、生命周期、安全、打包、签名、更新与 D0–D6 验收 | Proposed |
| [本地 API 安全 ADR](architecture/adr/0005-local-api-security.md) | 每安装实例认证、同源浏览器边界、SSE/WS 与资源限制 | Proposed |
| [桌面架构 ADR](architecture/adr/0006-desktop-first-tauri-python-sidecar.md) | 桌面优先、Tauri 2 壳、React/Vite UI 与 Python Sidecar 的强制边界 | Proposed |
| [AI 对话功能设计](features/ai-chat.md) | 已实现整本书对话切片，以及后续章节/笔记/选区目标设计 | Active / Proposed |
| [Phase 0 本地 E2E](development/phase-0-e2e.md) | Fake Adapter、SQLite 与 Job 全链路验证 | Active |
| [Phase 1 文档处理 E2E](development/phase-1-e2e.md) | 本地 Acquisition、Markdown/EPUB/PDF Preparation 与真实对象存储验证 | Active |
| [Phase 2 NotebookLM Adapter E2E](development/phase-2-e2e.md) | 公开 Python SDK 边界、凭据隔离、引用映射、生成与下载验证 | Active |
| [Phase 3 可恢复 Workflow E2E](development/phase-3-e2e.md) | Lease fencing、Step checkpoint、Intent reconciliation、认证恢复、解歧与取消验证 | Active |
| [Phase 4 Z-Library 可选 Adapter E2E](development/phase-4-e2e.md) | Rights gate、真实 session marker、逐跳网络、bounded download、Archive 与 Legacy migration 验证 | Active |
| [Phase 5 统一产品 E2E](development/phase-5-e2e.md) | Session/CSRF、导入、Worker、书库、整本书 Chat、引用与 SSE 全链路验证 | Active |

## 推荐阅读顺序

1. [产品 PRD](../diandianreading-PRD.md)：理解产品为什么存在。
2. [产品 Roadmap](../diandianreading-ROADMAP.md)：理解功能进入产品的顺序。
3. [API 参考](api.md)：了解两个现有项目真实提供的能力与限制。
4. [两项目集成计划](architecture/integration-plan.md)：了解主项目如何吸收这些能力。
5. [架构决策记录](architecture/README.md)：了解关键选择及其代价；实现本地 API 前阅读 [ADR-0005](architecture/adr/0005-local-api-security.md)。
6. [Tauri 2 桌面应用实施计划](architecture/desktop-application-plan.md)：了解桌面产品目标、Sidecar、安全、打包、更新与分阶段验收。
7. [ADR-0006](architecture/adr/0006-desktop-first-tauri-python-sidecar.md)：了解桌面壳、WebView、Python 核心与数据兼容的强制边界。
8. [AI 对话功能设计](features/ai-chat.md)：了解第一个 NotebookLM 用户界面。
9. [Phase 0 本地 E2E](development/phase-0-e2e.md)：验证架构地基的可执行链路。
10. [Phase 1 文档处理 E2E](development/phase-1-e2e.md)：验证真实本地文档处理、对象存储和持久化链路。
11. [Phase 2 NotebookLM Adapter E2E](development/phase-2-e2e.md)：验证公开 SDK Adapter、凭据路径隔离、引用恢复和内容资产发布。
12. [Phase 3 可恢复 Workflow E2E](development/phase-3-e2e.md)：验证进程崩溃边界、Lease 接管、远程结果协调、恢复控制与安全取消。
13. [Phase 4 Z-Library 可选 Adapter E2E](development/phase-4-e2e.md)：验证强制权利来源、Provider 会话隔离、浏览器网络策略、受限下载和 Legacy migration。
14. [Phase 5 统一产品 E2E](development/phase-5-e2e.md)：验证安装后仍可执行的安全 Web/API、持久导入、Job、整本书 Chat、引用与 SSE 链路。

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
