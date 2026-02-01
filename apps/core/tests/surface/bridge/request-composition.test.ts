import { afterEach, describe, expect, it } from "bun:test";

import { composeSingleMessage } from "../../../src/surface/bridge/request-composition";
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
  constructor(private readonly message: SurfaceMessage) {}

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
    throw new Error("not implemented");
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
