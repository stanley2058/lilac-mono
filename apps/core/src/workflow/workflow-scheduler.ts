import type { ModelMessage } from "ai";

import {
  lilacEventTypes,
  type CmdRequestMessageData,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";
import { resolveLogLevel } from "@stanley2058/lilac-utils";
import { Logger } from "@stanley2058/simple-module-logger";

import type { WorkflowStoreQueries } from "./workflow-store-queries";
import type { WorkflowStore } from "./workflow-store";
import type {
  WorkflowDefinitionV3,
  WorkflowRecord,
  WorkflowTaskRecord,
  WorkflowTaskState,
} from "./types";
import { computeNextCronAtMs } from "./cron";
import { buildScheduledJobMessages } from "./scheduled-request";

function consumerId(prefix: string): string {
  return `${prefix}:${process.pid}:${Math.random().toString(16).slice(2)}`;
}

function now(): number {
  return Date.now();
}

function isScheduledWorkflow(def: WorkflowRecord["definition"]): def is WorkflowDefinitionV3 {
  return def.version === 3;
}

function isTimeWaitUntilTask(t: WorkflowTaskRecord): boolean {
  return t.kind === "time.wait_until";
}

function isTimeCronTask(t: WorkflowTaskRecord): boolean {
  return t.kind === "time.cron";
}

async function publishTaskLifecycle(params: {
  bus: LilacBus;
  workflowId: string;
  taskId: string;
  state: WorkflowTaskState;
  detail?: string;
}) {
  await params.bus.publish(lilacEventTypes.EvtWorkflowTaskLifecycleChanged, {
    workflowId: params.workflowId,
    taskId: params.taskId,
    state: params.state,
    detail: params.detail,
    ts: now(),
  });
}

async function publishTaskResolved(params: {
  bus: LilacBus;
  workflowId: string;
  taskId: string;
  result: unknown;
}) {
  await params.bus.publish(lilacEventTypes.EvtWorkflowTaskResolved, {
    workflowId: params.workflowId,
    taskId: params.taskId,
    result: params.result,
  });
}

async function publishWorkflowLifecycle(params: {
  bus: LilacBus;
  workflowId: string;
  state: WorkflowRecord["state"];
  detail?: string;
}) {
  await params.bus.publish(lilacEventTypes.EvtWorkflowLifecycleChanged, {
    workflowId: params.workflowId,
    state: params.state,
    detail: params.detail,
    ts: now(),
  });
}

async function publishWorkflowResolved(params: {
  bus: LilacBus;
  workflowId: string;
  result: unknown;
}) {
  await params.bus.publish(lilacEventTypes.EvtWorkflowResolved, {
    workflowId: params.workflowId,
    result: params.result,
  });
}

function nonEmptyStr(x: unknown): x is string {
  return typeof x === "string" && x.trim().length > 0;
}

function parseCronInput(input: unknown): {
  expr: string;
  tz?: string;
  startAtMs?: number;
  skipMissed?: boolean;
} | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (!nonEmptyStr(o.expr)) return null;
  const tz = nonEmptyStr(o.tz) ? o.tz : undefined;
  const startAtMs =
    typeof o.startAtMs === "number" && Number.isFinite(o.startAtMs)
      ? Math.trunc(o.startAtMs)
      : undefined;
  const skipMissed = typeof o.skipMissed === "boolean" ? o.skipMissed : undefined;
  return { expr: o.expr, tz, startAtMs, skipMissed };
}

function parseWaitUntilInput(input: unknown): { runAtMs: number } | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (typeof o.runAtMs !== "number" || !Number.isFinite(o.runAtMs)) return null;
  return { runAtMs: Math.trunc(o.runAtMs) };
}

function toRequestHeaders(params: {
  requestId: string;
  sessionId: string;
  requestClient: string;
}): Record<string, string> {
  return {
    request_id: params.requestId,
    session_id: params.sessionId,
    request_client: params.requestClient,
  };
}

function ensureNonDiscordRequestId(requestId: string) {
  if (requestId.startsWith("discord:")) {
    throw new Error(`scheduled request_id must not use discord: prefix (got '${requestId}')`);
  }
}

function defaultJobSessionId(workflowId: string): string {
  return `job:${workflowId}`;
}

