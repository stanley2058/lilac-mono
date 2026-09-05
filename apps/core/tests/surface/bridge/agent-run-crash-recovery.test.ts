import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createMemoryBlobStore, type BlobStore } from "@stanley2058/lilac-blob-storage";
import { AiSdkPiAgent, type AiSdkPiAgentOptions } from "@stanley2058/lilac-agent";
import {
  createLilacBus,
  lilacEventTypes,
  type StoredMessageV1,
} from "@stanley2058/lilac-event-bus";
import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils";
import { jsonSchema, tool, type ModelMessage, type ToolSet } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { Result, type Result as ResultType } from "better-result";

import { createInMemoryDeliveryBus } from "../../helpers/in-memory-delivery-bus";
import {
  SqliteAgentRunJournal,
  createAgentRunCheckpoint,
  type AgentRunJournal,
} from "../../../src/surface/bridge/agent-run-journal";
import { startBusAgentRunner } from "../../../src/surface/bridge/bus-agent-runner";
import {
  RequestDeliveryCoordinator,
  SqliteRequestDeliveryStore,
  coreRequestDeliveryCodecs,
  createCoreRequestDeliveryAdmission,
  type AcceptedRequestDelivery,
  type CoreAcceptedRequestWork,
} from "../../../src/surface/bridge/request-delivery";
import type { BuiltLevel1Toolset, CoreToolPluginManager } from "../../../src/plugins";
import { projectStoredMessagesV1 } from "../../../src/transcript/stored-message-materialization";
import {
  joinAgentRunRecoveryHeads,
  removeFullyReconciledAgentRunTerminalHeads,
  selectAgentRunAcceptedRecovery,
} from "../../../src/runtime/create-core-runtime";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function value<T, E extends Error>(result: ResultType<T, E>): T {
  return result.match({
    ok: (resultValue) => resultValue,
    err: (error) => {
      throw error;
    },
  });
}

async function resultValue<T, E extends Error>(result: Promise<ResultType<T, E>>): Promise<T> {
  return value(await result);
}

function zeroUsage() {
  return {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };
}

function textStep(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id: "text" },
        { type: "text-delta" as const, id: "text", delta: text },
        { type: "text-end" as const, id: "text" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: zeroUsage(),
        },
      ],
    }),
  };
}

function toolStep(toolCallId: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: "tool-call" as const,
          toolCallId,
          toolName: "builtin",
          input: "{}",
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage: zeroUsage(),
        },
      ],
    }),
  };
}

