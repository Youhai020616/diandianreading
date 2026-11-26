import { state, ipc, requireDb } from "../appState";

export function registerAgentIpc(): void {
  // ---------- DeepSeek Harness Agent ----------

  ipc.handle(
    "agent:send",
    async (_win, input: { prompt: string; newSession?: boolean; sessionId?: string | null }) => {
      if (!state.supervisor) throw new Error("Agent state.supervisor unavailable");
      await state.supervisor.send(input.prompt, {
        newSession: input.newSession === true,
        sessionId: input.sessionId ?? undefined,
      });
      return { accepted: true };
    },
  );

  ipc.handle("agent:stop", async () => {
    await state.supervisor?.stopCurrentTurn();
    return { stopped: true };
  });

  ipc.handle("agent:reset", () => {
    state.supervisor?.resetSession();
    return { reset: true };
  });

  ipc.handle("agent:select-session", (_win, sessionId?: string | null) => {
    state.supervisor?.selectSession(sessionId ?? null);
    return { selected: true };
  });

  ipc.handle("agent:list-sessions", (_win, limit?: number) =>
    requireDb().listChatSessions(typeof limit === "number" ? limit : 40),
  );

  ipc.handle("agent:get-session", (_win, id: string) => requireDb().getChatSession(id));

  ipc.handle(
    "agent:save-session",
    (
      _win,
      input: {
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
          tools?: Array<{ name: string; status: "running" | "done" }>;
          createdAt?: string;
        }>;
      },
    ) => requireDb().upsertChatSession(input),
  );

  ipc.handle("agent:delete-session", (_win, id: string) => {
    requireDb().deleteChatSession(id);
    return { deleted: true };
  });
}
