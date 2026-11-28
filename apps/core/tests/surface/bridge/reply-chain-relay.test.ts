import { describe, expect, it } from "bun:test";

import { mergeChainByDiscordWindow } from "../../../src/surface/bridge/request-composition/reply-chain";
import type { ReplyChainMessage } from "../../../src/surface/bridge/request-composition/types";

function chainMessage(messageId: string, ts: number, relay = false): ReplyChainMessage {
  return {
    messageId,
    authorId: "user",
    authorName: "Stanley",
    ts,
    text: messageId,
    attachments: [],
    replyReference: {},
    ...(relay
      ? {
          relay: {
            nonce: "n",
            platform: "native" as const,
            threadId: "web",
            userId: "owner",
            discordUserId: "user",
            mode: "steer" as const,
            botUserId: "bot",
            botName: "lilac",
          },
        }
      : {}),
  };
}

describe("relay messages in a reply chain", () => {
  it("never merge with the linked user's own messages around them", () => {
    const merged = mergeChainByDiscordWindow([
      chainMessage("before", 1),
      chainMessage("relay", 2, true),
      chainMessage("after", 3),
      chainMessage("after-2", 4),
    ]);

    expect(merged.map((chunk) => chunk.messageIds)).toEqual([
      ["before"],
      ["relay"],
      ["after", "after-2"],
    ]);
  });
});
