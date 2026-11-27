import { isStartPageUrl } from "./startPage";
import { normalizeDomainKey, type NormalizedCookie } from "./cookieCodec";

export interface RawPartitionCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
}

export type ZlibAuthSessionSelection =
  | {
      ok: true;
      origin: string;
      cookies: NormalizedCookie[];
      authKey: string;
      source: "active-tab" | "open-tab" | "preferred-domain" | "cookie-store";
    }
  | {
      ok: false;
      reason: "sso_redirect_pending" | "wrong_site" | "not_logged_in";
      message: string;
    };

const NON_ZLIB_ROOT_DOMAINS = [
  "weread.qq.com",
  "qq.com",
  "douban.com",
  "xiaohongshu.com",
  "xhscdn.com",
  "zhihu.com",
  "bilibili.com",
  "baidu.com",
  "google.com",
  "bing.com",
  "github.com",
  "apple.com",
  "icloud.com",
  "openlibrary.org",
  "goodreads.com",
  "deepl.com",
  "openai.com",
  "deepseek.com",
  "localhost",
  "127.0.0.1",
];

export function isNonZlibHost(rawHost: string): boolean {
  const host = normalizeDomainKey(rawHost);
  if (!host) return true;
  return NON_ZLIB_ROOT_DOMAINS.some((root) => host === root || host.endsWith(`.${root}`));
}

export function isSingleLoginPortalHost(rawHost: string): boolean {
  const host = normalizeDomainKey(rawHost);
  return /^(?:[a-z0-9-]+\.)?singlelogin\.[a-z0-9.-]+$/i.test(host);
}

export function looksLikeZlibHost(rawHost: string): boolean {
  const host = normalizeDomainKey(rawHost);
  if (!host || isNonZlibHost(host)) return false;
  return /z-lib|zlib|zlibrary|1lib|singlelogin|b-ok|booksc|articles\.sk/i.test(host);
}

/** Mirrors probed when the preferred one is unreachable; also trusted for zero-click auto-sync. */
export const KNOWN_ZLIB_MIRRORS: readonly string[] = [
  "https://z-library.sk",
  "https://z-lib.fm",
  "https://z-lib.gs",
  "https://z-lib.by",
  "https://1lib.sk",
];

