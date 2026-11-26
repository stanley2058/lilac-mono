import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Panic, Result, type Result as ResultType } from "better-result";
import {
  EventDeliveryStopFailed,
  EventDeliveryTransportFailed,
  RedisEventDeadLetter,
  type EventDeliveryDoneError,
} from "@stanley2058/lilac-event-bus";
import Redis from "ioredis";
import type { BlobStore } from "@stanley2058/lilac-blob-storage";

import {
  captureCoreEventBusCleanup,
  CoreResidualDiscordRequestRouterDoneTimedOut,
  type CoreResidualDiscordRequestRouterDoneOutcome,
  type CoreRuntimeCleanupFailure,
  createCoreEventBusDeliveryOptions,
  createCoreEventBusFatalReporter,
  createCoreEventBusLogger,
  createCoreRuntimeCleanupSupervisor,
  createCoreRuntimeFatalReporter,
  joinAgentRunRecoveryHeads,
  openCoreDurableStoresInStartupOrder,
  recoverAgentRunCheckpointBlobReferences,
  removeFullyReconciledAgentRunTerminalHeads,
  resolveRequestCapabilityIdentity,
  resolveCoreGracefulDrainDeadlineMs,
  retainCoreResidualDiscordRequestRouter,
  scheduleCoreBlobStoreClose,
  selectAgentRunAcceptedRecovery,
  selectCoreRuntimeStopPass,
  settleCoreResidualDiscordRequestRouterDone,
  stopCoreResidualDiscordRequestRouter,
  superviseCoreRouterDone,
} from "../../src/runtime/create-core-runtime";
import {
  AgentRunJournalSqliteFailure,
  SqliteAgentRunJournal,
} from "../../src/surface/bridge/agent-run-journal";
import {
  coreRequestDeliveryCodecs,
  SqliteRequestDeliveryStore,
  type CoreAcceptedRequestWork,
  type CorePreparedRequestEnvelope,
  type CoreRequestOutputMetadata,
} from "../../src/surface/bridge/request-delivery";
import { SqliteTranscriptStore } from "../../src/transcript/transcript-store";
import {
  ResidualDiscordRequestRouterStopFailed,
  type ResidualDiscordRequestRouter,
} from "../../src/surface/discord/discord-request-router";
import {
  BUILTIN_SURFACE_PROTOCOLS,
  resolveBuiltinSurfaceProtocolSafetyMode,
} from "../../src/surface/builtin-surface-protocols";
import type { SurfaceProtocolRouting } from "../../src/surface/protocol";
import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import { applyWorkflowSchemaMigrations } from "../../src/workflow/workflow-migrations";

const unusedEvidenceBlobStore: Pick<BlobStore, "startUpload"> = {
  startUpload: async () => {
    throw new Error("unexpected dead-letter evidence upload");
  },
};

function resultValue<T, TError extends Error>(result: ResultType<T, TError>): T {
  return result.match({
    ok: (value) => value,
    err: (error) => {
      throw error;
    },
  });
}

type RecoveryJoinStore = SqliteRequestDeliveryStore<
  CorePreparedRequestEnvelope,
  CoreAcceptedRequestWork,
  CoreRequestOutputMetadata
>;

function acceptRecoveryJoinOwner(
  store: RecoveryJoinStore,
  input: {
    readonly requestDeliveryId: string;
    readonly requestId: string;
    readonly sessionId: string;
    readonly requestClient?: "discord" | "unknown";
    readonly queue?: CoreAcceptedRequestWork["data"]["queue"];
    readonly raw?: unknown;
  },
): void {
  const requestClient = input.requestClient ?? "discord";
  const headers = {
    request_id: input.requestId,
    session_id: input.sessionId,
    request_client: requestClient,
  };
  const data = {
    requestDeliveryId: input.requestDeliveryId,
    queue: input.queue ?? "prompt",
    messages: [{ role: "user" as const, content: "recover me" }],
    ...(input.raw === undefined ? {} : { raw: input.raw }),
  };
  resultValue(
    store.prepare({
      requestDeliveryId: input.requestDeliveryId,
      requestId: input.requestId,
      envelope: { headers, data },
      inputHandles: [],
      createdAt: 1,
    }),
  );
  resultValue(
    store.accept({
      requestDeliveryId: input.requestDeliveryId,
      work: {
        requestDeliveryId: input.requestDeliveryId,
        requestId: input.requestId,
        sessionId: input.sessionId,
        requestClient,
        headers,
        data,
      },
      inputReferences: [],
      acceptedAt: 2,
    }),
  );
}

function createRecoveryJoinStore(dbPath: string): RecoveryJoinStore {
  return new SqliteRequestDeliveryStore({
    dbPath,
    codecs: coreRequestDeliveryCodecs,
  });
}

const noWorkflowRecoveryAuthority = {
  authorizeWorkflowRequest: () => null,
};

describe("delegated request capability identity", () => {
  const authenticatedOrigin = {
    platform: "discord" as const,
    userId: "user-1",
    sessionRef: { platform: "discord" as const, channelId: "channel-1" },
  };

  it("preserves resolved safety only for a matching internal unknown-client projection", () => {
    expect(
      resolveRequestCapabilityIdentity({
        requestClient: "unknown",
        sessionId: "workflow-child",
        safetyMode: "trusted",
        authenticatedOrigin,
        cachedRequest: {
          requestId: "child-1",
          requestClient: "unknown",
          sessionId: "workflow-child",
          source: "internal-delegated",
          authenticatedOrigin,
          authenticationMetadataKind: "origin",
          verifiedIngress: false,
        },
      }),
    ).toEqual({
      principal: { platform: "discord", userId: "user-1" },
      authenticatedOrigin,
      safetyMode: "trusted",
    });
  });

  it("does not grant trust to a raw external unknown-client projection", () => {
    expect(
      resolveRequestCapabilityIdentity({
        requestClient: "unknown",
        sessionId: "workflow-child",
        safetyMode: "trusted",
        cachedRequest: {
          requestId: "child-1",
          requestClient: "unknown",
          sessionId: "workflow-child",
          source: "external",
          authenticationMetadataKind: "absent",
          verifiedIngress: false,
        },
      }),
    ).toEqual({
      principal: null,
      authenticatedOrigin: null,
      safetyMode: "restricted",
    });
  });

  it("does not grant principal or asserted trust from registered protocol membership", () => {
    expect(
      resolveRequestCapabilityIdentity({
        requestClient: "discord",
        sessionId: "channel-1",
        safetyMode: "trusted",
        cachedRequest: {
          requestId: "discord:channel-1:message-1",
          requestClient: "discord",
          sessionId: "channel-1",
          source: "external",
          platform: "discord",
          sessionRef: { platform: "discord", channelId: "channel-1" },
          messageRef: {
            platform: "discord",
            channelId: "channel-1",
            messageId: "message-1",
          },
          authenticationMetadataKind: "absent",
          verifiedIngress: false,
        },
      }),
    ).toEqual({
      principal: null,
      authenticatedOrigin: null,
      safetyMode: "restricted",
    });
  });

  it("preserves asserted safety when a built-in protocol has no external override", () => {
    const protocol = {
      ...BUILTIN_SURFACE_PROTOCOLS.discord,
      requestProjection: { inferRequestMessageRef: true },
    } satisfies SurfaceProtocolRouting<"discord">;

    expect(
      resolveBuiltinSurfaceProtocolSafetyMode({
        protocol,
        verifiedIngress: true,
        assertedSafetyMode: "trusted",
      }),
    ).toBe("trusted");
    expect(
      resolveBuiltinSurfaceProtocolSafetyMode({
        protocol,
        verifiedIngress: true,
        assertedSafetyMode: "restricted",
      }),
    ).toBe("restricted");
  });
});

