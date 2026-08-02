# ADR-0005: 本地 API 仍需显式认证与浏览器安全边界

## Status

`Proposed`

## Date

2026-08-03

## Context

ADR-0001 选择单用户、local-first 架构，并把 Web/API 绑定到 `localhost:3000`。回环绑定只能减少网络暴露面，不能证明请求来自受信任用户：同一台机器上的其他进程可以直接访问端口，恶意网页可以尝试跨站请求或 WebSocket 连接，DNS rebinding 可以让浏览器把攻击者控制的 Host 指向回环地址，错误的代理配置还可能扩大暴露范围。

本地 API 将接触书籍、笔记、文件导入、Provider 凭据状态和有远程副作用的 Job。因而“只能从本机连接”不是授权模型，也不能替代会话、Origin、CSRF、资源限制和审计。

## Threat model

本 ADR 首先防御以下边界内威胁：

- 恶意或被入侵的网站从用户浏览器向本地 API 发起跨站请求、SSE 或 WebSocket 连接。
- DNS rebinding、伪造 `Host`，以及错误信任 `Forwarded`/`X-Forwarded-*` 导致的边界绕过。
- 同一操作系统用户下的非受信任普通进程扫描并调用本地端口。
- Token 泄露到 URL、浏览器持久存储、日志、错误响应或诊断包。
- 超大 Body、上传、Header、并发连接、SSE/WS 长连接或慢请求造成的本地资源耗尽。
- 已失效页面、旧 Session 或已轮换 Token 继续执行远程副作用。

不在本 ADR 保证范围内：已取得当前用户权限并能读取应用私有文件或注入应用进程的恶意软件。文件权限可以缩小攻击面，但不能对这种主机失陷提供完整隔离。

## Decision

本地运行配置执行以下强制规则。

### 1. 网络边界不是授权

- 服务只绑定回环接口；Worker 不监听端口。
- 每个请求同时校验实际 TCP Peer 为回环地址，并校验规范化后的 `Host` 属于固定回环 Host/端口允许列表。两项任一失败即拒绝，不能只依赖 DNS 解析结果。
- 本地配置禁用 trusted-proxy 模式，不信任 `Forwarded`、`X-Forwarded-For`、`X-Forwarded-Host` 或 `X-Forwarded-Proto`。出现这些 Header 时拒绝请求，而不是据此改写 Peer、Host 或 Scheme。
- 除最小化且不返回版本、路径、账号或任务信息的 liveness 外，所有 API、SSE 和 WebSocket 都必须认证。回环来源本身不授予权限。

### 2. 每安装实例的 Token 与浏览器 Session

- 首次初始化使用 CSPRNG 生成至少 256 bit 的每安装实例 API Token，保存在应用私有凭据目录的 `0600` 普通文件中；数据库、前端 Bundle 和日志不保存明文 Token。
- CLI/自动化客户端使用 `Authorization: Bearer <install-token>`。服务端只保存可验证形式或从私有文件读取，并使用常量时间比较；Token 可轮换，轮换立即撤销旧 Token 和现有浏览器 Session。
- Web UI 使用短期、服务端保存的随机 Session。Cookie 至少设置 `HttpOnly`、`SameSite=Strict` 和 `Path=/`；在 HTTPS 入口下还必须设置 `Secure`。Session 有空闲与绝对过期时间，登出、Token 轮换和应用重置都会撤销它。
- 浏览器启动不得把长期安装 Token 放进查询参数、Fragment、HTML、JavaScript Bundle、`localStorage` 或 `sessionStorage`。本地 Launcher 可以创建短时、单次使用的 Bootstrap Nonce，通过 OS IPC 或清除历史前即可消费的 URL Fragment 交给 UI；UI 用它交换 Session 后立即销毁。Bootstrap 端点仍执行 Peer、Host、Origin、速率、有效期和单次消费校验。
- Session ID、Bootstrap Nonce 和 CSRF Token 都不得写入访问日志、错误消息或遥测。

### 3. Same-origin、Origin、CSRF 与 CORS

- Web UI 与 API 默认由同一规范 Origin `http://localhost:3000` 提供；开发态也通过该入口反向代理静态资源，不为第二个开发 Origin 放宽生产策略。
- 携带 Cookie 的浏览器请求必须验证 `Origin` 与规范 Origin 完全一致。所有改变状态的方法还必须携带与 Session 绑定的 CSRF Token；仅依赖 `SameSite` 不足以替代 CSRF 校验。
- Bearer 客户端可在不携带 Cookie 时使用 API；一旦请求携带浏览器 Cookie，就按浏览器请求执行 Origin/CSRF 规则，不能用 Header 混搭绕过。
- 默认不发送 CORS 允许 Header，并拒绝跨 Origin Preflight。若未来确需跨 Origin，必须通过新 ADR 给出精确 Origin 允许列表；禁止 `*`、动态反射 Origin 或宽泛的 localhost 端口范围。
- `GET`/`HEAD` 不得产生远程或本地写副作用。

### 4. SSE 与 WebSocket

- SSE 使用已认证的同源 Cookie Session；EventSource URL 不接受 Token 查询参数。连接建立与重连都重新验证 Session，Session 撤销后服务端关闭连接。
- WebSocket 在 Upgrade 前校验 Peer、Host、精确 `Origin` 和认证 Session/Bearer；浏览器 Session 还需提交一次性、与 Session 绑定的握手 Nonce。凭据不得放在查询参数。
- 限制每 Session 的 SSE/WS 连接数、WS 单消息大小、发送队列和空闲时间；慢消费者必须被断开，不能无限缓存 Job 事件。

### 5. 资源与接口限制

