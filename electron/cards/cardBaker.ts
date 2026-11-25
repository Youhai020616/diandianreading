import crypto from "node:crypto";
import { BrowserWindow, protocol, session, type CustomScheme } from "electron";
import { CARD_HEIGHT, CARD_WIDTH, renderReadingCardHtml, type ReadingCardPayload } from "./cardTemplates";
import { renderCarouselSlideHtml, type CarouselDeckPayload } from "./carouselTemplates";
import {
  CONCEPT_CARD_HEIGHT,
  CONCEPT_CARD_WIDTH,
  renderConceptVisualHtml,
  type ConceptVisualPayload,
} from "./conceptVisualTemplates";
import { renderMonthlyPosterHtml, type MonthlyPosterPayload } from "./posterTemplates";

export const CARD_PROTOCOL_SCHEME = "htmlcard";
export const CARD_SANDBOX_PARTITION = "persist:diandian-htmlcard-sandbox";

export const PRIVILEGED_CARD_SCHEMES: CustomScheme[] = [
  {
    scheme: CARD_PROTOCOL_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: false,
      corsEnabled: false,
      stream: false,
    },
  },
];

export const CARD_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data: local:; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none';";

export class CardBakerService {
  private readonly documents = new Map<string, string>();
  private protocolInstalled = false;

  installProtocol(): void {
    if (this.protocolInstalled) return;
    this.protocolInstalled = true;

    const sandboxSession = session.fromPartition(CARD_SANDBOX_PARTITION);

    // Strictly deny all external network egress from the card baker sandbox.
    sandboxSession.webRequest.onBeforeRequest((details, callback) => {
      if (details.url.startsWith(`${CARD_PROTOCOL_SCHEME}://`)) {
        callback({ cancel: false });
      } else {
        callback({ cancel: true });
      }
    });

    sandboxSession.protocol.handle(CARD_PROTOCOL_SCHEME, (request) => {
      try {
        const parsed = new URL(request.url);
        if (parsed.hostname !== "document") {
          return new Response("Not Found", { status: 404 });
        }
        const docId = parsed.pathname.replace(/^\/+/, "");
        const html = this.documents.get(docId);
        if (!html) {
          return new Response("Document Expired", { status: 404 });
        }
        return new Response(html, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": CARD_CSP,
            "cache-control": "no-store",
          },
        });
      } catch {
        return new Response("Bad Request", { status: 400 });
      }
    });
  }

  /**
   * Bake an arbitrary sanitized HTML card/slide/poster into a crisp 2x Retina PNG
   * buffer using a fresh transparent offscreen BrowserWindow (network blocked).
   */
  async bakeHtmlToPng(
    html: string,
    options: { width?: number; height?: number; scale?: number } = {},
  ): Promise<{ png: Buffer; width: number; height: number }> {
    this.installProtocol();

    const width = Math.max(320, Math.min(1200, options.width ?? CARD_WIDTH));
    const height = Math.max(320, Math.min(1600, options.height ?? CARD_HEIGHT));
    const docId = crypto.randomUUID();
    this.documents.set(docId, html);

    let win: BrowserWindow | null = null;
    try {
      const scale = options.scale ?? 2;
      const targetWidth = Math.round(width * scale);
      const targetHeight = Math.round(height * scale);

      win = new BrowserWindow({
        width: targetWidth,
        height: targetHeight,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        hasShadow: false,
        resizable: false,
        enableLargerThanScreen: true,
        paintWhenInitiallyHidden: true,
        webPreferences: {
          partition: CARD_SANDBOX_PARTITION,
          offscreen: true,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          javascript: false,
          backgroundThrottling: false,
        },
      });

      win.webContents.setFrameRate(30);
      let latestPng: Buffer | null = null;
      let latestSize = { width: targetWidth, height: targetHeight };
      let paintResolve: (() => void) | null = null;

      win.webContents.on("paint", (_event, _dirty, image) => {
        const size = image.getSize();
        if (size.width > 0 && size.height > 0) {
          latestPng = image.toPNG();
          latestSize = size;
          if (paintResolve) {
            const done = paintResolve;
            paintResolve = null;
            done();
          }
        }
      });

      await win.loadURL(`${CARD_PROTOCOL_SCHEME}://document/${docId}`);
      win.webContents.setZoomFactor(scale);
      win.webContents.invalidate();

      await new Promise<void>((resolve) => {
        paintResolve = resolve;
        setTimeout(resolve, 350);
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      latestPng = null;
      win.webContents.invalidate();
      await new Promise<void>((resolve) => {
        paintResolve = resolve;
        setTimeout(resolve, 450);
      });

      const png = latestPng as Buffer | null;
      if (!png || png.length === 0) {
        throw new Error("离屏卡片渲染返回了空图像");
      }
      return { png, width: latestSize.width, height: latestSize.height };
    } finally {
      this.documents.delete(docId);
      if (win && !win.isDestroyed()) {
        win.destroy();
      }
    }
  }

  async bakeCardToPng(
    payload: ReadingCardPayload,
    options: { width?: number; height?: number; scale?: number } = {},
  ): Promise<{ png: Buffer; width: number; height: number }> {
    return this.bakeHtmlToPng(renderReadingCardHtml(payload), options);
  }

  async bakeCarouselSlideToPng(
    deck: CarouselDeckPayload,
    slideIndex: number,
    options: { width?: number; height?: number; scale?: number } = {},
  ): Promise<{ png: Buffer; width: number; height: number }> {
    return this.bakeHtmlToPng(renderCarouselSlideHtml(deck, slideIndex), options);
  }

  async bakePosterToPng(
    payload: MonthlyPosterPayload,
    options: { width?: number; height?: number; scale?: number } = {},
  ): Promise<{ png: Buffer; width: number; height: number }> {
    return this.bakeHtmlToPng(renderMonthlyPosterHtml(payload), options);
  }

  async bakeConceptVisualToPng(
    payload: ConceptVisualPayload,
    options: { width?: number; height?: number; scale?: number } = {},
  ): Promise<{ png: Buffer; width: number; height: number }> {
    return this.bakeHtmlToPng(renderConceptVisualHtml(payload), {
      width: options.width ?? CONCEPT_CARD_WIDTH,
      height: options.height ?? CONCEPT_CARD_HEIGHT,
      scale: options.scale ?? 2,
    });
  }
}

export function registerCardPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged(PRIVILEGED_CARD_SCHEMES);
}
