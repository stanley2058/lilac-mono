import { lilacEventTypes, type LilacBus } from "@stanley2058/lilac-event-bus";
import { Result, type Result as ResultType } from "better-result";

import type { DurableWorkflowReadError, DurableWorkflowStore } from "./durable-workflow-store";
import type { WorkflowRun } from "./workflow-domain";
import type { WorkflowProgressCardService } from "./workflow-progress-projector";

export type WorkflowRunCancellation = {
  readonly run: WorkflowRun | null;
  readonly changed: boolean;
};

/**
 * Durably cancels a non-terminal run and its children, interrupts the agent requests its operations
 * started, and announces the change. A terminal run is returned unchanged.
 */
export async function cancelWorkflowRun(input: {
  readonly store: DurableWorkflowStore;
  readonly bus?: LilacBus;
  readonly progressCards?: Pick<WorkflowProgressCardService, "requestProjection">;
  readonly run: WorkflowRun;
  readonly detail: string;
  readonly now: number;
}): Promise<ResultType<WorkflowRunCancellation, DurableWorkflowReadError | Error>> {
  return Result.gen(async function* () {
    const { store, bus, run, now } = input;
    if (["succeeded", "failed", "cancelled"].includes(run.state))
      return Result.ok({ run, changed: false });
    const operations = yield* store.listOperations(run.runId, { limit: 1_000 });
    const activeRequests = operations.flatMap((operation) =>
      operation.requestId ? [operation.requestId] : [],
    );
    const cancelled = store.cancelRunAndChildren({ runId: run.runId, now, detail: input.detail });
    const changed = cancelled?.state === "cancelled";
    for (const requestId of activeRequests) {
      if (!bus) break;
      yield* Result.await(
        bus.publish(
          lilacEventTypes.CmdRequestMessage,
          {
            requestDeliveryId: crypto.randomUUID(),
            queue: "interrupt",
            messages: [],
            raw: { cancel: true, cancelQueued: true },
          },
          {
            headers: {
              request_id: requestId,
              session_id: `workflow:${run.runId}:cancel`,
              request_client: "unknown",
            },
          },
        ),
      );
    }
    if (changed && cancelled) {
      if (bus)
        yield* Result.await(
          bus.publish(lilacEventTypes.EvtWorkflowRunChanged, {
            runId: cancelled.runId,
            revisionId: cancelled.revisionId,
            state: cancelled.state,
            previousState: run.state,
            detail: cancelled.terminalDetail ?? undefined,
            ts: now,
          }),
        );
      input.progressCards?.requestProjection(cancelled.runId);
    }
    return Result.ok({ run: cancelled, changed });
  });
}
