import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedCookie } from "../electron/browser/cookieCodec";
import {
  isTrustedAutoSyncHost,
  selectZlibAuthSession,
  type ZlibAuthSessionOptions,
  type ZlibAuthSessionSelection,
} from "../electron/browser/zlibAuthSession";
import { ZlibAutoSync, type ZlibAutoSyncDeps } from "../electron/router/zlibAutoSync";
import { ZlibCliService, type ConnectionsSnapshot } from "../electron/router/zlibCliService";

const NOW = 1_760_000_000_000;
const FUTURE_EXP = Math.floor(NOW / 1000) + 86_400 * 30;

function snapshot(loggedIn: boolean): ConnectionsSnapshot {
  return {
    status: { installed: true } as ConnectionsSnapshot["status"],
    zlib: { loggedIn, userName: "", dailyRemaining: null, dailyAllowed: null, currentDomain: "" },
    weread: { loggedIn: false, name: "", vid: "" },
    kindle: { configured: false, to: "", from: "", smtpHost: "", smtpPort: "", smtpSecurity: "" },
  };
}

const MIRROR_SESSION: ZlibAuthSessionSelection = {
  ok: true,
  origin: "https://zh.z-library.sk",
  cookies: [{ name: "remix_userkey", value: "k", domain: ".z-library.sk", path: "/", secure: true, httpOnly: true }],
  authKey: "https://zh.z-library.sk:1:k",
  source: "active-tab",
};

function harness(overrides: Partial<ZlibAutoSyncDeps> = {}) {
  let paused = false;
  let now = NOW;
  const findSession = vi.fn(async (_url: string, _opts: ZlibAuthSessionOptions) => MIRROR_SESSION);
  const login = vi.fn(async (_cookies: NormalizedCookie[], _origin: string) => snapshot(true));
  const fetchSnapshot = vi.fn(async () => snapshot(false));
  const onSynced = vi.fn();
  const writePaused = vi.fn((value: boolean) => {
    paused = value;
  });
  const sync = new ZlibAutoSync({
    findSession,
    login,
    fetchSnapshot,
    getPreferredDomain: () => "https://z-lib.by",
    readPaused: () => paused,
    writePaused,
    onSynced,
    now: () => now,
    debounceMs: 10,
    ...overrides,
  });
  return {
    sync,
    findSession,
    login,
    fetchSnapshot,
    onSynced,
    writePaused,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("Z-Library zero-click auto-sync", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("syncs a trusted mirror once the CLI is known to be logged out", async () => {
    const h = harness();
    await h.sync.run("https://zh.z-library.sk/");
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(h.login).toHaveBeenCalledWith(MIRROR_SESSION.cookies, "https://zh.z-library.sk");
    expect(h.onSynced).toHaveBeenCalledTimes(1);
    expect(h.findSession.mock.calls[0]?.[1].scanCookieStore).toBe(false);
  });

  it("stays logged out after an explicit logout until the user starts a login again", async () => {
    const h = harness();
    h.sync.noteSnapshot(snapshot(true));
    h.sync.noteLogout();
    expect(h.writePaused).toHaveBeenLastCalledWith(true);

    await h.sync.run("https://zh.z-library.sk/");
    expect(h.login).not.toHaveBeenCalled();

    h.sync.beginLoginWatch();
    expect(h.writePaused).toHaveBeenLastCalledWith(false);
    await h.sync.run("https://zh.z-library.sk/");
    expect(h.login).toHaveBeenCalledTimes(1);
  });

  it("keeps the logout pause across restarts", async () => {
    const h = harness({ readPaused: () => true });
    await h.sync.run("https://zh.z-library.sk/");
    expect(h.findSession).not.toHaveBeenCalled();
    expect(h.login).not.toHaveBeenCalled();
  });

  it("does not re-login when the CLI turns out to be logged in already", async () => {
    const h = harness({ fetchSnapshot: async () => snapshot(true) });
    await h.sync.run("https://zh.z-library.sk/");
    expect(h.login).not.toHaveBeenCalled();
  });

  it("only trusts look-alike hosts while the user is logging in", async () => {
    const h = harness();
    h.sync.noteSnapshot(snapshot(false));
    await h.sync.run("https://zlib-mirror.example/");
    expect(h.findSession).not.toHaveBeenCalled();

    h.sync.beginLoginWatch();
    await h.sync.run("https://zlib-mirror.example/");
    expect(h.findSession).toHaveBeenCalledTimes(1);

    h.advance(16 * 60_000);
    h.sync.noteLogout();
    h.sync.beginLoginWatch();
    h.advance(16 * 60_000);
    await h.sync.run("https://zlib-mirror.example/");
    expect(h.findSession).toHaveBeenCalledTimes(1);
  });

  it("does not retry the same failing credentials on every page load", async () => {
    const login = vi.fn(async () => {
      throw new Error("login failed");
    });
    const h = harness({ login });
    h.sync.noteSnapshot(snapshot(false));
    await h.sync.run("https://zh.z-library.sk/");
    await h.sync.run("https://zh.z-library.sk/book/1");
    expect(login).toHaveBeenCalledTimes(1);

    h.sync.beginLoginWatch();
    await h.sync.run("https://zh.z-library.sk/");
    expect(login).toHaveBeenCalledTimes(2);
  });

  it("debounces page-settle events and ignores pages while logged in", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.sync.noteSnapshot(snapshot(false));
    h.sync.onPageSettled("https://zh.z-library.sk/a");
    h.sync.onPageSettled("https://zh.z-library.sk/b");
    await vi.advanceTimersByTimeAsync(20);
    expect(h.findSession).toHaveBeenCalledTimes(1);
    expect(h.findSession.mock.calls[0]?.[0]).toBe("https://zh.z-library.sk/b");

    h.sync.onPageSettled("https://zh.z-library.sk/c");
    await vi.advanceTimersByTimeAsync(20);
    expect(h.findSession).toHaveBeenCalledTimes(1);
  });
});

