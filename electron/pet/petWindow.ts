import path from "node:path";
import { BrowserWindow, screen } from "electron";
import type { TrustedIpcRegistry } from "../security/trustedIpc";

export const PET_COLLAPSED_SIZE = { width: 184, height: 158 } as const;
export const PET_NUDGE_SIZE = { width: 356, height: 378 } as const;
export const PET_EXPANDED_SIZE = { width: 396, height: 584 } as const;

export type PetWindowMode = "collapsed" | "nudge" | "expanded";

export interface PetWindowState {
  visible: boolean;
  expanded: boolean;
  mode: PetWindowMode;
  showJumpToMain: boolean;
}

export interface MainWindowProximity {
  active: boolean;
  bounds: { x: number; y: number; width: number; height: number } | null;
}

export interface PetAnchorPosition {
  right: number;
  bottom: number;
}

export interface PetWindowOptions {
  preloadPath: string;
  getEntryUrl: () => string;
  ipc: TrustedIpcRegistry;
  getSavedAnchor?: () => PetAnchorPosition | null;
  saveAnchor?: (anchor: PetAnchorPosition) => void;
  onStateChanged: (state: PetWindowState) => void;
}

interface DragOrigin {
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  lastX: number;
  lastY: number;
}

export class PetWindowController {
  private readonly options: PetWindowOptions;
  private win: BrowserWindow | null = null;
  private mode: PetWindowMode = "collapsed";
  private visible = false;
  private mainActive = true;
  private mainBounds: { x: number; y: number; width: number; height: number } | null = null;
  private lastShowJumpToMain = false;
  private dragOrigin: DragOrigin | null = null;
  private dragTimer: NodeJS.Timeout | null = null;

  constructor(options: PetWindowOptions) {
    this.options = options;
  }

  private computeShowJumpToMain(): boolean {
    if (!this.mainActive || !this.mainBounds) return true;
    const win = this.getWindow();
    if (!win) return false;
    const pb = win.getBounds();
    const mb = this.mainBounds;
    const cx = pb.x + pb.width / 2;
    const cy = pb.y + pb.height / 2;
    const margin = 36;
    const isTogether =
      cx >= mb.x - margin
      && cx <= mb.x + mb.width + margin
      && cy >= mb.y - margin
      && cy <= mb.y + mb.height + margin;
    return !isTogether;
  }

  setMainWindowContext(ctx: MainWindowProximity): void {
    this.mainActive = ctx.active;
    this.mainBounds = ctx.bounds;
    const next = this.computeShowJumpToMain();
    if (next !== this.lastShowJumpToMain) {
      this.lastShowJumpToMain = next;
      this.emitState();
    }
  }

  getState(): PetWindowState {
    const showJumpToMain = this.computeShowJumpToMain();
    this.lastShowJumpToMain = showJumpToMain;
    return {
      visible: this.visible && this.win !== null && !this.win.isDestroyed(),
      expanded: this.mode === "expanded",
      mode: this.mode,
      showJumpToMain,
    };
  }

  getWindow(): BrowserWindow | null {
    if (!this.win || this.win.isDestroyed()) return null;
    return this.win;
  }

  private computeClampedTopLeft(x: number, y: number, width: number, height: number): { x: number; y: number } {
    const displays = screen.getAllDisplays();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const d of displays) {
      // Use full display bounds horizontally & bottom so the pet can reach all screen edges freely,
      // while keeping the top edge below the macOS menu bar so it never gets trapped off-screen.
      minX = Math.min(minX, d.bounds.x);
      minY = Math.min(minY, d.workArea.y);
      maxX = Math.max(maxX, d.bounds.x + d.bounds.width);
      maxY = Math.max(maxY, d.bounds.y + d.bounds.height);
    }

    if (!Number.isFinite(minX)) {
      const pd = screen.getPrimaryDisplay();
      minX = pd.bounds.x;
      minY = pd.workArea.y;
      maxX = pd.bounds.x + pd.bounds.width;
      maxY = pd.bounds.y + pd.bounds.height;
    }

    // Allow transparent padding around the puppy to cross edges so the puppy itself reaches 100% of every screen edge
    const leftBleed = this.mode === "collapsed" ? 28 : 12;
    const rightBleed = this.mode === "collapsed" ? 28 : 12;
    const topBleed = this.mode === "collapsed" ? 18 : 0;
    const bottomBleed = this.mode === "collapsed" ? 18 : 12;