function testToolset(onEffect: () => void): BuiltLevel1Toolset {
  const builtin = tool({
    inputSchema: jsonSchema<Record<string, never>>({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute: () => {
      onEffect();
      return "effect-result";
    },
  });
  const findTools = tool({
    inputSchema: jsonSchema<Record<string, never>>({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute: () => "none",
  });
  return {
    tools: { builtin, find_tools: findTools },
    specs: new Map(),
    contributionInfo: new Map(),
    directToolNames: new Set(["builtin", "find_tools"]),
    catalog: [],
    catalogMetadata: {},
    updateActiveBatchTools: () => undefined,
    genericOutputNormalizerBypassTools: new Set(["builtin"]),
    aggregateOutputBudgetExemptTools: new Set(),
    release: async () => Result.ok(undefined),
  };
}

function pluginManager(toolset: BuiltLevel1Toolset): CoreToolPluginManager {
  return {
    init: async () => Result.ok(undefined),
    destroy: async () => Result.ok(undefined),
    reload: async () => Result.ok(undefined),
    ensureFresh: async () => Result.ok(undefined),
    getStatuses: () => [],
    getLevel2Tools: () => [],
    getLevel2ContributionInfo: () => new Map(),
    buildLevel1ToolsetResult: async () => Result.ok(toolset),
  };
}

type AcceptedInput = {
  readonly label: string;
  readonly requestId?: string;
  readonly sessionId?: string;
  readonly queue?: CoreAcceptedRequestWork["data"]["queue"];
  readonly messages?: readonly StoredMessageV1[];
  readonly raw?: unknown;
};

function acceptWork(
  store: SqliteRequestDeliveryStore<unknown, CoreAcceptedRequestWork, unknown>,
  input: AcceptedInput,
  acceptedAt: number,
): AcceptedRequestDelivery<CoreAcceptedRequestWork> {
  const requestDeliveryId = crypto.randomUUID();
  const requestId = input.requestId ?? `github:crash:${input.label}`;
  const sessionId = input.sessionId ?? `session-${input.label}`;
  const headers = {
    request_id: requestId,
    session_id: sessionId,
    request_client: "github" as const,
  };
  const data: CoreAcceptedRequestWork["data"] = {
    requestDeliveryId,
    queue: input.queue ?? "prompt",
    messages: [...(input.messages ?? [{ role: "user", content: input.label }])],
    ...(input.raw === undefined ? {} : { raw: input.raw }),
  };
  const work: CoreAcceptedRequestWork = {
    requestDeliveryId,
    requestId,
    sessionId,
    requestClient: "github",
    headers,
    data,
  };
  value(
    store.prepare({
      requestDeliveryId,
      requestId,
      envelope: { headers, data },
      inputHandles: [],
      createdAt: acceptedAt,
    }),
  );
  return value(
    store.accept({
      requestDeliveryId,
      work,
      inputReferences: [],
      acceptedAt,
    }),
  ).record;
}

function checkpoint(
  journal: SqliteAgentRunJournal,
  accepted: AcceptedRequestDelivery<CoreAcceptedRequestWork>,
  messages: readonly StoredMessageV1[],
  retainedRequestDeliveries: Parameters<
    typeof createAgentRunCheckpoint
  >[0]["retainedRequestDeliveries"] = [],
) {
  const opened = value(journal.openRun(accepted.work));
  return value(
    journal.writeCheckpoint(
      opened,
      createAgentRunCheckpoint({ messages, retainedRequestDeliveries }),
    ),
  );
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "lilac-agent-run-crash-"));
  directories.push(directory);
  const dbPath = join(directory, "request-delivery.db");
  const blobStore = await resultValue(createMemoryBlobStore());
  const store = new SqliteRequestDeliveryStore({
    dbPath,
    codecs: coreRequestDeliveryCodecs,
  });
  const journal = new SqliteAgentRunJournal({ dbPath });
  return { directory, dbPath, blobStore, store, journal };
}

type RecoveredRun = {
  readonly prompts: Map<string, ModelMessage[][]>;
  readonly order: string[];
  readonly runner: Awaited<ReturnType<typeof startBusAgentRunner>>;
  readonly store: SqliteRequestDeliveryStore<unknown, CoreAcceptedRequestWork, unknown>;
  readonly journal: SqliteAgentRunJournal;
  readonly bus: ReturnType<typeof createLilacBus>;
  readonly manager: CoreToolPluginManager;
};

async function waitForTerminal(
  store: SqliteRequestDeliveryStore<unknown, CoreAcceptedRequestWork, unknown>,
  requestDeliveryIds: readonly string[],
): Promise<void> {
  for (let turn = 0; turn < 20_000; turn += 1) {
    if (
      requestDeliveryIds.every(
        (requestDeliveryId) => value(store.load(requestDeliveryId)).state === "terminal",
      )
    ) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(
    `Recovered requests did not become terminal: ${JSON.stringify(
      requestDeliveryIds.map((requestDeliveryId) => ({
        requestDeliveryId,
        state: value(store.load(requestDeliveryId)).state,
      })),
    )}`,
  );
}

async function reconstruct(input: {
  readonly dbPath: string;
  readonly blobStore: BlobStore;
  readonly onEffect?: () => void;
}): Promise<RecoveredRun> {
  const store = new SqliteRequestDeliveryStore({
    dbPath: input.dbPath,
    codecs: coreRequestDeliveryCodecs,
  });
  const journal = new SqliteAgentRunJournal({ dbPath: input.dbPath });
  const recovery = value(journal.loadRecoveryHeads());
  const recoveryJoin = joinAgentRunRecoveryHeads({
    heads: recovery.heads,
    requestDeliveryStore: store,
    journal,
    logger: { warn: () => undefined },
  });
  const order: string[] = [];
  const raw = createInMemoryDeliveryBus();
  const publish = raw.publish.bind(raw);
  raw.publish = async (message, options) => {
    if (options.type === lilacEventTypes.EvtAgentOutputResponseText) {
      order.push(`surface:${options.headers?.request_id ?? "unknown"}`);
    }
    return publish(message, options);
  };
  const bus = createLilacBus(raw);
  const delivery = new RequestDeliveryCoordinator({
    store,
    blobStore: input.blobStore,
    admission: createCoreRequestDeliveryAdmission(input.blobStore),
  });
  const manager = pluginManager(testToolset(input.onEffect ?? (() => undefined)));
  const prompts = new Map<string, ModelMessage[][]>();
  const journalPort: Pick<
    AgentRunJournal,
    "openRun" | "writeCheckpoint" | "markTerminal" | "resetRun" | "removeReconciled"
  > = {
    openRun: journal.openRun.bind(journal),
    writeCheckpoint: journal.writeCheckpoint.bind(journal),
    resetRun: journal.resetRun.bind(journal),
    removeReconciled: journal.removeReconciled.bind(journal),
    markTerminal: (handle, terminal) => {
      order.push(`terminal:${handle.requestId}`);
      return journal.markTerminal(handle, terminal);
    },
  };
  const runner = await startBusAgentRunner({
    bus,
    blobStore: input.blobStore,
    requestDelivery: delivery,
    agentRunJournal: journalPort,
    subscriptionId: `crash-recovery-${crypto.randomUUID()}`,
    config: parseCoreConfigV2ToUniversal({}),
    pluginManager: manager,
    startPaused: true,
    issueControlCapability: () => ({
      capability: "crash-recovery",
      principal: null,
    }),
    reportFatalPanic: (panic) => {
      throw panic;
    },
    createAgent: (options: AiSdkPiAgentOptions<ToolSet>) => {
      let call = 0;
      return new AiSdkPiAgent({
        ...options,
        model: new MockLanguageModelV4({
          modelId: "crash-recovery",
          doStream: async (modelCall) => {
            const promptKey = JSON.stringify(modelCall.prompt);
            const observed = prompts.get(promptKey) ?? [];
            observed.push(structuredClone(modelCall.prompt));
            prompts.set(promptKey, observed);
            if (promptKey.includes("repeat tool effect") && call === 0) {
              call += 1;
              return toolStep(`repeat-${crypto.randomUUID()}`);
            }
            call += 1;
            return textStep("recovered");
          },
        }),
      });
    },
  });
  const recovered = value(
    await delivery.recoverAccepted(
      (record) => {
        const decision = selectAgentRunAcceptedRecovery(recoveryJoin, record.requestDeliveryId);
        return decision.kind === "retained-active"
          ? Promise.resolve(Result.ok(undefined))
          : runner.resumeAcceptedDelivery(
              record,
              decision.kind === "resume" ? decision.head : undefined,
            );
      },
      {
        terminalRecovery: (record) => {
          const decision = selectAgentRunAcceptedRecovery(recoveryJoin, record.requestDeliveryId);
          if (decision.kind !== "terminal") return undefined;
          return {
            outcome: decision.outcome,
            ...(decision.finalReplayDeadline === undefined
              ? {}
              : { finalReplayDeadline: decision.finalReplayDeadline }),
          };
        },
        prepareTerminalRecovery: (record) =>
          Promise.resolve(runner.discardPausedRecoveredDelivery(record.requestDeliveryId)),
      },
    ),
  );
  expect(recovered.failures).toEqual([]);
  removeFullyReconciledAgentRunTerminalHeads({
    heads: recoveryJoin.heads,
    requestDeliveryStore: store,
    journal,
  });
  runner.activate();
  return { prompts, order, runner, store, journal, bus, manager };
}

async function closeRecovered(run: RecoveredRun): Promise<void> {
  await run.runner.stop();
  await run.manager.destroy();
  run.journal.close();
  run.store.close();
  await run.bus.close();
}

function messagesFor(run: RecoveredRun, marker: string): string {
  const match = [...run.prompts.entries()].find(([requestId]) => requestId.includes(marker));
  return JSON.stringify(match?.[1] ?? []);
}

describe("agent run hard-crash recovery", () => {
  it("reconstructs original, semantic, tool, subagent, and terminal boundaries", async () => {
    const first = await fixture();
    const records: AcceptedRequestDelivery<CoreAcceptedRequestWork>[] = [];
    const original = acceptWork(first.store, { label: "accepted-original" }, 1);
    records.push(original);
    const initial = acceptWork(first.store, { label: "initial-checkpoint" }, 2);
    records.push(initial);
    checkpoint(first.journal, initial, [{ role: "user", content: "initial checkpoint" }]);

    const streaming = acceptWork(
      first.store,
      {
        label: "unsafe-stream-partial",
        messages: [{ role: "user", content: "unsafe partial" }],
      },
      3,
    );
    records.push(streaming);
    checkpoint(first.journal, streaming, [
      { role: "user", content: "stream request" },
      { role: "assistant", content: "safe completed prefix" },
    ]);

    const beforeToolResult = acceptWork(first.store, { label: "repeat-tool-effect" }, 4);
    records.push(beforeToolResult);
    checkpoint(first.journal, beforeToolResult, [{ role: "user", content: "repeat tool effect" }]);

    const completedToolMessages = value(
      projectStoredMessagesV1([
        { role: "user", content: "completed tool checkpoint" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "completed-tool",
              toolName: "builtin",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "completed-tool",
              toolName: "builtin",
              output: { type: "text", value: "durable effect result" },
            },
          ],
        },
      ]),
    );
    const afterToolResult = acceptWork(first.store, { label: "completed-tool-result" }, 5);
    records.push(afterToolResult);
    checkpoint(first.journal, afterToolResult, completedToolMessages);

    for (const [index, profile] of ["explore", "general"].entries()) {
      const subagent = acceptWork(
        first.store,
        {
          label: `subagent-${index}`,
          raw: { subagent: { profile, depth: 1 } },
        },
        6 + index,
      );
      records.push(subagent);
      checkpoint(first.journal, subagent, [{ role: "user", content: `subagent durable ${index}` }]);
    }

    const repeatedTail = acceptWork(first.store, { label: "repeat-terminal-tail" }, 8);
    records.push(repeatedTail);
    checkpoint(first.journal, repeatedTail, [
      {
        role: "user",
        content: "repeat terminal tail after prior surface initiation",
      },
    ]);

    const terminal = acceptWork(first.store, { label: "terminal-marker" }, 9);
    records.push(terminal);
    const terminalHandle = checkpoint(first.journal, terminal, [
      { role: "user", content: "must not rerun" },
    ]);
    value(
      first.journal.markTerminal(terminalHandle, {
        outcome: { kind: "completed" },
      }),
    );

    first.journal.close();
    first.store.close();

    let effects = 0;
    const run = await reconstruct({
      dbPath: first.dbPath,
      blobStore: first.blobStore,
      onEffect: () => {
        effects += 1;
      },
    });
    await waitForTerminal(
      run.store,
      records.map((record) => record.requestDeliveryId),
    );

    expect(messagesFor(run, "accepted-original")).toContain("accepted-original");
    expect(messagesFor(run, "initial checkpoint")).toContain("initial checkpoint");
    expect(messagesFor(run, "safe completed prefix")).toContain("safe completed prefix");
    expect(messagesFor(run, "safe completed prefix")).not.toContain("unsafe partial");
    expect(messagesFor(run, "completed tool checkpoint")).toContain("durable effect result");
    expect(effects).toBe(1);
    expect(messagesFor(run, "subagent durable 0")).toContain("subagent durable 0");
    expect(messagesFor(run, "subagent durable 1")).toContain("subagent durable 1");
    expect(messagesFor(run, "terminal-marker")).toBe("[]");
    expect(messagesFor(run, "repeat terminal tail")).toContain("repeat terminal tail");
    for (const record of records.filter((candidate) => candidate !== terminal)) {
      const surface = run.order.indexOf(`surface:${record.requestId}`);
      const terminalMark = run.order.indexOf(`terminal:${record.requestId}`);
      expect(surface).toBeGreaterThanOrEqual(0);
      expect(terminalMark).toBeGreaterThan(surface);
    }

    await closeRecovered(run);
    await resultValue(first.blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("reapplies an accepted control and reconciles one already retained by a checkpoint", async () => {
    const first = await fixture();
    const prePrompt = acceptWork(
      first.store,
      { label: "control-before-checkpoint", sessionId: "control-before" },
      1,
    );
    checkpoint(first.journal, prePrompt, [{ role: "user", content: "pre-control prompt" }]);
    const preControl = acceptWork(
      first.store,
      {
        label: "control-reapply",
        requestId: prePrompt.requestId,
        sessionId: "control-before",
        queue: "steer",
        messages: [{ role: "user", content: "steering reapplied after crash" }],
        raw: { requiresActive: true },
      },
      2,
    );

    const postPrompt = acceptWork(
      first.store,
      { label: "control-after-checkpoint", sessionId: "control-after" },
      3,
    );
    const postControl = acceptWork(
      first.store,
      {
        label: "control-retained",
        requestId: postPrompt.requestId,
        sessionId: "control-after",
        queue: "steer",
        messages: [{ role: "user", content: "steering already durable" }],
        raw: { requiresActive: true },
      },
      4,
    );
    checkpoint(
      first.journal,
      postPrompt,
      [
        { role: "user", content: "post-control prompt" },
        { role: "user", content: "steering already durable" },
      ],
      [
        {
          requestDeliveryId: postControl.requestDeliveryId,
          outcome: { kind: "completed" },
        },
      ],
    );
    first.journal.close();
    first.store.close();

    const run = await reconstruct({
      dbPath: first.dbPath,
      blobStore: first.blobStore,
    });
    await waitForTerminal(run.store, [
      prePrompt.requestDeliveryId,
      preControl.requestDeliveryId,
      postPrompt.requestDeliveryId,
      postControl.requestDeliveryId,
    ]);
    expect(messagesFor(run, "post-control prompt")).toContain("steering already durable");
    expect(value(run.store.load(postControl.requestDeliveryId)).state).toBe("terminal");
    expect(messagesFor(run, "pre-control prompt")).toContain("steering reapplied after crash");
    expect(value(run.store.load(preControl.requestDeliveryId)).state).toBe("terminal");

    await closeRecovered(run);
    await resultValue(first.blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("converges terminal owners after crashes before and during retained control terminalization", async () => {
    const first = await fixture();
    const requestDeliveryIds: string[] = [];
    const ownerLabels: string[] = [];

    for (const [index, terminalizedControlCount] of [0, 1].entries()) {
      const ownerLabel = `partial-terminal-owner-${index}`;
      const owner = acceptWork(first.store, { label: ownerLabel }, 1 + index * 3);
      ownerLabels.push(ownerLabel);
      const controls = [0, 1].map((controlIndex) =>
        acceptWork(
          first.store,
          {
            label: `partial-terminal-control-${index}-${controlIndex}`,
            requestId: owner.requestId,
            sessionId: owner.work.sessionId,
            queue: "steer",
            raw: { requiresActive: true },
          },
          2 + index * 3 + controlIndex,
        ),
      );
      const retainedRequestDeliveries = controls.map((control) => ({
        requestDeliveryId: control.requestDeliveryId,
        outcome: {
          kind: "completed" as const,
          code: "retained-control-applied",
        },
      }));
      const handle = checkpoint(
        first.journal,
        owner,
        [{ role: "user", content: `terminal checkpoint ${index}` }],
        retainedRequestDeliveries,
      );
      value(
        first.journal.markTerminal(handle, {
          outcome: { kind: "completed", code: "owner-completed" },
          finalReplayDeadline: 99,
        }),
      );
      value(
        first.store.terminalize({
          requestDeliveryId: owner.requestDeliveryId,
          outcome: { kind: "completed", code: "owner-completed" },
          terminalAt: 20,
          transportCommitRequired: false,
          finalReplayDeadline: 99,
        }),
      );
      for (const control of controls.slice(0, terminalizedControlCount)) {
        value(
          first.store.terminalize({
            requestDeliveryId: control.requestDeliveryId,
            outcome: { kind: "completed", code: "retained-control-applied" },
            terminalAt: 21,
            transportCommitRequired: false,
          }),
        );
      }
      requestDeliveryIds.push(
        owner.requestDeliveryId,
        ...controls.map((control) => control.requestDeliveryId),
      );
    }

    first.journal.close();
    first.store.close();

    const run = await reconstruct({
      dbPath: first.dbPath,
      blobStore: first.blobStore,
    });
    await waitForTerminal(run.store, requestDeliveryIds);
    for (const label of ownerLabels) expect(messagesFor(run, label)).toBe("[]");
    expect(value(run.journal.loadRecoveryHeads()).heads).toEqual([]);

    await closeRecovered(run);
    await resultValue(first.blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("resets one corrupt head and resumes its accepted original work", async () => {
    const first = await fixture();
    const corrupt = acceptWork(first.store, { label: "corrupt-original" }, 1);
    const valid = acceptWork(first.store, { label: "valid-checkpoint" }, 2);
    checkpoint(first.journal, corrupt, [{ role: "user", content: "corrupt checkpoint" }]);
    checkpoint(first.journal, valid, [{ role: "user", content: "valid durable checkpoint" }]);
    first.journal.close();
    first.store.close();
    const database = new Database(first.dbPath, { strict: true });
    database.run(
      "UPDATE agent_run_wal_heads SET checkpoint_json = '{' WHERE request_delivery_id = ?",
      [corrupt.requestDeliveryId],
    );
    database.close();

    const run = await reconstruct({
      dbPath: first.dbPath,
      blobStore: first.blobStore,
    });
    await waitForTerminal(run.store, [corrupt.requestDeliveryId, valid.requestDeliveryId]);
    expect(messagesFor(run, "corrupt-original")).toContain("corrupt-original");
    expect(messagesFor(run, "corrupt-original")).not.toContain("corrupt checkpoint");
    expect(messagesFor(run, "valid durable checkpoint")).toContain("valid durable checkpoint");

    await closeRecovered(run);
    await resultValue(first.blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("resets a future journal contract and resumes every accepted original", async () => {
    const first = await fixture();
    const records = [
      acceptWork(first.store, { label: "future-original-a" }, 1),
      acceptWork(first.store, { label: "future-original-b" }, 2),
    ];
    for (const record of records) {
      checkpoint(first.journal, record, [
        { role: "user", content: `discarded ${record.requestId}` },
      ]);
    }
    first.journal.close();
    first.store.close();
    const database = new Database(first.dbPath, { strict: true });
    database.run("UPDATE agent_run_wal_metadata SET schema_version = 99 WHERE singleton = 1");
    database.close();

    const run = await reconstruct({
      dbPath: first.dbPath,
      blobStore: first.blobStore,
    });
    await waitForTerminal(
      run.store,
      records.map((record) => record.requestDeliveryId),
    );
    expect(messagesFor(run, "future-original-a")).toContain("future-original-a");
    expect(messagesFor(run, "future-original-b")).toContain("future-original-b");
    expect(messagesFor(run, "future-original-a")).not.toContain(
      "discarded github:crash:future-original-a",
    );
    expect(messagesFor(run, "future-original-b")).not.toContain(
      "discarded github:crash:future-original-b",
    );

    await closeRecovered(run);
    await resultValue(first.blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });
});
