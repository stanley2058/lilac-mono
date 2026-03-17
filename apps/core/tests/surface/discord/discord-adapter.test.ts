import { describe, expect, it } from "bun:test";
import { MessageType, type Message } from "discord.js";

import {
  DiscordAdapter,
  hasExplicitDiscordUserMentionInContent,
  isExplicitDiscordUserMention,
  isRoutableDiscordUserMessage,
  resolveDiscordSurfaceEditTarget,
  resolveOutputNotificationEnabled,
  resolveEffectiveSessionModelOverride,
} from "../../../src/surface/discord/discord-adapter";

function makeMessage(input: { bot: boolean; system: boolean; type: MessageType }): Message {
  return {
    author: { bot: input.bot },
    system: input.system,
    type: input.type,
  } as unknown as Message;
}

describe("isRoutableDiscordUserMessage", () => {
  it("accepts normal user chat messages", () => {
    const msg = makeMessage({
      bot: false,
      system: false,
      type: MessageType.Default,
    });

    expect(isRoutableDiscordUserMessage(msg)).toBe(true);
  });

  it("accepts user replies", () => {
    const msg = makeMessage({
      bot: false,
      system: false,
      type: MessageType.Reply,
    });

    expect(isRoutableDiscordUserMessage(msg)).toBe(true);
  });

  it("rejects non-chat/system message types", () => {
    const threadCreated = makeMessage({
      bot: false,
      system: false,
      type: MessageType.ThreadCreated,
    });
    const threadStarter = makeMessage({
      bot: false,
      system: false,
      type: MessageType.ThreadStarterMessage,
    });

    expect(isRoutableDiscordUserMessage(threadCreated)).toBe(false);
    expect(isRoutableDiscordUserMessage(threadStarter)).toBe(false);
  });

  it("rejects bot-authored and system messages", () => {
    const botMessage = makeMessage({
      bot: true,
      system: false,
      type: MessageType.Default,
    });
    const systemMessage = makeMessage({
      bot: false,
      system: true,
      type: MessageType.Default,
    });

    expect(isRoutableDiscordUserMessage(botMessage)).toBe(false);
    expect(isRoutableDiscordUserMessage(systemMessage)).toBe(false);
  });
});

describe("hasExplicitDiscordUserMentionInContent", () => {
  it("returns false when text has no explicit mention token", () => {
    expect(
      hasExplicitDiscordUserMentionInContent({
        content: "thanks for the help",
        userId: "42",
      }),
    ).toBe(false);
  });

  it("returns true for <@id> mention tokens", () => {
    expect(
      hasExplicitDiscordUserMentionInContent({
        content: "<@42> can you take a look?",
        userId: "42",
      }),
    ).toBe(true);
  });

  it("returns true for <@!id> nickname mention tokens", () => {
    expect(
      hasExplicitDiscordUserMentionInContent({
        content: "hey <@!42> please review",
        userId: "42",
      }),
    ).toBe(true);
  });
});

describe("isExplicitDiscordUserMention", () => {
  it("returns false when Discord did not parse a mention", () => {
    expect(
      isExplicitDiscordUserMention({
        content: "`<@42>`",
        userId: "42",
        hasParsedMention: false,
      }),
    ).toBe(false);
  });

  it("returns false when parsed mention exists but no explicit token in content", () => {
    expect(
      isExplicitDiscordUserMention({
        content: "thanks for the answer",
        userId: "42",
        hasParsedMention: true,
      }),
    ).toBe(false);
  });

  it("returns true when parsed mention and explicit token both exist", () => {
    expect(
      isExplicitDiscordUserMention({
        content: "<@42> please refine this",
        userId: "42",
        hasParsedMention: true,
      }),
    ).toBe(true);
  });
});

describe("resolveEffectiveSessionModelOverride", () => {
  it("uses thread override when present", () => {
    const overrides = new Map<string, string>([
      ["parent-1", "sonnet"],
      ["thread-1", "gpt-5"],
    ]);

    const result = resolveEffectiveSessionModelOverride({
      sessionId: "thread-1",
      parentChannelId: "parent-1",
      overrides,
    });

    expect(result).toBe("gpt-5");
  });

  it("inherits parent override when thread has none", () => {
    const overrides = new Map<string, string>([["parent-1", "sonnet"]]);

    const result = resolveEffectiveSessionModelOverride({
      sessionId: "thread-1",
      parentChannelId: "parent-1",
      overrides,
    });

    expect(result).toBe("sonnet");
  });

  it("returns undefined when neither session nor parent has override", () => {
    const result = resolveEffectiveSessionModelOverride({
      sessionId: "thread-1",
      parentChannelId: "parent-1",
      overrides: new Map<string, string>(),
    });

    expect(result).toBeUndefined();
  });
});

describe("resolveOutputNotificationEnabled", () => {
  it("defaults to enabled when config is unset", () => {
    expect(resolveOutputNotificationEnabled({})).toBe(true);
  });

  it("respects explicit config false", () => {
    expect(resolveOutputNotificationEnabled({ configured: false })).toBe(false);
  });

  it("forces notifications off when silent=true", () => {
    expect(resolveOutputNotificationEnabled({ configured: true, silent: true })).toBe(false);
  });
});

