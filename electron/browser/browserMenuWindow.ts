import { BrowserWindow, screen } from "electron";
import type { TrustedIpcRegistry } from "../security/trustedIpc";

export interface BrowserMenuPayload {
  url: string;
  zoomPercent: number;
  theme: "light" | "dark";
}

export interface BrowserMenuWindowOptions {
  preloadPath: string;
  getEntryUrl: () => string;
  getParentWindow: () => BrowserWindow | null;
  ipc: TrustedIpcRegistry;
  onAction: (action: { kind: "import-cookie" | "open-settings" | "notified"; message?: string }) => void;
}

const MENU_WIDTH = 276;
const MENU_HEIGHT = 248;

/**
 * Lightweight frameless transparent BrowserWindow that paints our custom
 * design-system React menu cleanly ABOVE native WebContentsView with zero
 * flicker or webpage blanking.
 */
export class BrowserMenuWindowController {
  private readonly options: BrowserMenuWindowOptions;
  private win: BrowserWindow | null = null;
  private readyPromise: Promise<BrowserWindow> | null = null;

  constructor(options: BrowserMenuWindowOptions) {
    this.options = options;
  }

  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.win && !this.win.isDestroyed()) {
      return this.win;
    }
    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.readyPromise = (async () => {
      const entryUrl = this.options.getEntryUrl();
      const menuUrl = `${entryUrl.replace(/#.*$/, "")}#browser-menu`;
      const parent = this.options.getParentWindow() ?? undefined;

      const win = new BrowserWindow({
        width: MENU_WIDTH,
        height: MENU_HEIGHT,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        hasShadow: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        parent,
        webPreferences: {
          preload: this.options.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });

      if (process.platform === "darwin") {
        win.setHasShadow(false);
        win.setAlwaysOnTop(true, "pop-up-menu");
      } else {
        win.setAlwaysOnTop(true);
      }

      this.win = win;
      this.options.ipc.registerWindow(win, entryUrl);
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

      win.on("blur", () => {
        if (!win.isDestroyed() && win.isVisible()) {
          win.hide();
        }
      });

      win.on("closed", () => {
        if (this.win === win) {
          this.win = null;
          this.readyPromise = null;
        }
      });

      await win.loadURL(menuUrl);
      return win;
    })();

    return this.readyPromise;
  }

  async openAt(anchorRightX: number, anchorBottomY: number, payload: BrowserMenuPayload): Promise<void> {
    const win = await this.ensureWindow();
    if (win.isDestroyed()) return;

    // Toggle closed if already visible
    if (win.isVisible()) {
      win.hide();
      return;
    }

    const parent = this.options.getParentWindow();
    const contentBounds = parent && !parent.isDestroyed() ? parent.getContentBounds() : { x: 0, y: 0, width: 1200, height: 800 };
    const zoom = parent && !parent.isDestroyed() ? parent.webContents.getZoomFactor() : 1;

    const screenAnchorRight = contentBounds.x + Math.round(anchorRightX * zoom);
    const screenAnchorBottom = contentBounds.y + Math.round(anchorBottomY * zoom);

    const display = screen.getDisplayNearestPoint({ x: screenAnchorRight, y: screenAnchorBottom });
    const wa = display.workArea;

    const rawX = screenAnchorRight - MENU_WIDTH + 6;
    const rawY = screenAnchorBottom + 4;
    const clampedX = Math.max(wa.x + 8, Math.min(wa.x + wa.width - MENU_WIDTH - 8, rawX));
    const clampedY = Math.max(wa.y + 8, Math.min(wa.y + wa.height - MENU_HEIGHT - 8, rawY));

    win.webContents.send("browser-menu:data", payload);
    win.setBounds(
      {
        x: Math.round(clampedX),
        y: Math.round(clampedY),
        width: MENU_WIDTH,
        height: MENU_HEIGHT,
      },
      false,
    );
    win.setHasShadow(false);
    win.show();
    win.focus();
  }

  updateData(payload: Partial<BrowserMenuPayload>): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send("browser-menu:data", payload);
    }
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) {
      this.win.hide();
    }
  }

  dispatchToMain(action: { kind: "import-cookie" | "open-settings" | "notified"; message?: string }): void {
    this.options.onAction(action);
  }

  dispose(): void {
    const target = this.win;
    this.win = null;
    this.readyPromise = null;
    if (target && !target.isDestroyed()) {
      target.destroy();
    }
  }
}
