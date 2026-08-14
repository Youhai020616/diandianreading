# diandianreading 产品 Roadmap

> 路线版本：v0.3（本地 Web 工具分发轨）
>
> 对应 PRD：[diandianreading-PRD.md](./diandianreading-PRD.md)
>
> 目标：从已实现的 local-first Python/React 产品核心走到可通过 `uvx diandianreading web` 安装、启动、升级和恢复的正式版本
>
> 更新时间：2026-08-14

---

## 1. 路线总览

项目采用“个人优先、local-first、验证先行、逐步开放”的路线：

```text
读一本书
→ 留下自己的想法
→ AI 帮我理解和创作
→ 保存为个人知识
→ 再决定是否发布到社交平台
```

产品不是公共云 SaaS，也不再继续 Tauri 原生桌面轨。正式运行形态是：

```text
uvx diandianreading web
→ Python local Runtime
→ React browser UI at http://localhost:3000
→ SQLite / private files / durable Worker / Provider adapters
```

### 产品阶段

| 阶段 | 名称 | 目标 | 当前状态 |
| --- | --- | --- | --- |
| P0 | PRD 冻结 | 明确产品、数据与安全边界 | 已完成，v0.3 同步中 |
| P1 | 原型验证 | 验证信息架构和核心交互 | 有原型与 React UI；正式用户测试待补 |
| P2 | 技术地基 | local-first Python、SQLite、Worker、Web/API | Phase 0–5 已完成 |
| P3 | 个人 Alpha | 阅读、进度、标注和本地检索 | R1–R3 核心已实现；书签/最近阅读/搜索与真实使用待补 |
| P4 | AI Alpha | NotebookLM 问答、范围与引用 | Adapter、整书/选区/笔记已实现；章节范围与 live 验收待补 |
| P5 | 知识与创作 Beta | KnowledgeNote、内容修订、Obsidian、工作台 | C0–C3 已实现；真实 Vault 与模板质量待验收 |
| P6 | 发布 Beta | 人工确认后的平台适配与发布 | 未开始，须先通过 Gate 3 |
| P7 | 私人测试 | 验证持续使用价值 | 未开始 |
| P8 | 公测准备 | 安装、升级、备份、安全与恢复 | L0–L3 已完成；L4 发布代码就绪，外部 Gate 待处理 |
| P9 | v1.0 | 发布受支持的 local-first Web 工具 | 未开始 |

### 本地 Web 分发轨 / Local Web Track

详细契约见 [本地 Web 工具分发实施计划](docs/architecture/local-web-distribution-plan.md) 与 [ADR-0009](docs/architecture/adr/0009-local-web-tool-distribution.md)。

| 阶段 | 交付 | 退出证据 |
| --- | --- | --- |
| L0 | ADR/PRD/Roadmap/文档方向冻结 | **已完成**；不再承诺 Tauri，与 ADR-0004/0005 一致 |
| L1 | `diandianreading web`、兼容 alias、真实进程 E2E | **已完成**；installed wheel 启动 Uvicorn、readiness、SIGTERM |
| L2 | `setup notebooklm`、`doctor`、`open` | **已完成**；Chromium 原子安装、脱敏诊断、安全 reopen |
| L3 | 删除 Tauri/Rust/Sidecar-only 代码与 macOS CI | **已完成**；Python/Web 全量质量门通过 |
| L4 | Preview/Stable 分发准备 | workflow/manifest/runbook 已实现；License、名称 ownership、外部发布待维护者 |
| L5 | 真实产品验收 | 浏览器、NotebookLM、Obsidian 由维护者手测 |

### 已完成的功能交付轨

#### Reader Track

| 阶段 | 交付 | 状态 |
| --- | --- | --- |
| W0 | 锚点、Annotation、Progress 契约 | 已完成 |
| R1 | 正文、章节、进度服务 | 已完成 |
| R2 | 标注存储、CRUD、再锚定 | 已完成 |
| R3 | React 阅读器、PDF/Markdown、标注 UI | 代码完成，手工验收待补 |
| R4 | 引用定位、选区/笔记 Chat Scope | 代码完成，live 抽样待补 |

#### Content Track

| 阶段 | 交付 | 状态 |
| --- | --- | --- |
| C0 | KnowledgeNote/ContentAsset/Obsidian 契约 | 已完成 |
| C1 | 保存回答为 KnowledgeNote | 已完成 |
| C1b | 可恢复内容生成、修订作者归属 | 已完成 |
| C2 | Obsidian 增量导出与冲突保护 | 已完成 |
| C3 | React 创作工作台 | 代码完成，模板质量待补 |

