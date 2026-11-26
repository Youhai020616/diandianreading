export const WEREAD_IMPORT_FORMATS = ["epub", "pdf", "mobi", "azw3", "txt"];

export function supportsWeReadImport(format: string): boolean {
  return WEREAD_IMPORT_FORMATS.includes(format.toLowerCase());
}
