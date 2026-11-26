/** Shapes exchanged with the heartleo/zlib CLI and the renderer. */
import type { QrMatrix } from "../browser/cookieCodec";

export interface ZlibStatus {
  installed: boolean;
  binaryPath: string | null;
  version: string | null;
  supportsMeta: boolean;
  installHint: string;
}

export interface ZlibDomainHealth {
  domain: string;
  status: string;
  httpStatus: number;
}

export interface ConnectionsSnapshot {
  status: ZlibStatus;
  zlib: {
    loggedIn: boolean;
    userName: string;
    dailyRemaining: number | null;
    dailyAllowed: number | null;
    currentDomain: string;
    error?: string;
  };
  weread: {
    loggedIn: boolean;
    name: string;
    vid: string;
    error?: string;
  };
  kindle: {
    configured: boolean;
    to: string;
    from: string;
    smtpHost: string;
    smtpPort: string;
    smtpSecurity: string;
  };
}

export type WeReadQrEvent =
  | { kind: "starting" }
  | { kind: "qr"; qr: QrMatrix; hint: string }
  | { kind: "success"; name: string; vid: string }
  | { kind: "error"; message: string }
  | { kind: "canceled" };

export interface ZlibBookItem {
  bookRef: string;
  id: string;
  hash: string;
  title: string;
  author: string;
  publisher: string;
  coverUrl: string;
  extension: string;
  size: string;
  year: string;
  language: string;
  isbn?: string;
  url?: string;
  rating?: string;
  description?: string;
}

export interface LocalBookMetadata {
  title: string;
  authors: string;
  publisher: string;
  date: string;
  isbn: string;
  zlibBookRef?: string;
  language: string;
  tags: string;
  comments: string;
  source?: string;
  embeddedCover?: string;
}
