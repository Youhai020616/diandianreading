import { vi } from "vitest";

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
}

export type FetchRoute = (
  request: RecordedRequest,
) => Response | Promise<Response> | undefined;

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function installFetchMock(route: FetchRoute): {
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const mocked = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request: RecordedRequest = {
      url: String(input),
      method: String(init?.method ?? "GET").toUpperCase(),
      headers: new Headers(init?.headers ?? {}),
      body: init?.body,
    };
    requests.push(request);
    const response = await route(request);
    if (!response) {
      throw new TypeError(`Unhandled fetch route: ${request.method} ${request.url}`);
    }
    return response;
  });
  globalThis.fetch = mocked as unknown as typeof fetch;
  return { requests };
}

export function clearCsrfCookie(): void {
  document.cookie = "diandian_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
}

export function setCsrfCookie(value: string): void {
  document.cookie = `diandian_csrf=${value}; path=/`;
}
