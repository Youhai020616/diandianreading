/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig, type PluginOption } from "vite";

/**
 * Byte-identical copy of the CSP <meta> shipped in the legacy
 * `src/diandianreading/interfaces/web/static/index.html`. It is injected only
 * into the production build: the Vite dev server needs inline preamble
 * scripts for react-refresh, which this policy intentionally forbids.
 */
const LEGACY_CSP_META =
  "default-src 'none'; base-uri 'none'; object-src 'none'; form-action 'self'; "
  + "script-src 'self'; script-src-attr 'none'; style-src 'self'; style-src-attr 'none'; "
  + "img-src 'self'; font-src 'none'; connect-src 'self'; media-src 'none'; frame-src 'none'; "
  + "worker-src 'none'; manifest-src 'none'; trusted-types 'none'; require-trusted-types-for 'script'";

function injectCspMeta(): PluginOption {
  return {
    name: "diandian:inject-csp-meta",
    apply: "build",
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: "meta",
            attrs: { "http-equiv": "Content-Security-Policy", content: LEGACY_CSP_META },
            injectTo: "head-prepend",
          },
        ],
      };
    },
  };
}

export default defineConfig({
  plugins: [react(), injectCspMeta()],
  // Relative asset URLs so the FastAPI app (or the Tauri shell later) can host
  // the build from any mount path without rewriting the HTML.
  base: "./",
  build: {
    target: "es2022",
    sourcemap: false,
    // Single-page, single-entry app: no dynamic imports, so the module preload
    // polyfill (which uses runtime-created <link> nodes) is unnecessary.
    modulePreload: { polyfill: false },
  },
  server: {
    // Source-development convenience only (§7.1 desktop plan): proxy API and
    // SSE calls to the local Python runtime. Mutating endpoints may still be
    // rejected by the Python Origin/Host boundary when running cross-port;
    // full verification happens against the built assets served same-origin.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    restoreMocks: true,
  },
});
