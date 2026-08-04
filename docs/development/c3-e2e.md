# C3 创作工作台 E2E

> 状态：Active
>
> 范围：C3 的创作工作台 UI、书籍级生成入口与内容清单；浏览器功能测试由维护者在 Mac 上手动执行。

## 交付边界

- 工作台是第五个主视图(`Workbench / 创作`),提供来源书籍、内容类型、语气、长度、目标平台、保留引用与第一人称控制,以及内容列表、版本历史、编辑器、预览与导出入口。
- **新增书籍级生成入口** `POST /api/books/{book_id}/generate-content`。ai-chat.md 把生成挂在 message 上,因为那是 Chat UI 提供该操作的位置;而工作台从**书籍、主题或一组笔记**出发(PRD §6.5),需要自己的入口,而不是伪造一个 message ID。消息级路由保持不变。
- 内容清单 `GET /api/books/{book_id}/contents` 供工作台列出该书的全部内容资产。

## 作者归属在 UI 里可见

版本历史每一项标注「AI 原始稿」或「我的修改稿」,当前查看的版本单独显示归属。用户编辑保存为**新修订**而非覆盖:切回第 1 版仍能读到模型原文。这是 PRD §11.4 的 AI 内容风险在界面上的落点——一份几个月后无法回答"这段是不是我写的"的草稿,等于把风险留给了用户。

## 冲突不被粉饰

导出后若存在冲突,状态区直接写「N 个文件你手动改过,已写入冲突文件而不是覆盖」,并列出冲突文件路径。把冲突显示成成功会让用户以为 Vault 已同步,而实际没有。

## 两处实施中发现的问题

**`VIEW_NAMES` 白名单**。`AppController.setView` 用白名单校验视图名,新视图不加进去会被静默丢弃、导航点了没反应。已加入并让工作台像书库一样在切入时刷新书籍。

**隐藏面板里的选项会污染全局文本查询**。工作台的书籍下拉把每个书名渲染成 `<option>`,即便面板 `hidden`,这些文本仍在 DOM 里,使既有 `readerFlow` 测试的 `getByText("Book One")` 匹配到多个元素。工作台内容改为**仅在该视图激活时渲染**。

## 本地复现

```bash
cd apps/web && pnpm test && pnpm build
cd ../.. && rm -rf src/diandianreading/interfaces/web/static \
  && mkdir -p src/diandianreading/interfaces/web/static \
  && cp -r apps/web/dist/. src/diandianreading/interfaces/web/static/
uv run --frozen pytest -q
```

CI 的 `Verify committed web assets match the build` 步骤会重跑构建并要求提交的静态资源与之逐字节一致。

## 退出标准与证据

| 退出标准 | 证据 |
| --- | --- |
| 生成结果可编辑而非只能重新生成 | `workbenchFlow.test.tsx::distinguishes the AI draft from the user's edit` |
| AI 原始稿与人工修改稿在 UI 中可区分 | 同上,以及 `::keeps the AI draft readable after switching revisions` |
| 生成参数按选择提交 | `::submits a generation request with the chosen parameters` |
| 冲突被如实报告 | `::reports an export conflict instead of claiming success` |
| 无来源时拒绝生成 | `::refuses to generate without a book` |

## 仍需人工验收

**「至少 3 个内容模板可以真实用于发布」只能由维护者判定**——Fake Provider 能证明链路通,证明不了文案可用。该判断与浏览器功能测试一并留在 `manual-acceptance-checklist.md`。
