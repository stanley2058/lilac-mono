import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import SuperJSON from "superjson";
import { AiSdkPiAgent } from "@stanley2058/lilac-agent";
import { lilacEventTypes, outReqTopic } from "@stanley2058/lilac-event-bus";
import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils";
import { MockLanguageModelV4 } from "ai/test";
import { Result } from "better-result";
import {
  SqliteAgentRunJournal,
  createAgentRunCheckpoint,
  type AgentRunCheckpointV1,
} from "../../../src/surface/bridge/agent-run-journal";
import {
  joinAgentRunRecoveryHeads,
  selectAgentRunAcceptedRecovery,
} from "../../../src/runtime/create-core-runtime";
import {
  createRealCoreBusFixture,
  requireBusOk,
  withBusDeadline,
} from "../../helpers/real-core-bus";
import {
  corePrimaryTestPluginManager,
  level1TextStep,
  startBusAgentRunner,
} from "./bus-agent-runner-test-support";

// Schema 1 predates checkpoint deltas; its head duplicates the last full event payload.
function seedSchemaOneJournal(
  db: Database,
  identity: { requestDeliveryId: string; requestId: string; sessionId: string },
  checkpoint: AgentRunCheckpointV1,
) {
  db.run(`
    CREATE TABLE agent_run_wal_metadata (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1), schema_version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE agent_run_wal_heads (
      request_delivery_id TEXT PRIMARY KEY NOT NULL, request_id TEXT NOT NULL,
      session_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('active', 'terminal')),
      latest_sequence INTEGER NOT NULL, checkpoint_sequence INTEGER, checkpoint_json TEXT,
      terminal_outcome_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      FOREIGN KEY (request_delivery_id) REFERENCES request_delivery_records(request_delivery_id) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE agent_run_wal_events (
      request_delivery_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      event_kind TEXT NOT NULL CHECK (event_kind IN ('opened', 'checkpoint', 'terminal')),
      payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (request_delivery_id, sequence),
      FOREIGN KEY (request_delivery_id) REFERENCES request_delivery_records(request_delivery_id) ON DELETE CASCADE
    ) STRICT;
    INSERT INTO agent_run_wal_metadata VALUES (1, 1);
  `);
  db.run("INSERT INTO agent_run_wal_heads VALUES (?, ?, ?, 'active', 2, 2, ?, NULL, 1, 1)", [
    identity.requestDeliveryId,
    identity.requestId,
    identity.sessionId,
    SuperJSON.stringify(checkpoint),
  ]);
  db.run("INSERT INTO agent_run_wal_events VALUES (?, 1, 'opened', ?, 1)", [
    identity.requestDeliveryId,
    SuperJSON.stringify({ version: 1 }),
  ]);
  db.run("INSERT INTO agent_run_wal_events VALUES (?, 2, 'checkpoint', ?, 1)", [
    identity.requestDeliveryId,
    SuperJSON.stringify(checkpoint),
  ]);
}

