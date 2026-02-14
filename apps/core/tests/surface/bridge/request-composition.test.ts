import { afterEach, describe, expect, it } from "bun:test";

import {
  composeRecentChannelMessages,
  composeRequestMessages,
  composeSingleMessage,
} from "../../../src/surface/bridge/request-composition";
import type { ModelMessage } from "ai";
import type {
  AdapterEventHandler,
  AdapterSubscription,
  StartOutputOpts,
  SurfaceAdapter,
  SurfaceOutputStream,
} from "../../../src/surface/adapter";
import type { TranscriptStore } from "../../../src/transcript/transcript-store";
import type {
  AdapterCapabilities,
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
  SurfaceSelf,
  SurfaceSession,
} from "../../../src/surface/types";

class FakeAdapter implements SurfaceAdapter {
  constructor(
    private readonly message: SurfaceMessage,
    private readonly reactions: readonly string[] = [],
  ) {}

  async connect(): Promise<void> {
    throw new Error("not implemented");
  }
  async disconnect(): Promise<void> {
    throw new Error("not implemented");
  }

  async getSelf(): Promise<SurfaceSelf> {
    throw new Error("not implemented");
  }
  async getCapabilities(): Promise<AdapterCapabilities> {
    throw new Error("not implemented");
  }

  async listSessions(): Promise<SurfaceSession[]> {
    throw new Error("not implemented");
  }

  async startOutput(
    _sessionRef: SessionRef,
    _opts?: StartOutputOpts,
  ): Promise<SurfaceOutputStream> {
    throw new Error("not implemented");
  }

  async sendMsg(
    _sessionRef: SessionRef,
    _content: ContentOpts,
    _opts?: SendOpts,
  ): Promise<MsgRef> {
    throw new Error("not implemented");
  }

  async readMsg(_msgRef: MsgRef): Promise<SurfaceMessage | null> {
    return this.message;
  }

  async listMsg(
    _sessionRef: SessionRef,
    _opts?: LimitOpts,
  ): Promise<SurfaceMessage[]> {
    throw new Error("not implemented");
  }

  async editMsg(_msgRef: MsgRef, _content: ContentOpts): Promise<void> {
    throw new Error("not implemented");
  }

  async deleteMsg(_msgRef: MsgRef): Promise<void> {
    throw new Error("not implemented");
  }

  async getReplyContext(
    _msgRef: MsgRef,
    _opts?: LimitOpts,
  ): Promise<SurfaceMessage[]> {
    throw new Error("not implemented");
  }

  async addReaction(_msgRef: MsgRef, _reaction: string): Promise<void> {
    throw new Error("not implemented");
  }

  async removeReaction(_msgRef: MsgRef, _reaction: string): Promise<void> {
    throw new Error("not implemented");
  }

  async listReactions(_msgRef: MsgRef): Promise<string[]> {
    return [...this.reactions];
  }

  async subscribe(_handler: AdapterEventHandler): Promise<AdapterSubscription> {
    throw new Error("not implemented");
  }

  async getUnRead(_sessionRef: SessionRef): Promise<SurfaceMessage[]> {
    throw new Error("not implemented");
  }

  async markRead(_sessionRef: SessionRef, _upToMsgRef?: MsgRef): Promise<void> {
    throw new Error("not implemented");
  }
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("request-composition attachments", () => {
  it("includes reaction hint in attribution header", async () => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: "hi",
      ts: 0,
    };

    const adapter = new FakeAdapter(msg, ["👍", "👀"]);
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
    });

