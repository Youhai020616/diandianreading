# diandianreading 产品 PRD

> 版本：v0.3（本地 Web 工具分发版）
> 文档状态：产品方向与 MVP 规划
> 产品形态：local-first、通过终端启动本地 Web UI 的个人 AI 阅读、知识沉淀与内容发布工作台
> 更新时间：2026-08-14

---

## 1. 产品概述

### 1.1 一句话定位

diandianreading 是一个把“阅读、思考、AI 创作和社交发布”连接起来的个人内容工作台：用户读完一本书后，可以保留自己的划线和观点，让 AI 基于原文与个人笔记生成多种内容，再经过人工确认发布到社交媒体，并将最终成果沉淀到个人知识库。

### 1.2 产品愿景

让一本书不再只产生一次性的阅读体验，而是持续产生：

- 可检索的个人知识
- 可复用的观点和卡片
- 可发布的文章、图片、音频和视频
- 可以持续积累的个人主题与内容资产

### 1.3 核心闭环

```text
导入资料 → 阅读 → 划线/笔记 → AI 理解
      → 生成内容 → 人工编辑 → 多平台发布
      → 发布反馈 → 反哺知识库与下一次创作
```

### 1.4 产品原则

1. **阅读优先**：首页首先服务“继续阅读”，而不是展示后台指标。
2. **个人观点优先**：AI 输出应尽量基于用户的划线、笔记与上下文，而不是泛泛总结。
3. **来源可追溯**：生成的观点可以回溯到书籍章节、来源文档或用户笔记。
4. **用户拥有数据**：核心知识可以导出为 Markdown、JSON，并同步到 Obsidian。
5. **人工确认后发布**：AI 生成内容默认是草稿，不自动公开发布。
6. **平台适配而非一稿群发**：同一观点根据不同平台的语气、长度和媒体形式重新组织。

### 1.5 产品载体决策

第一版正式产品采用 **local-first Web 工具**：

- 用户通过 `uvx diandianreading web` 或持久 tool install 在终端启动本地服务；
- React + TypeScript + Vite 提供浏览器产品 UI；
- Python/FastAPI 模块化单体拥有 Domain、Application、HTTP/SSE、SQLite、私有文件、持久 Worker 和 Provider Adapter；
- UI、API 与 Worker 在一个受控本地 Runtime 中运行，固定监听 `127.0.0.1:3000`；
- 默认 App Home 为 `~/.diandianreading/`，不随 uvx 环境或启动目录变化；
- 不继续 Tauri/Electron、原生安装包、签名公证、应用内 Updater 或 Windows native bundle；
- 不在个人 MVP 引入公共云、多租户 Backend、远程代理或第二套业务状态。

完整实施边界见 [本地 Web 工具分发实施计划](docs/architecture/local-web-distribution-plan.md) 与 [ADR-0009](docs/architecture/adr/0009-local-web-tool-distribution.md)。历史桌面方向见已被替代的 ADR-0006；D1/D2 实现已删除，仅保留实验记录。

---

## 2. 产品目标与非目标

### 2.1 MVP 目标

在个人使用场景下，完整跑通以下流程：

1. 导入一本用户有权使用的 PDF/EPUB 或其他资料。
2. 在阅读器中继续阅读、划线和写想法。
3. 自动为该书建立 NotebookLM 工作空间。
4. 基于原文与用户笔记进行问答和内容生成。
5. 生成读书卡片、长文、幻灯片或视频脚本。
6. 将结果导出到 Obsidian。
7. 通过 SocialCLI 预览并发布到至少两个社交平台。

### 2.2 非目标（MVP 不做）

- 建设大规模正版电子书商城。
- 提供面向公众的 Z-Library 下载服务。
- 直接破解或绕过电子书 DRM。
- 第一阶段实现完整好友关系、评论、点赞和私信社区。
- 第一阶段支持所有社交平台的原生发布能力。
- 第一阶段开发原生 iOS/Android 阅读器。
- 第一阶段建设公共多租户云 Backend、公开注册、跨设备云同步或社区。
- 用自建大模型完全替代 NotebookLM。

