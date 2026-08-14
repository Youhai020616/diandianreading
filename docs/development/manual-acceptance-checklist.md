# 手动验收清单 / Manual Acceptance Checklist

> 状态:Draft(随 R3/R4 交付更新)
>
> 最后更新:2026-08-03
>
> 执行者:维护者本人,在自己的 Mac 上。此清单覆盖自动化明确不验证的两类事项:浏览器中的真实 UI 体验,与真实 Provider 联调。执行前先读对应 E2E 文档了解自动化已覆盖的范围。

## 0. 环境准备

```bash
git clone git@github.com:Youhai020616/diandianreading.git && cd diandianreading
uv sync --locked --all-groups
uv run diandianreading web     # 浏览器打开 http://localhost:3000
```

真实 Provider 联调前执行 `uv run diandianreading setup notebooklm`，经确认把固定 Chromium 安装到 App Home；凭据只进入 `~/.diandianreading/credentials/`，不要出现在终端历史或截图里。

## 1. 浏览器 UI 功能测试(离线,无需登录 Provider)

### 1.1 会话与安全

- [ ] 首次打开:URL fragment 中的 bootstrap nonce 被立即消费并从地址栏消失;刷新后会话仍有效。
- [ ] 复制该 URL 到隐身窗口打开:不能获得会话(nonce 单次)。
- [ ] Log out 后所有 API 操作要求重新 bootstrap。

### 1.2 导入与任务

- [ ] 本地导入一本 `.md` 与一本无 DRM 的 `.epub`:进度条/任务状态实时更新(SSE),完成后书籍出现在书库。
- [ ] 导入一个非法文件(如改名的 zip):任务失败且错误信息可读、可重试,不出现堆栈。

### 1.3 阅读器(R3)

- [ ] 打开 EPUB 书:正文渲染可读(标题/段落/列表/引用),章节侧栏可跳转,无任何脚本执行迹象(打开 DevTools Console 无 CSP 报错以外的异常)。
- [ ] 滚动阅读后关闭标签页重新打开:回到上次位置(进度恢复)。
- [ ] 选中一段文本 → 划线(换色)→ 写想法:侧栏出现对应条目;刷新后仍在;点击条目跳回原文位置。
- [ ] 删除一条笔记 → 默认列表隐藏 → 恢复后回到列表。
- [ ] 打开 PDF 书:分页渲染、页码导航、页级进度;(按 R3 实际能力)页级划线。
- [ ] 导入一本含恶意内容的样本(`<script>`、超长行、巨型标题):正文按文本渲染,无弹窗/无脚本执行。

### 1.4 AI Chat(fake 之外的 UI 行为)

- [ ] 未登录 Provider 时提问:错误状态可读、可重试,本地阅读与标注不受影响。

### 1.5 视觉与可访问性

- [ ] 窄窗口(≤768px)与高 DPI 下布局不破;Chat 面板在移动布局下可回退(浏览器返回键)。
- [ ] 纯键盘走完:导入 → 打开书 → 翻章 → 选区划线 → 提问;焦点始终可见。

## 2. 真实 NotebookLM 联调(需要 Google 账号)

> 风险背景:所有自动化验证基于 fake adapter;这是 adapter 与真实服务的第一次实弹。逐条记录结果(通过/失败/截图),失败不要当场修,记录后继续。

- [ ] `uv run diandian auth login`:Playwright 浏览器登录成功;`auth status` 显示健康。
- [ ] 导入一本你拥有权利的真实 EPUB:任务完整跑通(创建 Notebook → 上传 sources → ready);在 NotebookLM 网页端能看到对应 Notebook。
- [ ] 整本书提问 3–5 个问题:回答返回、引用列表非空、excerpt 与书内容相符。
- [ ] **引用定位抽样(R4 关键假设)**:抽 10 条真实引用,记录"点击后能否跳到原文正确位置 / 显示未能定位"的比例——这是 excerpt 唯一匹配假设的实证,结果直接决定 R4 定位器是否需要调整。
- [ ] 选区提问与笔记范围提问:回答明显使用了选区/笔记内容;`effective_scope` 展示与预期一致。
- [ ] 断网/中断一次生成:任务进入可恢复状态,重试成功,本地数据无损。
- [ ] 登出并重新登录:会话恢复,旧 Notebook 映射仍有效。

## 3. 可选:Z-Library(默认关闭;仅在确认权利边界后)

- [ ] 默认状态:UI 中 Z-Library 入口显示"未启用";`DIANDIAN_ZLIBRARY_ENABLED=1` 后才可用。
- [ ] 仅用你有权获取的资料走一次完整获取 → 导入;权利声明步骤不可跳过。

## 3.5 D2 桌面壳(需要 macOS 桌面会话;CI 无法提供证据)

> 背景:`launcher-core` 的端口拒绝、控制帧解析与子进程回收已有单元测试,macOS CI 也验证了未签名 `.app` 可构建且 Bundle 内 Sidecar 可启动。但"进程表里真的没有残留""第二次启动只聚焦窗口"必须在真实桌面会话观察。详见 [D2 Launcher E2E](d2-launcher-e2e.md)。

- [ ] 冷启动 `.app`:窗口打开并加载产品 UI;`pgrep -f diandian-desktop-sidecar` 只有一个进程。
- [ ] 正常退出应用后:`pgrep -f diandian-desktop-sidecar` 无输出(无孤儿)。
- [ ] 重复启动:第二次打开只聚焦既有窗口,不出现第二个窗口,Sidecar 进程数仍为 1。
- [ ] 强杀 Sidecar(`kill -9`):壳不静默挂起,退出后无残留进程。
- [ ] 强杀 Tauri 壳(`kill -9`):Sidecar 不长期存活;再次启动不会附着到旧进程。
- [ ] 3000 端口被无关进程占用(如 `python3 -m http.server 3000`)时启动:显示诊断并退出;占用进程**未被结束**,端口**未被改用**其他值。
- [ ] 打包 App 内完成一次 local import → Job → Chat → Citation 跳转的离线全链路。
- [ ] WebView 内无 Tauri IPC:开发者工具中 `window.__TAURI__` 为 `undefined`。

## 3.6 P5 创作工作台与 Obsidian(需要真实 Vault 与人工判断)

> 背景:生成链路与导出对账已有自动化覆盖(见 [C1b](c1b-e2e.md)、[C2](c2-e2e.md)、[C3](c3-e2e.md)),但"文案能不能真的用于发布"只能人工判定,Fake Provider 证明不了。

- [ ] 在真实 Obsidian Vault 上配置路径并导出一本书:Books/<书名>/ 下出现 Book/Highlights/Notes/Summary 四个文件,Obsidian 中可正常打开。
- [ ] 在 Obsidian 里重命名 Notes.md 后再次导出:更新落在改名后的文件上,**没有**新增重复文件。
- [ ] 在 Obsidian 里手动编辑某个导出文件后再次导出:原文件保持你的修改,旁边出现 `.diandian-conflict.md`,界面明确提示冲突。
- [ ] 工作台生成三种以上内容类型,判断**至少 3 个模板产出的文案可直接用于发布**(P5 退出标准)。
- [ ] 编辑一份草稿后切回第 1 版:能读到未被改动的 AI 原文,版本列表标注清晰。
- [ ] `obsidian://` 深链接点击后能在 Obsidian 中打开对应文件。

## 4. 结果记录

在本文件同目录建 `manual-acceptance-YYYYMMDD.md`,逐条记录:通过/失败、环境(macOS 版本/浏览器)、失败截图或错误码。失败项回流为 issue,由后续开发处理;不阻塞记录其余项。
