import { describe, expect, it } from "bun:test";
import { parseCoreConfigV1ToUniversal } from "@stanley2058/lilac-utils";
import { Result } from "better-result";

import type { SurfaceAdapter } from "../../../src/surface/adapter";
import { createDiscordThreadControl } from "../../../src/surface/discord/discord-thread-control";
import type { LimitOpts, MsgRef, SessionRef, SurfaceMessage } from "../../../src/surface/types";

const CHANNEL_ID = "111111111111111111";
const OTHER_CHANNEL_ID = "222222222222222222";
const CALLER = { userId: "user-1", sourceThreadId: CHANNEL_ID };
const READ = { view: "messages" as const, limit: 3, maxCharsPerItem: 100 };

function message(
  messageId: string,
  input: { userId: string; text: string; ts: number; userName?: string; deleted?: boolean },
): SurfaceMessage {
  return {
    ref: { platform: "discord", channelId: CHANNEL_ID, messageId },
    session: { platform: "discord", channelId: CHANNEL_ID },
    ...input,
  };
}

function fakeAdapter(messages: readonly SurfaceMessage[]) {
  const listed: { sessionRef: SessionRef; opts?: LimitOpts }[] = [];
  const adapter = {
    connect: async () => undefined,
    disconnect: async () => undefined,
    getSelf: async () => ({ platform: "discord" as const, userId: "bot", userName: "lilac" }),
    listSessions: async () => Result.ok([]),
    listSessionParticipants: async () =>
      Result.ok({ source: "guild_members" as const, participants: [] }),
    startOutput: async () => {
      throw new Error("unused");
    },
    startTyping: async () => Result.ok({ stop: async () => Result.ok(undefined) }),
    prepareSendMsg: async () => Result.ok(undefined),
    sendMsg: async () => {
      throw new Error("unused");
    },
    readMsg: async (_msgRef: MsgRef) => Result.ok(null),
    listMsg: async (sessionRef: SessionRef, opts?: LimitOpts) => {
      listed.push({ sessionRef, ...(opts ? { opts } : {}) });
      return Result.ok([...messages]);
    },
    editMsg: async () => Result.ok(undefined),
    deleteMsg: async () => Result.ok(undefined),
    getReplyContext: async () => Result.ok([]),
    planReplyChain: async (msgRef: MsgRef) => Result.ok([msgRef]),
    planMergeBlockEndingAt: async (msgRef: MsgRef) => Result.ok([msgRef]),
    addReaction: async () => Result.ok(undefined),
    removeReaction: async () => Result.ok(undefined),
    listReactions: async () => Result.ok([]),
    listReactionDetails: async () => Result.ok([]),
    getUnRead: async () => Result.ok([]),
    markRead: async () => Result.ok(undefined),
  } satisfies SurfaceAdapter;
  return { adapter, listed };
}

function control(messages: readonly SurfaceMessage[]) {
  const config = parseCoreConfigV1ToUniversal({
    surface: { discord: { botName: "lilac", allowedChannelIds: [CHANNEL_ID] } },
    entity: { sessions: { discord: { ops: CHANNEL_ID } } },
  });
  const { adapter, listed } = fakeAdapter(messages);
  return {
    port: createDiscordThreadControl({ adapter, getConfig: async () => config }),
    listed,
  };
}

describe("Discord thread control", () => {
  it("reads an allowed channel oldest first with authors and paging cursors", async () => {
    // Discord returns pages newest first.
    const { port, listed } = control([
      message("3", { userId: "bot", text: "On it.", ts: 30 }),
      message("2", { userId: "user-2", userName: "kai", text: "", ts: 20 }),
      message("1", { userId: "user-1", userName: "stanley", text: "Check the logs", ts: 10 }),
    ]);

    const read = await port.read(CALLER, "#ops", { ...READ, before: "9" });

    expect(listed).toEqual([
      {
        sessionRef: expect.objectContaining({ platform: "discord", channelId: CHANNEL_ID }),
        opts: { limit: 3, beforeMessageId: "9" },
      },
    ]);
    expect(read.unwrap()).toEqual({
      threadId: CHANNEL_ID,
      title: "#ops",
      activeRunId: null,
      items: [
        {
          id: "1",
          role: "user",
          kind: "text",
          text: "Check the logs",
          truncated: false,
          author: "stanley",
        },
        { id: "3", role: "assistant", kind: "text", text: "On it.", truncated: false },
      ],
      hasMore: true,
      before: "1",
      after: "3",
    });
  });

  it("orders messages that share a timestamp by snowflake id", async () => {
    const { port } = control([
      message("1300000000000000002", { userId: "user-1", text: "second", ts: 50 }),
      message("1300000000000000001", { userId: "user-1", text: "first", ts: 50 }),
    ]);

    const read = (await port.read(CALLER, CHANNEL_ID, { ...READ, limit: 2 })).unwrap();

    expect(read.items.map((item) => item.text)).toEqual(["first", "second"]);
    expect(read.before).toBe("1300000000000000001");
    expect(read.after).toBe("1300000000000000002");
  });

  it("rejects a channel outside the allowlist without reading it", async () => {
    const { port, listed } = control([]);

    const read = await port.read(CALLER, OTHER_CHANNEL_ID, READ);

    expect(read.isErr()).toBe(true);
    expect(read.isErr() && read.error.message).toContain("Not allowed");
    expect(listed).toEqual([]);
  });

  it("rejects messages and interrupts", async () => {
    const { port } = control([]);

    const sent = await port.send(CALLER, CHANNEL_ID, { text: "hi", mode: "auto" });
    const interrupted = await port.interrupt(CALLER, CHANNEL_ID, {});

    for (const result of [sent, interrupted]) {
      expect(result.isErr() && result.error._tag).toBe("SurfaceOperationUnsupported");
    }
  });
});
