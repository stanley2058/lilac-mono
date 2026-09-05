import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SqliteTranscriptStore } from "../../src/transcript/transcript-store";

function attemptInput(requestId: string, attemptIndex = 0, sessionId = "lifecycle-owner") {
  return {
    providerId: "claude-code",
    requestClient: "discord" as const,
    lilacSessionId: sessionId,
    executionScopeHashVersion: 1 as const,
    executionScopeHash: "scope",
    requestId,
    attemptIndex,
    candidateSessionId: crypto.randomUUID(),
    sourceSessionId: null,
    expectedBindingRevision: null,
  };
}

for (const kind of ["named", "primary"] as const) {
  describe(`${kind} Claude attempt lifecycle`, () => {
    it("preserves collision parity and bounds active attempts per owner", () => {
      const store = new SqliteTranscriptStore(":memory:");
      const reserve = (input: ReturnType<typeof attemptInput>) =>
        kind === "named"
          ? store.reserveCoreNamedClaudeSessionAttempt(input)
          : store.reserveCorePrimaryClaudeSessionAttempt(input);
      try {
        for (const [requested, allocated] of [
          [0, 0],
          [1, 1],
          [0, 2],
          [1, 3],
        ] as const) {
          const result = reserve(attemptInput("retried", requested));
          expect(result.status).toBe("ok");
          if (result.status === "ok") expect(result.value.attemptIndex).toBe(allocated);
        }
        for (let index = 0; index < 4; index += 1) {
          expect(reserve(attemptInput(`active-${index}`)).status).toBe("ok");
        }
        const rejected = reserve(attemptInput("over-cap"));
        expect(rejected.status).toBe("error");
        if (rejected.status === "error") {
          expect(rejected.error._tag).toBe("TranscriptTransactionConflict");
          if (rejected.error._tag === "TranscriptTransactionConflict") {
            expect(rejected.error.reason).toBe("attempt-not-retained");
          }
        }
        expect(reserve(attemptInput("another-owner", 0, "other-session")).status).toBe("ok");
      } finally {
        store.close();
      }
    });

    it("keeps terminal outcomes idempotent and rolls back failed reservations", async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-attempt-lifecycle-"));
      const dbPath = path.join(directory, "transcripts.db");
      const store = new SqliteTranscriptStore(dbPath);
      const raw = new Database(dbPath);
      const reserve = (input: ReturnType<typeof attemptInput>) =>
        kind === "named"
          ? store.reserveCoreNamedClaudeSessionAttempt(input)
          : store.reserveCorePrimaryClaudeSessionAttempt(input);
      const record = (state: "failed" | "cancelled") =>
        kind === "named"
          ? store.recordCoreNamedClaudeSessionAttemptOutcome({ ...attemptInput("finished"), state })
          : store.recordCorePrimaryClaudeSessionAttemptOutcome({
              ...attemptInput("finished"),
              state,
            });
      try {
        expect(reserve(attemptInput("finished")).status).toBe("ok");
        expect(record("failed").status).toBe("ok");
        expect(record("failed").status).toBe("ok");
        const conflict = record("cancelled");
        expect(conflict.status).toBe("error");
        if (
          conflict.status === "error" &&
          conflict.error._tag === "TranscriptTransactionConflict"
        ) {
          expect(conflict.error.reason).toBe("attempt-terminal");
        }
        raw.run("CREATE TABLE attempt_reservation_effects (request_id TEXT)");
        raw.run(`
          CREATE TRIGGER invalidate_attempt_reservation AFTER INSERT ON core_${kind}_claude_attempts
          WHEN NEW.request_id = 'rolled-back'
          BEGIN
            INSERT INTO attempt_reservation_effects VALUES (NEW.request_id);
            DELETE FROM core_${kind}_claude_attempts WHERE rowid = NEW.rowid;
          END
        `);
        const failed = reserve(attemptInput("rolled-back"));
        expect(failed.status).toBe("error");
        if (failed.status === "error" && failed.error._tag === "TranscriptTransactionConflict") {
          expect(failed.error.reason).toBe("attempt-not-retained");
        }
        expect(raw.query("SELECT * FROM attempt_reservation_effects").all()).toEqual([]);
        expect(
          raw
            .query(`SELECT state FROM core_${kind}_claude_attempts WHERE request_id = 'finished'`)
            .get(),
        ).toEqual({ state: "failed" });
      } finally {
        raw.close();
        store.close();
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
  });
}
