import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import { createToolServer } from "../../src/tool-server/create-tool-server";
import { ProgrammaticWorkflow } from "../../src/tool-server/tools/programmatic-workflow";
import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import { writeWorkflowValueArtifact } from "../../src/workflow/workflow-artifact-store";
import { WORKFLOW_MANUAL_RECONCILIATION_DETAIL } from "../../src/workflow/workflow-domain";
import { canonicalJsonSha256 } from "../../src/workflow/workflow-definition";
import { writeWorkflowWorktreePatchArtifact } from "../../src/workflow/workflow-worktree-artifact";

const invocationSchema = z.object({
  runId: z.string(),
  state: z.enum(["awaiting_review", "queued"]),
  approvalId: z.string(),
  revisionId: z.string(),
  sourceSha256: z.string(),
  inputSchemaSha256: z.string(),
  capabilitySha256: z.string(),
  argsSha256: z.string(),
});

function source() {
  return `import { defineWorkflow } from "@lilac/workflow";
export default defineWorkflow({
  name: "audit-routes",
  description: "Audit routes",
  input: { type: "object", required: ["directory"], properties: { directory: { type: "string" }, token: { type: "string", sensitive: true } } },
  capabilities: {
    agents: { profiles: ["explore"], models: ["inherit"], maxConcurrent: 1, maxTotal: 2, editing: [] },
    waits: [],
  },
  async run({ args, agent }) { return agent(\`Audit \${args.directory}\`); },
});
`;
}

