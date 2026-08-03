# ADR-0003: Provider 凭据物理隔离，数据库只保存引用

## Status

`Proposed`

> NotebookLM 的 Phase 2 Resolver、Z-Library 的 Phase 4 Profile/Session/Migration，以及 Phase 5 的统一 login/status/logout、API redaction 和跨 Provider 隔离均已实现并通过离线自动化测试。ADR 仍保持 `Proposed`：真实 NotebookLM/Z-Library 浏览器登录与登出将由用户手工验证，默认备份排除与安装器恢复流程也尚未完成全部验收。

## Date

2026-08-03

## Context

产品需要管理至少三类敏感本地凭据：

- NotebookLM/Google Cookie 或 master token。
- Z-Library 持久浏览器 Profile 与 storage state。
- 后续社交平台 Cookie、Token 或浏览器 Profile。

当前两个项目分别写入 `~/.notebooklm/` 和 `~/.zlibrary/`。它们的数据格式、生命周期、风险级别和刷新方式不同。尤其 NotebookLM `master_token.json` 是长期、全账号级凭据，风险高于普通会话 Cookie。

如果将这些内容直接存入业务 SQLite，会扩大备份、日志、调试导出和数据库泄露的影响范围。把不同 Provider Cookie 合并成统一 JSON 也会掩盖各自的安全要求。

## Decision

Provider 凭据采用 **物理隔离目录 + 不含路径的业务引用**：

```text
~/.diandianreading/
├── state/
│   └── app.sqlite3
├── objects/
├── staging/
├── uploads/
└── credentials/
    ├── local-api/
    ├── notebooklm/
    │   └── profiles/<safe-profile-key>/...
    ├── zlibrary/
    │   └── profiles/<safe-profile-key>/...
    └── publishing/<provider>/<safe-profile-key>/...  # future
```

业务契约只有：

```python
@dataclass(frozen=True)
class CredentialRef:
    provider: str
    profile: str
```

`CredentialRef` 是不透明逻辑引用，**不包含** `Path`、Home 目录、文件名或可由 API 调用方控制的路径片段。规则：

- 每个 Provider 自己定义实际凭据文件格式；Domain 与 Application 不解析 Cookie，也不解析、拼接或持久化物理路径。
- SQLite 只保存 `provider`、`profile`、最近健康状态和时间，不保存路径、Cookie、Token、密码、storage state 或 master token 内容。
- 只有对应 Infrastructure Adapter 内的 `CredentialPathResolver` 可以把 `(provider, profile)` 映射为物理路径。Resolver 使用安全编码/映射生成目录键，不能把原始 Profile 当作相对路径拼接。
- 活跃凭据必须位于应用拥有的 `credentials/<provider>/...` 根目录内。Resolver 对每个路径分量执行不跟随符号链接的类型、当前用户所有权与 `0700/0600` 权限检查，并在打开后再次确认对象仍位于允许根目录；检查失败即拒绝使用。
- Adapter 必须向 `NotebookLMClient.from_storage(path=...)` 等 Provider SDK 传入 Resolver 得到并验证过的显式绝对路径，不能依赖进程当前 Profile、环境变量优先级或用户请求中的路径。
- 日志、错误响应、Telemetry 和文档不得包含原始凭据、Authorization Header、Cookie 值、master token、账号邮箱或凭据绝对路径。
- 前端只获得状态：`connected`、`expired`、`missing`、`checking`、`error`，不能读取凭据内容、物理路径或安装 Token。
- 默认备份排除凭据目录；如用户显式导出凭据，必须走单独的加密流程并提示账号级风险，不能混入普通数据库/文档备份。
- NotebookLM master-token 模式只建议专用/可弃用 Google 账号。
- 登出由对应 Provider Adapter 执行，并明确是否删除 Profile、storage snapshot 和 master token；删除前仍执行根目录、类型、所有权和无符号链接校验。

### 旧目录与 `~/.zlibrary/config.json` 迁移

- 现有 `~/.notebooklm/`、`~/.zlibrary/` 只通过显式 migration 命令导入；运行时不把应用外绝对路径写入 `CredentialRef` 或数据库，也不长期引用旧目录。
- Migration 先 dry-run，拒绝符号链接、非当前用户对象、宽松权限和越界项；随后复制到应用凭据根目录内的私有 staging 目录，验证 Provider Profile，再原子发布。源目录默认保留，只有用户确认后才删除。
- 旧 `~/.zlibrary/config.json` 可能包含明文 `email`/`password`。当前旧脚本的 `load_credentials()` 会读取它，`login_to_zlibrary()` 还会输出账号邮箱；虽然当前 `main()` 不走该登录路径，残留文件仍是凭据泄露风险。
- Migration **不得**导入、记录或打印该 JSON 中的邮箱/密码，也不得把密码转换成新 Schema。应提示用户通过交互式登录建立新 Profile；验证新会话后，只能在再次确认且通过无链接/所有权检查时 unlink 旧文件。普通 unlink 不能保证 SSD、快照或备份中的历史副本被安全擦除；若文件曾暴露，提示用户轮换密码。
- 迁移和清理日志只记录 Provider、逻辑 Profile、结果与脱敏错误，不记录旧/新绝对路径或账号标识。

Phase 2 的 NotebookLM 实现将逻辑 Profile 映射为：

```text
<credentials-root>/notebooklm/profiles/profile-<sha256(profile)前32位>/storage_state.json
```

