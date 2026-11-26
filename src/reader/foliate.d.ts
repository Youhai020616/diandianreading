declare module "foliate-js/view.js";
declare module "foliate-js/overlayer.js" {
  export class Overlayer {
    static highlight(rects: DOMRect[], options?: { color?: string }): SVGElement;
  }
}
declare module "foliate-js/epub.js" {
  export class EPUB {
    constructor(loader: {
      loadText(name: string): Promise<string | null>;
      loadBlob(name: string, type?: string): Promise<Blob | null>;
      getSize(name: string): number;
    });
    init(): Promise<import("./foliate-types").EpubBook>;
  }
}
declare module "foliate-js/vendor/zip.js" {
  export function configure(options: { useWebWorkers: boolean }): void;
  export class BlobReader { constructor(data: Blob) }
  export interface Entry {
    filename: string;
    uncompressedSize: number;
    encrypted: boolean;
    directory: boolean;
    getData(writer: WritableStream<Uint8Array<ArrayBuffer>>, options: { checkSignature: boolean }): Promise<unknown>;
  }
  export class ZipReader {
    constructor(reader: BlobReader);
    getEntriesGenerator(): AsyncGenerator<Entry>;
    close(): Promise<void>;
  }
}
