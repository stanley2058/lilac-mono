import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Result as ResultType } from "better-result";
import SuperJSON from "superjson";

import {
  AgentRunJournalCodecFailure,
  AgentRunJournalConflict,
  SqliteAgentRunJournal,
  createAgentRunCheckpoint,
  type AgentRunCheckpointV1,
} from "../../../src/surface/bridge/agent-run-journal";
import type { CoreAcceptedRequestWork } from "../../../src/surface/bridge/request-delivery";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "lilac-agent-run-journal-"));
  directories.push(directory);
  const dbPath = join(directory, "request-delivery.db");
  const database = new Database(dbPath, { create: true, strict: true });
  database.run("PRAGMA foreign_keys = ON");
  database.run(`
    CREATE TABLE request_delivery_records (
      request_delivery_id TEXT PRIMARY KEY NOT NULL,
      request_id TEXT NOT NULL,
      state TEXT NOT NULL
    ) STRICT
  `);
  database.close();
  return { dbPath };
}

function work(input?: {
  requestDeliveryId?: string;
  requestId?: string;
  sessionId?: string;
}): CoreAcceptedRequestWork {
  const requestDeliveryId = input?.requestDeliveryId ?? "11111111-1111-4111-8111-111111111111";
  const requestId = input?.requestId ?? "request-1";
  const sessionId = input?.sessionId ?? "session-1";
  return {
    requestDeliveryId,
    requestId,
    sessionId,
    requestClient: "discord",
    headers: {
      request_id: requestId,
      session_id: sessionId,
      request_client: "discord",
    },
    data: {
      requestDeliveryId,
      queue: "prompt",
      messages: [],
    },
  };
}

function insertAccepted(dbPath: string, accepted: CoreAcceptedRequestWork): void {
  const database = new Database(dbPath, { strict: true });
  database.run(
    "INSERT INTO request_delivery_records (request_delivery_id, request_id, state) VALUES (?, ?, 'accepted')",
    [accepted.requestDeliveryId, accepted.requestId],
  );
  database.close();
}

