import { describe, expect, it } from "bun:test";

import { createWorkflowStoreQueries } from "../../src/workflow/workflow-store-queries";
import { SqliteWorkflowStore } from "../../src/workflow/workflow-store";
import { shouldSuppressRouterForWorkflowReply } from "../../src/workflow/should-suppress-router-message";

describe("shouldSuppressRouterForWorkflowReply", () => {
  it("suppresses strict replies that match a wait_for_reply task (including resolved)", async () => {
    const store = new SqliteWorkflowStore(":memory:");
    const queries = createWorkflowStoreQueries(store);

    const now = Date.now();
    store.upsertTask({
      workflowId: "wf1",
      taskId: "t1",
      kind: "discord.wait_for_reply",
      description: "wait",
      state: "resolved",
      input: { channelId: "chan", messageId: "anchor" },
      result: { text: "ok" },
      createdAt: now,
      updatedAt: now,
      resolvedAt: now,
      resolvedBy: "reply1",
      discordChannelId: "chan",
      discordMessageId: "anchor",
      discordFromUserId: "u1",
    });

    const res = await shouldSuppressRouterForWorkflowReply({
      queries,
      evt: {
        platform: "discord",
        channelId: "chan",
        messageId: "reply1",
        userId: "u1",
        userName: "U",
        text: "hello",
        ts: now,
        raw: { discord: { replyToMessageId: "anchor" } },
      },
    });

    expect(res.suppress).toBe(true);
  });

  it("does not suppress when fromUserId does not match", async () => {
    const store = new SqliteWorkflowStore(":memory:");
    const queries = createWorkflowStoreQueries(store);

    const now = Date.now();
    store.upsertTask({
      workflowId: "wf1",
      taskId: "t1",
      kind: "discord.wait_for_reply",
      description: "wait",
      state: "queued",
      input: { channelId: "chan", messageId: "anchor", fromUserId: "u1" },
      createdAt: now,
      updatedAt: now,
      discordChannelId: "chan",
      discordMessageId: "anchor",
      discordFromUserId: "u1",
    });

    const res = await shouldSuppressRouterForWorkflowReply({
      queries,
      evt: {
        platform: "discord",
        channelId: "chan",
        messageId: "reply1",
        userId: "u2",
        userName: "U",
        text: "hello",
        ts: now,
        raw: { discord: { replyToMessageId: "anchor" } },
      },
    });

    expect(res.suppress).toBe(false);
  });

  it("does not suppress cancelled tasks", async () => {
    const store = new SqliteWorkflowStore(":memory:");
    const queries = createWorkflowStoreQueries(store);

    const now = Date.now();
    store.upsertTask({
      workflowId: "wf1",
      taskId: "t1",
      kind: "discord.wait_for_reply",
      description: "wait",
      state: "cancelled",
      input: { channelId: "chan", messageId: "anchor" },
      createdAt: now,
      updatedAt: now,
      discordChannelId: "chan",
      discordMessageId: "anchor",
    });

    const res = await shouldSuppressRouterForWorkflowReply({
      queries,
      evt: {
        platform: "discord",
        channelId: "chan",
        messageId: "reply1",
        userId: "u1",
        userName: "U",
        text: "hello",
        ts: now,
        raw: { discord: { replyToMessageId: "anchor" } },
      },
    });

    expect(res.suppress).toBe(false);
  });
});
