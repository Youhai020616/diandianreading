# Security Policy

## Supported versions

`diandianreading` 当前处于 Alpha，尚未发布稳定版本或建立长期支持窗口。

| Version | Support |
| --- | --- |
| `main` / unreleased `0.1.0` | Best-effort security fixes |
| Earlier commits or private builds | Not supported |

## Reporting a vulnerability

请不要在公开 issue、Discussion、PR、截图或日志中披露以下内容：

- Install Token、Bootstrap Nonce、Browser Session、CSRF Token 或 Cookie；
- NotebookLM/Z-Library Credential、浏览器 storage state 或账号信息；
- 私有书籍正文、标注、笔记、Provider 回答或 Obsidian Vault 内容；
- App Home 的完整归档、数据库或可识别本机路径。

优先使用 GitHub 仓库 **Security → Report a vulnerability**（如果该入口已启用）。如果没有私密报告入口，请先通过仓库所有者的 GitHub 资料请求一个私密沟通渠道，不要在初次公开消息中附带漏洞细节或 Secret。

报告应尽量包含：

1. 受影响 commit/version 与操作系统、Python 版本；
2. 不含真实个人数据的最小复现步骤；
3. 预期边界与实际行为；
4. 影响范围和已知前置条件；
5. 使用临时 App Home 与测试账号生成的脱敏证据。

项目目前没有找到可公开记录的专用安全邮箱或响应 SLA，因此不能承诺固定回复时限。

## Security boundaries

本项目的核心安全假设：

- 单用户、local-first，不是 LAN/公网服务；
- HTTP 服务只绑定 `127.0.0.1:3000`，但回环本身不视为授权；
- 浏览器写操作要求 Session + CSRF + Host/Origin 边界；
- CLI reopen 要求私有 Install Token，并只签发短时单次 Nonce；
- App Home、Credential、SQLite、对象和浏览器运行时必须保持当前用户私有；
- 第三方 Provider 返回、书籍元数据、文件名、URL 和导出路径均按不可信输入处理；
- Z-Library 默认关闭，不支持绕过 DRM、付费限制、验证码或访问控制。

详细模型见 [ADR-0005](docs/architecture/adr/0005-local-api-security.md)、[ADR-0003](docs/architecture/adr/0003-provider-credential-isolation.md) 与 [ADR-0009](docs/architecture/adr/0009-local-web-tool-distribution.md)。