describe("SqliteAgentRunJournal", () => {
  it("restores the latest checkpoint and one predecessor after reopen", async () => {
    const { dbPath } = await fixture();
    const accepted = work();
    insertAccepted(dbPath, accepted);
    const journal = new SqliteAgentRunJournal({ dbPath, now: () => 10 });
    const opened = journal.openRun(accepted).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    const first = journal
      .writeCheckpoint(opened, createAgentRunCheckpoint({ messages: [] }))
      .match({
        ok: (value) => value,
        err: (error) => {
          throw error;
        },
      });
    const checkpoint = createAgentRunCheckpoint({
      messages: [{ role: "user", content: "continue" }],
      currentTurnUserId: "user-1",
      nativeOutput: { ordinal: 4, position: 2 },
    });
    const second = journal.writeCheckpoint(first, checkpoint).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    expect(second.sequence).toBe(3);
    const latestCheckpoint = createAgentRunCheckpoint({
      messages: [{ role: "user", content: "latest" }],
      loadedCatalogIds: ["mcp_docs_search"],
      currentTurnUserId: "user-2",
      nativeOutput: { ordinal: 9, position: 5 },
    });
    const third = journal.writeCheckpoint(second, latestCheckpoint).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    expect(third.sequence).toBe(4);
    journal.close();

    const reopened = new SqliteAgentRunJournal({ dbPath });
    const recovery = reopened.loadRecoveryHeads().match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    expect(recovery.resets).toEqual([]);
    expect(recovery.heads).toHaveLength(1);
    expect(recovery.heads[0]?.checkpoint).toEqual(latestCheckpoint);
    expect(recovery.heads[0]?.previousCheckpoint).toEqual(checkpoint);

    const database = new Database(dbPath, { strict: true });
    const checkpointEvents = database
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM agent_run_wal_events WHERE event_kind = 'checkpoint'",
      )
      .get();
    expect(checkpointEvents?.count).toBe(2);
    database.close();
    reopened.close();
  });

  it("promotes the predecessor atomically and preserves both checkpoints on mutation failure", async () => {
    const { dbPath } = await fixture();
    const accepted = work();
    insertAccepted(dbPath, accepted);
    const journal = new SqliteAgentRunJournal({ dbPath, now: () => 20 });
    const opened = journal.openRun(accepted).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    const predecessor = createAgentRunCheckpoint({
      messages: [{ role: "user", content: "safe" }],
    });
    const predecessorHandle = journal.writeCheckpoint(opened, predecessor).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    const latest = createAgentRunCheckpoint({
      messages: [{ role: "user", content: "missing blob" }],
    });
    const latestHandle = journal.writeCheckpoint(predecessorHandle, latest).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    const database = new Database(dbPath, { strict: true });
    const failureTriggers = [
      `CREATE TRIGGER reject_agent_run_checkpoint_delete
       BEFORE DELETE ON agent_run_wal_events
       WHEN OLD.event_kind = 'checkpoint'
       BEGIN SELECT RAISE(ABORT, 'checkpoint delete rejected'); END`,
      `CREATE TRIGGER reject_agent_run_checkpoint_insert
       BEFORE INSERT ON agent_run_wal_events
       WHEN NEW.event_kind = 'checkpoint'
       BEGIN SELECT RAISE(ABORT, 'checkpoint insert rejected'); END`,
      `CREATE TRIGGER reject_agent_run_checkpoint_promote_update
       BEFORE UPDATE OF checkpoint_json ON agent_run_wal_heads
       BEGIN SELECT RAISE(ABORT, 'checkpoint update rejected'); END`,
    ] as const;

    for (const [index, trigger] of failureTriggers.entries()) {
      database.run(trigger);
      expect(
        journal
          .promotePreviousCheckpoint(latestHandle, predecessor)
          .match({ ok: () => false, err: () => true }),
      ).toBe(true);
      database.run(
        `DROP TRIGGER ${[
          "reject_agent_run_checkpoint_delete",
          "reject_agent_run_checkpoint_insert",
          "reject_agent_run_checkpoint_promote_update",
        ][index]!}`,
      );
      const recovery = journal.loadRecoveryHeads().match({
        ok: (value) => value,
        err: (error) => {
          throw error;
        },
      });
      expect(recovery.heads[0]?.handle).toEqual(latestHandle);
      expect(recovery.heads[0]?.checkpoint).toEqual(latest);
      expect(recovery.heads[0]?.previousCheckpoint).toEqual(predecessor);
    }

    const promoted = journal.promotePreviousCheckpoint(latestHandle, predecessor).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    expect(promoted.sequence).toBe(latestHandle.sequence + 1);
    const recovery = journal.loadRecoveryHeads().match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    expect(recovery.heads[0]?.checkpoint).toEqual(predecessor);
    expect(recovery.heads[0]?.previousCheckpoint).toBeUndefined();
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM agent_run_wal_events WHERE event_kind = 'checkpoint'",
        )
        .get()?.count,
    ).toBe(1);
    database.close();
    journal.close();
  });

  it("retains terminal state until reconciliation", async () => {
    const { dbPath } = await fixture();
    const accepted = work();
    insertAccepted(dbPath, accepted);
    const journal = new SqliteAgentRunJournal({ dbPath });
    const opened = journal.openRun(accepted).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    const checkpoint = createAgentRunCheckpoint({
      messages: [{ role: "user", content: "finish" }],
    });
    const checkpointed = journal.writeCheckpoint(opened, checkpoint).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    journal
      .markTerminal(checkpointed, {
        outcome: { kind: "completed" },
        finalReplayDeadline: 5_000,
      })
      .match({
        ok: () => undefined,
        err: (error) => {
          throw error;
        },
      });
    const recovery = journal.loadRecoveryHeads().match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    expect(recovery.heads[0]).toMatchObject({
      state: "terminal",
      checkpoint,
      terminalOutcome: { kind: "completed" },
      finalReplayDeadline: 5_000,
    });
    journal.removeReconciled(accepted.requestDeliveryId).match({
      ok: () => undefined,
      err: (error) => {
        throw error;
      },
    });
    expect(
      journal.loadRecoveryHeads().match({
        ok: (value) => value.heads,
        err: (error) => {
          throw error;
        },
      }),
    ).toEqual([]);
    journal.close();
  });

  it("opens idempotently for the same accepted owner", async () => {
    const { dbPath } = await fixture();
    const accepted = work();
    insertAccepted(dbPath, accepted);
    const journal = new SqliteAgentRunJournal({ dbPath });
    const first = journal.openRun(accepted).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    const second = journal.openRun(accepted).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    expect(second).toEqual(first);

    const database = new Database(dbPath, { strict: true });
    expect(
      database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM agent_run_wal_events")
        .get()?.count,
    ).toBe(1);
    database.close();
    journal.close();
  });

  it("keeps the handle for an unchanged checkpoint, also after reopening", async () => {
    const { dbPath } = await fixture();
    const accepted = work();
    insertAccepted(dbPath, accepted);
    const unwrap = <T, E>(result: ResultType<T, E>): T =>
      result.match({
        ok: (value) => value,
        err: (error) => {
          throw error;
        },
      });
    const first = createAgentRunCheckpoint({ messages: [{ role: "user", content: "same" }] });
    const second = createAgentRunCheckpoint({ messages: [{ role: "user", content: "changed" }] });
    const journal = new SqliteAgentRunJournal({ dbPath });
    const opened = unwrap(journal.openRun(accepted));
    const written = unwrap(journal.writeCheckpoint(opened, first));
    expect(unwrap(journal.writeCheckpoint(written, first))).toEqual(written);
    journal.close();

    const reopened = new SqliteAgentRunJournal({ dbPath });
    expect(unwrap(reopened.writeCheckpoint(written, first))).toEqual(written);
    const advanced = unwrap(reopened.writeCheckpoint(written, second));
    expect(advanced.sequence).toBe(written.sequence + 1);
    expect(unwrap(reopened.writeCheckpoint(advanced, second))).toEqual(advanced);
    reopened.close();
  });

  it("rolls back the checkpoint event when the head update fails", async () => {
    const { dbPath } = await fixture();
    const accepted = work();
    insertAccepted(dbPath, accepted);
    const journal = new SqliteAgentRunJournal({ dbPath });
    const opened = journal.openRun(accepted).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    const database = new Database(dbPath, { strict: true });
    database.run(`
      CREATE TRIGGER reject_agent_run_head_checkpoint
      BEFORE UPDATE OF checkpoint_json ON agent_run_wal_heads
      BEGIN
        SELECT RAISE(ABORT, 'checkpoint head rejected');
      END
    `);

    expect(
      journal
        .writeCheckpoint(opened, createAgentRunCheckpoint({ messages: [] }))
        .match({ ok: () => false, err: () => true }),
    ).toBe(true);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM agent_run_wal_events WHERE event_kind = 'checkpoint'",
        )
        .get()?.count,
    ).toBe(0);
    expect(
      database
        .query<{ latest_sequence: number }, []>("SELECT latest_sequence FROM agent_run_wal_heads")
        .get()?.latest_sequence,
    ).toBe(1);
    database.close();
    journal.close();
  });

  it("rejects stale handles", async () => {
    const { dbPath } = await fixture();
    const accepted = work();
    insertAccepted(dbPath, accepted);
    const journal = new SqliteAgentRunJournal({ dbPath });
    const opened = journal.openRun(accepted).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    journal.writeCheckpoint(opened, createAgentRunCheckpoint({ messages: [] })).match({
      ok: () => undefined,
      err: (error) => {
        throw error;
      },
    });
    const stale = journal.writeCheckpoint(
      opened,
      createAgentRunCheckpoint({
        messages: [{ role: "user", content: "stale" }],
      }),
    );
    expect(stale.match({ ok: () => null, err: (error) => error })).toBeInstanceOf(
      AgentRunJournalConflict,
    );
    journal.close();
  });

  it("rejects stale and identity-incompatible terminal handles", async () => {
    const { dbPath } = await fixture();
    const accepted = work();
    insertAccepted(dbPath, accepted);
    const journal = new SqliteAgentRunJournal({ dbPath });
    const opened = journal.openRun(accepted).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    const checkpointed = journal
      .writeCheckpoint(opened, createAgentRunCheckpoint({ messages: [] }))
      .match({
        ok: (value) => value,
        err: (error) => {
          throw error;
        },
      });
    const handles = [
      opened,
      { ...checkpointed, requestId: "different-request" },
      { ...checkpointed, sessionId: "different-session" },
    ];
    for (const handle of handles) {
      expect(
        journal
          .markTerminal(handle, { outcome: { kind: "completed" } })
          .match({ ok: () => null, err: (error) => error }),
      ).toBeInstanceOf(AgentRunJournalConflict);
    }

    const database = new Database(dbPath, { strict: true });
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM agent_run_wal_events WHERE event_kind = 'terminal'",
        )
        .get()?.count,
    ).toBe(0);
    database.close();
    journal.close();
  });

  it("validates terminal schemas before writing and checkpoints when recovering", async () => {
    const { dbPath } = await fixture();
    const accepted = work();
    insertAccepted(dbPath, accepted);
    const journal = new SqliteAgentRunJournal({ dbPath });
    const opened = journal.openRun(accepted).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    expect(
      journal
        .markTerminal(opened, {
          outcome: { kind: "completed" },
          unexpected: true,
        } as unknown as Parameters<SqliteAgentRunJournal["markTerminal"]>[1])
        .match({ ok: () => null, err: (error) => error }),
    ).toBeInstanceOf(AgentRunJournalCodecFailure);

    const database = new Database(dbPath, { strict: true });
    expect(
      database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM agent_run_wal_events")
        .get()?.count,
    ).toBe(1);
    expect(
      database
        .query<{ latest_sequence: number }, []>("SELECT latest_sequence FROM agent_run_wal_heads")
        .get()?.latest_sequence,
    ).toBe(1);
    database.close();

    const checkpoint = {
      ...createAgentRunCheckpoint({ messages: [] }),
      unexpected: true,
    } as unknown as AgentRunCheckpointV1;
    expect(journal.writeCheckpoint(opened, checkpoint).isOk()).toBe(true);
    const recovery = journal.loadRecoveryHeads().match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    expect(recovery.heads).toEqual([]);
    expect(recovery.resets).toEqual([
      expect.objectContaining({ scope: "run", runId: accepted.requestDeliveryId }),
    ]);
    journal.close();
  });

  it("resets heads with incomplete checkpoint pairs", async () => {
    const { dbPath } = await fixture();
    const first = work();
    const second = work({
      requestDeliveryId: "22222222-2222-4222-8222-222222222222",
      requestId: "request-2",
      sessionId: "session-2",
    });
    insertAccepted(dbPath, first);
    insertAccepted(dbPath, second);
    const journal = new SqliteAgentRunJournal({ dbPath });
    journal.openRun(first);
    journal.openRun(second);
    const database = new Database(dbPath, { strict: true });
    database.run(
      "UPDATE agent_run_wal_heads SET checkpoint_sequence = 2 WHERE request_delivery_id = ?",
      [first.requestDeliveryId],
    );
    database.run(
      "UPDATE agent_run_wal_heads SET checkpoint_json = '{}' WHERE request_delivery_id = ?",
      [second.requestDeliveryId],
    );
    database.close();

    const recovery = journal.loadRecoveryHeads().match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    expect(recovery.heads).toEqual([]);
    expect(recovery.resets.map((reset) => reset.runId)).toEqual([
      first.requestDeliveryId,
      second.requestDeliveryId,
    ]);
    journal.close();
  });

  it("resets active heads with terminal payloads and terminal heads without them", async () => {
    const { dbPath } = await fixture();
    const first = work();
    const second = work({
      requestDeliveryId: "22222222-2222-4222-8222-222222222222",
      requestId: "request-2",
      sessionId: "session-2",
    });
    insertAccepted(dbPath, first);
    insertAccepted(dbPath, second);
    const journal = new SqliteAgentRunJournal({ dbPath, now: () => 10 });
    const firstHandle = journal.openRun(first).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    const secondHandle = journal.openRun(second).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    for (const handle of [firstHandle, secondHandle]) {
      journal.markTerminal(handle, { outcome: { kind: "completed" } }).match({
        ok: () => undefined,
        err: (error) => {
          throw error;
        },
      });
    }
    const database = new Database(dbPath, { strict: true });
    database.run("UPDATE agent_run_wal_heads SET state = 'active' WHERE request_delivery_id = ?", [
      first.requestDeliveryId,
    ]);
    database.run(
      "UPDATE agent_run_wal_heads SET terminal_outcome_json = NULL WHERE request_delivery_id = ?",
      [second.requestDeliveryId],
    );
    database.close();

    const recovery = journal.loadRecoveryHeads().match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    expect(recovery.heads).toEqual([]);
    expect(recovery.resets).toHaveLength(2);
    journal.close();
  });

  it("resets heads with incoherent sequences or timestamps", async () => {
    const { dbPath } = await fixture();
    const first = work();
    const second = work({
      requestDeliveryId: "22222222-2222-4222-8222-222222222222",
      requestId: "request-2",
      sessionId: "session-2",
    });
    insertAccepted(dbPath, first);
    insertAccepted(dbPath, second);
    const journal = new SqliteAgentRunJournal({ dbPath, now: () => 10 });
    const firstHandle = journal.openRun(first).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    journal.writeCheckpoint(firstHandle, createAgentRunCheckpoint({ messages: [] })).match({
      ok: () => undefined,
      err: (error) => {
        throw error;
      },
    });
    journal.openRun(second);
    const database = new Database(dbPath, { strict: true });
    database.run(
      "UPDATE agent_run_wal_heads SET latest_sequence = 1 WHERE request_delivery_id = ?",
      [first.requestDeliveryId],
    );
    database.run(
      "UPDATE agent_run_wal_heads SET created_at = 20, updated_at = 10 WHERE request_delivery_id = ?",
      [second.requestDeliveryId],
    );
    database.close();

    const recovery = journal.loadRecoveryHeads().match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    expect(recovery.heads).toEqual([]);
    expect(recovery.resets).toHaveLength(2);
    journal.close();
  });

  it("resets a head whose retained event does not match its checkpoint", async () => {
    const { dbPath } = await fixture();
    const accepted = work();
    insertAccepted(dbPath, accepted);
    const journal = new SqliteAgentRunJournal({ dbPath, now: () => 10 });
    const opened = journal.openRun(accepted).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    journal.writeCheckpoint(opened, createAgentRunCheckpoint({ messages: [] })).match({
      ok: () => undefined,
      err: (error) => {
        throw error;
      },
    });
    const database = new Database(dbPath, { strict: true });
    database.run(
      `UPDATE agent_run_wal_events
       SET payload_json = '{}'
       WHERE request_delivery_id = ? AND event_kind = 'checkpoint'`,
      [accepted.requestDeliveryId],
    );
    database.close();

    const recovery = journal.loadRecoveryHeads().match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    expect(recovery.heads).toEqual([]);
    expect(recovery.resets).toEqual([
      {
        scope: "run",
        runId: accepted.requestDeliveryId,
        reason: "corrupt-payload",
        errorName: "AgentRunJournalCodecFailure",
      },
    ]);
    journal.close();
  });

  it("resets only runs with malformed, future, or corrupt opened payloads", async () => {
    const { dbPath } = await fixture();
    const malformed = work();
    const future = work({
      requestDeliveryId: "22222222-2222-4222-8222-222222222222",
      requestId: "request-2",
      sessionId: "session-2",
    });
    const corrupt = work({
      requestDeliveryId: "33333333-3333-4333-8333-333333333333",
      requestId: "request-3",
      sessionId: "session-3",
    });
    const valid = work({
      requestDeliveryId: "44444444-4444-4444-8444-444444444444",
      requestId: "request-4",
      sessionId: "session-4",
    });
    const acceptedRuns = [malformed, future, corrupt, valid];
    for (const accepted of acceptedRuns) insertAccepted(dbPath, accepted);
    const journal = new SqliteAgentRunJournal({ dbPath, now: () => 10 });
    for (const accepted of acceptedRuns) {
      journal.openRun(accepted).match({
        ok: () => undefined,
        err: (error) => {
          throw error;
        },
      });
    }
    const database = new Database(dbPath, { strict: true });
    const updateOpenedPayload = database.query<void, [string, string]>(
      `UPDATE agent_run_wal_events
       SET payload_json = ?
       WHERE request_delivery_id = ? AND event_kind = 'opened'`,
    );
    updateOpenedPayload.run("{", malformed.requestDeliveryId);
    updateOpenedPayload.run(SuperJSON.stringify({ version: 2 }), future.requestDeliveryId);
    updateOpenedPayload.run(
      SuperJSON.stringify({ version: 1, unexpected: true }),
      corrupt.requestDeliveryId,
    );
    database.close();

    const recovery = journal.loadRecoveryHeads().match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    expect(recovery.heads.map((head) => head.handle.runId)).toEqual([valid.requestDeliveryId]);
    expect(recovery.resets.map((reset) => reset.runId)).toEqual([
      malformed.requestDeliveryId,
      future.requestDeliveryId,
      corrupt.requestDeliveryId,
    ]);
    const ownerDatabase = new Database(dbPath, { strict: true });
    expect(
      ownerDatabase
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM request_delivery_records")
        .get()?.count,
    ).toBe(4);
    ownerDatabase.close();
    journal.close();
  });

  it("resets one corrupt run without blocking valid recovery", async () => {
    const { dbPath } = await fixture();
    const first = work();
    const second = work({
      requestDeliveryId: "22222222-2222-4222-8222-222222222222",
      requestId: "request-2",
      sessionId: "session-2",
    });
    insertAccepted(dbPath, first);
    insertAccepted(dbPath, second);
    const journal = new SqliteAgentRunJournal({ dbPath });
    journal.openRun(first);
    journal.openRun(second);
    const database = new Database(dbPath, { strict: true });
    database.run(
      "UPDATE agent_run_wal_heads SET checkpoint_json = '{', checkpoint_sequence = 2 WHERE request_delivery_id = ?",
      [first.requestDeliveryId],
    );
    database.close();

    const recovery = journal.loadRecoveryHeads().match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    expect(recovery.heads.map((head) => head.handle.runId)).toEqual([second.requestDeliveryId]);
    expect(recovery.resets).toEqual([
      {
        scope: "run",
        runId: first.requestDeliveryId,
        reason: "corrupt-payload",
        errorName: "AgentRunJournalCodecFailure",
      },
    ]);
    const ownerDatabase = new Database(dbPath, { strict: true });
    expect(
      ownerDatabase
        .query<{ state: string }, [string]>(
          "SELECT state FROM request_delivery_records WHERE request_delivery_id = ?",
        )
        .get(first.requestDeliveryId)?.state,
    ).toBe("accepted");
    ownerDatabase.close();
    journal.close();
  });

  it("resets all journal tables for an incompatible schema version", async () => {
    const { dbPath } = await fixture();
    const accepted = work();
    insertAccepted(dbPath, accepted);
    const journal = new SqliteAgentRunJournal({ dbPath });
    journal.openRun(accepted);
    const database = new Database(dbPath, { strict: true });
    database.run("UPDATE agent_run_wal_metadata SET schema_version = 99 WHERE singleton = 1");
    database.close();

    const recovery = journal.loadRecoveryHeads().match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    expect(recovery.heads).toEqual([]);
    expect(recovery.resets).toEqual([
      {
        scope: "all",
        reason: "incompatible-schema",
        errorName: "AgentRunJournalSchemaIncompatible",
      },
    ]);
    journal.close();
  });

  it("recreates drifted journal tables without changing accepted work", async () => {
    const { dbPath } = await fixture();
    const accepted = work();
    insertAccepted(dbPath, accepted);
    const database = new Database(dbPath, { strict: true });
    database.run(`
      CREATE TABLE agent_run_wal_heads (
        request_delivery_id TEXT PRIMARY KEY NOT NULL
      ) STRICT
    `);
    database.close();

    const journal = new SqliteAgentRunJournal({ dbPath });
    expect(
      journal.openRun(accepted).match({
        ok: () => true,
        err: () => false,
      }),
    ).toBe(true);
    const ownerDatabase = new Database(dbPath, { strict: true });
    expect(
      ownerDatabase
        .query<{ state: string }, [string]>(
          "SELECT state FROM request_delivery_records WHERE request_delivery_id = ?",
        )
        .get(accepted.requestDeliveryId)?.state,
    ).toBe("accepted");
    ownerDatabase.close();
    journal.close();
  });
});
