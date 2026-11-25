import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { normalizeDomainKey, type NormalizedCookie } from "./cookieCodec";

const execFileAsync = promisify(execFile);

export type SupportedBrowserId =
  | "chrome"
  | "arc"
  | "brave"
  | "edge"
  | "dia"
  | "chromium"
  | "vivaldi"
  | "firefox";

export type ReadingSiteGroupId = "weread" | "douban" | "xiaohongshu" | "wechat_mp" | "zlib" | "other";

export interface ReadingSiteGroupSummary {
  id: ReadingSiteGroupId;
  label: string;
  subtitle: string;
  cookieCount: number;
  domainCount: number;
  defaultEnabled: boolean;
}

export interface PublicLocalBrowserProfile {
  id: string;
  browserId: SupportedBrowserId;
  browserName: string;
  profileName: string;
  profileEmail?: string;
  requiresKeychain: boolean;
}

interface InternalBrowserProfile extends PublicLocalBrowserProfile {
  cookieDbPath: string;
  engine: "chromium" | "firefox";
  keychainService?: string;
  keychainAccount?: string;
}

interface ChromiumSpec {
  browserId: Exclude<SupportedBrowserId, "firefox">;
  browserName: string;
  relDataDir: string;
  keychainService: string;
  keychainAccount: string;
}

const MAC_CHROMIUM_SPECS: ChromiumSpec[] = [
  {
    browserId: "chrome",
    browserName: "Google Chrome",
    relDataDir: path.join("Google", "Chrome"),
    keychainService: "Chrome Safe Storage",
    keychainAccount: "Chrome",
  },
  {
    browserId: "arc",
    browserName: "Arc",
    relDataDir: path.join("Arc", "User Data"),
    keychainService: "Arc Safe Storage",
    keychainAccount: "Arc",
  },
  {
    browserId: "brave",
    browserName: "Brave",
    relDataDir: path.join("BraveSoftware", "Brave-Browser"),
    keychainService: "Brave Safe Storage",
    keychainAccount: "Brave",
  },
  {
    browserId: "edge",
    browserName: "Microsoft Edge",
    relDataDir: "Microsoft Edge",
    keychainService: "Microsoft Edge Safe Storage",
    keychainAccount: "Microsoft Edge",
  },
  {
    browserId: "dia",
    browserName: "Dia",
    relDataDir: path.join("Dia", "User Data"),
    keychainService: "Dia Safe Storage",
    keychainAccount: "Dia",
  },
  {
    browserId: "vivaldi",
    browserName: "Vivaldi",
    relDataDir: "Vivaldi",
    keychainService: "Vivaldi Safe Storage",
    keychainAccount: "Vivaldi",
  },
  {
    browserId: "chromium",
    browserName: "Chromium",
    relDataDir: "Chromium",
    keychainService: "Chromium Safe Storage",
    keychainAccount: "Chromium",
  },
];

const SITE_GROUPS: Array<{
  id: Exclude<ReadingSiteGroupId, "other">;
  label: string;
  subtitle: string;
  patterns: RegExp[];
}> = [
  {
    id: "weread",
    label: "微信读书",
    subtitle: "weread.qq.com",
    patterns: [/(^|\.)weread\.qq\.com$/i],
  },
  {
    id: "douban",
    label: "豆瓣读书",
    subtitle: "douban.com",
    patterns: [/(^|\.)douban\.com$/i],
  },
  {
    id: "xiaohongshu",
    label: "小红书创作",
    subtitle: "xiaohongshu.com",
    patterns: [/(^|\.)xiaohongshu\.com$/i],
  },
  {
    id: "wechat_mp",
    label: "微信公众号",
    subtitle: "mp.weixin.qq.com",
    patterns: [/(^|\.)mp\.weixin\.qq\.com$/i, /(^|\.)weixin\.qq\.com$/i],
  },
  {
    id: "zlib",
    label: "Z-Library 书源",
    subtitle: "z-lib / singlelogin",
    patterns: [
      /(^|\.)z-lib\./i,
      /(^|\.)z-library\./i,
      /(^|\.)zlib\./i,
      /(^|\.)singlelogin\./i,
      /(^|\.)1lib\./i,
      /(^|\.)article\.sk$/i,
    ],
  },
];

