import { type PetWindowMode } from "../pet/petWindow";
import { hooks, state, ipc, sendToMain, requireDb } from "../appState";

export function registerPetIpc(): void {
  // ---------- Floating Desktop Golden Retriever Pet ----------

  ipc.handle("pet:get-state", () =>
    state.petController?.getState() ?? { visible: false, expanded: false, mode: "collapsed", showJumpToMain: false },
  );

  ipc.handle("pet:toggle", async () => {
    if (!state.petController) throw new Error("Pet controller unavailable");
    const next = await state.petController.toggle();
    requireDb().setSetting("pet.enabled", next.visible ? "true" : "false");
    return next;
  });

  ipc.handle("pet:show", async () => {
    if (!state.petController) throw new Error("Pet controller unavailable");
    const next = await state.petController.show();
    requireDb().setSetting("pet.enabled", "true");
    return next;
  });

  ipc.handle("pet:hide", () => {
    if (!state.petController) throw new Error("Pet controller unavailable");
    const next = state.petController.hide();
    requireDb().setSetting("pet.enabled", "false");
    return next;
  });

  ipc.handle("pet:set-expanded", (_win, expanded: boolean) => {
    if (!state.petController) throw new Error("Pet controller unavailable");
    return state.petController.setExpanded(Boolean(expanded));
  });

  ipc.handle("pet:set-mode", (_win, mode: PetWindowMode) => {
    if (!state.petController) throw new Error("Pet controller unavailable");
    if (mode !== "collapsed" && mode !== "nudge" && mode !== "expanded") {
      throw new Error("不支持的桌宠窗口模式");
    }
    return state.petController.setMode(mode);
  });

  ipc.handle("pet:get-recall-muted-today", () => {
    const today = new Date().toISOString().slice(0, 10);
    return { muted: requireDb().getSetting("pet.recallMutedDate") === today };
  });

  ipc.handle("pet:mute-recall-today", () => {
    const today = new Date().toISOString().slice(0, 10);
    requireDb().setSetting("pet.recallMutedDate", today);
    return { muted: true };
  });

  ipc.handle(
    "pet:send-to-draft",
    async (_win, payload: { quote: string; comment?: string; bookTitle?: string; author?: string }) => {
      if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        if (state.mainWindow.isMinimized()) state.mainWindow.restore();
        state.mainWindow.show();
        state.mainWindow.focus();
      } else {
        await hooks.createMainWindow();
      }
      sendToMain("app:quick-action", {
        kind: "draft",
        text: payload.quote,
        comment: payload.comment ?? "",
        title: payload.bookTitle ?? "",
        author: payload.author ?? "",
      });
      return { sent: true };
    },
  );

  ipc.on("pet:move-by", (_win, delta: { dx: number; dy: number }) => {
    state.petController?.moveBy(Number(delta?.dx ?? 0), Number(delta?.dy ?? 0));
  });

  ipc.on("pet:drag-start", (_win, pos: { screenX: number; screenY: number }) => {
    state.petController?.startDrag(Number(pos?.screenX), Number(pos?.screenY));
  });

  ipc.on("pet:drag-move", (_win, pos: { screenX: number; screenY: number }) => {
    state.petController?.dragTo(Number(pos?.screenX), Number(pos?.screenY));
  });

  ipc.on("pet:drag-end", () => {
    state.petController?.endDrag();
  });

  ipc.handle("pet:focus-main", async () => {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      if (state.mainWindow.isMinimized()) state.mainWindow.restore();
      state.mainWindow.show();
      state.mainWindow.focus();
      return { focused: true };
    }
    await hooks.createMainWindow();
    return { focused: true };
  });
}
