# Phase 1 文档处理端到端验证 / Document Processing E2E

> 状态：Active
>
> 不使用浏览器、真实 NotebookLM、Z-Library、网络访问或任何账号凭据。

## 1. 验证目标 / Goal

本流程验证从合法本地文件到可持久化导入结果的真实边界：

```text
CLI
→ LocalFileAcquirer
→ 私有 LocalFileStore + SHA-256 content addressing
→ LocalDocumentPreparationAdapter
   ├→ Markdown UTF-8 规范化与能力驱动分块
   ├→ EPUB 受限子进程解析、spine 顺序与派生 Markdown
   └→ PDF 结构检查与受限 passthrough
→ canonical preparation manifest
→ ImportBookUseCase
→ FakeKnowledgeAdapter
→ SQLite Unit of Work / migrations / repositories
→ 关闭并重新打开数据库
→ 验证 Book、Job、Asset、Part、Manifest、Source 与 RemoteOperation
```

它对应 [`integration-plan.md`](../architecture/integration-plan.md) 的 Phase 1 退出标准。Fake Knowledge Adapter 只替代远端 NotebookLM；本地 Acquisition、对象存储、文档准备、manifest 和 SQLite 都使用真实实现。

## 2. 准备环境 / Setup

在仓库根目录运行：

```bash
uv sync --locked --all-groups
```

## 3. 执行 E2E / Run

三个输出路径必须彼此分离且尚不存在：

```bash
uv run diandian phase1-e2e \
  --database .tmp/phase1-e2e/state/app.sqlite3 \
  --object-root .tmp/phase1-e2e/objects \
  --workspace .tmp/phase1-e2e/workspace
```

命令会创建私有 Markdown、EPUB 和 PDF 合成 fixture，并依次执行 Acquisition、Preparation、Fake Knowledge import 和 SQLite reopen 验证。它不会读取用户书籍、启动浏览器或访问网络。

成功时 stdout 返回结构化 JSON，包含以下稳定字段：

| 字段 | 不变量 |
| --- | --- |
| `status` | `ok` |
| `schema_version` | 当前为 `4`；Phase 2/3 migration 扩展远程操作与恢复字段，不改变 Phase 1 文档处理语义 |
| `format_count` / `book_count` | 均为 `3` |
| `manifest_count` | 每个根 Asset 一个，共 `3` |
| `asset_count` | `4`：三个根 Asset，加一个 EPUB 派生 Markdown Asset |
| `part_count` / `source_count` | 均为 `7` |
| `remote_operation_count` | `10`，即 `source_count + book_count` |
| `progress_event_count` | 当前固定 fixture 为 `46`，且必须大于 `0` |

重复运行会拒绝覆盖既有数据库、对象根目录或 workspace，返回退出码 `2`，并在 stderr 输出无 traceback 的结构化错误 JSON。专用 E2E 目录需要由调用者显式清理；生产代码不会静默删除既有内容。

## 4. 格式行为 / Format Semantics

### Markdown

- 只接受 UTF-8（允许 UTF-8 BOM），拒绝 NUL 与空白文档。
- Unicode 规范化为 NFC，换行统一为 LF。
- 追踪 Markdown 标题章节引用。
- 同时满足目标 `max_source_words`、`max_source_bytes` 和 `max_sources_per_workspace`。
- 内容完全相同的 Part 只保留一个，并按首次出现顺序合并所有章节引用。
- 超长连续文本继续按有限字符边界切分，不通过截断绕过限制。

### EPUB

- 原 EPUB 作为根 Asset 保留。
- ZIP central directory 在解析正文前完成 fail-closed 校验。
- 按 OPF spine 顺序提取 text-only 内容并生成派生 Markdown Asset。
- Part 指向派生 Asset，并保留 `epub-spine-XXXX` 章节引用。
- 不获取外部 URL；脚本、样式、SVG、iframe、object 和 embed 内容不进入 Markdown。
- XML `DOCTYPE` / `ENTITY`、路径穿越、Unicode/大小写碰撞、链接/设备条目、嵌套 Archive、加密或不支持的压缩、查询字符串成员引用均被拒绝。
- Parser 在独立 `python -I` 子进程中运行，父进程执行墙钟超时；POSIX 设置 CPU、文件描述符和文件大小限制，Linux 额外设置地址空间限制。

### PDF

Phase 1 **没有引入 PDF 文本解析器，也没有提前决定超限 PDF 的拆页或文本抽取策略**：