### 2.3 成功标准

个人版首个可用版本满足：

- 5 分钟内导入并开始阅读一本书。
- 从导入到生成第一条 AI 内容不超过 10 分钟（不含第三方异步等待）。
- 用户可以明确知道每条 AI 内容来自哪些来源。
- 一次内容生成至少能派生出 3 种平台形式。
- 用户可以一键将结果保存为 Obsidian Markdown。
- 发布前始终可预览、编辑、取消和重试。
- 用户只需准备 uv，即可通过一条终端命令启动核心流程；运行时不要求 Node、Rust、Tauri 或项目源码。

---

## 3. 目标用户

### 3.1 核心用户：知识型创作者

特征：

- 经常阅读书籍、文章和研究资料。
- 需要持续输出公众号、小红书、Bilibili、X 等内容。
- 有 Obsidian、Notion 或其他知识管理习惯。
- 不希望每次发布都从空白文档开始。

核心诉求：

> 我想把真正读过、想过的内容变成有个人观点的公开表达。

### 3.2 次级用户：深度阅读者

- 想更好地记住和复习读过的内容。
- 需要跨书搜索自己的划线和笔记。
- 希望通过 AI 发现不同书籍之间的联系。
- 不一定主动运营社交账号，但愿意保存可分享的内容。

### 3.3 后续用户：研究者与专业工作者

- 处理论文、报告、会议材料和行业资料。
- 需要引用和来源追溯。
- 需要快速生成报告、演示文稿和 briefing。

---

## 4. 核心用户场景

### 场景 A：读完一本书后快速产出内容

1. 用户打开 diandianreading，点击“继续阅读”。
2. 在书籍最后一章继续阅读并留下新的划线。
3. 点击“基于我的划线生成一组内容”。
4. 系统生成：长读书笔记、8 张分享卡片、短视频脚本。
5. 用户编辑标题和个人观点。
6. 选择小红书和 Bilibili，预览并分别发布。
7. 所有内容和来源保存到 Obsidian。

### 场景 B：围绕自己的想法继续思考

1. 用户在“想法”页面查看最近的划线和个人笔记。
2. AI 发现 3 条笔记都涉及“减少用户思考成本”。
3. 用户点击主题，查看相关书籍和来源。
4. 用户询问：“这个观点和我正在做的产品有什么关系？”
5. AI 给出带来源的回答，并生成一张主题卡片。

### 场景 C：定期内容生产

1. 用户在创作工作台选择最近一个主题。
2. 系统列出相关书籍、笔记和已生成内容。
3. 用户选择生成一周内容包。
4. 系统生成 1 篇长文、3 条短帖、1 组卡片、1 个视频脚本。
5. 用户在发布日历里安排发布时间。

---

## 5. 信息架构

侧边栏一级导航：

```text
SPACE
├── 今日       阅读首页和今日上下文
├── 书库       所有书籍与资料
├── 想法       划线、个人笔记、AI 发现
├── 创作       AI 生成的文章、卡片、音频、视频
└── 发布       草稿、审核、排程、历史

COLLECTION
├── 主题       个人知识主题与关联关系
└── 历史       阅读、创作和发布时间线
```

顶部模式切换：

- 阅读：继续阅读、查看当前书籍和阅读状态。
- 思考：聚合划线、笔记、主题和 AI 关联。
- 创作：从书籍和主题生成内容资产。

---

## 6. 页面与功能需求

## 6.1 今日（首页）

### 产品目的

让用户打开应用后立刻知道“今天该从哪里继续”，并看到自己最近正在形成的想法。

### 页面结构

1. 顶部：阅读 / 思考 / 创作模式、全局搜索、个人头像。
2. 问候区：今天的阅读提示和一句简短引导。
3. 继续阅读卡片：
   - 当前书籍封面
   - 章节标题
   - 阅读进度
   - 继续阅读
   - 问问这本书
