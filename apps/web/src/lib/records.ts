export type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function unwrapData(payload: unknown): unknown {
  if (isRecord(payload) && Object.prototype.hasOwnProperty.call(payload, "data")) {
    return payload["data"];
  }
  return payload;
}

export function firstArray(value: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return [];
  }
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
}