export function classifyCookieDomain(rawDomain: string): ReadingSiteGroupId {
  const clean = normalizeDomainKey(rawDomain);
  if (!clean) return "other";
  for (const g of SITE_GROUPS) {
    if (g.patterns.some((re) => re.test(clean))) {
      return g.id;
    }
  }
  return "other";
}

/**
 * Derive Chromium macOS v10 AES-128-CBC key via PBKDF2-HMAC-SHA1 (1003 iterations, salt "saltysalt").
 */
export function deriveChromiumMacAesKey(keychainPassword: string): Buffer {
  return crypto.pbkdf2Sync(keychainPassword, "saltysalt", 1003, 16, "sha1");
}

/**
 * Decrypt a single Chromium macOS `v10` encrypted cookie buffer.
 * Automatically handles Chrome 130+ (DB meta version >= 24) 32-byte SHA-256(host_key) prefix.
 */
export function decryptChromiumMacCookieValue(
  encrypted: Uint8Array,
  aesKey: Buffer,
  hostKey: string,
  dbVersion = 24,
): string | null {
  if (!encrypted || encrypted.length <= 3) return null;
  // Standard macOS Chromium prefix is ASCII "v10" (0x76, 0x31, 0x30)
  if (encrypted[0] !== 0x76 || encrypted[1] !== 0x31 || encrypted[2] !== 0x30) {
    return null;
  }
  try {
    const iv = Buffer.alloc(16, 0x20);
    const decipher = crypto.createDecipheriv("aes-128-cbc", aesKey, iv);
    let plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);

    // Chrome 130+ prepends SHA-256(host_key) (32 bytes) inside the encrypted value.
    if (plain.length >= 32) {
      const hostHash = crypto.createHash("sha256").update(hostKey, "utf8").digest();
      if (plain.subarray(0, 32).equals(hostHash)) {
        plain = plain.subarray(32);
      } else if (dbVersion >= 24) {
        // Fallback when host_key casing differs or leading dot normalized differently
        const altHost = hostKey.startsWith(".") ? hostKey.slice(1) : `.${hostKey}`;
        const altHash = crypto.createHash("sha256").update(altHost, "utf8").digest();
        if (plain.subarray(0, 32).equals(altHash)) {
          plain = plain.subarray(32);
        }
      }
    }
    return plain.toString("utf8");
  } catch {
    return null;
  }
}

const MAX_SAFE_COOKIE_UNIX_SEC = 253_402_300_799n; // 9999-12-31T23:59:59Z

export function chromiumMicrosToUnixSeconds(raw: bigint | number | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  let micros: bigint;
  if (typeof raw === "bigint") {
    micros = raw;
  } else if (typeof raw === "number" && Number.isFinite(raw)) {
    micros = BigInt(Math.trunc(raw));
  } else {
    return undefined;
  }
  if (micros <= 0n) return undefined;
  const unix = micros / 1_000_000n - 11_644_473_600n;
  if (unix <= 0n) return undefined;
  return Number(unix > MAX_SAFE_COOKIE_UNIX_SEC ? MAX_SAFE_COOKIE_UNIX_SEC : unix);
}

function normalizeFirefoxExpirySeconds(raw: bigint | number | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const val = typeof raw === "bigint" ? raw : Number.isFinite(raw) ? BigInt(Math.trunc(raw)) : 0n;
  if (val <= 0n) return undefined;
  const sec = val > 10_000_000_000_000n ? val / 1000n : val;
  return Number(sec > MAX_SAFE_COOKIE_UNIX_SEC ? MAX_SAFE_COOKIE_UNIX_SEC : sec);
}

