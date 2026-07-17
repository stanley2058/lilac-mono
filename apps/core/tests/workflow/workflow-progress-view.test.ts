import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import { canonicalJsonSha256 } from "../../src/workflow/workflow-definition";
import {
  normalizeWorkflowResourcePolicy,
  type WorkflowOperation,
  type WorkflowRevision,
  type WorkflowRun,
} from "../../src/workflow/workflow-domain";
import {
  buildWorkflowProgressView,
  renderWorkflowProgressView,
  type WorkflowProgressView,
} from "../../src/workflow/workflow-progress-view";

const SOURCE_HASH = "a".repeat(64);
const SCHEMA_HASH = "b".repeat(64);
const RESOURCE_HASH = "c".repeat(64);

function revision(): WorkflowRevision {
  return {
    revisionId: "revision-internal",
    canonicalProjectId: "project-internal",
    canonicalWorkspaceRoot: "/internal/workspace",
    scope: "project",
    normalizedPath: "workflows/audit-routes.js",
    sourceSha256: SOURCE_HASH,
    inputSchemaSha256: SCHEMA_HASH,
    resourcePolicySha256: RESOURCE_HASH,
    runtimeVersion: "lilac-workflow-js-v3",
    name: "audit-routes",
    snapshotArtifactId: `workflow-source:${SOURCE_HASH}`,
    metadata: {
      name: "audit-routes",
      description: "Audit routes for missing authentication coverage.",
    },
    inputSchema: { type: "object", additionalProperties: false },
    resources: normalizeWorkflowResourcePolicy({
      agents: { maxConcurrent: 2, maxTotal: 8 },
      maxNestingDepth: 4,
      maxWallTimeMs: 60_000,
      operationIdleTimeoutMs: 10_000,
      waits: ["reply", "sleep"],
    }),
    limits: {
      maxSourceBytes: 100_000,
      maxInputBytes: 10_000,
      maxOperationOutputBytes: 10_000,
      maxResultBytes: 100_000,
    },
    createdAt: 1_000,
  };
}

function run(): WorkflowRun {
  return {
    runId: "run-internal",
    revisionId: "revision-internal",
    state: "running",
    inputSchemaSnapshot: { type: "object", additionalProperties: false },
    args: { target: "src" },
    argsSha256: "d".repeat(64),
    origin: {
      requestId: "request-internal",
      sessionId: "channel-internal",
      client: "discord",
      userId: "user-internal",
      projectCwd: "/internal/workspace",
    },
    completionTarget: { kind: "durable_surface" },
    progressTarget: { platform: "discord", channelId: "channel-internal", replyToMessageId: null },
    terminalDetail: null,
    result: null,
    resultArtifactId: null,
    claimedBy: "engine",
    claimedAt: 2_000,
    createdAt: 1_000,
    startedAt: 2_000,
    updatedAt: 3_000,
    terminalAt: null,
  };
}

function view(overrides: Partial<WorkflowProgressView> = {}): WorkflowProgressView {
  return {
    run: run(),
    revision: revision(),
    elapsedMs: 84_000,
    progress: {
      completed: 3,
      queued: 0,
      active: 1,
      waiting: 0,
      failed: 0,
      cancelled: 0,
      total: 7,
    },
    phases: [
      {
        name: "Discovery",
        completed: 2,
        queued: 0,
        active: 1,
        waiting: 0,
        failed: 0,
        cancelled: 0,
        total: 3,
      },
      {
        name: "Review",
        completed: 1,
        queued: 0,
        active: 0,
        waiting: 0,
        failed: 0,
        cancelled: 0,
        total: 4,
      },
    ],
    recentOperations: [
      {
        label: "Inspect authentication routes",
        phase: "Discovery",
        kind: "agent",
        state: "running",
      },
      { label: "Collect route inventory", phase: "Discovery", kind: "agent", state: "succeeded" },
    ],
    waits: [],
    agents: { used: 4, active: 1, queued: 0 },
    nextTriggerAt: null,
    availableActions: ["pause", "cancel"],
    manualReconciliationRequired: false,
    sensitive: false,
    ...overrides,
  };
}

