import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";

export type KindleSmtpSecurity = "tls" | "starttls";

export interface KindleSettingsRaw {
  to: string;
  from: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: KindleSmtpSecurity;
  password: string;
}

export interface PublicKindleSettings {
  configured: boolean;
  to: string;
  from: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: KindleSmtpSecurity;
  hasPassword: boolean;
}

interface StoredKindleEnvelope {
  version: 1;
  to: string;
  from: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: KindleSmtpSecurity;
  passwordEncoding: "safeStorage" | "plain" | "none";
  passwordPayload: string;
  updatedAt: string;
}

interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50 MiB (Amazon Send-to-Kindle limit)
const ALLOWED_BOOK_EXTS = new Set([".epub", ".pdf", ".mobi", ".azw3", ".txt", ".docx", ".doc", ".rtf"]);

const MIME_BY_EXT: Record<string, string> = {
  ".epub": "application/epub+zip",
  ".pdf": "application/pdf",
  ".mobi": "application/x-mobipocket-ebook",
  ".azw3": "application/vnd.amazon.ebook",
  ".txt": "text/plain; charset=utf-8",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".rtf": "application/rtf",
};

function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function assertCleanHeaderValue(value: string, label: string): string {
  const trimmed = value.trim();
  if (/[\r\n\0]/.test(trimmed)) {
    throw new Error(`${label} 包含非法换行字符`);
  }
  return trimmed;
}

export function validateEmailAddress(raw: string, label: string): string {
  const clean = assertCleanHeaderValue(raw, label);
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(clean)) {
    throw new Error(`${label}格式不正确，请输入完整邮箱地址`);
  }
  return clean;
}

export function validateSmtpHost(raw: string): string {
  const clean = assertCleanHeaderValue(raw, "SMTP 服务器");
  if (!/^[a-z0-9.-]+$/i.test(clean) || !clean.includes(".")) {
    throw new Error("SMTP 服务器地址格式不正确，例如 smtp.qq.com");
  }
  return clean.toLowerCase();
}

export function validateSmtpPort(raw: unknown): number {
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    throw new Error("SMTP 端口必须是 1 到 65535 之间的整数");
  }
  return num;
}

export class KindleSettingsStore {
  private readonly filePath: string;
  private readonly safeStorage?: SafeStorageLike;

  constructor(userDataDir: string, safeStorage?: SafeStorageLike) {
    this.filePath = path.join(userDataDir, "config", "kindle-settings.json");
    this.safeStorage = safeStorage;
  }