describe("resolveDiscordSurfaceEditTarget", () => {
  it("uses plain content for non-embed bot messages", () => {
    expect(
      resolveDiscordSurfaceEditTarget({
        authorId: "bot",
        selfUserId: "bot",
        embedCount: 0,
      }),
    ).toBe("content");
  });

  it("uses embed description for single-embed bot messages", () => {
    expect(
      resolveDiscordSurfaceEditTarget({
        authorId: "bot",
        selfUserId: "bot",
        embedCount: 1,
      }),
    ).toBe("embed_description");
  });

  it("prefers content when single-embed bot messages also have visible content", () => {
    expect(
      resolveDiscordSurfaceEditTarget({
        authorId: "bot",
        selfUserId: "bot",
        embedCount: 1,
        content: "visible content",
      }),
    ).toBe("content");
  });

  it("rejects non-bot-authored messages", () => {
    expect(() =>
      resolveDiscordSurfaceEditTarget({
        authorId: "user",
        selfUserId: "bot",
        embedCount: 1,
      }),
    ).toThrow("authored by the Lilac Discord bot");
  });

  it("rejects multi-embed messages", () => {
    expect(() =>
      resolveDiscordSurfaceEditTarget({
        authorId: "bot",
        selfUserId: "bot",
        embedCount: 2,
      }),
    ).toThrow("single embed");
  });
});

describe("DiscordAdapter.getHealthSnapshot", () => {
  it("samples current gateway ping state from discord.js shards", () => {
    const adapter = new DiscordAdapter();
    const adapterWithClient = adapter as unknown as {
      client: {
        ws: {
          ping: number;
          shards: Map<number, { lastPingTimestamp: number }>;
        };
      } | null;
    };

    adapterWithClient.client = {
      ws: {
        ping: 123,
        shards: new Map<number, { lastPingTimestamp: number }>([
          [0, { lastPingTimestamp: 1_000 }],
          [1, { lastPingTimestamp: 2_000 }],
        ]),
      },
    };

    const snapshot = adapter.getHealthSnapshot();

    expect(snapshot.gatewayPingMs).toBe(123);
    expect(snapshot.lastGatewayPingAt).toBe(2_000);
  });
});

describe("DiscordAdapter.editMsg", () => {
  it("replaces only the embed description for single-embed bot messages", async () => {
    const editCalls: Array<Record<string, unknown>> = [];
    const message = {
      author: { id: "bot" },
      embeds: [
        {
          toJSON: () => ({
            title: "keep-title",
            description: "old-description",
            fields: [{ name: "field-1", value: "value-1" }],
            footer: { text: "keep-footer" },
          }),
        },
      ],
      edit: async (options: Record<string, unknown>) => {
        editCalls.push(options);
      },
    } as unknown as Message;

    const adapter = new DiscordAdapter();
    (adapter as unknown as { client: unknown }).client = {
      user: { id: "bot" },
      channels: {
        fetch: async () => ({
          messages: {
            fetch: async () => message,
          },
        }),
      },
    };

    await adapter.editMsg(
      { platform: "discord", channelId: "c1", messageId: "m1" },
      { text: "new-description" },
    );

    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]?.content).toBeUndefined();

    const embeds = editCalls[0]?.embeds as Array<{ toJSON(): Record<string, unknown> }> | undefined;
    expect(embeds).toHaveLength(1);

    const edited = embeds?.[0]?.toJSON();
    expect(edited?.title).toBe("keep-title");
    expect(edited?.description).toBe("new-description");
    expect(edited?.fields).toEqual([{ name: "field-1", value: "value-1" }]);
    expect(edited?.footer).toEqual({ text: "keep-footer" });
  });

  it("fails for non-bot-authored messages", async () => {
    const message = {
      author: { id: "user" },
      embeds: [],
      edit: async () => undefined,
    } as unknown as Message;

    const adapter = new DiscordAdapter();
    (adapter as unknown as { client: unknown }).client = {
      user: { id: "bot" },
      channels: {
        fetch: async () => ({
          messages: {
            fetch: async () => message,
          },
        }),
      },
    };

    await expect(
      adapter.editMsg(
        { platform: "discord", channelId: "c1", messageId: "m1" },
        { text: "updated" },
      ),
    ).rejects.toThrow("authored by the Lilac Discord bot");
  });

  it("edits content when a bot message has visible content plus one embed", async () => {
    const editCalls: Array<Record<string, unknown>> = [];
    const message = {
      author: { id: "bot" },
      content: "old content",
      embeds: [
        {
          toJSON: () => ({
            title: "preview-title",
            description: "preview-description",
          }),
        },
      ],
      edit: async (options: Record<string, unknown>) => {
        editCalls.push(options);
      },
    } as unknown as Message;

    const adapter = new DiscordAdapter();
    (adapter as unknown as { client: unknown }).client = {
      user: { id: "bot" },
      channels: {
        fetch: async () => ({
          messages: {
            fetch: async () => message,
          },
        }),
      },
    };

    await adapter.editMsg(
      { platform: "discord", channelId: "c1", messageId: "m1" },
      { text: "new content" },
    );

    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]?.content).toBe("new content");
    expect(editCalls[0]?.embeds).toBeUndefined();
  });
});
