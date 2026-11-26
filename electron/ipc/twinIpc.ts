import { distillStyleFromRevisionDiff } from "../twin/styleDistiller";
import { state, ipc, requireDb } from "../appState";

export function registerTwinIpc(): void {
  // ---------- Twin Profile (PROFILE.md / STYLE.md) ----------

  ipc.handle("twin:get", () => {
    if (!state.twinStore) throw new Error("Twin store not initialized");
    return state.twinStore.read();
  });

  ipc.handle("twin:save", (_win, input: { profileMd?: string; styleMd?: string }) => {
    if (!state.twinStore) throw new Error("Twin store not initialized");
    return state.twinStore.save(input);
  });

  ipc.handle("twin:distill-diff", async (_win, input: { draftId: string }) => {
    if (!state.twinStore) throw new Error("Twin store not initialized");
    const draft = requireDb().getDraft(String(input?.draftId ?? ""));
    if (!draft?.revisions || draft.revisions.length < 2) {
      return { suggestions: [] };
    }
    const aiRev = draft.revisions.find((r) => r.authorKind === "ai");
    const humanRev = [...draft.revisions].reverse().find((r) => r.authorKind === "human");
    if (!aiRev || !humanRev) return { suggestions: [] };
    const twin = state.twinStore.read();
    const modelSettings = state.settingsStore ? state.settingsStore.readRaw() : null;
    const suggestions = await distillStyleFromRevisionDiff({
      aiOriginal: aiRev.content,
      humanRevision: humanRev.content,
      currentStyleMd: twin.styleMd,
      modelSettings,
    });
    return { suggestions };
  });

  ipc.handle("twin:accept-style-rules", (_win, rules: string[]) => {
    if (!state.twinStore) throw new Error("Twin store not initialized");
    const clean = Array.isArray(rules) ? rules.map((r) => String(r)) : [];
    return state.twinStore.appendLearnedStyleRules(clean);
  });
}
