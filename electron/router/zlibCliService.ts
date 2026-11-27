import { execFile, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ROUTER_EBOOK_EXTENSIONS, resolveDownloadedBook } from "./downloadedBooks";
import { supportsWeReadImport } from "./wereadFormats";
import type { WeReadImportResult } from "../../src/types/desktop";
import {
  parseHalfBlockQrToMatrix,
  serializeToNetscapeCookies,
  type NormalizedCookie,
} from "../browser/cookieCodec";
import { KNOWN_ZLIB_MIRRORS } from "../browser/zlibAuthSession";

const execFileAsync = promisify(execFile);

import type { ConnectionsSnapshot, LocalBookMetadata, WeReadQrEvent, ZlibBookItem, ZlibDomainHealth, ZlibStatus } from "./zlibTypes";
import { DownloadHistoryPage, cliErrorMessage, extractCliError, extractDownloadedFilePath, isValidHistoryOnlyRef, isValidZlibBookRef, locateZlibBinary, normalizeMetaRecord, normalizeZlibDomainUrl, parseHistoryPage, parseMetaMatches, parseZlibSearchJson, unconfirmedWeReadImport, weReadImportError } from "./zlibOutput";

export * from "./zlibTypes";
export * from "./zlibOutput";

type FeedCacheKey = "recommended" | "most-popular" | "favorites";

const ALLOWED_SEARCH_ORDERS = new Set([
  "popular",
  "bestmatch",
  "date",
  "titleA",
  "title",
  "year",
  "filesize",
  "filesizeA",
]);

/** Returns true when the URL answers through the same network path the right-hand browser uses. */
export type MirrorProbe = (url: string, timeoutMs: number) => Promise<boolean>;

export class ZlibCliService {
  private readonly defaultDownloadDir: string;
  private preferredDomain = "";
  private activeWeReadLoginProc: ChildProcess | null = null;
  private readonly activeWeReadImports = new Map<string, Promise<WeReadImportResult>>();
  private readonly feedCache = new Map<FeedCacheKey, { items: ZlibBookItem[]; fetchedAt: number }>();
  private readonly historyPages = new Map<number, { fetchedAt: number; result: Promise<DownloadHistoryPage> }>();

  constructor(downloadDir: string) {
    this.defaultDownloadDir = downloadDir;
  }

  getDownloadDir(): string {
    return this.defaultDownloadDir;
  }

  invalidateFeedCache(): void {
    this.feedCache.clear();
    this.historyPages.clear();
  }

  setPreferredDomain(domain: string): string {
    const clean = domain.trim() ? normalizeZlibDomainUrl(domain) : "";
    if (clean !== this.preferredDomain) {
      this.invalidateFeedCache();
    }
    this.preferredDomain = clean;
    return clean;
  }

  getPreferredDomain(): string {
    return this.preferredDomain;
  }

  private buildEnv(): NodeJS.ProcessEnv {
    if (!this.preferredDomain) return process.env;
    return {
      ...process.env,
      ZLIB_DOMAIN: this.preferredDomain,
    };
  }

  async getStatus(): Promise<ZlibStatus> {
    const binaryPath = locateZlibBinary();
    const installHint = "书源组件随安装包提供，可能已损坏或被安全软件移除，请重新安装点点读书。";
    if (!binaryPath) {
      return {
        installed: false,
        binaryPath: null,
        version: null,
        supportsMeta: false,
        installHint,
      };
    }

    let version: string | null = null;
    let supportsMeta = false;
    try {
      const { stdout } = await execFileAsync(binaryPath, ["--version"], { timeout: 6_000 });
      version = stdout.trim().split(/\r?\n/)[0] || null;
    } catch {
      version = "unknown";
    }

    try {
      const { stdout } = await execFileAsync(binaryPath, ["--help"], { timeout: 6_000 });
      supportsMeta = /\bmeta\b/.test(stdout);
    } catch {
      supportsMeta = false;
    }

    return {
      installed: true,
      binaryPath,
      version,
      supportsMeta,
      installHint,
    };
  }

