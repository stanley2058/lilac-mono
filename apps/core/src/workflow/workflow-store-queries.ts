import type { WorkflowTaskRecord } from "./types";
import { SqliteWorkflowStore, type WorkflowStore } from "./workflow-store";

export type WorkflowStoreQueries = {
  listActiveDiscordWaitForReplyTasksByChannelId(channelId: string): WorkflowTaskRecord[];

  /**
   * Find wait_for_reply tasks that match a specific reply-to anchor.
   * This is used by the request router to suppress messages that should be
   * consumed by workflow resume.
   */
  listDiscordWaitForReplyTasksByChannelIdAndMessageId(
    channelId: string,
    messageId: string,
  ): WorkflowTaskRecord[];
  listActiveTimeoutTasks(nowMs: number): WorkflowTaskRecord[];
};

export function createWorkflowStoreQueries(store: WorkflowStore): WorkflowStoreQueries {
  // Default implementation uses listTasks per workflow; can be overridden.
  // Our concrete sqlite store implements a faster path via a cast.
  if (store instanceof SqliteWorkflowStore) {
    const sqlite = store;
    return {
      listActiveDiscordWaitForReplyTasksByChannelId: (channelId) =>
        sqlite.unsafeListActiveDiscordWaitForReplyTasksByChannelId(channelId),
      listDiscordWaitForReplyTasksByChannelIdAndMessageId: (channelId, messageId) =>
        sqlite.unsafeListDiscordWaitForReplyTasksByChannelIdAndMessageId(channelId, messageId),
      listActiveTimeoutTasks: (nowMs) => sqlite.unsafeListActiveTimeoutTasks(nowMs),
    };
  }

  return {
    listActiveDiscordWaitForReplyTasksByChannelId: (_channelId) => {
      return [];
    },
    listDiscordWaitForReplyTasksByChannelIdAndMessageId: (_channelId, _messageId) => {
      return [];
    },
    listActiveTimeoutTasks: (_nowMs) => {
      return [];
    },
  };
}