4. 最近留下的想法：展示 1～3 条最新划线或笔记。
5. AI 给你的下一步：
   - 关联主题
   - 继续追问
   - 生成卡片
6. 正在长成的内容：展示草稿、播客脚本、卡片和待发布内容。
7. 右侧信息区：
   - 本周阅读日历
   - 最近形成的主题
   - Obsidian 连接状态
   - 内容产出轨迹

### 关键交互

- 点击“继续阅读”进入阅读器并定位上次位置。
- 点击“问问这本书”打开基于当前书籍的 AI 对话。
- 点击想法直接跳转到原文位置。
- 点击 AI 建议直接生成内容或进入主题页面。

---

## 6.2 书库

### 功能

- 查看全部书籍、正在读、想读、已读。
- 书名、作者、标签和全文搜索。
- 按最近阅读、最近导入、阅读进度排序。
- 导入 PDF、EPUB、Markdown、网页或其他合法资料。
- 创建书籍的 NotebookLM 工作空间。
- 删除、归档或重新处理资料。

### 书籍状态

```text
importing → ready → reading → completed → archived
```

### 书籍卡片字段

- 封面
- 书名
- 作者
- 当前章节
- 阅读进度
- 划线数量
- 笔记数量
- AI 内容数量
- 最后阅读时间

### 验收标准

- 导入成功后 10 秒内显示书籍卡片。
- PDF/EPUB 解析失败时显示明确的错误原因和重试按钮。
- 删除书籍前需要二次确认，并说明是否同时删除 AI 内容和本地文件。

---

## 6.3 阅读器

### 功能

- PDF 阅读。
- EPUB 章节阅读。
- 目录导航。
- 阅读进度自动保存。
- 划线和颜色标记。
- 针对划线写个人想法。
- 书签。
- 通过深链接返回原文位置。
- 选中文本后：标记、写想法、问 AI、复制。

### 阅读体验原则

- 阅读页面不展示过多 AI 控件。
- AI 入口只在用户需要时出现。
- 不干扰用户连续阅读。
- 标注后能快速返回正文。

### 重点交互

```text
选中文本
  ├── 标记
  ├── 写想法
  ├── 问问 AI
  └── 保存到主题
```

---

## 6.4 想法

### 功能

- 聚合所有个人划线。
- 聚合所有个人笔记。
- 按书籍、主题、标签和时间筛选。
- 点击回到原文位置。
- 将多条笔记合并为一个主题。
- 让 AI 发现反复出现的关键词和观点。
- 将想法发送到 NotebookLM 继续追问。
- 导出为 Markdown、JSON。

### 想法对象类型

1. `highlight`：原文划线。
2. `note`：用户手写内容。
3. `ai_insight`：AI 发现的关联或建议。
4. `reflection`：用户在阅读后的长反思。

### AI 发现示例

```text
你最近 3 条笔记都在讨论“减少用户的思考成本”。
相关书籍：设计心理学、深度工作、创新者的窘境。
建议创建主题：让复杂变简单。
```

---

## 6.5 创作工作台

### 功能

- 选择一本书、一个主题或一组笔记作为输入。
- 选择内容类型。
- 生成和重新生成。
- 查看来源引用。
- 编辑标题、正文、结构和语气。
- 生成平台版本。
- 保存为草稿。
- 导出到 Obsidian。

### 内容类型

| 类型 | 结果 |
|---|---|
| 读书报告 | 长文、结构化总结、引用 |
| 读书卡片 | 1 张或多张视觉卡片 |
| 幻灯片 | PDF、PPTX 或图片序列 |
| 播客脚本 | 开场、观点、转场、结尾 |
| 视频脚本 | 标题、分镜、旁白、字幕建议 |
| 短帖 | 小红书、X、微博等平台版本 |
| 复习题 | 测验、闪卡、知识检查 |

### 内容状态

```text
queued → generating → draft → editing → approved → scheduled → published
```

