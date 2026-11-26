import { type DraftKind, type RevisionAuthorKind } from "../storage/database";
import { ipc, requireDb } from "../appState";

export function registerStudioIpc(): void {
  // ---------- Creation Studio (Immutable AI vs Human Revisions) ----------

  ipc.handle("drafts:list", (_win, bookId?: string) => requireDb().listDrafts(bookId));

  ipc.handle("drafts:get", (_win, id: string) => requireDb().getDraft(id));

  ipc.handle(
    "drafts:create",
    (
      _win,
      input: {
        bookId?: string | null;
        title: string;
        kind: DraftKind;
        authorKind: RevisionAuthorKind;
        content: string;
        sourceHighlightIds?: string[];
        promptSummary?: string;
      },
    ) => requireDb().createDraft(input),
  );

  ipc.handle(
    "drafts:append-revision",
    (
      _win,
      input: {
        draftId: string;
        title?: string;
        authorKind: RevisionAuthorKind;
        content: string;
        sourceHighlightIds?: string[];
        promptSummary?: string;
      },
    ) => requireDb().appendDraftRevision(input),
  );

  ipc.handle("drafts:delete", (_win, id: string) => {
    requireDb().deleteDraft(id);
    return { deleted: true };
  });
}
