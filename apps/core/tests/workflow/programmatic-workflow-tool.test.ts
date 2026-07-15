import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import { createToolServer } from "../../src/tool-server/create-tool-server";
import { ProgrammaticWorkflow } from "../../src/tool-server/tools/programmatic-workflow";
import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import { writeWorkflowValueArtifact } from "../../src/workflow/workflow-artifact-store";

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
  input: { type: "object", required: ["directory"], properties: { directory: { type: "string" } } },
  capabilities: {
    agents: { profiles: ["explore"], models: ["inherit"], maxConcurrent: 1, maxTotal: 2, editing: false, isolation: "shared" },
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
      workspaceRoot,
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
        safetyMode: "trusted" as const,
        serverOwnedRequest: true,
        authenticatedPrincipal: { platform: "discord" as const, userId: "user-1" },
        toolCallId: "tool-call-1",
      };
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

      const largeResult = "r".repeat(70_000);
      const resultArtifactId = await writeWorkflowValueArtifact({
        dataDir,
        value: largeResult,
        maxBytes: 1024 * 1024,
      });
      const resultStore = new DurableWorkflowStore(dbPath);
      try {
        expect(
          resultStore.transitionRun({
            runId: first.runId,
            from: "queued",
            to: "running",
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

      const scheduled = z
        .object({
          trigger: z.object({
            triggerId: z.string(),
            nextFireAt: z.number(),
            revisionId: z.string(),
          }),
        })
        .parse(
          await tool.call(
            "workflow.trigger.create",
            {
              scope: "auto",
              name: "audit-routes",
              args: { directory: "scheduled" },
              schedule: { kind: "timestamp", at: "1970-01-01T00:00:01.000Z" },
            },
            { context },
          ),
        );
      expect(scheduled.trigger).toMatchObject({
        nextFireAt: 1_000,
        revisionId: first.revisionId,
      });
      expect(
        await tool.call(
          "workflow.trigger.get",
          { triggerId: scheduled.trigger.triggerId },
          { context },
        ),
      ).toMatchObject({ trigger: { state: "active" }, lastRun: null });
      expect(await tool.call("workflow.trigger.list", {}, { context })).toMatchObject({
        triggers: [{ trigger: { triggerId: scheduled.trigger.triggerId } }],
      });
      expect(
        await tool.call(
          "workflow.trigger.cancel",
          { triggerId: scheduled.trigger.triggerId },
          { context },
        ),
      ).toMatchObject({ changed: true, trigger: { state: "cancelled" } });

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
    } finally {
      await tool.destroy();
    }
  });

  it("serves JSON help/calls and keeps every workflow callable unavailable in restricted mode", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-workflow-server-"));
    const workspaceRoot = path.join(root, "workspace");
    await fs.mkdir(workspaceRoot);
    const tool = new ProgrammaticWorkflow({
      workspaceRoot,
      dataDir: path.join(root, "data"),
      dbPath: path.join(root, "workflow.sqlite"),
    });
    const server = createToolServer({
      tools: [tool],
      requestMessageCache: {
        get: (requestId) =>
          requestId === "request-1" ? [{ role: "user", content: "workflow" }] : undefined,
        getOrigin: (requestId) =>
          requestId === "request-1"
            ? { sessionId: "channel-1", platform: "discord", actorUserId: "user-1" }
            : undefined,
      },
    });
    await server.init();
    try {
      const unauthenticatedHelp = await server.app.handle(
        new Request("http://localhost/help/workflow.run.trigger"),
      );
      expect(unauthenticatedHelp.status).toBe(404);
      const help = await server.app.handle(
        new Request("http://localhost/help/workflow.run.trigger", {
          headers: {
            "x-lilac-request-id": "request-1",
            "x-lilac-session-id": "channel-1",
            "x-lilac-request-client": "discord",
          },
        }),
      );
      expect(help.status).toBe(200);
      expect(await help.json()).toMatchObject({
        callableId: "workflow.run.trigger",
        description: expect.stringContaining("automatic durable execution"),
      });

      const restricted = await server.app.handle(
        new Request("http://localhost/list", {
          headers: {
            "x-lilac-safety-mode": "restricted",
            "x-lilac-request-id": "request-1",
            "x-lilac-session-id": "channel-1",
            "x-lilac-request-client": "discord",
          },
        }),
      );
      expect(await restricted.json()).toEqual({ tools: [] });

      const denied = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-lilac-safety-mode": "restricted",
            "x-lilac-request-id": "request-1",
            "x-lilac-session-id": "channel-1",
            "x-lilac-request-client": "discord",
          },
          body: JSON.stringify({
            callableId: "workflow.definition.list",
            input: { scope: "auto" },
          }),
        }),
      );
      expect(await denied.json()).toMatchObject({
        isError: true,
        output: expect.stringContaining("not allowed"),
      });

      const forged = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-lilac-request-id": "forged",
            "x-lilac-session-id": "channel-1",
            "x-lilac-request-client": "discord",
            "x-lilac-cwd": workspaceRoot,
          },
          body: JSON.stringify({
            callableId: "workflow.definition.list",
            input: { scope: "auto" },
          }),
        }),
      );
      expect(await forged.json()).toMatchObject({
        isError: true,
        output: expect.stringContaining("server-owned active request context"),
      });
    } finally {
      await server.stop();
    }
  });
});