### 生成请求字段

- 输入来源：书籍、章节、笔记、主题。
- 输出格式。
- 语言。
- 目标平台。
- 语气：理性、个人化、故事化、简洁。
- 长度。
- 是否必须保留引用。
- 是否使用第一人称。

---

## 6.6 发布

### 功能

- 查看所有草稿。
- 预览不同平台版本。
- 手动编辑每个平台的标题、正文、标签和媒体。
- 多平台发布。
- 定时发布。
- 发布前人工确认。
- 查看发布结果。
- 失败重试。
- 查看历史内容。

### 平台适配

```text
一份 ContentPackage
    ├── 小红书：标题 + 短段落 + 图片卡片 + 话题
    ├── Bilibili：标题 + 简介 + 视频 + 标签
    ├── X：短帖或 Thread
    ├── Reddit：标题 + Markdown 正文
    └── 公众号：长文 + 配图
```

### 发布保护

- 默认不自动发布。
- 首次发布必须确认账号和平台。
- 同一内容重复发布时提示。
- 内容包含长引用时提示版权风险。
- 平台接口失败时保留草稿，不丢失内容。

---

## 6.7 主题

### 功能

- 自动聚合相关划线、笔记和书籍。
- 手动创建主题。
- 主题之间建立关联。
- 查看主题时间线。
- 主题下生成内容。
- 将主题导出为 Obsidian 文件夹。

### 主题页面

- 主题名称和简介。
- 相关书籍。
- 相关划线。
- 用户观点。
- AI 总结。
- 关联主题。
- 已生成内容。
- 下一步阅读建议。

---

## 6.8 历史

### 功能

- 阅读时间线。
- 划线和笔记时间线。
- 内容生成时间线。
- 社交发布历史。
- 按日期、书籍和行为类型筛选。
- 从历史事件跳回原书或内容。

---

## 7. 三方项目集成方案

## 7.1 notebooklm-py

### 角色

NotebookLM 的程序化能力层：

- 创建 Notebook。
- 添加来源。
- 基于来源问答。
- 生成报告、幻灯片、音频、视频、测验和闪卡。
- 下载生成结果。

### 集成策略

旧版“第一阶段先通过 CLI、稳定后切换 Python API”的方案已由 [ADR-0002](docs/architecture/adr/0002-notebooklm-public-python-api.md) **Superseded**。目标生产集成从首个 NotebookLM Adapter 起直接使用固定版本的公开 `NotebookLMClient` Python API；CLI 只用于人工诊断，或作为有退出期限、`shell=False` 且通过同一 Contract Test 的临时兼容 Adapter。

```text
diandianreading Orchestrator
       ↓
NotebookLM Adapter
       ├── create_notebook()
       ├── add_source()
       ├── ask()
       ├── generate_artifact()
       └── download_artifact()
```

### 设计约束

- NotebookLM 为异步服务，必须使用任务队列。
- 记录 task_id、notebook_id、source_id 和 artifact_id，但外部 ID 存在独立 Provider 映射，不写入 `Book`。
- 每个远程写在调用前持久化 operation intent、唯一 correlation key 和输入指纹；超时、断连、取消或 Worker 失租后先 reconciliation，不按空 ID 盲目重建。
- 重试遵守 SDK 操作幂等矩阵与 Job attempt/max elapsed 上限；`AUTH_REQUIRED` 进入独立 blocked reason，不伪装成普通失败。
- 生成结果必须保存原始来源和提示词版本。

## 7.2 zlibrary-to-notebooklm

### 角色

作为“资料导入和格式处理”的参考模块，而不是公众书城。

可复用能力：

- PDF/EPUB 文件处理。
- EPUB 转 Markdown。
- 大文件按章节分块。
- 标题清洗和文件命名。

### 生产环境边界