    expect(out?.role).toBe("user");
    expect(typeof out?.content).toBe("string");
    expect(out!.content as string).toContain("reactions=👍,👀");
  });

  it("downloads discord attachment when mimeType is missing", async () => {
    let calls = 0;
    // @ts-expect-error stub fetch
    globalThis.fetch = async () => {
      calls++;
      return new Response("hello", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    };

    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: "hi",
      ts: 0,
      raw: {
        discord: {
          attachments: [
            {
              url: "https://cdn.discordapp.com/attachments/1/2/file.txt",
              filename: "file.txt",
            },
          ],
        },
      },
    };

    const adapter = new FakeAdapter(msg);
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
    });

    expect(out?.role).toBe("user");
    expect(Array.isArray(out?.content)).toBe(true);
    const content = out!.content as any[];

    expect(content.length).toBe(2);
    expect(content[1].type).toBe("text");
    expect(typeof content[1].text).toBe("string");
    expect(content[1].text).toContain("[discord_attachment");
    expect(content[1].text).toContain("file.txt");
    expect(content[1].text).toContain("hello");
    expect(calls).toBe(1);
  });

  it("does not download when mimeType is application/pdf", async () => {
    // @ts-expect-error stub fetch
    globalThis.fetch = async () => {
      throw new Error("should not fetch");
    };

    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: "hi",
      ts: 0,
      raw: {
        discord: {
          attachments: [
            {
              url: "https://cdn.discordapp.com/attachments/1/2/doc.pdf",
              filename: "doc.pdf",
              mimeType: "application/pdf",
            },
          ],
        },
      },
    };

    const adapter = new FakeAdapter(msg);
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
    });

    expect(out?.role).toBe("user");
    const content = out!.content as any[];
    expect(content[1].type).toBe("file");
    expect(content[1].mediaType).toBe("application/pdf");
    expect(content[1].data).toBeInstanceOf(URL);
  });

  it("inlines plain text when mimeType is text/plain", async () => {
    let calls = 0;
    // @ts-expect-error stub fetch
    globalThis.fetch = async () => {
      calls++;
      return new Response("hello", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    };

    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: "hi",
      ts: 0,
      raw: {
        discord: {
          attachments: [
            {
              url: "https://cdn.discordapp.com/attachments/1/2/file.txt",
              filename: "file.txt",
              mimeType: "text/plain",
            },
          ],
        },
      },
    };

    const adapter = new FakeAdapter(msg);
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
    });

    expect(out?.role).toBe("user");
    const content = out!.content as any[];
    expect(content[1].type).toBe("text");
    expect(content[1].text).toContain("hello");
    expect(calls).toBe(1);
  });

  it("treats non-text binary as URL-only text", async () => {
    // @ts-expect-error stub fetch
    globalThis.fetch = async () => {
      throw new Error("should not fetch");
    };

    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: "hi",
      ts: 0,
      raw: {
        discord: {
          attachments: [
            {
              url: "https://cdn.discordapp.com/attachments/1/2/doc.rtf",
              filename: "doc.rtf",
              mimeType: "application/rtf",
            },
          ],
        },
      },
    };

    const adapter = new FakeAdapter(msg);
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
    });

    expect(out?.role).toBe("user");
    const content = out!.content as any[];
    expect(content[1].type).toBe("text");
    expect(content[1].text).toContain("doc.rtf");
    expect(content[1].text).toContain("https://cdn.discordapp.com/");
  });

  it("falls back to inferred mime type when download fails", async () => {
    // @ts-expect-error stub fetch
    globalThis.fetch = async () => {
      throw new Error("network down");
    };

    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: "hi",
      ts: 0,
      raw: {
        discord: {
          attachments: [
            {
              url: "https://cdn.discordapp.com/attachments/1/2/note.txt",
              filename: "note.txt",
            },
          ],
        },
      },
    };

    const adapter = new FakeAdapter(msg);
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
    });

    expect(out?.role).toBe("user");
    const content = out!.content as any[];
    expect(content[1].type).toBe("text");
    expect(content[1].text).toContain("note.txt");
    expect(content[1].text).toContain("download failed");
    expect(content[1].text).toContain("https://cdn.discordapp.com/");
  });
});

describe("request-composition mention thread context", () => {
  class MultiFakeAdapter implements SurfaceAdapter {
    constructor(private readonly messages: Record<string, SurfaceMessage>) {}

    async connect(): Promise<void> {
      throw new Error("not implemented");
    }
    async disconnect(): Promise<void> {
      throw new Error("not implemented");
    }

    async getSelf(): Promise<SurfaceSelf> {
      throw new Error("not implemented");
    }
    async getCapabilities(): Promise<AdapterCapabilities> {
      throw new Error("not implemented");
    }

    async listSessions(): Promise<SurfaceSession[]> {
      throw new Error("not implemented");
    }

    async startOutput(
      _sessionRef: SessionRef,
      _opts?: StartOutputOpts,
    ): Promise<SurfaceOutputStream> {
      throw new Error("not implemented");
    }

    async sendMsg(
      _sessionRef: SessionRef,
      _content: ContentOpts,
      _opts?: SendOpts,
    ): Promise<MsgRef> {
      throw new Error("not implemented");
    }

    async readMsg(msgRef: MsgRef): Promise<SurfaceMessage | null> {
      const key = `${msgRef.channelId}:${msgRef.messageId}`;
      return this.messages[key] ?? null;
    }

    async listMsg(
      _sessionRef: SessionRef,
      _opts?: LimitOpts,
    ): Promise<SurfaceMessage[]> {
      throw new Error("not implemented");
    }

    async editMsg(_msgRef: MsgRef, _content: ContentOpts): Promise<void> {
      throw new Error("not implemented");
    }

    async deleteMsg(_msgRef: MsgRef): Promise<void> {
      throw new Error("not implemented");
    }

    async getReplyContext(
      msgRef: MsgRef,
      opts?: LimitOpts,
    ): Promise<SurfaceMessage[]> {
      const key = `${msgRef.channelId}:${msgRef.messageId}`;
      const base = this.messages[key];
      if (!base) return [];

      const limit = opts?.limit ?? 20;
      const half = Math.max(1, Math.floor(limit / 2));

      const all = Object.values(this.messages)
        .filter((m) => m.session.channelId === msgRef.channelId)
        .slice()
        .sort((a, b) => a.ts - b.ts);

      const beforeAll = all.filter((m) => m.ts <= base.ts);
      const before = beforeAll.slice(Math.max(0, beforeAll.length - half));

      const after = all.filter((m) => m.ts > base.ts).slice(0, half);
      return before.concat(after);
    }

    async addReaction(_msgRef: MsgRef, _reaction: string): Promise<void> {
      throw new Error("not implemented");
    }

    async removeReaction(_msgRef: MsgRef, _reaction: string): Promise<void> {
      throw new Error("not implemented");
    }

    async listReactions(_msgRef: MsgRef): Promise<string[]> {
      return [];
    }

    async subscribe(_handler: AdapterEventHandler): Promise<AdapterSubscription> {
      throw new Error("not implemented");
    }

    async getUnRead(_sessionRef: SessionRef): Promise<SurfaceMessage[]> {
      throw new Error("not implemented");
    }

    async markRead(
      _sessionRef: SessionRef,
      _upToMsgRef?: MsgRef,
    ): Promise<void> {
      throw new Error("not implemented");
    }
  }

  it("includes replied-to root and merges the user burst ending in a mention", async () => {
    const sessionId = "c";

    const root: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "root" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u0",
      userName: "rooter",
      text: "Root",
      ts: 0,
      raw: { reference: {} },
    };

    const m1: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "user msg 1",
      ts: 1000,
      raw: { reference: { messageId: "root", channelId: sessionId } },
    };

    const m2: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m2" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "user msg 2",
      ts: 1100,
      raw: { reference: {} },
    };

    const m3: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m3" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "<@bot> user msg 3",
      ts: 1200,
      raw: { reference: {} },
    };

    const adapter = new MultiFakeAdapter({
      [`${sessionId}:root`]: root,
      [`${sessionId}:m1`]: m1,
      [`${sessionId}:m2`]: m2,
      [`${sessionId}:m3`]: m3,
    });

    const out = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      trigger: { type: "mention", msgRef: m3.ref },
    });

    expect(out.chainMessageIds).toEqual(["root", "m1", "m2", "m3"]);
    expect(out.mergedGroups.length).toBe(2);
    expect(out.mergedGroups[0]?.messageIds).toEqual(["root"]);
    expect(out.mergedGroups[1]?.messageIds).toEqual(["m1", "m2", "m3"]);

    expect(out.messages.length).toBe(2);

    const merged = out.messages[1]?.content;
    expect(typeof merged).toBe("string");
    expect(merged as string).toContain("user msg 1");
    expect(merged as string).toContain("user msg 2");
    expect(merged as string).toContain("user msg 3");
    expect(merged as string).not.toContain("<@bot>");
  });
});

