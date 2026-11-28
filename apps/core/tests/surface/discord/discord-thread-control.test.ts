import { describe, expect, it } from "bun:test";
import { parseCoreConfigV1ToUniversal } from "@stanley2058/lilac-utils";
import { Result } from "better-result";

import type { SurfaceAdapter } from "../../../src/surface/adapter";
import {
  discordRelayNonce,
  type DiscordRelayPort,
  type DiscordRouterView,
} from "../../../src/surface/discord/discord-relay";
import type { ThreadSendResult } from "../../../src/surface/thread-control";
import type { TranscriptStore } from "../../../src/transcript/transcript-store";
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

function fakeAdapter(
  messages: readonly SurfaceMessage[],
  replyChains: Readonly<Record<string, readonly string[]>> = {},
) {
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
    readMsg: async (msgRef: MsgRef) =>
      Result.ok(messages.find((entry) => entry.ref.messageId === msgRef.messageId) ?? null),
    listMsg: async (sessionRef: SessionRef, opts?: LimitOpts) => {
      listed.push({ sessionRef, ...(opts ? { opts } : {}) });
      return Result.ok([...messages]);
    },
    editMsg: async () => Result.ok(undefined),
    deleteMsg: async () => Result.ok(undefined),
    getReplyContext: async () => Result.ok([]),
    planReplyChain: async (msgRef: MsgRef) =>
      Result.ok(
        (replyChains[msgRef.messageId] ?? [msgRef.messageId]).map((messageId) => ({
          ...msgRef,
          messageId,
        })),
      ),
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

function fakeRelay() {
  const sent: Parameters<DiscordRelayPort["sendRelayMessage"]>[0][] = [];
  const cancelled: Parameters<DiscordRelayPort["cancelRequest"]>[0][] = [];
  const results = new Map<string, ThreadSendResult>();
  const relay: DiscordRelayPort = {
    findRelayResult: (nonce) => results.get(nonce) ?? null,
    recordRelayResult: (nonce, result) => {
      if (!results.has(nonce)) results.set(nonce, result);
      return results.get(nonce) ?? result;
    },
    cancelRequest: async (input) => {
      cancelled.push(input);
    },
    sendRelayMessage: async (input) => {
      sent.push(input);
      return Result.ok({ platform: "discord", channelId: input.channelId, messageId: "900" });
    },
    relaySourcesForChannel: (channelId) =>
      channelId === CHANNEL_ID ? [{ platform: "native", threadId: "web", userId: "owner" }] : [],
  };
  return { relay, sent, cancelled };
}

function control(
  messages: readonly SurfaceMessage[],
  options: {
    relay?: DiscordRelayPort;
    router?: DiscordRouterView;
    transcriptStore?: TranscriptStore;
    replyChains?: Readonly<Record<string, readonly string[]>>;
  } = {},
) {
  const config = parseCoreConfigV1ToUniversal({
    surface: { discord: { botName: "lilac", allowedChannelIds: [CHANNEL_ID] } },
    entity: { sessions: { discord: { ops: CHANNEL_ID } } },
  });
  const { adapter, listed } = fakeAdapter(messages, options.replyChains);
  return {
    port: createDiscordThreadControl({
      adapter,
      getConfig: async () => config,
      ...(options.relay ? { relay: options.relay } : {}),
      ...(options.router ? { router: options.router } : {}),
      transcriptStore: () => options.transcriptStore,
    }),
    listed,
  };
}

const SCOPE = { userId: "owner", threadId: "web", channelId: CHANNEL_ID };

const NATIVE_CALLER = {
  userId: "discord-user",
  sourceThreadId: "native:web",
  source: { platform: "native" as const, userId: "owner" },
};

describe("Discord thread control", () => {
  it("reads the rest of one truncated message from a text offset", async () => {
    const { port } = control([message("1", { userId: "user-1", text: "0123456789", ts: 10 })]);
    const head = await port.read(CALLER, "#ops", { ...READ, maxCharsPerItem: 4 });
    expect(head.unwrap().items[0]).toMatchObject({ text: "0123", nextTextOffset: 4 });

    const rest = await port.read(CALLER, "#ops", {
      ...READ,
      maxCharsPerItem: 4,
      item: { id: "1", textOffset: 8 },
    });
    expect(rest.unwrap().items).toEqual([
      { id: "1", role: "user", kind: "text", text: "89", truncated: false, textOffset: 8 },
    ]);
  });

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

  it("rejects messages without a relay, and interrupts", async () => {
    const { port } = control([]);

    const sent = await port.send(CALLER, CHANNEL_ID, { text: "hi", mode: "auto" });
    const interrupted = await port.interrupt(CALLER, CHANNEL_ID, {});

    for (const result of [sent, interrupted]) {
      expect(result.isErr() && result.error._tag).toBe("SurfaceOperationUnsupported");
    }
  });

  it("continues a thread by replying to a message target and reports the steer", async () => {
    const { relay, sent } = fakeRelay();
    const admissions: unknown[] = [];
    const { port } = control([message("800", { userId: "bot", text: "working on it", ts: 10 })], {
      relay,
      router: {
        activeRequest: () => ({ requestId: "discord:111:5", outputMessageIds: ["800"] }),
        relayAdmission: (input) => {
          admissions.push(input);
          return { kind: "joins", requestId: "discord:111:5" };
        },
      },
    });

    const result = await port.send(NATIVE_CALLER, `discord:${CHANNEL_ID}:800`, {
      text: "use the retry path",
      mode: "steer",
      commandId: "cmd-1",
    });

    expect(result.unwrap()).toEqual({
      disposition: "steered",
      messageId: "900",
      runId: "discord:111:5",
    });
    expect(admissions).toEqual([
      { sessionId: CHANNEL_ID, replyToMessageId: "800", replyToBot: true, steer: true },
    ]);
    expect(sent).toEqual([
      {
        channelId: CHANNEL_ID,
        text: "<@bot>\n-# ↪ Sent from Lilac web for <@discord-user>\nuse the retry path",
        replyToMessageId: "800",
        origin: {
          nonce: discordRelayNonce("cmd-1", SCOPE),
          platform: "native",
          threadId: "web",
          userId: "owner",
          discordUserId: "discord-user",
          mode: "steer",
        },
      },
    ]);
    expect(discordRelayNonce("cmd-1", SCOPE).length).toBeLessThanOrEqual(25);
    expect(discordRelayNonce("cmd-1", SCOPE)).not.toBe(discordRelayNonce("cmd-2", SCOPE));
    expect(discordRelayNonce("cmd-1", SCOPE)).not.toBe(
      discordRelayNonce("cmd-1", { ...SCOPE, threadId: "other-thread" }),
    );
  });

  it("steers the session's running request through its latest output, whatever the target", async () => {
    const { relay, sent } = fakeRelay();
    const admissions: unknown[] = [];
    const { port } = control([], {
      relay,
      router: {
        activeRequest: () => ({ requestId: "discord:111:5", outputMessageIds: ["700", "800"] }),
        relayAdmission: (input) => {
          admissions.push(input);
          return { kind: "joins", requestId: "discord:111:5" };
        },
      },
    });

    const toTrigger = await port.send(NATIVE_CALLER, `discord:${CHANNEL_ID}:5`, {
      text: "change course",
      mode: "steer",
    });
    const toChannel = await port.send(NATIVE_CALLER, CHANNEL_ID, {
      text: "change course",
      mode: "steer",
    });

    for (const result of [toTrigger, toChannel])
      expect(result.unwrap()).toMatchObject({ disposition: "steered", runId: "discord:111:5" });
    expect(sent.map((input) => input.replyToMessageId)).toEqual(["800", "800"]);
    expect(admissions).toEqual([
      { sessionId: CHANNEL_ID, replyToMessageId: "800", replyToBot: true, steer: true },
      { sessionId: CHANNEL_ID, replyToMessageId: "800", replyToBot: true, steer: true },
    ]);
  });

  it("replays a keyed send's first result after the channel changed", async () => {
    const { relay, sent } = fakeRelay();
    let running = true;
    const { port } = control([], {
      relay,
      router: {
        activeRequest: () =>
          running ? { requestId: "discord:111:5", outputMessageIds: ["800"] } : undefined,
        relayAdmission: () =>
          running
            ? { kind: "joins", requestId: "discord:111:5" }
            : { kind: "starts", queued: false },
      },
    });
    const send = { text: "change course", mode: "steer" as const, commandId: "cmd-9" };

    const first = await port.send(NATIVE_CALLER, `discord:${CHANNEL_ID}:404`, send);
    running = false;
    const retry = await port.send(NATIVE_CALLER, `discord:${CHANNEL_ID}:404`, send);

    expect(retry.unwrap()).toEqual(first.unwrap());
    expect(first.unwrap()).toMatchObject({ disposition: "steered", runId: "discord:111:5" });
    expect(sent).toHaveLength(1);
  });

  it("returns the first stored result to overlapping keyed sends", async () => {
    const { relay } = fakeRelay();
    let running = true;
    const { port } = control([], {
      relay: {
        ...relay,
        // Both calls miss the replay lookup, as when they overlap.
        findRelayResult: () => null,
      },
      router: {
        activeRequest: () =>
          running ? { requestId: "discord:111:5", outputMessageIds: ["800"] } : undefined,
        relayAdmission: () =>
          running
            ? { kind: "joins", requestId: "discord:111:5" }
            : { kind: "starts", queued: false },
      },
    });
    const send = { text: "change course", mode: "steer" as const, commandId: "cmd-10" };

    const first = await port.send(NATIVE_CALLER, CHANNEL_ID, send);
    running = false;
    const overlapping = await port.send(NATIVE_CALLER, CHANNEL_ID, send);

    expect(overlapping.unwrap()).toEqual(first.unwrap());
  });

  it("steers a running request that has no output yet with a plain mention", async () => {
    const { relay, sent } = fakeRelay();
    const { port } = control([], {
      relay,
      router: {
        activeRequest: () => ({ requestId: "discord:111:5", outputMessageIds: [] }),
        relayAdmission: (input) =>
          input.steer
            ? { kind: "joins", requestId: "discord:111:5" }
            : { kind: "starts", queued: true },
      },
    });

    const result = await port.send(NATIVE_CALLER, `discord:${CHANNEL_ID}:404`, {
      text: "change course",
      mode: "steer",
    });

    expect(result.unwrap()).toMatchObject({ disposition: "steered", runId: "discord:111:5" });
    expect(sent[0]).not.toHaveProperty("replyToMessageId");
  });

  it("keeps an auto send on the named target while a request runs", async () => {
    const { relay, sent } = fakeRelay();
    const { port } = control([], {
      relay,
      router: {
        activeRequest: () => ({ requestId: "discord:111:5", outputMessageIds: ["800"] }),
        relayAdmission: () => ({ kind: "starts", queued: true }),
      },
    });

    const result = await port.send(NATIVE_CALLER, CHANNEL_ID, { text: "new topic", mode: "auto" });

    expect(result.unwrap()).toMatchObject({ disposition: "queued" });
    expect(sent[0]).not.toHaveProperty("replyToMessageId");
  });

  it("interrupts the channel's running request through its cancel path", async () => {
    const { relay, cancelled } = fakeRelay();
    const running = control([], {
      relay,
      router: {
        activeRequest: () => ({ requestId: "discord:111:5", outputMessageIds: ["800"] }),
        relayAdmission: () => ({ kind: "joins", requestId: "discord:111:5" }),
      },
    });
    const idle = control([], { relay });

    expect((await running.port.interrupt(NATIVE_CALLER, "#ops", {})).unwrap()).toEqual({
      status: "cancelled",
      runId: "discord:111:5",
    });
    expect(
      (
        await running.port.interrupt(NATIVE_CALLER, `discord:${CHANNEL_ID}:1`, {
          runId: "discord:111:4",
        })
      ).unwrap(),
    ).toEqual({ status: "ended", runId: "discord:111:4" });
    expect((await idle.port.interrupt(NATIVE_CALLER, CHANNEL_ID, {})).unwrap()).toEqual({
      status: "idle",
    });
    const sameSurface = await running.port.interrupt(CALLER, CHANNEL_ID, {});
    expect(sameSurface.isErr() && sameSurface.error._tag).toBe("SurfacePermissionDenied");
    expect(cancelled).toEqual([
      { channelId: CHANNEL_ID, requestId: "discord:111:5", discordUserId: "discord-user" },
    ]);
  });

  it("starts a new thread from a channel target, queued while another runs", async () => {
    const { relay, sent } = fakeRelay();
    const { port } = control([], {
      relay,
      router: {
        activeRequest: () => undefined,
        relayAdmission: () => ({ kind: "starts", queued: true }),
      },
    });

    const result = await port.send(NATIVE_CALLER, "#ops", { text: "new topic", mode: "auto" });

    expect(result.unwrap()).toEqual({
      disposition: "queued",
      messageId: "900",
      runId: `discord:${CHANNEL_ID}:900`,
    });
    expect(sent[0]).not.toHaveProperty("replyToMessageId");
  });

  it("starts an idle channel without a router view", async () => {
    const { relay } = fakeRelay();
    const { port } = control([], { relay });

    const result = await port.send(NATIVE_CALLER, CHANNEL_ID, { text: "carry on", mode: "auto" });

    expect(result.unwrap()).toMatchObject({ disposition: "started" });
  });

  it("rejects a message target that does not exist or is outside the allowlist", async () => {
    const { relay, sent } = fakeRelay();
    const { port } = control([], { relay });

    const missing = await port.send(NATIVE_CALLER, `discord:${CHANNEL_ID}:404`, {
      text: "hi",
      mode: "auto",
    });
    const outside = await port.send(NATIVE_CALLER, `discord:${OTHER_CHANNEL_ID}:1`, {
      text: "hi",
      mode: "auto",
    });

    expect(missing.isErr() && missing.error.message).toContain("No Discord message 404");
    expect(outside.isErr() && outside.error.message).toContain("Not allowed");
    expect(sent).toEqual([]);
  });

  it("reads a message target as the thread a reply to it would see", async () => {
    const snapshot = {
      requestId: "discord:111:1",
      requestClient: "discord",
      sessionId: CHANNEL_ID,
      updatedTs: 20,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { cmd: "ls" } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "bash",
              output: { type: "text", value: "README.md" },
            },
          ],
        },
        { role: "assistant", content: "Found the README." },
      ],
    };
    const transcriptStore = {
      getTranscriptBySurfaceMessage: (ref: { messageId: string }) =>
        Result.ok(ref.messageId === "2" || ref.messageId === "3" ? snapshot : null),
    } as unknown as TranscriptStore;
    const { port } = control(
      [
        message("1", { userId: "user-1", userName: "Stanley", text: "list files", ts: 10 }),
        message("2", { userId: "bot", text: "Found the", ts: 20 }),
        message("3", { userId: "bot", text: "README.", ts: 21 }),
      ],
      {
        transcriptStore,
        replyChains: { "3": ["1", "2", "3"] },
        router: {
          activeRequest: () => undefined,
          relayAdmission: () => ({ kind: "starts", queued: false }),
        },
      },
    );

    const messages = (
      await port.read(CALLER, `discord:${CHANNEL_ID}:3`, {
        ...READ,
        limit: 10,
        maxCharsPerItem: 4000,
      })
    ).unwrap();
    const activity = (
      await port.read(CALLER, `discord:${CHANNEL_ID}:3`, {
        ...READ,
        view: "activity",
        limit: 10,
        maxCharsPerItem: 4000,
      })
    ).unwrap();

    expect(messages.threadId).toBe(`discord:${CHANNEL_ID}:3`);
    expect(messages.items.map((item) => [item.role, item.text.split("\n").at(-1)])).toEqual([
      ["user", "list files"],
      ["assistant", "Found the README."],
    ]);
    expect(messages.items[0]?.text).toContain('"user_name":"Stanley"');
    expect(messages.items[0]?.id.startsWith("1.")).toBe(true);
    expect(activity.items.map((item) => item.kind)).toEqual(["text", "activity", "text"]);
    expect(activity.items[1]).toMatchObject({ activity: { kind: "tool", state: "complete" } });
    expect(activity.items[1]?.text).toContain("README.md");
  });

  it("rejects queue mode, callers without a native source, and oversized relays", async () => {
    const { relay, sent } = fakeRelay();
    const { port } = control([], { relay });

    const queued = await port.send(NATIVE_CALLER, CHANNEL_ID, { text: "later", mode: "queue" });
    const sameSurface = await port.send(CALLER, CHANNEL_ID, { text: "hi", mode: "auto" });
    const oversized = await port.send(NATIVE_CALLER, CHANNEL_ID, {
      text: "x".repeat(2000),
      mode: "auto",
    });

    expect(queued.isErr() && queued.error._tag).toBe("SurfaceInvalidInput");
    expect(sameSurface.isErr() && sameSurface.error._tag).toBe("SurfacePermissionDenied");
    expect(oversized.isErr() && oversized.error._tag).toBe("SurfaceInvalidInput");
    expect(sent).toEqual([]);
  });

  it("lists the native threads that relayed into a channel", () => {
    const { relay } = fakeRelay();
    const { port } = control([], { relay });

    expect(port.relaySources?.(CHANNEL_ID)).toEqual([
      { platform: "native", threadId: "web", userId: "owner" },
    ]);
    expect(port.relaySources?.(OTHER_CHANNEL_ID)).toEqual([]);
  });
});
