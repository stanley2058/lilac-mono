import { Database } from "bun:sqlite";
import JSON from "superjson";

import type { AgentRunnerRecoveryEntry } from "../surface/bridge/bus-agent-runner";
import type { BusToAdapterRelaySnapshot } from "../surface/bridge/subscribe-from-bus";

export type GracefulRestartSnapshot = {
  version: 1;
  createdAt: number;
  deadlineMs: number;
  agent: AgentRunnerRecoveryEntry[];
  relays: BusToAdapterRelaySnapshot[];
};

export type GracefulRestartLoadResult =
  | {
      snapshot: GracefulRestartSnapshot;
      reason: "loaded";
    }
  | {
      snapshot: null;
      reason: "empty" | "invalid_status" | "invalid_payload" | "version_mismatch";
    }
  | {
      snapshot: null;
      reason: "stale";
      createdAt: number;
      deadlineMs: number;
      ageMs: number;
    };

function isFreshSnapshot(snapshot: GracefulRestartSnapshot, nowMs: number): boolean {
  if (!Number.isFinite(snapshot.createdAt) || snapshot.createdAt < 0) return false;
  if (!Number.isFinite(snapshot.deadlineMs) || snapshot.deadlineMs <= 0) return false;
  return nowMs - snapshot.createdAt <= snapshot.deadlineMs;
}

export class SqliteGracefulRestartStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  clear(): void {
    this.db.run("DELETE FROM graceful_restart_state");
  }

  saveCompletedSnapshot(snapshot: GracefulRestartSnapshot): void {
    this.db.run(
      `
      INSERT INTO graceful_restart_state (
        singleton_id,
        status,
        updated_ts,
        payload_json
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(singleton_id) DO UPDATE SET
        status=excluded.status,
        updated_ts=excluded.updated_ts,
        payload_json=excluded.payload_json
      `,
      [1, "completed", Date.now(), JSON.stringify(snapshot)],
    );
  }

  loadAndConsumeCompletedSnapshotDetailed(): GracefulRestartLoadResult {
    this.db.run("BEGIN");

    try {
      const row = this.db
        .query("SELECT status, payload_json FROM graceful_restart_state WHERE singleton_id = ?")
        .get(1) as {
        status: string;
        payload_json: string;
      } | null;

      this.db.run("DELETE FROM graceful_restart_state WHERE singleton_id = ?", [1]);

      this.db.run("COMMIT");

      if (!row) return { snapshot: null, reason: "empty" };
      if (row.status !== "completed") return { snapshot: null, reason: "invalid_status" };

      try {
        const parsed = JSON.parse<GracefulRestartSnapshot>(row.payload_json);
        if (!parsed || parsed.version !== 1) {
          return { snapshot: null, reason: "version_mismatch" };
        }

        if (
          !Number.isFinite(parsed.createdAt) ||
          parsed.createdAt < 0 ||
          !Number.isFinite(parsed.deadlineMs) ||
          parsed.deadlineMs <= 0
        ) {
          return { snapshot: null, reason: "invalid_payload" };
        }

        const nowMs = Date.now();
        if (!isFreshSnapshot(parsed, nowMs)) {
          return {
            snapshot: null,
            reason: "stale",
            createdAt: parsed.createdAt,
            deadlineMs: parsed.deadlineMs,
            ageMs: Math.max(0, nowMs - parsed.createdAt),
          };
        }

        return {
          snapshot: parsed,
          reason: "loaded",
        };
      } catch {
        return { snapshot: null, reason: "invalid_payload" };
      }
    } catch (e) {
      this.db.run("ROLLBACK");
      throw e;
    }
  }

  loadAndConsumeCompletedSnapshot(): GracefulRestartSnapshot | null {
    const result = this.loadAndConsumeCompletedSnapshotDetailed();
    return result.snapshot;
  }

  private migrate() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS graceful_restart_state (
        singleton_id INTEGER PRIMARY KEY,
        status TEXT NOT NULL,
        updated_ts INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      )
    `);
  }
}
