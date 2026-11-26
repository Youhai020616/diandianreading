/** Grouping and labelling helpers for the ask panel's conversation history. */

interface ContextLike {
  kind: string;
  label: string;
}

/**
 * The subject a conversation is about. A web page label carries the chapter too
 * ("当前页：书名 · 章节"); turning pages in the same book must not look like a new subject.
 */
export function contextSubject(context: ContextLike | null | undefined): string {
  if (!context) return "";
  const label = context.label.replace(/\s+/g, " ").trim();
  if (context.kind !== "web") return label;
  const page = label.replace(/^当前页[:：]\s*/, "");
  return (page.split(" · ")[0] ?? page).replace(/…$/, "").trim();
}

export interface SessionGroup<T> {
  label: string;
  sessions: T[];
}

export const UNGROUPED_SESSIONS_LABEL = "其他对话";

/** Groups sessions by the context they started from, most recently active group first; ungrouped last. */
export function groupSessionsByContext<T extends { contextLabel: string; updatedAt: string }>(sessions: T[]): SessionGroup<T>[] {
  const groups = new Map<string, T[]>();
  const sorted = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const session of sorted) {
    const label = session.contextLabel.trim() || UNGROUPED_SESSIONS_LABEL;
    groups.set(label, [...(groups.get(label) ?? []), session]);
  }
  const ungrouped = groups.get(UNGROUPED_SESSIONS_LABEL);
  groups.delete(UNGROUPED_SESSIONS_LABEL);
  const result = [...groups].map(([label, list]) => ({ label, sessions: list }));
  if (ungrouped) result.push({ label: UNGROUPED_SESSIONS_LABEL, sessions: ungrouped });
  return result;
}
