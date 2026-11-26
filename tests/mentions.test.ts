import { expect, it } from "vitest";
import { trailingMentionQuery } from "../src/lib/mentions";

it("opens a mention right after Chinese text, at the start, or after a space, but not inside an address", () => {
  expect(trailingMentionQuery("帮我看@克林")).toBe("克林");
  expect(trailingMentionQuery("@")).toBe("");
  expect(trailingMentionQuery("对比 @悉达多")).toBe("悉达多");
  expect(trailingMentionQuery("发到 me@example")).toBeNull();
  expect(trailingMentionQuery("@克林 后面继续写")).toBeNull();
  expect(trailingMentionQuery("没有提及")).toBeNull();
});
