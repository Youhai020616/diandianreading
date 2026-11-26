/**
 * Types shared by the renderer and the main process, split by area under ./desktop/.
 * Import from here; the window.diandian API shape is DesktopBridgeApi.
 */
import type { DesktopBridgeApi } from "./desktop/bridge";

export * from "./desktop/agent";
export * from "./desktop/library";
export * from "./desktop/cards";
export * from "./desktop/browser";
export * from "./desktop/router";
export * from "./desktop/reader";
export * from "./desktop/app";
export * from "./desktop/bridge";

declare global {
  interface Window {
    diandian: DesktopBridgeApi;
  }
}
