import type { WorkflowTaskRecord } from "./types";
import { SqliteWorkflowStore, type WorkflowStore } from "./workflow-store";

export type WorkflowStoreQueries = {
  listActiveDiscordWaitForReplyTasksByChannelId(
    channelId: string,
  ): WorkflowTaskRecord[];
  listActiveTimeoutTasks(nowMs: number): WorkflowTaskRecord[];
};

export function createWorkflowStoreQueries(
  store: WorkflowStore,
): WorkflowStoreQueries {
  // Default implementation uses listTasks per workflow; can be overridden.
  // Our concrete sqlite store implements a faster path via a cast.
  if (store instanceof SqliteWorkflowStore) {
    const sqlite = store;
    return {
      listActiveDiscordWaitForReplyTasksByChannelId: (channelId) =>
        sqlite.unsafeListActiveDiscordWaitForReplyTasksByChannelId(channelId),
      listActiveTimeoutTasks: (nowMs) =>
        sqlite.unsafeListActiveTimeoutTasks(nowMs),
    };
  }

  return {
    listActiveDiscordWaitForReplyTasksByChannelId: (_channelId) => {
      return [];
    },
    listActiveTimeoutTasks: (_nowMs) => {
      return [];
    },
  };
}
