import type { Database } from "bun:sqlite";

export const SQLITE_BUSY_TIMEOUT_MS = 10_000;

export function configureSqliteConnection(db: Database): void {
  db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
}

export function isSqliteBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes("sqlite_busy") || normalized.includes("database is locked");
}
