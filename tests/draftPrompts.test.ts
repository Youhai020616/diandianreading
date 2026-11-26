import { expect, it } from "vitest";
import { buildWholeDraftPolishPrompt } from "../src/lib/draftPrompts";

it("asks for the whole draft, names the draft to revise, and requires the complete text back", () => {
  const body = "第一段：旧观点。\n\n第二段：v2 新增的要点。";
  const prompt = buildWholeDraftPolishPrompt("draft_1", "关于时间", body);
  expect(prompt).toContain("draftId: draft_1");
  expect(prompt).toContain("不要只修改最近新增的部分");
  expect(prompt).toContain("完整全文");
  expect(prompt.endsWith(body)).toBe(true);
});
