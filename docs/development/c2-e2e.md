# C2 Obsidian 导出 E2E

> 状态：Active
>
> 范围：C2 的 Vault 配置、五类导出文件、增量对账、手改冲突与路径封闭；不包含双向同步、冲突合并 UI 与创作工作台（C3）。

## 交付边界

Vault 不是本产品拥有的数据库,而是**用户会手动编辑的目录**,且 Obsidian 没有内建版本历史——错误覆盖不可恢复。C2 因此实现两条规则:

- **身份是 frontmatter 里的 `diandian_id`,不是文件名。** 对账先按记录路径查找;路径不在了就扫描 Vault 内的 `diandian_id` 重新定位。用户重命名导出文件是常规操作,以文件名对账会把它判定为新文件、每次同步都产生重复。
- **摘要与正文的 digest 与上次导出记录不一致 = 用户改过 = 绝不覆盖。** 新渲染写入同目录的 `<name>.diandian-conflict.md`,并在响应的 `conflicts` 数组里报告。宁可留下一个可清理的冲突文件,也不销毁用户在自己 Vault 里的手写内容。

## 安全边界

导出是本产品**第一个向用户文件系统写入的功能**,三类拒绝写在 `domain/vault.py`:

| 风险 | 处理 |
| --- | --- |
| 路径逃逸(书名来自 EPUB 元数据,不可信) | 逐段消毒(剥离分隔符/控制字符/保留设备名/首尾点、限长),拼接后**再次**断言仍在 Vault 根内——消毒器有 bug 也不足以写到外面 |
| Frontmatter 注入(正文来自 Provider) | 行首 `---` 与 `diandian_id:`/`diandian_content_hash:` 被前置零宽字符中和,生成文本无法伪造身份或截断 YAML 块 |
| 反向深链接扩大桌面攻击面 | 不注册自定义 scheme;`obsidian://` 只用于跳出去,跳回来用 `http://localhost:3000/…`(ADR-0008 §8) |

frontmatter 读取是**最小实现而非 YAML 解析器**:Vault 文件是不可信输入,交给通用解析器只会扩大攻击面而无收益。

## 分层落点

路径与 frontmatter 规则放在 `domain/vault.py` 而不是基础设施层:它们是**契约规则而非 I/O**——什么算安全路径段、什么标识一个导出文件、正文里哪些内容永远不许伪造。`tests/unit/test_architecture_boundaries.py` 禁止 application 层导入 infrastructure,这个落点同时满足该约束。

## 截断是显式的

标注分页上限为 100。导出取一页,若还有更多则在 `Book.md` 里写明"本次导出只包含最近 100 条标注",而不是静默丢弃——用户不该在自己的 Vault 里看到一份看似完整、实则被裁剪的文件。

## 本地复现

```bash
uv run --frozen diandian c2-e2e \
  --app-home .tmp/c2/app-home \
  --workspace .tmp/c2/workspace
```

预期输出：

```json
{
  "conflict_reported": true,
  "exported_files": 4,
  "manual_edit_preserved": true,
  "rename_followed_by_identity": true,
  "repeat_added_no_file": true,
  "schema_version": 10,
  "status": "ok"
}
```

链路：导入 → 提问 → 回答 → 新建标注 → 配置 Vault → 首次导出(4 个文件,全部 `created`)→ 再次导出(全部 `unchanged`,**文件数不变**)→ 重命名 `Notes.md` 并新增标注 → 导出(`updated` 且落在**改名后的文件**上,文件数仍不变)→ 手改该文件并再次新增标注 → 导出(`conflict`,手写内容原样保留,新渲染进冲突文件)。

## 退出标准与证据

| 退出标准 | 证据 |
| --- | --- |
| 同一本书重复导出不新增文件 | 本 E2E 的 `repeat_added_no_file`、`test_obsidian_export.py::test_repeating_an_unchanged_export_adds_no_file` |
| 重命名后再次导出仍定位到原文件 | 本 E2E 的 `rename_followed_by_identity`、`::test_a_renamed_file_is_found_by_identity_not_by_name` |
| 手改后不覆盖,产出冲突文件并在响应中报告 | 本 E2E 的 `manual_edit_preserved`/`conflict_reported`、`::test_a_manual_edit_is_never_overwritten`、`test_local_api_obsidian_export.py::test_a_manual_edit_produces_a_reported_conflict` |
| 路径逃逸与 frontmatter 注入被拒绝 | `test_obsidian_primitives.py::TestResolveInVault`、`::TestBuildDocument`、`::test_a_hostile_book_title_cannot_escape_the_vault` |
| 导出不上传任何数据 | 导出链路只触及本地数据库与 Vault 目录,不经过任何 Provider 端口 |

## 不属于本阶段

冲突文件的合并 UI、双向同步与文件监听均为非目标(ADR-0008 §9)。**冲突频率是一个待证据决定的问题**:若手改冲突在真实使用中频繁发生,说明单向导出的定位不成立,需要在 P5 之后重新评估。
