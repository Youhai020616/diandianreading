import { isRecord, unwrapData, type UnknownRecord } from "./records";
import type { ProviderStatus, SessionStatus } from "./types";

export function providerSource(data: unknown, providerName: string): unknown {
  if (Array.isArray(data)) {
    return (
      data.find((item) => {
        if (!isRecord(item)) {
          return false;
        }
        return item["provider"] === providerName || item["name"] === providerName;
      }) || null
    );
  }
  if (!isRecord(data)) {
    return null;
  }
  const providers = data["providers"];
  if (isRecord(providers)) {
    return providers[providerName] || null;
  }
  return data[providerName] || null;
}

export function normalizeProviderStatus(value: unknown): { status: ProviderStatus } {
  if (!isRecord(value)) {
    return { status: "unknown" };
  }

  if (value["authenticated"] === true || value["connected"] === true || value["healthy"] === true) {
    return { status: "connected" };
  }
  if (value["enabled"] === false || value["available"] === false) {
    return { status: "unavailable" };
  }
  if (value["authenticated"] === false || value["connected"] === false) {
    return { status: "required" };
  }

  const record: UnknownRecord = value;
  const rawStatus =
    typeof record["status"] === "string"
      ? record["status"].toLowerCase()
      : typeof record["state"] === "string"
        ? record["state"].toLowerCase()
        : "";

  if (["ok", "ready", "healthy", "authenticated", "connected"].includes(rawStatus)) {
    return { status: "connected" };
  }
  if (["auth_required", "expired", "unauthenticated", "disconnected", "missing"].includes(rawStatus)) {
    return { status: "required" };
  }
  if (["disabled", "unavailable", "not_configured"].includes(rawStatus)) {
    return { status: "unavailable" };
  }
  if (["error", "failed", "unhealthy"].includes(rawStatus)) {
    return { status: "error" };
  }
  return { status: "unknown" };
}

export function normalizeSession(payload: unknown): { status: SessionStatus } {
  const data = unwrapData(payload);
  if (!isRecord(data)) {
    return { status: "active" };
  }
  if (data["authenticated"] === false || data["active"] === false) {
    return { status: "required" };
  }
  const rawStatus = typeof data["status"] === "string" ? data["status"].toLowerCase() : "";
  if (["expired", "revoked"].includes(rawStatus)) {
    return { status: "expired" };
  }
  if (["required", "unauthenticated", "missing"].includes(rawStatus)) {
    return { status: "required" };
  }
  return { status: "active" };
}
