import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { ERROR_TEXT } from "./lib/errors";
import { AppController } from "./state/controller";
import { FakeEventSource } from "./test/fakeEventSource";
import {
  clearCsrfCookie,
  installFetchMock,
  jsonResponse,
  setCsrfCookie,
  type RecordedRequest,
} from "./test/mockFetch";

const controllers: AppController[] = [];

afterEach(() => {
  for (const controller of controllers.splice(0)) {
    controller.dispose();
  }
  clearCsrfCookie();
  window.history.replaceState(null, "", "/");
});

interface ChatHarness {
  requests: RecordedRequest[];
  setRunResult: (payload: unknown) => void;
  setMessagesResult: (payload: unknown) => void;
  setSubmitResult: (respond: () => Response) => void;
}

const CONVERSATION = {
  id: "conv-1",
  book_id: "book-1",
  title: "Discuss / 讨论：Book One",
  status: "active",
  created_at: "2026-08-01T00:00:00+00:00",
  updated_at: "2026-08-01T00:00:00+00:00",
  version: 1,
};

const USER_MESSAGE = {
  id: "msg-user-1",
  conversation_id: "conv-1",
  chat_run_id: "run-1",
  role: "user",
  content: "什么是以用户为中心的设计?",
  created_at: "2026-08-01T00:00:10+00:00",
};

const ASSISTANT_PENDING = {
  id: "msg-assistant-1",
  conversation_id: "conv-1",
  chat_run_id: "run-1",
  role: "assistant",
  content: null,
  created_at: "2026-08-01T00:00:11+00:00",
};

function queuedRun(): unknown {
  return { id: "run-1", conversation_id: "conv-1", status: "queued", phase: null, error: null };
}

function setupChatApp(): ChatHarness {
  setCsrfCookie("csrf-token-1");
  let runResult: unknown = null;
  let messagesResult: unknown = {
    data: { messages: [], active_chat_run: null, next_cursor: null },
  };
  let submitResult: () => Response = () =>
    jsonResponse(202, {
      data: {
        user_message: USER_MESSAGE,
        assistant_message: ASSISTANT_PENDING,
        chat_run: queuedRun(),
        replayed: false,
      },
    });
  let conversationExists = false;

  const { requests } = installFetchMock((request) => {
    if (request.url === "/api/session") {
      return jsonResponse(200, { data: { authenticated: true, status: "active" } });
    }
    if (request.url === "/api/auth/status") {
      return jsonResponse(200, {
        data: {
          providers: {
            notebooklm: { state: "authenticated", enabled: true },
            zlibrary: { state: "disabled", enabled: false },
          },
        },
      });
    }
    if (request.url.startsWith("/api/jobs")) {
      return jsonResponse(200, { data: { jobs: [], next_cursor: null } });
    }
    if (request.url === "/api/books?limit=100") {
      return jsonResponse(200, {
        data: {
          books: [{ id: "book-1", title: "Book One", author: null, status: "ready" }],
          next_cursor: null,
        },
      });
    }
    if (request.url === "/api/books/book-1/conversation" && request.method === "GET") {
      if (!conversationExists) {
        return jsonResponse(404, { error: { code: "NOT_FOUND", message: "missing" } });
      }
      return jsonResponse(200, { data: { conversation: CONVERSATION } });
    }
    if (request.url === "/api/books/book-1/conversation" && request.method === "PUT") {
      conversationExists = true;
      return jsonResponse(201, { data: { conversation: CONVERSATION, created: true } });
    }
    if (
      request.url === "/api/conversations/conv-1/messages?limit=50"
      && request.method === "GET"
    ) {
      return jsonResponse(200, messagesResult);
    }
    if (request.url === "/api/conversations/conv-1/messages" && request.method === "POST") {
      return submitResult();
    }
    if (request.url.startsWith("/api/chat-runs/") && request.method === "GET") {
      return jsonResponse(200, runResult);
    }
    if (request.url === "/api/chat-runs/run-1/retry" && request.method === "POST") {
      return jsonResponse(202, {
        data: { chat_run: queuedRun(), client_retry_id: "ignored", replayed: false },
      });
    }
    return undefined;
  });

  const controller = new AppController();
  controllers.push(controller);
  render(
    <App
      controller={controller}
      bootstrapTask={Promise.resolve({ attempted: false, ok: true, error: null })}
    />,
  );

  return {
    requests,
    setRunResult: (payload) => {
      runResult = payload;
    },
    setMessagesResult: (payload) => {
      messagesResult = payload;
    },
    setSubmitResult: (respond) => {
      submitResult = respond;
    },
  };
}

