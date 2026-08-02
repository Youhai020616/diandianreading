# ADR-0002: NotebookLM 通过公开 Python API 集成

## Status

`Proposed`

## Date

2026-08-03

## Context

现有 `zlibrary-to-notebooklm` 通过以下 shell 命令集成 NotebookLM：

```text
notebooklm create '<title>' --json
notebooklm use <notebook_id>
notebooklm source add '<path>' --json
```

实现位于 [`scripts/upload.py`](../../../source/zlibrary-to-notebooklm/scripts/upload.py)。该方式存在：

- `shell=True` 和字符串转义/注入风险。
- 依赖全局 active Notebook context，并发 Job 可能互相覆盖。
- 依赖 stdout JSON 结构。
- 子进程无法自然传递类型化异常、上传进度和 Client 生命周期。
- Source 创建后没有可靠等待 ready 的统一流程。

PRD 原计划第一阶段使用 CLI，稳定后切换 Python API。但当前仓库已经包含 `notebooklm-py 0.8.0rc1`，其公开 `NotebookLMClient` 提供创建 Notebook、添加文件、等待 Source、问答、生成和下载能力，并具有完整测试与异常体系。

`notebooklm-py` 同时包含 `_app/`、`_runtime/` 和 RPC 内部实现；其稳定性文档明确将下划线模块和大部分 RPC 模块排除在公共兼容保证之外。

## Decision

生产集成直接使用 `notebooklm-py` 的 **公开 Python API**：

- 通过主项目的 `NotebookLMAdapter` 实现 Knowledge Ports。
- 仅导入 `NotebookLMClient`、公开类型、枚举和异常。
- 不导入 `notebooklm._app`、`notebooklm._runtime`、下划线 feature 模块或未承诺的 RPC 编码细节。
- 每个调用显式传入 `notebook_id`，不使用 `notebooklm use`。
- 每个 Worker 进程、事件循环和 Profile 创建自己的 Client；Client 不跨线程或事件循环共享。
- Application 只传递不含路径的 `CredentialRef(provider, profile)` 与 `StorageKey`；Infrastructure 分别解析、校验并限制凭据路径和文档路径，再把显式绝对路径传给 SDK。
- 每次 Notebook/Source/Artifact 等远程写调用前，先按 ADR-0004 持久化独立 operation intent 与 correlation key；SDK 的进程内 probe/retry 不能替代跨进程 checkpoint。
- 固定已验证的 package 版本或 Git commit。
- 本地维护的登录域名/Playwright 修复应形成最小 patch queue，并优先贡献上游。
- CLI 保留给人工诊断和一次性运维，不作为主应用内部生产集成协议。
- 如果确实需要短期兼容 CLI，只能作为可移除 Adapter，使用 argv list 与 `shell=False`，并通过同一 Contract Test；它不是目标实现。

示例目标调用：

```python
credential_ref = CredentialRef(provider="notebooklm", profile=profile)
credential_path = credential_resolver.resolve_storage_state(credential_ref)
source_path = file_store.resolve_for_read(part.storage_key)

# credential_path/source_path 均由 Infrastructure 校验为受管根目录内、
# 非符号链接、当前用户所有的绝对路径；不能直接来自 API 请求。
async with NotebookLMClient.from_storage(path=str(credential_path)) as client:
    notebook = await client.notebooks.create(title)
    source = await client.sources.add_file(
        notebook.id,
        source_path,
        title=source_title,
        wait=False,
        on_progress=on_progress,
    )
    sources = await client.sources.wait_for_sources(
        notebook.id,
        [source.id],
        timeout=300,
    )
```

示例省略了调用外层的事务代码；`notebooks.create()` 与 `sources.add_file()` 必须各有一个已在调用前提交的持久 Intent。超时、断连、取消或 Worker 失租后先 reconciliation，不能因为本地没有拿到 ID 就重新创建。

## Consequences

### Positive

- 删除 shell 注入和 quoting 问题。
- 消除全局 active Notebook context 的并发竞争。
- 获得类型化返回、异常、上传进度、等待和重试能力。
- Application 层可通过 Fake Knowledge Adapter 进行快速测试。
- 不需要启动实验性 `notebooklm-server` sidecar。
- NotebookLM ID 可以在创建后直接持久化，无需解析 stdout。

### Negative

- 主 Worker 必须遵守 `NotebookLMClient` 的事件循环绑定规则。
- Python 依赖与上游版本变化进入主应用发布管理。
- Google RPC 变化仍可能使集成失效；公开 Python API 不能消除上游非官方风险。
- 当前本地修复尚未确认是否全部进入上游版本，短期需要维护 Fork/patch。
- Direct API 让主应用更接近 Provider，必须通过 Adapter 防止类型泄漏到 Domain。

### Follow-up

- 定义 `KnowledgeIngestionPort`、`KnowledgeQueryPort` 和 `KnowledgeGenerationPort`。
- 实现公开类型到主项目类型的 mapper。
- 建立 Client factory/lifespan，按 Profile 和 event loop 管理。
- 为 Auth、Rate Limit、Timeout、Protocol Drift 和远程结果不确定建立错误映射。
- 为每个产品使用的 SDK 写操作登记幂等/重试策略，并与 [API 参考](../../api.md)中的当前上游矩阵核对。
- 为 Adapter 建立 Contract Test；真实账号 smoke test 仅允许在受信任、受保护的手动 CI 上运行。
- 更新 PRD 中“先 CLI 后 Python”的旧表述。

## Alternatives considered

### 长期使用 CLI 子进程

拒绝。CLI 适合人工操作，但全局 context、JSON stdout、进程边界和 shell 参数使其不适合可恢复的并发 Job。

### 使用 `notebooklm-server` REST sidecar

暂不采用。REST `/v1` 是实验性表面，需要额外进程、Bearer Token 和接口版本管理；在主后端本身就是 Python 时没有必要。

### 直接导入 `notebooklm._app`

拒绝。其设计值得参考，但属于内部 API，可能在 minor 版本变化。主项目只能依赖上游承诺的公开表面。

### 把 `notebooklm-py` 源码复制进主包

拒绝。这样会混合产品业务和 SDK 协议维护，破坏上游同步与独立测试边界。

## Validation

本 ADR 变为 `Accepted` 前必须证明：

- 创建 Notebook、添加 Source、等待 ready 和问答的受信任 live-provider smoke test 通过。
- 在每个远程写调用前都能观察到已提交的 Intent；调用后、ID checkpoint 前终止进程时恢复不会重复创建。
- Adapter Contract Tests 使用 Fake 与真实实现均通过。
- 代码库不存在主应用生产路径中的 `shell=True` NotebookLM 调用。
- 代码库不存在 `notebooklm use` 依赖。
- 代码库不存在对 `notebooklm._*` 的主应用导入。
- 并发两个导入 Job 不会交叉使用 Notebook ID。
- 认证过期、429、超时和协议漂移都映射为明确错误类别。

## Related

- [API 参考](../../api.md)
- [集成计划](../integration-plan.md)
- [`notebooklm-py` Python API](../../../source/notebooklm-py/docs/python-api.md)
- [`notebooklm-py` 稳定性边界](../../../source/notebooklm-py/docs/stability.md)
- [ADR-0001](0001-local-first-modular-monolith.md)
- [ADR-0004](0004-durable-import-saga.md)
- [ADR-0003](0003-provider-credential-isolation.md)
