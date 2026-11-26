/** Persistent conversation history for the ask panel. */
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ChatMessageRecord, ChatMessageToolState, ChatSessionDetail, ChatSessionSummary } from "./records";
import { nowIso } from "./sqlite";

export function listChatSessions(db: DatabaseSync, limit = 40): ChatSessionSummary[] {
  const cap = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = db
    .prepare(
      `SELECT s.id, s.title, s.harness_session_id, s.context_label, s.created_at, s.updated_at,
              (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS message_count,
              COALESCE(
                (SELECT m.text FROM chat_messages m WHERE m.session_id = s.id AND m.role = 'assistant' AND length(trim(m.text)) > 0 ORDER BY m.seq DESC LIMIT 1),
                (SELECT m.text FROM chat_messages m WHERE m.session_id = s.id ORDER BY m.seq DESC LIMIT 1),
                ''
              ) AS preview
       FROM chat_sessions s
       ORDER BY s.updated_at DESC
       LIMIT ?`,
    )
    .all(cap) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: String(r.id),
    title: String(r.title || "未命名对话"),
    harnessSessionId: String(r.harness_session_id ?? ""),
    contextLabel: String(r.context_label ?? ""),
    messageCount: Number(r.message_count ?? 0),
    preview: String(r.preview ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }));
}

export function getChatSession(db: DatabaseSync, id: string): ChatSessionDetail | null {
  const row = db
    .prepare(
      `SELECT id, title, harness_session_id, context_label, created_at, updated_at
       FROM chat_sessions WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;

  const msgRows = db
    .prepare(
      `SELECT id, session_id, role, text, reasoning, contexts_json, tools_json, created_at
       FROM chat_messages
       WHERE session_id = ?
       ORDER BY seq ASC`,
    )
    .all(id) as Array<Record<string, unknown>>;

  const messages: ChatMessageRecord[] = msgRows.map((m) => {
    let contexts: string[] = [];
    let tools: ChatMessageToolState[] = [];
    try {
      const parsed = JSON.parse(String(m.contexts_json ?? "[]"));
      if (Array.isArray(parsed)) contexts = parsed.map(String);
    } catch {
      contexts = [];
    }
    try {
      const parsed = JSON.parse(String(m.tools_json ?? "[]"));
      if (Array.isArray(parsed)) {
        tools = parsed
          .filter((t): t is Record<string, unknown> => Boolean(t && typeof t === "object"))
          .map((t) => ({
            name: String(t.name ?? "tool"),
            status: t.status === "running" ? "running" : "done",
          }));
      }
    } catch {
      tools = [];
    }
    const rawRole = String(m.role ?? "user");
    const role: ChatMessageRecord["role"] =
      rawRole === "assistant" || rawRole === "system" ? rawRole : "user";
    return {
      id: String(m.id),
      sessionId: String(m.session_id),
      role,
      text: String(m.text ?? ""),
      reasoning: String(m.reasoning ?? ""),
      contexts,
      tools,
      createdAt: String(m.created_at),
    };
  });

  const lastPreview =
    [...messages].reverse().find((m) => m.role === "assistant" && m.text.trim())?.text
    ?? messages[messages.length - 1]?.text
    ?? "";

  return {
    id: String(row.id),
    title: String(row.title || "未命名对话"),
    harnessSessionId: String(row.harness_session_id ?? ""),
    contextLabel: String(row.context_label ?? ""),
    messageCount: messages.length,
    preview: lastPreview.replace(/\s+/g, " ").trim().slice(0, 120),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    messages,
  };
}

export function upsertChatSession(db: DatabaseSync, input: {
  id: string;
  title: string;
  harnessSessionId?: string;
  contextLabel?: string;
  messages: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    text: string;
    reasoning?: string;
    contexts?: string[];
    tools?: ChatMessageToolState[];
    createdAt?: string;
  }>;
}): ChatSessionSummary {
  const id = input.id.trim() || `chat_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
  const title = (input.title || "新对话").replace(/\s+/g, " ").trim().slice(0, 48) || "新对话";
  const ts = nowIso();
  const incomingHarnessId = (input.harnessSessionId ?? "").trim();
  const contextLabel = (input.contextLabel ?? "").replace(/\s+/g, " ").trim().slice(0, 60);

  db.exec("BEGIN");
  try {
    const existing = db
      .prepare("SELECT harness_session_id, created_at FROM chat_sessions WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;

    const harnessId = incomingHarnessId || String(existing?.harness_session_id ?? "");
    const createdAt = existing ? String(existing.created_at) : ts;

    db
      .prepare(
        `INSERT INTO chat_sessions (id, title, harness_session_id, context_label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           harness_session_id = CASE WHEN excluded.harness_session_id != '' THEN excluded.harness_session_id ELSE chat_sessions.harness_session_id END,
           -- The context a conversation started from stays its group.
           context_label = CASE WHEN chat_sessions.context_label = '' THEN excluded.context_label ELSE chat_sessions.context_label END,
           updated_at = excluded.updated_at`,
      )
      .run(id, title, harnessId, contextLabel, createdAt, ts);

    db.prepare("DELETE FROM chat_messages WHERE session_id = ?").run(id);
    const insertMsg = db.prepare(
      `INSERT INTO chat_messages (id, session_id, seq, role, text, reasoning, contexts_json, tools_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let seq = 0; seq < input.messages.length; seq += 1) {
      const m = input.messages[seq]!;
      const msgId = (m.id || `m_${crypto.randomUUID().slice(0, 10)}`).trim();
      const role = m.role === "assistant" || m.role === "system" ? m.role : "user";
      insertMsg.run(
        msgId,
        id,
        seq,
        role,
        String(m.text ?? ""),
        String(m.reasoning ?? ""),
        JSON.stringify(Array.isArray(m.contexts) ? m.contexts.map(String) : []),
        JSON.stringify(Array.isArray(m.tools) ? m.tools : []),
        m.createdAt || ts,
      );
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return listChatSessions(db, 100).find((s) => s.id === id)!;
}

export function deleteChatSession(db: DatabaseSync, id: string): void {
  db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(id);
}
