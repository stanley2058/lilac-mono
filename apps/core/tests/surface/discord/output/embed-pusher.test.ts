import { describe, expect, it } from "bun:test";
import type { Message } from "discord.js";

import { startEmbedPusher } from "../../../../src/surface/discord/output/embed-pusher";

describe("startEmbedPusher content phase", () => {
  it("requests streaming content before streamDone and terminal content after it", async () => {
    let resolveDone: () => void = () => {};
    const streamDone = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const phases: boolean[] = [];
    const message = { id: "message-1" } as Message;

    const result = await startEmbedPusher({
      createFirst: async () => {
        resolveDone();
        return message;
      },
      createReply: async () => message,
      getContent: (isStreaming) => {
        phases.push(isStreaming);
        return isStreaming ? "streaming" : "terminal";
      },
      getActionsLines: () => [],
      getMaxLength: () => 4096,
      streamDone,
      useSmartSplitting: false,
      editMessage: async () => ({ kind: "edited" }),
    });

    expect(result.status).toBe("ok");
    expect(phases).toEqual([true, false, false]);
    if (result.status === "error") throw result.error;
    expect(result.value.responseQueue).toEqual(["terminal"]);
  });

  it("performs a terminal read when streamDone resolves during a streaming sync", async () => {
    let resolveDone: () => void = () => {};
    const streamDone = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const phases: boolean[] = [];
    const message = { id: "message-1" } as Message;

    const result = await startEmbedPusher({
      createFirst: async () => message,
      createReply: async () => message,
      getContent: (isStreaming) => {
        phases.push(isStreaming);
        return phases.length === 1 ? "first content" : "same content";
      },
      getActionsLines: () => [],
      getMaxLength: () => 4096,
      streamDone,
      useSmartSplitting: false,
      editMessage: async () => {
        resolveDone();
        return { kind: "edited" };
      },
    });

    expect(result.status).toBe("ok");
    expect(phases).toEqual([true, true, false, false]);
  });

  it("skips edits for unchanged content and for elapsed-time-only title changes", async () => {
    const streamDone = Promise.withResolvers<void>();
    const message = { id: "message-1" } as Message;
    let reads = 0;
    let titleTick = 0;
    const edits: boolean[] = [];

    const result = await startEmbedPusher({
      createFirst: async () => message,
      createReply: async () => message,
      getContent: (isStreaming) => {
        reads += 1;
        if (reads === 4) streamDone.resolve();
        return isStreaming ? "same" : "done";
      },
      getProgressTitle: () => `Working... ${titleTick++}s`,
      shouldHeartbeatProgress: () => true,
      getActionsLines: () => [],
      getMaxLength: () => 4096,
      streamDone: streamDone.promise,
      useSmartSplitting: false,
      editMessage: async () => {
        edits.push(true);
        return { kind: "edited" };
      },
    });

    if (result.status === "error") throw result.error;
    expect(edits).toHaveLength(1);
    expect(result.value.responseQueue).toEqual(["done"]);
  });

  it("continues in a fresh message when the edited message is gone", async () => {
    let resolveDone: () => void = () => {};
    const streamDone = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const first = { id: "message-1" } as Message;
    const replacement = { id: "message-2" } as Message;
    const created = [first, replacement];
    const edited: string[] = [];

    const result = await startEmbedPusher({
      createFirst: async () => {
        const next = created.shift();
        if (!next) throw new Error("unexpected create");
        resolveDone();
        return next;
      },
      createReply: async () => {
        throw new Error("unexpected reply");
      },
      getContent: (isStreaming) => (isStreaming ? "streaming" : "terminal"),
      getActionsLines: () => [],
      getMaxLength: () => 4096,
      streamDone,
      useSmartSplitting: false,
      editMessage: async (message) => {
        edited.push(message.id);
        resolveDone();
        return message.id === "message-1" ? { kind: "not-found" } : { kind: "edited" };
      },
    });

    if (result.status === "error") throw result.error;
    expect(edited[0]).toBe("message-1");
    expect(result.value.lastMsg.id).toBe("message-2");
    expect(result.value.discordMessageCreated).toEqual(["message-1", "message-2"]);
    expect(result.value.responseQueue).toEqual(["terminal"]);
  });

  it("returns the Discord error when an edit fails", async () => {
    let resolveDone: () => void = () => {};
    const streamDone = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const message = { id: "message-1" } as Message;
    const edits: unknown[] = [];

    const result = await startEmbedPusher({
      createFirst: async () => {
        resolveDone();
        return message;
      },
      createReply: async () => message,
      getContent: (isStreaming) => (isStreaming ? "before " : "before \\(partial"),
      getActionsLines: () => [],
      getMaxLength: () => 4096,
      streamDone,
      useSmartSplitting: false,
      editMessage: async (_message, options) => {
        edits.push(options);
        return { kind: "failed", cause: Object.assign(new Error("unavailable"), { status: 503 }) };
      },
    });

    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected terminal edit failure");
    expect(result.error).toMatchObject({
      _tag: "DiscordEmbedEditFailed",
      message: "startEmbedPusher failed to edit message message-1",
      cause: { status: 503 },
    });
    expect(edits).toHaveLength(1);
  });
});
