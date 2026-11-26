import { expect, it } from "vitest";
import { contextSubject, groupSessionsByContext, UNGROUPED_SESSIONS_LABEL } from "../src/lib/chatSessions";

it("treats pages of the same book as one subject and keeps other contexts as labelled", () => {
  expect(contextSubject({ kind: "web", label: "当前页：一个投资家的20年 · 第三章" })).toBe("一个投资家的20年");
  expect(contextSubject({ kind: "web", label: "当前页：一个投资家的20年 · 第四章" })).toBe("一个投资家的20年");
  expect(contextSubject({ kind: "web", label: "当前页：很长很长的书名被截…" })).toBe("很长很长的书名被截");
  expect(contextSubject({ kind: "reader", label: "《克林索尔的最后夏天》" })).toBe("《克林索尔的最后夏天》");
  expect(contextSubject(null)).toBe("");
});

it("groups history by starting context, most recent group first and unlabelled conversations last", () => {
  const groups = groupSessionsByContext([
    { id: "a", contextLabel: "《悉达多》", updatedAt: "2026-11-20T10:00:00Z" },
    { id: "b", contextLabel: "", updatedAt: "2026-11-26T10:00:00Z" },
    { id: "c", contextLabel: "一个投资家的20年", updatedAt: "2026-11-25T10:00:00Z" },
    { id: "d", contextLabel: "《悉达多》", updatedAt: "2026-11-24T10:00:00Z" },
  ]);
  expect(groups.map(g => [g.label, g.sessions.map(s => s.id)])).toEqual([
    ["一个投资家的20年", ["c"]],
    ["《悉达多》", ["d", "a"]],
    [UNGROUPED_SESSIONS_LABEL, ["b"]],
  ]);
});
