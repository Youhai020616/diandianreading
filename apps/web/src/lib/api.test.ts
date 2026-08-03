import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "./api";
import { ApiError, UiError } from "./errors";
import { clearCsrfCookie, installFetchMock, jsonResponse, setCsrfCookie } from "../test/mockFetch";

afterEach(() => {
  clearCsrfCookie();
  vi.unstubAllGlobals();
});

describe("apiRequest CSRF double-submit", () => {
  it("injects X-CSRF-Token from the diandian_csrf cookie on mutating requests", async () => {
    setCsrfCookie("csrf-token-1");
    const { requests } = installFetchMock(() => jsonResponse(200, { data: {} }));

    await apiRequest("/api/session/logout", { method: "POST" });

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.headers.get("X-CSRF-Token")).toBe("csrf-token-1");
    expect(request.headers.get("Accept")).toBe("application/json");
  });

  it("does not attach the CSRF header to GET requests", async () => {
    setCsrfCookie("csrf-token-1");
    const { requests } = installFetchMock(() => jsonResponse(200, { data: {} }));

    await apiRequest("/api/session");

    expect(requests[0]!.headers.get("X-CSRF-Token")).toBeNull();
  });

  it("fails fast with CSRF_MISSING when the cookie is absent", async () => {
    const { requests } = installFetchMock(() => jsonResponse(200, { data: {} }));

    await expect(apiRequest("/api/imports", { method: "POST" })).rejects.toMatchObject({
      name: "UiError",
      code: "CSRF_MISSING",
    });
    expect(requests).toHaveLength(0);
  });

  it("allows requireCsrf=false mutations without the cookie (session bootstrap)", async () => {
    const { requests } = installFetchMock(() => jsonResponse(200, { data: {} }));

    await apiRequest("/api/session/bootstrap", { method: "POST", requireCsrf: false });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get("X-CSRF-Token")).toBeNull();
  });
});

describe("apiRequest error mapping", () => {
  it("maps HTTP statuses to stable codes when no payload code exists", async () => {
    for (const [status, code] of [
      [401, "AUTH_REQUIRED"],
      [404, "NOT_FOUND"],
      [413, "PAYLOAD_TOO_LARGE"],
      [422, "VALIDATION"],
      [500, "API_ERROR"],
    ] as const) {
      installFetchMock(() => new Response(null, { status }));
      const error = await apiRequest("/api/jobs").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(status);
      expect((error as ApiError).code).toBe(code);
    }
  });

  it("prefers the well-formed error code from the response payload", async () => {
    installFetchMock(() =>
      jsonResponse(503, { error: { code: "SOURCE_NOT_READY", message: "x", retriable: true } }),
    );
    const error = await apiRequest("/api/jobs").catch((caught: unknown) => caught);
    expect((error as ApiError).code).toBe("SOURCE_NOT_READY");
    expect((error as ApiError).status).toBe(503);
  });

  it("rejects malformed payload codes and falls back to the status mapping", async () => {
    installFetchMock(() => jsonResponse(422, { error: { code: "not-a-code" } }));
    const error = await apiRequest("/api/jobs").catch((caught: unknown) => caught);
    expect((error as ApiError).code).toBe("VALIDATION");
  });

  it("maps network failures to a status-0 NETWORK_UNAVAILABLE error", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    const error = await apiRequest("/api/jobs").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).code).toBe("NETWORK_UNAVAILABLE");
  });

  it("maps unreadable JSON in a 2xx response to INVALID_RESPONSE", async () => {
    installFetchMock(
      () =>
        new Response("not-json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const error = await apiRequest("/api/jobs").catch((caught: unknown) => caught);
    expect((error as ApiError).code).toBe("INVALID_RESPONSE");
  });

  it("returns null for 204 responses", async () => {
    installFetchMock(() => new Response(null, { status: 204 }));
    setCsrfCookie("csrf-token-1");
    await expect(apiRequest("/api/session/logout", { method: "POST" })).resolves.toBeNull();
  });

  it("refuses non-/api same-origin paths", async () => {
    const { requests } = installFetchMock(() => jsonResponse(200, {}));
    await expect(apiRequest("/etc/passwd")).rejects.toBeInstanceOf(UiError);
    expect(requests).toHaveLength(0);
  });
});
