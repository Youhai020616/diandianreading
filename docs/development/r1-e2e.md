# R1 正文与章节服务 E2E / Reading Content Service E2E

> 状态:Active
>
> 最后更新:2026-08-03
>
> 本阶段不启动真实浏览器、不访问任何 Provider、不读取真实账号凭据。浏览器 UI 功能验证与真实 Provider 联调由维护者在任务收尾时手工执行。

## 1. 目标 / Goal

R1 交付阅读器的数据地基([实施计划](../architecture/reader-annotation-plan.md) §4 R1):

```text
authenticated session
→ local markdown import (durable job + worker)
→ GET /api/books/{id}          书籍详情 + 阅读文档 + 章节索引 + 进度
→ GET /api/books/{id}/content  规范化正文,ETag = anchor_sha256,If-None-Match → 304
→ PUT /api/books/{id}/progress 锚点校验 + last-write-wins + 乐观版本
```

## 2. 运行方式 / How to Run

```bash
uv run diandian r1-e2e --app-home <fresh-dir> --workspace <fresh-dir>
# 或安装后:diandian r1-e2e --app-home ... --workspace ...
```

输出为确定性 JSON;重复对同一路径执行退出码为 2。CI 的 wheel 冒烟在隔离 venv 中执行同一命令。自动化断言:

- 单元:`tests/unit/test_chapter_spans.py`(章节平铺与 `markdown_chapters` 一致性)
- 集成:`tests/integration/test_reading_service.py`(三种格式、惰性物化幂等、篡改拒绝、进度冲突)
- 集成:`tests/integration/test_local_api_reading.py`(HTTP 契约、304、401/404/409/422)
- E2E:`tests/e2e/test_r1_reading.py`(安装入口全链路)

## 3. 阅读文档解析 / Reading Document Resolution

每本书的阅读正文是单一规范文档(ADR-0007):

| 来源 | 阅读文档 | anchor_sha256 |
| --- | --- | --- |
| EPUB | 导入时生成的派生整本 Markdown | 派生资产 sha256 |
| Markdown | 规范化正文(见 §4) | 规范化内容 sha256 |
| PDF | 原始字节 | 根资产 sha256;章节退化为空 |

## 4. 实现期决策记录 / Decisions Made While Implementing

1. **Markdown 书籍无派生资产(ADR-0007 §1 的前提修正)**:导入管线只为 EPUB 生成派生 Markdown。R1 在读取路径**惰性物化**:规范化 → 内容寻址存储(`derived/{root_id}/{sha}.md`)→ 登记派生资产;`LocalFileStore.put` 对已存在对象做内容去重,uuid5 派生 ID 使操作完全幂等。
2. **规范化为恒等时不建派生资产**:若规范化结果与原文逐字节相同(sha 相等),根资产本身就是阅读文档,不写入任何新对象或行——否则会撞 `UNIQUE(book_id, sha256)`。
3. **保留全局 `no-store`**:ADR-0005 的响应头姿态是刻意的(书籍正文不落浏览器磁盘缓存)。内容端点提供强 ETag,304 再验证由前端显式携带 `If-None-Match` 实现,不为带宽在安全边界上开洞。
4. **进度写入独立限流池**(240/分钟,与 60/分钟的通用 mutation 池分离),阅读时的高频进度保存不挤占导入/Chat 配额。
5. **进度锚点服务端校验**:锚点类型必须匹配文档格式、sha 必须等于当前阅读文档,否则 409;防止客户端把过期锚点写成"合法"进度。
6. **书籍详情暂不含标注计数**:R2 的标注仓库落地后由 W2 集成补充,不预置恒为 0 的假字段。

## 5. 已知边界 / Known Boundaries(交由后续阶段)

- **EPUB 章节词汇不一致**:`DocumentPart.chapter_refs` 来自 EPUB 解析器,与派生文档重推导的 `markdown-heading-NNNN` 是两套编号。阅读导航使用派生文档自身的章节索引;章节 → Part 的映射(ai-chat.md §4 章节范围所需)在 R4 以文本定位解决。
- PDF 无文本抽取:无章节、无文内锚点,进度按页记录(ADR-0007 既定代价)。
- 重新导入变更后的文件会产生**新的 Book**(`source_hash` 变化),再锚定编排(旧书标注 → 新文档)属于 R2 引擎的调用方,在 W2/R4 仲裁。

## 6. 明确未验证 / Explicitly Not Verified

- 浏览器中的真实渲染、选区与阅读体验(R3 + 维护者手工验收)。
- 真实 EPUB 通过 HTTP 导入后的读取(服务层用预置派生资产覆盖;导入管线自身由 Phase 1 E2E 覆盖)。
- 任何真实 Provider 行为。