- 校验 `%PDF-` 文件头和末尾区域中的 `%%EOF`。
- 当目标接受 `application/pdf` 且文件满足 `max_source_bytes` 时，原 PDF 作为一个确定性 Source/Part。
- 超过目标字节上限时 fail closed，返回 `SOURCE_LIMIT_EXCEEDED`。
- 该边界不等同于完整 PDF 语义验证、恶意 PDF 内容消毒、OCR、拆页或全文提取；这些能力必须在引入隔离解析器和确定产品策略后单独实现。

## 5. 有限安全预算 / Finite Security Budgets

默认 `DocumentSecurityLimits`：

| 限制 | 默认值 |
| --- | ---: |
| 输入文件 | 100 MiB |
| Archive entries | 2,000 |
| 单 Entry 解压大小 | 20 MiB |
| 总解压大小 | 200 MiB |
| 压缩比 | 100:1 |
| Archive 路径深度 | 16 |
| Entry 名长度 | 255 |
| 单 XML/HTML metadata 输入 | 5 MiB |
| Parser 输出 | 100 MiB |
| 父进程墙钟超时 | 20 秒 |
| 子进程 CPU | 10 秒 |
| Linux 地址空间 | 512 MiB |
| 子进程文件写入 | 正常运行 `0`；仅父进程已启用 coverage 插桩时允许最多 10 MiB coverage data |

所有值必须为正且有限；单 Entry 上限不得超过 Archive 总上限。具体部署可收紧这些值，但不能配置为无限。coverage.py 的 subprocess patch 只在测试进程已经加载 coverage 时由父进程传递序列化配置；普通 source/wheel E2E 不传递该配置，继续验证 `RLIMIT_FSIZE=0` 的生产路径。

## 6. 持久化与可追溯性 / Persistence

Preparation 使用 canonical、排序且无多余空白的 JSON manifest，记录：

- 根 Asset metadata 与 SHA-256；
- 派生 Asset 及其 `derived_from_asset_id`；
- 每个 Part 的顺序、StorageKey、MIME、词数、UTF-8 字节数、SHA-256 和章节引用；
- Preparation policy 版本、本次安全限制，以及实际使用的词数/字节/Source 数量和已排序 MIME target capabilities。

Domain/Application/SQLite 只保存不透明 `StorageKey`，不保存对象根目录或输入文件物理路径。E2E 会重新打开 SQLite，并重新校验每个 Asset、Part 与 manifest 对象的大小和 SHA-256。

## 7. 自动化验证 / Automated Checks

主要测试：

- `tests/e2e/test_phase1_document_processing.py`：子进程 CLI、SQLite reopen、对象/状态计数和拒绝覆盖。
- `tests/integration/test_local_acquisition.py`：权利确认、格式/魔数、大小、符号链接、去重和 observer 失败。
- `tests/integration/test_document_preparation.py`：Markdown/PDF/EPUB、spine、manifest、目标能力与恶意 Archive/markup fixture。
- `tests/integration/test_import_workflow.py`：派生 Asset、Part、manifest 与 Job transition 同一 Unit of Work。
- `tests/integration/test_sqlite_persistence.py`：当前 schema version 4、round-trip、manifest 所属 Book 约束、Lease fencing 与事务回滚。
- `tests/unit/test_document_policy.py`：中英文计数、章节追踪、字节/词数双限制和超长文本。
- `tests/unit/test_epub_worker.py`：HTML 状态机、Archive member、XML/metadata、引用解析、网络禁用与资源限制。
- `tests/unit/test_local_file_store.py`：私有权限、namespace、原子发布、去重、冲突和符号链接拒绝。

完整执行：

```bash
uv run pytest
```

CI 还会构建 wheel、连同生产依赖安装到隔离环境，并分别执行 Phase 0、Phase 1 与 Phase 2 CLI smoke，以验证全部 migration、`epub_worker.py` 和 NotebookLM Adapter 模块确实进入可安装产物。

## 8. 当前验证证据 / Validation Evidence

2026-08-03 的 Phase 1 本地门禁：

- Ruff format/lint：通过；
- strict mypy：36 个 source files 无问题；
- Python 3.11、3.12、3.14：各 `80 passed`；
- branch coverage：`90.70%`，其中隔离 EPUB worker 为 `94%`；
- `uv lock --check`：通过；
- sdist/wheel build：通过；
- source `phase1-e2e`：3 Books、4 Assets、7 Parts、3 manifests、7 ready Sources、10 resolved remote intents；
- isolated installed-wheel Phase 0 与 Phase 1 E2E：通过；
- wheel 内容：包含 `0001_initial.sql`、`0002_document_preparation.sql` 与 `epub_worker.py`。

这些检查均未启动浏览器、访问真实 Provider 或读取账号凭据。GitHub CI 状态以当前 Phase 1 PR checks 为最终依据。
