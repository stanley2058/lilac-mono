import { afterEach, describe, expect, it } from "bun:test";

import {
  composeRequestMessages,
  composeSingleMessage,
} from "../../../src/surface/bridge/request-composition";
import type {
  AdapterEventHandler,
  AdapterSubscription,
  StartOutputOpts,
  SurfaceAdapter,
  SurfaceOutputStream,
} from "../../../src/surface/adapter";
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
