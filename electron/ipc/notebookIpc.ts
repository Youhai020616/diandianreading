import { type NotebookItemKind } from "../storage/database";
import { ipc, requireDb } from "../appState";

export function registerNotebookIpc(): void {
  // ---------- Surf-Style Topic Notebooks ----------

  ipc.handle("notebooks:list", () => requireDb().listNotebooks());

  ipc.handle("notebooks:create", (_win, input: { name: string; icon?: string; description?: string }) =>
    requireDb().createNotebook(input),
  );

  ipc.handle("notebooks:delete", (_win, id: string) => {
    requireDb().deleteNotebook(String(id ?? ""));
    return { deleted: true };
  });

  ipc.handle(
    "notebooks:add-item",
    (
      _win,
      input: { notebookId: string; itemKind: NotebookItemKind; itemRef: string; title: string; meta?: string },
    ) =>
      requireDb().addNotebookItem(input.notebookId, {
        itemKind: input.itemKind,
        itemRef: input.itemRef,
        title: input.title,
        meta: input.meta,
      }),
  );

  ipc.handle("notebooks:remove-item", (_win, input: { notebookId: string; itemId: string }) =>
    requireDb().removeNotebookItem(input.notebookId, input.itemId),
  );
}
