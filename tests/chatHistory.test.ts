import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { KnowledgeDatabase } from "../electron/storage/database";

let dir: string;
let db: KnowledgeDatabase;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "diandian-chat-"));
  db = new KnowledgeDatabase(path.join(dir, "state.sqlite"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

it("keeps the context a conversation started from as its group across later saves", () => {
  const message = { id: "u1", role: "user" as const, text: "这一章讲了什么？" };
  db.upsertChatSession({ id: "chat_1", title: "这一章讲了什么？", contextLabel: "《悉达多》", messages: [message] });
  db.upsertChatSession({ id: "chat_1", title: "这一章讲了什么？", contextLabel: "《瓦尔登湖》", messages: [message] });
  db.upsertChatSession({ id: "chat_2", title: "随便聊聊", messages: [{ ...message, id: "u2" }] });
  const byId = new Map(db.listChatSessions().map(s => [s.id, s.contextLabel]));
  expect(byId.get("chat_1")).toBe("《悉达多》");
  expect(byId.get("chat_2")).toBe("");
  expect(db.getChatSession("chat_1")?.contextLabel).toBe("《悉达多》");
});
