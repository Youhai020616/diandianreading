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
3. **本地书库与阅读笔记**
   - 在「本地书库 → 导入书籍」可多选文件、导入整个文件夹，或将粘贴的文本存为 EPUB。导入会保留原文件，内容相同的书会复用已有副本。
   - 在「本地书库」点 EPUB 的封面或「阅读」即可在工作台内离线阅读。可重排 EPUB 支持在「Aa → 正文字体」选择宋体、黑体、楷体或原书字体，选择会记住。阅读器还支持目录、分页、脚注弹窗、字号与行距设置、单双栏、夜读和自动续读。其他格式使用系统阅读器打开。
   - 打开可重排的 EPUB，点「双语」可逐段中英对照，目录也会显示标题译文。默认使用 DeepL，首次可点「获取 API Key」打开官方密钥页，粘贴自己的密钥后选择「保存并开启双语」。翻译使用个人 DeepL 账户的额度，密钥加密保存在本机。也可在弹窗切换到 DeepSeek 或「模型设置」里已有的兼容模型。已缓存的译文可在同一翻译服务及配置下离线重读。
   - 已下载的 EPUB、PDF、MOBI、AZW3 和 TXT 可随时从该书的「···」菜单选择「导入到微信读书」。
   - 选中文字可以划线、写想法或交给「问点点」。单击已有划线可取消高亮，写过的想法会保留在笔记里。在「阅读笔记」点击「回到原文」即可跳回书中的位置。
   - EPUB 排版使用 [foliate-js](https://github.com/johnfactotum/foliate-js)，阅读交互参考 [Readest](https://github.com/readest/readest)。[阅读引擎许可声明](public/licenses/epub-reader.txt)
   - 基于 Electron 内置 Node 24 `node:sqlite` (`DatabaseSync`)，支持 Kindle `My Clippings.txt`（中英文）与微信读书导出笔记一键解析 + SHA-256 指纹去重。
   - 可从微信读书、Google Books 和 Open Library 查询封面和出版信息，选择对应版本后补全书籍资料。
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
