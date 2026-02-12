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
      [
        1,
        "completed",
        Date.now(),
        JSON.stringify(snapshot),
      ],
    );
  }

  loadAndConsumeCompletedSnapshot(): GracefulRestartSnapshot | null {
    this.db.run("BEGIN");

    try {
      const row = this.db
        .query(
          "SELECT status, payload_json FROM graceful_restart_state WHERE singleton_id = ?",
        )
        .get(1) as
        | {
            status: string;
            payload_json: string;
          }
        | null;

      this.db.run("DELETE FROM graceful_restart_state WHERE singleton_id = ?", [1]);

      this.db.run("COMMIT");

      if (!row) return null;
      if (row.status !== "completed") return null;

      try {
        const parsed = JSON.parse<GracefulRestartSnapshot>(row.payload_json);
        if (!parsed || parsed.version !== 1) return null;
        return parsed;
      } catch {
        return null;
      }
    } catch (e) {
      this.db.run("ROLLBACK");
      throw e;
    }
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