- 为 Header、JSON Body、上传文件、批量条目、分页、并发请求、每 Session 连接数、请求总时长和空闲时长设置显式上限；超限在读取或分配完整内容前拒绝。
- 上传采用流式硬上限，不能只相信 `Content-Length`；缺少、冲突或超限的长度信息按接口策略拒绝。
- 对登录、Bootstrap、Token 校验失败和有远程副作用的端点实施本地速率/并发限制；错误响应保持统一，不泄露 Token 是否部分匹配。
- 生产本地配置禁用交互式 API 文档和详细异常页；响应不返回物理文件路径、凭据 Profile 内容或内部堆栈。

## Security and privacy

- 安装 Token、Session、Nonce、CSRF Token 与 Provider 凭据使用不同命名空间和生命周期，不能互相复用。
- 安全日志只记录时间、请求类别、结果、脱敏主体和关联 ID；不记录 Authorization、Cookie、URL 凭据、正文、文件路径或账号邮箱。
- 所有有副作用的请求保留本地审计关联 ID，但该 ID 不是认证凭据。
- 如果未来允许远程访问、反向代理、容器共享网络或多用户使用，必须重新评审本 ADR；不能通过修改 bind address 直接复用本地安全模型。

## Operational rollback and recovery

- 安全配置或 Session Schema 升级前先创建不含凭据的数据库备份；Token 文件单独处理，不进入普通备份。
- 升级失败时服务必须 fail closed：停止 API 并提供本机 CLI 恢复/轮换 Token、清除 Session 和重新初始化入口，禁止回退到“临时无认证”。
- 回滚应用版本前撤销新旧 Session，并确认旧版本仍执行 Peer、Host 和 Token 校验；若旧版本不满足本 ADR，则只能保持服务停止，不能上线该回滚版本。
- Token 文件损坏或丢失时，通过本机交互式恢复流程生成新 Token并撤销全部 Session；不从数据库、日志或备份猜测旧 Token。
- 本 ADR 的回滚只影响本地访问控制，不自动撤销已经提交给远程 Provider 的操作；远程副作用按 ADR-0004 的持久 Intent 与 reconciliation 处理。

## Consequences

### Positive

- 恶意网页和普通本地端口扫描不能仅凭“请求来自回环”获得书籍或远程操作权限。
- 浏览器、CLI、SSE 与 WebSocket 共享明确且可测试的认证边界。
- DNS rebinding、CSRF、代理 Header 混淆和资源耗尽都有独立控制，而不是依赖单一 Token。
- 安全故障能够 fail closed，并保留本机可恢复路径。

### Negative

- 首次启动、Token 轮换、Session Bootstrap 和 CSRF 增加实现与测试成本。
- 纯浏览器开发流程必须通过统一 Origin，不能随意从其他端口直连 API。
- 本地恶意进程若已能读取 Token 文件，仍可调用 API；需要结合 ADR-0001/0003 的权限与所有权规则。
- 若以后引入远程访问或代理，需要重新设计 TLS、身份、代理信任和多用户授权。

### Follow-up

- 定义 Token 文件、Session、Bootstrap Nonce 和 CSRF Token 的 Schema 与轮换命令。
- 为 HTTP、SSE、WebSocket 实现统一 Peer/Host/Origin 验证中间件。
- 为请求大小、连接、超时和并发限制建立配置上限与拒绝测试。
- 建立 DNS rebinding、CSRF、CORS、代理 Header 和 Token 泄露回归测试。
- 在开发服务器入口保持 `localhost:3000` 单 Origin。

## Alternatives considered

### 只绑定 `127.0.0.1`

拒绝。它减少远程网络访问，但不能授权同机进程，也不能单独阻止恶意网页、DNS rebinding 或资源耗尽。

### 只校验 Bearer Token

拒绝作为浏览器完整方案。Token 不能替代 Origin、CSRF、Host、SSE/WS 握手和资源限制；长期 Token 直接暴露给浏览器 JavaScript还会扩大泄露面。

### 开放 CORS 给所有 localhost 端口

拒绝。任意本地开发站点或被攻陷的本地服务都会获得读取/写入能力，且端口不构成身份。

### 默认支持反向代理

拒绝。当前是单用户本地产品；信任代理 Header 会引入不必要且容易误配的边界。远程/代理部署必须单独决策。

## Validation

本 ADR 变为 `Accepted` 前必须证明：

- 无 Token/Session 的 API、SSE、WS 请求均被拒绝，最小 liveness 不泄露信息。
- 非回环 Peer、非法 `Host`、转发 Header 和 DNS-rebinding Host 测试均 fail closed。
- 跨 Origin 读写、缺失/错误 CSRF、跨站 WebSocket 和 CORS Preflight 被拒绝。
- 安装 Token 不出现在数据库、URL、前端存储、日志、异常或诊断包；文件权限/所有权符合 ADR-0001。
- Token 轮换会撤销旧 Bearer 与全部 Session；过期/撤销 Session 的 SSE/WS 被关闭。
- Body、上传、Header、并发、SSE/WS 消息与慢连接上限均有边界测试。
- trusted-proxy 保持关闭，应用不根据转发 Header 改写请求身份。
- 安全迁移失败时服务停止且本机恢复命令可轮换 Token；不存在无认证降级路径。

## Related

- [ADR-0001](0001-local-first-modular-monolith.md)
- [ADR-0003](0003-provider-credential-isolation.md)
- [ADR-0004](0004-durable-import-saga.md)
- [集成计划](../integration-plan.md)
- [API 参考中的现有 REST 安全事实](../../api.md#81-状态与安全模型)
- [`notebooklm-py` REST Server 实现](../../../source/notebooklm-py/src/notebooklm/server/)
