import type { SurfaceAction, SurfaceAttachment, SurfacePlatform } from "../surface/types";
import type { DurableWorkflowStore } from "./durable-workflow-store";
import type {
  JsonObject,
  JsonValue,
  WorkflowOperation,
  WorkflowRevision,
  WorkflowRun,
  WorkflowSurfaceActionKind,
  WorkflowUsage,
} from "./workflow-domain";
import { jsonObjectSchema } from "./workflow-domain";
import {
  publicWorkflowWorktreeOutput,
  type PublicWorkflowWorktreeOutput,
} from "./workflow-worktree-artifact";

export type WorkflowProgressPhase = {
  name: string;
  completed: number;
  running: number;
  failed: number;
  total: number;
};

export type WorkflowProgressView = {
  run: WorkflowRun;
  revision: WorkflowRevision;
  elapsedMs: number;
  review: {
    source: string | null;
    sourceAccess: string;
    firstArgs: JsonObject;
    inputSchema: JsonObject;
  };
  phases: WorkflowProgressPhase[];
  recentOperations: Array<Pick<WorkflowOperation, "label" | "phase" | "kind" | "state">>;
  worktreeOutputs: PublicWorkflowWorktreeOutput[];
  usage: WorkflowUsage & { agentCount: number; activeAgents: number };
  nextTriggerAt: number | null;
  availableActions: WorkflowSurfaceActionKind[];
  sensitive: boolean;
};

function schemaContainsSensitive(value: JsonValue): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(schemaContainsSensitive);
  return (
    value["sensitive"] === true ||
    Object.values(value).some((child) => schemaContainsSensitive(child))
  );
}

export function redactWorkflowValue(value: JsonValue, schema: JsonValue | undefined): JsonValue {
  if (
    schema !== undefined &&
    schema !== null &&
    typeof schema === "object" &&
    !Array.isArray(schema) &&
    schema["sensitive"] === true
  ) {
    return "<redacted>";
  }
  if (Array.isArray(value)) {
    const itemSchema =
      schema !== undefined &&
      schema !== null &&
      typeof schema === "object" &&
      !Array.isArray(schema)
        ? schema["items"]
        : undefined;
    return value.map((item) => redactWorkflowValue(item, itemSchema));
  }
  if (value === null || typeof value !== "object") return value;
  const properties =
    schema !== undefined &&
    schema !== null &&
    typeof schema === "object" &&
    !Array.isArray(schema) &&
    schema["properties"] !== null &&
    typeof schema["properties"] === "object" &&
    !Array.isArray(schema["properties"])
      ? schema["properties"]
      : undefined;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      redactWorkflowValue(child, properties?.[key]),
    ]),
  );
}

function availableActions(input: {
  run: WorkflowRun;
  manualReconciliationRequired: boolean;
}): WorkflowSurfaceActionKind[] {
  if (
    input.manualReconciliationRequired &&
    ["queued", "running", "blocked", "paused"].includes(input.run.state)
  ) {
    return ["cancel"];
  }
  if (["queued", "running", "blocked"].includes(input.run.state)) return ["pause", "cancel"];
  if (input.run.state === "paused") return ["resume", "cancel"];
  return [];
}

function summarizePhases(
  operations: readonly WorkflowOperation[],
  sensitive: boolean,
): WorkflowProgressPhase[] {
  const phases = new Map<string, WorkflowProgressPhase>();
  for (const operation of operations) {
    const name = sensitive ? "workflow" : (operation.phase ?? "workflow");
    const phase = phases.get(name) ?? { name, completed: 0, running: 0, failed: 0, total: 0 };
    phase.total += 1;
    if (operation.state === "succeeded") phase.completed += 1;
    if (["dispatched", "running", "blocked"].includes(operation.state)) phase.running += 1;
    if (["failed", "cancelled", "timed_out"].includes(operation.state)) phase.failed += 1;
    phases.set(name, phase);
  }
  return [...phases.values()];
}

