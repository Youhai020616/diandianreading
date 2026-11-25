export function normalizeAllowedWebUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("URL 不能为空");
  }
  const withScheme =
    /^https?:\/\//i.test(trimmed) || trimmed.startsWith("data:text/html")
      ? trimmed
      : /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(trimmed)
        ? `https://${trimmed}`
        : "";
  if (!withScheme) {
    throw new Error("仅支持有效的 http:// 或 https:// 网页地址");
  }
  if (withScheme.startsWith("data:text/html")) {
    return withScheme;
  }
  const parsed = new URL(withScheme);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("安全策略拒绝非 HTTP/HTTPS 协议（禁止 file:// 等本地协议）");
  }
  return parsed.toString();
}