describe("auto-sync host trust", () => {
  it("trusts known mirrors and the chosen mirror (with subdomains), never other sites", () => {
    const idle = { preferredUrl: "https://my-mirror.example.org", loginInProgress: false };
    expect(isTrustedAutoSyncHost("zh.z-library.sk", idle)).toBe(true);
    expect(isTrustedAutoSyncHost("z-lib.fm", idle)).toBe(true);
    expect(isTrustedAutoSyncHost("books.my-mirror.example.org", idle)).toBe(true);
    expect(isTrustedAutoSyncHost("www.example.org", idle)).toBe(false);
    expect(isTrustedAutoSyncHost("other.example.org", idle)).toBe(false);
    expect(isTrustedAutoSyncHost("evil-z-lib.fm.example", idle)).toBe(false);
    expect(isTrustedAutoSyncHost("z-library-login.example", idle)).toBe(false);
    expect(isTrustedAutoSyncHost("z-library-login.example", { ...idle, loginInProgress: true })).toBe(true);
    expect(isTrustedAutoSyncHost("weread.qq.com", { ...idle, loginInProgress: true })).toBe(false);
    expect(isTrustedAutoSyncHost("singlelogin.re", { ...idle, loginInProgress: true })).toBe(false);
    expect(isTrustedAutoSyncHost("mirror.my-mirror.org", { preferredUrl: "https://my-mirror.org", loginInProgress: false })).toBe(true);
  });

  it("auto mode skips untrusted tabs and the cookie-store scan; manual mode keeps both", () => {
    const allCookies = [
      { name: "remix_userid", value: "7", domain: ".fake-zlib.example", expirationDate: FUTURE_EXP },
      { name: "remix_userkey", value: "phish_key_123", domain: ".fake-zlib.example", expirationDate: FUTURE_EXP },
    ];
    const manual = selectZlibAuthSession({ nowMs: NOW, allCookies, activeTabUrl: "https://fake-zlib.example/" });
    expect(manual.ok).toBe(true);

    const auto = selectZlibAuthSession({
      nowMs: NOW,
      allCookies,
      activeTabUrl: "https://fake-zlib.example/",
      isAllowedHost: (host) => isTrustedAutoSyncHost(host, { loginInProgress: false }),
      scanCookieStore: false,
    });
    expect(auto.ok).toBe(false);
  });
});

