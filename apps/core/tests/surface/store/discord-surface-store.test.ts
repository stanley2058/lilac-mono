import { describe, expect, it } from "bun:test";

import { DiscordSurfaceStore } from "../../../src/surface/store/discord-surface-store";

describe("discord surface store message relations", () => {
  it("stores and reads relation metadata", () => {
    const store = new DiscordSurfaceStore(":memory:");

    store.upsertMessageRelation({
      channelId: "c1",
      messageId: "100",
      guildId: "g1",
      authorId: "u1",
      authorName: "alice",
      ts: 100,
      isChat: true,
      updatedTs: 1000,
    });

    store.upsertMessageRelation({
      channelId: "c1",
      messageId: "101",
      guildId: "g1",
      authorId: "u1",
      authorName: "alice",
      ts: 200,
      isChat: true,
      replyToChannelId: "c1",
      replyToMessageId: "100",
      updatedTs: 1001,
    });

    const row = store.getMessageRelation("c1", "101");
    expect(row?.reply_to_message_id).toBe("100");
    expect(row?.author_name).toBe("alice");
    expect(row?.is_chat).toBe(1);

    const list = store.listMessageRelationsBeforeOrAt({
      channelId: "c1",
      messageId: "101",
      limit: 10,
    });

    expect(list.map((m) => m.message_id)).toEqual(["100", "101"]);

    store.close();
  });

  it("marks relation rows deleted", () => {
    const store = new DiscordSurfaceStore(":memory:");

    store.upsertMessageRelation({
      channelId: "c1",
      messageId: "200",
      authorId: "u2",
      ts: 300,
      isChat: true,
      updatedTs: 2000,
    });

    store.markMessageRelationDeleted({
      channelId: "c1",
      messageId: "200",
      updatedTs: 2001,
    });

    const row = store.getMessageRelation("c1", "200");
    expect(row?.deleted).toBe(1);
    expect(row?.updated_ts).toBe(2001);

    const list = store.listMessageRelationsBeforeOrAt({
      channelId: "c1",
      messageId: "200",
      limit: 10,
    });
    expect(list).toEqual([]);

    store.close();
  });
});