    return {
      x: Math.round(Math.max(minX - leftBleed, Math.min(maxX - width + rightBleed, x))),
      y: Math.round(Math.max(minY - topBleed, Math.min(maxY - height + bottomBleed, y))),
    };
  }

  async show(): Promise<PetWindowState> {
    if (this.win && !this.win.isDestroyed()) {
      this.win.showInactive();
      this.visible = true;
      this.emitState();
      return this.getState();
    }

    const entryUrl = this.options.getEntryUrl();
    const petUrl = `${entryUrl.replace(/#.*$/, "")}#pet`;
    const initialSize =
      this.mode === "expanded"
        ? PET_EXPANDED_SIZE
        : this.mode === "nudge"
          ? PET_NUDGE_SIZE
          : PET_COLLAPSED_SIZE;
    const primaryWa = screen.getPrimaryDisplay().workArea;

    const saved = this.options.getSavedAnchor?.() ?? null;
    const rawX = saved ? saved.right - initialSize.width : primaryWa.x + primaryWa.width - initialSize.width - 28;
    const rawY = saved ? saved.bottom - initialSize.height : primaryWa.y + primaryWa.height - initialSize.height - 24;
    const pos = this.computeClampedTopLeft(rawX, rawY, initialSize.width, initialSize.height);

    const win = new BrowserWindow({
      width: initialSize.width,
      height: initialSize.height,
      x: pos.x,
      y: pos.y,
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
      alwaysOnTop: true,
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    if (process.platform === "darwin") {
      win.setHasShadow(false);
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.setAlwaysOnTop(true, "floating");
    } else {
      win.setAlwaysOnTop(true);
    }

    this.win = win;
    this.options.ipc.registerWindow(win, entryUrl);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    win.on("closed", () => {
      if (this.win === win) {
        this.stopDragTimer();
        this.win = null;
        this.visible = false;
        this.mode = "collapsed";
        this.dragOrigin = null;
        this.emitState();
      }
    });

    await win.loadURL(petUrl);
    if (!win.isDestroyed()) {
      win.setHasShadow(false);
      win.showInactive();
      this.visible = true;
      this.emitState();
    }
    return this.getState();
  }

  hide(): PetWindowState {
    this.stopDragTimer();
    this.mode = "collapsed";
    this.visible = false;
    this.dragOrigin = null;
    if (this.win && !this.win.isDestroyed()) {
      this.win.hide();
    }
    this.emitState();
    return this.getState();
  }

  async toggle(): Promise<PetWindowState> {
    if (this.getState().visible) {
      return this.hide();
    }
    return this.show();
  }

  setMode(nextMode: PetWindowMode): PetWindowState {
    this.mode = nextMode;
    const win = this.getWindow();
    if (!win) {
      this.emitState();
      return this.getState();
    }

    const oldBounds = win.getBounds();
    const target =
      this.mode === "expanded"
        ? PET_EXPANDED_SIZE
        : this.mode === "nudge"
          ? PET_NUDGE_SIZE
          : PET_COLLAPSED_SIZE;
    const anchorRight = oldBounds.x + oldBounds.width;
    const anchorBottom = oldBounds.y + oldBounds.height;

    const display = screen.getDisplayMatching(oldBounds);
    const wa = display.workArea;

    const rawX = anchorRight - target.width;
    const rawY = anchorBottom - target.height;
    const clampedX = Math.max(wa.x + 8, Math.min(wa.x + wa.width - target.width - 8, rawX));
    const clampedY = Math.max(wa.y + 8, Math.min(wa.y + wa.height - target.height - 8, rawY));

    win.setBounds(
      {
        x: Math.round(clampedX),
        y: Math.round(clampedY),
        width: target.width,
        height: target.height,
      },
      false,
    );
    win.setHasShadow(false);

    if (this.mode === "expanded") {
      win.focus();
      win.setHasShadow(false);
    }
    this.emitState();
    return this.getState();
  }

  setExpanded(nextExpanded: boolean): PetWindowState {
    return this.setMode(nextExpanded ? "expanded" : "collapsed");
  }

  private stopDragTimer(): void {
    if (this.dragTimer) {
      clearInterval(this.dragTimer);
      this.dragTimer = null;
    }
  }

  private syncDragToCursor(): void {
    const win = this.getWindow();
    const origin = this.dragOrigin;
    if (!win || !origin) {
      this.stopDragTimer();
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    const targetX = cursor.x - origin.offsetX;
    const targetY = cursor.y - origin.offsetY;
    const clamped = this.computeClampedTopLeft(targetX, targetY, origin.width, origin.height);
    if (clamped.x === origin.lastX && clamped.y === origin.lastY) return;
    origin.lastX = clamped.x;
    origin.lastY = clamped.y;
    win.setBounds(
      {
        x: clamped.x,
        y: clamped.y,
        width: origin.width,
        height: origin.height,
      },
      false,
    );
    const nextJump = this.computeShowJumpToMain();
    if (nextJump !== this.lastShowJumpToMain) {
      this.lastShowJumpToMain = nextJump;
      this.emitState();
    }
  }

  startDrag(_screenX?: number, _screenY?: number): void {
    const win = this.getWindow();
    if (!win) return;
    this.stopDragTimer();
    const b = win.getBounds();
    const cursor = screen.getCursorScreenPoint();
    this.dragOrigin = {
      offsetX: cursor.x - b.x,
      offsetY: cursor.y - b.y,
      width: b.width,
      height: b.height,
      lastX: b.x,
      lastY: b.y,
    };
    this.dragTimer = setInterval(() => this.syncDragToCursor(), 16);
  }

  dragTo(_screenX?: number, _screenY?: number): void {
    this.syncDragToCursor();
  }

  endDrag(): void {
    this.stopDragTimer();
    this.dragOrigin = null;
    const win = this.getWindow();
    if (!win) return;
    const b = win.getBounds();
    this.options.saveAnchor?.({
      right: b.x + b.width,
      bottom: b.y + b.height,
    });
    const nextJump = this.computeShowJumpToMain();
    if (nextJump !== this.lastShowJumpToMain) {
      this.lastShowJumpToMain = nextJump;
      this.emitState();
    }
  }

  moveBy(dx: number, dy: number): void {
    const win = this.getWindow();
    if (!win || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const b = win.getBounds();
    const clamped = this.computeClampedTopLeft(b.x + dx, b.y + dy, b.width, b.height);
    win.setBounds({ x: clamped.x, y: clamped.y, width: b.width, height: b.height }, false);
  }

  dispose(): void {
    this.stopDragTimer();
    const target = this.win;
    this.win = null;
    this.visible = false;
    this.dragOrigin = null;
    if (target && !target.isDestroyed()) {
      target.destroy();
    }
  }

  private emitState(): void {
    this.options.onStateChanged(this.getState());
  }
}

export function resolvePetPreloadPath(electronDistDir: string): string {
  return path.join(electronDistDir, "preload.js");
}