### 历史 Desktop Track

D1 Sidecar 与 D2 Tauri 壳曾完成可行性和 CI 实验；D3 的 React/Vite 成果保留为 Web UI。ADR-0006 已被 ADR-0009 替代，D4–D6 不再实施。历史文档保留证据，不构成未来承诺。

---

## 2. 执行原则

1. 每阶段单独分支、PR、review、offline E2E 与 CI，线性合并。
2. Fake/contract 测试证明代码边界，不替代真实 Provider、真实浏览器和真实 Vault。
3. 默认 PR CI 不持有 Provider、PyPI 或发布 Secret。
4. 数据和 Credential 始终保存在稳定 App Home，不进入 uvx/tool 环境。
5. 不为简化安装削弱 localhost Token、Session、Origin、CSRF 和资源限制。
6. 任何用户数据迁移先备份、后迁移、验证后提交；失败不创建空库伪装成功。
7. L2 已先迁移 Browser Provisioning，L3 再删除 D1/D2 专属代码。
8. 产品阶段按退出证据推进，不按提交数量推进。

---

## 3. P0–P2：产品与技术地基

### 已完成

- 单用户、local-first 产品边界；
- Python 模块化单体与架构边界测试；
- SQLite migration/checksum、私有 FileStore；
- 持久 Job、Lease/fencing、Intent/reconciliation；
- NotebookLM Adapter 与隔离 Credential；
- 可选 Z-Library Adapter，默认关闭且要求权利确认；
- FastAPI 同源 Web/API、Session/CSRF、SSE；
- React/Vite production UI；
- installed-wheel Phase 0–5/R/C E2E。

### 仍需补齐

- 公开分发 License；
- PyPI 包名 ownership 与 Trusted Publisher 外部配置；
- first-class 在线备份命令（当前只有停机 runbook）；
- 从 TestPyPI/PyPI 安装的 clean-machine uvx 证据。

---

## 4. P3：个人 Alpha——阅读与标注

### 已实现

- PDF/EPUB/Markdown 导入；
- 书库和正文读取；
- PDF.js 与派生 Markdown 阅读；
- 章节导航和阅读进度；
- 划线、锚定笔记、颜色、软删除和恢复；
- 内容变化后的唯一 quote 再锚定与 orphan 标记；
- 引用和标注跳回原文。

### 待实现

- 书签；
- 最近阅读视图；
- 本地书名/作者/正文/标注搜索；
- 长文和真实 PDF 性能测量；
- 标注导出完整性和连续七天真实使用。

### 退出标准

- 5–10 本合法真实资料的导入成功率达到目标并有记录；
- 阅读进度与标注在重启、重新导入、升级后不丢失；
- 本地搜索、书签和最近阅读满足基本使用；
- 真实浏览器键盘、窄窗口、高 DPI 和 PDF 样本通过；
- 连续使用一周无阻塞性数据丢失。

---

## 5. P4：AI Alpha——NotebookLM

### 已实现

- Provider Session/Adapter；
- 创建 Workspace、上传正文与持久映射；
- whole-book Chat；
- `selection` 与 `notes` QueryScope；
- `effective_scope`、防空范围扩大和注入定界；
- 本地 Citation 与唯一 excerpt 定位；
- ChatRun Lease、取消、重试与模糊结果 fail closed；
- 回答保存为 KnowledgeNote 与内容生成入口。

### 待实现/验证

- `chapters` 与 `conversation_default` QueryScope；
- 真实 NotebookLM 登录和 Session 恢复；
- 真实引用定位抽样；
- 个人笔记上下文是否确实改善回答；
- Provider 页面变化、断网和重启恢复；
- 回答质量人工评分。

### 退出标准

- 真实测试问题中至少 80% 可接受；
- 选区/笔记/章节范围不跨书、不扩大；
- Provider 失败时阅读与本地笔记仍可用；
- 超时、响应丢失、过期 Lease 与取消不会重复创建远程资源；
- live 结果和失败记录进入手动验收文档。

---

## 6. P5：知识与创作 Beta

### 已实现