export async function buildWorkflowProgressView(input: {
  store: DurableWorkflowStore;
  runId: string;
  now?: number;
  loadSource?: (revision: WorkflowRevision) => Promise<string | null>;
}): Promise<WorkflowProgressView> {
  const run = input.store.getRun(input.runId);
  if (!run) throw new Error(`Workflow run not found: ${input.runId}`);
  const revision = input.store.getRevision(run.revisionId);
  if (!revision) throw new Error(`Workflow revision not found: ${run.revisionId}`);
  const operations = input.store.listOperations(run.runId, { limit: 1_000 });
  const worktreeOutputs = input.store
    .listWorktreeOutputs(run.runId, { limit: 1_000 })
    .map(publicWorkflowWorktreeOutput);
  const trigger = input.store.getTriggerByLastRunId(run.runId);
  const usage = operations.reduce(
    (total, operation) => ({
      inputTokens: total.inputTokens + (operation.usage?.inputTokens ?? 0),
      outputTokens: total.outputTokens + (operation.usage?.outputTokens ?? 0),
      totalTokens: total.totalTokens + (operation.usage?.totalTokens ?? 0),
      agentCount: total.agentCount + (operation.kind === "agent" ? 1 : 0),
      activeAgents:
        total.activeAgents +
        (operation.kind === "agent" && ["dispatched", "running"].includes(operation.state) ? 1 : 0),
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, agentCount: 0, activeAgents: 0 },
  );
  const end = run.terminalAt ?? input.now ?? Date.now();
  const sensitive = schemaContainsSensitive(run.inputSchemaSnapshot);
  return {
    run,
    revision,
    elapsedMs: Math.max(0, end - (run.startedAt ?? run.createdAt)),
    review: {
      source: input.loadSource ? await input.loadSource(revision) : null,
      sourceAccess: `tools workflow.run.get ${run.runId} --include-source=true (immutable artifact ${revision.snapshotArtifactId})`,
      firstArgs: jsonObjectSchema.parse(redactWorkflowValue(run.args, run.inputSchemaSnapshot)),
      inputSchema: run.inputSchemaSnapshot,
    },
    phases: summarizePhases(operations, sensitive),
    recentOperations: operations.slice(-5).map(({ label, phase, kind, state }) => ({
      label: sensitive ? null : label,
      phase: sensitive ? null : phase,
      kind,
      state,
    })),
    worktreeOutputs,
    usage,
    nextTriggerAt: trigger?.nextFireAt ?? null,
    availableActions: availableActions({
      run,
      manualReconciliationRequired: input.store.getManualReconciliationDetail(run.runId) !== null,
    }),
    sensitive,
  };
}

function actionLabel(kind: WorkflowSurfaceActionKind): string {
  return kind[0]!.toUpperCase() + kind.slice(1);
}

export function toSurfaceActions(input: {
  view: WorkflowProgressView;
  actionIds: ReadonlyMap<WorkflowSurfaceActionKind, string>;
}): SurfaceAction[] {
  return input.view.availableActions.flatMap((kind) => {
    const actionId = input.actionIds.get(kind);
    if (!actionId) return [];
    return [
      {
        actionId,
        label: actionLabel(kind),
        style: kind === "cancel" ? "danger" : "secondary",
      },
    ];
  });
}

function json(value: JsonValue): string {
  return JSON.stringify(value, null, 2);
}

function bounded(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n... (bounded; use source access)`;
}

function reviewJson(view: WorkflowProgressView): string {
  return JSON.stringify(
    {
      project: view.revision.canonicalProjectId,
      workspaceRoot: view.revision.canonicalWorkspaceRoot,
      scope: view.revision.scope,
      path: view.revision.normalizedPath,
      runtimeVersion: view.revision.runtimeVersion,
      hashes: {
        source: view.revision.sourceSha256,
        inputSchema: view.revision.inputSchemaSha256,
        resourcePolicy: view.revision.resourcePolicySha256,
        ...(view.sensitive ? {} : { args: view.run.argsSha256 }),
      },
      firstArgsRedacted: view.review.firstArgs,
      inputSchema: view.review.inputSchema,
      resources: view.revision.resources,
      limits: view.revision.limits,
      sourceAccess: view.review.sourceAccess,
    },
    null,
    2,
  );
}

export function renderWorkflowProgressView(input: {
  view: WorkflowProgressView;
  platform: SurfacePlatform;
  actions: SurfaceAction[];
}): { text: string; actions: SurfaceAction[]; attachments: SurfaceAttachment[] } {
  const view = input.view;
  const phaseLines = view.phases.map(
    (phase) =>
      `- ${phase.name}: ${phase.completed} complete, ${phase.running} running, ${phase.failed} failed, ${phase.total} total`,
  );
  const operationLines = view.recentOperations.map(
    (operation) =>
      `- ${operation.label ?? operation.kind}: ${operation.state}${operation.phase ? ` (${operation.phase})` : ""}`,
  );
  const worktreeOutputLines = view.worktreeOutputs.map((output) => {
    const detail =
      !view.sensitive && output.reconciliationDetail ? `; ${output.reconciliationDetail}` : "";
    if (!output.artifactId) {
      return `- ${output.operationId}: ${output.state}; worktree preserved for reconciliation${detail}`;
    }
    return `- ${output.operationId}: ${output.state} patch \`${output.artifactId}\` (${output.bytes ?? 0} bytes); retrieve with \`tools workflow.run.get ${view.run.runId} --worktree-patch-artifact-id=${output.artifactId} --include-sensitive-result=true\`${detail}`;
  });
  const exactReviewDetails =
    input.platform === "github"
      ? [
          "",
          "### First invocation arguments (redacted per schema)",
          `\`\`\`json\n${bounded(json(view.review.firstArgs), 12_000)}\n\`\`\``,
          "### Input schema",
          `\`\`\`json\n${bounded(json(view.review.inputSchema), 20_000)}\n\`\`\``,
        ]
      : [
          "",
          "First invocation arguments (schema-redacted) and the exact input schema are attached in the review JSON.",
        ];
  const base = [
    `## Workflow: ${view.revision.name}`,
    `Run: \`${view.run.runId}\` | Revision: \`${view.revision.sourceSha256.slice(0, 12)}\``,
    `State: **${view.run.state}** | Elapsed: ${Math.floor(view.elapsedMs / 1_000)}s`,
    `Scope/path: \`${view.revision.scope}:${view.revision.normalizedPath}\``,
    `Project: \`${view.revision.canonicalProjectId}\``,
    "",
    "### Resources and durability",
    `Agents: ${view.revision.resources.agents.maxConcurrent} concurrent / ${view.revision.resources.agents.maxTotal} total`,
    `Waits: ${view.revision.resources.waits.join(", ") || "none"}`,
    `Limits: wall ${view.revision.resources.maxWallTimeMs}ms, idle ${view.revision.resources.operationIdleTimeoutMs}ms, nesting ${view.revision.resources.maxNestingDepth}, source ${view.revision.limits.maxSourceBytes}B, input ${view.revision.limits.maxInputBytes}B, operation output ${view.revision.limits.maxOperationOutputBytes}B, result ${view.revision.limits.maxResultBytes}B`,
    "",
    "### Hashes",
    `Source: \`${view.revision.sourceSha256}\``,
    `Input schema: \`${view.revision.inputSchemaSha256}\``,
    `Resource policy: \`${view.revision.resourcePolicySha256}\``,
    ...(view.sensitive ? [] : [`Arguments: \`${view.run.argsSha256}\``]),
    ...exactReviewDetails,
    `Source access: \`${view.review.sourceAccess}\``,
    ...(phaseLines.length > 0 ? ["", "### Phases", ...phaseLines] : []),
    ...(operationLines.length > 0 ? ["", "### Recent operations", ...operationLines] : []),
    ...(worktreeOutputLines.length > 0
      ? ["", "### Isolated edit outputs", ...worktreeOutputLines]
      : []),
    "",
    `Usage: ${view.usage.inputTokens} input / ${view.usage.outputTokens} output / ${view.usage.totalTokens} total tokens | Agents: ${view.usage.agentCount} total / ${view.usage.activeAgents} active`,
    ...(view.nextTriggerAt !== null
      ? [`Next trigger: ${new Date(view.nextTriggerAt).toISOString()}`]
      : []),
    ...(view.run.terminalDetail && !view.sensitive
      ? ["", `Terminal detail: ${view.run.terminalDetail}`]
      : []),
    ...(view.run.result !== null && !view.sensitive
      ? [
          "",
          `Result: \`${bounded(json(redactWorkflowValue(view.run.result, view.run.inputSchemaSnapshot)), 1_000)}\``,
        ]
      : []),
    ...(view.run.resultArtifactId && !view.sensitive
      ? ["", `Result artifact: \`${view.run.resultArtifactId}\` (inspect with workflow.run.get)`]
      : []),
  ].join("\n");

  if (input.platform === "github") {
    const source = view.review.source
      ? bounded(view.review.source.replaceAll("```", "` ` `"), 20_000)
      : "Source snapshot unavailable from this projector instance.";
    return {
      text: `${base}\n\n<details><summary>Exact immutable source</summary>\n\n\`\`\`js\n${source}\n\`\`\`\n</details>`,
      actions: input.actions,
      attachments: [],
    };
  }

  const attachments: SurfaceAttachment[] = [
    {
      kind: "file",
      mimeType: "application/json",
      filename: `${view.revision.name}-review.json`,
      bytes: new TextEncoder().encode(reviewJson(view)),
    },
  ];
  if (view.review.source) {
    attachments.push({
      kind: "file",
      mimeType: "text/javascript",
      filename: `${view.revision.name}-${view.revision.sourceSha256.slice(0, 12)}.js`,
      bytes: new TextEncoder().encode(view.review.source),
    });
  }
  return { text: bounded(base, 4_000), actions: input.actions, attachments };
}