describe("Core runtime startup", () => {
  it("resets unsafe checkpoint recovery and clears stale blob ownership", () => {
    const reconcileCalls: Array<
      readonly { readonly requestDeliveryId: string; readonly messages: readonly object[] }[]
    > = [];
    let reconciliationAttempt = 0;
    const decision = recoverAgentRunCheckpointBlobReferences({
      heads: new Map([
        [
          "delivery-1",
          {
            handle: {
              runId: "delivery-1",
              requestId: "request-1",
              sessionId: "session-1",
              sequence: 3,
            },
            state: "active" as const,
            checkpoint: {
              version: 1 as const,
              messages: [{ role: "user" as const, content: "latest" }],
              retainedRequestDeliveries: [],
            },
            previousCheckpoint: {
              version: 1 as const,
              messages: [{ role: "user" as const, content: "previous" }],
              retainedRequestDeliveries: [],
            },
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      ]),
      reconcile: ({ checkpoints }) => {
        reconcileCalls.push(checkpoints);
        reconciliationAttempt += 1;
        return reconciliationAttempt === 1
          ? Result.err(new Error("checkpoint blob missing"))
          : Result.ok(undefined);
      },
      resetAll: () => Result.ok(undefined),
    });

    expect(decision.kind).toBe("reset");
    expect(reconcileCalls).toEqual([
      [
        {
          requestDeliveryId: "delivery-1",
          messages: [
            { role: "user", content: "latest" },
            { role: "user", content: "previous" },
          ],
        },
      ],
      [],
    ]);
  });

  it("disables checkpoint recovery when its journal cannot reset", () => {
    const reconciliationError = new Error("checkpoint blob missing");
    const resetError = new Error("journal reset failed");
    const decision = recoverAgentRunCheckpointBlobReferences({
      heads: new Map(),
      reconcile: () => Result.err(reconciliationError),
      resetAll: () => Result.err(resetError),
    });

    expect(decision).toEqual({
      kind: "disabled",
      reconciliationError,
      resetError,
    });
  });

  it("stops WAL recovery after a run reset fails and falls every accepted owner back to original work", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lilac-core-recovery-join-"));
    const dbPath = path.join(dir, "request-delivery.db");
    const store = createRecoveryJoinStore(dbPath);
    const journal = new SqliteAgentRunJournal({ dbPath, now: () => 10 });

    try {
      const owners = [
        {
          requestDeliveryId: "11111111-1111-4111-8111-111111111111",
          requestId: "request-reset-fails",
          sessionId: "session-reset-fails",
        },
        {
          requestDeliveryId: "22222222-2222-4222-8222-222222222222",
          requestId: "request-later-invalid",
          sessionId: "session-later-invalid",
        },
        {
          requestDeliveryId: "33333333-3333-4333-8333-333333333333",
          requestId: "request-later-valid",
          sessionId: "session-later-valid",
        },
      ] as const;
      for (const owner of owners) {
        acceptRecoveryJoinOwner(store, owner);
        resultValue(journal.openRun(owner));
      }
      const loaded = resultValue(journal.loadRecoveryHeads()).heads;
      const heads = loaded.map((head, index) =>
        index < 2
          ? {
              ...head,
              handle: { ...head.handle, requestId: `incompatible-${index}` },
            }
          : head,
      );
      const resetCalls: string[] = [];
      const removeCalls: string[] = [];
      const resetFailure = new AgentRunJournalSqliteFailure({
        operation: "reset-run",
        code: "SQLITE_IOERR",
        message: "injected startup reset failure",
      });
      const joined = joinAgentRunRecoveryHeads({
        heads,
        requestDeliveryStore: store,
        journal: {
          resetRun: (runId) => {
            resetCalls.push(runId);
            return Result.err(resetFailure);
          },
          removeReconciled: (runId) => {
            removeCalls.push(runId);
            return Result.ok(undefined);
          },
        },
        workflowAuthority: noWorkflowRecoveryAuthority,
        logger: { warn: () => undefined },
      });

      expect(joined.journalResetFailure).toBe(resetFailure);
      expect(joined.heads.size).toBe(0);
      expect(joined.retainedOwners.size).toBe(0);
      expect(joined.recoverableRootParentRequestIds).toEqual([]);
      expect(resetCalls).toEqual([owners[0].requestDeliveryId]);
      expect(removeCalls).toEqual([]);
      for (const owner of owners) {
        expect(selectAgentRunAcceptedRecovery(joined, owner.requestDeliveryId)).toEqual({
          kind: "resume",
        });
      }
    } finally {
      journal.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resets active WAL heads with incompatible accepted request identity", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lilac-core-recovery-join-"));
    const dbPath = path.join(dir, "request-delivery.db");
    const store = createRecoveryJoinStore(dbPath);
    const journal = new SqliteAgentRunJournal({ dbPath, now: () => 10 });
    const notices: Array<{
      readonly message: string;
      readonly context: Readonly<Record<string, string | number | boolean>>;
    }> = [];

    try {
      const requestMismatch = {
        requestDeliveryId: "11111111-1111-4111-8111-111111111111",
        requestId: "request-1",
        sessionId: "session-1",
      };
      const sessionMismatch = {
        requestDeliveryId: "22222222-2222-4222-8222-222222222222",
        requestId: "request-2",
        sessionId: "session-2",
      };
      acceptRecoveryJoinOwner(store, requestMismatch);
      acceptRecoveryJoinOwner(store, sessionMismatch);
      resultValue(journal.openRun(requestMismatch));
      resultValue(
        journal.openRun({
          ...sessionMismatch,
          sessionId: "wrong-session",
        }),
      );
      const loaded = resultValue(journal.loadRecoveryHeads()).heads;
      const requestMismatchHead = loaded.find(
        (head) => head.handle.runId === requestMismatch.requestDeliveryId,
      );
      if (!requestMismatchHead) throw new Error("expected request mismatch recovery head");
      const joined = joinAgentRunRecoveryHeads({
        heads: loaded.map((head) =>
          head === requestMismatchHead
            ? {
                ...head,
                handle: { ...head.handle, requestId: "wrong-request" },
              }
            : head,
        ),
        requestDeliveryStore: store,
        journal,
        workflowAuthority: noWorkflowRecoveryAuthority,
        logger: {
          warn: (message, context) => notices.push({ message, context }),
        },
      });

      expect(joined.heads.size).toBe(0);
      expect(resultValue(journal.loadRecoveryHeads()).heads).toEqual([]);
      expect(notices.map(({ context }) => context.reason)).toEqual([
        "incompatible-identity",
        "incompatible-identity",
      ]);
      expect(JSON.stringify(notices)).not.toContain("recover me");
    } finally {
      journal.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("admits only owned accepted control deliveries retained by checkpoints", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lilac-core-recovery-join-"));
    const dbPath = path.join(dir, "request-delivery.db");
    const store = createRecoveryJoinStore(dbPath);
    const journal = new SqliteAgentRunJournal({ dbPath, now: () => 10 });
    const notices: Array<Readonly<Record<string, string | number | boolean>>> = [];
    const invalidOwnerIds: string[] = [];

    try {
      const writeRetainedCheckpoint = (
        owner: {
          readonly requestDeliveryId: string;
          readonly requestId: string;
          readonly sessionId: string;
        },
        retainedRequestDeliveryIds: readonly string[],
      ) => {
        const handle = resultValue(journal.openRun(owner));
        return resultValue(
          journal.writeCheckpoint(handle, {
            version: 1,
            messages: [{ role: "user", content: `checkpoint for ${owner.requestId}` }],
            retainedRequestDeliveries: retainedRequestDeliveryIds.map((requestDeliveryId) => ({
              requestDeliveryId,
              outcome: { kind: "completed" },
            })),
          }),
        );
      };
      const acceptControl = (input: {
        readonly requestId: string;
        readonly sessionId: string;
        readonly queue?: CoreAcceptedRequestWork["data"]["queue"];
      }) => {
        const control = {
          requestDeliveryId: crypto.randomUUID(),
          requestId: input.requestId,
          sessionId: input.sessionId,
          queue: input.queue ?? ("steer" as const),
          raw: { requiresActive: true },
        };
        acceptRecoveryJoinOwner(store, control);
        return control;
      };

      const validOwner = {
        requestDeliveryId: crypto.randomUUID(),
        requestId: "request-valid-retained",
        sessionId: "session-valid-retained",
      };
      acceptRecoveryJoinOwner(store, validOwner);
      const validControl = acceptControl({
        requestId: validOwner.requestId,
        sessionId: validOwner.sessionId,
      });
      writeRetainedCheckpoint(validOwner, [validControl.requestDeliveryId]);

      const terminalParent = {
        requestDeliveryId: crypto.randomUUID(),
        requestId: "request-terminal-parent",
        sessionId: "session-terminal-parent",
      };
      acceptRecoveryJoinOwner(store, terminalParent);
      const terminalParentControl = acceptControl({
        requestId: terminalParent.requestId,
        sessionId: terminalParent.sessionId,
      });
      const terminalParentHandle = writeRetainedCheckpoint(terminalParent, [
        terminalParentControl.requestDeliveryId,
      ]);
      resultValue(
        journal.markTerminal(terminalParentHandle, {
          outcome: { kind: "completed", code: "terminal-parent-recovered" },
          finalReplayDeadline: 99,
        }),
      );

      const missingOwner = {
        requestDeliveryId: crypto.randomUUID(),
        requestId: "request-missing-retained",
        sessionId: "session-missing-retained",
      };
      acceptRecoveryJoinOwner(store, missingOwner);
      invalidOwnerIds.push(missingOwner.requestDeliveryId);
      writeRetainedCheckpoint(missingOwner, [crypto.randomUUID()]);

      const terminalOwner = {
        requestDeliveryId: crypto.randomUUID(),
        requestId: "request-terminal-retained",
        sessionId: "session-terminal-retained",
      };
      acceptRecoveryJoinOwner(store, terminalOwner);
      const terminalControl = acceptControl({
        requestId: terminalOwner.requestId,
        sessionId: terminalOwner.sessionId,
      });
      resultValue(
        store.terminalize({
          requestDeliveryId: terminalControl.requestDeliveryId,
          outcome: { kind: "completed" },
          terminalAt: 3,
          transportCommitRequired: false,
        }),
      );
      invalidOwnerIds.push(terminalOwner.requestDeliveryId);
      writeRetainedCheckpoint(terminalOwner, [terminalControl.requestDeliveryId]);

      const wrongKindOwner = {
        requestDeliveryId: crypto.randomUUID(),
        requestId: "request-wrong-kind-retained",
        sessionId: "session-wrong-kind-retained",
      };
      acceptRecoveryJoinOwner(store, wrongKindOwner);
      const promptReference = acceptControl({
        requestId: wrongKindOwner.requestId,
        sessionId: wrongKindOwner.sessionId,
        queue: "prompt",
      });
      invalidOwnerIds.push(wrongKindOwner.requestDeliveryId);
      writeRetainedCheckpoint(wrongKindOwner, [promptReference.requestDeliveryId]);

      const unrelatedOwner = {
        requestDeliveryId: crypto.randomUUID(),
        requestId: "request-unrelated-owner",
        sessionId: "session-unrelated-retained",
      };
      acceptRecoveryJoinOwner(store, unrelatedOwner);
      const unrelatedControl = acceptControl({
        requestId: "request-unrelated-control",
        sessionId: unrelatedOwner.sessionId,
      });
      invalidOwnerIds.push(unrelatedOwner.requestDeliveryId);
      writeRetainedCheckpoint(unrelatedOwner, [unrelatedControl.requestDeliveryId]);

      const duplicateOwner = {
        requestDeliveryId: crypto.randomUUID(),
        requestId: "request-duplicate-retained",
        sessionId: "session-duplicate-retained",
      };
      acceptRecoveryJoinOwner(store, duplicateOwner);
      const duplicateControl = acceptControl({
        requestId: duplicateOwner.requestId,
        sessionId: duplicateOwner.sessionId,
      });
      invalidOwnerIds.push(duplicateOwner.requestDeliveryId);
      writeRetainedCheckpoint(duplicateOwner, [
        duplicateControl.requestDeliveryId,
        duplicateControl.requestDeliveryId,
      ]);

      const joined = joinAgentRunRecoveryHeads({
        heads: resultValue(journal.loadRecoveryHeads()).heads,
        requestDeliveryStore: store,
        journal,
        workflowAuthority: noWorkflowRecoveryAuthority,
        logger: { warn: (_message, context) => notices.push(context) },
      });

      expect(new Set(joined.heads.keys())).toEqual(
        new Set([validOwner.requestDeliveryId, terminalParent.requestDeliveryId]),
      );
      expect(
        new Set(resultValue(journal.loadRecoveryHeads()).heads.map((head) => head.handle.runId)),
      ).toEqual(new Set([validOwner.requestDeliveryId, terminalParent.requestDeliveryId]));
      expect(notices.map((context) => context.reason)).toEqual(
        invalidOwnerIds.map(() => "invalid-retained-delivery"),
      );
      expect(resultValue(store.load(unrelatedControl.requestDeliveryId)).state).toBe("accepted");
      expect(joined.heads.has(unrelatedOwner.requestDeliveryId)).toBe(false);
      expect(selectAgentRunAcceptedRecovery(joined, validControl.requestDeliveryId)).toEqual({
        kind: "retained-active",
        ownerRunId: validOwner.requestDeliveryId,
      });
      expect(
        selectAgentRunAcceptedRecovery(joined, terminalParentControl.requestDeliveryId),
      ).toEqual({
        kind: "terminal",
        outcome: { kind: "completed" },
        finalReplayDeadline: 99,
      });
      expect(selectAgentRunAcceptedRecovery(joined, unrelatedControl.requestDeliveryId)).toEqual({
        kind: "resume",
      });
      expect(selectAgentRunAcceptedRecovery(joined, unrelatedOwner.requestDeliveryId)).toEqual({
        kind: "resume",
      });
    } finally {
      journal.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reconciles an active WAL head whose request owner is already terminal", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lilac-core-recovery-join-"));
    const dbPath = path.join(dir, "request-delivery.db");
    const store = createRecoveryJoinStore(dbPath);
    const journal = new SqliteAgentRunJournal({ dbPath, now: () => 10 });
    const notices: Array<Readonly<Record<string, string | number | boolean>>> = [];

    try {
      const owner = {
        requestDeliveryId: crypto.randomUUID(),
        requestId: "request-terminal",
        sessionId: "session-terminal",
      };
      acceptRecoveryJoinOwner(store, owner);
      resultValue(journal.openRun(owner));
      resultValue(
        store.terminalize({
          requestDeliveryId: owner.requestDeliveryId,
          outcome: { kind: "completed" },
          terminalAt: 3,
          transportCommitRequired: false,
        }),
      );

      const joined = joinAgentRunRecoveryHeads({
        heads: resultValue(journal.loadRecoveryHeads()).heads,
        requestDeliveryStore: store,
        journal,
        workflowAuthority: noWorkflowRecoveryAuthority,
        logger: { warn: (_message, context) => notices.push(context) },
      });

      expect(joined.heads.size).toBe(0);
      expect(resultValue(journal.loadRecoveryHeads()).heads).toEqual([]);
      expect(notices).toEqual([
        {
          requestDeliveryId: owner.requestDeliveryId,
          operation: "reconcile",
          reason: "owner-terminal",
        },
      ]);
    } finally {
      journal.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps a terminal WAL head until its partially terminalized retained controls converge", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lilac-core-recovery-join-"));
    const dbPath = path.join(dir, "request-delivery.db");
    const store = createRecoveryJoinStore(dbPath);
    const journal = new SqliteAgentRunJournal({ dbPath, now: () => 10 });

    try {
      const owner = {
        requestDeliveryId: crypto.randomUUID(),
        requestId: "request-partial-terminal",
        sessionId: "session-partial-terminal",
      };
      const controls = [crypto.randomUUID(), crypto.randomUUID()].map((requestDeliveryId) => ({
        requestDeliveryId,
        requestId: owner.requestId,
        sessionId: owner.sessionId,
        queue: "steer" as const,
        raw: { requiresActive: true },
      }));
      acceptRecoveryJoinOwner(store, owner);
      for (const control of controls) acceptRecoveryJoinOwner(store, control);
      const checkpoint = resultValue(
        journal.writeCheckpoint(resultValue(journal.openRun(owner)), {
          version: 1,
          messages: [{ role: "user", content: "terminal checkpoint" }],
          retainedRequestDeliveries: controls.map((control) => ({
            requestDeliveryId: control.requestDeliveryId,
            outcome: { kind: "completed", code: "control-applied" },
          })),
        }),
      );
      resultValue(
        journal.markTerminal(checkpoint, {
          outcome: { kind: "completed", code: "owner-completed" },
          finalReplayDeadline: 99,
        }),
      );
      resultValue(
        store.terminalize({
          requestDeliveryId: owner.requestDeliveryId,
          outcome: { kind: "completed", code: "owner-completed" },
          terminalAt: 3,
          transportCommitRequired: false,
          finalReplayDeadline: 99,
        }),
      );
      resultValue(
        store.terminalize({
          requestDeliveryId: controls[0]!.requestDeliveryId,
          outcome: { kind: "completed", code: "control-applied" },
          terminalAt: 4,
          transportCommitRequired: false,
        }),
      );

      const joined = joinAgentRunRecoveryHeads({
        heads: resultValue(journal.loadRecoveryHeads()).heads,
        requestDeliveryStore: store,
        journal,
        workflowAuthority: noWorkflowRecoveryAuthority,
        logger: { warn: () => undefined },
      });
      expect([...joined.heads.keys()]).toEqual([owner.requestDeliveryId]);
      expect(selectAgentRunAcceptedRecovery(joined, controls[1]!.requestDeliveryId)).toEqual({
        kind: "terminal",
        outcome: { kind: "completed", code: "control-applied" },
        finalReplayDeadline: 99,
      });

      expect(
        removeFullyReconciledAgentRunTerminalHeads({
          heads: joined.heads,
          requestDeliveryStore: store,
          journal,
        }),
      ).toEqual([]);
      expect(resultValue(journal.loadRecoveryHeads()).heads).toHaveLength(1);

      resultValue(
        store.terminalize({
          requestDeliveryId: controls[1]!.requestDeliveryId,
          outcome: { kind: "completed", code: "control-applied" },
          terminalAt: 5,
          transportCommitRequired: false,
        }),
      );
      expect(
        removeFullyReconciledAgentRunTerminalHeads({
          heads: joined.heads,
          requestDeliveryStore: store,
          journal,
        }),
      ).toEqual([owner.requestDeliveryId]);
      expect(resultValue(journal.loadRecoveryHeads()).heads).toEqual([]);
    } finally {
      journal.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resets only a terminal head that claims an unrelated terminal control", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lilac-core-recovery-join-"));
    const dbPath = path.join(dir, "request-delivery.db");
    const store = createRecoveryJoinStore(dbPath);
    const journal = new SqliteAgentRunJournal({ dbPath, now: () => 10 });
    const notices: Array<Readonly<Record<string, string | number | boolean>>> = [];

    try {
      const validOwner = {
        requestDeliveryId: crypto.randomUUID(),
        requestId: "request-valid-neighbor",
        sessionId: "session-valid-neighbor",
      };
      acceptRecoveryJoinOwner(store, validOwner);
      resultValue(journal.openRun(validOwner));

      const badOwner = {
        requestDeliveryId: crypto.randomUUID(),
        requestId: "request-bad-terminal-owner",
        sessionId: "session-bad-terminal-owner",
      };
      const unrelatedControl = {
        requestDeliveryId: crypto.randomUUID(),
        requestId: "request-unrelated-terminal-control",
        sessionId: badOwner.sessionId,
        queue: "steer" as const,
        raw: { requiresActive: true },
      };
      acceptRecoveryJoinOwner(store, badOwner);
      acceptRecoveryJoinOwner(store, unrelatedControl);
      const checkpoint = resultValue(
        journal.writeCheckpoint(resultValue(journal.openRun(badOwner)), {
          version: 1,
          messages: [],
          retainedRequestDeliveries: [
            {
              requestDeliveryId: unrelatedControl.requestDeliveryId,
              outcome: { kind: "completed", code: "control-applied" },
            },
          ],
        }),
      );
      resultValue(
        journal.markTerminal(checkpoint, {
          outcome: { kind: "completed", code: "owner-completed" },
        }),
      );
      resultValue(
        store.terminalize({
          requestDeliveryId: badOwner.requestDeliveryId,
          outcome: { kind: "completed", code: "owner-completed" },
          terminalAt: 3,
          transportCommitRequired: false,
        }),
      );
      resultValue(
        store.terminalize({
          requestDeliveryId: unrelatedControl.requestDeliveryId,
          outcome: { kind: "completed", code: "control-applied" },
          terminalAt: 4,
          transportCommitRequired: false,
        }),
      );

      const joined = joinAgentRunRecoveryHeads({
        heads: resultValue(journal.loadRecoveryHeads()).heads,
        requestDeliveryStore: store,
        journal,
        workflowAuthority: noWorkflowRecoveryAuthority,
        logger: { warn: (_message, context) => notices.push(context) },
      });

      expect([...joined.heads.keys()]).toEqual([validOwner.requestDeliveryId]);
      expect(
        resultValue(journal.loadRecoveryHeads()).heads.map((head) => head.handle.runId),
      ).toEqual([validOwner.requestDeliveryId]);
      expect(notices).toEqual([
        {
          requestDeliveryId: badOwner.requestDeliveryId,
          operation: "reset",
          reason: "invalid-retained-delivery",
        },
      ]);
      expect(resultValue(store.load(unrelatedControl.requestDeliveryId)).state).toBe("terminal");
    } finally {
      journal.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps one deterministic active WAL head per session", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lilac-core-recovery-join-"));
    const dbPath = path.join(dir, "request-delivery.db");
    const store = createRecoveryJoinStore(dbPath);
    const journal = new SqliteAgentRunJournal({ dbPath, now: () => 10 });
    const notices: Array<Readonly<Record<string, string | number | boolean>>> = [];

    try {
      const first = {
        requestDeliveryId: "11111111-1111-4111-8111-111111111111",
        requestId: "request-first",
        sessionId: "shared-session",
      };
      const second = {
        requestDeliveryId: "22222222-2222-4222-8222-222222222222",
        requestId: "request-second",
        sessionId: "shared-session",
      };
      acceptRecoveryJoinOwner(store, first);
      acceptRecoveryJoinOwner(store, second);
      resultValue(journal.openRun(first));
      resultValue(journal.openRun(second));
      const loaded = resultValue(journal.loadRecoveryHeads()).heads;

      const joined = joinAgentRunRecoveryHeads({
        heads: [...loaded].reverse(),
        requestDeliveryStore: store,
        journal,
        workflowAuthority: noWorkflowRecoveryAuthority,
        logger: { warn: (_message, context) => notices.push(context) },
      });

      expect([...joined.heads.keys()]).toEqual([first.requestDeliveryId]);
      expect(joined.recoverableRootParentRequestIds).toEqual([first.requestId]);
      expect(
        resultValue(journal.loadRecoveryHeads()).heads.map((head) => head.handle.runId),
      ).toEqual([first.requestDeliveryId]);
      expect(notices).toEqual([
        {
          requestDeliveryId: second.requestDeliveryId,
          operation: "reset",
          reason: "duplicate-active-session",
        },
      ]);
      expect(resultValue(store.load(second.requestDeliveryId)).state).toBe("accepted");
    } finally {
      journal.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not protect workflow-owned recovered runs as live root parents", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lilac-core-recovery-join-"));
    const dbPath = path.join(dir, "request-delivery.db");
    const store = createRecoveryJoinStore(dbPath);
    const journal = new SqliteAgentRunJournal({ dbPath, now: () => 10 });

    try {
      const workflowOwner = {
        requestDeliveryId: crypto.randomUUID(),
        requestId: "request-workflow-child",
        sessionId: "workflow-child-session",
        requestClient: "unknown" as const,
        raw: {
          workflow: {
            runId: "workflow-run",
            operationId: "workflow-operation",
            dispatchEpoch: "dispatch-epoch-0001",
          },
        },
      };
      const staleHintOwner = {
        requestDeliveryId: crypto.randomUUID(),
        requestId: "request-stale-workflow-hint",
        sessionId: "stale-workflow-hint-session",
        requestClient: "unknown" as const,
        raw: workflowOwner.raw,
      };
      acceptRecoveryJoinOwner(store, workflowOwner);
      acceptRecoveryJoinOwner(store, staleHintOwner);
      resultValue(journal.openRun(workflowOwner));
      resultValue(journal.openRun(staleHintOwner));

      const joined = joinAgentRunRecoveryHeads({
        heads: resultValue(journal.loadRecoveryHeads()).heads,
        requestDeliveryStore: store,
        journal,
        workflowAuthority: {
          authorizeWorkflowRequest: ({ requestId }) =>
            requestId === workflowOwner.requestId
              ? {
                  policy: {
                    runId: workflowOwner.raw.workflow.runId,
                    operationId: workflowOwner.raw.workflow.operationId,
                    dispatchEpoch: workflowOwner.raw.workflow.dispatchEpoch,
                  },
                }
              : null,
        },
        logger: { warn: () => undefined },
      });

      expect(new Set(joined.heads.keys())).toEqual(
        new Set([workflowOwner.requestDeliveryId, staleHintOwner.requestDeliveryId]),
      );
      expect(joined.recoverableRootParentRequestIds).toEqual([staleHintOwner.requestId]);
    } finally {
      journal.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves recoverable transcript state unchanged when workflow schema validation fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lilac-core-transcript-preflight-"));
    const transcriptPath = path.join(dir, "transcripts.db");
    const workflowPath = path.join(dir, "workflow.sqlite3");
    const seededTranscript = new SqliteTranscriptStore(transcriptPath);
    const reserved = seededTranscript.reserveCoreNamedClaudeSessionAttempt({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: "session-1",
      executionScopeHashVersion: 1,
      executionScopeHash: "scope",
      requestId: "request-1",
      attemptIndex: 0,
      candidateSessionId: crypto.randomUUID(),
      sourceSessionId: null,
      expectedBindingRevision: null,
    });
    if (reserved.status === "error") throw reserved.error;
    seededTranscript.close();
    const transcriptBefore = await readFile(transcriptPath);
    const legacyWorkflow = new Database(workflowPath, { strict: true });
    const migrated = applyWorkflowSchemaMigrations(legacyWorkflow, () => 1, 25);
    if (migrated.status === "error") throw migrated.error;
    legacyWorkflow.close();
    const deferredTranscript: { store: SqliteTranscriptStore | null } = {
      store: null,
    };

    try {
      expect(() =>
        openCoreDurableStoresInStartupOrder({
          openTranscript: () => {
            deferredTranscript.store = new SqliteTranscriptStore(
              transcriptPath,
              undefined,
              undefined,
              { deferStartupRecovery: true },
            );
          },
          openDiscordSearch: () => undefined,
          openDiscordSurface: () => undefined,
          openConversationThread: () => undefined,
          openDiscovery: () => undefined,
          openWorkflow: () => {
            new DurableWorkflowStore(workflowPath, {
              deferStartupRecovery: true,
            });
          },
        }),
      ).toThrow("requires offline blob migration");

      deferredTranscript.store?.close();
      deferredTranscript.store = null;
      expect(await readFile(transcriptPath)).toEqual(transcriptBefore);
      using transcriptState = new Database(transcriptPath, {
        readonly: true,
        strict: true,
      });
      expect(
        transcriptState
          .query<{ state: string }, []>(
            "SELECT state FROM core_named_claude_attempts WHERE request_id = 'request-1'",
          )
          .get(),
      ).toEqual({ state: "active" });
    } finally {
      deferredTranscript.store?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reserves the blob cleanup slice before the hard shutdown deadline", () => {
    expect(
      resolveCoreGracefulDrainDeadlineMs({
        nowMs: 1_000,
        hardDeadlineAtMs: 6_000,
        configuredDrainDeadlineMs: 3_000,
      }),
    ).toBe(3_000);
    expect(
      resolveCoreGracefulDrainDeadlineMs({
        nowMs: 3_500,
        hardDeadlineAtMs: 6_000,
        configuredDrainDeadlineMs: 3_000,
      }),
    ).toBe(1_500);
    expect(
      resolveCoreGracefulDrainDeadlineMs({
        nowMs: 5_500,
        hardDeadlineAtMs: 6_000,
        configuredDrainDeadlineMs: 3_000,
      }),
    ).toBe(0);
  });

  it("starts blob fencing at the reserved cleanup slice even when earlier cleanup is pending", async () => {
    let scheduledDelayMs = -1;
    let deadlineCallback = (): void => {
      throw new Error("Blob close deadline was not scheduled");
    };
    let cancelled = false;
    let closeCount = 0;
    const closed = Promise.withResolvers<void>();
    const controller = scheduleCoreBlobStoreClose({
      hardDeadlineAtMs: 6_000,
      now: () => 1_000,
      close: async () => {
        closeCount += 1;
        closed.resolve();
      },
      scheduleDeadline: (callback, delayMs) => {
        deadlineCallback = callback;
        scheduledDelayMs = delayMs;
        return () => {
          cancelled = true;
        };
      },
    });

    expect(scheduledDelayMs).toBe(4_000);
    deadlineCallback();
    await closed.promise;
    await controller.closeNow();

    expect(closeCount).toBe(1);
    expect(cancelled).toBe(true);
  });

  it("closes blob storage early and cancels its reserved deadline", async () => {
    let deadlineCallback = (): void => {
      throw new Error("Blob close deadline was not scheduled");
    };
    let cancelled = false;
    let closeCount = 0;
    const controller = scheduleCoreBlobStoreClose({
      hardDeadlineAtMs: 6_000,
      now: () => 1_000,
      close: async () => {
        closeCount += 1;
      },
      scheduleDeadline: (callback) => {
        deadlineCallback = callback;
        return () => {
          cancelled = true;
        };
      },
    });

    await controller.closeNow();
    deadlineCallback();
    await controller.closeNow();

    expect(closeCount).toBe(1);
    expect(cancelled).toBe(true);
  });

  it.each([
    ["Error", () => new Error("cleanup failed")],
    ["Panic", () => new Panic({ message: "cleanup invariant failed" })],
  ] as const)(
    "preserves a startup Panic through cleanup %s and continues cleanup",
    async (_, cause) => {
      const startupPanic = new Panic({ message: "startup invariant failed" });
      const cleanupFailure = cause();
      const calls: string[] = [];
      const cleanup = createCoreRuntimeCleanupSupervisor(startupPanic);
      let thrown: unknown;

      try {
        await cleanup.run("failing", async () => {
          calls.push("failing");
          throw cleanupFailure;
        });
        await cleanup.run("continued", async () => {
          calls.push("continued");
        });
        cleanup.finish();
        throw startupPanic;
      } catch (cause) {
        thrown = cause;
      }

      expect(calls).toEqual(["failing", "continued"]);
      expect(cleanup.failures).toEqual([
        {
          label: "failing",
          error: cleanupFailure.message,
          panic: Panic.is(cleanupFailure),
        },
      ]);
      expect(thrown).toBe(startupPanic);
    },
  );

  it("continues cleanup before propagating the first cleanup Panic without a prior Panic", async () => {
    const firstPanic = new Panic({ message: "first cleanup invariant failed" });
    const secondPanic = new Panic({
      message: "second cleanup invariant failed",
    });
    const calls: string[] = [];
    const cleanup = createCoreRuntimeCleanupSupervisor(null);

    await cleanup.run("first", async () => {
      calls.push("first");
      throw firstPanic;
    });
    await cleanup.run("second", async () => {
      calls.push("second");
      throw secondPanic;
    });
    await cleanup.run("continued", async () => {
      calls.push("continued");
    });

    expect(calls).toEqual(["first", "second", "continued"]);
    expect(() => cleanup.finish()).toThrow(firstPanic);
  });

  it("records a synchronous cleanup throw and continues cleanup", async () => {
    const failure = new Error("cleanup threw synchronously");
    const calls: string[] = [];
    const cleanup = createCoreRuntimeCleanupSupervisor(null);

    await cleanup.run("synchronous", () => {
      calls.push("synchronous");
      throw failure;
    });
    await cleanup.run("continued", async () => {
      calls.push("continued");
    });

    expect(calls).toEqual(["synchronous", "continued"]);
    expect(cleanup.failures).toEqual([
      { label: "synchronous", error: failure.message, panic: false },
    ]);
  });

  it("supervises typed cleanup outcomes without converting them back to rejections", async () => {
    const cleanupPanic = new Panic({
      message: "typed cleanup invariant failed",
    });
    const cleanup = createCoreRuntimeCleanupSupervisor(null);

    await cleanup.runOutcome("ordinary", async () => ({
      kind: "result",
      result: Result.err(new Error("typed cleanup failed")),
    }));
    await cleanup.runOutcome("panic", async () => ({
      kind: "panic",
      panic: cleanupPanic,
    }));

    expect(cleanup.failures).toEqual([
      { label: "ordinary", error: "typed cleanup failed", panic: false },
      { label: "panic", error: "typed cleanup invariant failed", panic: true },
    ]);
    expect(() => cleanup.finish()).toThrow(cleanupPanic);
  });

  it("retains and retries residual router ownership after an ordinary stop failure", async () => {
    const stopFailure = new ResidualDiscordRequestRouterStopFailed({
      failures: [
        new EventDeliveryStopFailed({
          topic: "evt.request",
          cause: new Error("cleanup failed"),
          message: "forced cleanup failure",
        }),
      ],
      message: "Residual router cleanup failed",
    });
    const done = Promise.withResolvers<ResultType<void, EventDeliveryDoneError>>();
    const calls: string[] = [];
    let router: ResidualDiscordRequestRouter;
    router = {
      done: done.promise,
      stop: async () => {
        calls.push("stop");
        if (calls.length === 1) {
          return {
            kind: "result",
            result: Result.err(stopFailure),
            residualRouter: router,
          };
        }
        done.resolve(Result.ok(undefined));
        return {
          kind: "result",
          result: Result.ok(undefined),
          residualRouter: null,
        };
      },
    };
    const cleanup = createCoreRuntimeCleanupSupervisor(null);

    const retained = await stopCoreResidualDiscordRequestRouter({
      router,
      cleanup,
    });
    expect(retained).toBe(router);
    if (!retained) throw new Error("expected retained residual ownership");
    const released = await stopCoreResidualDiscordRequestRouter({
      router: retained,
      cleanup,
    });

    expect(released).toBeNull();
    expect(calls).toEqual(["stop", "stop"]);
    expect(cleanup.failures).toEqual([
      {
        label: "residualRouter.stop",
        error: stopFailure.message,
        panic: false,
      },
    ]);
  });

  it("retains ownership after a synchronous residual router stop throw", async () => {
    const rejection = new Error("stop threw synchronously");
    const cleanup = createCoreRuntimeCleanupSupervisor(null);
    const router: ResidualDiscordRequestRouter = {
      done: Promise.resolve(Result.ok(undefined)),
      stop() {
        throw rejection;
      },
    };

    const retained = await stopCoreResidualDiscordRequestRouter({
      router,
      cleanup,
    });

    expect(retained).toBe(router);
    expect(cleanup.failures).toHaveLength(1);
    expect(cleanup.failures[0]).toMatchObject({
      label: "residualRouter.stop",
      panic: false,
    });
  });

  it("records an in-time residual done Result error", async () => {
    const failure = new EventDeliveryTransportFailed({
      topic: "evt.request",
      operation: "ack",
      cursor: "8-0",
      cause: new Error("Redis connection closed"),
      message: "Redis delivery acknowledgement failed",
    });
    const cleanup = createCoreRuntimeCleanupSupervisor(null);
    let cancelled = false;

    await settleCoreResidualDiscordRequestRouterDone({
      supervision: Promise.resolve({
        kind: "result",
        result: Result.err(failure),
      }),
      cleanup,
      reportLatePanic: () => {},
      deadlineMs: 3_000,
      scheduleDeadline: () => () => {
        cancelled = true;
      },
    });

    expect(cancelled).toBe(true);
    expect(cleanup.failures).toEqual([
      { label: "residualRouter.done", error: failure.message, panic: false },
    ]);
  });

  it("records every residual stop Panic and keeps exact first-Panic precedence", async () => {
    const firstPanic = new Panic({ message: "first residual stop panic" });
    const secondPanic = new Panic({ message: "second residual stop panic" });
    const ordinaryFailure = new ResidualDiscordRequestRouterStopFailed({
      failures: [
        new EventDeliveryStopFailed({
          topic: "evt.surface",
          cause: new Error("surface cleanup failed"),
          message: "forced surface cleanup failure",
        }),
      ],
      message: "Residual router ordinary cleanup failed",
    });
    let router: ResidualDiscordRequestRouter;
    router = {
      done: Promise.resolve(Result.ok(undefined)),
      stop: async () => ({
        kind: "panic",
        panic: firstPanic,
        additionalPanics: [secondPanic],
        ordinaryFailure,
        residualRouter: router,
      }),
    };
    const cleanup = createCoreRuntimeCleanupSupervisor(null);
    const fatalReports: Error[] = [];
    const cleanupBoundary = {
      record: cleanup.record,
      reportFatalError: (error: Error) => fatalReports.push(error),
    };

    const retained = await stopCoreResidualDiscordRequestRouter({
      router,
      cleanup: cleanupBoundary,
    });

    expect(retained).toBe(router);
    expect(fatalReports).toEqual([]);
    expect(cleanup.panics).toEqual([firstPanic, secondPanic]);
    expect(cleanup.failures).toEqual([
      {
        label: "residualRouter.stop.panic",
        error: firstPanic.message,
        panic: true,
      },
      {
        label: "residualRouter.stop.panic",
        error: secondPanic.message,
        panic: true,
      },
      {
        label: "residualRouter.stop",
        error: ordinaryFailure.message,
        panic: false,
      },
    ]);
    expect(() => cleanup.finish()).toThrow(firstPanic);
  });

  it("attaches done supervision immediately to a residual replacement", async () => {
    const replacementDone = Promise.withResolvers<ResultType<void, EventDeliveryDoneError>>();
    const donePanic = new Panic({
      message: "replacement done invariant failed",
    });
    const stopFailure = new ResidualDiscordRequestRouterStopFailed({
      failures: [
        new EventDeliveryStopFailed({
          topic: "evt.request",
          cause: new Error("replacement remained live"),
          message: "forced replacement cleanup failure",
        }),
      ],
      message: "Residual router cleanup retained a replacement",
    });
    const replacement: ResidualDiscordRequestRouter = {
      done: replacementDone.promise,
      stop: async () => ({
        kind: "result",
        result: Result.err(stopFailure),
        residualRouter: replacement,
      }),
    };
    const initial: ResidualDiscordRequestRouter = {
      done: Promise.resolve(Result.ok(undefined)),
      stop: async () => ({
        kind: "result",
        result: Result.err(stopFailure),
        residualRouter: replacement,
      }),
    };
    const cleanup = createCoreRuntimeCleanupSupervisor(null);
    const supervisions: Array<Promise<CoreResidualDiscordRequestRouterDoneOutcome>> = [];
    const ownership: { router: ResidualDiscordRequestRouter | null } = {
      router: null,
    };

    retainCoreResidualDiscordRequestRouter({
      router: initial,
      retainRouter: (router) => {
        ownership.router = router;
      },
      retainDoneSupervision: (supervision) => supervisions.push(supervision),
    });

    const retainedInitial = ownership.router;
    if (!retainedInitial) throw new Error("expected initial residual ownership");
    const returnedReplacement = await stopCoreResidualDiscordRequestRouter({
      router: retainedInitial,
      cleanup,
    });
    if (!returnedReplacement) throw new Error("expected a residual replacement");
    retainCoreResidualDiscordRequestRouter({
      router: returnedReplacement,
      retainRouter: (router) => {
        ownership.router = router;
      },
      retainDoneSupervision: (supervision) => supervisions.push(supervision),
    });
    replacementDone.reject(donePanic);

    expect(ownership.router).toBe(replacement);
    expect(supervisions).toHaveLength(2);
    const supervision = supervisions[1];
    if (!supervision) throw new Error("expected replacement done supervision");
    await settleCoreResidualDiscordRequestRouterDone({
      supervision,
      cleanup,
      reportLatePanic: () => {},
      deadlineMs: 3_000,
    });
    expect(cleanup.panics).toEqual([donePanic]);
  });

  it("reports a residual done Panic that settles after the cleanup deadline", async () => {
    const done = Promise.withResolvers<CoreResidualDiscordRequestRouterDoneOutcome>();
    const reported = Promise.withResolvers<Panic>();
    const panic = new Panic({ message: "late residual done invariant failed" });
    const recorded: Array<{ readonly label: string; readonly cause: unknown }> = [];
    let expireDeadline: () => void = () => {
      throw new Error("deadline was not scheduled");
    };
    let cancelled = false;

    const settling = settleCoreResidualDiscordRequestRouterDone({
      supervision: done.promise,
      cleanup: {
        record: (label, cause) => recorded.push({ label, cause }),
      },
      reportLatePanic: (latePanic) => {
        reported.resolve(latePanic);
      },
      deadlineMs: 3_000,
      scheduleDeadline: (callback, delayMs) => {
        expect(delayMs).toBe(3_000);
        expireDeadline = callback;
        return () => {
          cancelled = true;
        };
      },
    });
    expireDeadline();
    await settling;

    expect(cancelled).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.label).toBe("residualRouter.done");
    expect(recorded[0]?.cause).toBeInstanceOf(CoreResidualDiscordRequestRouterDoneTimedOut);
    expect(recorded[0]?.cause).toMatchObject({ deadlineMs: 3_000 });

    done.resolve({ kind: "panic", panic });
    expect(await reported.promise).toBe(panic);
    expect(recorded).toHaveLength(1);
  });

  it("runs full cleanup once across residual-router stop re-entry and eventual release", async () => {
    const fullCleanupOperations = [
      "agentRunner.stop",
      "mcpOAuthCallback.stop",
      "mcpRegistry.shutdown",
      "blobStore.close",
      "durableWorkflowStore.close",
      "transcriptStore.close",
      "bus.close",
    ] as const;
    const fullCleanupCounts = new Map(fullCleanupOperations.map((operation) => [operation, 0]));
    const failures = [
      new ResidualDiscordRequestRouterStopFailed({
        failures: [
          new EventDeliveryStopFailed({
            topic: "evt.request",
            cause: new Error("initial residual stop failed"),
            message: "initial residual stop failed",
          }),
        ],
        message: "Initial residual router cleanup failed",
      }),
      new ResidualDiscordRequestRouterStopFailed({
        failures: [
          new EventDeliveryStopFailed({
            topic: "evt.request",
            cause: new Error("residual retry failed"),
            message: "residual retry failed",
          }),
        ],
        message: "Residual router cleanup retry failed",
      }),
    ] as const;
    const stopPasses: string[] = [];
    const cleanupFailures: Array<readonly CoreRuntimeCleanupFailure[]> = [];
    let fullCleanupPending = true;
    let residualStopAttempts = 0;
    let residualDoneSettlements = 0;
    let residualRouter: ResidualDiscordRequestRouter | null = null;
    const residualDoneSupervisions: Array<Promise<CoreResidualDiscordRequestRouterDoneOutcome>> =
      [];

    const retainResidualRouter = (router: ResidualDiscordRequestRouter): void => {
      retainCoreResidualDiscordRequestRouter({
        router,
        retainRouter: (retained) => {
          residualRouter = retained;
        },
        retainDoneSupervision: (supervision) => {
          residualDoneSupervisions.push(
            supervision.then((outcome) => {
              residualDoneSettlements += 1;
              return outcome;
            }),
          );
        },
      });
    };
    const createResidualRouter = (): ResidualDiscordRequestRouter => ({
      done: Promise.resolve(Result.ok(undefined)),
      stop: async () => {
        const failure = failures[residualStopAttempts];
        residualStopAttempts += 1;
        if (!failure) {
          return {
            kind: "result",
            result: Result.ok(undefined),
            residualRouter: null,
          };
        }
        const replacement = createResidualRouter();
        return {
          kind: "result",
          result: Result.err(failure),
          residualRouter: replacement,
        };
      },
    });
    retainResidualRouter(createResidualRouter());

    const stopRuntime = async (): Promise<void> => {
      const stopPass = selectCoreRuntimeStopPass({
        fullCleanupPending,
        hasResidualRouter: residualRouter !== null,
      });
      if (stopPass === "none") return;
      stopPasses.push(stopPass);
      const cleanup = createCoreRuntimeCleanupSupervisor(null);

      if (stopPass === "full") {
        for (const operation of fullCleanupOperations) {
          await cleanup.run(operation, async () => {
            fullCleanupCounts.set(operation, (fullCleanupCounts.get(operation) ?? 0) + 1);
          });
        }
      }

      if (residualRouter) {
        const replacement = await stopCoreResidualDiscordRequestRouter({
          router: residualRouter,
          cleanup,
        });
        residualRouter = null;
        if (replacement) retainResidualRouter(replacement);
      }

      if (stopPass === "full") fullCleanupPending = false;
      for (const supervision of residualDoneSupervisions) {
        await settleCoreResidualDiscordRequestRouterDone({
          supervision,
          cleanup,
          reportLatePanic: () => {},
          deadlineMs: 3_000,
        });
      }
      residualDoneSupervisions.length = 0;
      cleanupFailures.push(cleanup.failures);
      cleanup.finish();
    };

    await stopRuntime();
    await stopRuntime();
    await stopRuntime();
    await stopRuntime();

    expect(stopPasses).toEqual(["full", "residual-router", "residual-router"]);
    expect(Object.fromEntries(fullCleanupCounts)).toEqual({
      "agentRunner.stop": 1,
      "mcpOAuthCallback.stop": 1,
      "mcpRegistry.shutdown": 1,
      "blobStore.close": 1,
      "durableWorkflowStore.close": 1,
      "transcriptStore.close": 1,
      "bus.close": 1,
    });
    expect(residualStopAttempts).toBe(3);
    expect(residualDoneSettlements).toBe(3);
    expect(residualRouter).toBeNull();
    expect(cleanupFailures).toEqual([
      [
        {
          label: "residualRouter.stop",
          error: failures[0].message,
          panic: false,
        },
      ],
      [
        {
          label: "residualRouter.stop",
          error: failures[1].message,
          panic: false,
        },
      ],
      [],
    ]);
  });
});

