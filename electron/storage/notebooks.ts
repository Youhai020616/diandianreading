/** Topic notebooks: user-curated bundles of books, drafts and web pages. */
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { NotebookItemKind, NotebookItemRecord, NotebookRecord } from "./records";
import { nowIso } from "./sqlite";

export function listNotebooks(db: DatabaseSync): NotebookRecord[] {
  const nbs = db
    .prepare("SELECT * FROM notebooks ORDER BY updated_at DESC")
    .all() as Array<Record<string, unknown>>;
  const allItems = db
    .prepare("SELECT * FROM notebook_items ORDER BY created_at DESC")
    .all() as Array<Record<string, unknown>>;

  const byNb = new Map<string, NotebookItemRecord[]>();
  for (const r of allItems) {
    const nbId = String(r.notebook_id);
    const list = byNb.get(nbId) ?? [];
    list.push({
      id: String(r.id),
      notebookId: nbId,
      itemKind: String(r.item_kind) as NotebookItemKind,
      itemRef: String(r.item_ref),
      title: String(r.title),
      meta: String(r.meta ?? ""),
      createdAt: String(r.created_at),
    });
    byNb.set(nbId, list);
  }

  return nbs.map((r) => {
    const id = String(r.id);
    return {
      id,
      name: String(r.name),
      icon: String(r.icon ?? "✦"),
      description: String(r.description ?? ""),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      items: byNb.get(id) ?? [],
    };
  });
}

export function createNotebook(db: DatabaseSync, input: { name: string; icon?: string; description?: string }): NotebookRecord {
  const name = input.name.trim();
  if (!name) throw new Error("主题空间名称不能为空");
  const id = `nb_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
  const ts = nowIso();
  db
    .prepare(
      "INSERT INTO notebooks (id, name, icon, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, name, (input.icon || "✦").trim().slice(0, 4), (input.description ?? "").trim(), ts, ts);
  return listNotebooks(db).find((n) => n.id === id)!;
}

export function deleteNotebook(db: DatabaseSync, id: string): void {
  db.prepare("DELETE FROM notebooks WHERE id = ?").run(id);
}

export function addNotebookItem(
  db: DatabaseSync,
  notebookId: string,
  input: { itemKind: NotebookItemKind; itemRef: string; title: string; meta?: string },
): NotebookRecord {
  const exists = db.prepare("SELECT id FROM notebooks WHERE id = ?").get(notebookId);
  if (!exists) throw new Error("主题空间不存在");
  const ref = input.itemRef.trim();
  const title = input.title.trim();
  if (!ref || !title) throw new Error("条目标识与标题不能为空");
  const id = `nbi_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
  const ts = nowIso();
  db
    .prepare(
      `INSERT INTO notebook_items (id, notebook_id, item_kind, item_ref, title, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(notebook_id, item_kind, item_ref) DO UPDATE SET title = excluded.title, meta = excluded.meta`,
    )
    .run(id, notebookId, input.itemKind, ref, title, (input.meta ?? "").trim(), ts);
  db.prepare("UPDATE notebooks SET updated_at = ? WHERE id = ?").run(ts, notebookId);
  return listNotebooks(db).find((n) => n.id === notebookId)!;
}

export function removeNotebookItem(db: DatabaseSync, notebookId: string, itemId: string): NotebookRecord | null {
  db
    .prepare("DELETE FROM notebook_items WHERE id = ? AND notebook_id = ?")
    .run(itemId, notebookId);
  db.prepare("UPDATE notebooks SET updated_at = ? WHERE id = ?").run(nowIso(), notebookId);
  return listNotebooks(db).find((n) => n.id === notebookId) ?? null;
}
