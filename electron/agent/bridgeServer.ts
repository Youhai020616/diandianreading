import crypto from "node:crypto";
import http from "node:http";

export class BridgeRejection extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface BridgeRequest {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

export class LocalBridgeServer {
  private server: http.Server | null = null;
  private port = 0;
  readonly token: string;
  private readonly handler: (req: BridgeRequest) => Promise<unknown>;

  constructor(handler: (req: BridgeRequest) => Promise<unknown>) {
    this.handler = handler;
    this.token = crypto.randomBytes(24).toString("hex");
  }

  get endpoint(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<string> {
    if (this.server) return this.endpoint;
    this.server = http.createServer((req, res) => {
      const auth = req.headers.authorization ?? "";
      const expected = `Bearer ${this.token}`;
      const authBuf = Buffer.from(auth, "utf8");
      const expectedBuf = Buffer.from(expected, "utf8");
      if (authBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(authBuf, expectedBuf)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let aborted = false;

      req.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
          aborted = true;
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "payload too large" }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        if (aborted) return;
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        let parsedBody: Record<string, unknown> = {};
        if (raw) {
          try {
            const val = JSON.parse(raw) as unknown;
            if (!val || typeof val !== "object" || Array.isArray(val)) {
              throw new Error("body must be JSON object");
            }
            parsedBody = val as Record<string, unknown>;
          } catch {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "invalid JSON object body" }));
            return;
          }
        }

        const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        this.handler({
          method: req.method ?? "POST",
          path: parsedUrl.pathname,
          body: parsedBody,
        })
          .then((data) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, data }));
          })
          .catch((error: unknown) => {
            const status = error instanceof BridgeRejection ? error.status : 500;
            const message = error instanceof Error ? error.message : String(error);
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: message }));
          });
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(0, "127.0.0.1", () => {
        const addr = this.server?.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
          resolve();
        } else {
          reject(new Error("Failed to bind loopback bridge server"));
        }
      });
    });
    return this.endpoint;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const target = this.server;
    this.server = null;
    this.port = 0;
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
}
