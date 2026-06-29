import { describe, expect, it } from "bun:test";

import { decideActiveRequestRoute } from "../../../src/surface/bridge/bus-request-router/decisions";

const botNames = ["lilac"];

describe("bus request router decisions", () => {
  it("routes replies to active output as follow-up unless the bot is mentioned", () => {
    const activeOutputMessageIds = new Set(["bot-output"]);

    expect(
      decideActiveRequestRoute({
        activeOutputMessageIds,
        replyToBot: true,
        mentionsBot: false,
        replyToMessageId: "bot-output",
        userText: "more detail",
        botMentionNames: botNames,
        allowMentionSteer: true,
        plainMessageBehavior: "buffered_prompt",
      }),
    ).toEqual({ kind: "active_output_follow_up" });

    expect(
      decideActiveRequestRoute({
        activeOutputMessageIds,
        replyToBot: true,
        mentionsBot: true,
        replyToMessageId: "bot-output",
        userText: "@lilac !int stop there",
        botMentionNames: botNames,
        allowMentionSteer: true,
        plainMessageBehavior: "buffered_prompt",
      }),
    ).toEqual({
      kind: "active_output_steer",
      queue: "interrupt",
      inheritReplyTo: false,
    });
  });

  it("routes active-channel mentions as steer when allowed", () => {
    expect(
      decideActiveRequestRoute({
        activeOutputMessageIds: new Set(["bot-output"]),
        replyToBot: false,
        mentionsBot: true,
        userText: "@lilac use this constraint",
        botMentionNames: botNames,
        allowMentionSteer: true,
        plainMessageBehavior: "buffered_prompt",
      }),
    ).toEqual({
      kind: "active_mention_steer",
      queue: "steer",
      inheritReplyTo: true,
    });
  });

  it("forks replies to non-active bot output into a queued prompt", () => {
    expect(
      decideActiveRequestRoute({
        activeOutputMessageIds: new Set(["bot-output"]),
        replyToBot: true,
        mentionsBot: false,
        replyToMessageId: "older-bot-message",
        userText: "new branch please",
        botMentionNames: botNames,
        allowMentionSteer: true,
        plainMessageBehavior: "buffered_prompt",
      }),
    ).toEqual({ kind: "fork_reply_prompt" });
  });

  it("uses the caller-selected plain message behavior", () => {
    const shared = {
      activeOutputMessageIds: new Set(["bot-output"]),
      replyToBot: false,
      mentionsBot: false,
      userText: "ambient follow-up",
      botMentionNames: botNames,
      allowMentionSteer: false,
    };

    expect(
      decideActiveRequestRoute({
        ...shared,
        plainMessageBehavior: "follow_up",
      }),
    ).toEqual({ kind: "plain_follow_up" });

    expect(
      decideActiveRequestRoute({
        ...shared,
        plainMessageBehavior: "buffered_prompt",
      }),
    ).toEqual({ kind: "buffered_prompt" });
  });
});
