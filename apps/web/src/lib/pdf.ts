/**
 * pdfjs-dist glue behind a small engine interface so the reader UI (and its
 * jsdom tests) never import pdf.js directly.
 *
 * CSP/Trusted Types posture (see apps/web/README.md for the meta changes):
 * - the worker is our own bundled same-origin asset, allowed by
 *   `worker-src 'self'`;
 * - under `require-trusted-types-for 'script'` the Worker constructor needs a
 *   TrustedScriptURL, so exactly one policy (`pdfjs-worker`) is registered and
 *   it only ever accepts the bundled worker asset URL;
 * - `useWasm: false` keeps pdf.js off WebAssembly compilation, which would
 *   need `script-src 'wasm-unsafe-eval'` in the worker's CSP; pdf.js v6 has
 *   no `new Function`/eval font path, so no `unsafe-eval` anywhere;
 * - the PDF bytes are fetched by our API client and passed as data, so pdf.js
 *   performs no network fetches of its own (no cMap/standard-font URLs are
 *   configured; see README for the fidelity trade-off).
 */

export interface PdfPageHandle {
  /** CSS pixel size of the page at scale 1. */
  readonly width: number;
  readonly height: number;
  render(canvas: HTMLCanvasElement, scale: number): Promise<void>;
  /**
   * Render the selectable text layer into `container`; resolves false when a
   * text layer is unavailable for this page/document.
   */
  renderTextLayer(container: HTMLElement, scale: number): Promise<boolean>;
}

export interface PdfDocumentHandle {
  readonly pageCount: number;
  getPage(pageNumber: number): Promise<PdfPageHandle>;
  destroy(): Promise<void>;
}

export interface PdfEngine {
  open(data: ArrayBuffer): Promise<PdfDocumentHandle>;
}

interface TrustedTypePolicyLike {
  createScriptURL(input: string): unknown;
}

interface TrustedTypesLike {
  createPolicy(
    name: string,
    rules: { createScriptURL: (input: string) => string },
  ): TrustedTypePolicyLike;
}

let sharedWorker: Worker | null = null;

function workerScriptTarget(workerUrl: string): string {
  const trustedTypes = (globalThis as { trustedTypes?: TrustedTypesLike }).trustedTypes;
  if (trustedTypes === undefined) {
    return workerUrl;
  }
  const policy = trustedTypes.createPolicy("pdfjs-worker", {
    createScriptURL: (input: string): string => {
      if (input !== workerUrl) {
        throw new Error("pdfjs-worker policy only accepts the bundled worker asset");
      }
      return input;
    },
  });
  // The DOM Worker constructor accepts TrustedScriptURL at runtime; the
  // TypeScript lib signature predates Trusted Types.
  return policy.createScriptURL(workerUrl) as string;
}

async function ensureWorker(): Promise<Worker> {
  if (sharedWorker === null) {
    const workerModule = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    sharedWorker = new Worker(workerScriptTarget(workerModule.default), { type: "module" });
  }
  return sharedWorker;
}

export function createPdfjsEngine(): PdfEngine {
  return {
    async open(data: ArrayBuffer): Promise<PdfDocumentHandle> {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerPort = await ensureWorker();
      const task = pdfjs.getDocument({
        data: new Uint8Array(data),
        disableAutoFetch: true,
        // No wasm side-loading: WebAssembly compilation would additionally
        // require `script-src 'wasm-unsafe-eval'` in the worker's CSP. The
        // trade-off (JPX/ICC-heavy PDFs may render without those images) is
        // documented in the README.
        useWasm: false,
        useWorkerFetch: false,
      });
      const document = await task.promise;
      return {
        pageCount: document.numPages,
        async getPage(pageNumber: number): Promise<PdfPageHandle> {
          const page = await document.getPage(pageNumber);
          const baseViewport = page.getViewport({ scale: 1 });
          return {
            width: baseViewport.width,
            height: baseViewport.height,
            async render(canvas: HTMLCanvasElement, scale: number): Promise<void> {
              const outputScale =
                typeof window !== "undefined" && window.devicePixelRatio > 0
                  ? window.devicePixelRatio
                  : 1;
              const viewport = page.getViewport({ scale });
              canvas.width = Math.floor(viewport.width * outputScale);
              canvas.height = Math.floor(viewport.height * outputScale);
              canvas.style.width = `${Math.floor(viewport.width)}px`;
              canvas.style.height = `${Math.floor(viewport.height)}px`;
              const renderViewport =
                outputScale === 1 ? viewport : page.getViewport({ scale: scale * outputScale });
              await page.render({ canvas, viewport: renderViewport }).promise;
            },
            async renderTextLayer(container: HTMLElement, scale: number): Promise<boolean> {
              try {
                const viewport = page.getViewport({ scale });
                container.style.setProperty("--scale-factor", String(scale));
                const layer = new pdfjs.TextLayer({
                  textContentSource: page.streamTextContent(),
                  container,
                  viewport,
                });
                await layer.render();
                return container.childNodes.length > 0;
              } catch {
                return false;
              }
            },
          };
        },
        async destroy(): Promise<void> {
          await task.destroy();
        },
      };
    },
  };
}
