# 点点读书 · diandianreading v2

本地优先、围绕**「深度阅读 -> 划线沉淀 -> 个人表达与视觉卡片 -> Obsidian 知识资产」**打造的 Electron + DeepSeek Harness 桌面阅读创作工作台。

## 核心能力（M0–M3 完整版）

1. **原生多账号双栏阅读工作台**
   - 右侧采用 Electron 原生 `WebContentsView`（彻底告别跨域 iframe 限制），默认直达微信读书，支持豆瓣、小红书创作者中心、微信公众号后台一键直达。
   - 多账号独立 `persist:` Partition 隔离 Cookie 与登录态，左侧支持自由拖拽分栏与一键折叠专注模式。
2. **DeepSeek Harness 引擎 + 4 大定制 Cordis 插件**
   - `reading-browser`：读取右侧页面正文与选中段落，支持受控网页导航（绝不暴露 Cookie/密码）。
   - `reading-studio`：跨书检索本地划线、沉淀金句、向创作工作台追加不可变 AI 初稿/修订、执行 Obsidian 导出与书源状态查询。
   - `twin-context`：热装配你的 `PROFILE.md` 与 `STYLE.md`（去 AI 味硬规矩），修改后下一轮即时生效且保持系统前缀稳定。
   - `runtime-safety`：基于 `ctx.tools.guard` 提供 `plan`（只读规划）/ `confirm`（安全确认）/ `auto`（全自动）三档执行守卫，全模式默认禁用任意底层 Shell/覆写工具。
3. **本地 SQLite 知识库（零 C++ 编译依赖）与多源导入**
   - 基于 Electron 内置 Node 24 `node:sqlite` (`DatabaseSync`)，支持 Kindle `My Clippings.txt`（中英文）与微信读书导出笔记一键解析 + SHA-256 指纹去重。
   - 内置 **Google Books + Open Library** 并行在线书籍元数据补全。
4. **不可变创作工作台 + 离线沙盒 3:4 高清卡片工坊**
   - AI 原稿与人工修订按不可变版本链分层保存，支持「对照 AI 原稿」双栏审阅，永不互相覆盖。
   - 5 套温润宣纸/瑞士网格/深夜书房/青苔书笺/灵感刊头 3:4 书摘卡片，基于受控 `htmlcard://` 离线沙盒（禁用外部网络）离屏 2× Retina 烘焙为 `1080×1440` PNG，一键复制剪贴板直贴小红书/公众号。
5. **Obsidian 增量双向对账 & 可选 `heartleo/zlib` 书源路由**
   - 通过 frontmatter `diandian_id` 自动追踪 Obsidian 中的文件改名/移动；手工编辑过的笔记自动输出 `.diandian-conflict.md` 冲突副本，绝不静默覆盖；支持 `obsidian://open` 深链接直达。
   - 可选检测本机 `heartleo/zlib` CLI，支持用用户自有账号检索、下载、推送 Kindle 与导入微信读书书架；未安装时完全不影响核心功能。

## 快速启动

```bash
pnpm install
pnpm dev      # 开发模式（Vite HMR + Electron）
# 或
pnpm build && pnpm start
```

## 验证命令

```bash
pnpm typecheck
pnpm test
pnpm build
```
