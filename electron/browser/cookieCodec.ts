export interface NormalizedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
  expirationDate?: number;
}

export interface CookieDomainSummary {
  domain: string;
  count: number;
  recommended: boolean;
}

export interface ParsedCookieBundle {
  format: "netscape" | "json";
  cookies: NormalizedCookie[];
  domains: CookieDomainSummary[];
}

export interface QrMatrix {
  size: number;
  rows: boolean[][];
}

const RECOMMENDED_DOMAIN_PATTERNS: RegExp[] = [
  /(^|\.)weread\.qq\.com$/i,
  /(^|\.)qq\.com$/i,
  /(^|\.)weixin\.qq\.com$/i,
  /(^|\.)douban\.com$/i,
  /(^|\.)xiaohongshu\.com$/i,
  /(^|\.)z-lib\./i,
  /(^|\.)z-library\./i,
  /(^|\.)zlib\./i,
  /(^|\.)singlelogin\./i,
  /(^|\.)article\.sk$/i,
];

export function isRecommendedReadingDomain(rawDomain: string): boolean {
  const clean = normalizeDomainKey(rawDomain);
  if (!clean) return false;
  return RECOMMENDED_DOMAIN_PATTERNS.some((re) => re.test(clean));
}

export function normalizeDomainKey(rawDomain: string): string {
  return rawDomain.trim().replace(/^\.+/, "").toLowerCase();
}

function normalizeSameSite(raw: unknown): NormalizedCookie["sameSite"] {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "strict") return "strict";
  if (s === "lax") return "lax";
  if (s === "none" || s === "no_restriction") return "no_restriction";
  return undefined;
}

function parseNetscapeCookies(raw: string): NormalizedCookie[] {
  const lines = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  const out: NormalizedCookie[] = [];

  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line) continue;

    let httpOnly = false;
    if (line.startsWith("#HttpOnly_")) {
      httpOnly = true;
      line = line.slice("#HttpOnly_".length);
    } else if (line.startsWith("#")) {
      continue;
    }

    const parts = line.split("\t");
    if (parts.length < 7) continue;
    const domain = (parts[0] ?? "").trim();
    const cookiePath = (parts[2] ?? "/").trim() || "/";
    const secure = (parts[3] ?? "").trim().toUpperCase() === "TRUE";
    const expNum = Number(parts[4] ?? "0");
    const name = (parts[5] ?? "").trim();
    const value = parts.slice(6).join("\t");

    if (!domain || !name) continue;
    out.push({
      name,
      value,
      domain,
      path: cookiePath.startsWith("/") ? cookiePath : `/${cookiePath}`,
      secure,
      httpOnly,
      ...(Number.isFinite(expNum) && expNum > 0 ? { expirationDate: expNum } : {}),
    });
  }
  return out;
}

function parseJsonCookies(raw: string): NormalizedCookie[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).cookies)
      ? ((parsed as Record<string, unknown>).cookies as unknown[])
      : null;
  if (!list) return null;

  const out: NormalizedCookie[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const name = String(rec.name ?? "").trim();
    const value = rec.value !== undefined && rec.value !== null ? String(rec.value) : "";
    const domain = String(rec.domain ?? rec.host ?? "").trim();
    if (!name || !domain) continue;

    const cookiePath = String(rec.path ?? "/").trim() || "/";
    const expRaw = rec.expirationDate ?? rec.expires ?? rec.expiry;
    let expirationDate: number | undefined;
    if (typeof expRaw === "number" && Number.isFinite(expRaw) && expRaw > 0) {
      // Handle millisecond timestamps gracefully.
      expirationDate = expRaw > 1e12 ? Math.floor(expRaw / 1000) : expRaw;
    }

    out.push({
      name,
      value,
      domain,
      path: cookiePath.startsWith("/") ? cookiePath : `/${cookiePath}`,
      secure: rec.secure === true,
      httpOnly: rec.httpOnly === true,
      sameSite: normalizeSameSite(rec.sameSite),
      ...(expirationDate ? { expirationDate } : {}),
    });
  }
  return out;
}

export function summarizeCookiesByDomain(cookies: NormalizedCookie[]): CookieDomainSummary[] {
  const counts = new Map<string, number>();
  for (const c of cookies) {
    const key = normalizeDomainKey(c.domain);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([domain, count]) => ({
      domain,
      count,
      recommended: isRecommendedReadingDomain(domain),
    }))
    .sort((a, b) => {
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
      return b.count - a.count || a.domain.localeCompare(b.domain);
    });
}

