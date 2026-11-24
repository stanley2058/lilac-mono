import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asSchema } from "ai";
import { Panic, Result } from "better-result";
import {
  parseCoreConfigV2ToUniversal,
  parseCoreConfigV3ToUniversal,
} from "@stanley2058/lilac-utils";
import type { LilacBus } from "@stanley2058/lilac-event-bus";
import type { Level1ExecutionRequestContext } from "@stanley2058/lilac-plugin-runtime";

import { corePreparedRequestEnvelopeSchema } from "../../src/surface/bridge/request-delivery/core-integration";
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
import { createRealCoreBusFixture, requireBusOk, withBusDeadline } from "../helpers/real-core-bus";

const CONFIG = parseCoreConfigV3ToUniversal({ configVersion: 3 });
// The catalog lists claude-code only where its credentials exist, so CI pins it.
CONFIG.models.catalog = { providers: { "claude-code": "enabled" } };
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
      title?: string;
    };
    finished?: { result: string };
    queued?: boolean;
    origin?: Partial<WorkflowRun["origin"]>;
    createdAt?: number;
  }) {
    const now = input.createdAt ?? Date.now();
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
      state: input.queued ? "queued" : "running",
      inputSchemaSnapshot: {},
      args: {},
      argsSha256: canonicalJsonSha256({}),
      origin: {
        requestId: "parent-request",
        sessionId: PARENT_SESSION,
        client: "native",
        userId: "owner",
        projectCwd: dir,
        ...input.origin,
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
            ...(subagent.title ? { title: subagent.title } : {}),
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
    const childSessionId =
      run.completionTarget.kind === "live_parent" ? run.completionTarget.childSessionId : "";
    if (input.queued) return { runId, requestId: "", childSessionId };
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
    return { runId, requestId: operation.requestId!, childSessionId };
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

  it("delivers keyed steering and cancellation through the real durable Redis bus", async () => {
    const fixture = await createRealCoreBusFixture();
    const child = seedRun({ id: "real-bus", subagent: { parentSessionId: PARENT_SESSION } });
    const received: Array<{ queue: string; requestDeliveryId: string; requestId?: string }> = [];
    const arrivals = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const subscription = requireBusOk(
      await fixture.bus.subscribeTopic(
        "cmd.request",
        { mode: "fanout", subscriptionId: "orchestrate-controls" },
        async (message) => {
          received.push({
            queue: message.data.queue,
            requestDeliveryId: message.data.requestDeliveryId,
            requestId: message.headers?.request_id,
          });
          arrivals[received.length - 1]?.resolve();
          return Result.ok(undefined);
        },
        () => "commit",
      ),
    );
    try {
      const built = build({ bus: fixture.bus });
      const command = {
        action: "send",
        id: child.runId,
        message: "Focus on auth",
        commandId: "stable-command",
      };
      expect(await call(built, command)).toMatchObject({ disposition: "steered" });
      await withBusDeadline(arrivals[0]!.promise, "orchestrate steer");
      expect(await call(built, command)).toMatchObject({ disposition: "steered" });
      expect(
        requireBusOk(
          await fixture.bus.fetchTopic("cmd.request", {
            offset: { type: "begin" },
            limit: 10,
          }),
        ).messages,
      ).toHaveLength(1);
      expect(await call(built, { action: "interrupt", id: child.runId })).toMatchObject({
        status: "cancelled",
      });
      await withBusDeadline(arrivals[1]!.promise, "orchestrate cancellation");
      expect(received.map((message) => message.queue)).toEqual(["steer", "interrupt"]);
      expect(received.map((message) => message.requestId)).toEqual([
        child.requestId,
        child.requestId,
      ]);
      expect(received[1]!.requestDeliveryId).not.toBe(received[0]!.requestDeliveryId);
      for (const message of received) {
        expect(
          requireBusOk(fixture.store.load(message.requestDeliveryId)).publication?.streamId,
        ).toBeString();
      }
    } finally {
      requireBusOk(await subscription.stop());
      await fixture.close();
    }
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

    expect(
      await call(built, { action: "send", id: child.runId, message: "Now", mode: "steer" }),
    ).toMatchObject({ disposition: "started" });
    expect(await call(built, { action: "send", id: child.runId, message: "Later" })).toMatchObject({
      disposition: "started",
    });
    expect(launches.map((launch) => launch.task)).toEqual(["Now", "Later"]);

    active = true;
    expect(await call(built, { action: "send", id: child.runId, message: "Now" })).toMatchObject({
      disposition: "steered",
    });
    expect(
      await call(built, {
        action: "send",
        id: child.runId,
        message: "Next, faster",
        model: "claude-code/claude-opus-5-5",
        options: { settings: { fastMode: true } },
      }),
    ).toMatchObject({ disposition: "started" });
    await expect(
      call(built, {
        action: "send",
        id: child.runId,
        message: "Steer with settings",
        mode: "steer",
        model: "claude-code/claude-opus-5-5",
      }),
    ).rejects.toThrow(/apply to a new run/u);
  });

  it("follows up when an explicit steer reaches a finished child", async () => {
    const child = seedRun({
      id: "ended",
      subagent: { parentSessionId: PARENT_SESSION },
      finished: { result: "done" },
    });
    const built = build();
    expect(
      await call(built, { action: "send", id: child.runId, message: "More", mode: "steer" }),
    ).toMatchObject({ disposition: "started" });
    expect(
      await call(built, {
        action: "send",
        id: child.runId,
        message: "Faster",
        mode: "steer",
        model: "claude-code/claude-opus-5-5",
      }),
    ).toMatchObject({ disposition: "started" });
    expect(launches.map((launch) => launch.task)).toEqual(["More", "Faster"]);
  });

  it("carries, replaces, and clears model settings across follow-ups", async () => {
    const child = seedRun({
      id: "settings",
      subagent: { parentSessionId: PARENT_SESSION },
      finished: { result: "done" },
    });
    const original = store.getWorkflowRequestDispatchPolicy.bind(store);
    store.getWorkflowRequestDispatchPolicy = (requestId) =>
      requestId === child.requestId
        ? Result.ok({
            model: "claude-code/claude-opus-5-5",
            reasoning: "high",
            options: { settings: { fastMode: true } },
            resolvedModelRequest: { spec: "claude-code/claude-opus-5-5", provider: "claude-code" },
          } as never)
        : original(requestId);
    const built = build();
    const send = (input: Record<string, unknown>) =>
      call(built, { action: "send", id: child.runId, message: "Again", ...input });

    await send({});
    await send({ options: { taskBudget: { total: 50000 } } });
    await send({ options: {} });
    await send({ model: "claude-code/claude-sonnet-5" });

    expect(
      launches.map(({ modelOverride, reasoningOverride, providerOptionsOverride }) => ({
        modelOverride,
        reasoningOverride,
        providerOptionsOverride,
      })),
    ).toEqual([
      {
        modelOverride: "claude-code/claude-opus-5-5",
        reasoningOverride: "high",
        providerOptionsOverride: { settings: { fastMode: true } },
      },
      {
        modelOverride: "claude-code/claude-opus-5-5",
        reasoningOverride: "high",
        providerOptionsOverride: { taskBudget: { total: 50000 } },
      },
      {
        modelOverride: "claude-code/claude-opus-5-5",
        reasoningOverride: "high",
        providerOptionsOverride: undefined,
      },
      {
        modelOverride: "claude-code/claude-sonnet-5",
        reasoningOverride: undefined,
        providerOptionsOverride: { settings: { fastMode: true } },
      },
    ]);
  });

  it("accepts the model read reports when continuing a v2 alias child", async () => {
    const child = seedRun({
      id: "v2-alias",
      subagent: { parentSessionId: PARENT_SESSION },
      finished: { result: "done" },
    });
    const config = parseCoreConfigV2ToUniversal({});
    config.models.def = { deep: { model: "openai/gpt-5.5", agentCanSelect: true } };
    const original = store.getWorkflowRequestDispatchPolicy.bind(store);
    store.getWorkflowRequestDispatchPolicy = (requestId) =>
      requestId === child.requestId
        ? Result.ok({
            model: "deep",
            reasoning: "high",
            resolvedModelRequest: { alias: "deep", spec: "openai/gpt-5.5", provider: "openai" },
          } as never)
        : original(requestId);
    const built = build({ config });
    const read = await call(built, { action: "read", id: child.runId });
    await call(built, {
      action: "send",
      id: child.runId,
      message: "Again, faster",
      model: read.model,
      options: { serviceTier: "priority" },
    });
    expect(launches[0]).toMatchObject({
      modelOverride: "deep",
      reasoningOverride: "high",
      providerOptionsOverride: { serviceTier: "priority" },
    });
  });

  it("rejects settings it cannot apply", async () => {
    const child = seedRun({
      id: "bad-settings",
      subagent: { parentSessionId: PARENT_SESSION },
      finished: { result: "done" },
    });
    const workflow = seedRun({ id: "scripted" });
    const built = build();
    await expect(
      call(built, {
        action: "send",
        id: child.runId,
        message: "Go",
        model: "claude-code/claude-opus-5-5",
        options: { previousResponseId: "resp_1" },
      }),
    ).rejects.toThrow(/previousResponseId is not a supported option/u);
    await expect(
      call(built, {
        action: "interrupt",
        id: workflow.runId,
        model: "claude-code/claude-opus-5-5",
      }),
    ).rejects.toThrow(/apply only to send to a subagent/u);
    expect(launches).toHaveLength(0);
  });

  it("reads effective settings and the rest of a truncated result", async () => {
    const child = seedRun({
      id: "long",
      subagent: { parentSessionId: PARENT_SESSION },
      finished: { result: "0123456789abcdef" },
    });
    const original = store.getWorkflowRequestDispatchPolicy.bind(store);
    store.getWorkflowRequestDispatchPolicy = (requestId) =>
      requestId === child.requestId
        ? Result.ok({
            options: { serviceTier: "priority" },
            resolvedModelRequest: {
              spec: "codex/gpt-5.4-pro",
              provider: "codex",
              reasoning: "high",
              providerOptions: {
                openai: { serviceTier: "priority", textVerbosity: "low", store: false },
              },
            },
          } as never)
        : original(requestId);
    const built = build();

    const head = await call(built, { action: "read", id: child.runId, maxCharsPerItem: 10 });
    expect(head).toMatchObject({
      model: "codex/gpt-5.4-pro",
      reasoning: "high",
      options: { serviceTier: "priority", textVerbosity: "low" },
      result: { text: "0123456789", truncated: true, nextTextOffset: 10 },
    });
    const rest = await call(built, {
      action: "read",
      id: child.runId,
      itemId: "result",
      textOffset: 10,
      maxCharsPerItem: 10,
    });
    expect(rest.items).toEqual([
      {
        id: "result",
        role: "assistant",
        kind: "text",
        text: "abcdef",
        truncated: false,
        textOffset: 10,
      },
    ]);
    await expect(call(built, { action: "read", id: child.runId, textOffset: 10 })).rejects.toThrow(
      /textOffset requires itemId/u,
    );
  });

  it("names the live follow-up when interrupting an ended run", async () => {
    const old = seedRun({
      id: "old",
      subagent: { parentSessionId: PARENT_SESSION, sessionName: "full-shared" },
      finished: { result: "done" },
    });
    const next = seedRun({
      id: "next",
      subagent: { parentSessionId: PARENT_SESSION, sessionName: "full-shared" },
    });
    seedRun({
      id: "later",
      subagent: { parentSessionId: PARENT_SESSION, sessionName: "full-shared" },
      queued: true,
      createdAt: Date.now() + 1_000,
    });
    expect(await call(build(), { action: "interrupt", id: old.runId })).toMatchObject({
      status: "ended",
      liveRunId: next.runId,
    });
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

  it("offers only reading actions to a run that cannot control targets", async () => {
    const built = build({ canControl: false, runProfile: "full" });
    const schema = asSchema(built.inputSchema as never).jsonSchema as {
      properties: { action: { enum: string[] } };
    };
    expect(schema.properties.action.enum).toEqual(["read", "list", "search"]);
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
    // The durable request bus accepts the steer only if it meets the prepared-envelope contract.
    expect(
      corePreparedRequestEnvelopeSchema.safeParse({
        headers: published[0]!.headers,
        data: published[0]!.data,
      }).success,
    ).toBe(true);

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
  it("lists the subagents in this conversation, nested ones included, newest first", async () => {
    const first = seedRun({
      id: "first",
      subagent: { parentSessionId: PARENT_SESSION, title: "Review" },
      createdAt: 1_000,
    });
    const nested = seedRun({
      id: "nested",
      subagent: {
        parentSessionId: first.childSessionId,
        parentRequestId: first.requestId,
        sessionName: "full-nested",
      },
      createdAt: 2_000,
      finished: { result: "done" },
    });
    seedRun({ id: "elsewhere", subagent: { parentSessionId: "native:other" }, createdAt: 3_000 });

    const listed = await call(build(), { action: "list" });
    expect(listed.items).toEqual([
      expect.objectContaining({
        kind: "subagent",
        id: nested.runId,
        parentId: first.runId,
        state: "succeeded",
        controllable: false,
      }),
      expect.objectContaining({
        kind: "subagent",
        id: first.runId,
        title: "Review",
        client: "native",
        controllable: true,
      }),
    ]);
    expect(listed.before).toBeUndefined();

    const page = await call(build(), { action: "list", limit: 1 });
    expect(page.items.map((item: { id: string }) => item.id)).toEqual([nested.runId]);
    const next = await call(build(), { action: "list", limit: 1, before: page.before });
    expect(next.items.map((item: { id: string }) => item.id)).toEqual([first.runId]);

    const active = await call(build(), { action: "list", state: "active" });
    expect(active.items.map((item: { id: string }) => item.id)).toEqual([first.runId]);

    // A subagent sees its whole conversation, itself included, but controls none of it.
    const fromChild = build({
      runProfile: "full",
      canControl: false,
      requestContext: primaryContext({
        requestId: first.requestId,
        sessionId: first.childSessionId,
        subagentDepth: 1,
        subagentProfile: "full",
        serverOwnedRequest: undefined,
      }),
    });
    const seen = await call(fromChild, { action: "list" });
    expect(seen.items).toEqual([
      expect.objectContaining({ id: nested.runId, controllable: false }),
      expect.objectContaining({ id: first.runId, self: true, controllable: false }),
    ]);
  });

  it("lists the runs a user started, and only workflows in this project", async () => {
    const mine = seedRun({
      id: "mine",
      subagent: { parentSessionId: "native:another-thread" },
      createdAt: 1_000,
    });
    seedRun({
      id: "theirs",
      subagent: { parentSessionId: "native:their-thread" },
      origin: { userId: "someone-else" },
    });
    const workflow = seedRun({ id: "report", createdAt: 2_000 });

    const subagents = await call(build(), { action: "list", scope: "user", kind: "subagent" });
    expect(subagents.items.map((item: { id: string }) => item.id)).toEqual([mine.runId]);
    expect(subagents.items[0]).toMatchObject({ controllable: false });

    const workflows = await call(build(), { action: "list", scope: "user", kind: "workflow" });
    expect(workflows.items).toEqual([
      expect.objectContaining({ kind: "workflow", id: workflow.runId, name: "nightly-report" }),
    ]);

    const other = realpathSync(mkdtempSync(path.join(tmpdir(), "lilac-orchestrate-other-")));
    try {
      const elsewhere = await call(build({ cwd: other }), {
        action: "list",
        scope: "user",
        kind: "workflow",
      });
      expect(elsewhere.items).toEqual([]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("lists threads on the user's surface and, through a linked account, Discord", async () => {
    const config = {
      ...CONFIG,
      surface: {
        ...CONFIG.surface,
        discord: {
          ...CONFIG.surface.discord,
          allowedChannelIds: ["111", "222"],
          allowedGuildIds: [],
        },
      },
    } as typeof CONFIG;
    const threadCalls: unknown[] = [];
    const native = {
      linkedDiscordIds: async (userId: string) => (userId === "owner" ? ["d-owner"] : []),
      threads: (userId: string, input: unknown) => {
        threadCalls.push({ userId, input });
        return Result.ok({
          items: [{ id: "t1", title: "Plan", updatedAt: 5_000, active: true }],
          nextCursor: "5000_t1",
        });
      },
      summaries: async () => Result.ok([]),
      query: () => Result.ok({ items: [] }),
    };
    const discordAdapter = {
      listSessions: async () =>
        Result.ok([
          {
            ref: { platform: "discord", channelId: "111" },
            title: "#dev",
            kind: "channel",
            updatedAt: 3_000,
          },
          {
            ref: { platform: "discord", channelId: "999" },
            title: "#secret",
            kind: "channel",
            updatedAt: 4_000,
          },
          {
            ref: { platform: "discord", channelId: "222" },
            title: "#ops",
            kind: "channel",
            updatedAt: 2_000,
          },
        ]),
    };
    const built = build({
      config,
      directory: { native: native as never, discordAdapter: () => discordAdapter as never },
    });

    const nativeThreads = await call(built, { action: "list", scope: "user", limit: 1 });
    expect(nativeThreads).toEqual({
      items: [
        {
          kind: "thread",
          id: "t1",
          client: "native",
          title: "Plan",
          updatedAt: new Date(5_000).toISOString(),
          active: true,
        },
      ],
      before: "5000_t1",
    });
    expect(threadCalls).toEqual([{ userId: "owner", input: { limit: 1 } }]);

    const discord = await call(built, {
      action: "list",
      scope: "user",
      client: "discord",
      limit: 1,
    });
    expect(discord.items.map((item: { id: string }) => item.id)).toEqual(["111"]);
    const rest = await call(built, {
      action: "list",
      scope: "user",
      client: "discord",
      before: discord.before,
    });
    expect(rest).toEqual({
      items: [expect.objectContaining({ id: "222", title: "#ops", client: "discord" })],
    });

    const unlinked = build({
      config,
      requestContext: primaryContext({ requestInitiator: { platform: "native", userId: "guest" } }),
      directory: { native: native as never, discordAdapter: () => discordAdapter as never },
    });
    await expect(
      call(unlinked, { action: "list", scope: "user", client: "discord" }),
    ).rejects.toThrow(/no linked discord account/u);
  });

  it("searches summaries before messages, one row per thread, across linked surfaces", async () => {
    const config = {
      ...CONFIG,
      surface: {
        ...CONFIG.surface,
        discord: { ...CONFIG.surface.discord, allowedChannelIds: ["111"], allowedGuildIds: [] },
      },
    } as typeof CONFIG;
    const native = {
      linkedDiscordIds: async () => ["d-owner"],
      threads: () => Result.ok({ items: [] }),
      summaries: async () =>
        Result.ok([{ threadId: "t1", title: "Auth refactor", brief: "Moved sessions to JWT" }]),
      query: () =>
        Result.ok({
          items: [
            { threadId: "t1", title: "Auth refactor", excerpt: "jwt", surface: "native" },
            { threadId: "t2", title: "Login bug", excerpt: "the jwt expired", surface: "native" },
          ],
        }),
    };
    const conversationThreads = {
      search: async () => ({
        meta: {},
        results: [
          {
            surface: "discord",
            threadId: "discord:channel:111:1",
            title: "Token talk",
            brief: "JWT rotation",
            session: { platform: "discord", channelId: "111" },
          },
          {
            surface: "discord",
            threadId: "discord:channel:999:1",
            title: "Hidden",
            brief: "JWT secrets",
            session: { platform: "discord", channelId: "999" },
          },
        ],
      }),
    };
    const discovery = {
      searchResult: async () =>
        Result.ok({
          meta: {},
          groups: [
            {
              key: "discord:111",
              source: "conversation",
              origin: { kind: "session", platform: "discord", sessionId: "111", label: "#dev" },
              entries: [[{ kind: "message", matched: true, text: "jwt again" }]],
            },
          ],
        }),
    };
    const built = build({
      config,
      directory: {
        native: native as never,
        conversationThreads: conversationThreads as never,
        discovery: discovery as never,
      },
    });

    const found = await call(built, { action: "search", query: "jwt", maxCharsPerItem: 10 });
    expect(found.items).toEqual([
      {
        id: "t1",
        client: "native",
        title: "Auth refactor",
        snippet: "Moved sess",
        snippetTruncated: true,
        matchedIn: "summary",
      },
      {
        id: "111",
        client: "discord",
        title: "Token talk",
        snippet: "JWT rotati",
        snippetTruncated: true,
        matchedIn: "summary",
      },
      {
        id: "t2",
        client: "native",
        title: "Login bug",
        snippet: "the jwt ex",
        snippetTruncated: true,
        matchedIn: "message",
      },
    ]);

    const nativeOnly = await call(built, { action: "search", query: "jwt", client: "native" });
    expect(nativeOnly.items.map((item: { id: string }) => item.id)).toEqual(["t1", "t2"]);

    await expect(call(built, { action: "search" })).rejects.toThrow(/search requires query/u);
    const unverified = build({ requestContext: primaryContext({ serverOwnedRequest: undefined }) });
    await expect(call(unverified, { action: "search", query: "jwt" })).rejects.toThrow(
      /no verified surface user/u,
    );
  });

  it("reads a Discord thread from native only through a linked account", async () => {
    const calls: unknown[] = [];
    const discordPort: SurfaceThreadControlPort = {
      read: async (caller, threadId) => {
        calls.push({ caller, threadId });
        return Result.ok({ threadId, title: "#dev", activeRunId: null, items: [], hasMore: false });
      },
      send: async () => Result.ok({ disposition: "posted", messageId: "m" }),
      interrupt: async () => Result.ok({ status: "idle" }),
    };
    const threadControl = {
      resolve: (platform: string) => (platform === "discord" ? discordPort : null),
    };
    const linked = build({
      threadControl,
      directory: { native: { linkedDiscordIds: async () => ["d-owner"] } as never },
    });
    expect(await call(linked, { action: "read", id: "111", client: "discord" })).toMatchObject({
      kind: "thread",
      threadId: "111",
    });
    expect(calls).toEqual([
      { caller: { userId: "d-owner", sourceThreadId: PARENT_SESSION }, threadId: "111" },
    ]);

    const unlinked = build({
      threadControl,
      directory: { native: { linkedDiscordIds: async () => [] } as never },
    });
    await expect(call(unlinked, { action: "read", id: "111", client: "discord" })).rejects.toThrow(
      /linked Discord account/u,
    );
    await expect(
      call(linked, { action: "read", id: "wfrun:anything", client: "discord" }),
    ).rejects.toThrow(/client applies/u);
  });
  it("lists subagents that a scripted workflow's agent step delegated from this conversation", async () => {
    const workflow = seedRun({ id: "flow", createdAt: 1_000 });
    const stepChild = seedRun({
      id: "step-child",
      subagent: {
        parentSessionId: `workflow:${workflow.runId}:agent`,
        parentRequestId: workflow.requestId,
      },
      createdAt: 2_000,
    });
    const listed = await call(build(), { action: "list" });
    expect(listed.items).toEqual([
      expect.objectContaining({ id: stepChild.runId, controllable: false, self: false }),
    ]);
  });

  it("pages every stored Discord session and checks a Discord link on each call", async () => {
    const config = {
      ...CONFIG,
      surface: {
        ...CONFIG.surface,
        discord: { ...CONFIG.surface.discord, allowedChannelIds: ["111"], allowedGuildIds: [] },
      },
    } as typeof CONFIG;
    const limits: (number | undefined)[] = [];
    let links: string[] = ["d-owner"];
    const built = build({
      config,
      directory: {
        native: { linkedDiscordIds: async () => links } as never,
        discordAdapter: () =>
          ({
            listSessions: async (opts?: { limit?: number }) => {
              limits.push(opts?.limit);
              return Result.ok([
                { ref: { platform: "discord", channelId: "111" }, kind: "channel" },
              ]);
            },
          }) as never,
      },
    });
    const listed = await call(built, { action: "list", scope: "user", client: "discord" });
    expect(listed.items.map((item: { id: string }) => item.id)).toEqual(["111"]);
    expect(limits).toEqual([Number.MAX_SAFE_INTEGER]);

    links = [];
    await expect(call(built, { action: "list", scope: "user", client: "discord" })).rejects.toThrow(
      /no linked discord account/u,
    );
  });

  it("asks each search source for all its candidates and keeps defects as defects", async () => {
    const requested: unknown[] = [];
    const native = {
      linkedDiscordIds: async () => [],
      threads: () => Result.ok({ items: [] }),
      summaries: async (_userId: string, input: { limit: number }) => {
        requested.push({ source: "summaries", limit: input.limit });
        return Result.ok([]);
      },
      query: (_userId: string, input: { limit: number }) => {
        requested.push({ source: "messages", limit: input.limit });
        return Result.ok({
          items: [
            { threadId: "t1", title: "One", excerpt: "a", surface: "native" },
            { threadId: "t1", title: "One", excerpt: "b", surface: "native" },
            { threadId: "t2", title: "Two", excerpt: "c", surface: "native" },
          ],
        });
      },
    };
    const found = await call(build({ directory: { native: native as never } }), {
      action: "search",
      query: "x",
      limit: 2,
    });
    expect(found.items.map((item: { id: string }) => item.id)).toEqual(["t1", "t2"]);
    expect(requested).toEqual([
      { source: "summaries", limit: 50 },
      { source: "messages", limit: 100 },
    ]);

    const panic = new Panic({ message: "summary index invariant" });
    const config = {
      ...CONFIG,
      surface: {
        ...CONFIG.surface,
        discord: { ...CONFIG.surface.discord, allowedChannelIds: ["111"], allowedGuildIds: [] },
      },
    } as typeof CONFIG;
    const broken = build({
      config,
      requestContext: primaryContext({ requestInitiator: { platform: "native", userId: "owner" } }),
      directory: {
        native: { ...native, linkedDiscordIds: async () => ["d-owner"] } as never,
        conversationThreads: {
          search: async () => {
            throw panic;
          },
        } as never,
      },
    });
    const [settled] = await Promise.allSettled([
      call(broken, { action: "search", query: "x", client: "discord" }),
    ]);
    expect(settled?.status === "rejected" && Panic.is(settled.reason)).toBe(true);
  });

  it("authorizes a subagent read on the run's own surface only", async () => {
    const child = seedRun({
      id: "discord-child",
      subagent: { parentSessionId: "channel-1" },
      origin: { client: "discord", sessionId: "channel-1", userId: "d-user" },
    });
    const nativePort: SurfaceThreadControlPort = {
      read: async (_caller, threadId) =>
        Result.ok({ threadId, title: "Same id", activeRunId: null, items: [], hasMore: false }),
      send: async () => Result.ok({ disposition: "posted", messageId: "m" }),
      interrupt: async () => Result.ok({ status: "idle" }),
    };
    const built = build({
      threadControl: { resolve: (platform) => (platform === "native" ? nativePort : null) },
      directory: { native: { linkedDiscordIds: async () => [] } as never },
    });
    await expect(call(built, { action: "read", id: child.runId })).rejects.toThrow(/cannot read/u);
  });
  it("lists unseen allowlisted Discord channels and follows allowlist changes mid-run", async () => {
    const withAllowlist = (ids: string[]) =>
      ({
        ...CONFIG,
        surface: {
          ...CONFIG.surface,
          discord: { ...CONFIG.surface.discord, allowedChannelIds: ids, allowedGuildIds: [] },
        },
      }) as typeof CONFIG;
    let current = withAllowlist(["111", "333", "333"]);
    const built = build({
      config: withAllowlist([]),
      directory: {
        getConfig: async () => current,
        discordAdapter: () =>
          ({
            listSessions: async () =>
              Result.ok([
                {
                  ref: { platform: "discord", channelId: "111" },
                  title: "#dev",
                  kind: "channel",
                  updatedAt: 5_000,
                },
              ]),
          }) as never,
      },
      requestContext: primaryContext({
        requestClient: "unknown",
        sessionId: "sub:discord:111:named:helper",
        requestInitiator: { platform: "discord", userId: "d-user" },
        requestInitiatorSessionId: "111",
        subagentDepth: 1,
        subagentProfile: "full",
        serverOwnedRequest: undefined,
      }),
      runProfile: "full",
    });
    const listed = await call(built, { action: "list", scope: "user" });
    expect(listed.items.map((item: { id: string }) => item.id)).toEqual(["111", "333"]);

    current = withAllowlist(["333"]);
    const after = await call(built, { action: "list", scope: "user" });
    expect(after.items.map((item: { id: string }) => item.id)).toEqual(["333"]);
  });
});