describe("Core runtime event delivery", () => {
  it("captures ordinary owned Redis cleanup failure", async () => {
    const redis = new Redis({ lazyConnect: true });
    const cleanupError = new Error("redis close failed");
    Reflect.set(redis, "quit", async () => {
      throw cleanupError;
    });

    try {
      const captured = await captureCoreEventBusCleanup({
        redis,
        raw: null,
        bus: null,
      });
      expect(captured.status).toBe("error");
      if (captured.status === "error") expect(captured.error.cause).toBe(cleanupError);
    } finally {
      redis.disconnect();
    }
  });

  it("wires the owned Redis client, redacted logger, and fatal reporter", () => {
    const redis = new Redis({ lazyConnect: true });
    const reported: Error[] = [];
    const logs: unknown[] = [];
    const postCommitObserver = {
      observe: async () => Result.ok(undefined),
    };

    try {
      const options = createCoreEventBusDeliveryOptions({
        redis,
        deadLetterEncryptionKey: Buffer.alloc(32, 0x42),
        evidenceBlobStore: unusedEvidenceBlobStore,
        logger: {
          warn: (...args) => logs.push(args),
          error: (...args) => logs.push(args),
        },
        reportFatalError: (error) => reported.push(error),
        postCommitObserver,
      });

      expect(options.deadLetter).toBeInstanceOf(RedisEventDeadLetter);
      expect(Reflect.get(options.deadLetter!, "redis")).toBe(redis);
      expect(Reflect.get(options.deadLetter!, "evidenceBlobStore")).toBe(unusedEvidenceBlobStore);
      expect(options.logger).toBeDefined();
      expect(options.reportFatal).toBeDefined();
      expect(options.postCommitObserver).toBe(postCommitObserver);

      const panic = new Panic({ message: "delivery invariant failed" });
      options.reportFatal!.report(panic, {
        topic: "cmd.request",
        cursor: "1-0",
        phase: "handler",
      });
      expect(reported).toEqual([panic]);
    } finally {
      redis.disconnect();
    }
  });

  it("forwards only payload-redacted event delivery metadata", () => {
    const secret = "event-payload-secret";
    const logs: Array<{ event: unknown; context: unknown }> = [];
    const logger = createCoreEventBusLogger({
      warn: (event, context) => logs.push({ event, context }),
      error: (event, context) => logs.push({ event, context }),
    });

    logger.warn("event_bus.contract_invalid", {
      topic: "cmd.request",
      cursor: "1-0",
      source: "contract",
      stage: "payload",
      eventType: "cmd.request.message",
      payload: secret,
      evidence: secret,
    });

    expect(logs).toEqual([
      {
        event: "event_bus.contract_invalid",
        context: {
          topic: "cmd.request",
          cursor: "1-0",
          source: "contract",
          stage: "payload",
          eventType: "cmd.request.message",
        },
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain(secret);
  });

  it("propagates fatal identities to process supervision exactly once", () => {
    const reported: Error[] = [];
    const reporter = createCoreEventBusFatalReporter((error) => reported.push(error));
    const panic = new Panic({ message: "delivery panic" });
    const defect = new Error("delivery defect");
    const nonErrorDefect = { broken: true };
    const context = {
      topic: "cmd.request",
      cursor: "2-0",
      phase: "delivery-action" as const,
    };

    reporter.report(panic, context);
    reporter.report(panic, context);
    reporter.report(defect, context);
    reporter.report(defect, context);
    reporter.report(nonErrorDefect, context);
    reporter.report(nonErrorDefect, context);

    expect(reported).toHaveLength(3);
    expect(reported[0]).toBe(panic);
    expect(reported[1]).toBe(defect);
    expect(Panic.is(reported[2])).toBe(true);
  });

  it("supervises router transport termination without a direct done await", async () => {
    const routerDone = Promise.withResolvers<ResultType<void, EventDeliveryDoneError>>();
    const fatalObserved = Promise.withResolvers<void>();
    const reported: Error[] = [];
    let healthy = true;
    const reportFatalError = createCoreRuntimeFatalReporter((error) => {
      reported.push(error);
      fatalObserved.resolve();
    });
    const transportFailure = new EventDeliveryTransportFailed({
      topic: "evt.request",
      operation: "ack",
      cursor: "7-0",
      cause: new Error("Redis connection closed"),
      message: "Redis delivery acknowledgement failed",
    });

    const supervision = superviseCoreRouterDone({
      done: routerDone.promise,
      isStopping: () => false,
      markUnhealthy: () => {
        healthy = false;
      },
      reportFatalError,
    });
    routerDone.resolve(Result.err(transportFailure));

    await fatalObserved.promise;
    reportFatalError(transportFailure);
    await supervision;

    expect(reported).toEqual([transportFailure]);
    expect(healthy).toBe(false);
  });

  it("waits for subscription and dead-letter work before closing owned Redis", async () => {
    const calls: string[] = [];
    const deliveryStarted = Promise.withResolvers<void>();
    const releaseDelivery = Promise.withResolvers<void>();
    const routerDone = Promise.withResolvers<ResultType<void, EventDeliveryDoneError>>();
    const reported: Error[] = [];
    let stopping = false;
    const cleanup = createCoreRuntimeCleanupSupervisor(null);
    const routerSupervision = superviseCoreRouterDone({
      done: routerDone.promise,
      isStopping: () => stopping,
      markUnhealthy: () => {
        throw new Error("requested shutdown must not mark the runtime unhealthy");
      },
      reportFatalError: (error) => reported.push(error),
    });

    const shutdown = (async () => {
      stopping = true;
      await cleanup.run("subscription.stop", async () => {
        calls.push("subscription.stop");
        deliveryStarted.resolve();
        await releaseDelivery.promise;
        calls.push("dead-letter.done");
        routerDone.resolve(Result.ok(undefined));
      });
      await cleanup.run("subscription.done", () => routerSupervision);
      await cleanup.run("bus.close", async () => {
        calls.push("redis.close");
      });
      cleanup.finish();
    })();

    await deliveryStarted.promise;
    expect(calls).toEqual(["subscription.stop"]);
    releaseDelivery.resolve();
    await shutdown;

    expect(calls).toEqual(["subscription.stop", "dead-letter.done", "redis.close"]);
    expect(reported).toEqual([]);
  });
});
