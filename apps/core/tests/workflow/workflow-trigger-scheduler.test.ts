import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createLilacBus,
  type FetchOptions,
  type HandleContext,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";

import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import {
  canonicalJsonSha256,
  WORKFLOW_RUNTIME_VERSION,
} from "../../src/workflow/workflow-definition";
import {
  normalizeWorkflowResourcePolicy,
  type WorkflowTrigger,
} from "../../src/workflow/workflow-domain";
import { WorkflowTriggerScheduler } from "../../src/workflow/workflow-trigger-scheduler";

class CapturingRawBus implements RawBus {
  readonly messages: Array<Omit<Message<unknown>, "id" | "ts">> = [];
  async publish<TData>(message: Omit<Message<TData>, "id" | "ts">, _options: PublishOptions) {
    this.messages.push(message);
    return { id: `${this.messages.length}-0`, cursor: `${this.messages.length}-0` };
  }
  async subscribe<TData>(
    _topic: string,
    _options: SubscriptionOptions,
    _handler: (message: Message<TData>, context: HandleContext) => Promise<void>,
  ) {
    return { stop: async () => {} };
  }
  async fetch<TData>(_topic: string, _options: FetchOptions) {
    return { messages: [] as Array<{ msg: Message<TData>; cursor: string }> };
  }
  async close() {}
}

function createRevision(store: DurableWorkflowStore): void {
  const resources = normalizeWorkflowResourcePolicy({
    agents: { maxConcurrent: 1, maxTotal: 1 },
    maxNestingDepth: 2,
    maxWallTimeMs: 60_000,
    operationIdleTimeoutMs: 10_000,
    waits: [],
    safety: { originatingMode: "trusted", escalation: "none" },
  });
  const limits = {
    maxSourceBytes: 10_000,
    maxInputBytes: 10_000,
    maxOperationOutputBytes: 10_000,
    maxResultBytes: 10_000,
    maxRuntimeMemoryBytes: 256 * 1024 * 1024,
  };
  store.createRevision({
    revisionId: "revision-1",
    canonicalProjectId: "project-1",
    canonicalWorkspaceRoot: "/workspace",
    scope: "project",
    normalizedPath: "scheduled.js",
    name: "scheduled",
    snapshotArtifactId: `workflow-source:${"a".repeat(64)}`,
    sourceSha256: "a".repeat(64),
    inputSchemaSha256: "b".repeat(64),
    resourcePolicySha256: canonicalJsonSha256({ resources, limits }),
    metadata: { name: "scheduled", description: "Scheduled workflow" },
    inputSchema: { type: "object", additionalProperties: false },
    resources,
    limits,
    runtimeVersion: WORKFLOW_RUNTIME_VERSION,
    createdAt: 1,
  });
}

function trigger(): WorkflowTrigger {
  return {
    triggerId: "trigger-1",
    revisionId: "revision-1",
    state: "active",
    definition: { kind: "timestamp", at: 100 },
    args: {},
    argsSha256: canonicalJsonSha256({}),
    schedulingPolicy: { skipMissed: true, overlap: "coalesce" },
    origin: {
      requestId: "request-owner",
      sessionId: "channel-1",
      client: "discord",
      userId: "owner-1",
      safetyMode: "trusted",
      projectCwd: "/workspace",
    },
    completionTarget: { kind: "detached" },
    progressTarget: null,
    nextFireAt: 100,
    lastFireAt: null,
    lastRunId: null,
    claimedBy: null,
    claimedAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("workflow trigger scheduler", () => {
  it("fires the immutable trusted owner snapshot directly into the queue", async () => {
    const file = join(tmpdir(), `workflow-scheduler-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(file);
    const raw = new CapturingRawBus();
    const bus = createLilacBus(raw);
    try {
      createRevision(store);
      store.createTrigger(trigger());
      const scheduler = new WorkflowTriggerScheduler({ bus, store, now: () => 100 });
      await scheduler.tick();
      const storedTrigger = store.getTrigger("trigger-1");
      const fired = storedTrigger?.lastRunId ? store.getRun(storedTrigger.lastRunId) : null;
      expect(fired).toMatchObject({
        state: "queued",
        revisionId: "revision-1",
        origin: { client: "discord", userId: "owner-1", safetyMode: "trusted" },
      });
      expect(raw.messages.some((message) => message.type === "evt.workflow.run.changed")).toBe(
        true,
      );
    } finally {
      await bus.close();
      store.close();
      rmSync(file, { force: true });
    }
  });
});