  readRaw(): KindleSettingsRaw {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<StoredKindleEnvelope>;
      let password = "";
      if (
        parsed.passwordEncoding === "safeStorage" &&
        parsed.passwordPayload &&
        this.safeStorage?.isEncryptionAvailable()
      ) {
        password = this.safeStorage.decryptString(Buffer.from(parsed.passwordPayload, "base64"));
      } else if (parsed.passwordEncoding === "plain" && parsed.passwordPayload) {
        password = parsed.passwordPayload;
      }
      const smtpSecurity: KindleSmtpSecurity =
        parsed.smtpSecurity === "starttls" ? "starttls" : "tls";
      const smtpPort =
        typeof parsed.smtpPort === "number" && Number.isInteger(parsed.smtpPort) && parsed.smtpPort > 0
          ? parsed.smtpPort
          : smtpSecurity === "starttls"
            ? 587
            : 465;
      return {
        to: typeof parsed.to === "string" ? parsed.to.trim() : "",
        from: typeof parsed.from === "string" ? parsed.from.trim() : "",
        smtpHost: typeof parsed.smtpHost === "string" ? parsed.smtpHost.trim() : "",
        smtpPort,
        smtpSecurity,
        password,
      };
    } catch {
      return {
        to: "",
        from: "",
        smtpHost: "",
        smtpPort: 465,
        smtpSecurity: "tls",
        password: "",
      };
    }
  }

  readPublic(): PublicKindleSettings {
    const raw = this.readRaw();
    const hasPassword = Boolean(raw.password);
    const configured = Boolean(raw.to && raw.from && raw.smtpHost && hasPassword);
    return {
      configured,
      to: raw.to,
      from: raw.from,
      smtpHost: raw.smtpHost,
      smtpPort: raw.smtpPort,
      smtpSecurity: raw.smtpSecurity,
      hasPassword,
    };
  }

  save(input: {
    to: string;
    from: string;
    smtpHost: string;
    smtpPort: number;
    smtpSecurity: KindleSmtpSecurity;
    password?: string;
    clearPassword?: boolean;
  }): PublicKindleSettings {
    const existing = this.readRaw();
    const to = validateEmailAddress(input.to, "Kindle 收件邮箱");
    const from = validateEmailAddress(input.from, "发件邮箱");
    const smtpHost = validateSmtpHost(input.smtpHost);
    const smtpPort = validateSmtpPort(input.smtpPort);
    const smtpSecurity: KindleSmtpSecurity = input.smtpSecurity === "starttls" ? "starttls" : "tls";

    let nextPassword = existing.password;
    if (input.clearPassword) {
      nextPassword = "";
    } else if (typeof input.password === "string" && input.password.trim()) {
      nextPassword = assertCleanHeaderValue(input.password, "邮箱授权码");
    }

    let passwordEncoding: StoredKindleEnvelope["passwordEncoding"] = "none";
    let passwordPayload = "";
    if (nextPassword) {
      if (this.safeStorage?.isEncryptionAvailable()) {
        passwordEncoding = "safeStorage";
        passwordPayload = this.safeStorage.encryptString(nextPassword).toString("base64");
      } else {
        passwordEncoding = "plain";
        passwordPayload = nextPassword;
      }
    }

    const envelope: StoredKindleEnvelope = {
      version: 1,
      to,
      from,
      smtpHost,
      smtpPort,
      smtpSecurity,
      passwordEncoding,
      passwordPayload,
      updatedAt: new Date().toISOString(),
    };
    writeFileAtomic(this.filePath, JSON.stringify(envelope, null, 2));
    return this.readPublic();
  }

  clear(): PublicKindleSettings {
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch {
      // Ignore if missing
    }
    return this.readPublic();
  }
}

interface SmtpResponse {
  code: number;
  lines: string[];
}

class SimpleSmtpConnection {
  private socket: net.Socket | tls.TLSSocket;
  private buffer = "";
  private pendingLines: string[] = [];
  private waiting:
    | {
        resolve: (res: SmtpResponse) => void;
        reject: (err: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | null = null;
  private closedError: Error | null = null;

  private constructor(socket: net.Socket | tls.TLSSocket) {
    this.socket = socket;
    this.attachListeners(socket);
  }

  private attachListeners(sock: net.Socket | tls.TLSSocket): void {
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx = this.buffer.indexOf("\n");
      while (idx !== -1) {
        const line = this.buffer.slice(0, idx).replace(/\r$/, "");
        this.buffer = this.buffer.slice(idx + 1);
        this.pendingLines.push(line);
        idx = this.buffer.indexOf("\n");
      }
      this.tryFlushPending();
    });
    sock.on("error", (err) => {
      this.failAll(err);
    });
    sock.on("close", () => {
      this.failAll(new Error("SMTP 连接已提前断开"));
    });
  }