- 本地上传是默认入口；Z-Library Adapter 默认关闭。
- 调用 Z-Library Adapter 前必须逐项保存不可预选的 `RightsProvenance`（权利依据、政策版本、确认时间、脱敏来源定位，完成后绑定内容哈希）；缺失或不匹配时拒绝创建 Acquisition Job。
- 用户声明用于执行产品政策与审计，不包装成法律验证；不对公众暴露未经授权或通用下载流程。
- 初始 URL、每次 Redirect、浏览器子请求、下载、Archive 和 Parser 都执行 allowlist、非公网地址拒绝、大小/时间/类型、防穿越/解压炸弹、无网络和资源上限。
- 不绕过访问控制、验证码、付费限制或 DRM。
- 不把第三方来源当作产品的唯一内容供应链。

## 7.3 SocialCLI

### 角色

社交媒体发布适配层：

- 登录和账号管理。
- 平台内容适配。
- 发布、定时和批量任务。
- 发布历史。
- dry-run 预览。

### 集成策略

第一阶段通过安全的子进程调用或 CLI Adapter；禁止直接拼接 shell 命令。第二阶段抽取稳定的 Python Publisher 接口。

```text
ContentPackage
       ↓
PlatformAdapter
       ├── XiaohongshuAdapter
       ├── BilibiliAdapter
       ├── TwitterAdapter
       └── RedditAdapter
```

### 平台优先级

MVP 选择 2 个平台，建议一个中文平台 + 一个国际平台。平台能力以实际可用性为准，失败的发布任务保留为草稿。

## 7.4 Obsidian

### 角色

用户长期知识的可拥有出口：

- 保存书籍笔记。
- 保存个人想法。
- 保存主题卡片。
- 保存 AI 生成结果。
- 保存社交内容版本。

### MVP 集成

- 指定 Vault 目录。
- 导出 Markdown。
- 使用 YAML frontmatter 保存外部 ID。
- 通过 `obsidian://` 打开笔记。

### 推荐目录

```text
Vault/
├── Books/
│   └── 设计心理学/
│       ├── Book.md
│       ├── Highlights.md
│       ├── Notes.md
│       ├── Summary.md
│       └── Social Posts/
├── Topics/
└── Content/
```

### 数据归属

- 产品数据库：阅读进度、任务状态、发布状态、外部服务 ID。
- Obsidian：用户长期维护的知识笔记和主题内容。

---

## 8. 数据模型

### 8.1 User

| 字段 | 说明 |
|---|---|
| id | 用户 ID |
| display_name | 显示名称 |
| timezone | 时区 |
| preferences | 阅读和生成偏好 |
| created_at | 创建时间 |

### 8.2 Book

| 字段 | 说明 |
|---|---|
| id | 书籍 ID |
| title | 书名 |
| author | 作者 |
| cover_url | 封面 |
| status | importing / reading / completed |
| progress | 阅读进度 |
| source_hash | 文件哈希 |
| original_asset_id | 原始 `DocumentAsset` ID；Asset 使用逻辑 `StorageKey`，不保存物理路径 |
| created_at | 导入时间 |

旧字段 `Book.notebooklm_id` 已由 [集成计划](docs/architecture/integration-plan.md) **Superseded**。NotebookLM 等 Provider 映射独立保存，避免把 Book 绑定到单一 Provider：

| ExternalWorkspace 字段 | 说明 |
|---|---|
| id | 本地映射 ID |
| book_id | 所属书籍 |
| provider | Provider 名称 |
| credential_profile | 逻辑 Profile；不是路径 |
| external_id | Provider Workspace ID |
| status | Provider 映射状态 |

### 8.3 Annotation

| 字段 | 说明 |
|---|---|
| id | 标注 ID |
| book_id | 所属书籍 |
| chapter_id | 所属章节 |
| type | highlight / note / ai_insight |
| content | 内容 |
| location | 原文定位信息 |
| tags | 标签 |
| created_at | 创建时间 |
| synced_to_obsidian | 是否已同步 |

### 8.4 Artifact

