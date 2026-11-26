/** Book sources (Z-Library CLI), downloads, Kindle and WeRead import. */

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

export interface PublicKindleSettings {
  configured: boolean;
  to: string;
  from: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: "tls" | "starttls";
  hasPassword: boolean;
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

export interface QrMatrix {
  size: number;
  rows: boolean[][];
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

export interface LocalBookImportResult {
  added: number;
  existing: number;
  failures: { name: string; message: string }[];
  canceled: boolean;
}

export interface ZlibDownloadHistoryPage {
  books: (ZlibBookItem & { unavailableReason?: string })[];
  localRefs: string[];
  hasMore: boolean;
}

export interface DownloadedBookFile {
  filePath: string;
  fileName: string;
  format: string;
  sizeBytes: number;
  modifiedAt: number;
  fileRevision?: string;
}

export type DownloadCoverHint = Partial<Pick<ZlibBookItem, "title" | "author" | "isbn" | "publisher" | "year" | "coverUrl">>;

export interface WeReadImportResult {
  output: string;
  alreadyExisted: boolean;
}

export interface LocalBookMetadata {
  title: string;
  authors: string;
  publisher: string;
  date: string;
  isbn: string;
  language: string;
  tags: string;
  comments: string;
  source?: string;
}