function hostOfUrl(rawUrl: string): string {
  try {
    return normalizeDomainKey(new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`).hostname);
  } catch {
    return "";
  }
}

/**
 * Whether a host may be adopted as the Z-Library mirror without the user clicking anything:
 * a known mirror or the mirror the user already chose (or their subdomains), or — only while
 * the user is actively logging in — a host whose name looks like Z-Library. Anything else
 * (e.g. a phishing look-alike visited later) needs the manual sync button.
 */
export function isTrustedAutoSyncHost(
  rawHost: string,
  opts: { preferredUrl?: string; loginInProgress: boolean },
): boolean {
  const host = normalizeDomainKey(rawHost);
  if (!host || isNonZlibHost(host) || isSingleLoginPortalHost(host)) return false;
  const trustedRoots = [...KNOWN_ZLIB_MIRRORS, opts.preferredUrl ?? ""].map(hostOfUrl).filter(Boolean);
  if (trustedRoots.some((root) => host === root || host.endsWith(`.${root}`))) return true;
  return opts.loginInProgress && looksLikeZlibHost(host);
}

function parseHttpOrigin(rawUrl?: string): { origin: string; host: string } | null {
  if (!rawUrl || !rawUrl.trim()) return null;
  if (isStartPageUrl(rawUrl)) return null;
  try {
    const candidate = /^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`;
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const host = normalizeDomainKey(parsed.hostname);
    if (!host) return null;
    return { origin: `${parsed.protocol}//${parsed.host}`, host };
  } catch {
    return null;
  }
}

function isCookieUnexpired(cookie: RawPartitionCookie, nowMs: number): boolean {
  if (typeof cookie.expirationDate !== "number" || cookie.expirationDate <= 0) return true;
  return cookie.expirationDate * 1000 > nowMs - 60_000;
}

function isValidZlibCookieValue(value: string, minLen = 1): boolean {
  const v = value.trim();
  if (v.length < minLen) return false;
  const lower = v.toLowerCase();
  return lower !== "0" && lower !== "deleted" && lower !== "null" && lower !== "false";
}

export function extractZlibAuthPair(
  cookies: readonly NormalizedCookie[],
): { userId: string; userKey: string } | null {
  let userId = "";
  let userKey = "";
  for (const c of cookies) {
    if (c.name === "remix_userid" && isValidZlibCookieValue(c.value, 1)) {
      userId = c.value.trim();
    } else if (c.name === "remix_userkey" && isValidZlibCookieValue(c.value, 6)) {
      userKey = c.value.trim();
    }
  }
  return userId && userKey ? { userId, userKey } : null;
}

function collectCookiesForHost(
  allCookies: readonly RawPartitionCookie[],
  host: string,
  nowMs: number,
): NormalizedCookie[] {
  const matched: NormalizedCookie[] = [];
  for (const c of allCookies) {
    if (!isCookieUnexpired(c, nowMs)) continue;
    const dom = normalizeDomainKey(c.domain ?? "");
    if (!dom) continue;
    if (host === dom || host.endsWith(`.${dom}`)) {
      matched.push({
        name: c.name,
        value: c.value,
        domain: c.domain ?? host,
        path: c.path ?? "/",
        secure: Boolean(c.secure),
        httpOnly: Boolean(c.httpOnly),
        ...(c.expirationDate ? { expirationDate: c.expirationDate } : {}),
      });
    }
  }
  return matched;
}

/**
 * Resolve an authenticated Z-Library mirror session (`remix_userid` + `remix_userkey`)
 * from the active browser partition without ever leaking non-Z-Library site cookies
 * or getting tripped up by SingleLogin cross-domain redirects.
 */
export interface ZlibAuthSessionOptions {
  /** Extra host filter; zero-click auto-sync passes `isTrustedAutoSyncHost`. */
  isAllowedHost?: (host: string) => boolean;
  /** Fall back to scanning every cookie domain (manual sync only). Defaults to true. */
  scanCookieStore?: boolean;
}

export function selectZlibAuthSession(input: {
  allCookies: readonly RawPartitionCookie[];
  activeTabUrl?: string;
  openTabUrls?: readonly string[];
  preferredUrl?: string;
  nowMs?: number;
} & ZlibAuthSessionOptions): ZlibAuthSessionSelection {
  const nowMs = input.nowMs ?? Date.now();
  const isAllowedHost = input.isAllowedHost ?? (() => true);
  const tryCandidate = (
    rawUrl: string | undefined,
    source: "active-tab" | "open-tab" | "preferred-domain",
  ): Extract<ZlibAuthSessionSelection, { ok: true }> | null => {
    const parsed = parseHttpOrigin(rawUrl);
    if (!parsed) return null;
    if (isNonZlibHost(parsed.host) || isSingleLoginPortalHost(parsed.host)) return null;
    if (!isAllowedHost(parsed.host)) return null;
    const cookies = collectCookiesForHost(input.allCookies, parsed.host, nowMs);
    const pair = extractZlibAuthPair(cookies);
    if (!pair) return null;
    return {
      ok: true,
      origin: parsed.origin,
      cookies,
      authKey: `${parsed.origin}:${pair.userId}:${pair.userKey.slice(0, 10)}`,
      source,
    };
  };

  // 1. Active tab always wins when it already landed on an authenticated Z-Lib mirror (handles SingleLogin redirects).
  const fromActive = tryCandidate(input.activeTabUrl, "active-tab");
  if (fromActive) return fromActive;

  // 2. Check other open tabs in the same account partition (most recent last -> reverse).
  for (const tabUrl of [...(input.openTabUrls ?? [])].reverse()) {
    if (tabUrl === input.activeTabUrl) continue;
    const fromTab = tryCandidate(tabUrl, "open-tab");
    if (fromTab) return fromTab;
  }

  // 3. Check caller's preferred mirror domain if it holds valid Z-Lib auth cookies.
  const fromPreferred = tryCandidate(input.preferredUrl, "preferred-domain");
  if (fromPreferred) return fromPreferred;

  // 4. Scan partition cookie store for any authenticated Z-Lib mirror domain (newest expiry first).
  const candidateDomains = new Map<string, number>();
  for (const c of input.scanCookieStore === false ? [] : input.allCookies) {
    if (c.name !== "remix_userkey" || !isValidZlibCookieValue(c.value, 6) || !isCookieUnexpired(c, nowMs)) {
      continue;
    }
    const dom = normalizeDomainKey(c.domain ?? "");
    if (!dom || isNonZlibHost(dom) || isSingleLoginPortalHost(dom) || !isAllowedHost(dom)) continue;
    const exp = typeof c.expirationDate === "number" ? c.expirationDate : 0;
    const prev = candidateDomains.get(dom) ?? -1;
    if (exp > prev) candidateDomains.set(dom, exp);
  }

  const sortedDomains = [...candidateDomains.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([dom]) => dom);

  for (const dom of sortedDomains) {
    const cookies = collectCookiesForHost(input.allCookies, dom, nowMs);
    const pair = extractZlibAuthPair(cookies);
    if (pair) {
      const origin = `https://${dom}`;
      return {
        ok: true,
        origin,
        cookies,
        authKey: `${origin}:${pair.userId}:${pair.userKey.slice(0, 10)}`,
        source: "cookie-store",
      };
    }
  }

  // 5. No valid Z-Lib credentials found — return a precise, actionable explanation.
  const activeParsed = parseHttpOrigin(input.activeTabUrl);
  if (activeParsed && isSingleLoginPortalHost(activeParsed.host)) {
    return {
      ok: false,
      reason: "sso_redirect_pending",
      message: "右侧页面仍在登录跳转页（SingleLogin），请完成登录并等待页面进入 Z-Library 首页后再试。",
    };
  }

  if (!activeParsed || isNonZlibHost(activeParsed.host)) {
    return {
      ok: false,
      reason: "wrong_site",
      message: "右侧尚未打开或登录 Z-Library，请先点击「1. 右侧打开登录」并在右侧网页完成登录。",
    };
  }

  return {
    ok: false,
    reason: "not_logged_in",
    message: "尚未在右侧检测到 Z-Library 登录状态，请先在右侧网页输入账号密码完成登录（如遇验证请先点击通过）。",
  };
}
