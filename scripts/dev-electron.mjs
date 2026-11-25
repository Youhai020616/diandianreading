import { spawn } from "node:child_process";
import net from "node:net";

const DEV_URL = "http://127.0.0.1:5173";

function waitForPort(port, host = "127.0.0.1", timeoutMs = 30_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ port, host });
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`Timed out waiting for ${host}:${port}`));
          return;
        }
        setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

const vite = spawn("pnpm", ["exec", "vite"], {
  stdio: "inherit",
  env: process.env,
});

const cleanup = () => {
  if (!vite.killed) vite.kill("SIGTERM");
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

try {
  await waitForPort(5173);
  const electron = spawn("pnpm", ["exec", "electron", "."], {
    stdio: "inherit",
    env: {
      ...process.env,
      DIANDIAN_DEV_SERVER_URL: DEV_URL,
    },
  });
  electron.on("exit", (code) => {
    cleanup();
    process.exit(code ?? 0);
  });
} catch (error) {
  console.error(error);
  cleanup();
  process.exit(1);
}