  async getConnectionsSnapshot(): Promise<ConnectionsSnapshot> {
    const status = await this.getStatus();
    const empty: ConnectionsSnapshot = {
      status,
      zlib: {
        loggedIn: false,
        userName: "",
        dailyRemaining: null,
        dailyAllowed: null,
        currentDomain: this.preferredDomain,
      },
      weread: {
        loggedIn: false,
        name: "",
        vid: "",
      },
      kindle: {
        configured: false,
        to: "",
        from: "",
        smtpHost: "smtp.gmail.com",
        smtpPort: "587",
        smtpSecurity: "starttls",
      },
    };
    if (!status.installed || !status.binaryPath) return empty;
    const bin = status.binaryPath;
    const env = this.buildEnv();

    const [cfgRes, profRes, wrRes] = await Promise.allSettled([
      execFileAsync(bin, ["config", "--json"], { timeout: 8_000, env }),
      execFileAsync(bin, ["profile", "--json"], { timeout: 10_000, env }),
      execFileAsync(bin, ["weread", "whoami", "--json"], { timeout: 10_000, env }),
    ]);

    if (cfgRes.status === "fulfilled") {
      try {
        const rows = JSON.parse(cfgRes.value.stdout.trim()) as Array<{ key?: string; value?: string; saved?: string }>;
        const byKey = new Map<string, string>();
        for (const row of rows) {
          if (row.key) byKey.set(row.key, String(row.value ?? row.saved ?? "").trim());
        }
        empty.zlib.currentDomain = this.preferredDomain || byKey.get("ZLIB_DOMAIN") || "";
        const to = byKey.get("KINDLE_TO") || "";
        const from = byKey.get("KINDLE_FROM") || "";
        empty.kindle = {
          configured: Boolean(to && from),
          to,
          from,
          smtpHost: byKey.get("KINDLE_SMTP_HOST") || "smtp.gmail.com",
          smtpPort: byKey.get("KINDLE_SMTP_PORT") || "587",
          smtpSecurity: byKey.get("KINDLE_SMTP_SECURITY") || "starttls",
        };
      } catch {
        // Ignore parse issues.
      }
    }

    if (profRes.status === "fulfilled") {
      try {
        const prof = JSON.parse(profRes.value.stdout.trim()) as {
          name?: string;
          daily_remaining?: number;
          daily_allowed?: number;
        };
        empty.zlib.loggedIn = true;
        empty.zlib.userName = String(prof.name ?? "已登录用户").trim();
        empty.zlib.dailyRemaining = typeof prof.daily_remaining === "number" ? prof.daily_remaining : null;
        empty.zlib.dailyAllowed = typeof prof.daily_allowed === "number" ? prof.daily_allowed : null;
      } catch {
        empty.zlib.loggedIn = false;
      }
    } else {
      const msg = extractCliError(profRes.reason, "").message;
      if (msg && !/not logged in/i.test(msg)) {
        empty.zlib.error = msg;
      }
    }

    if (wrRes.status === "fulfilled") {
      try {
        const wr = JSON.parse(wrRes.value.stdout.trim()) as { vid?: string; name?: string };
        if (wr.vid || wr.name) {
          empty.weread.loggedIn = true;
          empty.weread.vid = String(wr.vid ?? "");
          empty.weread.name = String(wr.name ?? "微信读书用户");
        }
      } catch {
        empty.weread.loggedIn = false;
      }
    }

    return empty;
  }

  private requireBinary(): string {
    const bin = locateZlibBinary();
    if (!bin) {
      throw new Error("找不到书源组件 heartleo/zlib。它随安装包提供，请重新安装点点读书后再试。");
    }
    return bin;
  }

  async listHealthyDomains(timeoutMs = 25_000): Promise<ZlibDomainHealth[]> {
    const bin = this.requireBinary();
    const { stdout } = await execFileAsync(bin, ["doctor", "--json"], { timeout: timeoutMs });
    const parsed = JSON.parse(stdout.trim()) as Array<{
      domain?: string;
      status?: string;
      http_status?: number;
    }>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((d) => typeof d.domain === "string" && d.domain.trim())
      .map((d) => ({
        domain: String(d.domain),
        status: String(d.status ?? "unknown"),
        httpStatus: Number(d.http_status ?? 0),
      }));
  }

