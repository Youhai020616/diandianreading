# ADR-0001: 首个运行架构采用 local-first Python 模块化单体

## Status

`Proposed`

## Date

2026-08-03

## Context

产品 PRD 将 `diandianreading` 定位为个人优先的阅读、知识沉淀和内容发布工作台，并把“纯本地个人工具还是带账号的 Web 应用”保留为待确认问题。Roadmap P2 要求建立数据库迁移、文件目录、任务系统和外部服务 Adapter，但不鼓励过早建设复杂云架构。

当前工作区只有：

- 静态 HTML 原型 [`ai-reading-ecosystem-demo/index.html`](../../../ai-reading-ecosystem-demo/index.html)。
- 产品 [PRD](../../../diandianreading-PRD.md) 与 [Roadmap](../../../diandianreading-ROADMAP.md)。
- 两个 Python 集成项目：`notebooklm-py` 和 `zlibrary-to-notebooklm`。

核心数据包括本地 PDF/EPUB、阅读进度、标注、个人笔记、Obsidian Vault 路径及多个 Provider 的浏览器会话。第一版目标是验证个人完整闭环，而不是多租户公共服务。

## Decision

首个可运行版本采用 **local-first、单用户、Python 模块化单体**：

- 一个主 Python 应用包 `src/diandianreading`。
- `domain`、`application`、`infrastructure`、`interfaces` 和 `worker` 分层。
- SQLite 作为第一阶段数据库，本地目录作为文件存储。
- 持久 Worker 执行导入和 NotebookLM 长任务，但 Worker 不监听网络端口。
- Web/API 对外只暴露一个本地 Origin：`http://localhost:3000`；回环绑定只限制网络暴露，不构成授权，认证、Peer/Host、Origin/CSRF、SSE/WS 与限额遵守 [ADR-0005](0005-local-api-security.md)。
- 静态原型按 [ADR-0006](0006-desktop-first-tauri-python-sidecar.md) 演进为 React/TypeScript/Vite UI，并由 Tauri 2 桌面壳封装；前端与桌面选择不改变后端领域边界。
- NotebookLM、Z-Library、Obsidian 与发布平台全部通过 application Ports 接入。
- 本地书籍、标注、笔记和草稿是产品核心数据；第三方服务不可用时这些能力仍须可用。

依赖方向固定为：

```text
interfaces → application → domain
infrastructure → application ports
worker → application use cases
```

这里的箭头表示**编译时/导入时允许依赖**：箭头起点可以依赖终点。运行时请求或数据流图必须另行标注，不能据运行时调用方向反推模块 import 方向。

### 私有文件系统不变量

应用管理的数据库、WAL、文档、Job 工作区和备份执行同一套 fail-closed 规则：

- POSIX 启动时使用 `umask 0077`。`~/.diandianreading/`、`data/`、`files/`、`jobs/`、`backups/` 及其私有子目录归当前有效用户所有并保持 `0700`；`app.db`、`app.db-wal`、`app.db-shm`、文档对象、Job 临时/结果文件和备份文件保持 `0600`。
- 打开既有对象前使用不跟随链接的方式检查每个受管路径分量：根目录和父目录不得是符号链接，文件必须是当前用户所有的普通文件，规范化结果必须仍位于配置的受管根目录内。权限、所有权、类型或边界不满足时拒绝启动或拒绝该操作，不能自动递归 `chmod`/`chown` 未知路径。
- 创建目录与文件时使用排他创建和不跟随符号链接的系统能力（POSIX 上使用 `O_EXCL`/`O_NOFOLLOW` 或等价的 `openat` 约束）；目标平台无法可靠提供等价保证时，相关写操作 fail closed，而不是降级为先检查后普通打开。
- 普通文档、manifest、Job 结果和备份先写同一父目录中的随机临时普通文件，设置权限并 `fsync` 文件，再以原子 rename/replace 发布，最后 `fsync` 父目录。不得跨文件系统假设 rename 原子性。
- 活跃 SQLite 数据库不得通过文件 replace 更新；使用 SQLite 事务、WAL/checkpoint 与官方 backup API。备份先由 SQLite backup API 生成到私有 staging 文件，校验后再按上一条原子发布；同时校验运行期间新建的 WAL/SHM 权限和所有权。
- 外部下载名、Archive Entry 名和用户标题都不是物理路径。Domain/数据库/API 只保存逻辑 `StorageKey`；只有 Infrastructure `FileStore` 可以把它解析到受管根目录内的物理路径。
- 非 POSIX 平台必须提供等价的仅当前用户 ACL、reparse-point/链接拒绝和原子发布语义，并在文档中记录差异。

