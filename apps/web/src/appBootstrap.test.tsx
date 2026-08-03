import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { startBootstrap } from "./lib/bootstrap";
import { ERROR_TEXT } from "./lib/errors";
import { AppController } from "./state/controller";
import { clearCsrfCookie, installFetchMock, jsonResponse } from "./test/mockFetch";

const controllers: AppController[] = [];

function makeController(): AppController {
  const controller = new AppController();
  controllers.push(controller);
  return controller;
}

afterEach(() => {
  for (const controller of controllers.splice(0)) {
    controller.dispose();
  }
  clearCsrfCookie();
  window.history.replaceState(null, "", "/");
});

function installUnauthenticatedRoutes(): { requests: { url: string; method: string }[] } {
  const { requests } = installFetchMock((request) => {
    if (request.url === "/api/session/bootstrap") {
      return jsonResponse(401, { error: { code: "AUTH_REQUIRED", message: "invalid" } });
    }
    return jsonResponse(401, { error: { code: "AUTH_REQUIRED", message: "no session" } });
  });
  return { requests };
}

describe("session bootstrap flow", () => {
  it("exchanges the fragment nonce once and announces success when the session is active", async () => {
    window.history.replaceState(null, "", "/#bootstrap=nonce-ok");
    const { requests } = installFetchMock((request) => {
      if (request.url === "/api/session/bootstrap") {
        return jsonResponse(200, { data: { authenticated: true, status: "active" } });
      }
      if (request.url === "/api/session") {
        return jsonResponse(200, { data: { authenticated: true, status: "active" } });
      }
      if (request.url === "/api/auth/status") {
        return jsonResponse(200, {
          data: {
            providers: {
              notebooklm: { provider: "notebooklm", state: "authenticated", enabled: true },
              zlibrary: { provider: "zlibrary", state: "disabled", enabled: false },
            },
          },
        });
      }
      if (request.url.startsWith("/api/jobs")) {
        return jsonResponse(200, { data: { jobs: [], next_cursor: null } });
      }
      if (request.url.startsWith("/api/books")) {
        return jsonResponse(200, { data: { books: [], next_cursor: null } });
      }
      return undefined;
    });

    render(<App controller={makeController()} bootstrapTask={startBootstrap()} />);

    await waitFor(() => {
      expect(screen.getByText("Session active / 会话有效")).toBeInTheDocument();
    });
    const bootstrapCalls = requests.filter((request) => request.url === "/api/session/bootstrap");
    expect(bootstrapCalls).toHaveLength(1);
    expect(window.location.hash).toBe("");
    await waitFor(() => {
      expect(document.getElementById("global-live")).toHaveTextContent(
        "Secure local session established / 安全本地会话已建立。",
      );
    });
    expect(screen.getByText("Connected / 已连接")).toBeInTheDocument();
    expect(screen.getByText("Unavailable or disabled / 不可用或未启用")).toBeInTheDocument();
  });

  it("surfaces a friendly error state when the nonce exchange fails", async () => {
    window.history.replaceState(null, "", "/#bootstrap=nonce-bad");
    installUnauthenticatedRoutes();

    render(<App controller={makeController()} bootstrapTask={startBootstrap()} />);

    await waitFor(() => {
      expect(screen.getByText("Session required / 需要会话")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(document.getElementById("global-live")).toHaveTextContent(
        ERROR_TEXT["AUTH_REQUIRED"] as string,
      );
    });
    const logout = document.getElementById("logout-button") as HTMLButtonElement;
    expect(logout.disabled).toBe(true);
  });

  it("does not call the bootstrap endpoint when the fragment has no nonce", async () => {
    window.history.replaceState(null, "", "/");
    const { requests } = installUnauthenticatedRoutes();

    render(<App controller={makeController()} bootstrapTask={startBootstrap()} />);

    await waitFor(() => {
      expect(screen.getByText("Session required / 需要会话")).toBeInTheDocument();
    });
    expect(
      requests.filter((request) => request.url === "/api/session/bootstrap"),
    ).toHaveLength(0);
    expect(document.getElementById("global-live")).toHaveTextContent("");
  });
});
