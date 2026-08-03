import { afterEach, describe, expect, it } from "vitest";
import { exchangeBootstrapNonce, startBootstrap, takeBootstrapNonce } from "./bootstrap";
import { ApiError } from "./errors";
import { installFetchMock, jsonResponse } from "../test/mockFetch";

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("takeBootstrapNonce", () => {
  it("reads the nonce from the URL fragment and strips the fragment once", () => {
    window.history.replaceState(null, "", "/?keep=1#bootstrap=nonce-abc");
    const nonce = takeBootstrapNonce();
    expect(nonce).toBe("nonce-abc");
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("?keep=1");
  });

  it("returns null when the fragment is missing", () => {
    window.history.replaceState(null, "", "/");
    expect(takeBootstrapNonce()).toBeNull();
  });

  it("rejects oversized nonces but still strips the fragment", () => {
    window.history.replaceState(null, "", `/#bootstrap=${"a".repeat(4097)}`);
    expect(takeBootstrapNonce()).toBeNull();
    expect(window.location.hash).toBe("");
  });
});

describe("exchangeBootstrapNonce", () => {
  it("POSTs the nonce without a CSRF requirement", async () => {
    const { requests } = installFetchMock(() =>
      jsonResponse(200, { data: { authenticated: true, status: "active" } }),
    );

    const result = await exchangeBootstrapNonce("nonce-abc");

    expect(result).toEqual({ attempted: true, ok: true, error: null });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe("/api/session/bootstrap");
    expect(request.method).toBe("POST");
    expect(request.headers.get("Content-Type")).toBe("application/json");
    expect(request.headers.get("X-CSRF-Token")).toBeNull();
    expect(JSON.parse(String(request.body))).toEqual({ nonce: "nonce-abc" });
  });

  it("reports a failed exchange with the mapped ApiError", async () => {
    installFetchMock(() =>
      jsonResponse(401, { error: { code: "AUTH_REQUIRED", message: "invalid" } }),
    );

    const result = await exchangeBootstrapNonce("nonce-bad");

    expect(result.attempted).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(ApiError);
    expect((result.error as ApiError).code).toBe("AUTH_REQUIRED");
  });
});

describe("startBootstrap", () => {
  it("resolves without an attempt when no nonce is present", async () => {
    window.history.replaceState(null, "", "/");
    const { requests } = installFetchMock(() => jsonResponse(200, {}));

    await expect(startBootstrap()).resolves.toEqual({
      attempted: false,
      ok: true,
      error: null,
    });
    expect(requests).toHaveLength(0);
  });

  it("attempts the exchange exactly once when the fragment carries a nonce", async () => {
    window.history.replaceState(null, "", "/#bootstrap=nonce-1");
    const { requests } = installFetchMock(() => jsonResponse(200, { data: {} }));

    const result = await startBootstrap();

    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(window.location.hash).toBe("");
  });
});