当产品需要多用户远程访问、公共注册或跨设备云同步时，重新评审本 ADR。

## Consequences

### Positive

- 与个人优先、浏览器 Profile、本地文件和 Obsidian 使用方式一致。
- 无需第一阶段引入 Kubernetes、Redis、对象存储和多租户 Secret Vault。
- Python 可以直接复用 Playwright、EPUB/PDF 处理和 `notebooklm-py`。
- SQLite Job checkpoint 足以支持离开页面和进程重启后的恢复。
- 模块化边界允许未来把 Worker、数据库或前端独立部署，而不先支付微服务成本。

### Negative

- 第一版不适合多用户共享部署。
- 本地浏览器关闭或设备离线时，远程自动化不可用。
- SQLite 写并发和本地文件容量会成为规模上限。
- 若使用独立前端开发服务器，需要通过同一入口代理或构建后由主服务托管，保持单端口约束。
- 未来迁移 PostgreSQL/S3 时仍需实现基础设施 Adapter 和数据迁移。

### Follow-up

- 建立根 `pyproject.toml`、uv workspace 和应用骨架。
- 定义数据库迁移与 `~/.diandianreading/` 数据目录。
- 实现统一私有 `FileStore`、`StorageKey` resolver、权限/所有权审计和无符号链接打开。
- 建立单 Worker 的持久 Job runner。
- 按 ADR-0005 实现本地 API Token/Session 与同源入口。
- 为模块依赖方向添加静态检查或测试守卫。

## Alternatives considered

### 多租户云 Web 应用

暂不采用。它要求远程浏览器、用户级凭据加密、Secret Vault、租户隔离、公共合规流程和更复杂的任务基础设施，超出个人 MVP 目标。

### 微服务架构

暂不采用。当前没有独立扩缩容需求或团队边界；服务拆分会增加部署、观测、认证和一致性成本，却不能改善首个阅读闭环。

### 纯桌面原生业务重写

不采用。阅读器继续利用 PDF.js/epub.js，Python 本地服务继续集成现有 Provider；不会把 Domain、Worker、NotebookLM 或文档处理重写为原生 Rust。长期产品使用 [ADR-0006](0006-desktop-first-tauri-python-sidecar.md) 的 Tauri 桌面壳包装同一 Web UI 与 Python Sidecar。

### TypeScript 单后端

暂不采用。两个关键集成都已是 Python；使用 TypeScript 会迫使 NotebookLM 走实验性 REST sidecar 或额外进程，增加接口和端口成本。

## Validation

本 ADR 变为 `Accepted` 前必须证明：

- 根应用可在 `localhost:3000` 启动。
- SQLite migration、WAL/checkpoint、原子备份和恢复通过。
- 数据库/WAL/SHM、文档、Job 和备份的权限、所有权、根目录约束及符号链接攻击测试通过。
- 写入中断只留下可识别的私有 staging 文件，不会发布部分文档或半成品备份。
- Fake Adapter 能跑通持久 Import Job。
- 进程重启后 Job 可恢复。
- NotebookLM 不可用时本地书库、阅读和笔记仍可操作。
- 架构边界测试确认 `domain` 不导入基础设施框架。

## Related

- [集成计划](../integration-plan.md)
- [ADR-0002](0002-notebooklm-public-python-api.md)
- [ADR-0003](0003-provider-credential-isolation.md)
- [ADR-0004](0004-durable-import-saga.md)
- [ADR-0005](0005-local-api-security.md)
- [ADR-0006](0006-desktop-first-tauri-python-sidecar.md)
- [桌面应用实施计划](../desktop-application-plan.md)