describe("ProgrammaticWorkflow Level-2 tool", () => {
  let root: string | null = null;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = null;
  });

  it("registers definition/run callables and persists waiting then approved queued runs without execution", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-workflow-tool-"));
    const workspaceRoot = path.join(root, "workspace");
    const dataDir = path.join(root, "data");
    const dbPath = path.join(root, "workflow.sqlite");
    await fs.mkdir(workspaceRoot);
    const ensuredCards: string[] = [];
    let reviewerAvailable = true;
    const tool = new ProgrammaticWorkflow({
      dataDir,
      dbPath,
      now: () => 100,
      reviewerResolver: {
        resolve: async () =>
          reviewerAvailable
            ? {
                platform: "discord",
                userId: "user-1",
                sessionRef: { platform: "discord", channelId: "channel-1" },
                originMessageRef: {
                  platform: "discord",
                  channelId: "channel-1",
                  messageId: "message-1",
                },
              }
            : null,
      },
      progressCards: {
        ensureInitialCard: async (runId) => {
          if (!ensuredCards.includes(runId)) ensuredCards.push(runId);
          return { platform: "discord", channelId: "channel-1", messageId: `card-${runId}` };
        },
        requestProjection: () => {},
      },
    });
    await tool.init();
    try {
      const listed = await tool.list();
      expect(listed.map((entry) => entry.callableId)).toEqual([
        "workflow.definition.save",
        "workflow.definition.validate",
        "workflow.definition.get",
        "workflow.definition.list",
        "workflow.run.trigger",
        "workflow.trigger.create",
        "workflow.trigger.get",
        "workflow.trigger.list",
        "workflow.trigger.cancel",
        "workflow.run.get",
        "workflow.run.list",
        "workflow.run.cancel",
        "workflow.run.pause",
        "workflow.run.resume",
        "workflow.approval.revoke",
      ]);

      const context = {
        requestId: "request-1",
        sessionId: "channel-1",
        requestClient: "discord",
        cwd: workspaceRoot,
        projectRoot: workspaceRoot,
        safetyMode: "trusted" as const,
        serverOwnedRequest: true,
        authenticatedPrincipal: { platform: "discord" as const, userId: "user-1" },
        toolCallId: "tool-call-1",
      };
      await expect(
        tool.call(
          "workflow.definition.list",
          {},
          { context: { ...context, projectRoot: undefined } },
        ),
      ).rejects.toThrow("lacks server-resolved project root authority");
      expect(
        await tool.call(
          "workflow.definition.list",
          {},
          { context: { ...context, projectRoot: `${workspaceRoot}${path.sep}` } },
        ),
      ).toMatchObject({ definitions: [] });
      const symlinkRoot = path.join(root, "workspace-symlink");
      await fs.symlink(workspaceRoot, symlinkRoot);
      await expect(
        tool.call(
          "workflow.definition.list",
          {},
          { context: { ...context, projectRoot: symlinkRoot } },
        ),
      ).rejects.toThrow("must be a real directory");
      await tool.call(
        "workflow.definition.save",
        {
          scope: "project",
          name: "audit-routes",
          source: source(),
        },
        { context },
      );
      const first = invocationSchema.parse(
        await tool.call(
          "workflow.run.trigger",
          {
            scope: "auto",
            name: "audit-routes",
            args: { directory: "src" },
            progress: { requestOrigin: true },
          },
          { context },
        ),
      );
      expect(first.state).toBe("awaiting_review");
      expect(ensuredCards).toEqual([first.runId]);
      const retried = invocationSchema.parse(
        await tool.call(
          "workflow.run.trigger",
          {
            scope: "auto",
            name: "audit-routes",
            args: { directory: "src" },
            progress: { requestOrigin: true },
          },
          { context },
        ),
      );
      expect(retried.runId).toBe(first.runId);
      expect(
        await tool.call(
          "workflow.run.get",
          { runId: first.runId, includeSource: true },
          { context },
        ),
      ).toMatchObject({ source: source() });
      const otherPrincipalContext = {
        ...context,
        requestId: "request-other",
        authenticatedPrincipal: { platform: "discord" as const, userId: "user-other" },
        toolCallId: "tool-call-other",
      };
      await expect(
        tool.call("workflow.run.get", { runId: first.runId }, { context: otherPrincipalContext }),
      ).rejects.toThrow("principal scope");
      expect(
        await tool.call("workflow.run.list", {}, { context: otherPrincipalContext }),
      ).toMatchObject({ runs: [] });
      const operatorContext = {
        cwd: workspaceRoot,
        projectRoot: workspaceRoot,
        safetyMode: "trusted" as const,
        serverOwnedRequest: true,
        operator: true,
      };
      await expect(
        tool.call(
          "workflow.run.get",
          { runId: first.runId },
          { context: { ...operatorContext, projectRoot: undefined } },
        ),
      ).rejects.toThrow("lacks server-resolved project root authority");
      expect(
        await tool.call("workflow.run.get", { runId: first.runId }, { context: operatorContext }),
      ).toMatchObject({ run: { runId: first.runId } });
      expect(await tool.call("workflow.run.list", {}, { context: operatorContext })).toMatchObject({
        runs: [{ runId: first.runId }],
      });
      expect(
        new Set([
          first.sourceSha256,
          first.inputSchemaSha256,
          first.capabilitySha256,
          first.argsSha256,
        ]).size,
      ).toBe(4);

      const inspector = new DurableWorkflowStore(dbPath);
      try {
        expect(inspector.getRun(first.runId)).toMatchObject({
          state: "awaiting_review",
          args: { directory: "src" },
          inputSchemaSnapshot: { type: "object" },
          progressTarget: { platform: "discord", channelId: "channel-1" },
        });
        expect(
          inspector.transitionApproval({
            approvalId: first.approvalId,
            from: "pending",
            to: "approved",
            now: 101,
          }),
        ).toBe(true);
      } finally {
        inspector.close();
      }

      context.toolCallId = "tool-call-2";
      const second = invocationSchema.parse(
        await tool.call(
          "workflow.run.trigger",
          { scope: "auto", name: "audit-routes", args: { directory: "tests" } },
          { context },
        ),
      );
      expect(second.state).toBe("queued");
      expect(second.approvalId).toBe(first.approvalId);
      expect(second.revisionId).toBe(first.revisionId);
      expect(second.argsSha256).not.toBe(first.argsSha256);
      expect(ensuredCards).toEqual([first.runId, second.runId]);

      const manualStore = new DurableWorkflowStore(dbPath);
      try {
        expect(
          manualStore.transitionRun({
            runId: second.runId,
            from: "queued",
            to: "paused",
            now: 102,
            detail: WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
          }),
        ).toBe(true);
      } finally {
        manualStore.close();
      }
      await expect(
        tool.call("workflow.run.resume", { runId: second.runId }, { context }),
      ).rejects.toThrow(WORKFLOW_MANUAL_RECONCILIATION_DETAIL);
      const manualVerifier = new DurableWorkflowStore(dbPath);
      expect(manualVerifier.getRun(second.runId)?.state).toBe("paused");
      manualVerifier.close();

      const largeResult = "r".repeat(70_000);
      const resultArtifactId = await writeWorkflowValueArtifact({
        dataDir,
        value: largeResult,
        maxBytes: 1024 * 1024,
      });
      const resultStore = new DurableWorkflowStore(dbPath);
      try {
        const claimed = resultStore.tryClaimApprovedRun({
          runId: first.runId,
          claimerId: "engine-public-patch",
          now: 102,
        });
        expect(claimed).not.toBeNull();
        expect(
          resultStore.createOperation(
            {
              runId: first.runId,
              operationId: "operation-public-patch",
              callSiteId: "public-patch",
              parentOperationId: null,
              phase: null,
              label: "isolated edit",
              kind: "agent",
              input: {},
              inputSha256: canonicalJsonSha256({}),
              state: "queued",
              attempt: 0,
              requestId: null,
              output: null,
              resultArtifactId: null,
              error: null,
              usage: null,
              claimedBy: null,
              claimedAt: null,
              createdAt: 102,
              startedAt: null,
              updatedAt: 102,
              terminalAt: null,
            },
            "engine-public-patch",
          ),
        ).toBe(true);
        expect(
          resultStore.recordWorktreePrepared({
            runId: first.runId,
            operationId: "operation-public-patch",
            runOwnerId: "engine-public-patch",
            worktreePath: "/private/worktree/path",
            baseCommit: "a".repeat(40),
            now: 102,
          }),
        ).toMatchObject({ state: "prepared" });
        expect(
          resultStore.transitionOperation({
            runId: first.runId,
            operationId: "operation-public-patch",
            runOwnerId: "engine-public-patch",
            from: "queued",
            to: "dispatched",
            now: 102,
          }),
        ).toBe(true);
        const patch = new TextEncoder().encode(
          "diff --git a/a.txt b/a.txt\n+public patch content\n",
        );
        const patchArtifact = await writeWorkflowWorktreePatchArtifact({ dataDir, patch });
        expect(
          resultStore.recordWorktreeCaptured({
            runId: first.runId,
            operationId: "operation-public-patch",
            runOwnerId: "engine-public-patch",
            ...patchArtifact,
            now: 102,
          }),
        ).toMatchObject({ state: "captured", artifactId: patchArtifact.artifactId });
        expect(
          resultStore.transitionOperation({
            runId: first.runId,
            operationId: "operation-public-patch",
            runOwnerId: "engine-public-patch",
            from: "dispatched",
            to: "running",
            now: 102,
          }),
        ).toBe(true);
        expect(
          resultStore.transitionOperation({
            runId: first.runId,
            operationId: "operation-public-patch",
            runOwnerId: "engine-public-patch",
            from: "running",
            to: "succeeded",
            output: "edited",
            now: 102,
          }),
        ).toBe(true);
        expect(
          resultStore.transitionRun({
            runId: first.runId,
            from: "running",
            to: "succeeded",
            now: 103,
            result: null,
            resultArtifactId,
          }),
        ).toBe(true);
      } finally {
        resultStore.close();
      }
      expect(
        await tool.call(
          "workflow.run.get",
          {
            runId: first.runId,
            includeResultArtifact: true,
            includeSensitiveResult: true,
          },
          { context },
        ),
      ).toMatchObject({ resultArtifact: largeResult });
      const rawPatchMetadata = await tool.call(
        "workflow.run.get",
        { runId: first.runId },
        { context },
      );
      expect(JSON.stringify(rawPatchMetadata)).not.toContain("/private/worktree/path");
      expect(JSON.stringify(rawPatchMetadata)).not.toContain("cleanupError");
      const patchMetadata = z
        .object({
          worktreeOutputs: z.array(
            z.object({
              artifactId: z.string(),
              state: z.string(),
              bytes: z.number(),
            }),
          ),
          worktreeOutputPage: z.object({
            offset: z.number(),
            limit: z.number(),
            total: z.number(),
          }),
        })
        .parse(rawPatchMetadata);
      expect(patchMetadata.worktreeOutputs).toMatchObject([
        { state: "captured", bytes: expect.any(Number) },
      ]);
      expect(patchMetadata.worktreeOutputPage).toEqual({ offset: 0, limit: 100, total: 1 });
      const patchArtifactId = patchMetadata.worktreeOutputs[0]?.artifactId;
      if (!patchArtifactId) throw new Error("Missing public patch artifact ID");
      await expect(
        tool.call(
          "workflow.run.get",
          { runId: first.runId, worktreePatchArtifactId: patchArtifactId },
          { context },
        ),
      ).rejects.toThrow("includeSensitiveResult=true");
      const patchChunk = z
        .object({
          worktreePatch: z.object({
            artifactId: z.string(),
            encoding: z.literal("base64"),
            offset: z.number(),
            nextOffset: z.number().nullable(),
            totalBytes: z.number(),
            content: z.string(),
          }),
        })
        .parse(
          await tool.call(
            "workflow.run.get",
            {
              runId: first.runId,
              includeSensitiveResult: true,
              worktreePatchArtifactId: patchArtifactId,
              worktreePatchBytes: 8,
            },
            { context },
          ),
        );
      expect(Buffer.from(patchChunk.worktreePatch.content, "base64").byteLength).toBe(8);
      expect(Buffer.from(patchChunk.worktreePatch.content, "base64").toString("utf8")).toBe(
        "diff --g",
      );
      expect(patchChunk.worktreePatch.nextOffset).toBe(8);
      await expect(
        tool.call(
          "workflow.run.get",
          {
            runId: first.runId,
            includeSensitiveResult: true,
            worktreePatchArtifactId: patchArtifactId,
          },
          { context: otherPrincipalContext },
        ),
      ).rejects.toThrow("principal scope");

      const scheduledResult = await tool.call(
        "workflow.trigger.create",
        {
          scope: "auto",
          name: "audit-routes",
          args: { directory: "scheduled", token: "scheduled-secret" },
          schedule: { kind: "timestamp", at: "1970-01-01T00:00:01.000Z" },
          idempotencyKey: "scheduled-once",
        },
        { context },
      );
      expect(
        z.object({ trigger: z.record(z.string(), z.unknown()) }).parse(scheduledResult).trigger[
          "argsSha256"
        ],
      ).toBeUndefined();
      const scheduled = z
        .object({
          trigger: z.object({
            triggerId: z.string(),
            nextFireAt: z.number(),
            revisionId: z.string(),
          }),
        })
        .parse(scheduledResult);
      expect(scheduled.trigger).toMatchObject({
        nextFireAt: 1_000,
        revisionId: first.revisionId,
      });
      const triggerGet = await tool.call(
        "workflow.trigger.get",
        { triggerId: scheduled.trigger.triggerId },
        { context },
      );
      expect(triggerGet).toMatchObject({
        trigger: { state: "active", args: { token: "<redacted>" } },
        lastRun: null,
      });
      expect(
        z.object({ trigger: z.record(z.string(), z.unknown()) }).parse(triggerGet).trigger[
          "argsSha256"
        ],
      ).toBeUndefined();
      const triggerList = await tool.call("workflow.trigger.list", {}, { context });
      expect(triggerList).toMatchObject({
        triggers: [{ trigger: { triggerId: scheduled.trigger.triggerId } }],
      });
      expect(
        z
          .object({ triggers: z.array(z.object({ trigger: z.record(z.string(), z.unknown()) })) })
          .parse(triggerList).triggers[0]?.trigger["argsSha256"],
      ).toBeUndefined();
      const duplicate = await tool.call(
        "workflow.trigger.create",
        {
          scope: "auto",
          name: "audit-routes",
          args: { directory: "scheduled", token: "scheduled-secret" },
          schedule: { kind: "timestamp", at: "1970-01-01T00:00:01.000Z" },
          idempotencyKey: "scheduled-once",
        },
        { context },
      );
      expect(duplicate).toMatchObject({
        created: false,
        trigger: { triggerId: scheduled.trigger.triggerId },
      });
      await expect(
        tool.call(
          "workflow.trigger.create",
          {
            scope: "auto",
            name: "audit-routes",
            args: { directory: "different" },
            schedule: { kind: "timestamp", at: "1970-01-01T00:00:01.000Z" },
            idempotencyKey: "scheduled-once",
          },
          { context },
        ),
      ).rejects.toThrow("idempotency key was reused");
      const otherTriggerPrincipalContext = {
        ...context,
        authenticatedPrincipal: { platform: "discord" as const, userId: "user-other" },
      };
      await expect(
        tool.call(
          "workflow.trigger.get",
          { triggerId: scheduled.trigger.triggerId },
          { context: otherTriggerPrincipalContext },
        ),
      ).rejects.toThrow("principal scope");
      const cancelledTrigger = await tool.call(
        "workflow.trigger.cancel",
        { triggerId: scheduled.trigger.triggerId },
        { context },
      );
      expect(cancelledTrigger).toMatchObject({
        changed: true,
        trigger: { state: "cancelled", args: { token: "<redacted>" } },
      });
      expect(
        z.object({ trigger: z.record(z.string(), z.unknown()) }).parse(cancelledTrigger).trigger[
          "argsSha256"
        ],
      ).toBeUndefined();

      reviewerAvailable = false;
      context.toolCallId = "tool-call-3";
      const unauthenticated = await tool.call(
        "workflow.run.trigger",
        { scope: "auto", name: "audit-routes", args: { directory: "docs" } },
        { context },
      );
      expect(unauthenticated).toMatchObject({
        state: "queued",
        reviewerAvailable: true,
        progressCard: expect.any(Object),
        message: expect.stringContaining("already approved"),
      });

      const cancelled = await tool.call(
        "workflow.run.cancel",
        { runId: second.runId },
        { context },
      );
      expect(cancelled).toMatchObject({ ok: true, changed: true, run: { state: "cancelled" } });
      const cancelledRun = z
        .object({ run: z.record(z.string(), z.unknown()) })
        .parse(cancelled).run;
      expect(cancelledRun["argsSha256"]).toBeUndefined();
    } finally {
      await tool.destroy();
    }
  });

  it("scopes limited durable pages and personal approvals by trusted project and principal", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-workflow-scoping-"));
    const projectA = path.join(root, "plain-project-a");
    const projectB = path.join(root, "plain-project-b");
    const dataDir = path.join(root, "data");
    const dbPath = path.join(root, "workflow.sqlite");
    await fs.mkdir(projectA);
    await fs.mkdir(projectB);

    let now = 100;
    const store = new DurableWorkflowStore(dbPath);
    const progressCards = {
      ensureInitialCard: async (runId: string) => ({
        platform: "discord" as const,
        channelId: "channel-1",
        messageId: `card-${runId}`,
      }),
      requestProjection: () => {},
    };
    const tool = new ProgrammaticWorkflow({
      dataDir,
      store,
      now: () => now++,
      progressCards,
    });
    await tool.init();

    const context = (projectRoot: string, userId: string, toolCallId: string) => ({
      requestId: `request-${toolCallId}`,
      sessionId: "channel-1",
      requestClient: "discord",
      cwd: path.join(root!, "shell", "nested"),
      projectRoot,
      safetyMode: "trusted" as const,
      serverOwnedRequest: true,
      authenticatedPrincipal: { platform: "discord" as const, userId },
      toolCallId,
    });

    try {
      const projectAUser = context(projectA, "user-1", "a-save");
      await tool.call(
        "workflow.definition.save",
        { scope: "personal", name: "audit-routes", source: source() },
        { context: projectAUser },
      );

      projectAUser.toolCallId = "a-run";
      const projectARun = invocationSchema.parse(
        await tool.call(
          "workflow.run.trigger",
          { scope: "personal", name: "audit-routes", args: { directory: "project-a" } },
          { context: projectAUser },
        ),
      );
      expect(
        store.transitionApproval({
          approvalId: projectARun.approvalId,
          from: "pending",
          to: "approved",
          now: now++,
        }),
      ).toBe(true);

      const projectAOtherUser = context(projectA, "user-2", "a-other-run");
      await tool.call(
        "workflow.run.trigger",
        { scope: "personal", name: "audit-routes", args: { directory: "other-user" } },
        { context: projectAOtherUser },
      );

      const projectBUser = context(projectB, "user-1", "b-run");
      const projectBRun = invocationSchema.parse(
        await tool.call(
          "workflow.run.trigger",
          { scope: "personal", name: "audit-routes", args: { directory: "project-b" } },
          { context: projectBUser },
        ),
      );
      expect(projectBRun.state).toBe("awaiting_review");
      expect(projectBRun.revisionId).not.toBe(projectARun.revisionId);
      expect(projectBRun.approvalId).not.toBe(projectARun.approvalId);

      expect(
        await tool.call("workflow.run.list", { limit: 1 }, { context: projectAUser }),
      ).toMatchObject({ runs: [{ runId: projectARun.runId }] });

      projectAUser.toolCallId = "a-trigger";
      const projectATrigger = await tool.call(
        "workflow.trigger.create",
        {
          scope: "personal",
          name: "audit-routes",
          args: { directory: "project-a" },
          schedule: { kind: "timestamp", at: 3000 },
        },
        { context: projectAUser },
      );
      projectAOtherUser.toolCallId = "a-other-trigger";
      await tool.call(
        "workflow.trigger.create",
        {
          scope: "personal",
          name: "audit-routes",
          args: { directory: "other-user" },
          schedule: { kind: "timestamp", at: 1000 },
        },
        { context: projectAOtherUser },
      );
      projectBUser.toolCallId = "b-trigger";
      await tool.call(
        "workflow.trigger.create",
        {
          scope: "personal",
          name: "audit-routes",
          args: { directory: "project-b" },
          schedule: { kind: "timestamp", at: 500 },
        },
        { context: projectBUser },
      );
      const projectATriggerId = z
        .object({ trigger: z.object({ triggerId: z.string() }) })
        .parse(projectATrigger).trigger.triggerId;
      expect(
        await tool.call("workflow.trigger.list", { limit: 1 }, { context: projectAUser }),
      ).toMatchObject({ triggers: [{ trigger: { triggerId: projectATriggerId } }] });
    } finally {
      await tool.destroy();
      store.close();
    }
  });

  it("selects unrelated workflow roots from authenticated Level-1 shell cwd per HTTP invocation", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-workflow-server-"));
    const shellRoot = path.join(root, "default-workspace");
    const projectA = path.join(root, "project-a");
    const projectB = path.join(root, "project-b-outside-default-workspace");
    await Promise.all([fs.mkdir(shellRoot), fs.mkdir(projectA), fs.mkdir(projectB)]);
    const tool = new ProgrammaticWorkflow({
      dataDir: path.join(root, "data"),
      dbPath: path.join(root, "workflow.sqlite"),
    });
    const capabilities = new Map([
      ["capability-a", "request-a"],
      ["capability-b", "request-b"],
    ]);
    const server = createToolServer({
      tools: [tool],
      canonicalWorkspaceRoot: shellRoot,
      requestMessageCache: {
        get: (requestId) => (requestId.startsWith("request-") ? [] : undefined),
        getOrigin: (requestId) =>
          requestId.startsWith("request-")
            ? { sessionId: "channel-1", platform: "discord", actorUserId: "user-1" }
            : undefined,
      },
      authorizeControlRequest: ({ requestId, sessionId, platform, token }) =>
        capabilities.get(token) === requestId && sessionId === "channel-1" && platform === "discord"
          ? {
              kind: "primary" as const,
              principal: { platform: "discord" as const, userId: "user-1" },
              allowedCallables: null,
              canonicalCwd: shellRoot,
              safetyMode: "trusted" as const,
            }
          : null,
    });
    await server.init();
    const headers = (requestId: string, token: string, selectedRoot: string) => ({
      "content-type": "application/json",
      "x-lilac-request-id": requestId,
      "x-lilac-session-id": "channel-1",
      "x-lilac-request-client": "discord",
      "x-lilac-cwd": selectedRoot,
      "x-lilac-control-capability": token,
    });
    const call = async (
      requestId: string,
      token: string,
      selectedRoot: string,
      callableId: string,
      input: Record<string, unknown>,
    ) =>
      await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: headers(requestId, token, selectedRoot),
          body: JSON.stringify({ callableId, input }),
        }),
      );
    try {
      const unauthenticatedHelp = await server.app.handle(
        new Request("http://localhost/help/workflow.run.trigger"),
      );
      expect(unauthenticatedHelp.status).toBe(500);
      const help = await server.app.handle(
        new Request("http://localhost/help/workflow.run.trigger", {
          headers: headers("request-a", "capability-a", projectA),
        }),
      );
      expect(help.status).toBe(200);
      expect(await help.json()).toMatchObject({
        callableId: "workflow.run.trigger",
        description: expect.stringContaining("automatic durable execution"),
      });

      const savedA = await call("request-a", "capability-a", projectA, "workflow.definition.save", {
        scope: "project",
        name: "audit-routes",
        source: source(),
      });
      const savedB = await call("request-b", "capability-b", projectB, "workflow.definition.save", {
        scope: "project",
        name: "audit-routes",
        source: source(),
      });
      expect(await savedA.json()).toMatchObject({ isError: false, output: { ok: true } });
      expect(await savedB.json()).toMatchObject({ isError: false, output: { ok: true } });
      expect(
        await fs.readFile(path.join(projectA, ".lilac", "workflows", "audit-routes.js"), "utf8"),
      ).toBe(source());
      expect(
        await fs.readFile(path.join(projectB, ".lilac", "workflows", "audit-routes.js"), "utf8"),
      ).toBe(source());
      expect(path.relative(shellRoot, projectB).startsWith(".." + path.sep)).toBe(true);

      const listA = await call("request-a", "capability-a", projectA, "workflow.definition.list", {
        scope: "project",
      });
      const listB = await call("request-b", "capability-b", projectB, "workflow.definition.list", {
        scope: "project",
      });
      expect(await listA.json()).toMatchObject({
        output: {
          definitions: [{ path: path.join(projectA, ".lilac/workflows/audit-routes.js") }],
        },
      });
      expect(await listB.json()).toMatchObject({
        output: {
          definitions: [{ path: path.join(projectB, ".lilac/workflows/audit-routes.js") }],
        },
      });

      const forged = await call(
        "request-a",
        "forged-capability",
        projectB,
        "workflow.definition.list",
        { scope: "project" },
      );
      expect(forged.status).toBe(500);
      const missingCapability = await server.app.handle(
        new Request("http://localhost/list", {
          headers: {
            "x-lilac-request-id": "request-a",
            "x-lilac-session-id": "channel-1",
            "x-lilac-request-client": "discord",
            "x-lilac-cwd": projectB,
          },
        }),
      );
      expect(missingCapability.status).toBe(500);
    } finally {
      await server.stop();
    }
  });
});
