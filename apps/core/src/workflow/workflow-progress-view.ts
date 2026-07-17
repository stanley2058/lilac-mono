import type { SurfaceAction, SurfacePlatform } from "../surface/types";
import type {
  DurableWorkflowStore,
  WorkflowOperationProgressSummary,
} from "./durable-workflow-store";
import type {
  JsonValue,
  WorkflowOperation,
  WorkflowOperationState,
  WorkflowRevision,
  WorkflowRun,
  WorkflowSurfaceActionKind,
} from "./workflow-domain";

export type WorkflowProgressCounts = {
  completed: number;
  queued: number;
  active: number;
  waiting: number;
  failed: number;
  cancelled: number;
  total: number;
};

export type WorkflowProgressPhase = WorkflowProgressCounts & {
  name: string;
};

export type WorkflowProgressWait = {
  kind: "reply" | "sleep";
  prompt: string;
  dueAt: number | null;
  deadlineAt: number | null;
  requiresReplyToMessage: boolean;
  isCurrentChannel: boolean;
};

export type WorkflowProgressView = {
  run: WorkflowRun;
  revision: WorkflowRevision;
  elapsedMs: number;
  progress: WorkflowProgressCounts;
  phases: WorkflowProgressPhase[];
  recentOperations: Array<Pick<WorkflowOperation, "label" | "phase" | "kind" | "state">>;
  waits: WorkflowProgressWait[];
  agents: { used: number; active: number; queued: number };
  nextTriggerAt: number | null;
  availableActions: WorkflowSurfaceActionKind[];
  manualReconciliationRequired: boolean;
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

function emptyCounts(): WorkflowProgressCounts {
  return {
    completed: 0,
    queued: 0,
    active: 0,
    waiting: 0,
    failed: 0,
    cancelled: 0,
    total: 0,
  };
}

function addOperationSummary(
  counts: WorkflowProgressCounts,
  summary: WorkflowOperationProgressSummary,
): void {
  counts.total += summary.count;
  if (summary.state === "succeeded") counts.completed += summary.count;
  else if (summary.state === "queued") counts.queued += summary.count;
  else if (summary.kind === "wait" && summary.state === "blocked") {
    counts.waiting += summary.count;
  } else if (["dispatched", "running", "blocked"].includes(summary.state)) {
    counts.active += summary.count;
  } else if (["failed", "timed_out"].includes(summary.state)) counts.failed += summary.count;
  else if (summary.state === "cancelled") counts.cancelled += summary.count;
}

function summarizePhases(
  summaries: readonly WorkflowOperationProgressSummary[],
  sensitive: boolean,
): WorkflowProgressPhase[] {
  const phases = new Map<string, WorkflowProgressPhase>();
  for (const summary of summaries) {
    const name = sensitive ? "Workflow" : (summary.phase ?? "Workflow");
    const phase = phases.get(name) ?? { name, ...emptyCounts() };
    addOperationSummary(phase, summary);
    phases.set(name, phase);
  }
  return [...phases.values()];
}

export async function buildWorkflowProgressView(input: {
  store: DurableWorkflowStore;
  runId: string;
  now?: number;
}): Promise<WorkflowProgressView> {
  const run = input.store.getRun(input.runId);
  if (!run) throw new Error(`Workflow run not found: ${input.runId}`);
  const revision = input.store.getRevision(run.revisionId);
  if (!revision) throw new Error(`Workflow revision not found: ${run.revisionId}`);
  const operationSummaries = input.store.summarizeMeaningfulOperations(run.runId);
  const recentOperations = input.store.listRecentMeaningfulOperations(run.runId, 5);
  const trigger = input.store.getTriggerByLastRunId(run.runId);
  const sensitive = schemaContainsSensitive(run.inputSchemaSnapshot);
  const progress = emptyCounts();
  for (const summary of operationSummaries) addOperationSummary(progress, summary);
  const waits = [
    ...input.store.listWaits({ runId: run.runId, state: "pending", matchKind: "reply", limit: 5 }),
    ...input.store.listWaits({ runId: run.runId, state: "claimed", matchKind: "reply", limit: 5 }),
    ...input.store.listWaits({ runId: run.runId, state: "pending", matchKind: "sleep", limit: 5 }),
    ...input.store.listWaits({ runId: run.runId, state: "claimed", matchKind: "sleep", limit: 5 }),
  ]
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((wait): WorkflowProgressWait => {
      const operation = input.store.getOperation(run.runId, wait.operationId);
      return {
        kind: wait.match.kind,
        prompt: sensitive
          ? wait.match.kind === "reply"
            ? "Waiting for your reply"
            : "Waiting"
          : (operation?.label ?? (wait.match.kind === "reply" ? "Waiting for reply" : "Waiting")),
        dueAt: wait.dueAt,
        deadlineAt: wait.deadlineAt,
        requiresReplyToMessage: wait.match.kind === "reply" && wait.match.messageId !== null,
        isCurrentChannel:
          wait.match.kind === "reply" &&
          run.progressTarget?.platform === wait.match.platform &&
          run.progressTarget.channelId === wait.match.channelId,
      };
    });
  const visibleOperations = recentOperations.map(({ label, phase, kind, state }) => ({
    label: sensitive ? null : label,
    phase: sensitive ? null : phase,
    kind,
    state,
  }));
  const agentSummaries = operationSummaries.filter((summary) => summary.kind === "agent");
  const end = run.terminalAt ?? input.now ?? Date.now();
  const manualReconciliationRequired =
    input.store.getManualReconciliationDetail(run.runId) !== null;
  return {
    run,
    revision,
    elapsedMs: Math.max(0, end - (run.startedAt ?? run.createdAt)),
    progress,
    phases: summarizePhases(operationSummaries, sensitive),
    recentOperations: visibleOperations,
    waits,
    agents: {
      used: agentSummaries.reduce(
        (total, summary) =>
          total +
          (summary.state === "queued"
            ? 0
            : summary.state === "cancelled"
              ? summary.startedCount
              : summary.count),
        0,
      ),
      active: agentSummaries
        .filter((summary) => ["dispatched", "running"].includes(summary.state))
        .reduce((total, summary) => total + summary.count, 0),
      queued: agentSummaries
        .filter((summary) => summary.state === "queued")
        .reduce((total, summary) => total + summary.count, 0),
    },
    nextTriggerAt: trigger?.nextFireAt ?? null,
    availableActions: availableActions({ run, manualReconciliationRequired }),
    manualReconciliationRequired,
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

function bounded(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function escapeInlineMarkdown(text: string): string {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll(/([`*_[\]{}()#+\-.!|<>~])/gu, "\\$1")
    .replaceAll("@", "@\u200b");
}

function oneLine(text: string, max: number): string {
  return bounded(escapeInlineMarkdown(text.replaceAll(/\s+/gu, " ").trim()), max);
}

function formatDuration(elapsedMs: number): string {
  const seconds = Math.floor(elapsedMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60)
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatTimestamp(platform: SurfacePlatform, value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(value) || Number.isNaN(date.getTime())) return "at a distant future time";
  if (platform === "discord") return `<t:${Math.floor(value / 1_000)}:R>`;
  return date.toISOString();
}

function presentationState(view: WorkflowProgressView): string {
  if (view.manualReconciliationRequired) return "Needs attention";
  if (view.run.state === "paused") return "Paused";
  if (["running", "blocked"].includes(view.run.state)) {
    if (view.waits.some((wait) => wait.kind === "reply")) return "Waiting for your reply";
    if (view.waits.some((wait) => wait.kind === "sleep")) return "Waiting";
  }
  const labels = {
    queued: "Queued",
    running: "Running",
    blocked: "Blocked",
    paused: "Paused",
    succeeded: "Succeeded",
    failed: "Failed",
    cancelled: "Cancelled",
  } satisfies Record<WorkflowRun["state"], string>;
  return labels[view.run.state];
}

function progressSummary(counts: WorkflowProgressCounts): string | null {
  if (counts.total === 0) return null;
  const noun = counts.total === 1 ? "step" : "steps";
  const details = [
    `${counts.completed}/${counts.total} ${noun} complete`,
    counts.queued > 0 ? `${counts.queued} queued` : null,
    counts.active > 0 ? `${counts.active} active` : null,
    counts.waiting > 0 ? `${counts.waiting} waiting` : null,
    counts.failed > 0 ? `${counts.failed} failed` : null,
    counts.cancelled > 0 ? `${counts.cancelled} stopped` : null,
  ].filter((part): part is string => part !== null);
  return details.join(" · ");
}

function phaseLine(phase: WorkflowProgressPhase): string {
  const details = [
    `${phase.completed}/${phase.total} complete`,
    phase.queued > 0 ? `${phase.queued} queued` : null,
    phase.active > 0 ? `${phase.active} active` : null,
    phase.waiting > 0 ? `${phase.waiting} waiting` : null,
    phase.failed > 0 ? `${phase.failed} failed` : null,
    phase.cancelled > 0 ? `${phase.cancelled} stopped` : null,
  ].filter((part): part is string => part !== null);
  return `- ${oneLine(phase.name, 80)}: ${details.join(" · ")}`;
}

function operationState(state: WorkflowOperationState, kind: WorkflowOperation["kind"]): string {
  if (state === "succeeded") return "complete";
  if (state === "timed_out") return "timed out";
  if (state === "cancelled") return "stopped";
  if (state === "blocked" && kind === "wait") return "waiting";
  if (state === "dispatched") return "starting";
  return state;
}

function renderTextBlock(
  text: string,
  max: number,
  language = "text",
): {
  text: string;
  truncated: boolean;
} {
  const normalized = text.trim() || "Completed without output.";
  const escaped = normalized.replaceAll("```", "` ` `");
  return {
    text: `\`\`\`${language}\n${bounded(escaped, max)}\n\`\`\``,
    truncated: escaped.length > max,
  };
}

function renderResult(result: JsonValue): { text: string; truncated: boolean } {
  if (typeof result === "string") return renderTextBlock(result, 1_200);
  return renderTextBlock(JSON.stringify(result, null, 2), 1_200, "json");
}

export function renderWorkflowProgressView(input: {
  view: WorkflowProgressView;
  platform: SurfacePlatform;
  actions: SurfaceAction[];
}): { text: string; actions: SurfaceAction[]; attachments: [] } {
  const view = input.view;
  const terminal = ["succeeded", "failed", "cancelled"].includes(view.run.state);
  const lines = [
    `## ${view.revision.name}`,
    oneLine(view.revision.metadata.description, 240),
    "",
    `**${presentationState(view)}** · ${formatDuration(view.elapsedMs)}`,
  ];

  if (view.manualReconciliationRequired) {
    lines.push(
      "",
      "The workflow could not confirm an operation's outcome. Cancel it and start a new run.",
    );
  } else {
    const waitsAreActionable = ["running", "blocked"].includes(view.run.state);
    const replyWait = waitsAreActionable
      ? view.waits.find((wait) => wait.kind === "reply")
      : undefined;
    const sleepWait = waitsAreActionable
      ? view.waits.find((wait) => wait.kind === "sleep")
      : undefined;
    if (replyWait) {
      lines.push("", `**Action required:** ${oneLine(replyWait.prompt, 300)}`);
      if (replyWait.isCurrentChannel) {
        lines.push(
          replyWait.requiresReplyToMessage
            ? "Reply to the original prompt message to continue."
            : "Reply in this channel to continue.",
        );
      } else {
        lines.push(
          replyWait.requiresReplyToMessage
            ? "Reply to the original prompt message in the originating Discord channel to continue."
            : "Reply in the originating Discord channel to continue.",
        );
      }
      if (replyWait.deadlineAt !== null) {
        lines.push(`Response deadline: ${formatTimestamp(input.platform, replyWait.deadlineAt)}`);
      }
    } else if (sleepWait?.dueAt !== null && sleepWait?.dueAt !== undefined) {
      lines.push("", `Resumes ${formatTimestamp(input.platform, sleepWait.dueAt)}.`);
    }
  }

  if (terminal && !view.sensitive) {
    if (view.run.state === "succeeded" && view.run.result !== null) {
      const result = renderResult(view.run.result);
      lines.push("", "**Result**", result.text);
      if (result.truncated) {
        lines.push("Result shortened for this card. Ask Lilac for the full workflow result.");
      }
    } else if (view.run.state === "succeeded" && view.run.resultArtifactId) {
      lines.push(
        "",
        "**Result**",
        "The result is too large to display here. Ask Lilac for the full workflow result.",
      );
    } else if (view.run.terminalDetail) {
      lines.push("", "**Reason**", renderTextBlock(view.run.terminalDetail, 600).text);
    }
  }

  const summary = progressSummary(view.progress);
  if (summary) lines.push("", summary);

  if (view.phases.length > 1) {
    const visiblePhases = view.phases.slice(0, 4);
    lines.push("", "**Progress**", ...visiblePhases.map(phaseLine));
    if (view.phases.length > visiblePhases.length) {
      lines.push(`- ${view.phases.length - visiblePhases.length} more phases`);
    }
  }

  if (!terminal) {
    const waitVisible = view.waits.length > 0;
    const operations = view.recentOperations
      .filter(
        (operation) => !(waitVisible && operation.kind === "wait" && operation.state === "blocked"),
      )
      .slice(0, 3);
    if (operations.length > 0) {
      const hasActive = operations.some((operation) =>
        ["queued", "dispatched", "running", "blocked"].includes(operation.state),
      );
      lines.push(
        "",
        hasActive ? "**Now**" : "**Recent**",
        ...operations.map(
          (operation) =>
            `- ${oneLine(operation.label ?? (operation.kind === "agent" ? "Agent step" : "Wait"), 140)} — ${operationState(operation.state, operation.kind)}`,
        ),
      );
    }
  }

  if (view.agents.used > 0 || view.agents.queued > 0) {
    const agentParts = [
      view.agents.active > 0 ? `${view.agents.active} active` : null,
      view.agents.queued > 0 ? `${view.agents.queued} queued` : null,
      view.agents.used > 0 ? `${view.agents.used} used` : null,
    ].filter((part): part is string => part !== null);
    lines.push("", `Agents: ${agentParts.join(" · ")}`);
  }
  if (view.nextTriggerAt !== null) {
    lines.push(`Next run: ${formatTimestamp(input.platform, view.nextTriggerAt)}`);
  }

  return {
    text: bounded(lines.join("\n"), 4_000),
    actions: input.actions,
    attachments: [],
  };
}
