import { describe, expect, it } from "bun:test";
import type { Client } from "discord.js";

import {
  DiscordOutputStream,
  buildOutputAllowedMentions,
  buildThinkingDisplay,
  clampReasoningDetail,
  escapeDiscordMarkdown,
  formatReasoningAsBlockquote,
  toPreviewTail,
} from "../../../../src/surface/discord/output/discord-output-stream";

describe("escapeDiscordMarkdown", () => {
  it("escapes emphasis markers in glob-like patterns", () => {
    expect(escapeDiscordMarkdown("**/*")).toBe("\\*\\*/\\*");
  });

  it("escapes common markdown control characters", () => {
    expect(escapeDiscordMarkdown("[x](y) _z_ `k` ~u~")).toBe(
      "\\[x\\]\\(y\\) \\_z\\_ \\`k\\` \\~u\\~",
    );
  });
});

function createFakeDiscordClient(): {
  client: Client;
  createdMessageIds: string[];
  deletedMessageIds: string[];
} {
  type FakeMessage = {
    readonly id: string;
    readonly channelId: string;
    edit(options: unknown): Promise<FakeMessage>;
    reply(options: unknown): Promise<FakeMessage>;
    delete(): Promise<void>;
  };

  const deletedMessageIds: string[] = [];
  const createdMessageIds: string[] = [];
  const messages = new Map<string, FakeMessage>();
  let nextMessageId = 1;
  const channelId = "chan";

  const createMessage = (): FakeMessage => {
    const id = `m_${nextMessageId++}`;
    createdMessageIds.push(id);
    const message: FakeMessage = {
      id,
      channelId,
      edit: async (_options) => message,
      reply: async (_options) => createMessage(),
      delete: async () => {
        deletedMessageIds.push(id);
        messages.delete(id);
      },
    };

    messages.set(id, message);
    return message;
  };

  const channel = {
    send: async (_options: unknown) => createMessage(),
    messages: {
      fetch: async (messageId: string) => messages.get(messageId) ?? null,
    },
  };

  const client = {
    channels: {
      fetch: async (id: string) => (id === channelId ? channel : null),
    },
  };

  return {
    client: client as unknown as Client,
    createdMessageIds,
    deletedMessageIds,
  };
}

describe("preview reanchor behavior", () => {
  it("keeps frozen placeholder lane messages on reanchor", async () => {
    const { client, createdMessageIds, deletedMessageIds } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      reasoningDisplayMode: "none",
    });

    await out.push({ type: "text.delta", delta: "hello" });
    await out.abort("reanchor");

    expect(createdMessageIds.length).toBeGreaterThan(0);
    expect(out.getFinalTextMode()).toBe("full");
    expect(deletedMessageIds).toEqual([]);
  });

  it("keeps frozen placeholder lane messages on interrupt reanchor", async () => {
    const { client, createdMessageIds, deletedMessageIds } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      reasoningDisplayMode: "none",
    });

    await out.push({ type: "text.delta", delta: "hello" });
    await out.abort("reanchor_interrupt");

    expect(createdMessageIds.length).toBeGreaterThan(0);
    expect(deletedMessageIds).toEqual([]);
  });

  it("reports continuation final text mode for inline streams", () => {
    const { client } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
    });

    expect(out.getFinalTextMode()).toBe("continuation");
  });
});

describe("reasoning display helpers", () => {
  it("clamps long reasoning output and preserves leading content", () => {
    expect(clampReasoningDetail("0123456789", 4)).toBe("012…");
  });

  it("renders reasoning text as blockquote lines", () => {
    expect(formatReasoningAsBlockquote("**Title**\nline 1\nline 2")).toBe(
      "> **Title**\n> line 1\n> line 2",
    );
  });

  it("renders simple thinking status with spinner and elapsed seconds", () => {
    expect(
      buildThinkingDisplay({
        nowMs: 10_500,
        startedAtMs: 10_000,
        mode: "simple",
      }),
    ).toBe("⣟ Thinking... 0s");
  });

  it("renders detailed thinking status with blockquoted detail", () => {
    expect(
      buildThinkingDisplay({
        nowMs: 21_500,
        startedAtMs: 20_000,
        mode: "detailed",
        detailText: "line 1\nline 2",
      }),
    ).toBe("⣽ Thinking... 1s\n> line 1\n> line 2");
  });

  it("clamps detailed reasoning body to 512 chars", () => {
    const detail = `${"a".repeat(520)}\n${"b".repeat(10)}`;
    const output = buildThinkingDisplay({
      nowMs: 21_500,
      startedAtMs: 20_000,
      mode: "detailed",
      detailText: detail,
    });

    expect(output.startsWith("⣽ Thinking... 1s\n> ")).toBe(true);
    expect(output.includes("…")).toBe(true);
    expect(output.length).toBeLessThanOrEqual("⣽ Thinking... 1s\n> ".length + 512);
  });

  it("renders empty output for none mode", () => {
    expect(
      buildThinkingDisplay({
        nowMs: 21_500,
        startedAtMs: 20_000,
        mode: "none",
        detailText: "line 1\nline 2",
      }),
    ).toBe("");
  });
});

describe("preview tail helper", () => {
  it("returns input unchanged when already within limit", () => {
    expect(toPreviewTail("hello", 10)).toBe("hello");
  });

  it("tails to exact max length with ellipsis prefix", () => {
    const out = toPreviewTail("0123456789", 6);
    expect(out).toBe("...789");
    expect(out.length).toBe(6);
  });
});

describe("output mention policy", () => {
  it("disables reply and mentions when notifications are off", () => {
    expect(
      buildOutputAllowedMentions({
        notificationsEnabled: false,
        previewMode: false,
        isReply: true,
        isFinalLane: true,
      }),
    ).toEqual({ parse: [], repliedUser: false });
  });

  it("suppresses notifications on preview transient lane", () => {
    expect(
      buildOutputAllowedMentions({
        notificationsEnabled: true,
        previewMode: true,
        isReply: true,
        isFinalLane: false,
      }),
    ).toEqual({ parse: [], repliedUser: false });
  });

  it("enables user mentions and reply ping on preview final lane", () => {
    expect(
      buildOutputAllowedMentions({
        notificationsEnabled: true,
        previewMode: true,
        isReply: true,
        isFinalLane: true,
      }),
    ).toEqual({ parse: ["users"], repliedUser: true });
  });
});
