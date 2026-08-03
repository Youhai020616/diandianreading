export function newClientIdentifier(prefix: string): string {
  if (typeof window.crypto.randomUUID === "function") {
    return `${prefix}-${window.crypto.randomUUID()}`;
  }
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${value}`;
}
