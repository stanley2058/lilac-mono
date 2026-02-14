import { describe, expect, it } from "bun:test";
import { MessageType, type Message } from "discord.js";

import { isRoutableDiscordUserMessage } from "../../../src/surface/discord/discord-adapter";

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
