import type { DatabaseSync } from "node:sqlite";

export function nowIso(): string {
  return new Date().toISOString();
}

/** A storage function bound to a database connection, minus that first argument. */
export type BoundToDb<F> = F extends (db: DatabaseSync, ...args: infer A) => infer R ? (...args: A) => R : never;

/** What schema and migration helpers need from KnowledgeDatabase. */
export interface SqlContext {
  readonly db: DatabaseSync;
  transaction<T>(work: () => T): T;
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  deleteSetting(key: string): void;
}