  /**
   * Resolve a fast, reachable Z-Library mirror URL to open in the right-hand browser
   * without stalling 25s on `zlib doctor` when common mirrors respond in ~300ms.
   */
  async resolveLoginMirrorUrl(explicitDomain: string | undefined, probe: MirrorProbe): Promise<{
    url: string;
    reachable: boolean;
    switched: boolean;
  }> {
    const primary = explicitDomain?.trim()
      ? normalizeZlibDomainUrl(explicitDomain)
      : this.preferredDomain;

    if (primary && (await probe(primary, 2_800))) {
      return { url: primary, reachable: true, switched: false };
    }

    const candidates = KNOWN_ZLIB_MIRRORS.filter((m) => m !== primary);
    try {
      const winner = await Promise.any(
        candidates.map(async (candidate) => {
          const ok = await probe(candidate, 3_600);
          if (!ok) throw new Error("unreachable");
          return candidate;
        }),
      );
      return { url: winner, reachable: true, switched: Boolean(primary && winner !== primary) };
    } catch {
      // Fall back to a bounded `zlib doctor --json` check.
    }

    // `zlib doctor` checks over the CLI's own network path, so the browser must confirm its pick.
    const healthyList = await this.listHealthyDomains(8_000).catch(() => []);
    const healthy = healthyList.find((d) => d.status === "healthy")?.domain;
    let cleanHealthy = "";
    try {
      cleanHealthy = healthy ? normalizeZlibDomainUrl(healthy) : "";
    } catch {
      // Ignore a malformed doctor entry.
    }
    if (cleanHealthy && cleanHealthy !== primary && (await probe(cleanHealthy, 3_600))) {
      return {
        url: cleanHealthy,
        reachable: true,
        switched: Boolean(primary),
      };
    }

    return {
      url: primary || KNOWN_ZLIB_MIRRORS[0]!,
      reachable: false,
      switched: false,
    };
  }