Resolver 创建/校验私有 `0700` 目录和 `0600` 普通文件，拒绝符号链接、非当前用户所有对象、根目录越界、空文件、超过 16 MiB 或缺少 `cookies` 列表的 storage-state JSON。只有 Infrastructure 把该绝对路径传给公开 `NotebookLMClient.from_storage(path=...)`；Domain/Application/SQLite/CLI 输出中仍只有 provider/profile。缺失或畸形状态固定映射为脱敏 `AUTH_REQUIRED`。

统一的是引用、健康检查和 UI 状态，不统一 Provider 的 Secret Schema 或物理路径。

### Phase 5 implementation evidence

- `diandian auth login/status/logout` 通过同一 composition root 调用两个独立的 Provider Session Manager；删除一个逻辑 Profile 不会访问另一个 Provider 根目录。
- `GET /api/auth/status` 只返回 provider、逻辑 profile、状态和检查时间，不返回 Cookie、账号、Provider 内部 ID 或凭据路径。
- `ApplicationRuntime` 把 NotebookLM 与 Z-Library Resolver 固定到 `credentials/notebooklm` 与 `credentials/zlibrary` 的独立命名空间；Install Token 使用第三个 `credentials/local-api` 命名空间。
- SQLite/API/CLI/E2E 具备 Secret、物理路径和 Provider ID 的回归断言；本地与 installed-wheel E2E 不读取真实账号凭据。
- 这些证据验证代码边界，不等价于真实 Provider 页面和 Cookie 生命周期已经通过手工浏览器测试。

## Consequences

### Positive

- 数据库备份和调试导出默认不携带账号级 Secret。
- 一个 Provider 凭据泄露不会自动暴露其他 Provider 格式和目录。
- Adapter 可以继续使用上游已有 Profile 机制。
- 前端和 Domain 不需要理解 Cookie 字段。
- 后续可把文件引用替换为 OS Keychain/Secret Vault，而不改变业务对象。

### Negative

- 应用数据和凭据备份需要分开说明。
- 移动数据目录时必须由 Infrastructure Resolver 和 migration 一次性处理，不能更新业务对象中的路径。
- 多个 Profile 的安全目录映射、健康检查和登出需要 Provider 专用实现。
- 本地恶意进程仍可能读取当前用户有权访问的文件；文件权限不是完整 Secret Vault。
- 如果未来成为云服务，文件路径引用方案不能直接满足多租户要求。

### Follow-up

- Phase 2 已定义仅含 `provider/profile` 的 `CredentialRef`，并实现 NotebookLM `CredentialPathResolver`、健康检查、根目录/无链接/所有权/权限守卫和错误脱敏测试。
- Phase 4 已实现 Z-Library 专用 Resolver、Session Manager、登录/登出、Legacy no-read migration 与跨 Provider 隔离验证；离线测试不声称 live Provider 页面已验证。
- 将凭据目录加入产品安装器的默认备份排除清单，并持续执行日志/CLI/API redaction 测试。
- 为迁移现有 Profile 提供 dry-run、staging 验证与显式清理命令，并专门检测 `~/.zlibrary/config.json`。
- Phase 5 已在统一 CLI/API/UI 中接入两个 Provider 的 login/status/logout，并完成 API/CLI redaction 自动化验证；真实浏览器登录/登出和安装器默认备份排除通过后，再重新评估本 ADR 为 `Accepted`。

## Alternatives considered

### 全部凭据写入 SQLite

拒绝。即使数据库加密，解密密钥、备份、日志和导出仍增加攻击面；现阶段没有必须集中查询 Secret 内容的需求。

### 把所有 Provider Cookie 转成统一 JSON

拒绝。Cookie 域、刷新、master token 和浏览器 Profile 语义不同；统一 Schema 会制造虚假的可互换性。

### 全部使用环境变量

不采用为默认方案。环境变量适合 CI，但不适合长期本地浏览器 Profile、大型 storage state 或多个账号切换，也容易通过子进程继承扩大暴露范围。

### 第一阶段集成 OS Keychain

暂不采用。Keychain 适合小型 Token，但浏览器 Profile 是目录结构；可以后续将关键解密密钥或小型 Token 放入 Keychain。

## Validation

本 ADR 变为 `Accepted` 前必须证明：

- SQLite dump 不含 Cookie、Token、密码或 master token。
- SQLite、Domain 对象和 API 响应不包含凭据路径或 Secret 内容；`CredentialRef` 序列化只有 `provider/profile`。
- 日志和异常快照通过敏感字段、账号标识与绝对路径扫描。
- 凭据目录/文件权限、所有权、根目录 confinement 与无符号链接测试通过。
- Provider Client 收到的是 Infrastructure Resolver 验证过的显式绝对路径。
- NotebookLM 与 Z-Library 可分别登录、检查和登出。
- 删除一个 Provider Profile 不影响另一个 Provider。
- Git 和默认备份不会包含凭据目录。
- Legacy migration 不读取到业务层、不打印也不复制 `~/.zlibrary/config.json` 的明文账号密码；新 Profile 验证失败时旧目录保持不变。

## Related

- [集成计划](../integration-plan.md)
- [API 参考：认证边界](../../api.md)
- [ADR-0001](0001-local-first-modular-monolith.md)
- [ADR-0002](0002-notebooklm-public-python-api.md)
