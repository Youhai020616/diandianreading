const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const DISPLAY_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

export function internalIdentifier(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || CONTROL_CHARACTERS.test(normalized)) {
    return null;
  }
  return normalized;
}

export function displayText(value: unknown, fallback: string, maxLength?: number): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.replace(DISPLAY_CONTROL_CHARACTERS, " ").trim();
  if (!normalized) {
    return fallback;
  }
  const limit = maxLength !== undefined && Number.isInteger(maxLength) ? maxLength : 500;
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

export function headerText(value: unknown, maxLength?: number): string {
  return displayText(value, "", maxLength).replace(/[\r\n]/gu, " ");
}

export function knownCode(value: unknown): string | null {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/u.test(value)) {
    return null;
  }
  return value;
}