  async runDoctor(): Promise<{ ok: boolean; output: string; domains: ZlibDomainHealth[] }> {
    const bin = this.requireBinary();
    try {
      const { stdout, stderr } = await execFileAsync(bin, ["doctor", "--json"], { timeout: 25_000 });
      const raw = stdout.trim();
      let domains: ZlibDomainHealth[] = [];
      try {
        const list = JSON.parse(raw) as Array<{ domain?: string; status?: string; http_status?: number }>;
        if (Array.isArray(list)) {
          domains = list
            .filter((d) => typeof d.domain === "string" && d.domain.trim())
            .map((d) => ({
              domain: String(d.domain),
              status: String(d.status ?? "unknown"),
              httpStatus: Number(d.http_status ?? 0),
            }));
          const summary = domains
            .map((d) => `${d.status === "healthy" ? "✓" : "✗"} ${d.domain} (${d.status} ${d.httpStatus})`)
            .join("\n");
          return { ok: true, output: summary || raw, domains };
        }
      } catch {
        // Fallback to raw text.
      }
      return { ok: true, output: [raw, stderr.trim()].filter(Boolean).join("\n"), domains };
    } catch (error: unknown) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      return {
        ok: false,
        output: [err.stdout?.trim(), err.stderr?.trim(), err.message].filter(Boolean).join("\n"),
        domains: [],
      };
    }
  }

  /**
   * Bridge right-hand WebContentsView cookies into `zlib login --cookies` using a
   * mode-0600 temp file that is unconditionally deleted in `finally`.
   */
  async loginZlibWithCookies(cookies: NormalizedCookie[], domainUrl: string): Promise<ConnectionsSnapshot> {
    const bin = this.requireBinary();
    const cleanDomain = normalizeZlibDomainUrl(domainUrl);
    if (!cleanDomain) throw new Error("请提供有效的 Z-Library 镜像域名");
    if (cookies.length === 0) {
      throw new Error("未在右侧当前页面读取到该域名的登录 Cookie，请先确认已在右侧网页登录成功。");
    }

    const tmpFile = path.join(os.tmpdir(), `diandian-zlib-sync-${crypto.randomBytes(8).toString("hex")}.txt`);
    try {
      const netscape = serializeToNetscapeCookies(cookies);
      fs.writeFileSync(tmpFile, netscape, { encoding: "utf8", mode: 0o600 });
      await execFileAsync(bin, ["login", "--cookies", tmpFile, "--domain", cleanDomain], {
        timeout: 25_000,
      });
      this.preferredDomain = cleanDomain;
      this.invalidateFeedCache();
      return await this.getConnectionsSnapshot();
    } catch (error) {
      throw extractCliError(error, "同步 Z-Library 登录态失败");
    } finally {
      try {
        fs.rmSync(tmpFile, { force: true });
      } catch {
        // Ignore cleanup failure.
      }
    }
  }

  async loginZlibWithCookieFile(filePath: string, domainUrl?: string): Promise<ConnectionsSnapshot> {
    const bin = this.requireBinary();
    const trimmed = filePath.trim();
    if (!trimmed || !path.isAbsolute(trimmed) || !fs.lstatSync(trimmed).isFile()) {
      throw new Error("请选择有效的 Netscape cookies.txt 文件");
    }
    const args = ["login", "--cookies", trimmed];
    if (domainUrl && domainUrl.trim()) {
      const clean = normalizeZlibDomainUrl(domainUrl);
      args.push("--domain", clean);
      this.preferredDomain = clean;
    }
    try {
      await execFileAsync(bin, args, { timeout: 25_000 });
      this.invalidateFeedCache();
      return await this.getConnectionsSnapshot();
    } catch (error) {
      throw extractCliError(error, "导入 Cookie 登录 Z-Library 失败");
    }
  }

  async logoutZlib(): Promise<ConnectionsSnapshot> {
    const bin = this.requireBinary();
    try {
      await execFileAsync(bin, ["logout"], { timeout: 15_000, env: this.buildEnv() });
      this.invalidateFeedCache();
      return await this.getConnectionsSnapshot();
    } catch (error) {
      throw extractCliError(error, "退出 Z-Library 登录失败");
    }
  }

  async logoutWeRead(): Promise<ConnectionsSnapshot> {
    this.cancelWeReadQrLogin();
    const bin = this.requireBinary();
    try {
      await execFileAsync(bin, ["weread", "logout"], { timeout: 15_000, env: this.buildEnv() });
      return await this.getConnectionsSnapshot();
    } catch (error) {
      throw extractCliError(error, "解除微信读书书架绑定失败");
    }
  }

  startWeReadQrLogin(onEvent: (event: WeReadQrEvent) => void): void {
    this.cancelWeReadQrLogin();
    const bin = this.requireBinary();
    onEvent({ kind: "starting" });

    const child = spawn(bin, ["weread", "login"], {
      env: this.buildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.activeWeReadLoginProc = child;

    let stdoutBuf = "";
    let stderrBuf = "";
    let qrSent = false;

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      if (!qrSent) {
        const matrix = parseHalfBlockQrToMatrix(stdoutBuf);
        if (matrix) {
          qrSent = true;
          onEvent({
            kind: "qr",
            qr: matrix,
            hint: "请使用微信扫一扫上方二维码，并在手机上确认登录微信读书书架通道",
          });
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });

    child.once("error", (err) => {
      if (this.activeWeReadLoginProc === child) this.activeWeReadLoginProc = null;
      onEvent({ kind: "error", message: `无法启动微信读书扫码登录: ${err.message}` });
    });

    child.once("exit", (code, signal) => {
      const wasActive = this.activeWeReadLoginProc === child;
      if (wasActive) this.activeWeReadLoginProc = null;
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        onEvent({ kind: "canceled" });
        return;
      }
      if (code === 0) {
        void execFileAsync(bin, ["weread", "whoami", "--json"], { timeout: 10_000 })
          .then(({ stdout }) => {
            const parsed = JSON.parse(stdout.trim()) as { name?: string; vid?: string };
            onEvent({
              kind: "success",
              name: String(parsed.name ?? "微信读书用户"),
              vid: String(parsed.vid ?? ""),
            });
          })
          .catch(() => {
            onEvent({ kind: "success", name: "微信读书用户", vid: "" });
          });
      } else {
        const detail = [stderrBuf.trim(), stdoutBuf.trim().split("\n").slice(-3).join(" ")].filter(Boolean).join(" ");
        onEvent({
          kind: "error",
          message: detail || `微信读书扫码登录未完成 (code=${code ?? "unknown"})`,
        });
      }
    });
  }

  cancelWeReadQrLogin(): void {
    const proc = this.activeWeReadLoginProc;
    this.activeWeReadLoginProc = null;
    if (proc && !proc.killed) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // Ignore.
      }
    }
  }

  async openKindleConfigInTerminal(): Promise<{ launched: boolean; command: string }> {
    const bin = this.requireBinary();
    const command = `${bin} kindle config`;
    if (process.platform === "darwin" && /^[a-zA-Z0-9/._-]+$/.test(bin)) {
      await execFileAsync("osascript", [
        "-e",
        'tell application "Terminal" to activate',
        "-e",
        `tell application "Terminal" to do script "${bin} kindle config"`,
      ]);
      return { launched: true, command };
    }
    return { launched: false, command };
  }

  private async fetchCachedFeed(
    key: FeedCacheKey,
    ttlMs: number,
    forceRefresh = false,
  ): Promise<ZlibBookItem[]> {
    const now = Date.now();
    if (!forceRefresh) {
      const cached = this.feedCache.get(key);
      if (cached && now - cached.fetchedAt < ttlMs) {
        return cached.items;
      }
    }
    const bin = this.requireBinary();
    try {
      const { stdout } = await execFileAsync(bin, [key, "--json"], {
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        env: this.buildEnv(),
      });
      const items = parseZlibSearchJson(stdout);
      this.feedCache.set(key, { items, fetchedAt: now });
      return items;
    } catch (error) {
      throw extractCliError(error, `获取 Z-Library ${key} 书单失败`);
    }
  }

  async getRecommended(forceRefresh = false): Promise<ZlibBookItem[]> {
    return this.fetchCachedFeed("recommended", 5 * 60_000, forceRefresh);
  }

  async getMostPopular(forceRefresh = false): Promise<ZlibBookItem[]> {
    return this.fetchCachedFeed("most-popular", 10 * 60_000, forceRefresh);
  }

  async getFavorites(forceRefresh = false): Promise<ZlibBookItem[]> {
    return this.fetchCachedFeed("favorites", 3 * 60_000, forceRefresh);
  }

  async getHistory(forceRefresh = false): Promise<ZlibBookItem[]> {
    return (await this.getDownloadHistoryPage(1, forceRefresh)).books;
  }

  async getDownloadHistoryPage(page: number, forceRefresh = false): Promise<DownloadHistoryPage> {
    if (!Number.isSafeInteger(page) || page < 1) throw new Error("下载历史页码须为正整数。");
    const cached = this.historyPages.get(page);
    if (!forceRefresh && cached && Date.now() - cached.fetchedAt < 120_000) return cached.result;
    const bin = this.requireBinary();
    const result = execFileAsync(bin, ["history", "--json", "--page", String(page)], {
      timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: this.buildEnv(),
    }).then(({ stdout }) => parseHistoryPage(stdout, page));
    this.historyPages.set(page, { fetchedAt: Date.now(), result });
    try {
      return await result;
    } catch (error) {
      if (this.historyPages.get(page)?.result === result) this.historyPages.delete(page);
      const message = cliErrorMessage(error, "读取 Z-Library 下载历史失败");
      if ((error as { code?: number }).code === 3 || /not logged in|log ?in (?:first|required)|unauthorized|no saved session/i.test(message)) {
        throw new Error("请在「连接与偏好」连接 Z-Library 账号，再回到书库重试。");
      }
      throw extractCliError(error, "读取 Z-Library 下载历史失败");
    }
  }

  async search(
    query: string,
    opts: { format?: string; limit?: number; page?: number; order?: string } = {},
  ): Promise<ZlibBookItem[]> {
    const bin = this.requireBinary();
    const q = query.trim();
    if (!q) return [];
    const args = ["search", q, "--json"];
    if (opts.format && /^[a-z0-9]{2,8}$/i.test(opts.format.trim())) {
      args.push("--ext", opts.format.trim().toLowerCase());
    }
    if (opts.order && ALLOWED_SEARCH_ORDERS.has(opts.order.trim())) {
      args.push("--order", opts.order.trim());
    }
    if (typeof opts.page === "number" && Number.isFinite(opts.page) && opts.page > 1) {
      args.push("--page", String(Math.min(50, Math.floor(opts.page))));
    }
    const count = Math.max(1, Math.min(30, opts.limit ?? 15));
    args.push("--count", String(count));

    try {
      const { stdout } = await execFileAsync(bin, args, {
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        env: this.buildEnv(),
      });
      return parseZlibSearchJson(stdout);
    } catch (error) {
      throw extractCliError(error, "zlib 检索失败");
    }
  }

  async download(
    bookRef: string,
    destDir?: string,
  ): Promise<{ output: string; directory: string; filePath?: string }> {
    const bin = this.requireBinary();
    const cleanRef = bookRef.trim();
    const historyOnly = isValidHistoryOnlyRef(cleanRef);
    if (!historyOnly && !isValidZlibBookRef(cleanRef)) {
      throw new Error("无效的书籍标识，格式应为 `<id>:<hash>`");
    }
    const targetDir = destDir && path.isAbsolute(destDir) ? destDir : this.defaultDownloadDir;
    fs.mkdirSync(targetDir, { recursive: true });
    try {
      const args = historyOnly ? ["history", "--download", cleanRef.slice("history:".length)] : ["download", cleanRef];
      const { stdout, stderr } = await execFileAsync(bin, [...args, "--dir", targetDir, "--json"], {
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
        env: this.buildEnv(),
      });
      const filePath = extractDownloadedFilePath(stdout, targetDir);
      this.historyPages.clear();
      return {
        directory: targetDir,
        ...(filePath ? { filePath } : {}),
        output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || `已下载到 ${targetDir}`,
      };
    } catch (error) {
      throw extractCliError(error, "zlib 下载失败");
    }
  }

  async sendToKindle(filePath: string): Promise<{ output: string }> {
    const bin = this.requireBinary();
    const cleanPath = this.assertReadableBookFile(filePath);
    try {
      const { stdout, stderr } = await execFileAsync(bin, ["kindle", "send", cleanPath], {
        timeout: 90_000,
        maxBuffer: 2 * 1024 * 1024,
        env: this.buildEnv(),
      });
      return {
        output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || "已触发发送到 Kindle",
      };
    } catch (error) {
      throw extractCliError(error, "发送到 Kindle 失败");
    }
  }

  async importToWeRead(filePath: string, options?: { fromLibrary?: boolean }): Promise<WeReadImportResult> {
    const cleanPath = options?.fromLibrary
      ? await resolveDownloadedBook(this.defaultDownloadDir, filePath)
      : await fs.promises.realpath(this.assertReadableBookFile(filePath));
    if (!supportsWeReadImport(path.extname(cleanPath).slice(1))) {
      throw new Error("微信读书支持导入 EPUB、PDF、MOBI、AZW3 和 TXT 文件。");
    }
    const pending = this.activeWeReadImports.get(cleanPath);
    if (pending) return pending;
    const bin = locateZlibBinary();
    if (!bin) throw new Error("请先在「连接与偏好」安装传书组件并连接微信读书。");
    const transfer = this.uploadToWeRead(bin, cleanPath);
    this.activeWeReadImports.set(cleanPath, transfer);
    try { return await transfer; }
    finally { this.activeWeReadImports.delete(cleanPath); }
  }

  private async uploadToWeRead(bin: string, filePath: string): Promise<WeReadImportResult> {
    // WeRead can spend up to three minutes processing after the upload finishes.
    const { stdout, stderr } = await execFileAsync(bin, ["weread", "import", filePath, "--json"], {
      timeout: 15 * 60_000, maxBuffer: 2 * 1024 * 1024, env: this.buildEnv(),
    }).catch(error => { throw weReadImportError(error); });
    let result;
    try { result = JSON.parse(stdout); } catch { throw new Error(unconfirmedWeReadImport); }
    if (typeof result?.book_id !== "string" || !result.book_id.trim()
      || (result.already_existed !== undefined && typeof result.already_existed !== "boolean")) {
      throw new Error(unconfirmedWeReadImport);
    }
    return { output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n"), alreadyExisted: result.already_existed === true };
  }

  async readLocalBookMeta(filePath: string): Promise<LocalBookMetadata> {
    const bin = this.requireBinary();
    const cleanPath = this.assertReadableBookFile(filePath);
    try {
      const { stdout } = await execFileAsync(bin, ["meta", cleanPath, "--json"], {
        timeout: 20_000,
        maxBuffer: 2 * 1024 * 1024,
        env: this.buildEnv(),
      });
      return normalizeMetaRecord(JSON.parse(stdout.trim()));
    } catch (error) {
      throw extractCliError(error, "读取电子书元数据失败（需要 zlib v0.0.16+）");
    }
  }

  async fetchLocalBookMetaMatches(
    filePath: string,
    sources: string[] = ["douban", "weread", "openlibrary", "google"],
  ): Promise<LocalBookMetadata[]> {
    const bin = this.requireBinary();
    const cleanPath = this.assertReadableBookFile(filePath);
    const allowedSources = new Set(["douban", "weread", "openlibrary", "google", "goodreads"]);
    const safeSources = sources.map((s) => s.trim().toLowerCase()).filter((s) => allowedSources.has(s));
    const args = ["meta", cleanPath, "--fetch", "--json"];
    if (safeSources.length > 0) {
      args.push("--source", safeSources.join(","));
    }

    try {
      const { stdout } = await execFileAsync(bin, args, {
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        env: this.buildEnv(),
      });
      return parseMetaMatches(stdout);
    } catch (error) {
      throw extractCliError(error, "在线抓取元数据失败");
    }
  }

  async applyLocalBookMeta(
    filePath: string,
    patch: Partial<LocalBookMetadata> & { rename?: boolean },
  ): Promise<{ metadata: LocalBookMetadata; filePath: string; output: string }> {
    const bin = this.requireBinary();
    const cleanPath = this.assertReadableBookFile(filePath);
    const args = ["meta", cleanPath];
    if (patch.title !== undefined && patch.title.trim()) args.push("-t", patch.title.trim());
    if (patch.authors !== undefined && patch.authors.trim()) args.push("-a", patch.authors.trim());
    if (patch.publisher !== undefined && patch.publisher.trim()) args.push("-p", patch.publisher.trim());
    if (patch.isbn !== undefined && patch.isbn.trim()) args.push("--isbn", patch.isbn.trim());
    if (patch.date !== undefined && patch.date.trim()) args.push("-d", patch.date.trim());
    if (patch.language !== undefined && patch.language.trim()) args.push("-l", patch.language.trim());
    if (patch.tags !== undefined && patch.tags.trim()) args.push("--tags", patch.tags.trim());
    if (patch.comments !== undefined && patch.comments.trim()) args.push("-c", patch.comments.trim());
    if (patch.rename) args.push("--rename");
    args.push("--json");

    try {
      const { stdout, stderr } = await execFileAsync(bin, args, {
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        env: this.buildEnv(),
      });
      let metadata = normalizeMetaRecord({});
      try {
        metadata = normalizeMetaRecord(JSON.parse(stdout.trim()));
      } catch {
        // Keep fallback.
      }
      return {
        metadata,
        filePath: extractDownloadedFilePath(stdout, path.dirname(cleanPath)) ?? cleanPath,
        output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || "元数据已原子写回电子书文件",
      };
    } catch (error) {
      throw extractCliError(error, "写回电子书元数据失败");
    }
  }

  async embedEpubCover(filePath: string, jpeg: Buffer): Promise<void> {
    const bin = this.requireBinary();
    const book = this.assertReadableBookFile(filePath);
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "diandian-cover-"));
    try {
      const cover = path.join(directory, "cover.jpg");
      await fs.promises.writeFile(cover, jpeg, { mode: 0o600 });
      await execFileAsync(bin, ["meta", book, "--cover", cover, "--json"], {
        timeout: 30_000, env: this.buildEnv(),
      });
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  }

  async extractBookCover(filePath: string): Promise<Buffer | null> {
    const bin = this.requireBinary();
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "diandian-preview-"));
    try {
      const file = path.join(dir, "cover");
      await execFileAsync(bin, ["meta", filePath, "--get-cover", file], { timeout: 15_000, env: this.buildEnv() });
      return (await fs.promises.stat(file)).size <= 8 * 1024 * 1024 ? await fs.promises.readFile(file) : null;
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  }

  dispose(): void {
    this.cancelWeReadQrLogin();
  }

  private assertReadableBookFile(filePath: string): string {
    const trimmed = filePath.trim();
    if (!trimmed || !path.isAbsolute(trimmed)) {
      throw new Error("请选择本机有效的电子书文件（绝对路径）");
    }
    const stat = fs.lstatSync(trimmed);
    if (!stat.isFile()) {
      throw new Error("目标不是有效的电子书文件");
    }
    const ext = path.extname(trimmed).toLowerCase();
    if (!ROUTER_EBOOK_EXTENSIONS.includes(ext.slice(1))) {
      throw new Error(`不支持的电子书格式: ${ext || "未知"}`);
    }
    return trimmed;
  }
}
