/** The polish request names its scope explicitly; models otherwise tend to touch only the newest part. */
export function buildWholeDraftPolishPrompt(draftId: string, title: string, content: string): string {
  return [
    `请润色整篇草稿（draftId: ${draftId}，标题：《${title}》）。润色范围是下面的完整正文，不要只修改最近新增的部分。`,
    "1. 从头到尾逐段检查结构、衔接和用词，严格遵守我的 STYLE.md 去 AI 味要求；保留我的观点、引文和事实，不要加入原文没有的信息。",
    "2. 完成后调用 draft_create_or_revise（传入上面的 draftId）追加一条新的 AI 修订版本，content 必须是润色后的完整全文，不能只包含改动的段落。",
    "3. 回复里用两三句话说明主要改了什么。",
    "",
    "完整正文：",
    "",
    content,
  ].join("\n");
}