describe("login mirror resolution", () => {
  it("probes through the injected (browser) network path", async () => {
    const service = new ZlibCliService("/tmp/diandian-test-downloads");
    service.setPreferredDomain("https://z-lib.by");
    vi.spyOn(service, "listHealthyDomains").mockResolvedValue([]);

    const up = await service.resolveLoginMirrorUrl(undefined, async () => true);
    expect(up).toEqual({ url: "https://z-lib.by", reachable: true, switched: false });

    const switched = await service.resolveLoginMirrorUrl(undefined, async (url) => url === "https://z-lib.fm");
    expect(switched).toEqual({ url: "https://z-lib.fm", reachable: true, switched: true });

    const down = await service.resolveLoginMirrorUrl(undefined, async () => false);
    expect(down).toEqual({ url: "https://z-lib.by", reachable: false, switched: false });
  });

  it("only adopts a `zlib doctor` pick that the browser can reach", async () => {
    const service = new ZlibCliService("/tmp/diandian-test-downloads");
    service.setPreferredDomain("https://z-lib.by");
    vi.spyOn(service, "listHealthyDomains").mockResolvedValue([
      { domain: "https://new-mirror.example", status: "healthy", httpStatus: 200 },
    ]);
    const unreachable = await service.resolveLoginMirrorUrl(undefined, async () => false);
    expect(unreachable.url).toBe("https://z-lib.by");
    expect(unreachable.reachable).toBe(false);

    const reachable = await service.resolveLoginMirrorUrl(undefined, async (url) => url === "https://new-mirror.example");
    expect(reachable).toEqual({ url: "https://new-mirror.example", reachable: true, switched: true });
  });
});

describe("Z-Library login redirect & domain safety", () => {
  it("follows SingleLogin redirect to the authenticated mirror instead of stale preferredDomain", () => {
    const res = selectZlibAuthSession({
      nowMs: NOW,
      preferredUrl: "https://z-lib.by",
      activeTabUrl: "https://zh.z-library.sk/",
      allCookies: [
        { name: "wr_skey", value: "weread_tok", domain: ".weread.qq.com", expirationDate: FUTURE_EXP },
        { name: "remix_userid", value: "40119657", domain: ".singlelogin.re", expirationDate: FUTURE_EXP },
        { name: "remix_userkey", value: "sso_key_abcdef", domain: ".singlelogin.re", expirationDate: FUTURE_EXP },
        { name: "remix_userid", value: "40119657", domain: ".z-library.sk", expirationDate: FUTURE_EXP },
        { name: "remix_userkey", value: "mirror_key_987654", domain: ".z-library.sk", expirationDate: FUTURE_EXP },
      ],
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.origin).toBe("https://zh.z-library.sk");
      expect(res.source).toBe("active-tab");
      expect(res.cookies.some((c) => c.name === "remix_userkey" && c.value === "mirror_key_987654")).toBe(true);
      expect(res.cookies.some((c) => c.domain.includes("weread.qq.com"))).toBe(false);
    }
  });

  it("refuses to export WeRead or Douban cookies when Z-Library is not logged in", () => {
    const res = selectZlibAuthSession({
      nowMs: NOW,
      activeTabUrl: "https://weread.qq.com/web/shelf",
      allCookies: [
        { name: "wr_vid", value: "123456", domain: ".weread.qq.com", expirationDate: FUTURE_EXP },
        { name: "wr_skey", value: "secret", domain: ".weread.qq.com", expirationDate: FUTURE_EXP },
      ],
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("wrong_site");
      expect(res.message).toContain("右侧打开登录");
    }
  });

  it("reports SingleLogin redirect in progress when mirror cookies have not landed yet", () => {
    const res = selectZlibAuthSession({
      nowMs: NOW,
      activeTabUrl: "https://singlelogin.re/",
      allCookies: [
        { name: "remix_userid", value: "40119657", domain: ".singlelogin.re", expirationDate: FUTURE_EXP },
        { name: "remix_userkey", value: "sso_key_abcdef", domain: ".singlelogin.re", expirationDate: FUTURE_EXP },
      ],
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("sso_redirect_pending");
      expect(res.message).toContain("SingleLogin");
    }
  });

  it("recovers authenticated Z-Library mirror from partition cookie store even if active tab returned to WeRead", () => {
    const res = selectZlibAuthSession({
      nowMs: NOW,
      preferredUrl: "https://z-lib.by",
      activeTabUrl: "https://weread.qq.com/web/reader/123",
      allCookies: [
        { name: "remix_userid", value: "0", domain: ".z-lib.by", expirationDate: FUTURE_EXP },
        { name: "remix_userkey", value: "deleted", domain: ".z-lib.by", expirationDate: FUTURE_EXP },
        { name: "remix_userid", value: "889900", domain: ".z-lib.fm", expirationDate: FUTURE_EXP },
        { name: "remix_userkey", value: "valid_fm_key_12345", domain: ".z-lib.fm", expirationDate: FUTURE_EXP },
      ],
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.origin).toBe("https://z-lib.fm");
      expect(res.source).toBe("cookie-store");
    }
  });
});
