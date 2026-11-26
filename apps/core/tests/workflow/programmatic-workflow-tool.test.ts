import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { Panic, Result } from "better-result";
import {
  createLilacBus,
  lilacEventTypes,
  type FetchOptions,
  type Message,
  type PublishOptions,
  type RawBus,
  type RawDeliveryHandler,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";

import type { RequestContext } from "../../src/tool-server/types";
import { ProgrammaticWorkflow } from "../../src/tool-server/tools/programmatic-workflow";
import { writeWorkflowValueArtifact } from "../../src/workflow/workflow-artifact-store";
import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import { workflowStoreValue } from "./workflow-store-test-helpers";
import { createWorkflowTestBlobStore } from "./workflow-test-blob-store";

const blobStore = await createWorkflowTestBlobStore();

async function callValue(
  tool: ProgrammaticWorkflow,
  callableId: string,
  input: Record<string, unknown>,
  opts?: { context?: RequestContext },
): Promise<unknown> {
  return (await tool.call(callableId, input, opts)).unwrap();
}

const invocationSchema = z.object({
  runId: z.string(),
  state: z.literal("queued"),
  revisionId: z.string(),
  sourceSha256: z.string(),
  inputSchemaSha256: z.string(),
  resourcePolicySha256: z.string(),
  argsSha256: z.string(),
});

const createdProjectionFailureSchema = z.object({
  status: z.literal("error"),
  error: z.object({
    kind: z.literal("conflict"),
    code: z.literal("workflow_run_created_projection_failed"),
    message: z.string(),
    retryable: z.literal(false),
    details: z.object({ runId: z.string() }),
  }),
});

class ProjectionFailingRawBus implements RawBus {
  constructor(
    private readonly failedType: string,
    private readonly failure: unknown,
  ) {}

  async publish<TData>(message: Omit<Message<TData>, "id" | "ts">, _options: PublishOptions) {
    if (message.type === this.failedType) throw this.failure;
    return { id: "1-0", cursor: "1-0" };
  }

  async subscribe(_topic: string, _options: SubscriptionOptions, _handler: RawDeliveryHandler) {
    return Result.ok({
      done: Promise.resolve(Result.ok(undefined)),
      stop: async () => Result.ok(undefined),
    });
  }

  async fetch(_topic: string, _options: FetchOptions) {
    return { messages: [] };
  }

  async close() {}
}

function source() {
  return `import { defineWorkflow } from "@lilac/workflow";
export default defineWorkflow({
  name: "audit-routes",
  description: "Audit routes",
  input: { type: "object", required: ["directory"], properties: { directory: { type: "string" } } },
  resources: { agents: { maxConcurrent: 1, maxTotal: 2 }, waits: [] },
  async run({ args, agent }) { return agent(\`Audit \${args.directory}\`, { profile: "explore" }); },
});
`;
}

describe("ProgrammaticWorkflow trusted auto-run", () => {
  let root: string | null = null;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = null;
  });

  it("accepts equivalent native origin IDs for runs and scheduled triggers", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-native-workflow-"));
    const workspaceRoot = path.join(root, "workspace");
    await fs.mkdir(workspaceRoot);
    const tool = new ProgrammaticWorkflow({
      blobStore,
      dataDir: path.join(root, "data"),
      dbPath: path.join(root, "workflow.sqlite"),
      progressCards: {
        resolveTarget: (platform) => (platform === "native" ? "native" : null),
        ensureInitialCard: async (runId) => ({
          platform: "native",
          channelId: "thread",
          messageId: `card-${runId}`,
        }),
        requestProjection: () => {},
      },
    });
    const context: RequestContext = {
      requestId: "native:thread:input",
      sessionId: "native:thread",
      requestClient: "native",
      cwd: workspaceRoot,
      safetyMode: "trusted",
      serverOwnedRequest: true,
      requestInitiator: { platform: "native", userId: "owner" },
      requestInitiatorSessionId: "thread",
    };
    await tool.init();
    try {
      await callValue(
        tool,
        "workflow.definition.save",
        { scope: "project", name: "audit-routes", source: source() },
        { context },
      );
      const result = await callValue(
        tool,
        "workflow.run.trigger",
        { scope: "project", name: "audit-routes", args: { directory: "src" } },
        { context },
      );
      const run = invocationSchema.parse(result);
      expect(
        await callValue(tool, "workflow.run.get", { runId: run.runId }, { context }),
      ).toMatchObject({
        run: {
          origin: { userId: "owner" },
          progressTarget: { platform: "native", channelId: "thread" },
        },
      });
      const scheduled = await tool.call(
        "workflow.trigger.create",
        {
          scope: "project",
          name: "audit-routes",
          args: { directory: "src" },
          schedule: { kind: "timestamp", at: Date.now() + 60_000 },
        },
        { context },
      );
      expect(scheduled.match({ ok: () => null, err: (error) => error })).toBeNull();
      const denied = await tool.call(
        "workflow.run.trigger",
        { scope: "project", name: "audit-routes", args: { directory: "src" } },
        { context: { ...context, requestInitiatorSessionId: "another-thread" } },
      );
      expect(denied).toMatchObject({ status: "error", error: { kind: "denied" } });
    } finally {
      await tool.destroy();
    }
  });

  it("rejects explicit progress targets without a registered port before durable writes", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-workflow-progress-target-"));
    const workspaceRoot = path.join(root, "workspace");
    const dataDir = path.join(root, "data");
    const dbPath = path.join(root, "workflow.sqlite");
    await fs.mkdir(workspaceRoot);
    const store = new DurableWorkflowStore(dbPath);
    const tool = new ProgrammaticWorkflow({
      blobStore,
      dataDir,
      store,
      progressCards: {
        resolveTarget: () => null,
        ensureInitialCard: async () => {
          throw new Error("unexpected progress card");
        },
        requestProjection: () => {},
      },
    });
    const context = {
      requestId: "request-1",
      sessionId: "channel-1",
      requestClient: "discord",
      cwd: workspaceRoot,
      safetyMode: "trusted" as const,
      requestInitiator: { platform: "discord" as const, userId: "user-1" },
      requestInitiatorSessionId: "channel-1",
    } satisfies RequestContext;
    await tool.init();
    try {
      await callValue(
        tool,
        "workflow.definition.save",
        { scope: "project", name: "audit-routes", source: source() },
        { context },
      );
      await expect(
        tool.call(
          "workflow.run.trigger",
          {
            scope: "project",
            name: "audit-routes",
            args: { directory: "src" },
            progress: { client: "slack", sessionId: "channel-2" },
          },
          { context },
        ),
      ).resolves.toMatchObject({
        status: "error",
        error: {
          kind: "unavailable",
          message: expect.stringContaining("not registered with a progress port: slack"),
        },
      });
      await expect(
        tool.call(
          "workflow.trigger.create",
          {
            scope: "project",
            name: "audit-routes",
            args: { directory: "src" },
            schedule: { kind: "timestamp", at: 1_000 },
            progress: { client: "slack", sessionId: "channel-2" },
          },
          { context },
        ),
      ).resolves.toMatchObject({
        status: "error",
        error: {
          kind: "unavailable",
          message: expect.stringContaining("not registered with a progress port: slack"),
        },
      });
      await expect(
        tool.call(
          "workflow.run.trigger",
          {
            scope: "project",
            name: "audit-routes",
            args: { directory: "src" },
            progress: { requestOrigin: true },
          },
          { context },
        ),
      ).resolves.toMatchObject({
        status: "error",
        error: {
          kind: "unavailable",
          message: expect.stringContaining(
            "request-origin surface is not registered with a progress port: discord",
          ),
        },
      });

      expect(workflowStoreValue(store.listRuns())).toEqual([]);
      expect(workflowStoreValue(store.listTriggers())).toEqual([]);
      expect(workflowStoreValue(store.listRevisions())).toEqual([]);
    } finally {
      await tool.destroy();
      store.close();
    }
  });

  it("returns a nonretryable conflict when progress-card creation fails after commit", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-workflow-card-failure-"));
    const workspaceRoot = path.join(root, "workspace");
    const store = new DurableWorkflowStore(path.join(root, "workflow.sqlite"));
    await fs.mkdir(workspaceRoot);
    const tool = new ProgrammaticWorkflow({
      blobStore,
      dataDir: path.join(root, "data"),
      store,
      progressCards: {
        resolveTarget: (platform) => (platform === "discord" ? platform : null),
        ensureInitialCard: async () => {
          throw new Error("private progress failure");
        },
        requestProjection: () => {},
      },
    });
    const context = {
      requestId: "request-1",
      sessionId: "channel-1",
      requestClient: "discord",
      cwd: workspaceRoot,
      safetyMode: "trusted" as const,
      toolCallId: "tool-call-1",
    } satisfies RequestContext;
    await tool.init();
    try {
      await callValue(
        tool,
        "workflow.definition.save",
        { scope: "project", name: "audit-routes", source: source() },
        { context },
      );
      const failed = createdProjectionFailureSchema.parse(
        await tool.call(
          "workflow.run.trigger",
          { scope: "project", name: "audit-routes", args: { directory: "src" } },
          { context },
        ),
      );

      expect(failed.error.message).toContain("already exists");
      expect(failed.error.message).toContain("Inspect the durable run and reconcile");
      expect(failed.error.message).toContain("rather than blindly retrying");
      expect(failed.error.message).not.toContain("private progress failure");
      expect(workflowStoreValue(store.getRun(failed.error.details.runId))).toMatchObject({
        runId: failed.error.details.runId,
        state: "queued",
      });
    } finally {
      await tool.destroy();
      store.close();
    }
  });

  it("returns the created-run conflict for either bus publication failure", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-workflow-publish-failure-"));
    for (const [index, eventType] of [
      lilacEventTypes.EvtWorkflowRunChanged,
      lilacEventTypes.EvtWorkflowProgressRequested,
    ].entries()) {
      const workspaceRoot = path.join(root, `workspace-${index}`);
      const store = new DurableWorkflowStore(path.join(root, `workflow-${index}.sqlite`));
      await fs.mkdir(workspaceRoot);
      const tool = new ProgrammaticWorkflow({
        blobStore,
        dataDir: path.join(root, `data-${index}`),
        store,
        bus: createLilacBus(
          new ProjectionFailingRawBus(eventType, new Error("private bus failure")),
        ),
      });
      const context = {
        requestId: `request-${index}`,
        cwd: workspaceRoot,
        safetyMode: "trusted" as const,
        toolCallId: `tool-call-${index}`,
      } satisfies RequestContext;
      await tool.init();
      try {
        await callValue(
          tool,
          "workflow.definition.save",
          { scope: "project", name: "audit-routes", source: source() },
          { context },
        );
        const failed = createdProjectionFailureSchema.parse(
          await tool.call(
            "workflow.run.trigger",
            { scope: "project", name: "audit-routes", args: { directory: "src" } },
            { context },
          ),
        );

        expect(failed.error.message).not.toContain("private bus failure");
        expect(workflowStoreValue(store.getRun(failed.error.details.runId))).toMatchObject({
          runId: failed.error.details.runId,
          state: "queued",
        });
      } finally {
        await tool.destroy();
        store.close();
      }
    }
  });

  it("keeps idempotent run identity when its accepted replay has no progress service", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-workflow-idempotent-projection-"));
    const workspaceRoot = path.join(root, "workspace");
    const store = new DurableWorkflowStore(path.join(root, "workflow.sqlite"));
    await fs.mkdir(workspaceRoot);
    const context = {
      requestId: "request-1",
      sessionId: "channel-1",
      requestClient: "discord",
      cwd: workspaceRoot,
      safetyMode: "trusted" as const,
      toolCallId: "tool-call-1",
    } satisfies RequestContext;
    const input = {
      scope: "project",
      name: "audit-routes",
      args: { directory: "src" },
      idempotencyKey: "stable-invocation",
    };
    const firstTool = new ProgrammaticWorkflow({
      blobStore,
      dataDir: path.join(root, "data"),
      store,
      progressCards: {
        resolveTarget: (platform) => (platform === "discord" ? platform : null),
        ensureInitialCard: async (runId) => ({
          platform: "discord",
          channelId: "channel-1",
          messageId: `card-${runId}`,
        }),
        requestProjection: () => {},
      },
    });
    await firstTool.init();
    try {
      await callValue(
        firstTool,
        "workflow.definition.save",
        { scope: "project", name: "audit-routes", source: source() },
        { context },
      );
      const first = invocationSchema.parse(
        await callValue(firstTool, "workflow.run.trigger", input, { context }),
      );
      const successfulReplay = invocationSchema.parse(
        await callValue(firstTool, "workflow.run.trigger", input, { context }),
      );
      expect(successfulReplay.runId).toBe(first.runId);
      expect(workflowStoreValue(store.listRuns())).toHaveLength(1);
      await firstTool.destroy();

      const replayTool = new ProgrammaticWorkflow({
        blobStore,
        dataDir: path.join(root, "data"),
        store,
      });
      await replayTool.init();
      try {
        const failed = createdProjectionFailureSchema.parse(
          await replayTool.call("workflow.run.trigger", input, { context }),
        );
        expect(failed.error.details.runId).toBe(first.runId);
        expect(workflowStoreValue(store.listRuns())).toHaveLength(1);
        expect(workflowStoreValue(store.getRun(first.runId))).toMatchObject({
          runId: first.runId,
          progressTarget: { platform: "discord", channelId: "channel-1" },
        });
      } finally {
        await replayTool.destroy();
      }
    } finally {
      await firstTool.destroy();
      store.close();
    }
  });

  it("preserves Panic from post-commit progress projection", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-workflow-projection-panic-"));
    const workspaceRoot = path.join(root, "workspace");
    const store = new DurableWorkflowStore(path.join(root, "workflow.sqlite"));
    const panic = new Panic({ message: "progress projection invariant failed" });
    await fs.mkdir(workspaceRoot);
    const tool = new ProgrammaticWorkflow({
      blobStore,
      dataDir: path.join(root, "data"),
      store,
      progressCards: {
        resolveTarget: (platform) => (platform === "discord" ? platform : null),
        ensureInitialCard: async () => {
          throw panic;
        },
        requestProjection: () => {},
      },
    });
    const context = {
      requestId: "request-1",
      sessionId: "channel-1",
      requestClient: "discord",
      cwd: workspaceRoot,
      safetyMode: "trusted" as const,
      toolCallId: "tool-call-1",
    } satisfies RequestContext;
    await tool.init();
    try {
      await callValue(
        tool,
        "workflow.definition.save",
        { scope: "project", name: "audit-routes", source: source() },
        { context },
      );
      await expect(
        tool.call(
          "workflow.run.trigger",
          { scope: "project", name: "audit-routes", args: { directory: "src" } },
          { context },
        ),
      ).rejects.toBeInstanceOf(Panic);
      expect(workflowStoreValue(store.listRuns())).toHaveLength(1);
    } finally {
      await tool.destroy();
      store.close();
    }
  });

  it("exposes no approval API and immediately queues authenticated trusted invocations", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-workflow-tool-"));
    const workspaceRoot = path.join(root, "workspace");
    const dataDir = path.join(root, "data");
    await fs.mkdir(workspaceRoot);
    const cards: string[] = [];
    const tool = new ProgrammaticWorkflow({
      blobStore,
      dataDir,
      dbPath: path.join(root, "workflow.sqlite"),
      now: () => 100,
      progressCards: {
        resolveTarget: (platform) =>
          platform === "discord" || platform === "github" ? platform : null,
        ensureInitialCard: async (runId) => {
          cards.push(runId);
          return { platform: "discord", channelId: "channel-1", messageId: `card-${runId}` };
        },
        requestProjection: () => {},
      },
    });
    const context = {
      requestId: "request-1",
      sessionId: "channel-1",
      requestClient: "discord",
      cwd: workspaceRoot,
      safetyMode: "trusted" as const,
      serverOwnedRequest: true,
      requestInitiator: { platform: "discord" as const, userId: "user-1" },
      requestInitiatorSessionId: "channel-1",
      toolCallId: "tool-call-1",
    } satisfies RequestContext;
    await tool.init();
    try {
      expect((await tool.list()).map((entry) => entry.callableId)).not.toContain(
        "workflow.approval.revoke",
      );
      await callValue(
        tool,
        "workflow.definition.save",
        { scope: "project", name: "audit-routes", source: source() },
        { context },
      );
      const crossTarget = invocationSchema.parse(
        await callValue(
          tool,
          "workflow.run.trigger",
          {
            scope: "project",
            name: "audit-routes",
            args: { directory: "src" },
            progress: { client: "github", sessionId: "octo/repo#1" },
            idempotencyKey: "cross-target",
          },
          { context },
        ),
      );
      expect(
        await callValue(tool, "workflow.run.get", { runId: crossTarget.runId }, { context }),
      ).toMatchObject({
        run: {
          origin: { client: "discord", sessionId: "channel-1", userId: "user-1" },
          progressTarget: { platform: "github", channelId: "octo/repo#1" },
        },
      });
      await expect(
        tool.call(
          "workflow.run.trigger",
          { scope: "project", name: "audit-routes", args: { directory: "src" } },
          {
            context: {
              ...context,
              requestInitiator: { platform: "github", userId: "user-1" },
            },
          },
        ),
      ).resolves.toMatchObject({
        status: "error",
        error: {
          kind: "denied",
          message: expect.stringContaining(
            "authenticated identity does not match the request origin",
          ),
        },
      });
      const first = invocationSchema.parse(
        await callValue(
          tool,
          "workflow.run.trigger",
          { scope: "project", name: "audit-routes", args: { directory: "src" } },
          { context },
        ),
      );
      expect(first.state).toBe("queued");
      expect(cards).toEqual([crossTarget.runId, first.runId]);
      const fetched = await callValue(
        tool,
        "workflow.run.get",
        { runId: first.runId },
        { context },
      );
      expect(fetched).toMatchObject({
        run: {
          runId: first.runId,
          state: "queued",
          origin: { client: "discord", sessionId: "channel-1", userId: "user-1" },
        },
      });
      expect(JSON.stringify(fetched)).not.toContain("approval");
    } finally {
      await tool.destroy();
    }
  });

  it("does not gate workflow calls by safety, principal, operator, or server-owned metadata", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-workflow-denied-origin-"));
    const workspaceRoot = path.join(root, "workspace");
    await fs.mkdir(workspaceRoot);
    const tool = new ProgrammaticWorkflow({
      blobStore,
      dataDir: path.join(root, "data"),
      dbPath: path.join(root, "workflow.sqlite"),
    });
    const trusted = {
      requestId: "request-1",
      sessionId: "channel-1",
      requestClient: "discord",
      cwd: workspaceRoot,
      safetyMode: "trusted" as const,
      serverOwnedRequest: true,
      requestInitiator: { platform: "discord" as const, userId: "user-1" },
      requestInitiatorSessionId: "channel-1",
    } satisfies RequestContext;
    await tool.init();
    try {
      for (const context of [
        { ...trusted, serverOwnedRequest: false },
        { ...trusted, safetyMode: "restricted" as const },
        { ...trusted, requestInitiator: undefined },
        { ...trusted, requestInitiator: undefined, operator: true },
      ]) {
        expect(await callValue(tool, "workflow.run.list", {}, { context })).toMatchObject({
          runs: [],
        });
      }
      await expect(
        tool.call("workflow.run.list", { limit: 0 }, { context: trusted }),
      ).resolves.toMatchObject({ status: "error", error: { kind: "usage" } });
    } finally {
      await tool.destroy();
    }
  });

  it("returns sensitive-workflow results while redacting sensitive inputs", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-workflow-result-access-"));
    const workspaceRoot = path.join(root, "workspace");
    const dataDir = path.join(root, "data");
    const dbPath = path.join(root, "workflow.sqlite");
    await fs.mkdir(workspaceRoot);
    const tool = new ProgrammaticWorkflow({
      blobStore,
      dataDir,
      dbPath,
      now: () => 100,
      progressCards: {
        resolveTarget: (platform) => (platform === "discord" ? platform : null),
        ensureInitialCard: async (runId) => ({
          platform: "discord",
          channelId: "channel-1",
          messageId: `card-${runId}`,
        }),
        requestProjection: () => {},
      },
    });
    const context = {
      requestId: "request-1",
      sessionId: "channel-1",
      requestClient: "discord",
      cwd: workspaceRoot,
      safetyMode: "trusted" as const,
      serverOwnedRequest: true,
      requestInitiator: { platform: "discord" as const, userId: "user-1" },
      requestInitiatorSessionId: "channel-1",
    } satisfies RequestContext;
    const sensitiveSource = source()
      .replace('required: ["directory"]', 'required: ["directory", "token"]')
      .replace(
        'properties: { directory: { type: "string" } }',
        'properties: { directory: { type: "string" }, token: { type: "string", sensitive: true } }',
      );
    await tool.init();
    const store = new DurableWorkflowStore(dbPath);
    try {
      await callValue(
        tool,
        "workflow.definition.save",
        { scope: "project", name: "audit-routes", source: sensitiveSource },
        { context },
      );
      const invocation = invocationSchema.parse(
        await callValue(
          tool,
          "workflow.run.trigger",
          {
            scope: "project",
            name: "audit-routes",
            args: { directory: "src", token: "super-secret" },
          },
          { context },
        ),
      );
      expect(
        store.tryClaimRun({ runId: invocation.runId, claimerId: "worker-1", now: 101 }),
      ).not.toBeNull();
      const artifact = await writeWorkflowValueArtifact({
        blobStore,
        workflowStore: store,
        value: "unrestricted result",
        maxBytes: 1_048_576,
      });
      if (artifact.status === "error") throw artifact.error;
      expect(
        store.terminalizeRun({
          runId: invocation.runId,
          from: "running",
          to: "succeeded",
          ownerId: "worker-1",
          now: 102,
          detail: "unrestricted detail",
          result: null,
          resultArtifact: artifact.value,
        }),
      ).toBe(true);

      const fetched = await callValue(
        tool,
        "workflow.run.get",
        { runId: invocation.runId, includeResultArtifact: true },
        { context },
      );
      expect(fetched).toMatchObject({
        run: {
          args: { directory: "src", token: "<redacted>" },
          terminalDetail: "unrestricted detail",
        },
        resultArtifact: "unrestricted result",
      });
      expect(JSON.stringify(fetched)).not.toContain("super-secret");

      const inlineInvocation = invocationSchema.parse(
        await callValue(
          tool,
          "workflow.run.trigger",
          {
            scope: "project",
            name: "audit-routes",
            args: { directory: "src", token: "another-secret" },
          },
          { context },
        ),
      );
      expect(
        store.tryClaimRun({ runId: inlineInvocation.runId, claimerId: "worker-2", now: 103 }),
      ).not.toBeNull();
      expect(
        store.terminalizeRun({
          runId: inlineInvocation.runId,
          from: "running",
          to: "succeeded",
          ownerId: "worker-2",
          now: 104,
          detail: "inline detail",
          result: "inline unrestricted result",
          resultArtifact: null,
        }),
      ).toBe(true);
      const inlineFetched = await callValue(
        tool,
        "workflow.run.get",
        { runId: inlineInvocation.runId },
        { context },
      );
      expect(inlineFetched).toMatchObject({
        run: {
          args: { directory: "src", token: "<redacted>" },
          result: "inline unrestricted result",
          terminalDetail: "inline detail",
        },
      });
      expect(JSON.stringify(inlineFetched)).not.toContain("another-secret");
    } finally {
      store.close();
      await tool.destroy();
    }
  });

  it("pins the trigger snapshot without using origin identity as an invocation gate", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-workflow-trigger-owner-"));
    const workspaceRoot = path.join(root, "workspace");
    await fs.mkdir(workspaceRoot);
    const tool = new ProgrammaticWorkflow({
      blobStore,
      dataDir: path.join(root, "data"),
      dbPath: path.join(root, "workflow.sqlite"),
      now: () => 100,
    });
    const context = {
      requestId: "request-owner",
      sessionId: "channel-1",
      requestClient: "discord",
      cwd: workspaceRoot,
      safetyMode: "trusted" as const,
      serverOwnedRequest: true,
      requestInitiator: { platform: "discord" as const, userId: "owner-1" },
      requestInitiatorSessionId: "channel-1",
      toolCallId: "trigger-call",
    } satisfies RequestContext;
    await tool.init();
    try {
      await callValue(
        tool,
        "workflow.definition.save",
        { scope: "project", name: "audit-routes", source: source() },
        { context },
      );
      const created = z
        .object({
          trigger: z.object({
            triggerId: z.string(),
            revisionId: z.string(),
            origin: z.object({ userId: z.literal("owner-1") }),
          }),
          sourceSha256: z.string(),
        })
        .parse(
          await callValue(
            tool,
            "workflow.trigger.create",
            {
              scope: "project",
              name: "audit-routes",
              args: { directory: "src" },
              schedule: { kind: "timestamp", at: 1_000 },
            },
            { context },
          ),
        );
      expect(created.trigger.revisionId).toBeTruthy();
      expect(created.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(
        await callValue(
          tool,
          "workflow.trigger.get",
          { triggerId: created.trigger.triggerId },
          {
            context: {
              ...context,
              requestInitiator: { platform: "discord", userId: "other-user" },
            },
          },
        ),
      ).toMatchObject({ trigger: { triggerId: created.trigger.triggerId } });
    } finally {
      await tool.destroy();
    }
  });

  it("lets an ordinary workflow child admit runs up to the global cap and returns capacity as an error", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-workflow-child-cap-"));
    const workspaceRoot = path.join(root, "workspace");
    await fs.mkdir(workspaceRoot);
    const tool = new ProgrammaticWorkflow({
      blobStore,
      dataDir: path.join(root, "data"),
      dbPath: path.join(root, "workflow.sqlite"),
      getMaxActiveRuns: () => 1,
    });
    const childContext = {
      requestId: "workflow-child-request",
      sessionId: "workflow:parent:operation",
      requestClient: "unknown",
      cwd: workspaceRoot,
      safetyMode: "restricted" as const,
      serverOwnedRequest: false,
      subagentProfile: "general" as const,
      controlCapability: "ordinary-workflow-control-capability",
      toolCallId: "child-trigger-1",
    } satisfies RequestContext;
    await tool.init();
    try {
      await callValue(
        tool,
        "workflow.definition.save",
        { scope: "project", name: "audit-routes", source: source() },
        { context: childContext },
      );
      const accepted = invocationSchema.parse(
        await callValue(
          tool,
          "workflow.run.trigger",
          { scope: "project", name: "audit-routes", args: { directory: "src" } },
          { context: childContext },
        ),
      );
      expect(accepted.state).toBe("queued");

      const rejected = await tool.call(
        "workflow.run.trigger",
        { scope: "project", name: "audit-routes", args: { directory: "tests" } },
        { context: { ...childContext, toolCallId: "child-trigger-2" } },
      );
      expect(rejected).toMatchObject({
        status: "error",
        error: {
          kind: "unavailable",
          code: "workflow_capacity_exceeded",
          message:
            "Global workflow capacity is full (1/1 active runs). Wait for a workflow to finish or cancel one, then retry with the same idempotency key.",
          retryable: true,
          details: { activeRuns: 1, limit: 1 },
        },
      });
      expect(
        await callValue(tool, "workflow.run.list", {}, { context: childContext }),
      ).toMatchObject({
        runs: [{ runId: accepted.runId }],
      });
    } finally {
      await tool.destroy();
    }
  });
});