function mapChromiumSameSite(raw: unknown): NormalizedCookie["sameSite"] {
  const n = Number(raw);
  if (n === 0) return "no_restriction";
  if (n === 1) return "lax";
  if (n === 2) return "strict";
  return "unspecified";
}

function findChromiumCookieDb(profileDir: string): string | null {
  const candidates = [
    path.join(profileDir, "Cookies"),
    path.join(profileDir, "Network", "Cookies"),
  ];
  for (const p of candidates) {
    try {
      if (fs.lstatSync(p).isFile()) return p;
    } catch {
      // Continue
    }
  }
  return null;
}

function discoverMacChromiumProfiles(appSupportDir: string): InternalBrowserProfile[] {
  const out: InternalBrowserProfile[] = [];
  for (const spec of MAC_CHROMIUM_SPECS) {
    const userDataDir = path.join(appSupportDir, spec.relDataDir);
    if (!fs.existsSync(userDataDir)) continue;

    let infoCache: Record<string, Record<string, unknown>> = {};
    const localStatePath = path.join(userDataDir, "Local State");
    try {
      const parsed = JSON.parse(fs.readFileSync(localStatePath, "utf8")) as {
        profile?: { info_cache?: Record<string, Record<string, unknown>> };
      };
      if (parsed?.profile?.info_cache && typeof parsed.profile.info_cache === "object") {
        infoCache = parsed.profile.info_cache;
      }
    } catch {
      // Fall back to directory scan if Local State is missing
    }

    const dirNames = new Set<string>(Object.keys(infoCache));
    if (dirNames.size === 0) {
      try {
        for (const ent of fs.readdirSync(userDataDir, { withFileTypes: true })) {
          if (ent.isDirectory() && (ent.name === "Default" || /^Profile \d+$/i.test(ent.name))) {
            dirNames.add(ent.name);
          }
        }
      } catch {
        // Ignore unreadable dir
      }
    }

    // Order Default first, then alphabetically by friendly name
    const discovered: InternalBrowserProfile[] = [];
    for (const dirName of dirNames) {
      const profileDir = path.join(userDataDir, dirName);
      const cookieDbPath = findChromiumCookieDb(profileDir);
      if (!cookieDbPath) continue;

      const meta = infoCache[dirName] ?? {};
      const rawName = String(meta.name ?? meta.gaia_given_name ?? meta.shortcut_name ?? dirName).trim();
      const email = String(meta.user_name ?? "").trim();
      const profileName = rawName || (dirName === "Default" ? "默认配置" : dirName);

      discovered.push({
        id: `${spec.browserId}:${dirName}`,
        browserId: spec.browserId,
        browserName: spec.browserName,
        profileName,
        ...(email && email !== profileName ? { profileEmail: email } : {}),
        requiresKeychain: true,
        cookieDbPath,
        engine: "chromium",
        keychainService: spec.keychainService,
        keychainAccount: spec.keychainAccount,
      });
    }

    discovered.sort((a, b) => {
      const aDefault = a.id.endsWith(":Default") ? 0 : 1;
      const bDefault = b.id.endsWith(":Default") ? 0 : 1;
      if (aDefault !== bDefault) return aDefault - bDefault;
      return a.profileName.localeCompare(b.profileName);
    });
    out.push(...discovered);
  }
  return out;
}

