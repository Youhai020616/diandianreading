/** Types for read-scope.mjs (used by tests; the plugin itself is plain ESM). */
export declare const READ_SCOPE_TOOLS: readonly string[];
export declare function parseReadRoots(raw: string | undefined): string[];
export declare function checkReadScope(
  toolName: string,
  args: unknown,
  scope: { roots: string[]; home?: string },
): string | undefined;
