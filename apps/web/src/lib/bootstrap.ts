import { apiRequest } from "./api";

export interface BootstrapResult {
  attempted: boolean;
  ok: boolean;
  error: unknown;
}

/**
 * Reads the one-time bootstrap nonce from the URL fragment and strips the
 * fragment from the address bar immediately, mirroring the legacy app.js
 * top-of-module behaviour.
 */
export function takeBootstrapNonce(): string | null {
  const fragment = window.location.hash;
  let nonce: string | null = null;

  if (fragment) {
    try {
      const parameters = new URLSearchParams(fragment.slice(1));
      const candidate = parameters.get("bootstrap");
      if (candidate && candidate.length <= 4096) {
        nonce = candidate;
      }
    } finally {
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname + window.location.search,
      );
    }
  }

  return nonce;
}

export async function exchangeBootstrapNonce(nonceValue: string): Promise<BootstrapResult> {
  let nonce: string = nonceValue;
  try {
    await apiRequest("/api/session/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce }),
      requireCsrf: false,
    });
    return { attempted: true, ok: true, error: null };
  } catch (error) {
    return { attempted: true, ok: false, error };
  } finally {
    nonce = "";
    void nonce;
  }
}

/**
 * Takes the nonce (side effect: strips the fragment) and starts the exchange
 * immediately. Call once at application start, before rendering.
 */
export function startBootstrap(): Promise<BootstrapResult> {
  const nonce = takeBootstrapNonce();
  if (!nonce) {
    return Promise.resolve({ attempted: false, ok: true, error: null });
  }
  return exchangeBootstrapNonce(nonce);
}