  private failAll(err: Error): void {
    this.closedError = err;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  private tryFlushPending(): void {
    if (!this.waiting) return;
    const collected: string[] = [];
    for (let i = 0; i < this.pendingLines.length; i += 1) {
      const line = this.pendingLines[i]!;
      collected.push(line);
      if (/^\d{3}( |$)/.test(line)) {
        this.pendingLines.splice(0, i + 1);
        const code = Number(line.slice(0, 3));
        const w = this.waiting;
        this.waiting = null;
        clearTimeout(w.timer);
        w.resolve({ code, lines: collected });
        return;
      }
    }
  }

  readResponse(timeoutMs = 20_000): Promise<SmtpResponse> {
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiting) {
          this.waiting = null;
          reject(new Error("SMTP 服务器响应超时，请检查主机名、端口或加密方式"));
        }
      }, timeoutMs);
      this.waiting = { resolve, reject, timer };
      this.tryFlushPending();
    });
  }

  async command(line: string, expectedCodes: number[], timeoutMs = 20_000): Promise<SmtpResponse> {
    if (this.closedError) throw this.closedError;
    this.socket.write(`${line}\r\n`, "utf8");
    const res = await this.readResponse(timeoutMs);
    if (!expectedCodes.includes(res.code)) {
      throw new Error(`SMTP ${res.code}: ${res.lines.join(" | ")}`);
    }
    return res;
  }

  async sendDataBody(rawMessage: string, timeoutMs = 60_000): Promise<SmtpResponse> {
    if (this.closedError) throw this.closedError;
    const stuffed = rawMessage.replace(/\r?\n/g, "\r\n").replace(/\r\n\./g, "\r\n..");
    const body = stuffed.startsWith(".") ? `.${stuffed}` : stuffed;
    this.socket.write(`${body}\r\n.\r\n`, "utf8");
    const res = await this.readResponse(timeoutMs);
    if (res.code !== 250) {
      throw new Error(`SMTP ${res.code}: ${res.lines.join(" | ")}`);
    }
    return res;
  }

  async upgradeToTls(host: string, timeoutMs = 15_000): Promise<void> {
    const rawSocket = this.socket;
    rawSocket.removeAllListeners("data");
    rawSocket.removeAllListeners("error");
    rawSocket.removeAllListeners("close");
    this.buffer = "";
    this.pendingLines = [];

    const tlsSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("STARTTLS 加密握手超时")), timeoutMs);
      const s = tls.connect(
        {
          socket: rawSocket,
          servername: host,
          rejectUnauthorized: true,
        },
        () => {
          clearTimeout(timer);
          resolve(s);
        },
      );
      s.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    this.socket = tlsSocket;
    this.attachListeners(tlsSocket);
  }

  close(): void {
    try {
      this.socket.write("QUIT\r\n");
    } catch {
      // Ignore
    }
    try {
      this.socket.end();
      this.socket.destroy();
    } catch {
      // Ignore
    }
  }

  static async connect(
    host: string,
    port: number,
    security: KindleSmtpSecurity,
    timeoutMs = 15_000,
  ): Promise<SimpleSmtpConnection> {
    const sock = await new Promise<net.Socket | tls.TLSSocket>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("连接 SMTP 服务器超时，请确认服务器地址、端口和加密方式（465 通常为 SSL/TLS，587 通常为 STARTTLS）")),
        timeoutMs,
      );
      const s =
        security === "tls"
          ? tls.connect({ host, port, servername: host, rejectUnauthorized: true }, () => {
              clearTimeout(timer);
              resolve(s);
            })
          : net.connect({ host, port }, () => {
              clearTimeout(timer);
              resolve(s);
            });
      s.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const conn = new SimpleSmtpConnection(sock);
    const greeting = await conn.readResponse(timeoutMs);
    if (greeting.code !== 220) {
      conn.close();
      throw new Error(`SMTP 握手失败 (${greeting.code}): ${greeting.lines.join(" ")}`);
    }

    await conn.command("EHLO diandianreading.local", [250], timeoutMs);
    if (security === "starttls") {
      await conn.command("STARTTLS", [220], timeoutMs);
      await conn.upgradeToTls(host, timeoutMs);
      await conn.command("EHLO diandianreading.local", [250], timeoutMs);
    }
    return conn;
  }
}

async function authenticateSmtp(conn: SimpleSmtpConnection, user: string, pass: string): Promise<void> {
  try {
    await conn.command("AUTH LOGIN", [334]);
    await conn.command(Buffer.from(user, "utf8").toString("base64"), [334]);
    await conn.command(Buffer.from(pass, "utf8").toString("base64"), [235]);
    return;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Fallback to AUTH PLAIN only if server doesn't support AUTH LOGIN
    if (/SMTP (502|504)/.test(msg)) {
      const plainToken = Buffer.from(`\u0000${user}\u0000${pass}`, "utf8").toString("base64");
      await conn.command(`AUTH PLAIN ${plainToken}`, [235]);
      return;
    }
    throw err;
  }
}

function mapFriendlySmtpError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/SMTP 535|Authentication failed|Invalid login|5\.7\.8|5\.7\.139/i.test(raw)) {
    return "邮箱认证失败：请确认已开启邮箱的「POP3/SMTP 服务」，且填写的是邮箱授权码（而非网页登录密码）";
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) {
    return "无法解析 SMTP 服务器地址，请检查域名拼写或网络连接";
  }
  if (/ECONNREFUSED/i.test(raw)) {
    return "目标端口拒绝连接，请检查 SMTP 服务器和端口号是否正确";
  }
  if (/wrong version number|SSL routines|packet length too long/i.test(raw)) {
    return "加密方式与端口不匹配：465 端口通常选 SSL/TLS，587 端口通常选 STARTTLS";
  }
  if (/SMTP 550|SMTP 553|5\.7\.1/i.test(raw)) {
    return `发件被服务器拒绝（${raw}），请检查发件邮箱与认证账号一致，并已加入亚马逊白名单`;
  }
  return raw;
}