| 字段 | 说明 |
|---|---|
| id | 内容 ID |
| input_ids | 输入来源 ID |
| type | report / card / slides / audio / video / post |
| title | 标题 |
| content | 文本或结构化数据 |
| media_urls | 媒体文件 |
| prompt_version | 提示词版本 |
| status | 内容状态 |
| created_at | 创建时间 |

### 8.5 PublishJob

| 字段 | 说明 |
|---|---|
| id | 发布任务 ID |
| artifact_id | 关联内容 |
| platform | 平台 |
| adapted_content | 平台适配版本 |
| scheduled_at | 计划时间 |
| status | draft / approved / scheduled / published / failed |
| external_post_id | 外部平台 ID |
| error_message | 错误信息 |

---

## 9. 技术架构建议

下图箭头表示 **runtime call/data flow**，不是模块 import 方向；编译时依赖遵守 `interfaces → application → domain`、`infrastructure → application ports`。

```text
uv / uvx terminal entry
   └── local Python Runtime
       ├── React / TypeScript / Vite static UI
       ├── FastAPI same-origin HTTP/SSE
       └── embedded durable Worker
           ↓ localhost:3000
Authenticated Local API / Application Layer
   ├── Library Service
   ├── Reader & Annotation Service
   ├── Topic Service
   ├── Content Studio Service
   ├── Publish Service
   └── Obsidian Export Service
           ↓
     Durable Job Queue / Worker
       ├── Restricted Document Preparation Adapter
       ├── NotebookLM Adapter
       ├── Media Processor
       └── SocialCLI Adapter
           ↓
     SQLite + Private FileStore + SQLite FTS

Terminal、Browser 与自动化使用同一 Python core 和 App Home。
```

### 推荐技术选择（本地 Web 版）

- 分发：PyPI/GitHub immutable release；`uvx diandianreading web` 为一次性入口，`uv tool install` 为持久安装。
- 前端：React + TypeScript + Vite；production build 进入 Python wheel，不使用 Next.js Server。
- 阅读器：PDF.js + 受限 Markdown renderer；EPUB 使用派生 Markdown，不引入原生容器渲染。
- 后端：按 [ADR-0001](docs/architecture/adr/0001-local-first-modular-monolith.md) 使用 local-first Python 模块化单体；FastAPI、Worker 与 Provider Client 由同一进程管理。
- 本地 Web 安全与分发：遵守 [ADR-0005](docs/architecture/adr/0005-local-api-security.md) 与 [ADR-0009](docs/architecture/adr/0009-local-web-tool-distribution.md)。
- 数据库：个人版使用 SQLite；只有产品转为多租户云服务时才重新评审 PostgreSQL。
- 文件：个人版使用本地私有 FileStore；云对象存储不是 local-first MVP 的隐含依赖。
- 任务：个人版使用 SQLite 持久队列/单 Worker；云队列只有多租户或独立扩缩容时再评审。
- 搜索：SQLite FTS 起步，后续按本地规模证据评估独立搜索服务。
- 媒体：PyMuPDF、Pillow、ffmpeg、python-pptx。

---

## 10. MVP 开发计划

### Phase 0：原型验证

- 完成阅读首页。
- 完成侧边栏页面原型。
- 完成阅读器演示。
- 完成 AI、Obsidian、发布交互的假数据流程。

### Phase 1：个人阅读核心

- 上传 PDF/EPUB。
- 解析书名、作者、目录。
- 在线阅读。
- 保存阅读进度。
- 划线、笔记、书签。
- 书库和想法页面接入真实数据。

### Phase 2：NotebookLM 集成

- 自动创建 Notebook。
- 上传书籍和标注。
- 书籍问答。
- 生成报告、卡片和脚本。
- 显示生成任务进度。
- 失败重试和结果下载。

### Phase 3：Obsidian 集成

- Vault 配置。
- Markdown 导出。
- YAML ID 映射。
- `obsidian://` 打开链接。
- 增量同步。

### Phase 4：内容发布

- ContentPackage 统一数据结构。
- 两个平台的内容适配。
- 预览和人工确认。
- 定时发布。
- 发布历史和失败重试。

