import { ipcMain as rawIpcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { matchesTrustedAppUrl } from "./urlMatch";

export { matchesTrustedAppUrl };

export class TrustedIpcRegistry {
  private readonly allowed = new Map<number, { window: BrowserWindow; url: string }>();

  registerWindow(window: BrowserWindow, trustedUrl: string): void {
    const webContentsId = window.webContents.id;
    this.allowed.set(webContentsId, { window, url: trustedUrl });
    window.once("closed", () => {
      if (this.allowed.get(webContentsId)?.window === window) {
        this.allowed.delete(webContentsId);
      }
    });
  }

  assertTrusted(event: IpcMainInvokeEvent | IpcMainEvent): BrowserWindow {
    const entry = this.allowed.get(event.sender.id);
    if (
      !entry
      || entry.window.isDestroyed()
      || event.sender !== entry.window.webContents
      || !event.senderFrame
      || event.senderFrame !== event.sender.mainFrame
      || !matchesTrustedAppUrl(event.senderFrame.url, entry.url)
    ) {
      throw new Error("IPC rejected: untrusted sender window or frame");
    }
    return entry.window;
  }

  handle<TArgs extends unknown[], TResult>(
    channel: string,
    listener: (window: BrowserWindow, ...args: TArgs) => TResult | Promise<TResult>,
  ): void {
    rawIpcMain.handle(channel, (event, ...args) => {
      const win = this.assertTrusted(event);
      return listener(win, ...(args as TArgs));
    });
  }

  on<TArgs extends unknown[]>(
    channel: string,
    listener: (window: BrowserWindow, ...args: TArgs) => void,
  ): void {
    rawIpcMain.on(channel, (event, ...args) => {
      try {
        const win = this.assertTrusted(event);
        listener(win, ...(args as TArgs));
      } catch {
        // Silently ignore untrusted fire-and-forget IPC events.
      }
    });
  }
}
