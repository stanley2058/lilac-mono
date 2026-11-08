import type { WorkflowRunSummary } from "@stanley2058/lilac-client-protocol";
import { Result } from "better-result";
import type { DurableWorkflowStore } from "../../workflow/durable-workflow-store";
import type { WorkflowRun, WorkflowRunState } from "../../workflow/workflow-domain";
import {
  buildWorkflowProgressCard,
  buildWorkflowProgressViewResult,
} from "../../workflow/workflow-progress-view";
import { nativeFailure } from "./errors";
import { nativeThreadId } from "./native-protocol";
import type { NativeStore } from "./store";
import type { NativeSurfaceStore } from "./store-surface";

type WorkflowRunPage = { items: WorkflowRunSummary[]; nextCursor?: string };

const PAGE_SIZE = 30;
const MAX_SCANNED_BATCHES = 10;
const SEED_PAGE_SIZE = 500;
const ACTIVE_STATES = [
  "queued",
  "running",
  "blocked",
  "paused",
] as const satisfies readonly WorkflowRunState[];
const FINISHED_STATES = [
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly WorkflowRunState[];

function activeState(state: WorkflowRunState) {
  return ACTIVE_STATES.some((active) => active === state);
}

function decodeCursor(cursor: string | undefined) {
  if (cursor === undefined) return Result.ok(undefined);
  const separator = cursor.indexOf("_");
  const createdAt = Number(cursor.slice(0, separator));
  if (separator < 1 || !Number.isSafeInteger(createdAt))
    return Result.err(nativeFailure("invalid", "Invalid workflow cursor"));
  return Result.ok({ createdAt, runId: cursor.slice(separator + 1) });
}

/** Native thread that owns a run's progress card, when there is one. */
function runThreadId(run: WorkflowRun) {
  if (run.completionTarget.kind === "live_parent") return undefined;
  return run.progressTarget?.platform === "native"
    ? nativeThreadId(run.progressTarget.channelId)
    : undefined;
}

export class NativeWorkflows {
  constructor(
    private readonly options: {
      native: Pick<NativeStore, "getUser" | "getThread" | "getThreadRecord" | "setWorkflowActive">;
      surface: Pick<NativeSurfaceStore, "readMessage">;
      workflows: DurableWorkflowStore;
    },
  ) {}

  /** Re-reads the run instead of trusting event order, so a late event cannot revive a finished run. */
  reconcile(runId: string) {
    return this.options.workflows
      .getRun(runId)
      .map((run) => {
        const threadId = run && runThreadId(run);
        if (threadId)
          this.options.native.setWorkflowActive(threadId, runId, activeState(run.state));
      })
      .mapError(() => nativeFailure("sqlite", "Workflows are unavailable"));
  }

  seedActive() {
    return Result.gen(function* (this: NativeWorkflows) {
      let before: { createdAt: number; runId: string } | undefined;
      for (;;) {
        const runs = yield* this.options.workflows
          .listTopLevelRuns({
            states: ACTIVE_STATES,
            before,
            nativeOnly: true,
            limit: SEED_PAGE_SIZE,
          })
          .mapError(() => nativeFailure("sqlite", "Workflows are unavailable"));
        for (const run of runs) {
          const threadId = runThreadId(run);
          if (threadId) this.options.native.setWorkflowActive(threadId, run.runId, true);
        }
        const last = runs.at(-1);
        if (!last || runs.length < SEED_PAGE_SIZE) return Result.ok(undefined);
        before = { createdAt: last.createdAt, runId: last.runId };
      }
    }, this);
  }

  /** Owners also see runs with no native conversation; everyone else only sees threads they can read. */
  async list(
    actorId: string,
    input: { state: "active" | "finished"; cursor?: string; limit?: number },
  ) {
    return Result.gen(async function* (this: NativeWorkflows) {
      const user = yield* this.options.native.getUser(actorId);
      const owner = user.role === "owner";
      const limit = Math.min(PAGE_SIZE, input.limit ?? PAGE_SIZE);
      const items: WorkflowRunSummary[] = [];
      let before = yield* decodeCursor(input.cursor);
      const page = () =>
        Result.ok<WorkflowRunPage>({
          items,
          ...(before ? { nextCursor: `${before.createdAt}_${before.runId}` } : {}),
        });
      for (let batch = 0; batch < MAX_SCANNED_BATCHES; batch += 1) {
        const runs = yield* this.options.workflows
          .listTopLevelRuns({
            states: input.state === "active" ? ACTIVE_STATES : FINISHED_STATES,
            before,
            nativeOnly: !owner,
            limit: limit + 1,
          })
          .mapError(() => nativeFailure("sqlite", "Workflows are unavailable"));
        for (const run of runs.slice(0, limit)) {
          if (items.length >= limit) return page();
          const summary = yield* Result.await(this.summary(actorId, owner, run));
          if (summary) items.push(summary);
          before = { createdAt: run.createdAt, runId: run.runId };
        }
        if (runs.length <= limit) return Result.ok<WorkflowRunPage>({ items });
      }
      return page();
    }, this);
  }

  private async summary(actorId: string, owner: boolean, run: WorkflowRun) {
    return Result.gen(async function* (this: NativeWorkflows) {
      const access = this.threadAccess(actorId, owner, run);
      if (access === "hidden") return Result.ok(undefined);
      const view = yield* Result.await(
        buildWorkflowProgressViewResult({ store: this.options.workflows, runId: run.runId }).then(
          (result) => result.mapError(() => nativeFailure("sqlite", "Workflows are unavailable")),
        ),
      );
      const source =
        access === "none" ? undefined : yield* this.cardSource(actorId, access, run.runId);
      return Result.ok<WorkflowRunSummary>({
        id: run.runId,
        card: buildWorkflowProgressCard(view),
        ...(access === "none"
          ? {}
          : { thread: { id: access.id, title: access.title, ...(source ? { source } : {}) } }),
        ...(access === "none" && run.progressTarget && run.progressTarget.platform !== "native"
          ? { platform: run.progressTarget.platform }
          : {}),
      });
    }, this);
  }

  /** The posted card's place in its thread and, for editors, the actions it currently offers. */
  private cardSource(actorId: string, thread: { id: string; editable: boolean }, runId: string) {
    return Result.gen(function* (this: NativeWorkflows) {
      const binding = yield* this.options.workflows
        .getSurfaceBinding(runId)
        .mapError(() => nativeFailure("sqlite", "Workflows are unavailable"));
      const messageId = binding?.messageRef?.messageId;
      if (!messageId) return Result.ok(undefined);
      const found = yield* this.options.surface.readMessage(actorId, thread.id, messageId);
      if (!found) return Result.ok(undefined);
      const actions = thread.editable
        ? found.message.parts.find((part) => part.type === "data-actions")
        : undefined;
      return Result.ok({
        messageId,
        position: found.position,
        ...(actions?.type === "data-actions" ? { actions } : {}),
      });
    }, this);
  }

  private threadAccess(actorId: string, owner: boolean, run: WorkflowRun) {
    const threadId = runThreadId(run);
    if (!threadId) return owner ? ("none" as const) : ("hidden" as const);
    const thread = this.options.native
      .getThread(actorId, threadId)
      .match({ ok: (value) => value, err: () => undefined });
    if (thread) return { id: thread.id, title: thread.title, editable: thread.capabilities.edit };
    // A deleted conversation must not hide a run that may still be spending resources.
    const gone = this.options.native
      .getThreadRecord(threadId)
      .match({ ok: (record) => record.deleted, err: () => true });
    return owner && gone ? ("none" as const) : ("hidden" as const);
  }
}