describe("request-composition active channel burst rules", () => {
  class ListFakeAdapter implements SurfaceAdapter {
    constructor(private readonly messages: SurfaceMessage[]) {}

    async connect(): Promise<void> {
      throw new Error("not implemented");
    }
    async disconnect(): Promise<void> {
      throw new Error("not implemented");
    }

    async getSelf(): Promise<SurfaceSelf> {
      throw new Error("not implemented");
    }
    async getCapabilities(): Promise<AdapterCapabilities> {
      throw new Error("not implemented");
    }

    async listSessions(): Promise<SurfaceSession[]> {
      throw new Error("not implemented");
    }

    async startOutput(
      _sessionRef: SessionRef,
      _opts?: StartOutputOpts,
    ): Promise<SurfaceOutputStream> {
      throw new Error("not implemented");
    }

    async sendMsg(
      _sessionRef: SessionRef,
      _content: ContentOpts,
      _opts?: SendOpts,
    ): Promise<MsgRef> {
      throw new Error("not implemented");
    }

    async readMsg(msgRef: MsgRef): Promise<SurfaceMessage | null> {
      const m = this.messages.find(
        (x) => x.session.channelId === msgRef.channelId && x.ref.messageId === msgRef.messageId,
      );
      return m ?? null;
    }

    async listMsg(
      sessionRef: SessionRef,
      opts?: LimitOpts,
    ): Promise<SurfaceMessage[]> {
      const limit = Math.max(1, opts?.limit ?? 50);
      const inChannel = this.messages.filter(
        (m) => m.session.channelId === sessionRef.channelId,
      );
      // Return a recent-ish slice (ordering doesn't matter; composeRecentChannelMessages sorts).
      return inChannel.slice(Math.max(0, inChannel.length - limit));
    }

    async editMsg(_msgRef: MsgRef, _content: ContentOpts): Promise<void> {
      throw new Error("not implemented");
    }

    async deleteMsg(_msgRef: MsgRef): Promise<void> {
      throw new Error("not implemented");
    }

    async getReplyContext(
      _msgRef: MsgRef,
      _opts?: LimitOpts,
    ): Promise<SurfaceMessage[]> {
      return [];
    }

    async addReaction(_msgRef: MsgRef, _reaction: string): Promise<void> {
      throw new Error("not implemented");
    }

    async removeReaction(_msgRef: MsgRef, _reaction: string): Promise<void> {
      throw new Error("not implemented");
    }

    async listReactions(_msgRef: MsgRef): Promise<string[]> {
      return [];
    }

    async subscribe(_handler: AdapterEventHandler): Promise<AdapterSubscription> {
      throw new Error("not implemented");
    }

    async getUnRead(_sessionRef: SessionRef): Promise<SurfaceMessage[]> {
      throw new Error("not implemented");
    }

    async markRead(
      _sessionRef: SessionRef,
      _upToMsgRef?: MsgRef,
    ): Promise<void> {
      throw new Error("not implemented");
    }
  }

  it("stops at >3h age cutoff (active mode, non-trigger)", async () => {
    const sessionId = "c";
    const anchorTs = 10_000_000;

    const mk = (id: string, ts: number): SurfaceMessage => ({
      ref: { platform: "discord", channelId: sessionId, messageId: id },
      session: { platform: "discord", channelId: sessionId },
      userId: "u",
      userName: "user",
      text: `msg_${id}`,
      ts,
      raw: { reference: {} },
    });

    const msgs = [
      mk("7", anchorTs - (3 * 60 * 60 * 1000 + 1)), // too old
      mk("8", anchorTs - 90 * 60 * 1000),
      mk("9", anchorTs - 30 * 60 * 1000),
      mk("10", anchorTs),
    ];

    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 20,
      triggerMsgRef: { platform: "discord", channelId: sessionId, messageId: "10" },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(["8", "9", "10"]);
  });

  it("stops at >3h age cutoff (active mode, mention trigger)", async () => {
    const sessionId = "c";
    const anchorTs = 10_000_000;

    const mk = (id: string, ts: number, text: string): SurfaceMessage => ({
      ref: { platform: "discord", channelId: sessionId, messageId: id },
      session: { platform: "discord", channelId: sessionId },
      userId: "u",
      userName: "user",
      text,
      ts,
      raw: { reference: {} },
    });

    const msgs = [
      mk("7", anchorTs - (3 * 60 * 60 * 1000 + 1), "too_old"),
      mk("8", anchorTs - 90 * 60 * 1000, "ok_8"),
      mk("9", anchorTs - 30 * 60 * 1000, "ok_9"),
      mk("10", anchorTs, "<@bot> ok_10"),
    ];

    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 20,
      triggerMsgRef: { platform: "discord", channelId: sessionId, messageId: "10" },
      triggerType: "mention",
    });

    expect(out.chainMessageIds).toEqual(["8", "9", "10"]);
  });

  it("stops at >2h silence gap cutoff (active mode, non-trigger)", async () => {
    const sessionId = "c";
    const anchorTs = 10_000_000;

    const mk = (id: string, ts: number): SurfaceMessage => ({
      ref: { platform: "discord", channelId: sessionId, messageId: id },
      session: { platform: "discord", channelId: sessionId },
      userId: "u",
      userName: "user",
      text: `msg_${id}`,
      ts,
      raw: { reference: {} },
    });

    const msgs = [
      mk("8", anchorTs - 3 * 60 * 60 * 1000), // age ok, but gap too large
      mk("9", anchorTs - 30 * 60 * 1000),
      mk("10", anchorTs),
    ];

    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 20,
      triggerMsgRef: { platform: "discord", channelId: sessionId, messageId: "10" },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(["9", "10"]);
  });

  it("stops at >2h silence gap cutoff (active mode, mention trigger)", async () => {
    const sessionId = "c";
    const anchorTs = 10_000_000;

    const mk = (id: string, ts: number, text: string): SurfaceMessage => ({
      ref: { platform: "discord", channelId: sessionId, messageId: id },
      session: { platform: "discord", channelId: sessionId },
      userId: "u",
      userName: "user",
      text,
      ts,
      raw: { reference: {} },
    });

    const msgs = [
      mk("8", anchorTs - 3 * 60 * 60 * 1000, "gap_too_large"),
      mk("9", anchorTs - 30 * 60 * 1000, "ok_9"),
      mk("10", anchorTs, "<@bot> ok_10"),
    ];

    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 20,
      triggerMsgRef: { platform: "discord", channelId: sessionId, messageId: "10" },
      triggerType: "mention",
    });

    expect(out.chainMessageIds).toEqual(["9", "10"]);
  });

  it("does not expand transcripts for bot messages older than 1h", async () => {
    const sessionId = "c";
    const anchorTs = 10_000_000;

    const mkUser = (id: string, ts: number): SurfaceMessage => ({
      ref: { platform: "discord", channelId: sessionId, messageId: id },
      session: { platform: "discord", channelId: sessionId },
      userId: "u",
      userName: "user",
      text: `user_${id}`,
      ts,
      raw: { reference: {} },
    });

    const mkBot = (id: string, ts: number, text: string): SurfaceMessage => ({
      ref: { platform: "discord", channelId: sessionId, messageId: id },
      session: { platform: "discord", channelId: sessionId },
      userId: "bot",
      userName: "lilac",
      text,
      ts,
      raw: { reference: {} },
    });

    const msgs = [
      mkBot("8", anchorTs - 2 * 60 * 60 * 1000, "old bot text"),
      mkBot("9", anchorTs - 30 * 60 * 1000, "recent bot text"),
      mkUser("10", anchorTs),
    ];

    const transcriptStore: TranscriptStore = {
      saveRequestTranscript() {},
      linkSurfaceMessagesToRequest() {},
      close() {},
      getTranscriptBySurfaceMessage(input) {
        const expanded = (content: string): ModelMessage[] => [
          { role: "assistant", content },
        ];
        if (input.messageId === "8") {
          return {
            requestId: "r8",
            sessionId,
            requestClient: "discord",
            createdTs: 0,
            updatedTs: 0,
            messages: expanded("EXPANDED_OLD"),
          };
        }
        if (input.messageId === "9") {
          return {
            requestId: "r9",
            sessionId,
            requestClient: "discord",
            createdTs: 0,
            updatedTs: 0,
            messages: expanded("EXPANDED_RECENT"),
          };
        }
        return null;
      },
    };

    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 20,
      transcriptStore,
      triggerMsgRef: { platform: "discord", channelId: sessionId, messageId: "10" },
      triggerType: undefined,
    });

    const text = out.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");

    expect(text).toContain("EXPANDED_RECENT");
    expect(text).not.toContain("EXPANDED_OLD");
    expect(text).toContain("old bot text");
  });

  it("does not expand transcripts for bot messages older than 1h (mention trigger)", async () => {
    const sessionId = "c";
    const anchorTs = 10_000_000;

    const mkUser = (id: string, ts: number, text: string): SurfaceMessage => ({
      ref: { platform: "discord", channelId: sessionId, messageId: id },
      session: { platform: "discord", channelId: sessionId },
      userId: "u",
      userName: "user",
      text,
      ts,
      raw: { reference: {} },
    });

    const mkBot = (id: string, ts: number, text: string): SurfaceMessage => ({
      ref: { platform: "discord", channelId: sessionId, messageId: id },
      session: { platform: "discord", channelId: sessionId },
      userId: "bot",
      userName: "lilac",
      text,
      ts,
      raw: { reference: {} },
    });

    const msgs = [
      mkBot("8", anchorTs - 2 * 60 * 60 * 1000, "old bot text"),
      mkBot("9", anchorTs - 30 * 60 * 1000, "recent bot text"),
      mkUser("10", anchorTs, "<@bot> trigger"),
    ];

    const transcriptStore: TranscriptStore = {
      saveRequestTranscript() {},
      linkSurfaceMessagesToRequest() {},
      close() {},
      getTranscriptBySurfaceMessage(input) {
        const expanded = (content: string): ModelMessage[] => [
          { role: "assistant", content },
        ];
        if (input.messageId === "8") {
          return {
            requestId: "r8",
            sessionId,
            requestClient: "discord",
            createdTs: 0,
            updatedTs: 0,
            messages: expanded("EXPANDED_OLD"),
          };
        }
        if (input.messageId === "9") {
          return {
            requestId: "r9",
            sessionId,
            requestClient: "discord",
            createdTs: 0,
            updatedTs: 0,
            messages: expanded("EXPANDED_RECENT"),
          };
        }
        return null;
      },
    };

    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 20,
      transcriptStore,
      triggerMsgRef: { platform: "discord", channelId: sessionId, messageId: "10" },
      triggerType: "mention",
    });

    const text = out.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");

    expect(text).toContain("EXPANDED_RECENT");
    expect(text).not.toContain("EXPANDED_OLD");
    expect(text).toContain("old bot text");
  });

  it("treats mention that is a reply as an explicit reply chain", async () => {
    const sessionId = "c";

    const root: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "root" },
      session: { platform: "discord", channelId: sessionId },
      userId: "bot",
      userName: "lilac",
      text: "old bot text",
      ts: 0,
      raw: { reference: {} },
    };

    const replyMention: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u",
      userName: "user",
      text: "<@bot> continuing",
      // Make it "too old" for active-burst cutoffs if they applied.
      ts: 10_000_000,
      raw: { reference: { messageId: "root", channelId: sessionId } },
    };

    class ReplyChainAdapter implements SurfaceAdapter {
      constructor(private readonly messages: Record<string, SurfaceMessage>) {}

      async connect(): Promise<void> {
        throw new Error("not implemented");
      }
      async disconnect(): Promise<void> {
        throw new Error("not implemented");
      }

      async getSelf(): Promise<SurfaceSelf> {
        throw new Error("not implemented");
      }
      async getCapabilities(): Promise<AdapterCapabilities> {
        throw new Error("not implemented");
      }

      async listSessions(): Promise<SurfaceSession[]> {
        throw new Error("not implemented");
      }

      async startOutput(
        _sessionRef: SessionRef,
        _opts?: StartOutputOpts,
      ): Promise<SurfaceOutputStream> {
        throw new Error("not implemented");
      }

      async sendMsg(
        _sessionRef: SessionRef,
        _content: ContentOpts,
        _opts?: SendOpts,
      ): Promise<MsgRef> {
        throw new Error("not implemented");
      }

      async readMsg(msgRef: MsgRef): Promise<SurfaceMessage | null> {
        const key = `${msgRef.channelId}:${msgRef.messageId}`;
        return this.messages[key] ?? null;
      }

      async listMsg(
        _sessionRef: SessionRef,
        _opts?: LimitOpts,
      ): Promise<SurfaceMessage[]> {
        throw new Error("listMsg should not be called");
      }

      async editMsg(_msgRef: MsgRef, _content: ContentOpts): Promise<void> {
        throw new Error("not implemented");
      }

      async deleteMsg(_msgRef: MsgRef): Promise<void> {
        throw new Error("not implemented");
      }

      async getReplyContext(
        _msgRef: MsgRef,
        _opts?: LimitOpts,
      ): Promise<SurfaceMessage[]> {
        return [];
      }

      async addReaction(_msgRef: MsgRef, _reaction: string): Promise<void> {
        throw new Error("not implemented");
      }

      async removeReaction(_msgRef: MsgRef, _reaction: string): Promise<void> {
        throw new Error("not implemented");
      }

      async listReactions(_msgRef: MsgRef): Promise<string[]> {
        return [];
      }

      async subscribe(_handler: AdapterEventHandler): Promise<AdapterSubscription> {
        throw new Error("not implemented");
      }

      async getUnRead(_sessionRef: SessionRef): Promise<SurfaceMessage[]> {
        throw new Error("not implemented");
      }

      async markRead(
        _sessionRef: SessionRef,
        _upToMsgRef?: MsgRef,
      ): Promise<void> {
        throw new Error("not implemented");
      }
    }

    const transcriptStore: TranscriptStore = {
      saveRequestTranscript() {},
      linkSurfaceMessagesToRequest() {},
      close() {},
      getTranscriptBySurfaceMessage(input) {
        if (input.messageId !== "root") return null;
        return {
          requestId: "rroot",
          sessionId,
          requestClient: "discord",
          createdTs: 0,
          updatedTs: 0,
          messages: [{ role: "assistant", content: "EXPANDED_ROOT" }],
        };
      },
    };

    const adapter = new ReplyChainAdapter({
      [`${sessionId}:root`]: root,
      [`${sessionId}:m1`]: replyMention,
    });

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 20,
      transcriptStore,
      triggerMsgRef: replyMention.ref,
      triggerType: "mention",
    });

    expect(out.chainMessageIds).toEqual(["root", "m1"]);

    const combined = out.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(combined).toContain("EXPANDED_ROOT");
    expect(combined).not.toContain("old bot text");
  });
});