export async function startWorkflowScheduler(params: {
  bus: LilacBus;
  store: WorkflowStore;
  queries: WorkflowStoreQueries;
  subscriptionId: string;
  intervalMs?: number;
}) {
  const logger = new Logger({
    logLevel: resolveLogLevel(),
    module: "workflow-scheduler",
  });

  const intervalMs = params.intervalMs ?? 1000;

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const tick = async (nowMs = now()) => {
    if (running) return;
    running = true;
    try {
      const candidates = params.queries.listActiveTimeoutTasks(nowMs);
      if (candidates.length === 0) return;

      for (const candidate of candidates) {
        if (!candidate.timeoutAt) continue;
        if (candidate.timeoutAt > nowMs) continue;

        if (!isTimeWaitUntilTask(candidate) && !isTimeCronTask(candidate)) {
          continue;
        }

        const fresh = params.store.getTask(candidate.workflowId, candidate.taskId);
        if (!fresh) continue;
        if (!fresh.timeoutAt || fresh.timeoutAt > nowMs) continue;
        if (fresh.state === "resolved" || fresh.state === "failed" || fresh.state === "cancelled") {
          continue;
        }

        const claimed = params.store.tryClaimTimeoutTask({
          workflowId: fresh.workflowId,
          taskId: fresh.taskId,
          timeoutAt: fresh.timeoutAt,
          nowMs,
        });
        if (!claimed) continue;

        const claimedTask = params.store.getTask(fresh.workflowId, fresh.taskId);
        const w = params.store.getWorkflow(fresh.workflowId);
        if (!claimedTask || !w) {
          continue;
        }

        if (w.state === "resolved" || w.state === "failed" || w.state === "cancelled") {
          // If the workflow is terminal, ensure the trigger task can't fire again.
          const terminalState = w.state;
          const nextState: WorkflowTaskState =
            terminalState === "cancelled" ? "cancelled" : "cancelled";
          params.store.upsertTask({
            ...claimedTask,
            state: nextState,
            updatedAt: nowMs,
            resolvedAt: claimedTask.resolvedAt ?? nowMs,
            result:
              claimedTask.result ?? ({ kind: "terminal", workflowState: terminalState } as const),
          });
          await publishTaskLifecycle({
            bus: params.bus,
            workflowId: claimedTask.workflowId,
            taskId: claimedTask.taskId,
            state: nextState,
            detail: `workflow terminal (${terminalState})`,
          });
          continue;
        }

        if (!isScheduledWorkflow(w.definition)) {
          // Misconfigured: time-based tasks are only supported for v3 scheduled workflows.
          params.store.upsertTask({
            ...claimedTask,
            state: "failed",
            updatedAt: nowMs,
            resolvedAt: nowMs,
            result: {
              kind: "error",
              message: "time-based tasks require a v3 scheduled workflow definition",
            },
          });
          await publishTaskLifecycle({
            bus: params.bus,
            workflowId: claimedTask.workflowId,
            taskId: claimedTask.taskId,
            state: "failed",
            detail: "invalid workflow definition",
          });
          continue;
        }

        const wScheduled = w as WorkflowRecord & { definition: WorkflowDefinitionV3 };

        await handleScheduledTrigger({
          bus: params.bus,
          store: params.store,
          logger,
          nowMs,
          workflow: wScheduled,
          task: claimedTask,
        });
      }
    } finally {
      running = false;
    }
  };

  async function handleScheduledTrigger(input: {
    bus: LilacBus;
    store: WorkflowStore;
    logger: Logger;
    nowMs: number;
    workflow: WorkflowRecord & { definition: WorkflowDefinitionV3 };
    task: WorkflowTaskRecord;
  }) {
    const { bus, store, workflow, task, nowMs } = input;

    const bumped = store.bumpResumeSeq(workflow.workflowId);
    if (!bumped) {
      store.upsertTask({ ...task, state: "blocked", updatedAt: nowMs });
      return;
    }

    const runSeq = bumped.resumeSeq;
    const requestId = `wf:${workflow.workflowId}:${runSeq}`;
    ensureNonDiscordRequestId(requestId);

    const sessionId = defaultJobSessionId(workflow.workflowId);
    const requestClient = "unknown";

    const messages: ModelMessage[] = buildScheduledJobMessages({
      workflowId: workflow.workflowId,
      taskId: task.taskId,
      runSeq,
      firedAtMs: nowMs,
      definition: workflow.definition,
    });

    const data: CmdRequestMessageData = {
      queue: "prompt",
      messages,
      raw: {
        workflowId: workflow.workflowId,
        taskId: task.taskId,
        schedule: workflow.definition.schedule,
        firedAtMs: nowMs,
      },
    };

    await publishWorkflowLifecycle({
      bus,
      workflowId: workflow.workflowId,
      state: "running",
      detail: `trigger fired (${task.kind})`,
    });

    await bus.publish(lilacEventTypes.CmdRequestMessage, data, {
      headers: toRequestHeaders({ requestId, sessionId, requestClient }),
    });

    if (task.kind === "time.wait_until") {
      const tResolved: WorkflowTaskRecord = {
        ...task,
        state: "resolved",
        updatedAt: nowMs,
        resolvedAt: nowMs,
        resolvedBy: `time:${nowMs}`,
        result: {
          kind: "scheduled_fired",
          firedAtMs: nowMs,
          requestId,
        },
      };
      store.upsertTask(tResolved);

      const wResolved: WorkflowRecord = {
        ...workflow,
        state: "resolved",
        resolvedAt: nowMs,
        updatedAt: nowMs,
      };
      store.upsertWorkflow(wResolved);

      await publishTaskLifecycle({
        bus,
        workflowId: workflow.workflowId,
        taskId: task.taskId,
        state: "resolved",
        detail: "fired",
      });
      await publishTaskResolved({
        bus,
        workflowId: workflow.workflowId,
        taskId: task.taskId,
        result: tResolved.result,
      });
      await publishWorkflowLifecycle({
        bus,
        workflowId: workflow.workflowId,
        state: "resolved",
        detail: "scheduled workflow fired",
      });
      await publishWorkflowResolved({
        bus,
        workflowId: workflow.workflowId,
        result: { requestId },
      });
      return;
    }

    if (task.kind === "time.cron") {
      const cron = parseCronInput(task.input);
      if (!cron) {
        const failed: WorkflowTaskRecord = {
          ...task,
          state: "failed",
          updatedAt: nowMs,
          resolvedAt: nowMs,
          result: { kind: "error", message: "invalid cron input" },
        };
        store.upsertTask(failed);
        await publishTaskLifecycle({
          bus,
          workflowId: workflow.workflowId,
          taskId: task.taskId,
          state: "failed",
          detail: "invalid cron input",
        });
        await publishWorkflowLifecycle({
          bus,
          workflowId: workflow.workflowId,
          state: "failed",
          detail: "invalid cron input",
        });
        return;
      }

      let nextAtMs: number;
      try {
        nextAtMs = computeNextCronAtMs(
          {
            expr: cron.expr,
            tz: cron.tz,
            startAtMs: cron.startAtMs,
            skipMissed: cron.skipMissed,
          },
          nowMs,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const failed: WorkflowTaskRecord = {
          ...task,
          state: "failed",
          updatedAt: nowMs,
          resolvedAt: nowMs,
          result: { kind: "error", message: msg },
        };
        store.upsertTask(failed);
        await publishTaskLifecycle({
          bus,
          workflowId: workflow.workflowId,
          taskId: task.taskId,
          state: "failed",
          detail: msg,
        });
        await publishWorkflowLifecycle({
          bus,
          workflowId: workflow.workflowId,
          state: "failed",
          detail: msg,
        });
        return;
      }

      const updated: WorkflowTaskRecord = {
        ...task,
        state: "blocked",
        updatedAt: nowMs,
        timeoutAt: nextAtMs,
        result: {
          kind: "cron_tick",
          firedAtMs: nowMs,
          requestId,
          nextAtMs,
        },
      };
      store.upsertTask(updated);

      await publishTaskLifecycle({
        bus,
        workflowId: workflow.workflowId,
        taskId: task.taskId,
        state: "blocked",
        detail: `rescheduled nextAt=${nextAtMs}`,
      });
      await publishTaskResolved({
        bus,
        workflowId: workflow.workflowId,
        taskId: task.taskId,
        result: updated.result,
      });
      await publishWorkflowLifecycle({
        bus,
        workflowId: workflow.workflowId,
        state: "blocked",
        detail: "cron rescheduled",
      });
      return;
    }

    // Defensive: should never happen.
    store.upsertTask({ ...task, state: "blocked", updatedAt: nowMs });
  }

  if (intervalMs > 0) {
    timer = setInterval(() => {
      tick().catch((e: unknown) => {
        logger.error("scheduler tick failed", e);
      });
    }, intervalMs);
  }

  // Expose tick for tests / manual triggering.
  return {
    tick,
    stop: async () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