function operation(input: {
  id: string;
  kind: WorkflowOperation["kind"];
  state: WorkflowOperation["state"];
  phase?: string;
  label?: string;
  createdAt: number;
}): WorkflowOperation {
  return {
    runId: "run-internal",
    operationId: input.id,
    callSiteId: `site-${input.id}`,
    parentOperationId: null,
    phase: input.phase ?? null,
    label: input.label ?? null,
    kind: input.kind,
    input: {},
    inputSha256: canonicalJsonSha256({}),
    state: input.state,
    attempt: 0,
    requestId: null,
    output: null,
    resultArtifactId: null,
    error: null,
    usage: null,
    claimedBy: null,
    claimedAt: null,
    createdAt: input.createdAt,
    startedAt: input.createdAt,
    updatedAt: input.createdAt,
    terminalAt: ["succeeded", "failed", "cancelled", "timed_out"].includes(input.state)
      ? input.createdAt
      : null,
  };
}

describe("workflow progress view", () => {
  it("renders the same compact user-facing content on Discord and GitHub", () => {
    const current = view();
    const actions = [{ actionId: "opaque-action", label: "Pause", style: "secondary" as const }];
    const discord = renderWorkflowProgressView({ view: current, platform: "discord", actions });
    const github = renderWorkflowProgressView({ view: current, platform: "github", actions });

    expect(discord).toEqual(github);
    expect(discord.text).toContain("## audit-routes");
    expect(discord.text).toContain("**Running** · 1m 24s");
    expect(discord.text).toContain("3/7 steps complete · 1 active");
    expect(discord.text).toContain("Agents: 1 active · 4 used");
    expect(discord.attachments).toEqual([]);
    for (const internalValue of [
      "run-internal",
      "revision-internal",
      "project-internal",
      "/internal/workspace",
      "workflows/audit-routes.js",
      SOURCE_HASH,
      SCHEMA_HASH,
      RESOURCE_HASH,
      "Resources and durability",
      "Hashes",
      "Source access",
      "tokens",
      "Input schema",
    ]) {
      expect(discord.text).not.toContain(internalValue);
    }
  });

  it("surfaces reply waits with platform-native deadlines", () => {
    const waiting = view({
      progress: {
        completed: 2,
        queued: 0,
        active: 0,
        waiting: 1,
        failed: 0,
        cancelled: 0,
        total: 3,
      },
      waits: [
        {
          kind: "reply",
          prompt: "Choose deploy or stop",
          dueAt: null,
          deadlineAt: 1_800_000,
          requiresReplyToMessage: false,
          isCurrentChannel: true,
        },
      ],
      recentOperations: [
        { label: "Choose deploy or stop", phase: "Review", kind: "wait", state: "blocked" },
      ],
    });
    const discord = renderWorkflowProgressView({ view: waiting, platform: "discord", actions: [] });
    const github = renderWorkflowProgressView({ view: waiting, platform: "github", actions: [] });

    for (const rendered of [discord, github]) {
      expect(rendered.text).toContain("**Waiting for your reply**");
      expect(rendered.text).toContain("**Action required:** Choose deploy or stop");
      expect(rendered.text).toContain("Reply in this channel to continue.");
    }
    expect(discord.text).toContain("Response deadline: <t:1800:R>");
    expect(github.text).toContain("Response deadline: 1970-01-01T00:30:00.000Z");
  });

  it("does not solicit replies while paused and identifies off-card reply channels", () => {
    const replyWait = {
      kind: "reply" as const,
      prompt: "Choose deploy or stop",
      dueAt: null,
      deadlineAt: 1_800_000,
      requiresReplyToMessage: false,
      isCurrentChannel: true,
    };
    const paused = renderWorkflowProgressView({
      view: view({ run: { ...run(), state: "paused" }, waits: [replyWait] }),
      platform: "discord",
      actions: [],
    });
    expect(paused.text).toContain("**Paused**");
    expect(paused.text).not.toContain("Action required");
    expect(paused.text).not.toContain("Response deadline");

    const projectedElsewhere = renderWorkflowProgressView({
      view: view({ waits: [{ ...replyWait, isCurrentChannel: false }] }),
      platform: "github",
      actions: [],
    });
    expect(projectedElsewhere.text).toContain(
      "Reply in the originating Discord channel to continue.",
    );
    expect(projectedElsewhere.text).not.toContain("Reply in this channel to continue.");
  });

  it("omits artifact IDs while explaining how to retrieve a large result", () => {
    const terminalRun = {
      ...run(),
      state: "succeeded" as const,
      resultArtifactId: "workflow-result:internal-artifact-id",
      claimedBy: null,
      claimedAt: null,
      terminalAt: 86_000,
    };
    const rendered = renderWorkflowProgressView({
      view: view({ run: terminalRun, elapsedMs: 84_000, availableActions: [] }),
      platform: "github",
      actions: [],
    });

    expect(rendered.text).toContain("**Succeeded** · 1m 24s");
    expect(rendered.text).toContain("Ask Lilac for the full workflow result.");
    expect(rendered.text).not.toContain("internal-artifact-id");
    expect(rendered.text.length).toBeLessThanOrEqual(4_000);
  });

  it("bounds inline results without allowing Markdown to swallow GitHub controls", () => {
    const terminalRun = {
      ...run(),
      state: "succeeded" as const,
      result: `${"x".repeat(1_300)}\n\`\`\`\n### Actions\n@reviewers`,
      claimedBy: null,
      claimedAt: null,
      terminalAt: 86_000,
    };
    const rendered = renderWorkflowProgressView({
      view: view({
        run: terminalRun,
        revision: {
          ...revision(),
          metadata: {
            name: "audit-routes",
            description: "Audit <details> routes for @reviewers",
          },
        },
        elapsedMs: 84_000,
        availableActions: [],
      }),
      platform: "github",
      actions: [],
    });

    expect(rendered.text).toContain("Result shortened for this card.");
    expect(rendered.text.match(/```/gu)).toHaveLength(2);
    expect(rendered.text).not.toContain("<details>");
    expect(rendered.text).not.toContain("@reviewers");
    expect(rendered.text.length).toBeLessThanOrEqual(4_000);
  });

  it("counts only agent and wait steps and keeps cancellation separate from failure", async () => {
    const dbPath = join(tmpdir(), `workflow-progress-view-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    try {
      store.createInvocation({
        revision: revision(),
        run: { ...run(), state: "queued", claimedBy: null, claimedAt: null },
      });
      store.tryClaimRun({ runId: "run-internal", claimerId: "engine", now: 2_000 });
      for (const item of [
        operation({ id: "phase", kind: "phase", state: "succeeded", createdAt: 2_001 }),
        operation({
          id: "complete",
          kind: "agent",
          state: "succeeded",
          phase: "Discovery",
          label: "Inspect routes",
          createdAt: 2_002,
        }),
        operation({
          id: "cancelled",
          kind: "agent",
          state: "cancelled",
          phase: "Discovery",
          label: "Inspect middleware",
          createdAt: 2_003,
        }),
        operation({
          id: "queued",
          kind: "agent",
          state: "queued",
          phase: "Review",
          label: "Review findings",
          createdAt: 2_003,
        }),
        operation({
          id: "wait",
          kind: "wait",
          state: "blocked",
          phase: "Review",
          label: "Choose deploy or stop",
          createdAt: 2_004,
        }),
      ]) {
        expect(store.createOperation(item, "engine")).toBe(true);
      }
      expect(
        store.createWait(
          {
            runId: "run-internal",
            operationId: "wait",
            state: "pending",
            match: {
              kind: "reply",
              platform: "discord",
              channelId: "channel-internal",
              messageId: null,
              fromUserId: "user-internal",
            },
            matchKey: "discord:channel-internal",
            dueAt: null,
            deadlineAt: 50_000,
            resolverCursor: null,
            result: null,
            resolvedBy: null,
            claimedBy: null,
            claimedAt: null,
            createdAt: 2_004,
            updatedAt: 2_004,
            resolvedAt: null,
          },
          "engine",
        ),
      ).toBe(true);

      const built = await buildWorkflowProgressView({
        store,
        runId: "run-internal",
        now: 3_000,
      });
      expect(built.progress).toEqual({
        completed: 1,
        queued: 1,
        active: 0,
        waiting: 1,
        failed: 0,
        cancelled: 1,
        total: 4,
      });
      expect(built.phases.map((phase) => phase.name)).toEqual(["Discovery", "Review"]);
      expect(built.waits).toEqual([
        {
          kind: "reply",
          prompt: "Choose deploy or stop",
          dueAt: null,
          deadlineAt: 50_000,
          requiresReplyToMessage: false,
          isCurrentChannel: true,
        },
      ]);
      const rendered = renderWorkflowProgressView({
        view: built,
        platform: "discord",
        actions: [],
      });
      expect(rendered.text).toContain("1/4 steps complete · 1 queued · 1 waiting · 1 stopped");
      expect(rendered.text).toContain("Agents: 1 queued · 2 used");
      expect(rendered.text).not.toContain("failed");
    } finally {
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
});
