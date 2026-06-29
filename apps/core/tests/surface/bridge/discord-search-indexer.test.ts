import { describe, expect, it } from "bun:test";
import { parseCoreConfigV1ToUniversal, type CoreConfig } from "@stanley2058/lilac-utils";

import type { SurfaceAdapter, AdapterEventHandler } from "../../../src/surface/adapter";
import type { AdapterEvent } from "../../../src/surface/events";
import { startDiscordSearchIndexer } from "../../../src/surface/bridge/discord-search-indexer";
import type { SurfaceMessage } from "../../../src/surface/types";

class FakeAdapter {
  handler: AdapterEventHandler | null = null;

  async subscribe(handler: AdapterEventHandler) {
    this.handler = handler;
    return { stop: async () => {} };
  }
}

function testConfig(): CoreConfig {
  return parseCoreConfigV1ToUniversal({
    surface: {
      discord: {
        botName: "lilac",
        allowedChannelIds: ["c1"],
      },
      router: {
        defaultMode: "mention",
        sessionModes: {},
      },
    },
  });
}

function discordMessage(): SurfaceMessage {
  return {
    ref: { platform: "discord", channelId: "c1", messageId: "m1" },
    session: { platform: "discord", channelId: "c1", guildId: "g1" },
    userId: "u1",
    text: "hello",
    ts: 1,
  };
}

describe("discord search indexer", () => {
  it("passes current config into conversation thread refreshes", async () => {
    const adapter = new FakeAdapter();
    const cfg = testConfig();
    const createdMessages: SurfaceMessage[] = [];
    const refreshConfigs: Array<CoreConfig | undefined> = [];

    await startDiscordSearchIndexer({
      adapter: adapter as unknown as SurfaceAdapter,
      search: {
        async onMessageCreated(message) {
          createdMessages.push(message);
        },
        onMessageUpdated() {},
        onMessageDeleted() {},
      },
      getConfig: async () => cfg,
      conversationThreads: {
        refreshThreads(inputCfg) {
          refreshConfigs.push(inputCfg);
          return { channels: 1, threads: 1, messages: 1 };
        },
      },
    });

    const evt: AdapterEvent = {
      type: "adapter.message.created",
      platform: "discord",
      ts: 1,
      message: discordMessage(),
    };

    await adapter.handler?.(evt);

    expect(createdMessages).toHaveLength(1);
    expect(refreshConfigs).toEqual([cfg]);
  });
});