function discoverMacFirefoxProfiles(appSupportDir: string): InternalBrowserProfile[] {
  const firefoxDir = path.join(appSupportDir, "Firefox");
  const profilesIni = path.join(firefoxDir, "profiles.ini");
  if (!fs.existsSync(profilesIni)) return [];

  const out: InternalBrowserProfile[] = [];
  try {
    const raw = fs.readFileSync(profilesIni, "utf8");
    const sections = raw.split(/\r?\n(?=\[)/);
    for (const sec of sections) {
      if (!/^\[Profile\d+\]/i.test(sec.trim())) continue;
      const nameMatch = /^Name=(.+)$/m.exec(sec);
      const pathMatch = /^Path=(.+)$/m.exec(sec);
      const relMatch = /^IsRelative=(\d)$/m.exec(sec);
      if (!pathMatch?.[1]) continue;
      const relPath = pathMatch[1].trim();
      const isRelative = relMatch ? relMatch[1] === "1" : true;
      const profileDir = isRelative ? path.join(firefoxDir, relPath) : relPath;
      const cookieDbPath = path.join(profileDir, "cookies.sqlite");
      try {
        if (!fs.lstatSync(cookieDbPath).isFile()) continue;
      } catch {
        continue;
      }
      const profileName = nameMatch?.[1]?.trim() || path.basename(profileDir);
      out.push({
        id: `firefox:${path.basename(profileDir)}`,
        browserId: "firefox",
        browserName: "Firefox",
        profileName,
        requiresKeychain: false,
        cookieDbPath,
        engine: "firefox",
      });
    }
  } catch {
    // Ignore malformed profiles.ini
  }
  return out;
}

function discoverAllProfiles(): InternalBrowserProfile[] {
  if (process.platform !== "darwin") {
    return [];
  }
  const appSupportDir = path.join(os.homedir(), "Library", "Application Support");
  return [
    ...discoverMacChromiumProfiles(appSupportDir),
    ...discoverMacFirefoxProfiles(appSupportDir),
  ];
}

function withTempSqliteCopy<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "diandian-cookie-db-"));
  try {
    const tmpDb = path.join(tmpDir, "Cookies.sqlite");
    fs.copyFileSync(dbPath, tmpDb);
    fs.chmodSync(tmpDb, 0o600);
    // Copy WAL/SHM sidecar files if present so recently written cookies are visible even while browser is open
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${dbPath}${suffix}`;
      if (fs.existsSync(sidecar)) {
        try {
          fs.copyFileSync(sidecar, `${tmpDb}${suffix}`);
          fs.chmodSync(`${tmpDb}${suffix}`, 0o600);
        } catch {
          // Non-fatal if sidecar vanished mid-copy
        }
      }
    }
    const db = new DatabaseSync(tmpDb, { readOnly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore temp cleanup failure
    }
  }
}

async function readMacKeychainPassword(service: string, account: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", service, "-a", account],
      { timeout: 60_000 },
    );
    const secret = stdout.trim();
    if (!secret) throw new Error("钥匙串返回为空");
    return secret;
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    const detail = (err.stderr || err.message || "").trim();
    if (/User canceled|denied|errSecAuthFailed|-128/i.test(detail)) {
      throw new Error("你取消了 macOS 钥匙串授权，未读取浏览器 Cookie。");
    }
    throw new Error(
      `无法从 macOS 钥匙串获取「${service}」解密授权（请在系统弹窗点击「允许」，或改用下方手动文件导入）。`,
    );
  }
}

export function listLocalBrowserProfiles(): PublicLocalBrowserProfile[] {
  return discoverAllProfiles().map(({ id, browserId, browserName, profileName, profileEmail, requiresKeychain }) => ({
    id,
    browserId,
    browserName,
    profileName,
    ...(profileEmail ? { profileEmail } : {}),
    requiresKeychain,
  }));
}

/**
 * Inspect plaintext host_key counts for a browser profile WITHOUT triggering macOS Keychain.
 */
export function inspectLocalBrowserProfile(profileId: string): {
  profile: PublicLocalBrowserProfile;
  groups: ReadingSiteGroupSummary[];
  totalCookies: number;
} {
  const profile = discoverAllProfiles().find((p) => p.id === profileId);
  if (!profile) {
    throw new Error("未找到对应的本机浏览器配置文件，请刷新后重试");
  }

  const countsByGroup = new Map<ReadingSiteGroupId, { cookies: number; domains: Set<string> }>();
  for (const g of SITE_GROUPS) {
    countsByGroup.set(g.id, { cookies: 0, domains: new Set() });
  }
  countsByGroup.set("other", { cookies: 0, domains: new Set() });

  let totalCookies = 0;

  withTempSqliteCopy(profile.cookieDbPath, (db) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const nowChromiumMicros = BigInt(nowSec + 11_644_473_600) * 1_000_000n;
    const stmt =
      profile.engine === "chromium"
        ? db.prepare(
            "SELECT host_key AS host, COUNT(*) AS cnt FROM cookies WHERE expires_utc = 0 OR expires_utc > ? GROUP BY host_key",
          )
        : db.prepare(
            "SELECT host AS host, COUNT(*) AS cnt FROM moz_cookies WHERE expiry = 0 OR expiry > ? GROUP BY host",
          );
    const rows = stmt.all(
      profile.engine === "chromium" ? nowChromiumMicros : nowSec,
    ) as Array<{ host?: string; cnt?: number | bigint }>;
    for (const row of rows) {
      const host = String(row.host ?? "").trim();
      const cnt = Number(row.cnt ?? 0);
      if (!host || cnt <= 0) continue;
      totalCookies += cnt;
      const groupId = classifyCookieDomain(host);
      const bucket = countsByGroup.get(groupId)!;
      bucket.cookies += cnt;
      bucket.domains.add(normalizeDomainKey(host));
    }
  });

  const groups: ReadingSiteGroupSummary[] = [
    ...SITE_GROUPS.map((g) => {
      const b = countsByGroup.get(g.id)!;
      return {
        id: g.id,
        label: g.label,
        subtitle: g.subtitle,
        cookieCount: b.cookies,
        domainCount: b.domains.size,
        defaultEnabled: b.cookies > 0,
      };
    }),
    {
      id: "other" as const,
      label: "其他全部站点",
      subtitle: "将浏览器中其余网站的登录态一并迁入",
      cookieCount: countsByGroup.get("other")!.cookies,
      domainCount: countsByGroup.get("other")!.domains.size,
      defaultEnabled: false,
    },
  ];

  return {
    profile: {
      id: profile.id,
      browserId: profile.browserId,
      browserName: profile.browserName,
      profileName: profile.profileName,
      ...(profile.profileEmail ? { profileEmail: profile.profileEmail } : {}),
      requiresKeychain: profile.requiresKeychain,
    },
    groups,
    totalCookies,
  };
}

/**
 * Extract & decrypt cookies for ONLY the user-selected site groups from a local browser profile.
 * Runs exclusively in Electron Main Process; raw cookie values are never sent to renderer or LLM.
 */
export async function extractLocalBrowserCookies(
  profileId: string,
  selectedGroups: ReadingSiteGroupId[],
): Promise<{
  profile: PublicLocalBrowserProfile;
  cookies: NormalizedCookie[];
  domains: string[];
}> {
  const profile = discoverAllProfiles().find((p) => p.id === profileId);
  if (!profile) {
    throw new Error("未找到对应的本机浏览器配置文件");
  }
  const groupSet = new Set<ReadingSiteGroupId>(selectedGroups);
  if (groupSet.size === 0) {
    throw new Error("请至少开启一个要导入的站点分组");
  }

  let aesKey: Buffer | null = null;
  if (profile.engine === "chromium") {
    const service = profile.keychainService || "Chrome Safe Storage";
    const account = profile.keychainAccount || "Chrome";
    const password = await readMacKeychainPassword(service, account);
    aesKey = deriveChromiumMacAesKey(password);
  }

  const out: NormalizedCookie[] = [];
  const touchedDomains = new Set<string>();
  const nowSec = Math.floor(Date.now() / 1000);

  try {
    withTempSqliteCopy(profile.cookieDbPath, (db) => {
      if (profile.engine === "chromium") {
        let dbVersion = 24;
        try {
          const metaRow = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string } | undefined;
          const parsedVer = Number(metaRow?.value);
          if (Number.isFinite(parsedVer) && parsedVer > 0) dbVersion = parsedVer;
        } catch {
          // Default to 24
        }

        const stmt = db.prepare(
          "SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies",
        );
        // Chromium stores 64-bit expires_utc microseconds (> Number.MAX_SAFE_INTEGER)
        stmt.setReadBigInts(true);
        const rows = stmt.all() as Array<{
          host_key?: string;
          name?: string;
          value?: string;
          encrypted_value?: Uint8Array | null;
          path?: string;
          expires_utc?: bigint | number;
          is_secure?: bigint | number;
          is_httponly?: bigint | number;
          samesite?: bigint | number;
        }>;

        for (const row of rows) {
          const host = String(row.host_key ?? "").trim();
          const name = String(row.name ?? "").trim();
          if (!host || !name) continue;
          if (!groupSet.has(classifyCookieDomain(host))) continue;

          const exp = chromiumMicrosToUnixSeconds(row.expires_utc);
          if (exp !== undefined && exp < nowSec) continue;

          let value = String(row.value ?? "");
          if (!value && row.encrypted_value && row.encrypted_value.length > 0 && aesKey) {
            const decrypted = decryptChromiumMacCookieValue(row.encrypted_value, aesKey, host, dbVersion);
            if (decrypted === null) continue;
            value = decrypted;
          }
          if (!value) continue;

          const cookiePath = String(row.path ?? "/").trim() || "/";
          out.push({
            name,
            value,
            domain: host,
            path: cookiePath.startsWith("/") ? cookiePath : `/${cookiePath}`,
            secure: Number(row.is_secure ?? 0) === 1,
            httpOnly: Number(row.is_httponly ?? 0) === 1,
            sameSite: mapChromiumSameSite(row.samesite),
            ...(exp ? { expirationDate: exp } : {}),
          });
          touchedDomains.add(normalizeDomainKey(host));
        }
      } else {
        const stmt = db.prepare(
          "SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies",
        );
        stmt.setReadBigInts(true);
        const rows = stmt.all() as Array<{
          host?: string;
          name?: string;
          value?: string;
          path?: string;
          expiry?: bigint | number;
          isSecure?: bigint | number;
          isHttpOnly?: bigint | number;
          sameSite?: bigint | number;
        }>;

        for (const row of rows) {
          const host = String(row.host ?? "").trim();
          const name = String(row.name ?? "").trim();
          const value = String(row.value ?? "");
          if (!host || !name || !value) continue;
          if (!groupSet.has(classifyCookieDomain(host))) continue;

          const exp = normalizeFirefoxExpirySeconds(row.expiry);
          if (exp !== undefined && exp < nowSec) continue;

          const cookiePath = String(row.path ?? "/").trim() || "/";
          out.push({
            name,
            value,
            domain: host,
            path: cookiePath.startsWith("/") ? cookiePath : `/${cookiePath}`,
            secure: Number(row.isSecure ?? 0) === 1,
            httpOnly: Number(row.isHttpOnly ?? 0) === 1,
            sameSite: mapChromiumSameSite(row.sameSite),
            ...(exp ? { expirationDate: exp } : {}),
          });
          touchedDomains.add(normalizeDomainKey(host));
        }
      }
    });
  } finally {
    // Zero out derived AES key in memory immediately
    if (aesKey) aesKey.fill(0);
  }

  return {
    profile: {
      id: profile.id,
      browserId: profile.browserId,
      browserName: profile.browserName,
      profileName: profile.profileName,
      ...(profile.profileEmail ? { profileEmail: profile.profileEmail } : {}),
      requiresKeychain: profile.requiresKeychain,
    },
    cookies: out,
    domains: [...touchedDomains],
  };
}
