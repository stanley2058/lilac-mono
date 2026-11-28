import { describe, expect, it } from "bun:test";

import { DiscordSurfaceStore } from "../../../src/surface/store/discord-surface-store";

describe("discord surface store message relations", () => {
  it("orders sessions by messages rather than metadata refreshes", () => {
    const store = new DiscordSurfaceStore(":memory:");
    for (const [channelId, ts, updatedTs] of [
      ["older", 100, 900],
      ["newer", 200, 300],
    ] as const) {
      store.upsertSession({ channelId, type: "thread", updatedTs });
      store.upsertMessageRelation({
        channelId,
        messageId: channelId,
        authorId: "user",
        ts,
        isChat: true,
        updatedTs,
      });
    }
    expect(
      store.listSessions().map((session) => [session.channel_id, session.activity_ts]),
    ).toEqual([
      ["newer", 200],
      ["older", 100],
    ]);
    store.close();
  });
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

describe("discord surface store relays", () => {
  const relay = {
    nonce: "nonce-1",
    channelId: "c1",
    sourcePlatform: "native",
    sourceThreadId: "web",
    sourceUserId: "owner",
    discordUserId: "d-owner",
    mode: "steer",
    createdTs: 1,
  };

  it("keeps the first relay row for a retried nonce and binds its message once", () => {
    const store = new DiscordSurfaceStore(":memory:");

    expect(store.insertRelayMessage(relay)).toMatchObject({ message_id: null });
    store.bindRelayMessage({ nonce: "nonce-1", channelId: "c1", messageId: "m1", ts: 2 });
    store.bindRelayMessage({ nonce: "nonce-1", channelId: "c1", messageId: "m2", ts: 3 });

    expect(store.insertRelayMessage({ ...relay, sourceThreadId: "other" })).toMatchObject({
      message_id: "m1",
      source_thread_id: "web",
    });
    expect(store.getRelayMessageByMessageId("c1", "m1")).toMatchObject({ nonce: "nonce-1" });
    expect(store.getRelayMessageByMessageId("c1", "m2")).toBeNull();
    store.close();
  });

  it("lists a channel's relay sources from its relay and output refs", () => {
    const store = new DiscordSurfaceStore(":memory:");
    store.insertRelayMessage(relay);
    store.insertRelayMessage({ ...relay, nonce: "nonce-2", channelId: "c2", sourceThreadId: "t2" });
    store.bindRelayMessage({ nonce: "nonce-1", channelId: "c1", messageId: "m1", ts: 2 });
    store.insertRelayRef({
      channelId: "c1",
      messageId: "out",
      nonce: "nonce-1",
      kind: "output",
      ts: 3,
    });

    expect(store.listRelaySourcesForChannel("c1")).toEqual([
      { source_platform: "native", source_thread_id: "web", source_user_id: "owner" },
    ]);
    expect(store.listRelaySourcesForChannel("c2")).toEqual([]);
    store.close();
  });

  it("keeps the first reported result for a nonce", () => {
    const store = new DiscordSurfaceStore(":memory:");
    store.insertRelayResult({ nonce: "n", disposition: "steered", messageId: "m1", runId: "r1" });
    store.insertRelayResult({ nonce: "n", disposition: "started", messageId: "m2" });

    expect(store.getRelayResult("n")).toEqual({
      nonce: "n",
      disposition: "steered",
      message_id: "m1",
      run_id: "r1",
    });
    store.close();
  });
});
