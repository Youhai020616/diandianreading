/** After the new document commits, reveal the tab at most this long later (dom-ready may come sooner). */
export const TAB_REVEAL_AFTER_COMMIT_MS = 450;
/** Safety net if a navigation never settles (hung network); keeps the stale page hidden meanwhile. */
export const TAB_REVEAL_SAFETY_MS = 8000;
/** Chromium's ERR_ABORTED: a navigation was cancelled (replaced, stopped, or turned into a download). */
const ERR_ABORTED = -3;

/**
 * Decides when a tab that is navigating to another site may be shown again.
 *
 * While a cross-site navigation is pending the previous page stays loaded, so its late
 * dom-ready / stop events must not reveal it (it would flash before the new site). The tab is
 * revealed shortly after the new document commits, on its dom-ready, when the navigation fails,
 * or when loading ends without a commit — then the old page is what the user should see.
 */
export class TabRevealGate {
  private awaitingCommit = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    public ready: boolean,
    private readonly onReveal: () => void,
    private readonly timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
  ) {}

  /** A navigation to another site starts: hide the tab until the new page can be shown. */
  defer(): void {
    this.ready = false;
    this.awaitingCommit = true;
    this.schedule(TAB_REVEAL_SAFETY_MS);
  }

  /** The main frame committed a new document (did-navigate). */
  committed(): void {
    if (!this.awaitingCommit) return;
    this.awaitingCommit = false;
    if (!this.ready) this.schedule(TAB_REVEAL_AFTER_COMMIT_MS);
  }

  domReady(): void {
    if (!this.awaitingCommit) this.reveal();
  }

  failed(errorCode: number, isMainFrame: boolean): void {
    // An abort here is usually the old load being replaced; whether the new one also ended is
    // decided when loading stops.
    if (!isMainFrame || errorCode === ERR_ABORTED) return;
    this.awaitingCommit = false;
    this.reveal();
  }

  /** Loading stopped (did-stop-loading, or loadURL settled); `stillLoading` is webContents.isLoading(). */
  stopped(stillLoading: boolean): void {
    // Nothing is loading and nothing committed: the navigation was stopped, blocked or became a
    // download, so the previous page remains and should be visible again.
    if (this.awaitingCommit && !stillLoading) this.awaitingCommit = false;
    if (!this.awaitingCommit) this.reveal();
  }

  reveal(): void {
    this.cancelTimer();
    this.awaitingCommit = false;
    if (this.ready) return;
    this.ready = true;
    this.onReveal();
  }

  dispose(): void {
    this.cancelTimer();
  }

  private schedule(delayMs: number): void {
    this.cancelTimer();
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      this.reveal();
    }, delayMs);
  }

  private cancelTimer(): void {
    if (this.timer) this.timers.clear(this.timer);
    this.timer = undefined;
  }
}
