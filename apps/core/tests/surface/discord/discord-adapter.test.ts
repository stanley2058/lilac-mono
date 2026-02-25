import { describe, expect, it } from "bun:test";
import { MessageType, type Message } from "discord.js";

import {
  hasExplicitDiscordUserMentionInContent,
  isExplicitDiscordUserMention,
  isRoutableDiscordUserMessage,
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
