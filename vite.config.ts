/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig, type PluginOption } from "vite";

const CSP_META =
  "default-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'; "
  + "script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; "
  + "font-src 'self' data:; connect-src 'self'; frame-src 'self'";

function injectCspMeta(): PluginOption {
  return {
    name: "diandian:inject-csp-meta",
    apply: "build",
    transformIndexHtml(html, context) {
      // The offline EPUB frame has its own stricter network and chapter policy.
      if (context.path.endsWith("/src/reader/frame.html")) return html;
      return {
        html,
        tags: [
          {
            tag: "meta",
            attrs: { "http-equiv": "Content-Security-Policy", content: CSP_META },
            injectTo: "head-prepend",
          },
        ],
      };
    },
  };
}

export default defineConfig({
  plugins: [react(), injectCspMeta()],
  base: "./",
  build: {
    target: "es2022",
    rolldownOptions: { input: ["index.html", "src/reader/frame.html"] },
    outDir: "dist",
    sourcemap: false,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
  },
});