### Phase 5：个人知识网络

- 主题自动发现。
- 书籍、想法、主题、内容之间的关联。
- 主题页和时间线。
- 基于阅读历史的内容建议。

---

## 11. 合规、安全与风险

### 11.1 内容版权

- 只处理用户有权使用的内容。
- 对外分享默认分享用户自己的总结和观点，而不是整本书正文。
- 对长引用、连续章节引用和完整内容导出进行提示或限制。
- 不提供 DRM 破解或未经授权的书籍下载服务。

### 11.2 凭证与私有文件安全

- `CredentialRef` 是只有 `provider/profile` 的不透明引用；Domain、业务数据库和 API 不保存 Credential 物理路径或 Secret。
- Google/NotebookLM、外部资料源和社交平台凭据按 Provider 物理隔离。只有 Infrastructure Resolver 能映射到应用凭据根目录中的路径并传给 SDK。
- POSIX 上应用根目录、凭据、文档、Job 与备份目录使用当前用户所有的 `0700`，数据库、WAL/SHM、Credential、文档对象、Job 文件和备份使用 `0600`；拒绝符号链接、错误 owner/type 和越界路径。
- 普通文件使用同目录 staging、`fsync` 和原子发布；SQLite 使用事务/backup API，不 replace 活跃数据库。默认备份排除凭据。
- Obsidian Vault 是用户选择的外部边界，不与应用私有 FileStore 混为同一受管根目录；写入前单独校验授权目录和链接边界。

### 11.3 第三方接口与任务风险

- NotebookLM 使用的接口可能发生变化。
- SocialCLI 的部分平台依赖浏览器 Cookie 或非稳定接口。
- Job 生命周期 `queued/running/blocked/completed/failed/cancelled` 与业务 `current_step`、`blocked_reason`、取消请求和 Lease 正交；UI/API 分字段展示。
- 长任务具备有界超时/重试、Step checkpoint、调用前远程 Intent、Lease fencing、取消安全点和 reconciliation。
- `AUTH_REQUIRED` 是 `blocked_reason`；Provider 结果不确定时使用 `REMOTE_OUTCOME_AMBIGUOUS`，不能 blind recreation。
- 第三方失败不能导致用户草稿或笔记丢失。

### 11.4 AI 内容风险

- AI 生成内容必须标记为草稿。
- 回答需要显示引用或来源。
- 发布前必须由用户确认。
- 医疗、法律、金融等高风险内容增加人工核验提示。

### 11.5 本地 Web Runtime 安全

- `localhost:3000` 只是网络暴露边界，不是用户授权。
- 每安装实例使用独立 Token；浏览器使用短期服务端 Session。所有业务 API、SSE 和 WebSocket 都认证。
- 同时校验实际 Peer 与 `Host`，默认 same-origin；浏览器写请求校验精确 `Origin` 和 Session 绑定 CSRF Token。
- 默认拒绝 CORS，不接受 Token 查询参数；SSE/WS 单独执行握手认证、Origin 和连接/消息上限。
- trusted proxy/转发 Header 支持默认关闭；Header、Body、上传、批量、并发和超时都有显式上限。
- 服务固定绑定回环地址，不提供 `0.0.0.0`、LAN、远程代理或公共部署参数；端口冲突时不附着、不杀进程、不随机换端口。
- Bootstrap Secret 只通过 readiness 后生成的 URL Fragment 单次传递，不进入参数、普通日志、文件或遥测。
- Python 包安装不执行浏览器下载；Playwright Chromium 由显式 setup 写入私有版本化目录并校验。
- 完整约束与 fail-closed 回滚见 [ADR-0005](docs/architecture/adr/0005-local-api-security.md) 和 [ADR-0009](docs/architecture/adr/0009-local-web-tool-distribution.md)。

### 11.6 不可信资料与权利来源