export function parseCookieInput(rawText: string): ParsedCookieBundle {
  const trimmed = rawText.replace(/^\uFEFF/, "").trim();
  if (!trimmed) {
    throw new Error("Cookie 内容为空");
  }

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const jsonCookies = parseJsonCookies(trimmed);
    if (jsonCookies && jsonCookies.length > 0) {
      return {
        format: "json",
        cookies: jsonCookies,
        domains: summarizeCookiesByDomain(jsonCookies),
      };
    }
  }

  const netscapeCookies = parseNetscapeCookies(trimmed);
  if (netscapeCookies.length > 0) {
    return {
      format: "netscape",
      cookies: netscapeCookies,
      domains: summarizeCookiesByDomain(netscapeCookies),
    };
  }

  throw new Error("未能识别 Cookie 格式：请导入标准 Netscape cookies.txt 或 Cookie-Editor 导出的 JSON 数组");
}

export function filterCookiesByDomains(
  cookies: NormalizedCookie[],
  selectedDomains: string[],
): NormalizedCookie[] {
  const targets = new Set(selectedDomains.map(normalizeDomainKey).filter(Boolean));
  if (targets.size === 0) return [];
  return cookies.filter((c) => {
    const dom = normalizeDomainKey(c.domain);
    if (targets.has(dom)) return true;
    for (const t of targets) {
      if (dom.endsWith(`.${t}`) || t.endsWith(`.${dom}`)) return true;
    }
    return false;
  });
}

export function buildElectronCookieUrl(cookie: NormalizedCookie): string {
  const host = normalizeDomainKey(cookie.domain);
  const scheme = cookie.secure ? "https" : "http";
  const pathPart = cookie.path.startsWith("/") ? cookie.path : `/${cookie.path}`;
  return `${scheme}://${host}${pathPart}`;
}

/**
 * Serialize cookies into Netscape cookies.txt format (accepted by `zlib login --cookies`).
 */
export function serializeToNetscapeCookies(cookies: NormalizedCookie[]): string {
  const lines = [
    "# Netscape HTTP Cookie File",
    "# Generated temporarily by diandianreading for local CLI login sync",
  ];
  for (const c of cookies) {
    const cleanHost = normalizeDomainKey(c.domain);
    if (!cleanHost || !c.name) continue;
    const includeSubdomains = c.domain.startsWith(".") ? "TRUE" : "FALSE";
    const domainField = c.domain.startsWith(".") ? `.${cleanHost}` : cleanHost;
    const prefix = c.httpOnly ? "#HttpOnly_" : "";
    const pathField = (c.path || "/").replace(/[\r\n\t]/g, "");
    const secureField = c.secure ? "TRUE" : "FALSE";
    const expField = c.expirationDate && c.expirationDate > 0 ? String(Math.floor(c.expirationDate)) : "0";
    const safeName = c.name.replace(/[\r\n\t]/g, "");
    const safeVal = c.value.replace(/[\r\n\t]/g, "");
    lines.push(
      `${prefix}${domainField}\t${includeSubdomains}\t${pathField}\t${secureField}\t${expField}\t${safeName}\t${safeVal}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Convert Unicode half-block QR output (`█`, `▀`, `▄`, ` `) from `zlib weread login`
 * into a crisp boolean QR pixel matrix for native SVG rendering.
 */
export function parseHalfBlockQrToMatrix(rawStdout: string): QrMatrix | null {
  const rawLines = rawStdout.replace(/\r\n/g, "\n").split("\n");
  const qrLines = rawLines.filter((l) => /[█▀▄]/.test(l));
  if (qrLines.length < 8) return null;

  // Trim uniform leading/trailing whitespace across all QR lines.
  let minCol = Infinity;
  let maxCol = 0;
  for (const line of qrLines) {
    const chars = Array.from(line);
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === "█" || ch === "▀" || ch === "▄") {
        if (i < minCol) minCol = i;
        if (i > maxCol) maxCol = i;
      }
    }
  }
  if (!Number.isFinite(minCol) || maxCol <= minCol) return null;

  const width = maxCol - minCol + 1;
  const rows: boolean[][] = [];

  for (const line of qrLines) {
    const chars = Array.from(line);
    const topRow: boolean[] = [];
    const bottomRow: boolean[] = [];
    for (let i = minCol; i <= maxCol; i++) {
      const ch = chars[i] ?? " ";
      topRow.push(ch === "█" || ch === "▀");
      bottomRow.push(ch === "█" || ch === "▄");
    }
    rows.push(topRow, bottomRow);
  }

  // Trim trailing all-white row if QR height is odd.
  while (rows.length > width && rows[rows.length - 1]?.every((cell) => !cell)) {
    rows.pop();
  }

  return {
    size: Math.max(width, rows.length),
    rows,
  };
}