describe("request-composition system message filtering", () => {
  class RawListAdapter implements SurfaceAdapter {
    constructor(private readonly messages: SurfaceMessage[]) {}

    async connect(): Promise<void> {
      throw new Error("not implemented");
    }
    async disconnect(): Promise<void> {
      throw new Error("not implemented");
    }
    async getSelf(): Promise<SurfaceSelf> {
      throw new Error("not implemented");
    }
    async getCapabilities(): Promise<AdapterCapabilities> {
      throw new Error("not implemented");
    }
    async listSessions(): Promise<SurfaceSession[]> {
      throw new Error("not implemented");
    }
    async startOutput(
      _sessionRef: SessionRef,
      _opts?: StartOutputOpts,
    ): Promise<SurfaceOutputStream> {
      throw new Error("not implemented");
    }
    async sendMsg(
      _sessionRef: SessionRef,
      _content: ContentOpts,
      _opts?: SendOpts,
    ): Promise<MsgRef> {
      throw new Error("not implemented");
    }

    async readMsg(msgRef: MsgRef): Promise<SurfaceMessage | null> {
      const m = this.messages.find(
        (x) => x.session.channelId === msgRef.channelId && x.ref.messageId === msgRef.messageId,
      );
      return m ?? null;
    }

    async listMsg(
      sessionRef: SessionRef,
      _opts?: LimitOpts,
    ): Promise<SurfaceMessage[]> {
      return this.messages.filter((m) => m.session.channelId === sessionRef.channelId);
    }

    async editMsg(_msgRef: MsgRef, _content: ContentOpts): Promise<void> {
      throw new Error("not implemented");
    }
    async deleteMsg(_msgRef: MsgRef): Promise<void> {
      throw new Error("not implemented");
    }
    async getReplyContext(
      _msgRef: MsgRef,
      _opts?: LimitOpts,
    ): Promise<SurfaceMessage[]> {
      return [];
    }
    async addReaction(_msgRef: MsgRef, _reaction: string): Promise<void> {
      throw new Error("not implemented");
    }
    async removeReaction(_msgRef: MsgRef, _reaction: string): Promise<void> {
      throw new Error("not implemented");
    }
    async listReactions(_msgRef: MsgRef): Promise<string[]> {
      return [];
    }
    async subscribe(_handler: AdapterEventHandler): Promise<AdapterSubscription> {
      throw new Error("not implemented");
    }
    async getUnRead(_sessionRef: SessionRef): Promise<SurfaceMessage[]> {
      throw new Error("not implemented");
    }
    async markRead(_sessionRef: SessionRef, _upToMsgRef?: MsgRef): Promise<void> {
      throw new Error("not implemented");
    }
  }

  it("excludes non-chat/system surface messages from default model context", async () => {
    const sessionId = "c";

    const mk = (id: string, ts: number, text: string, isChat: boolean): SurfaceMessage => ({
      ref: { platform: "discord", channelId: sessionId, messageId: id },
      session: { platform: "discord", channelId: sessionId },
      userId: "u",
      userName: "user",
      text,
      ts,
      raw: { discord: { isChat } },
    });

    const msgs = [
      mk("1", 1, "hello", true),
      mk("sys", 2, "created a thread", false),
      mk("2", 3, "world", true),
    ];

    const adapter = new RawListAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 20,
    });

    expect(out.chainMessageIds).toEqual(["1", "2"]);

    const combined = out.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");

    expect(combined).toContain("hello");
    expect(combined).toContain("world");
    expect(combined).not.toContain("created a thread");
  });

  it("returns null for composeSingleMessage when message is not chat", async () => {
    const sessionId = "c";

    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "sys" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u",
      userName: "user",
      text: "created a thread",
      ts: 0,
      raw: { discord: { isChat: false } },
    };

    const adapter = new RawListAdapter([msg]);

    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
    });

    expect(out).toBe(null);
  });
});

