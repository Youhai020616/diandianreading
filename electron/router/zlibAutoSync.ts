import type { NormalizedCookie } from "../browser/cookieCodec";
import {
  isTrustedAutoSyncHost,
  type ZlibAuthSessionOptions,
  type ZlibAuthSessionSelection,
} from "../browser/zlibAuthSession";
import type { ConnectionsSnapshot } from "./zlibTypes";

/** Setting key: "1" after an explicit Z-Library logout, cleared when the user logs in again. */
export const ZLIB_AUTO_SYNC_PAUSED_KEY = "router.zlibAutoSyncPaused";

const LOGIN_WATCH_MS = 15 * 60_000;

export interface ZlibAutoSyncDeps {
  findSession(preferredUrl: string, options: ZlibAuthSessionOptions): Promise<ZlibAuthSessionSelection>;
  login(cookies: NormalizedCookie[], origin: string): Promise<ConnectionsSnapshot>;
  fetchSnapshot(): Promise<ConnectionsSnapshot>;
  getPreferredDomain(): string;
  /** Persisted so an explicit logout survives restarts. */
  readPaused(): boolean;
  writePaused(paused: boolean): void;
  onSynced(snapshot: ConnectionsSnapshot, origin: string): void;
  now?: () => number;
  debounceMs?: number;
}

/**
 * Zero-click Z-Library login: when a right-hand page settles on a trusted mirror while the CLI is
 * logged out, hand that mirror's session cookies to the CLI.
 *
 * An explicit logout pauses this until the user starts a login again; the browser keeps its
 * cookies, so without the pause the next page load would log the user straight back in.
 */
export class ZlibAutoSync {
  private loginWatchUntil = 0;
  private knownLoggedIn: boolean | null = null;
  private lastSyncedKey = "";
  private readonly failedKeys = new Set<string>();
  private paused: boolean | null = null;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: ZlibAutoSyncDeps) {}

  /** Record the CLI login state from any connections snapshot. */
  noteSnapshot(snapshot: ConnectionsSnapshot): void {
    this.knownLoggedIn = snapshot.zlib.loggedIn;
  }

  /** The user clicked "open login": watch the browser for the next 15 minutes. */
  beginLoginWatch(): void {
    this.loginWatchUntil = this.now() + LOGIN_WATCH_MS;
    this.failedKeys.clear();
    this.setPaused(false);
  }

  /** A manual browser sync or cookie-file login succeeded. */
  noteManualLogin(authKey?: string): void {
    if (authKey) this.lastSyncedKey = authKey;
    this.loginWatchUntil = 0;
    this.failedKeys.clear();
    this.setPaused(false);
  }

  noteLogout(): void {
    this.knownLoggedIn = false;
    this.lastSyncedKey = "";
    this.loginWatchUntil = 0;
    this.cancelPending();
    this.setPaused(true);
  }

  onPageSettled(url: string): void {
    if (!this.shouldConsider(url)) return;
    this.cancelPending();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run(url);
    }, this.deps.debounceMs ?? 550);
  }

  cancelPending(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** One silent sync attempt; `onPageSettled` calls it after the debounce. */
  async run(url: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (this.knownLoggedIn === null) this.noteSnapshot(await this.deps.fetchSnapshot());
      // Re-evaluate: the login window or login state may have changed during the debounce.
      if (!this.shouldConsider(url)) return;

      const found = await this.deps.findSession(url, {
        isAllowedHost: (host) => this.isTrusted(host),
        scanCookieStore: false,
      });
      if (!found.ok || this.failedKeys.has(found.authKey)) return;
      if (found.authKey === this.lastSyncedKey && this.knownLoggedIn) return;

      let snapshot: ConnectionsSnapshot;
      try {
        snapshot = await this.deps.login(found.cookies, found.origin);
      } catch {
        // Do not retry the same credentials on every page load; the manual button still works.
        this.failedKeys.add(found.authKey);
        return;
      }
      this.noteSnapshot(snapshot);
      if (!snapshot.zlib.loggedIn) {
        this.failedKeys.add(found.authKey);
        return;
      }
      this.lastSyncedKey = found.authKey;
      this.loginWatchUntil = 0;
      this.deps.onSynced(snapshot, found.origin);
    } catch {
      // Silent background check: the manual sync button remains available.
    } finally {
      this.running = false;
    }
  }

  private shouldConsider(url: string): boolean {
    if (this.isPaused()) return false;
    if (this.knownLoggedIn === true && !this.loginInProgress()) return false;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return false;
    }
    return this.isTrusted(host);
  }

  private isTrusted(host: string): boolean {
    return isTrustedAutoSyncHost(host, {
      preferredUrl: this.deps.getPreferredDomain(),
      loginInProgress: this.loginInProgress(),
    });
  }

  private loginInProgress(): boolean {
    return this.now() < this.loginWatchUntil;
  }

  private isPaused(): boolean {
    if (this.paused === null) this.paused = this.deps.readPaused();
    return this.paused;
  }

  private setPaused(paused: boolean): void {
    if (this.isPaused() === paused) return;
    this.paused = paused;
    this.deps.writePaused(paused);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