describe("retained state across supported upgrades", () => {
  for (const prior of [
    "before-journal",
    "schema-1",
    "corrupt-checkpoint",
    "future-journal",
  ] as const) {
    it(`recovers accepted work and retained Redis output from ${prior}`, async () => {
      const f = await createRealCoreBusFixture();
      const identity = {
        requestDeliveryId: crypto.randomUUID(),
        requestId: `github:upgrade:${prior}`,
        sessionId: `upgrade-${prior}`,
      };
      const headers = {
        request_id: identity.requestId,
        session_id: identity.sessionId,
        request_client: "github",
      } as const;
      const manager = corePrimaryTestPluginManager();
      let runner: Awaited<ReturnType<typeof startBusAgentRunner>> | undefined;
      let journal: SqliteAgentRunJournal | undefined;
      const db = new Database(join(f.directory, "request-delivery.sqlite"), { strict: true });
      try {
        requireBusOk(
          await f.bus.publish(
            lilacEventTypes.CmdRequestMessage,
            {
              requestDeliveryId: identity.requestDeliveryId,
              queue: "prompt",
              messages: [{ role: "user", content: "original accepted input" }],
            },
            { headers },
          ),
        );
        const admission = requireBusOk(
          await f.coordinator.handleDelivery(identity.requestDeliveryId),
        );
        expect(admission.disposition).toBe("accepted");
        const beforeUpgrade = requireBusOk(f.store.load(identity.requestDeliveryId));
        expect(beforeUpgrade.state).toBe("accepted");
        if (prior !== "before-journal") {
          seedSchemaOneJournal(
            db,
            identity,
            createAgentRunCheckpoint({
              messages: [
                { role: "user", content: "original accepted input" },
                { role: "assistant", content: "retained checkpoint progress" },
                { role: "user", content: "continue the older checkpoint" },
              ],
            }),
          );
        }
        if (prior === "corrupt-checkpoint") {
          db.run(
            "UPDATE agent_run_wal_events SET payload_json = '{}' WHERE event_kind = 'checkpoint'",
          );
        }
        if (prior === "future-journal") {
          db.run("UPDATE agent_run_wal_metadata SET schema_version = 999");
        }
        const oldOutput = requireBusOk(
          await f.bus.publish(
            lilacEventTypes.EvtAgentOutputDeltaText,
            { delta: "retained pre-upgrade output" },
            { headers },
          ),
        );
        journal = new SqliteAgentRunJournal({
          dbPath: join(f.directory, "request-delivery.sqlite"),
        });
        const recovered = requireBusOk(journal.loadRecoveryHeads());
        if (prior === "corrupt-checkpoint") {
          expect(recovered.resets).toMatchObject([{ scope: "run", reason: "corrupt-payload" }]);
        } else if (prior === "future-journal") {
          expect(recovered.resets).toMatchObject([{ scope: "all", reason: "incompatible-schema" }]);
        } else {
          expect(recovered.resets).toEqual([]);
        }
        expect(requireBusOk(f.store.load(identity.requestDeliveryId))).toEqual(beforeUpgrade);
        expect(
          db
            .query<{ schema_version: number }, []>(
              "SELECT schema_version FROM agent_run_wal_metadata",
            )
            .get()?.schema_version,
        ).toBe(2);
        if (prior === "schema-1") {
          expect(recovered.heads[0]?.checkpoint?.messages).toContainEqual({
            role: "assistant",
            content: "retained checkpoint progress",
          });
          expect(
            db
              .query<{ delta: number; checkpoint_json: string | null }, []>(
                "SELECT e.delta, h.checkpoint_json FROM agent_run_wal_events e JOIN agent_run_wal_heads h USING (request_delivery_id) WHERE e.event_kind = 'checkpoint'",
              )
              .get(),
          ).toEqual({ delta: 0, checkpoint_json: null });
        }
        const recoveryJoin = joinAgentRunRecoveryHeads({
          heads: recovered.heads,
          requestDeliveryStore: f.store,
          journal,
          logger: { warn: () => undefined },
        });
        const prompts: string[] = [];
        const output = Promise.withResolvers<void>();
        const seen: string[] = [];
        requireBusOk(
          await f.bus.subscribeTopic(
            outReqTopic(identity.requestId),
            { mode: "tail", offset: { type: "begin" } },
            async (message) => {
              if (message.type === lilacEventTypes.EvtAgentOutputDeltaText)
                seen.push(message.data.delta);
              if (message.type === lilacEventTypes.EvtAgentOutputResponseText) output.resolve();
              return Result.ok(undefined);
            },
            () => "stop",
          ),
        );
        const config = parseCoreConfigV2ToUniversal({});
        config.models.main = { model: "openai/upgrade-test" };
        runner = await startBusAgentRunner({
          bus: f.bus,
          blobStore: f.blobs,
          requestDelivery: f.coordinator,
          agentRunJournal: journal,
          subscriptionId: "upgrade-runner",
          config,
          pluginManager: manager,
          startPaused: true,
          cwd: f.directory,
          issueControlCapability: () => ({ capability: "upgrade", principal: null }),
          reportFatalPanic: (error) => {
            throw error;
          },
          createAgent: (options) =>
            new AiSdkPiAgent({
              ...options,
              model: new MockLanguageModelV4({
                doStream: async (call) => {
                  prompts.push(JSON.stringify(call.prompt));
                  return level1TextStep("upgraded response");
                },
              }),
            }),
        });
        const currentRunner = runner;
        const recovery = requireBusOk(
          await f.coordinator.recoverAccepted((record) => {
            const decision = selectAgentRunAcceptedRecovery(recoveryJoin, record.requestDeliveryId);
            return currentRunner.resumeAcceptedDelivery(
              record,
              decision.kind === "resume" ? decision.head : undefined,
            );
          }),
        );
        expect(recovery.failures).toEqual([]);
        runner.activate();
        await withBusDeadline(output.promise, "upgraded runner output");
        await withBusDeadline(runner.waitForIdle(), "upgraded runner settlement");
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain("original accepted input");
        expect(prompts[0]?.includes("retained checkpoint progress")).toBe(prior === "schema-1");
        expect(seen[0]).toBe("retained pre-upgrade output");
        expect(seen.join("")).toContain("upgraded response");
        const replay = requireBusOk(
          await f.bus.fetchTopic(outReqTopic(identity.requestId), { offset: { type: "begin" } }),
        );
        expect(replay.messages[0]?.cursor).toBe(oldOutput.cursor);
        expect(requireBusOk(f.store.load(identity.requestDeliveryId))).toMatchObject({
          state: "terminal",
          outcome: { kind: "completed" },
        });
        expect(
          db
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM request_delivery_records")
            .get()?.count,
        ).toBe(1);
      } finally {
        await runner?.stop();
        requireBusOk(await manager.destroy());
        journal?.close();
        db.close();
        await f.close();
      }
    }, 15_000);
  }
});
