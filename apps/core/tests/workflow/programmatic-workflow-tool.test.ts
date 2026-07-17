import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import type { RequestContext } from "../../src/tool-server/types";
import { ProgrammaticWorkflow } from "../../src/tool-server/tools/programmatic-workflow";

const invocationSchema = z.object({
  runId: z.string(),
  state: z.literal("queued"),
  revisionId: z.string(),
  sourceSha256: z.string(),
  inputSchemaSha256: z.string(),
  resourcePolicySha256: z.string(),
  argsSha256: z.string(),
});

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

  it("exposes no approval API and immediately queues authenticated trusted invocations", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-workflow-tool-"));
    const workspaceRoot = path.join(root, "workspace");
    const dataDir = path.join(root, "data");
    await fs.mkdir(workspaceRoot);
    const cards: string[] = [];
    const tool = new ProgrammaticWorkflow({
      dataDir,
      dbPath: path.join(root, "workflow.sqlite"),
      now: () => 100,
      progressCards: {
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
      authenticatedPrincipal: { platform: "discord" as const, userId: "user-1" },
      toolCallId: "tool-call-1",
    } satisfies RequestContext;
    await tool.init();
    try {
      expect((await tool.list()).map((entry) => entry.callableId)).not.toContain(
        "workflow.approval.revoke",
      );
      await tool.call(
        "workflow.definition.save",
        { scope: "project", name: "audit-routes", source: source() },
        { context },
      );
      const first = invocationSchema.parse(
        await tool.call(
          "workflow.run.trigger",
          { scope: "project", name: "audit-routes", args: { directory: "src" } },
          { context },
        ),
      );
      expect(first.state).toBe("queued");
      expect(cards).toEqual([first.runId]);
      const fetched = await tool.call("workflow.run.get", { runId: first.runId }, { context });
      expect(fetched).toMatchObject({ run: { runId: first.runId, state: "queued" } });
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
      authenticatedPrincipal: { platform: "discord" as const, userId: "user-1" },
    } satisfies RequestContext;
    await tool.init();
    try {
      for (const context of [
        { ...trusted, serverOwnedRequest: false },
        { ...trusted, safetyMode: "restricted" as const },
        { ...trusted, authenticatedPrincipal: undefined },
        { ...trusted, authenticatedPrincipal: undefined, operator: true },
      ]) {
        expect(await tool.call("workflow.run.list", {}, { context })).toMatchObject({ runs: [] });
      }
      await expect(
        tool.call("workflow.run.list", { limit: 0 }, { context: trusted }),
      ).rejects.toThrow();
    } finally {
      await tool.destroy();
    }
  });

  it("pins the trigger snapshot without using origin identity as an invocation gate", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-workflow-trigger-owner-"));
    const workspaceRoot = path.join(root, "workspace");
    await fs.mkdir(workspaceRoot);
    const tool = new ProgrammaticWorkflow({
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
      authenticatedPrincipal: { platform: "discord" as const, userId: "owner-1" },
      toolCallId: "trigger-call",
    } satisfies RequestContext;
    await tool.init();
    try {
      await tool.call(
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
          await tool.call(
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
        await tool.call(
          "workflow.trigger.get",
          { triggerId: created.trigger.triggerId },
          {
            context: {
              ...context,
              authenticatedPrincipal: { platform: "discord", userId: "other-user" },
            },
          },
        ),
      ).toMatchObject({ trigger: { triggerId: created.trigger.triggerId } });
    } finally {
      await tool.destroy();
    }
  });

  it("lets an ordinary workflow child admit runs up to the global cap and returns capacity as data", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-workflow-child-cap-"));
    const workspaceRoot = path.join(root, "workspace");
    await fs.mkdir(workspaceRoot);
    const tool = new ProgrammaticWorkflow({
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
      await tool.call(
        "workflow.definition.save",
        { scope: "project", name: "audit-routes", source: source() },
        { context: childContext },
      );
      const accepted = invocationSchema.parse(
        await tool.call(
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
      expect(rejected).toEqual({
        ok: false,
        error: {
          code: "workflow_capacity_exceeded",
          message:
            "Global workflow capacity is full (1/1 active runs). Wait for a workflow to finish or cancel one, then retry with the same idempotency key.",
          activeRuns: 1,
          limit: 1,
          retryable: true,
        },
      });
      expect(await tool.call("workflow.run.list", {}, { context: childContext })).toMatchObject({
        runs: [{ runId: accepted.runId }],
      });
    } finally {
      await tool.destroy();
    }
  });
});
