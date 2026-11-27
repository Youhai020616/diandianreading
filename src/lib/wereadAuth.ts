export interface WeReadAuthRequest {
  bookTitle?: string;
  /** true: the binding expired; false: never bound; omitted: unknown. */
  expired?: boolean;
  onAuthenticated?: () => void | Promise<void>;
}

/**
 * Detect whether a `router.importWeRead` failure is due to an unbound or expired
 * WeRead E-Ink upload session so the UI can pop up QR re-auth and auto-retry seamlessly.
 */
export function isWeReadAuthRequiredError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return /连接微信读书账号|not logged in|session expired|weread login/i.test(msg);
}