- URL、Redirect、下载名、Archive Entry、文档 metadata/正文和 Parser 输出都按敌对输入处理。
- 下载不得写入或扫描通用 `~/Downloads`；使用私有 Job staging、应用生成对象名、流式硬上限、类型/魔数、哈希和原子发布。
- EPUB/Archive 限制 Entry、解压后大小、压缩比、嵌套与路径/链接类型；Parser 最小权限、无网络并限制 CPU/内存/时间/输出。
- Z-Library 导入必须绑定可审计 `RightsProvenance`；无确认、未知权利类型或证据政策不满足时在 Adapter 调用前拒绝。

---

## 12. 核心指标

### 激活

- 首次导入成功率。
- 首次开始阅读完成率。
- 首次划线率。
- 首次生成内容完成率。

### 使用

- 周活跃阅读天数。
- 每本书平均划线数。
- 每本书平均个人笔记数。
- AI 问答次数。
- 内容生成次数。
- Obsidian 同步次数。

### 内容生产

- 生成内容被编辑的比例。
- 生成内容被发布的比例。
- 每本书产生的内容数量。
- 平台发布成功率。
- 重新生成率和人工修改比例。

### 长期价值

- 30 天后仍然回访的用户比例。
- 跨书搜索次数。
- 主题页面访问次数。
- 从旧笔记生成新内容的次数。
- 用户导出的知识资产数量。

---

## 13. 关键验收流程

### 验收流程 A：阅读到 AI

```text
导入 PDF
→ 书籍出现在书库
→ 打开阅读器
→ 划线并写想法
→ 点击问 AI
→ AI 回答显示来源
```

### 验收流程 B：AI 到 Obsidian

```text
选择 3 条想法
→ 生成主题总结
→ 保存到 Obsidian
→ 生成 Book.md / Notes.md / Summary.md
→ 点击链接可以打开对应文件
```

### 验收流程 C：AI 到社交发布

```text
选择一份总结
→ 生成卡片和平台文案
→ 查看小红书与 Bilibili 版本
→ 编辑标题和正文
→ 预览
→ 确认发布或定时发布
→ 发布失败时草稿仍然保留
```

---

## 14. 产品差异化

diandianreading 不与微信读书竞争书库规模，也不与 Buffer 竞争纯粹的社交排程能力。它的核心差异是：

1. **以用户真实阅读为内容源，而不是从热点反向创作。**
2. **以用户划线和想法为 AI 生成的中心。**
3. **内容有来源链路，可以回到原文和个人思考。**
4. **从一本书自动派生长文、卡片、音频、视频和短帖。**
5. **Obsidian 让知识属于用户，SocialCLI 让知识可以被传播。**

最终形成：

```text
读过的书 → 个人观点 → 知识主题 → 内容资产 → 社交影响力
```

---

## 15. 产品决策状态

### 15.1 已确认

1. 第一版是单用户、local-first 的个人工具，不建设带公共账号体系的多租户 Web 应用。
2. 正式产品通过 uv/uvx 在终端启动 Python 本地 Runtime，React/Vite 浏览器 UI 是主要产品界面。
3. 第一版先支持 PDF、EPUB 和本地 Markdown，不开发原生移动端。
4. Obsidian 第一版只做单向导出。
5. 公开社区、公共书库和跨设备云同步放到个人 MVP 之后。
6. 所有自动发布默认需要人工确认。

### 15.2 仍需证据或产品验证

1. 第一批社交平台选择小红书 + Bilibili，还是 X + Reddit。
2. NotebookLM 生成结果哪些必须保留本地副本，以及保留期限。
3. 是否在后续增加网页和 YouTube 导入。
4. 主题和内容何时开放公开分享，以及是否需要独立云服务。
5. Playwright Chromium setup 的代理、磁盘、清理和受支持平台范围。
6. PyPI Stable 的 License 与首批 OS/Python 支持矩阵。

本地 Web 分发未决项与证据门见 [本地 Web 工具分发实施计划](docs/architecture/local-web-distribution-plan.md)。
