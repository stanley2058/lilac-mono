import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { Result } from "better-result";
import type { BlobRefV1 } from "@stanley2058/lilac-blob-storage";
import type { LimitOpts, SessionRef, SurfaceMessage } from "../../../src/surface/types";
import {
  DISCORD_SEARCH_NEW_MESSAGE_HEAL_LIMIT,
  DiscordSearchService,
  DiscordSearchStore,
} from "../../../src/surface/store/discord-search-store";

class FakeSearchAdapter {
  public listCalls: Array<{ sessionRef: SessionRef; opts?: LimitOpts }> = [];

  constructor(private readonly messagesByChannelId: Record<string, SurfaceMessage[]>) {}

  async listMsg(sessionRef: SessionRef, opts?: LimitOpts) {
    this.listCalls.push({ sessionRef, opts });
    const messages = this.messagesByChannelId[sessionRef.channelId] ?? [];
    return Result.ok(messages.slice(0, opts?.limit ?? 50));
  }
}

describe("discord search store", () => {
  it("lists cached messages before an exact Discord position", () => {
    const store = new DiscordSearchStore(":memory:");
    const message = (messageId: string, ts: number): SurfaceMessage => ({
      ref: { platform: "discord", channelId: "123", messageId },
      session: { platform: "discord", channelId: "123" },
      userId: "u1",
      text: messageId,
      ts,
      raw: {},
    });

    try {
      store.upsertMessages([message("m1", 1), message("m2", 2), message("m3", 3)]);
      expect(
        store
          .listIndexedMessagesBefore({
            channelId: "123",
            before: { messageId: "m3", ts: 3 },
            limit: 2,
          })
          .map((entry) => entry.ref.messageId),
      ).toEqual(["m1", "m2"]);
    } finally {
      store.close();
    }
  });

  it("persists an expiring attachment cache reference without changing message freshness", () => {
    const originalDateNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    const store = new DiscordSearchStore(":memory:");
    const message: SurfaceMessage = {
      ref: { platform: "discord", channelId: "123", messageId: "m1" },
      session: { platform: "discord", channelId: "123" },
      userId: "u1",
      text: "attachment",
      ts: 1,
      raw: {
        attachments: [
          {
            id: "a1",
            url: "https://cdn.discordapp.com/attachments/1/2/image.png?ex=secret",
            filename: "image.png",
            mimeType: "image/png",
            size: 123,
          },
        ],
      },
    };
    const blob: BlobRefV1 = {
      version: 1,
      objectId: `b1_${"1".repeat(32)}`,
      sha256: "a".repeat(64),
      byteLength: 123,
      expiresAt: 86_401_000,
    };

    try {
      expect(store.upsertMessages([message])).toBe(1);
      store.putAttachmentCache({
        channelId: "123",
        messageId: "m1",
        ordinal: 0,
        attachmentId: "a1",
        blob,
        cachedAt: now,
      });

      expect(
        store.getAttachmentCache({
          channelId: "123",
          messageId: "m1",
          ordinal: 0,
          attachmentId: "a1",
        }),
      ).toEqual({ blob, cachedAt: 1_000 });
      expect(store.getIndexedMessage({ channelId: "123", messageId: "m1" })?.attachments).toEqual([
        {
          id: "a1",
          filename: "image.png",
          mimeType: "image/png",
          size: 123,
          cache: { blob, cachedAt: 1_000 },
        },
      ]);

      const durableBlob: BlobRefV1 = {
        version: 1,
        objectId: `b1_${"2".repeat(32)}`,
        sha256: "b".repeat(64),
        byteLength: 123,
      };
      store.putAttachmentCache({
        channelId: "123",
        messageId: "m1",
        ordinal: 0,
        attachmentId: "a1",
        blob: durableBlob,
        cachedAt: now,
      });
      expect(
        store.getAttachmentCache({
          channelId: "123",
          messageId: "m1",
          ordinal: 0,
          attachmentId: "a1",
        }),
      ).toEqual({ blob: durableBlob, cachedAt: 1_000 });

      now = 2_000;
      expect(store.upsertMessages([{ ...message, text: "edited text" }])).toBe(1);
      expect(
        store.getAttachmentCache({
          channelId: "123",
          messageId: "m1",
          ordinal: 0,
          attachmentId: "a1",
        }),
      ).toEqual({ blob: durableBlob, cachedAt: 1_000 });
    } finally {
      store.close();
      Date.now = originalDateNow;
    }
  });

  it("detaches and reports a cached blob when attachment metadata is pruned", () => {
    const pruned: BlobRefV1[] = [];
    const store = new DiscordSearchStore(":memory:", {
      onAttachmentCachePruned: (blob) => pruned.push(blob),
    });
    const message: SurfaceMessage = {
      ref: { platform: "discord", channelId: "123", messageId: "m1" },
      session: { platform: "discord", channelId: "123" },
      userId: "u1",
      text: "attachment",
      ts: 1,
      raw: {
        attachments: [
          {
            id: "a1",
            url: "https://cdn.discordapp.com/attachments/1/2/image.png",
            filename: "image.png",
          },
        ],
      },
    };
    const blob: BlobRefV1 = {
      version: 1,
      objectId: `b1_${"2".repeat(32)}`,
      sha256: "b".repeat(64),
      byteLength: 5,
      expiresAt: 86_401_000,
    };

    store.upsertMessages([message]);
    store.putAttachmentCache({
      channelId: "123",
      messageId: "m1",
      ordinal: 0,
      attachmentId: "a1",
      blob,
      cachedAt: 1_000,
    });
    store.upsertMessages([{ ...message, raw: { attachments: [] } }]);

    expect(pruned).toEqual([blob]);
    expect(store.listMessageAttachments("123", "m1")).toEqual([]);
    store.close();
  });

  it("does not treat reported attachment MIME or size changes as identity changes", () => {
    const pruned: BlobRefV1[] = [];
    const store = new DiscordSearchStore(":memory:", {
      onAttachmentCachePruned: (blob) => pruned.push(blob),
    });
    const message: SurfaceMessage = {
      ref: { platform: "discord", channelId: "123", messageId: "m1" },
      session: { platform: "discord", channelId: "123" },
      userId: "u1",
      text: "attachment",
      ts: 1,
      raw: {
        attachments: [
          {
            id: "a1",
            url: "https://cdn.discordapp.com/attachments/1/2/diagram.webp",
            filename: "diagram.webp",
            mimeType: "image/webp",
            size: 123,
          },
        ],
      },
    };
    const blob: BlobRefV1 = {
      version: 1,
      objectId: `b1_${"3".repeat(32)}`,
      sha256: "c".repeat(64),
      byteLength: 456,
    };

    try {
      expect(store.upsertMessages([message])).toBe(1);
      store.putAttachmentCache({
        channelId: "123",
        messageId: "m1",
        ordinal: 0,
        attachmentId: "a1",
        blob,
        cachedAt: 1_000,
      });

      expect(
        store.upsertMessages([
          {
            ...message,
            raw: {
              attachments: [
                {
                  id: "a1",
                  url: "https://cdn.discordapp.com/attachments/1/2/diagram.webp",
                  filename: "diagram.webp",
                  mimeType: "image/png",
                  size: 456,
                },
              ],
            },
          },
        ]),
      ).toBe(0);
      expect(pruned).toEqual([]);
      expect(
        store.getAttachmentCache({
          channelId: "123",
          messageId: "m1",
          ordinal: 0,
          attachmentId: "a1",
        }),
      ).toEqual({ blob, cachedAt: 1_000 });
    } finally {
      store.close();
    }
  });

  it("does not advance freshness when re-upserting identical messages", () => {
    const originalDateNow = Date.now;
    let now = 1_000;
    Date.now = () => now;

    const store = new DiscordSearchStore(":memory:");
    const message: SurfaceMessage = {
      ref: { platform: "discord", channelId: "123", messageId: "m1" },
      session: { platform: "discord", channelId: "123" },
      userId: "u1",
      userName: "user one",
      text: "deploy completed",
      ts: 1,
    };

    try {
      expect(store.upsertMessages([message])).toBe(1);
      const first = store.listMessagesForDiscovery()[0]?.updatedTs;

      now = 2_000;
      expect(store.upsertMessages([message])).toBe(0);
      const unchanged = store.listMessagesForDiscovery()[0]?.updatedTs;
      expect(unchanged).toBe(first);

      expect(store.upsertMessages([{ ...message, text: "deploy completed successfully" }])).toBe(1);
      const changed = store.listMessagesForDiscovery()[0]?.updatedTs;
      expect(changed).toBe(2_000);
    } finally {
      store.close();
      Date.now = originalDateNow;
    }
  });

  it("persists stable attachment metadata without signed URLs", () => {
    const store = new DiscordSearchStore(":memory:");
    const message: SurfaceMessage = {
      ref: { platform: "discord", channelId: "123", messageId: "m1" },
      session: { platform: "discord", channelId: "123" },
      userId: "u1",
      text: "",
      ts: 1,
      raw: {
        attachments: [
          {
            id: "a1",
            url: "https://cdn.discordapp.com/attachments/1/2/image.png?ex=secret",
            filename: "image.png",
            mimeType: "image/png",
            size: 123,
          },
        ],
      },
    };

    expect(store.upsertMessages([message])).toBe(1);
    expect(store.getIndexedMessage({ channelId: "123", messageId: "m1" })?.attachments).toEqual([
      { id: "a1", filename: "image.png", mimeType: "image/png", size: 123 },
    ]);
    expect(store.upsertMessages([message])).toBe(0);
    expect(
      store.upsertMessages([
        {
          ...message,
          raw: {
            attachments: [
              {
                id: "a2",
                url: "https://cdn.discordapp.com/attachments/1/2/other.png?ex=other",
                filename: "other.png",
                mimeType: "image/png",
                size: 456,
              },
            ],
          },
        },
      ]),
    ).toBe(1);
    store.close();
  });

  it("returns message mutations for inserts, edits, and duplicate updates", () => {
    const store = new DiscordSearchStore(":memory:");
    const service = new DiscordSearchService({
      adapter: new FakeSearchAdapter({}),
      store,
    });
    const message: SurfaceMessage = {
      ref: { platform: "discord", channelId: "123", messageId: "m1" },
      session: { platform: "discord", channelId: "123" },
      userId: "u1",
      text: "deploy started",
      ts: 1,
    };

    try {
      const inserted = service.onMessageUpdated(message);
      expect(inserted?.before).toBeNull();
      expect(inserted?.after?.text).toBe("deploy started");
      expect(inserted?.changed).toBe(true);

      const edited = service.onMessageUpdated({
        ...message,
        text: "deploy completed",
        editedTs: 2,
      });
      expect(edited?.before?.text).toBe("deploy started");
      expect(edited?.after?.text).toBe("deploy completed");
      expect(edited?.changed).toBe(true);

      const duplicate = service.onMessageUpdated({
        ...message,
        text: "deploy completed",
        editedTs: 2,
      });
      expect(duplicate?.before).toEqual(duplicate?.after);
      expect(duplicate?.changed).toBe(false);
    } finally {
      store.close();
    }
  });

  it("heals recent history on create and respects cooldown", async () => {
    const adapter = new FakeSearchAdapter({
      "123": [
        {
          ref: { platform: "discord", channelId: "123", messageId: "m1" },
          session: { platform: "discord", channelId: "123" },
          userId: "u1",
          text: "deploy completed",
          ts: 1,
        },
      ],
    });

    const store = new DiscordSearchStore(":memory:");
    const service = new DiscordSearchService({ adapter, store });

    await service.onMessageCreated({
      ref: { platform: "discord", channelId: "123", messageId: "seed-1" },
      session: { platform: "discord", channelId: "123" },
      userId: "u1",
      text: "hello",
      ts: 10,
    });

    await service.onMessageCreated({
      ref: { platform: "discord", channelId: "123", messageId: "seed-2" },
      session: { platform: "discord", channelId: "123" },
      userId: "u1",
      text: "world",
      ts: 11,
    });

    expect(adapter.listCalls.length).toBe(1);
    expect(adapter.listCalls[0]?.opts?.limit).toBe(DISCORD_SEARCH_NEW_MESSAGE_HEAL_LIMIT);

    store.close();
  });
});

it("rebuilds a newly created external-content FTS index over retained messages", () => {
  const root = mkdtempSync(join(tmpdir(), "lilac-fts-"));
  const path = join(root, "search.db");
  const store = new DiscordSearchStore(path);
  store.upsertMessages([
    {
      ref: { platform: "discord", channelId: "123", messageId: "m" },
      session: { platform: "discord", channelId: "123" },
      userId: "u",
      text: "retainedneedle",
      ts: 1,
      raw: {},
    },
  ]);
  store.close();
  const db = new Database(path);
  db.run(
    "DROP TRIGGER discord_search_messages_ai; DROP TRIGGER discord_search_messages_ad; DROP TRIGGER discord_search_messages_au; DROP TABLE discord_search_messages_fts",
  );
  db.close();
  const reopened = new DiscordSearchStore(path);
  const probe = new Database(path);
  expect(
    probe
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM discord_search_messages_fts WHERE discord_search_messages_fts MATCH 'retainedneedle'",
      )
      .get()?.count,
  ).toBe(1);
  probe.close();
  reopened.close();
  rmSync(root, { recursive: true });
});
