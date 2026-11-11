import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asSchema } from "ai";
import { Result } from "better-result";
import { parseCoreConfigV3ToUniversal } from "@stanley2058/lilac-utils";
import type { LilacBus } from "@stanley2058/lilac-event-bus";
import type { Level1ExecutionRequestContext } from "@stanley2058/lilac-plugin-runtime";

import type { SurfaceThreadControlPort } from "../../src/surface/thread-control";
import type { RegisteredSurfacePlatform } from "../../src/surface/types";
import { createOrchestrateTool, type OrchestrateToolOptions } from "../../src/tools/orchestrate";
import type { SubagentDelegationRegistration } from "../../src/tools/subagent";
import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import {
  canonicalJsonSha256,
  sha256,
  WORKFLOW_RUNTIME_VERSION,
} from "../../src/workflow/workflow-definition";
import type {
  WorkflowOperation,
  WorkflowRevision,
  WorkflowRun,
} from "../../src/workflow/workflow-domain";
import { workflowSourceArtifactReferenceForTest } from "../workflow/workflow-test-blob-store";
import { workflowStoreValue } from "../workflow/workflow-store-test-helpers";

const CONFIG = parseCoreConfigV3ToUniversal({ configVersion: 3 });
const PARENT_SESSION = "native:parent-thread";

type Published = { type: string; data: Record<string, unknown>; headers?: Record<string, string> };

function fakeBus(published: Published[]): LilacBus {
  return {
    publish: async (
      type: string,
      data: Record<string, unknown>,
      options?: { headers?: Record<string, string> },
    ) => {
      published.push({ type, data, ...(options?.headers ? { headers: options.headers } : {}) });
      return Result.ok({ id: String(published.length) });
    },
  } as unknown as LilacBus;
}