- KnowledgeNote 与 save-as-note 幂等；
- 内容资产、可恢复生成、AI/human 修订作者归属；
- 内容编辑与版本历史；
- Vault 配置；
- Book/Highlights/Notes/Summary/Social Posts 导出；
- stable ID 增量对账；
- 重命名跟随、手改冲突文件、路径封闭与 frontmatter 防注入；
- React 创作工作台。

### 待验证

- 真实 Obsidian Vault；
- `obsidian://` 深链接；
- 手工重命名和冲突体验；
- 至少三个内容模板可直接用于后续编辑/发布；
- 冲突频率是否说明需要重新评估单向导出。

### 退出标准

- 生成结果可编辑且 AI 原稿不可变；
- 重复导出不产生重复文件；
- 手工修改永不被静默覆盖；
- 至少三个模板通过维护者质量判断；
- Provider 失败不破坏本地草稿和修订历史。

---

## 7. P6：发布 Beta

P6 暂不自动进入。只有 Gate 3 证明 AI 内容确实减少创作时间后才启动。

候选范围：

- 先支持一个文字平台，再支持一个图片/视频平台；
- 平台适配、预览、dry-run、人工确认、排程和历史；
- 每个平台独立状态；
- 发布前 Intent/correlation key；
- 超时或响应丢失先 reconciliation，不 blind republish；
- 媒体失败保留文本草稿。

退出标准：

- 连续 20 次受控发布不丢草稿；
- 失败可安全重试；
- 用户可在发布前修改每个平台版本；
- 至少两个平台完成真实测试。

---

## 8. P7：私人测试

### 规模

- 5–20 名受邀用户；
- 至少两周；
- 至少一半为知识型创作者或重度读者。

### 核心任务

- 通过 uv 安装并启动；
- 导入 2 本资料；
- 完成 3 次阅读/标注；
- 进行 3 次 AI 问答；
- 生成 2 个内容资产；
- 导出 1 次 Obsidian；
- 若 P6 已通过 Gate，再执行发布。

### 退出标准

- 50% 以上用户在两周内第二次使用；
- 核心任务无高频阻塞或数据丢失；
- 至少 5 条具体可执行反馈；
- 安装与 Provider setup 不需要开发者现场修环境。

---

## 9. P8：公测准备

### 安装与升级

- `uvx diandianreading web` clean-machine smoke；
- `uv tool install/upgrade`；
- immutable tag、wheel/sdist hash 与 changelog；
- schema compatibility 与 downgrade 拒绝；
- App Home 在工具环境重建后保持完整；
- Playwright Chromium 显式 setup、升级与清理；
- 备份、恢复、卸载和重新安装说明。

### 安全

- ADR-0003/0004/0005/0009 全部关键路径有证据；
- 只绑定回环，不支持 LAN/公网；
- Token 损坏/丢失时 fail closed 并可恢复；
- Chromium 不进入基础 wheel、不静默下载、不依赖开发缓存；
- PyPI Trusted Publishing/OIDC 或受控发布凭据；
- Secret、账号、正文和路径不进入日志/诊断包；
- Z-Library 保持默认关闭和权利约束。

### RC 验收

- 核心流程通过率 ≥95%；
- 严重 Bug 为 0；
- 高优先级 Bug 不超过 3；
- installed real-process E2E 与发布后 uvx smoke 通过；
- 备份/恢复、Token 轮换、migration 中断通过；
- 真实 NotebookLM 与 Obsidian 受控验收通过。

---

## 10. P9：v1.0

### 上线范围

- PDF/EPUB/Markdown 导入；
- 阅读、进度、划线与个人笔记；
- 基础书库、书签、最近阅读和本地搜索；
- NotebookLM 问答、来源和部分内容生成；
- Markdown/Obsidian 导出；
- 内容历史和任务状态；
- P6 只有在真实平台通过时才进入承诺范围。

### 发布清单

- [ ] `uvx diandianreading web` 从正式 PyPI 包启动；
- [ ] License 与分发渠道一致；
- [ ] Git tag、wheel/sdist、SHA-256 和 changelog 完整；
- [ ] Python/OS/Provider 支持矩阵明确；
- [ ] App Home、Schema、Chromium revision 和升级说明完整；
- [ ] clean-machine 安装、启动、Ctrl+C、重启和升级完成；
- [ ] SQLite/文件备份与恢复演练完成；
- [ ] Token/Session 恢复和端口冲突行为完成；
- [ ] 隐私、权利边界、AI 内容提示与使用说明完成；
- [ ] 新手引导、示例导入和反馈入口完成。

