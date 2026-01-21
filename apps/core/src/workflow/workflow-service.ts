import {
  lilacEventTypes,
  type CmdRequestMessageData,
  type EvtAdapterMessageCreatedData,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";

import { Logger, type LogLevel } from "@stanley2058/simple-module-logger";

import { createWorkflowStoreQueries } from "./workflow-store-queries";
import type { WorkflowStoreQueries } from "./workflow-store-queries";

import {
  pollTimeouts,
  resolveDiscordWaitForReplyFromAdapterEvent,
} from "./workflow-resolver";

import type {
  WorkflowDefinitionV2,
  WorkflowRecord,
  WorkflowTaskRecord,
  WorkflowTaskState,
  WorkflowState,
} from "./types";
import type { WorkflowStore } from "./workflow-store";
import { buildResumeRequest } from "./resume";
import { indexFieldsForTask } from "./index-fields";

function consumerId(prefix: string): string {
  return `${prefix}:${process.pid}:${Math.random().toString(16).slice(2)}`;
}

function now(): number {
  return Date.now();
}

function isWorkflowDefinitionV2(x: unknown): x is WorkflowDefinitionV2 {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (o.version !== 2) return false;

  const origin = o.origin;
  const resumeTarget = o.resumeTarget;

  if (!origin || typeof origin !== "object") return false;
  if (!resumeTarget || typeof resumeTarget !== "object") return false;

  const originRec = origin as Record<string, unknown>;
  const resumeRec = resumeTarget as Record<string, unknown>;

  if (typeof originRec.request_id !== "string") return false;
  if (typeof originRec.session_id !== "string") return false;
  if (typeof originRec.request_client !== "string") return false;

  if (typeof resumeRec.session_id !== "string") return false;
  if (typeof resumeRec.request_client !== "string") return false;

  if (typeof o.summary !== "string") return false;

  if (o.completion !== "all" && o.completion !== "any") return false;

  return true;
}

async function publishWorkflowLifecycle(params: {
  bus: LilacBus;
  headers?: Record<string, string>;
  workflowId: string;
  state: WorkflowState;
  detail?: string;
}) {
  await params.bus.publish(
    lilacEventTypes.EvtWorkflowLifecycleChanged,
    {
      workflowId: params.workflowId,
      state: params.state,
      detail: params.detail,
      ts: now(),
    },
    { headers: params.headers },
  );
}

async function publishTaskLifecycle(params: {
  bus: LilacBus;
  headers?: Record<string, string>;
  workflowId: string;
  taskId: string;
  state: WorkflowTaskState;
  detail?: string;
}) {
  await params.bus.publish(
    lilacEventTypes.EvtWorkflowTaskLifecycleChanged,
    {
      workflowId: params.workflowId,
      taskId: params.taskId,
      state: params.state,
      detail: params.detail,
      ts: now(),
    },
    { headers: params.headers },
  );
}

async function publishTaskResolved(params: {
  bus: LilacBus;
  headers?: Record<string, string>;
  workflowId: string;
  taskId: string;
  result: unknown;
}) {
  await params.bus.publish(
    lilacEventTypes.EvtWorkflowTaskResolved,
    {
      workflowId: params.workflowId,
      taskId: params.taskId,
      result: params.result,
    },
    { headers: params.headers },
  );
}

async function publishWorkflowResolved(params: {
  bus: LilacBus;
  headers?: Record<string, string>;
  workflowId: string;
  result: unknown;
}) {
  await params.bus.publish(
    lilacEventTypes.EvtWorkflowResolved,
    { workflowId: params.workflowId, result: params.result },
    { headers: params.headers },
  );
}

function canResolveWorkflow(
  def: WorkflowDefinitionV2,
  tasks: WorkflowTaskRecord[],
): boolean {
  const active = tasks.filter((t) => t.state !== "cancelled");
  if (active.length === 0) return false;

  const resolved = active.filter((t) => t.state === "resolved");

  if (def.completion === "all") {
    return resolved.length === active.length;
  }

  return resolved.length > 0;
}

function ensureNonDiscordRequestId(requestId: string) {
  if (requestId.startsWith("discord:")) {
    throw new Error(
      `resume request_id must not use discord: prefix (got '${requestId}')`,
    );
  }
}

function toRequestHeaders(resume: {
  requestId: string;
  sessionId: string;
  requestClient: string;
}): Record<string, string> {
  return {
    request_id: resume.requestId,
    session_id: resume.sessionId,
    request_client: resume.requestClient,
  };
}

export async function startWorkflowService(params: {
  bus: LilacBus;
  store: WorkflowStore;
  subscriptionId: string;
  pollTimeouts?: {
    enabled: boolean;
    intervalMs?: number;
  };
}) {
  const { bus, store, subscriptionId } = params;

  const logger = new Logger({
    logLevel: (process.env.LOG_LEVEL as LogLevel) ?? "info",
    module: "workflow-service",
  });
  const queries: WorkflowStoreQueries = createWorkflowStoreQueries(store);

  const pollIntervalMs = params.pollTimeouts?.intervalMs ?? 1000;
  let timeoutTimer: ReturnType<typeof setInterval> | null = null;

  const cmdSub = await bus.subscribeTopic(
    "cmd.workflow",
    {
      mode: "work",
      subscriptionId,
      consumerId: consumerId(subscriptionId),
      offset: { type: "begin" },
      batch: { maxWaitMs: 250 },
    },
    async (msg, ctx) => {
      if (msg.type === lilacEventTypes.CmdWorkflowCreate) {
        const workflowId = msg.data.workflowId;

        logger.info("workflow create", {
          workflowId,
          requestId: msg.headers?.request_id,
          sessionId: msg.headers?.session_id,
        });

        const defRaw = msg.data.definition;
        if (!isWorkflowDefinitionV2(defRaw)) {
          throw new Error(
            "cmd.workflow.create requires definition: WorkflowDefinitionV2",
          );
        }

        const existing = store.getWorkflow(workflowId);
        if (existing) {
          await ctx.commit();
          return;
        }

        const w: WorkflowRecord = {
          workflowId,
          state: "queued",
          createdAt: now(),
          updatedAt: now(),
          definition: defRaw,
          resumeSeq: 0,
        };

        store.upsertWorkflow(w);

        logger.info("workflow created", { workflowId });

        await publishWorkflowLifecycle({
          bus,
          headers: msg.headers,
          workflowId,
          state: "queued",
          detail: "created",
        });

        await ctx.commit();
        return;
      }

      if (msg.type === lilacEventTypes.CmdWorkflowTaskCreate) {
        const workflowId = msg.data.workflowId;
        const taskId = msg.data.taskId;

        logger.info("workflow task create", {
          workflowId,
          taskId,
          kind: msg.data.kind,
        });

        const w = store.getWorkflow(workflowId);
        if (!w) {
          throw new Error(`Unknown workflow '${workflowId}'`);
        }

        const existingTask = store.getTask(workflowId, taskId);
        if (existingTask) {
          await ctx.commit();
          return;
        }

        const indexed = indexFieldsForTask({
          kind: msg.data.kind,
          input: msg.data.input,
        });

        const t: WorkflowTaskRecord = {
          workflowId,
          taskId,
          kind: msg.data.kind,
          description: msg.data.description,
          state: "queued",
          input: msg.data.input,
          createdAt: now(),
          updatedAt: now(),
          ...indexed,
        };

        store.upsertTask(t);

        logger.info("workflow task created", {
          workflowId,
          taskId,
          kind: t.kind,
          state: t.state,
        });

        await publishTaskLifecycle({
          bus,
          headers: msg.headers,
          workflowId,
          taskId,
          state: "queued",
          detail: "created",
        });

        const wUpdated: WorkflowRecord = {
          ...w,
          state: "blocked",
          updatedAt: now(),
        };
        store.upsertWorkflow(wUpdated);
        await publishWorkflowLifecycle({
          bus,
          headers: msg.headers,
          workflowId,
          state: "blocked",
          detail: "waiting on tasks",
        });

        await ctx.commit();
        return;
      }

      if (msg.type === lilacEventTypes.CmdWorkflowCancel) {
        const workflowId = msg.data.workflowId;

        logger.info("workflow cancel", {
          workflowId,
          reason: msg.data.reason,
        });
        const w = store.getWorkflow(workflowId);
        if (!w) {
          await ctx.commit();
          return;
        }

        if (
          w.state === "resolved" ||
          w.state === "failed" ||
          w.state === "cancelled"
        ) {
          await ctx.commit();
          return;
        }

        const updated: WorkflowRecord = {
          ...w,
          state: "cancelled",
          updatedAt: now(),
        };
        store.upsertWorkflow(updated);

        logger.info("workflow cancelled", { workflowId });

        await publishWorkflowLifecycle({
          bus,
          headers: msg.headers,
          workflowId,
          state: "cancelled",
          detail: msg.data.reason ?? "cancelled",
        });

        const tasks = store.listTasks(workflowId);
        for (const t of tasks) {
          if (
            t.state === "resolved" ||
            t.state === "failed" ||
            t.state === "cancelled"
          )
            continue;
          const tu: WorkflowTaskRecord = {
            ...t,
            state: "cancelled",
            updatedAt: now(),
          };
          store.upsertTask(tu);
          await publishTaskLifecycle({
            bus,
            headers: msg.headers,
            workflowId,
            taskId: t.taskId,
            state: "cancelled",
            detail: msg.data.reason ?? "cancelled",
          });
        }

        await ctx.commit();
        return;
      }

      await ctx.commit();
    },
  );

  const adapterSub = await bus.subscribeTopic(
    "evt.adapter",
    {
      mode: "fanout",
      subscriptionId: `${subscriptionId}:adapter`,
      consumerId: consumerId(`${subscriptionId}:adapter`),
      offset: { type: "now" },
      batch: { maxWaitMs: 250 },
    },
    async (msg, ctx) => {
      if (msg.type !== lilacEventTypes.EvtAdapterMessageCreated) {
        await ctx.commit();
        return;
      }

        await resolveDiscordWaitForReplyFromAdapterEvent({
          bus,
          store,
          queries,
          evt: msg.data,
          evtHeaders: msg.headers,
          onTaskResolved: async (workflowId, trigger) => {
            logger.info("workflow task resolved (reply)", {
              workflowId,
              channelId: trigger.evt.channelId,
              messageId: trigger.evt.messageId,
              userId: trigger.evt.userId,
            });

            logger.debug("workflow task resolved text", {
              workflowId,
              text:
                trigger.text.length > 200
                  ? `${trigger.text.slice(0, 200)}...`
                  : trigger.text,
            });
            await tryResolveWorkflow({
              bus,
              store,
              logger,
              workflowId,
              triggerEvt: trigger.evt,
              triggerUserText: trigger.text,
            });
          },
      });

      await ctx.commit();
    },
  );

  if (params.pollTimeouts?.enabled) {
    timeoutTimer = setInterval(() => {
      pollTimeouts({
        bus,
        store,
        queries,
        onTaskResolved: async (workflowId, trigger) => {
          logger.info("workflow task resolved (timeout)", {
            workflowId,
          });

          logger.debug("workflow task resolved text", {
            workflowId,
            text: trigger.text,
          });
          await tryResolveWorkflow({
            bus,
            store,
            logger,
            workflowId,
            triggerEvt: trigger.evt,
            triggerUserText: trigger.text,
          });
        },
      }).catch((e: unknown) => {
        logger.error("workflow timeout polling failed", e);
      });
    }, pollIntervalMs);
  }

  return {
    stop: async () => {
      if (timeoutTimer) {
        clearInterval(timeoutTimer);
        timeoutTimer = null;
      }
      await cmdSub.stop();
      await adapterSub.stop();
    },
  };
}

async function tryResolveWorkflow(params: {
  bus: LilacBus;
  store: WorkflowStore;
  logger: Logger;
  workflowId: string;
  triggerEvt: EvtAdapterMessageCreatedData;
  triggerUserText: string;
}) {
  const { bus, store, workflowId, logger } = params;

  const w = store.getWorkflow(workflowId);
  if (!w) return;

  if (w.state === "resolved" || w.state === "failed" || w.state === "cancelled")
    return;

  const tasks = store.listTasks(workflowId);

  if (!canResolveWorkflow(w.definition, tasks)) {
    return;
  }

  // Mark resolved and bump resume seq.
  const wResolved: WorkflowRecord = {
    ...w,
    state: "resolved",
    resolvedAt: now(),
    updatedAt: now(),
  };
  store.upsertWorkflow(wResolved);

  logger.info("workflow resolved", {
    workflowId,
    taskCount: tasks.length,
    completion: w.definition.completion,
  });

  await publishWorkflowLifecycle({
    bus,
    headers: undefined,
    workflowId,
    state: "resolved",
    detail: "workflow resolved",
  });

  await publishWorkflowResolved({
    bus,
    headers: undefined,
    workflowId,
    result: { tasks },
  });

  // Do not publish resume twice.
  if (wResolved.resumePublishedAt) {
    return;
  }

  const bumped = store.bumpResumeSeq(workflowId);
  if (!bumped) return;

  const requestId = `wf:${workflowId}:${bumped.resumeSeq}`;
  ensureNonDiscordRequestId(requestId);

  logger.info("publishing resume request", {
    workflowId,
    requestId,
    sessionId: bumped.definition.resumeTarget.session_id,
    requestClient: bumped.definition.resumeTarget.request_client,
  });

  const resume = buildResumeRequest({
    workflow: bumped,
    tasks: store.listTasks(workflowId),
    triggerUserText: params.triggerUserText,
    triggerMeta: {
      platform: params.triggerEvt.platform,
      channelId: params.triggerEvt.channelId,
      messageId: params.triggerEvt.messageId,
      userId: params.triggerEvt.userId,
      userName: params.triggerEvt.userName,
      ts: params.triggerEvt.ts,
    },
    requestId,
  });

  const data: CmdRequestMessageData = {
    queue: resume.queue,
    messages: resume.messages,
    raw: resume.raw,
  };

  await bus.publish(lilacEventTypes.CmdRequestMessage, data, {
    headers: toRequestHeaders({
      requestId: resume.requestId,
      sessionId: resume.sessionId,
      requestClient: resume.requestClient,
    }),
  });

  const after = store.getWorkflow(workflowId);
  if (after) {
    store.upsertWorkflow({
      ...after,
      resumePublishedAt: now(),
      updatedAt: now(),
    });
  }
}
