import {
  lilacEventTypes,
  type EvtAdapterMessageCreatedData,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";

import type { WorkflowTaskRecord } from "./types";
import type { WorkflowStore } from "./workflow-store";
import type { WorkflowStoreQueries } from "./workflow-store-queries";
import { matchDiscordWaitForReply } from "./discord-wait-for-reply";
import type { WorkflowTimeoutResult } from "./timeout";

async function publishTaskLifecycle(params: {
  bus: LilacBus;
  headers?: Record<string, string>;
  workflowId: string;
  taskId: string;
  state: "resolved" | "failed" | "cancelled" | "queued" | "running" | "blocked";
  detail?: string;
}) {
  await params.bus.publish(
    lilacEventTypes.EvtWorkflowTaskLifecycleChanged,
    {
      workflowId: params.workflowId,
      taskId: params.taskId,
      state: params.state,
      detail: params.detail,
      ts: Date.now(),
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
    { workflowId: params.workflowId, taskId: params.taskId, result: params.result },
    { headers: params.headers },
  );
}

export async function resolveDiscordWaitForReplyFromAdapterEvent(params: {
  bus: LilacBus;
  store: WorkflowStore;
  queries: WorkflowStoreQueries;
  evt: EvtAdapterMessageCreatedData;
  evtHeaders?: Record<string, string>;
  onTaskResolved: (workflowId: string, trigger: { evt: EvtAdapterMessageCreatedData; text: string }) => Promise<void>;
}) {
  const { bus, store, queries, evt } = params;
  if (evt.platform !== "discord") return;

  const candidates = queries.listActiveDiscordWaitForReplyTasksByChannelId(evt.channelId);
  if (candidates.length === 0) return;

  for (const task of candidates) {
    if (task.kind !== "discord.wait_for_reply") continue;
    if (task.discordChannelId !== evt.channelId) continue;
    if (!task.discordMessageId) continue;

    const matched = matchDiscordWaitForReply({
      evt,
      input: {
        channelId: task.discordChannelId ?? evt.channelId,
        messageId: task.discordMessageId,
        fromUserId: task.discordFromUserId,
      },
    });
    if (!matched) continue;

    const fresh = store.getTask(task.workflowId, task.taskId);
    if (!fresh) continue;

    // Idempotency: already resolved by this message.
    if (fresh.state === "resolved" && fresh.resolvedBy === matched.resolvedBy) {
      continue;
    }

    if (fresh.state === "resolved" || fresh.state === "failed" || fresh.state === "cancelled") {
      continue;
    }

    const updated: WorkflowTaskRecord = {
      ...fresh,
      state: "resolved",
      result: matched.result,
      resolvedAt: Date.now(),
      updatedAt: Date.now(),
      resolvedBy: matched.resolvedBy,
    };

    store.upsertTask(updated);

    await publishTaskLifecycle({
      bus,
      headers: params.evtHeaders,
      workflowId: updated.workflowId,
      taskId: updated.taskId,
      state: "resolved",
      detail: "resolved",
    });

    await publishTaskResolved({
      bus,
      headers: params.evtHeaders,
      workflowId: updated.workflowId,
      taskId: updated.taskId,
      result: updated.result,
    });

    await params.onTaskResolved(updated.workflowId, { evt, text: matched.result.text });
  }
}

export async function pollTimeouts(params: {
  bus: LilacBus;
  store: WorkflowStore;
  queries: WorkflowStoreQueries;
  onTaskResolved: (workflowId: string, trigger: { evt: EvtAdapterMessageCreatedData; text: string }) => Promise<void>;
}) {
  const nowMs = Date.now();
  const candidates = params.queries.listActiveTimeoutTasks(nowMs);
  if (candidates.length === 0) return;

  for (const task of candidates) {
    if (!task.timeoutAt) continue;

    const fresh = params.store.getTask(task.workflowId, task.taskId);
    if (!fresh) continue;

    if (fresh.state === "resolved" || fresh.state === "failed" || fresh.state === "cancelled") {
      continue;
    }

    const result: WorkflowTimeoutResult = {
      kind: "timeout",
      timeoutAt: task.timeoutAt,
      ts: nowMs,
    };

    const updated: WorkflowTaskRecord = {
      ...fresh,
      state: "resolved",
      result,
      resolvedAt: nowMs,
      updatedAt: nowMs,
      resolvedBy: `timeout:${nowMs}`,
    };

    params.store.upsertTask(updated);

    await publishTaskLifecycle({
      bus: params.bus,
      headers: undefined,
      workflowId: updated.workflowId,
      taskId: updated.taskId,
      state: "resolved",
      detail: "timeout",
    });

    await publishTaskResolved({
      bus: params.bus,
      headers: undefined,
      workflowId: updated.workflowId,
      taskId: updated.taskId,
      result: updated.result,
    });

    await params.onTaskResolved(updated.workflowId, {
      evt: {
        platform: "discord",
        channelId: updated.discordChannelId ?? "",
        messageId: updated.discordMessageId ?? "",
        userId: updated.discordFromUserId ?? "",
        userName: undefined,
        text: "<timeout>",
        ts: nowMs,
      },
      text: "<timeout>",
    });
  }
}