function encodeRfc2047(text: string): string {
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function wrapBase64(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return lines.join("\r\n");
}

export async function verifyKindleSmtp(
  config: Pick<KindleSettingsRaw, "from" | "smtpHost" | "smtpPort" | "smtpSecurity" | "password">,
): Promise<{ ok: true; latencyMs: number } | { ok: false; message: string }> {
  const started = Date.now();
  let conn: SimpleSmtpConnection | null = null;
  try {
    const from = validateEmailAddress(config.from, "发件邮箱");
    const host = validateSmtpHost(config.smtpHost);
    const port = validateSmtpPort(config.smtpPort);
    const pass = assertCleanHeaderValue(config.password, "邮箱授权码");
    if (!pass) {
      return { ok: false, message: "请先输入邮箱 SMTP 授权码" };
    }
    conn = await SimpleSmtpConnection.connect(host, port, config.smtpSecurity);
    await authenticateSmtp(conn, from, pass);
    return { ok: true, latencyMs: Math.max(1, Date.now() - started) };
  } catch (error) {
    return { ok: false, message: mapFriendlySmtpError(error) };
  } finally {
    conn?.close();
  }
}

export async function sendBookViaKindleSmtp(
  config: KindleSettingsRaw,
  filePath: string,
): Promise<{ output: string }> {
  const resolved = path.resolve(filePath.trim());
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`找不到本地电子书文件：${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (stat.size > MAX_ATTACHMENT_BYTES) {
    throw new Error("电子书文件超过 50 MB，超出亚马逊 Send to Kindle 附件上限");
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!ALLOWED_BOOK_EXTS.has(ext)) {
    throw new Error(`Kindle 邮件推送暂不支持 ${ext || "未知"} 格式，请使用 EPUB / PDF / MOBI / AZW3 / TXT`);
  }

  const to = validateEmailAddress(config.to, "Kindle 收件邮箱");
  const from = validateEmailAddress(config.from, "发件邮箱");
  const host = validateSmtpHost(config.smtpHost);
  const port = validateSmtpPort(config.smtpPort);
  const pass = assertCleanHeaderValue(config.password, "邮箱授权码");
  if (!pass) {
    throw new Error("尚未保存发件邮箱 SMTP 授权码，请先在「连接与偏好」完成 Kindle 推送配置");
  }

  const fileName = path.basename(resolved);
  const encodedFileName = encodeRfc2047(fileName);
  const mimeType = MIME_BY_EXT[ext] ?? "application/octet-stream";
  const attachmentB64 = wrapBase64(fs.readFileSync(resolved).toString("base64"));
  const boundary = `----=_DiandianKindle_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const headers = [
    `From: <${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeRfc2047(`Send to Kindle: ${fileName}`)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2, 10)}@diandianreading.local>`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];

  const message = [
    ...headers,
    "",
    `--${boundary}`,
    `Content-Type: text/plain; charset="utf-8"`,
    `Content-Transfer-Encoding: 8bit`,
    "",
    `Sent via 点点读书 (${fileName})`,
    "",
    `--${boundary}`,
    `Content-Type: ${mimeType}; name="${encodedFileName}"`,
    `Content-Transfer-Encoding: base64`,
    `Content-Disposition: attachment; filename="${encodedFileName}"`,
    "",
    attachmentB64,
    "",
    `--${boundary}--`,
  ].join("\r\n");

  let conn: SimpleSmtpConnection | null = null;
  try {
    conn = await SimpleSmtpConnection.connect(host, port, config.smtpSecurity);
    await authenticateSmtp(conn, from, pass);
    await conn.command(`MAIL FROM:<${from}>`, [250]);
    await conn.command(`RCPT TO:<${to}>`, [250, 251]);
    await conn.command("DATA", [354]);
    await conn.sendDataBody(message, 90_000);
    return {
      output: `已将《${path.basename(fileName, ext)}》推送至 ${to}`,
    };
  } catch (error) {
    throw new Error(mapFriendlySmtpError(error));
  } finally {
    conn?.close();
  }
}