---

## 11. 版本策略

| 版本 | 目标 |
| --- | --- |
| v0.1 | Local Web Developer Preview：Web CLI、setup/doctor、Preview 发布 |
| v0.2 | 个人 Alpha：阅读器缺口与真实浏览器验证 |
| v0.3 | AI Alpha：章节范围与 NotebookLM live 验收 |
| v0.4 | 知识 Beta：Obsidian 与模板质量稳定 |
| v0.5 | 可选发布 Beta：通过 Gate 3 后的 Social Adapter |
| v0.9 | Local Web RC：安装、升级、备份、安全与恢复 |
| v1.0 | 受支持的 local-first Web 工具正式版 |

版本号与当前 Python package `0.1.0` 的对应关系在 L4 发布 PR 中冻结；未发布前不根据文档自动跳版本。

---

## 12. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| uv 对目标用户仍太技术化 | 首次采用受阻 | setup/doctor、根 README、clean-machine 测试；有证据后再评估 Homebrew |
| NotebookLM 接口变化 | AI 中断 | Adapter、健康检查、blocked 状态和本地降级 |
| Chromium 下载失败/过大 | 无法登录 Provider | 显式 setup、固定 revision、代理/磁盘诊断、版本化私有目录 |
| uvx 环境重建 | 用户误以为数据丢失 | App Home 独立、升级/卸载文档和恢复测试 |
| 本地 API 被网页/同机进程调用 | 文件与远程副作用 | Token、Peer+Host、Origin/CSRF、限额、禁用 proxy trust |
| 固定端口占用 | 无法启动 | fail closed；收集证据后再设计可认证动态 Origin |
| PyPI 包或发布凭据被篡改 | 本机代码执行 | immutable tag、hash、Trusted Publishing、最小 CI 权限 |
| 恶意下载/Archive/Parser | SSRF、路径穿越、耗尽 | 逐跳网络策略、流式上限、隔离解析与 Archive 限制 |
| 远程提交后响应丢失 | 重复资源/发布 | Intent、correlation、Lease fencing、reconciliation |
| 功能范围膨胀 | 核心体验不稳定 | Gate 先行，P6 不在 P3–P5 验收前自动启动 |

---

## 13. Go / No-Go Gates

### Gate 1：产品结构

进入条件：用户理解“阅读 → 思考 → AI → 知识”。

停止条件：产品被理解为普通书库或通用聊天。

### Gate 2：AI 集成

进入条件：阅读器与标注稳定。

停止条件：用户不愿留下划线和笔记。

### Gate 3：社交发布

进入条件：AI 结果确实减少创作时间，至少三个模板可用。

停止条件：结果需要完全重写或用户只需要 Obsidian。

### Gate 4：扩大用户

进入条件：uv 安装、Provider setup、核心闭环和数据恢复稳定。

停止条件：第三方、Credential、版权或数据安全边界未通过。

### Gate 5：云/社区

进入条件：个人工作流稳定且有明确公开分享需求。

停止条件：会推翻 local-first 核心或把产品变回传统社区阅读 App。

---

## 14. 当前执行顺序

```text
L0 文档/ADR 同步
→ L1 Web CLI + installed-process E2E
→ L2 setup/doctor/open
→ L3 桌面代码与 CI 退场
→ L4 Preview/Stable 分发准备
→ L5 维护者真实手动验收
→ 补齐 P3/P4/P5 产品缺口
→ Gate 3 决定是否进入 P6
```

当前不优先：

- Tauri/Electron/原生安装包；
- 公共书城和复杂社交关系；
- 云多租户和跨设备同步；
- 全平台发布或无人值守发布；
- 双向 Obsidian 同步；
- 大规模推荐算法。

---

## 15. v1.0 最终定义

```text
准备 uv
→ uvx diandianreading web
→ 浏览器安全建立本地 Session
→ 导入合法资料
→ 阅读并留下划线和想法
→ 向 AI 提问并查看来源
→ 生成和编辑内容
→ 保存到 Obsidian
→ 安全退出、重启和升级
→ 历史与数据保持完整
```

若 P6 通过 Gate 3，再把“预览 → 人工确认 → 发布/排程”加入正式闭环。产品完成不是功能数量最大，而是这条主链稳定、可恢复、可解释，并且用户愿意再次使用。
