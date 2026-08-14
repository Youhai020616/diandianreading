/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig, type PluginOption } from "vite";

/**
 * CSP <meta> injected only into the production build: the Vite dev server
 * needs inline preamble scripts for react-refresh, which this policy
 * intentionally forbids.
 *
 * R3 delta vs. the legacy `static/index.html` policy (each relaxation is the
 * minimum pdf.js requires; see apps/web/README.md "CSP changes for R3"):
 * - `worker-src 'none'` -> `worker-src 'self'`: pdf.js renders inside a
 *   dedicated Worker whose script is our own bundled same-origin asset.
 *   blob:/data: workers remain forbidden.
 * - `trusted-types 'none'` -> `trusted-types pdfjs-worker`: under
 *   `require-trusted-types-for 'script'` the Worker constructor demands a
 *   TrustedScriptURL; `src/lib/pdf.ts` registers exactly one policy that only
 *   accepts the bundled worker asset URL. Enforcement itself
 *   (`require-trusted-types-for 'script'`) is unchanged.
 * Everything else is untouched: no inline, no remote, no `unsafe-eval`
 * (pdf.js runs with `isEvalSupported: false`), `frame-src 'none'` stays,
 * img-src stays 'self' (canvas rendering references no blob: image URLs).
 */
const CSP_META =
  "default-src 'none'; base-uri 'none'; object-src 'none'; form-action 'self'; "
  + "script-src 'self'; script-src-attr 'none'; style-src 'self'; style-src-attr 'none'; "
  + "img-src 'self'; font-src 'none'; connect-src 'self'; media-src 'none'; frame-src 'none'; "
  + "worker-src 'self'; manifest-src 'none'; trusted-types pdfjs-worker; require-trusted-types-for 'script'";

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
  // Relative asset URLs let FastAPI host the build from any mount path without
  // rewriting the HTML.
  base: "./",
  build: {
    target: "es2022",
    sourcemap: false,
    // Single-page, single-entry app: no dynamic imports, so the module preload
    // polyfill (which uses runtime-created <link> nodes) is unnecessary.
    modulePreload: { polyfill: false },
  },
  server: {
    // Source-development convenience only: proxy API and SSE calls to the
    // local Python runtime. Mutating endpoints may still be
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