describe("request-composition session divider", () => {
  class DividerAdapter implements SurfaceAdapter {
    constructor(private readonly messages: SurfaceMessage[]) {}

    async connect(): Promise<void> {
      throw new Error("not implemented");
    }
    async disconnect(): Promise<void> {
      throw new Error("not implemented");
    }

    async getSelf(): Promise<SurfaceSelf> {
      return { platform: "discord", userId: "bot", userName: "lilac" };
    }
    async getCapabilities(): Promise<AdapterCapabilities> {
      throw new Error("not implemented");
    }

    async listSessions(): Promise<SurfaceSession[]> {
      throw new Error("not implemented");
    }

    async startOutput(
      _sessionRef: SessionRef,
      _opts?: StartOutputOpts,
    ): Promise<SurfaceOutputStream> {
      throw new Error("not implemented");
    }

    async sendMsg(
      _sessionRef: SessionRef,
      _content: ContentOpts,
      _opts?: SendOpts,
    ): Promise<MsgRef> {
      throw new Error("not implemented");
    }

    async readMsg(msgRef: MsgRef): Promise<SurfaceMessage | null> {
      return (
        this.messages.find(
          (m) =>
            m.session.channelId === msgRef.channelId &&
            m.ref.messageId === msgRef.messageId,
        ) ?? null
      );
    }

    async listMsg(
      sessionRef: SessionRef,
      opts?: LimitOpts,
    ): Promise<SurfaceMessage[]> {
      const inChannel = this.messages
        .filter((m) => m.session.channelId === sessionRef.channelId)
        .slice()
        .sort((a, b) => a.ts - b.ts);

      let filtered = inChannel;
      if (opts?.beforeMessageId) {
        const before = inChannel.find((m) => m.ref.messageId === opts.beforeMessageId);
        if (before) {
          filtered = filtered.filter((m) => m.ts < before.ts);
        }
      }

      if (opts?.afterMessageId) {
        const after = inChannel.find((m) => m.ref.messageId === opts.afterMessageId);
        if (after) {
          filtered = filtered.filter((m) => m.ts > after.ts);
        }
      }

      const limit = Math.max(1, opts?.limit ?? 50);
      return filtered.slice(Math.max(0, filtered.length - limit));
    }

    async editMsg(_msgRef: MsgRef, _content: ContentOpts): Promise<void> {
      throw new Error("not implemented");
    }
    async deleteMsg(_msgRef: MsgRef): Promise<void> {
      throw new Error("not implemented");
    }

    async getReplyContext(
      _msgRef: MsgRef,
      _opts?: LimitOpts,
    ): Promise<SurfaceMessage[]> {
      return [];
    }

    async addReaction(_msgRef: MsgRef, _reaction: string): Promise<void> {
      throw new Error("not implemented");
    }
    async removeReaction(_msgRef: MsgRef, _reaction: string): Promise<void> {
      throw new Error("not implemented");
    }

    async listReactions(_msgRef: MsgRef): Promise<string[]> {
      return [];
    }

    async subscribe(_handler: AdapterEventHandler): Promise<AdapterSubscription> {
      throw new Error("not implemented");
    }

    async getUnRead(_sessionRef: SessionRef): Promise<SurfaceMessage[]> {
      throw new Error("not implemented");
    }

    async markRead(_sessionRef: SessionRef, _upToMsgRef?: MsgRef): Promise<void> {
      throw new Error("not implemented");
    }
  }

  it("cuts off recent context at the most recent divider", async () => {
    const sessionId = "c";

    const msgs: SurfaceMessage[] = [
      {
        ref: { platform: "discord", channelId: sessionId, messageId: "1" },
        session: { platform: "discord", channelId: sessionId },
        userId: "u",
        userName: "user",
        text: "before",
        ts: 1,
        raw: { discord: { isChat: true } },
      },
      {
        ref: { platform: "discord", channelId: sessionId, messageId: "d" },
        session: { platform: "discord", channelId: sessionId },
        userId: "bot",
        userName: "lilac",
        text: "[LILAC_SESSION_DIVIDER] (by user)",
        ts: 2,
        raw: { discord: { isChat: true } },
      },
      {
        ref: { platform: "discord", channelId: sessionId, messageId: "2" },
        session: { platform: "discord", channelId: sessionId },
        userId: "u",
        userName: "user",
        text: "after_1",
        ts: 3,
        raw: { discord: { isChat: true } },
      },
      {
        ref: { platform: "discord", channelId: sessionId, messageId: "3" },
        session: { platform: "discord", channelId: sessionId },
        userId: "u",
        userName: "user",
        text: "after_2",
        ts: 4,
        raw: { discord: { isChat: true } },
      },
    ];

    const adapter = new DividerAdapter(msgs);
    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 50,
    });

    expect(out.chainMessageIds).toEqual(["2", "3"]);
    const combined = out.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(combined).toContain("after_1");
    expect(combined).toContain("after_2");
    expect(combined).not.toContain("LILAC_SESSION_DIVIDER");
    expect(combined).not.toContain("before");
  });

  it("does not cut off context at divider from a different bot id", async () => {
    const sessionId = "c";

    const msgs: SurfaceMessage[] = [
      {
        ref: { platform: "discord", channelId: sessionId, messageId: "1" },
        session: { platform: "discord", channelId: sessionId },
        userId: "u",
        userName: "user",
        text: "before",
        ts: 1,
        raw: { discord: { isChat: true } },
      },
      {
        ref: { platform: "discord", channelId: sessionId, messageId: "d_other" },
        session: { platform: "discord", channelId: sessionId },
        userId: "bot_other",
        userName: "lilac-other",
        text: "[LILAC_SESSION_DIVIDER] (by user)",
        ts: 2,
        raw: { discord: { isChat: true } },
      },
      {
        ref: { platform: "discord", channelId: sessionId, messageId: "2" },
        session: { platform: "discord", channelId: sessionId },
        userId: "u",
        userName: "user",
        text: "after_1",
        ts: 3,
        raw: { discord: { isChat: true } },
      },
      {
        ref: { platform: "discord", channelId: sessionId, messageId: "3" },
        session: { platform: "discord", channelId: sessionId },
        userId: "u",
        userName: "user",
        text: "after_2",
        ts: 4,
        raw: { discord: { isChat: true } },
      },
    ];

    const adapter = new DividerAdapter(msgs);
    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 50,
    });

    expect(out.chainMessageIds).toEqual(["1", "2", "3"]);
    const combined = out.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(combined).toContain("before");
    expect(combined).toContain("after_1");
    expect(combined).toContain("after_2");
    expect(combined).not.toContain("LILAC_SESSION_DIVIDER");
  });

  it("still recognizes legacy divider format for cutoff", async () => {
    const sessionId = "c";

    const msgs: SurfaceMessage[] = [
      {
        ref: { platform: "discord", channelId: sessionId, messageId: "1" },
        session: { platform: "discord", channelId: sessionId },
        userId: "u",
        userName: "user",
        text: "before",
        ts: 1,
        raw: { discord: { isChat: true } },
      },
      {
        ref: { platform: "discord", channelId: sessionId, messageId: "d" },
        session: { platform: "discord", channelId: sessionId },
        userId: "bot",
        userName: "lilac",
        text: "--- Session Divider ---\n[LILAC_SESSION_DIVIDER]",
        ts: 2,
        raw: { discord: { isChat: true } },
      },
      {
        ref: { platform: "discord", channelId: sessionId, messageId: "2" },
        session: { platform: "discord", channelId: sessionId },
        userId: "u",
        userName: "user",
        text: "after_1",
        ts: 3,
        raw: { discord: { isChat: true } },
      },
    ];

    const adapter = new DividerAdapter(msgs);
    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 50,
    });

    expect(out.chainMessageIds).toEqual(["2"]);
    const combined = out.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(combined).toContain("after_1");
    expect(combined).not.toContain("before");
    expect(combined).not.toContain("LILAC_SESSION_DIVIDER");
  });

  it("cuts off reply-chain context at the most recent divider", async () => {
    const sessionId = "c";

    const root: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "root" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u0",
      userName: "rooter",
      text: "Root",
      ts: 1,
      raw: { reference: {} },
    };

    const divider: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "div" },
      session: { platform: "discord", channelId: sessionId },
      userId: "bot",
      userName: "lilac",
      text: "[LILAC_SESSION_DIVIDER] (by user)",
      ts: 50,
      raw: { reference: {} },
    };

    const m1: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "user msg 1",
      ts: 100,
      raw: { reference: { messageId: "root", channelId: sessionId } },
    };

    const m2: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m2" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "user msg 2",
      ts: 110,
      raw: { reference: { messageId: "m1", channelId: sessionId } },
    };

    const adapter = new DividerAdapter([root, divider, m1, m2]);

    const out = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      trigger: { type: "reply", msgRef: m2.ref },
      maxDepth: 10,
    });

    // Reply chains intentionally ignore the divider.
    expect(out.chainMessageIds).toEqual(["root", "m1", "m2"]);
    const combined = out.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(combined).toContain("user msg 1");
    expect(combined).toContain("user msg 2");
    expect(combined).toContain("Root");
    expect(combined).not.toContain("LILAC_SESSION_DIVIDER");
  });

  it("cuts off mention-thread context at the most recent divider", async () => {
    const sessionId = "c";

    const root: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "root" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u0",
      userName: "rooter",
      text: "Root",
      ts: 1,
      raw: { reference: {} },
    };

    const divider: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "div" },
      session: { platform: "discord", channelId: sessionId },
      userId: "bot",
      userName: "lilac",
      text: "[LILAC_SESSION_DIVIDER] (by user)",
      ts: 50,
      raw: { reference: {} },
    };

    const m1: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "user msg 1",
      ts: 100,
      raw: { reference: { messageId: "root", channelId: sessionId } },
    };

    const m2: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m2" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "user msg 2",
      ts: 110,
      raw: { reference: {} },
    };

    const m3: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m3" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "<@bot> user msg 3",
      ts: 120,
      raw: { reference: {} },
    };

    class MentionDividerAdapter extends DividerAdapter {
      override async getReplyContext(
        msgRef: MsgRef,
        opts?: LimitOpts,
      ): Promise<SurfaceMessage[]> {
        const base = await this.readMsg(msgRef);
        if (!base) return [];

        const limit = opts?.limit ?? 50;
        const all = [root, divider, m1, m2, m3].slice().sort((a, b) => a.ts - b.ts);
        const half = Math.max(1, Math.floor(limit / 2));
        const beforeAll = all.filter((m) => m.ts <= base.ts);
        const before = beforeAll.slice(Math.max(0, beforeAll.length - half));
        const after = all.filter((m) => m.ts > base.ts).slice(0, half);
        return before.concat(after);
      }
    }

    const adapter = new MentionDividerAdapter([root, divider, m1, m2, m3]);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 50,
      triggerMsgRef: m3.ref,
      triggerType: "mention",
    });

    expect(out.chainMessageIds).toEqual(["m1", "m2", "m3"]);
    const combined = out.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(combined).toContain("user msg 1");
    expect(combined).toContain("user msg 2");
    expect(combined).toContain("user msg 3");
    expect(combined).not.toContain("Root");
    expect(combined).not.toContain("LILAC_SESSION_DIVIDER");
  });
});
