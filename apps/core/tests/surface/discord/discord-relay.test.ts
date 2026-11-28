import { describe, expect, it } from "bun:test";

import {
  discordRelayBody,
  formatDiscordRelayText,
  parseDiscordMessageTarget,
  relayJoinsActiveRequest,
} from "../../../src/surface/discord/discord-relay";

describe("Discord relay admission", () => {
  const active = new Set(["out-1", "out-2"]);

  it.each([
    ["mention", "out-2", true, true],
    ["mention", "old", true, false],
    ["mention", undefined, false, false],
    ["active", "out-1", true, true],
    ["active", "old", true, false],
    ["active", undefined, false, true],
    ["active", "user-msg", false, true],
  ] as const)(
    "mode %s replying to %s (bot=%s) joins the running request: %s",
    (mode, replyToMessageId, replyToBot, joins) => {
      expect(
        relayJoinsActiveRequest({
          mode,
          activeOutputMessageIds: active,
          replyToMessageId,
          replyToBot,
        }),
      ).toBe(joins);
    },
  );

  it("parses only discord:<channel>:<message> targets", () => {
    expect(parseDiscordMessageTarget("discord:111:222")).toEqual({
      channelId: "111",
      messageId: "222",
    });
    expect(parseDiscordMessageTarget("111")).toBeNull();
    expect(parseDiscordMessageTarget("discord:dev-chat:222")).toBeNull();
  });

  it("keeps only the relayed text for agents", () => {
    const posted = formatDiscordRelayText({
      botUserId: "bot",
      senderMention: "<@user>",
      text: "first line\nsecond line",
    });

    expect(discordRelayBody(posted)).toBe("first line\nsecond line");
    expect(discordRelayBody("@Lilac\n-# ↪ Sent from Lilac web for @Stanley\nhi")).toBe("hi");
    expect(discordRelayBody("ordinary text")).toBe("ordinary text");
  });
});