describe("orchestrate tool", () => {
  let dir: string;
  let store: DurableWorkflowStore;
  let projectId: string;
  let published: Published[];
  let launches: SubagentDelegationRegistration[];

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "lilac-orchestrate-")));
    store = new DurableWorkflowStore(":memory:");
    projectId = `project:${sha256(dir)}`;
    published = [];
    launches = [];
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedRun(input: {
    id: string;
    subagent?: {
      parentSessionId: string;
      parentRequestId?: string;
      sessionName?: string;
      childRequestId?: string;
    };
    finished?: { result: string };
  }) {
    const now = Date.now();
    const resources: WorkflowRevision["resources"] = {
      agents: { maxConcurrent: 1, maxTotal: 1 },
      maxNestingDepth: 1,
      operationIdleTimeoutMs: 10_000,
      waits: [],
    };
    const limits: WorkflowRevision["limits"] = {
      maxSourceBytes: 10_000,
      maxInputBytes: 10_000,
      maxOperationOutputBytes: 10_000,
      maxResultBytes: 10_000,
    };
    store.createRevision({
      revisionId: `revision-${input.id}`,
      canonicalProjectId: projectId,
      canonicalWorkspaceRoot: dir,
      scope: "project",
      normalizedPath: `${input.id}.js`,
      name: input.subagent ? "subagent-delegate" : "nightly-report",
      snapshotArtifact: workflowSourceArtifactReferenceForTest(input.id),
      sourceSha256: "a".repeat(64),
      inputSchemaSha256: "b".repeat(64),
      resourcePolicySha256: canonicalJsonSha256({ resources, limits }),
      metadata: { name: "run", description: "Test run" },
      inputSchema: { type: "object", additionalProperties: false },
      resources,
      limits,
      runtimeVersion: WORKFLOW_RUNTIME_VERSION,
      createdAt: now,
    });
    const subagent = input.subagent;
    const sessionName = subagent?.sessionName ?? "full-abc123";
    const runId = subagent ? `wfrun:subagent:${input.id}` : `wfrun:${input.id}`;
    const run: WorkflowRun = {
      runId,
      revisionId: `revision-${input.id}`,
      state: "running",
      inputSchemaSnapshot: {},
      args: {},
      argsSha256: canonicalJsonSha256({}),
      origin: {
        requestId: "parent-request",
        sessionId: PARENT_SESSION,
        client: "native",
        userId: "owner",
        projectCwd: dir,
      },
      completionTarget: subagent
        ? {
            kind: "live_parent",
            parentRequestId: subagent.parentRequestId ?? "parent-request",
            parentSessionId: subagent.parentSessionId,
            parentRequestClient: "native",
            parentToolCallId: `spawn-${input.id}`,
            childRequestId: subagent.childRequestId ?? `child-${input.id}`,
            childSessionId: `sub:${subagent.parentSessionId}:named:${sessionName}`,
            profile: "full",
            sessionName,
            depth: 1,
            reasoning: null,
            fallbackToSurface: false,
            fallbackProgressTarget: null,
            deferredDelivery: true,
          }
        : { kind: "detached" },
      progressTarget: null,
      terminalDetail: null,
      result: null,
      resultArtifact: null,
      claimedBy: "test-worker",
      claimedAt: now,
      createdAt: now,
      startedAt: now,
      updatedAt: now,
      terminalAt: null,
    };
    store.createRun(run);
    const operation: WorkflowOperation = {
      runId,
      operationId: "agent",
      callSiteId: "agent",
      parentOperationId: null,
      phase: null,
      label: "subagent full",
      kind: "agent",
      input: { prompt: "Research", options: { profile: "full", cwd: dir } },
      inputSha256: "c".repeat(64),
      state: input.finished ? "succeeded" : "running",
      attempt: 0,
      requestId: `wfr:${input.id}:agent:0`,
      output: null,
      resultArtifact: null,
      error: null,
      usage: null,
      claimedBy: "test-worker",
      claimedAt: now,
      createdAt: now,
      startedAt: now,
      updatedAt: now,
      terminalAt: input.finished ? now : null,
    };
    if (!store.createOperation(operation, "test-worker"))
      throw new Error("Could not seed operation");
    if (input.finished)
      store.transitionRun({
        runId,
        from: "running",
        to: "succeeded",
        now,
        result: input.finished.result,
      });
    return {
      runId,
      requestId: operation.requestId!,
      childSessionId:
        run.completionTarget.kind === "live_parent" ? run.completionTarget.childSessionId : "",
    };
  }

  function primaryContext(
    overrides: Partial<Level1ExecutionRequestContext<RegisteredSurfacePlatform>> = {},
  ): Level1ExecutionRequestContext<RegisteredSurfacePlatform> {
    return {
      requestId: "native:parent-thread:turn-2",
      requestDeliveryId: "delivery",
      sessionId: PARENT_SESSION,
      requestClient: "native",
      subagentDepth: 0,
      subagentProfile: "primary",
      serverOwnedRequest: true,
      requestInitiator: { platform: "native", userId: "owner" },
      requestInitiatorSessionId: PARENT_SESSION,
      ...overrides,
    };
  }

  function build(options: Partial<OrchestrateToolOptions> = {}) {
    return createOrchestrateTool({
      config: CONFIG,
      cwd: dir,
      runProfile: "primary",
      canControl: true,
      idleTimeoutMs: 60_000,
      maxDepth: 2,
      requestContext: primaryContext(),
      workflows: store,
      bus: fakeBus(published),
      delegate: async (registration) => {
        launches.push(registration);
        return {
          runId: `wfrun:subagent:follow-up-${launches.length}`,
          completion: new Promise(() => {}),
          cancel: async () => {},
        };
      },
      ...options,
    });
  }

  async function call(
    built: ReturnType<typeof build>,
    input: Record<string, unknown>,
  ): Promise<Record<string, any>> {
    return (await built.execute!(
      input as never,
      {
        toolCallId: "tool-call",
        messages: [],
      } as never,
    )) as Record<string, any>;
  }

  it("reads a running child's transcript as messages or activity", async () => {
    const child = seedRun({ id: "reader", subagent: { parentSessionId: PARENT_SESSION } });
    const built = build({
      transcripts: {
        getRequestTranscript: ({ requestId }) =>
          Result.ok(
            requestId === child.requestId
              ? ({
                  messages: [
                    { role: "user", content: "Research the bug" },
                    {
                      role: "assistant",
                      content: [
                        { type: "text", text: "Checking the logs." },
                        {
                          type: "tool-call",
                          toolCallId: "t1",
                          toolName: "bash",
                          input: { command: "cat log" },
                        },
                      ],
                    },
                    {
                      role: "tool",
                      content: [
                        {
                          type: "tool-result",
                          toolCallId: "t1",
                          toolName: "bash",
                          output: { type: "text", value: "ERROR at line 4" },
                        },
                      ],
                    },
                  ],
                } as never)
              : null,
          ),
      },
    });

    const messages = await call(built, { action: "read", id: child.runId });
    expect(messages).toMatchObject({ kind: "subagent", state: "running", running: true });
    expect(messages.items.map((item: { text: string }) => item.text)).toEqual([
      "Research the bug",
      "Checking the logs.",
    ]);

    const latest = await call(built, { action: "read", id: child.runId, limit: 1 });
    expect(latest).toMatchObject({ hasMore: true, before: "1", after: "2" });
    expect(latest.items.map((item: { text: string }) => item.text)).toEqual(["Checking the logs."]);

    const activity = await call(built, { action: "read", id: child.runId, view: "activity" });
    expect(activity.items.some((item: { kind: string }) => item.kind === "activity")).toBe(true);
  });

  it("does not let another conversation read a child it cannot reach", async () => {
    const child = seedRun({ id: "private", subagent: { parentSessionId: "native:someone-else" } });
    const built = build();
    await expect(call(built, { action: "read", id: child.runId })).rejects.toThrow(/cannot read/u);
  });

  it("steers a running child through its active request", async () => {
    const child = seedRun({ id: "steer", subagent: { parentSessionId: PARENT_SESSION } });
    const result = await call(build(), {
      action: "send",
      id: child.runId,
      message: "Focus on the auth module.",
    });
    expect(result).toEqual({ kind: "subagent", disposition: "steered", runId: child.runId });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      data: {
        queue: "steer",
        messages: [{ role: "user", content: "Focus on the auth module." }],
        raw: {
          requiresActive: true,
          autoFollowUp: {
            parentRequestId: "native:parent-thread:turn-2",
            parentToolCallId: "tool-call",
          },
        },
      },
      headers: { request_id: child.requestId, session_id: child.childSessionId },
    });
  });

  it("continues a finished child in its own conversation with its previous model", async () => {
    const child = seedRun({
      id: "done",
      subagent: { parentSessionId: PARENT_SESSION, sessionName: "full-feedc0de" },
      finished: { result: "First answer" },
    });
    const original = store.getWorkflowRequestDispatchPolicy.bind(store);
    store.getWorkflowRequestDispatchPolicy = (requestId) =>
      requestId === child.requestId
        ? Result.ok({ model: "openai/gpt-5.5", reasoning: "high" } as never)
        : original(requestId);

    const result = await call(build(), {
      action: "send",
      id: child.runId,
      message: "Now check the tests.",
    });

    expect(result).toEqual({
      kind: "subagent",
      disposition: "started",
      runId: "wfrun:subagent:follow-up-1",
      previousRunId: child.runId,
    });
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({
      mode: "deferred",
      profile: "full",
      sessionName: "full-feedc0de",
      childSessionId: child.childSessionId,
      task: "Now check the tests.",
      modelOverride: "openai/gpt-5.5",
      reasoningOverride: "high",
      parentSessionId: PARENT_SESSION,
    });
    expect(store.getRun(child.runId).unwrap()?.result).toBe("First answer");
  });

  it("steers only a child the runner holds as its active run, and follows up otherwise", async () => {
    const child = seedRun({ id: "between", subagent: { parentSessionId: PARENT_SESSION } });
    let active = false;
    const built = build({
      liveSubagents: () => ({
        readSubagentSnapshot: (sessionId, requestId) =>
          active && sessionId === child.childSessionId && requestId === child.requestId
            ? ({ messages: [], streaming: true, title: "Working" } as never)
            : undefined,
      }),
    });

    await expect(
      call(built, { action: "send", id: child.runId, message: "Now", mode: "steer" }),
    ).rejects.toThrow(/target-ended/u);
    expect(await call(built, { action: "send", id: child.runId, message: "Later" })).toMatchObject({
      disposition: "started",
    });
    expect(launches.map((launch) => launch.task)).toEqual(["Later"]);

    active = true;
    expect(await call(built, { action: "send", id: child.runId, message: "Now" })).toMatchObject({
      disposition: "steered",
    });
  });

  it("reports target-ended when an explicit steer reaches a finished child", async () => {
    const child = seedRun({
      id: "ended",
      subagent: { parentSessionId: PARENT_SESSION },
      finished: { result: "done" },
    });
    await expect(
      call(build(), { action: "send", id: child.runId, message: "More", mode: "steer" }),
    ).rejects.toThrow(/target-ended/u);
    expect(launches).toHaveLength(0);
  });

  it("only lets the launching conversation message or stop a child", async () => {
    const child = seedRun({ id: "sibling", subagent: { parentSessionId: PARENT_SESSION } });
    const fromChild = build({
      runProfile: "full",
      requestContext: primaryContext({
        sessionId: "sub:native:parent-thread:named:other",
        subagentDepth: 1,
        subagentProfile: "full",
        serverOwnedRequest: undefined,
      }),
    });
    await expect(
      call(fromChild, { action: "send", id: child.runId, message: "Stop that" }),
    ).rejects.toThrow(/Only the conversation that launched/u);
    await expect(call(fromChild, { action: "interrupt", id: child.runId })).rejects.toThrow(
      /Only the conversation that launched/u,
    );
    expect(published).toHaveLength(0);
  });

  it("interrupts the exact run, leaving a newer follow-up alone", async () => {
    const old = seedRun({
      id: "old",
      subagent: { parentSessionId: PARENT_SESSION, sessionName: "full-same" },
      finished: { result: "old" },
    });
    const newer = seedRun({
      id: "newer",
      subagent: { parentSessionId: PARENT_SESSION, sessionName: "full-same" },
    });

    const stale = await call(build(), { action: "interrupt", id: old.runId });
    expect(stale).toMatchObject({ kind: "subagent", status: "ended", state: "succeeded" });
    expect(store.getRun(newer.runId).unwrap()?.state).toBe("running");

    const stopped = await call(build(), { action: "interrupt", id: newer.runId });
    expect(stopped).toMatchObject({ kind: "subagent", status: "cancelled", state: "cancelled" });
    expect(published[0]).toMatchObject({
      data: { queue: "interrupt", raw: { cancel: true } },
      headers: { request_id: newer.requestId },
    });
  });

  it("reads and interrupts scripted workflows but never messages them", async () => {
    const workflow = seedRun({ id: "nightly" });
    const built = build();
    expect(await call(built, { action: "read", id: workflow.runId })).toMatchObject({
      kind: "workflow",
      name: "nightly-report",
      state: "running",
      operations: [{ operationId: "agent", kind: "agent", state: "running" }],
    });
    await expect(
      call(built, { action: "send", id: workflow.runId, message: "hi" }),
    ).rejects.toThrow(/do not accept messages/u);
    expect(await call(built, { action: "interrupt", id: workflow.runId })).toMatchObject({
      kind: "workflow",
      status: "cancelled",
    });
  });

  it("keeps workflows from another project private", async () => {
    const workflow = seedRun({ id: "elsewhere" });
    const other = realpathSync(mkdtempSync(path.join(tmpdir(), "lilac-orchestrate-other-")));
    try {
      await expect(
        call(build({ cwd: other }), { action: "read", id: workflow.runId }),
      ).rejects.toThrow(/outside this run's project/u);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("offers only read to a run that cannot control targets", async () => {
    const built = build({ canControl: false, runProfile: "full" });
    const schema = asSchema(built.inputSchema as never).jsonSchema as {
      properties: { action: { enum: string[] } };
    };
    expect(schema.properties.action.enum).toEqual(["read"]);
  });

  it("rejects thread targets when the caller's surface has no thread control", async () => {
    const built = build({
      requestContext: primaryContext({
        requestClient: "discord",
        sessionId: "123",
        requestInitiator: { platform: "discord", userId: "u" },
        requestInitiatorSessionId: "123",
      }),
      threadControl: { resolve: () => null },
    });
    await expect(call(built, { action: "read", id: "some-thread" })).rejects.toThrow(
      /Thread control is unavailable on this surface/u,
    );
  });

  it("routes thread targets through the caller's surface port as its principal", async () => {
    const calls: unknown[] = [];
    const port: SurfaceThreadControlPort = {
      read: async (caller, threadId, input) => {
        calls.push({ op: "read", caller, threadId, input });
        return Result.ok({
          threadId,
          title: "Other",
          activeRunId: null,
          items: [],
          hasMore: false,
        });
      },
      send: async (caller, threadId, input) => {
        calls.push({ op: "send", caller, threadId, input });
        return Result.ok({ disposition: "started", messageId: "m1", runId: "r1" });
      },
      interrupt: async (caller, threadId, input) => {
        calls.push({ op: "interrupt", caller, threadId, input });
        return Result.ok({ status: "idle" });
      },
    };
    const built = build({
      threadControl: { resolve: (platform) => (platform === "native" ? port : null) },
    });
    expect(await call(built, { action: "send", id: "other-thread", message: "Hello" })).toEqual({
      kind: "thread",
      disposition: "started",
      messageId: "m1",
      runId: "r1",
    });
    expect(calls[0]).toEqual({
      op: "send",
      caller: { userId: "owner", sourceThreadId: PARENT_SESSION },
      threadId: "other-thread",
      input: { text: "Hello", mode: "auto" },
    });

    const unverified = build({
      requestContext: primaryContext({ serverOwnedRequest: undefined }),
      threadControl: { resolve: () => port },
    });
    await expect(call(unverified, { action: "read", id: "other-thread" })).rejects.toThrow(
      /Thread control is unavailable/u,
    );

    // A delegating subagent reads other threads but cannot message or stop them.
    const fromChild = build({
      runProfile: "full",
      threadControl: { resolve: () => port },
      requestContext: primaryContext({
        sessionId: "sub:native:parent-thread:named:helper",
        subagentDepth: 1,
        subagentProfile: "full",
        serverOwnedRequest: undefined,
      }),
    });
    expect(await call(fromChild, { action: "read", id: "other-thread" })).toMatchObject({
      kind: "thread",
    });
    await expect(
      call(fromChild, { action: "send", id: "other-thread", message: "Hi" }),
    ).rejects.toThrow(/Only a primary run/u);
    await expect(call(fromChild, { action: "interrupt", id: "other-thread" })).rejects.toThrow(
      /Only a primary run/u,
    );
    expect(calls.filter((entry) => (entry as { op: string }).op !== "read")).toHaveLength(1);
  });

  it("does not send a keyed message twice", async () => {
    const running = seedRun({ id: "keyed-steer", subagent: { parentSessionId: PARENT_SESSION } });
    const built = build();
    const steer = { action: "send", id: running.runId, message: "Focus", commandId: "k1" };
    await call(built, steer);
    await call(built, steer);
    expect(published).toHaveLength(2);
    expect(published[0]!.data.requestDeliveryId).toBe(published[1]!.data.requestDeliveryId);

    const finished = seedRun({
      id: "keyed-follow-up",
      subagent: { parentSessionId: PARENT_SESSION, sessionName: "full-keyed" },
      finished: { result: "done" },
    });
    const followUp = { action: "send", id: finished.runId, message: "Next", commandId: "k2" };
    const first = await call(
      build({
        delegate: async (registration) => {
          launches.push(registration);
          // The dispatcher stores the follow-up so a retry can find it.
          seedRun({
            id: "keyed-follow-up-run",
            subagent: {
              parentSessionId: PARENT_SESSION,
              sessionName: "full-keyed",
              childRequestId: registration.childRequestId,
            },
          });
          return {
            runId: "wfrun:subagent:keyed-follow-up-run",
            completion: new Promise(() => {}),
            cancel: async () => {},
          };
        },
      }),
      followUp,
    );
    const retried = await call(built, followUp);
    expect(retried).toEqual(first);
    expect(launches).toHaveLength(1);
  });

  it("replays a keyed send even after the child changed state", async () => {
    const child = seedRun({ id: "keyed-cross", subagent: { parentSessionId: PARENT_SESSION } });
    const built = build({
      requestDeliveryKnown: (id) => published.some((item) => item.data.requestDeliveryId === id),
    });
    const send = { action: "send", id: child.runId, message: "Focus", commandId: "k3" };
    expect(await call(built, send)).toMatchObject({ disposition: "steered" });
    store.transitionRun({ runId: child.runId, from: "running", to: "succeeded", now: Date.now() });

    expect(await call(built, send)).toMatchObject({ disposition: "steered", runId: child.runId });
    expect(launches).toHaveLength(0);
  });

  it("finds a keyed follow-up beyond the newest page of subagent runs", async () => {
    const suffix = `:cmd-${sha256(`${PARENT_SESSION}:k9`).slice(0, 40)}`;
    const target = seedRun({
      id: "aaa-old-follow-up",
      subagent: {
        parentSessionId: PARENT_SESSION,
        sessionName: "full-paged",
        childRequestId: `sub:x${suffix}`,
      },
    });
    for (let index = 0; index < 101; index += 1)
      seedRun({ id: `zzz-${index}`, subagent: { parentSessionId: PARENT_SESSION } });
    const finished = seedRun({
      id: "aab-finished",
      subagent: { parentSessionId: PARENT_SESSION, sessionName: "full-paged" },
      finished: { result: "done" },
    });

    const result = await call(build(), {
      action: "send",
      id: finished.runId,
      message: "Next",
      commandId: "k9",
    });
    expect(result).toMatchObject({ disposition: "started", runId: target.runId });
    expect(launches).toHaveLength(0);
  });

  it("pages workflow operations from storage beyond the first thousand", async () => {
    const workflow = seedRun({ id: "paged" });
    const base = workflowStoreValue(store.listOperations(workflow.runId))[0]!;
    for (let index = 0; index < 1_001; index += 1)
      store.createOperation(
        {
          ...base,
          operationId: `phase-${String(index).padStart(4, "0")}`,
          callSiteId: `phase-${index}`,
          kind: "phase",
          requestId: null,
          createdAt: base.createdAt + index + 1,
        },
        "test-worker",
      );
    const built = build();

    const latest = await call(built, { action: "read", id: workflow.runId, limit: 3 });
    expect(latest).toMatchObject({ hasMore: true, before: "999", after: "1002" });
    expect(latest.operations.map((item: { operationId: string }) => item.operationId)).toEqual([
      "phase-0998",
      "phase-0999",
      "phase-1000",
    ]);

    const beyond = await call(built, { action: "read", id: workflow.runId, after: "1000" });
    expect(beyond.operations.map((item: { operationId: string }) => item.operationId)).toEqual([
      "phase-0999",
      "phase-1000",
    ]);
  });
});
