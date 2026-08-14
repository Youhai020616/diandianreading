# 安装、升级、备份、恢复与卸载

> 状态：Preview runbook
>
> 适用：single-user local Web Runtime。公开 PyPI 包尚未发布；索引命令只描述发行后的规范流程。

## 1. 安装形态

### 临时运行（发行后）

```bash
uvx diandianreading web
```

uvx 工具环境可以被重建；用户状态不在该环境内，而在 `~/.diandianreading/`。

### 持久工具安装（发行后）

```bash
uv tool install diandianreading
diandianreading web
```

### 当前源码运行

```bash
git clone https://github.com/Youhai020616/diandianreading.git
cd diandianreading
uv sync --locked --all-groups
uv run diandianreading web
```

NotebookLM 交互登录前：

```bash
diandianreading setup notebooklm
diandian auth login notebooklm
```

源码运行时给命令加 `uv run`。

## 2. 升级

持久工具安装：

```bash
uv tool upgrade diandianreading
diandianreading doctor
```

固定版本安装或回退工具环境：

```bash
uv tool install --reinstall 'diandianreading==<version>'
```

注意：

- 先停止正在运行的 `web` 进程，再升级；
- App Home 不随 tool environment 删除；
- Runtime 启动时校验 migration checksum，并只执行向前 migration；
- **数据库 downgrade 不受支持**。较新版本已经提升 schema 后，不要用较旧版本打开同一 App Home；
- Playwright 版本变化后，`doctor` 可能报告 `version_mismatch`，需再次执行 `setup notebooklm`；
- Provider 的远程副作用不会因本地工具回退自动撤销。

## 3. 备份

仓库尚未提供在线 snapshot 命令。raw App Home 备份只在 FastAPI/Worker 进程完全停止后才安全；运行中直接复制 SQLite/WAL 不是受支持的备份方式。

完整私有备份（包含 Credential 和 Chromium，文件可能很大）：

```bash
# 1. 先在启动终端 Ctrl+C，并确认进程已退出
umask 077
backup="$HOME/diandianreading-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
tar -C "$HOME" -czf "$backup" .diandianreading
chmod 600 "$backup"
shasum -a 256 "$backup" > "$backup.sha256"
printf '%s\n' "$backup"
```

不包含可重新下载 Chromium 与 staging 的精简备份：

```bash
umask 077
backup="$HOME/diandianreading-data-$(date +%Y%m%d-%H%M%S).tar.gz"
tar -C "$HOME" \
  --exclude='.diandianreading/browsers' \
  --exclude='.diandianreading/staging' \
  -czf "$backup" .diandianreading
chmod 600 "$backup"
shasum -a 256 "$backup" > "$backup.sha256"
```

备份包含数据库、书籍、笔记和 Provider Credential，应按 Secret 对待：不要上传到公开云盘、issue、CI artifact 或聊天记录。

## 4. 恢复

1. 安装与备份 schema 相同或更新的受信任版本；
2. 停止所有 `diandianreading` 进程；
3. 验证 checksum 和 archive path；
4. 不与既有 App Home 合并，先把既有目录原子改名保留；
5. 解压并运行 `doctor`，再启动 Web。

```bash
backup="$HOME/<backup-file>.tar.gz"
shasum -a 256 -c "$backup.sha256"

# 拒绝绝对路径与 .. 路径分量
if tar -tzf "$backup" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "unsafe backup archive" >&2
  exit 1
fi

if [ -e "$HOME/.diandianreading" ]; then
  mv "$HOME/.diandianreading" "$HOME/.diandianreading.before-restore"
fi

tar -C "$HOME" -xzf "$backup"
chmod 700 "$HOME/.diandianreading"
diandianreading doctor
diandianreading web
```

若恢复失败，停止进程，移走失败目录，再把 `.diandianreading.before-restore` 改回原名。不要用空数据库覆盖原数据库，也不要为“清理”而删除远程 NotebookLM 资源。

精简备份恢复后，NotebookLM 登录前重新执行：

```bash
diandianreading setup notebooklm
```

## 5. 卸载

```bash
uv tool uninstall diandianreading
```

该命令只移除工具环境，**不会**删除 `~/.diandianreading/`。确认已有可恢复备份并明确希望永久删除数据后，才手动删除 App Home：

```bash
rm -rf "$HOME/.diandianreading"
```

此操作不可撤销；不要把它放进自动卸载脚本。

## 6. 端口与故障恢复

- 3000 被未知进程占用：停止那个进程或稍后重试；应用不会换端口或附着。
- 服务已运行但浏览器关闭：使用 `diandianreading open`，不要复用旧 bootstrap URL。
- Install Token 损坏/权限不安全：Runtime fail closed；不要手工把认证关闭。
- Chromium missing/version mismatch：本地阅读仍可用；需要 Provider 浏览器时运行 `setup notebooklm`。

更细安全行为见 [L2 Runtime E2E](../development/l2-local-runtime-e2e.md)。