async function openConversationAndSubmit(): Promise<void> {
  // Below the desktop breakpoint the panel is an aria-hidden drawer until the
  // user opens it, mirroring the legacy behaviour.
  fireEvent.click(document.getElementById("nav-chat-button") as HTMLButtonElement);
  const select = document.getElementById("chat-book-select") as HTMLSelectElement;
  await waitFor(() => {
    expect(select.value).toBe("book-1");
  });

  fireEvent.click(screen.getByRole("button", { name: "Open / 打开" }));
  await waitFor(() => {
    expect(document.getElementById("chat-state")).toHaveTextContent(
      "Conversation ready for “Book One” / 对话已就绪。",
    );
  });

  const textarea = document.getElementById("chat-question") as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: "什么是以用户为中心的设计?" } });
  fireEvent.submit(document.getElementById("chat-form") as HTMLFormElement);
}

describe("chat submission and run state machine", () => {
  it("submits with idempotency metadata and renders the queued run state", async () => {
    const harness = setupChatApp();
    await openConversationAndSubmit();

    await waitFor(() => {
      expect(document.getElementById("chat-state")).toHaveTextContent(
        "Question saved; waiting for the worker / 问题已保存，等待处理。",
      );
    });

    const submit = harness.requests.find(
      (request) =>
        request.url === "/api/conversations/conv-1/messages" && request.method === "POST",
    );
    expect(submit).toBeDefined();
    const body = JSON.parse(String(submit!.body)) as Record<string, unknown>;
    expect(body["question"]).toBe("什么是以用户为中心的设计?");
    expect(body["query_scope"]).toEqual({ type: "book" });
    expect(typeof body["client_message_id"]).toBe("string");
    expect(submit!.headers.get("Idempotency-Key")).toBe(body["client_message_id"]);
    expect(submit!.headers.get("X-CSRF-Token")).toBe("csrf-token-1");

    // Messages render from the submission payload: user text plus pending answer.
    expect(screen.getByText("什么是以用户为中心的设计?")).toBeInTheDocument();
    expect(screen.getByText("Answer pending / 回答等待处理中。")).toBeInTheDocument();

    // Queued/running runs expose only the cancel action.
    expect(document.getElementById("cancel-chat-button")).toBeVisible();
    expect(document.getElementById("retry-chat-button")).not.toBeVisible();

    // A credentialed run event stream is opened for the accepted run.
    const runStream = FakeEventSource.instances.find(
      (instance) => instance.url === "/api/chat-runs/run-1/events",
    );
    expect(runStream).toBeDefined();
    expect(runStream!.withCredentials).toBe(true);
  });

  it("renders the completed answer with API-provided citations after a run event", async () => {
    const harness = setupChatApp();
    await openConversationAndSubmit();
    await waitFor(() => {
      expect(document.getElementById("cancel-chat-button")).toBeVisible();
    });

    const completedAssistant = {
      ...ASSISTANT_PENDING,
      content: "以用户为中心的设计强调……",
    };
    harness.setRunResult({
      data: {
        chat_run: { id: "run-1", conversation_id: "conv-1", status: "completed", phase: null, error: null },
        assistant_message: completedAssistant,
        references: [
          {
            citation_number: 1,
            label: "第 4 章 Part 2",
            passage: "书中指出……",
            location: { type: "chapter", value: "4" },
          },
        ],
      },
    });
    harness.setMessagesResult({
      data: {
        messages: [USER_MESSAGE, { ...completedAssistant, references: [] }],
        active_chat_run: null,
        next_cursor: null,
      },
    });

    const runStream = FakeEventSource.instances.find(
      (instance) => instance.url === "/api/chat-runs/run-1/events",
    )!;
    runStream.emit("chat_run.completed", { id: 3 });

    await waitFor(() => {
      expect(document.getElementById("chat-state")).toHaveTextContent(
        "Answer completed and saved / 回答已完成并保存。",
      );
    });
    expect(screen.getByText("以用户为中心的设计强调……")).toBeInTheDocument();

    const citation = screen.getByRole("button", {
      name: "来源 1，第 4 章 Part 2，来源位置可用",
    });
    expect(citation).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(citation);
    expect(citation).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("书中指出……")).toBeVisible();

    // Terminal run: the stream closes and the run actions disappear.
    await waitFor(() => {
      expect(runStream.closed).toBe(true);
    });
    expect(document.getElementById("run-actions")).not.toBeVisible();
  });

  it("shows a time-gated retry action for retriable failures and resubmits idempotently", async () => {
    const harness = setupChatApp();
    await openConversationAndSubmit();
    await waitFor(() => {
      expect(document.getElementById("cancel-chat-button")).toBeVisible();
    });

    harness.setRunResult({
      data: {
        chat_run: {
          id: "run-1",
          conversation_id: "conv-1",
          status: "failed",
          phase: null,
          error: {
            code: "REMOTE_UNAVAILABLE",
            message: "",
            retriable: true,
            retry_after_ms: 60,
          },
        },
      },
    });
    const runStream = FakeEventSource.instances.find(
      (instance) => instance.url === "/api/chat-runs/run-1/events",
    )!;
    runStream.emit("chat_run.failed", { id: 4 });

    const retryButton = document.getElementById("retry-chat-button") as HTMLButtonElement;
    await waitFor(() => {
      expect(document.getElementById("chat-state")).toHaveTextContent(
        ERROR_TEXT["REMOTE_UNAVAILABLE"] as string,
      );
    });
    expect(retryButton).toBeVisible();
    expect(document.getElementById("cancel-chat-button")).not.toBeVisible();
    expect(retryButton.disabled).toBe(true);

    // retry_after_ms elapses and the action unlocks.
    await waitFor(() => {
      expect(retryButton.disabled).toBe(false);
    });

    harness.setRunResult({ data: { chat_run: queuedRun() } });
    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(document.getElementById("chat-state")).toHaveTextContent(
        "Question saved; waiting for the worker / 问题已保存，等待处理。",
      );
    });
    const retry = harness.requests.find(
      (request) => request.url === "/api/chat-runs/run-1/retry" && request.method === "POST",
    );
    expect(retry).toBeDefined();
    const retryBody = JSON.parse(String(retry!.body)) as Record<string, unknown>;
    expect(retry!.headers.get("Idempotency-Key")).toBe(retryBody["client_retry_id"]);
  });

  it("never offers retry for ambiguous provider outcomes", async () => {
    const harness = setupChatApp();
    await openConversationAndSubmit();
    await waitFor(() => {
      expect(document.getElementById("cancel-chat-button")).toBeVisible();
    });

    harness.setRunResult({
      data: {
        chat_run: {
          id: "run-1",
          conversation_id: "conv-1",
          status: "failed",
          phase: null,
          error: {
            code: "AMBIGUOUS_PROVIDER_OUTCOME",
            message: "",
            retriable: true,
            retry_after_ms: 0,
          },
        },
      },
    });
    const runStream = FakeEventSource.instances.find(
      (instance) => instance.url === "/api/chat-runs/run-1/events",
    )!;
    runStream.emit("chat_run.failed", { id: 5 });

    await waitFor(() => {
      expect(document.getElementById("chat-state")).toHaveTextContent(
        ERROR_TEXT["AMBIGUOUS_PROVIDER_OUTCOME"] as string,
      );
    });
    expect(document.getElementById("retry-chat-button")).not.toBeVisible();
    expect(document.getElementById("run-actions")).not.toBeVisible();
  });

  it("recovers the active run when the API reports CONVERSATION_BUSY", async () => {
    const harness = setupChatApp();
    harness.setSubmitResult(() =>
      jsonResponse(409, {
        error: {
          code: "CONVERSATION_BUSY",
          message: "busy",
          retriable: false,
          details: { active_run_url: "/api/chat-runs/run-9" },
        },
      }),
    );
    harness.setRunResult({
      data: {
        chat_run: {
          id: "run-9",
          conversation_id: "conv-1",
          status: "running",
          phase: "waiting_for_provider",
          error: null,
        },
      },
    });

    await openConversationAndSubmit();

    await waitFor(() => {
      expect(document.getElementById("chat-state")).toHaveTextContent(
        ERROR_TEXT["CONVERSATION_BUSY"] as string,
      );
    });
    expect(document.getElementById("cancel-chat-button")).toBeVisible();
  });
});
