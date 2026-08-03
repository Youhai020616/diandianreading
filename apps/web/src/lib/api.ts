import { ApiError, UiError } from "./errors";
import { isRecord, unwrapData, type UnknownRecord } from "./records";
import { knownCode } from "./text";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const CSRF_COOKIE_NAME = "diandian_csrf";
export const CSRF_HEADER_NAME = "X-CSRF-Token";

export interface ApiRequestOptions {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  signal?: AbortSignal;
  requireCsrf?: boolean;
}

export function safeApiUrl(path: string): URL {
  const url = new URL(path, window.location.href);
  if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) {
    throw new UiError("INVALID_API_PATH");
  }
  return url;
}

export function readCookie(name: string): string {
  const entries = document.cookie ? document.cookie.split(";") : [];
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    const rawName = separator >= 0 ? entry.slice(0, separator) : entry;
    if (rawName.trim() !== name) {
      continue;
    }
    const rawValue = separator >= 0 ? entry.slice(separator + 1) : "";
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }
  return "";
}

export function responseError(payload: unknown): UnknownRecord | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (isRecord(payload["error"])) {
    return payload["error"];
  }
  const data = unwrapData(payload);
  if (isRecord(data) && isRecord(data["error"])) {
    return data["error"];
  }
  return null;
}

export function httpStatusCode(status: number): string {
  if (status === 401) {
    return "AUTH_REQUIRED";
  }
  if (status === 404) {
    return "NOT_FOUND";
  }
  if (status === 413) {
    return "PAYLOAD_TOO_LARGE";
  }
  if (status === 422) {
    return "VALIDATION";
  }
  return "API_ERROR";
}

export async function apiRequest(path: string, options?: ApiRequestOptions): Promise<unknown> {
  const requestOptions = options || {};
  const method = String(requestOptions.method || "GET").toUpperCase();
  const url = safeApiUrl(path);
  const headers = new Headers(requestOptions.headers || {});
  const requireCsrf = requestOptions.requireCsrf !== false;

  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }

  if (MUTATING_METHODS.has(method)) {
    const csrfToken = readCookie(CSRF_COOKIE_NAME);
    if (!csrfToken && requireCsrf) {
      throw new UiError("CSRF_MISSING");
    }
    if (csrfToken) {
      headers.set(CSRF_HEADER_NAME, csrfToken);
    }
  }

  let response: Response;
  try {
    response = await fetch(url.pathname + url.search, {
      method,
      headers,
      body: requestOptions.body ?? null,
      signal: requestOptions.signal ?? null,
      credentials: "include",
      mode: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  } catch {
    throw new ApiError(0, "NETWORK_UNAVAILABLE", null);
  }

  let payload: unknown = null;
  if (response.status !== 204) {
    const contentType = response.headers.get("Content-Type") || "";
    if (contentType.toLowerCase().includes("application/json")) {
      try {
        payload = await response.json();
      } catch {
        if (response.ok) {
          throw new ApiError(response.status, "INVALID_RESPONSE", null);
        }
      }
    }
  }

  if (!response.ok) {
    const error = responseError(payload);
    const code = knownCode(error && error["code"]) || httpStatusCode(response.status);
    throw new ApiError(response.status, code, payload);
  }

  return payload;
}

export function eventSourceFor(path: string): EventSource {
  const url = safeApiUrl(path);
  return new EventSource(url.pathname + url.search, { withCredentials: true });
}
