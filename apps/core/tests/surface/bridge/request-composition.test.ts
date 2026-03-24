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

  async sendMsg(_sessionRef: SessionRef, _content: ContentOpts, _opts?: SendOpts): Promise<MsgRef> {
    throw new Error("not implemented");
  }

  async readMsg(_msgRef: MsgRef): Promise<SurfaceMessage | null> {
    return this.message;
  }

  async listMsg(_sessionRef: SessionRef, _opts?: LimitOpts): Promise<SurfaceMessage[]> {
    throw new Error("not implemented");
  }

  async editMsg(_msgRef: MsgRef, _content: ContentOpts): Promise<void> {
    throw new Error("not implemented");
  }

  async deleteMsg(_msgRef: MsgRef): Promise<void> {
    throw new Error("not implemented");
  }

  async getReplyContext(_msgRef: MsgRef, _opts?: LimitOpts): Promise<SurfaceMessage[]> {
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

  it("includes user alias in attribution header when configured", async () => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "discord-user",
      text: "hi",
      ts: 0,
    };

    const adapter = new FakeAdapter(msg, []);
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
      discordUserAliasById: new Map([["u", "Stanley"]]),
    });

    expect(out?.role).toBe("user");
    expect(typeof out?.content).toBe("string");
    expect(out!.content as string).toContain("user_alias=Stanley");
  });

  it("returns pure assistant text without discord attribution header", async () => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "bot",
      userName: "lilac",
      text: "[discord user_id=bot user_name=lilac message_id=m]\nassistant_output",
      ts: 0,
    };

    const adapter = new FakeAdapter(msg, []);
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
    });

    expect(out?.role).toBe("assistant");
    expect(typeof out?.content).toBe("string");
    expect(out!.content as string).toBe("assistant_output");
    expect(out!.content as string).not.toContain("[discord user_id=");
  });

  it("keeps bot embed-only messages untagged", async () => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "other-bot",
      userName: "github-bot",
      text: ["assistant embed title", "assistant embed body"].join("\n\n"),
      ts: 0,
    };

    const adapter = new FakeAdapter(msg, []);
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
    });

    expect(out?.role).toBe("user");
    expect(typeof out?.content).toBe("string");
    expect(out!.content as string).toContain("assistant embed title\n\nassistant embed body");
    expect(out!.content as string).toContain(
      "[discord user_id=other-bot user_name=github-bot message_id=m]",
    );
    expect(out!.content as string).not.toContain("[discord_embed]");
  });

  it("labels embed text separately from user-authored text", async () => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: ["check this out", "[discord_embed]", "preview title", "preview description"].join(
        "\n\n",
      ),
      ts: 0,
      raw: {
        content: "check this out",
        embeds: [
          {
            title: "preview title",
            description: "preview description",
          },
        ],
      },
    };

    const adapter = new FakeAdapter(msg, []);
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
    });

    expect(out?.role).toBe("user");
    expect(typeof out?.content).toBe("string");

    const content = out!.content as string;
    expect(content).toContain("check this out");
    expect(content).toContain("[discord_embed]");
    expect(content).toContain("preview title");
    expect(content).toContain("preview description");
    expect(content.indexOf("check this out")).toBeLessThan(content.indexOf("[discord_embed]"));
  });

  it("uses stored tagged text directly", async () => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: "@alice shared this\n\n[discord_embed]\n\npreview title",
      ts: 0,
      raw: {
        content: "<@123> shared this",
        embeds: [{ title: "preview title" }],
      },
    };

    const adapter = new FakeAdapter(msg, []);
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
    });

    expect(out?.role).toBe("user");
    expect(typeof out?.content).toBe("string");

    const content = out!.content as string;
    expect(content).toContain("@alice shared this");
    expect(content).not.toContain("<@123>");
    expect(content).toContain("[discord_embed]");
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

  it("keeps labeled embed text before attachment-derived parts", async () => {
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
      text: ["look", "[discord_embed]", "preview title"].join("\n\n"),
      ts: 0,
      raw: {
        content: "look",
        embeds: [{ title: "preview title" }],
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

    const content = out!.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.type).toBe("text");
    expect(content[0]?.text).toContain("look");
    expect(content[0]?.text).toContain("[discord_embed]");
    expect(content[1]?.type).toBe("text");
    expect(content[1]?.text).toContain("[discord_attachment");
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

  it("inlines text when mimeType is application/x-yaml", async () => {
    let calls = 0;
    // @ts-expect-error stub fetch
    globalThis.fetch = async () => {
      calls++;
      return new Response("name: lilac\nmode: active\n", {
        headers: { "content-type": "application/x-yaml" },
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
              url: "https://cdn.discordapp.com/attachments/1/2/config.yaml",
              filename: "config.yaml",
              mimeType: "application/x-yaml",
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
    expect(content[1].text).toContain("name: lilac");
    expect(calls).toBe(1);
  });

  it("inlines text when mimeType ends with +json", async () => {
    let calls = 0;
    // @ts-expect-error stub fetch
    globalThis.fetch = async () => {
      calls++;
      return new Response('{"status":"ok"}', {
        headers: { "content-type": "application/vnd.api+json" },
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
              url: "https://cdn.discordapp.com/attachments/1/2/doc.api.json",
              filename: "doc.api.json",
              mimeType: "application/vnd.api+json",
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
    expect(content[1].text).toContain('{"status":"ok"}');
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

  it("uses forward snapshot content and visible attachments only", async () => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: "Forwarded snapshot text",
      ts: 0,
      raw: {
        reference: {
          type: 1,
          messageId: "orig",
          channelId: "other",
        },
        attachments: [
          {
            url: "https://cdn.discordapp.com/attachments/orig/1/IMG_1.png",
            filename: "IMG_1.png",
            mimeType: "image/jpeg",
            size: 10,
          },
          {
            url: "https://cdn.discordapp.com/attachments/orig/2/IMG_2.png",
            filename: "IMG_2.png",
            mimeType: "image/jpeg",
            size: 10,
          },
          {
            url: "https://cdn.discordapp.com/attachments/orig/3/IMG_3.png",
            filename: "IMG_3.png",
            mimeType: "image/jpeg",
            size: 10,
          },
        ],
        messageSnapshots: [
          {
            message: {
              content: "Forwarded snapshot text",
              attachments: [
                {
                  url: "https://cdn.discordapp.com/attachments/fwd/1/IMG_VISIBLE.png",
                  filename: "IMG_VISIBLE.png",
                  mimeType: "image/jpeg",
                  size: 10,
                },
              ],
            },
          },
        ],
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

    const parts = out!.content as any[];
    expect(parts[0].type).toBe("text");
    expect(parts[0].text).toContain("Forwarded snapshot text");

    const imageParts = parts.filter((p) => p && p.type === "image");
    expect(imageParts.length).toBe(1);
    expect(String(imageParts[0].image)).toContain("IMG_VISIBLE.png");
  });

  it("uses forward snapshot embed string description when content is empty", async () => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: ["[discord_embed]", "forwarded embed text"].join("\n\n"),
      ts: 0,
      raw: {
        reference: {
          type: 1,
          messageId: "orig",
          channelId: "other",
        },
        messageSnapshots: [
          {
            message: {
              content: "",
              embeds: ["forwarded embed text"],
              attachments: [],
            },
          },
        ],
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
    expect(typeof out?.content).toBe("string");
    expect(out!.content as string).toContain("[discord_embed]");
    expect(out!.content as string).toContain("forwarded embed text");
  });

  it("uses forward snapshot embed title/description/image when content is empty", async () => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: [
        "[discord_embed]",
        "forwarded title",
        "forwarded description",
        "https://example.com/snapshot-image.png",
      ].join("\n\n"),
      ts: 0,
      raw: {
        reference: {
          type: 1,
          messageId: "orig",
          channelId: "other",
        },
        messageSnapshots: [
          {
            message: {
              content: "",
              embeds: [
                {
                  title: "forwarded title",
                  description: "forwarded description",
                  fields: [{ name: "internal", value: "skip-for-inbound" }],
                  image: { url: "https://example.com/snapshot-image.png" },
                  footer: { text: "skip-footer-for-inbound" },
                },
              ],
              attachments: [],
            },
          },
        ],
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
    expect(typeof out?.content).toBe("string");

    const content = out!.content as string;
    expect(content).toContain("[discord_embed]");
    expect(content).toContain("forwarded title");
    expect(content).toContain("forwarded description");
    expect(content).toContain("https://example.com/snapshot-image.png");
    expect(content).not.toContain("skip-for-inbound");
    expect(content).not.toContain("skip-footer-for-inbound");
  });

  it("uses stored tagged forwarded snapshot text directly", async () => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: "@alice forwarded this\n\n[discord_embed]\n\nforwarded title",
      ts: 0,
      raw: {
        reference: {
          type: 1,
          messageId: "orig",
          channelId: "other",
        },
        messageSnapshots: [
          {
            message: {
              content: "<@123> forwarded this",
              embeds: [{ title: "forwarded title" }],
              attachments: [],
            },
          },
        ],
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
    expect(typeof out?.content).toBe("string");

    const content = out!.content as string;
    expect(content).toContain("@alice forwarded this");
    expect(content).not.toContain("<@123>");
    expect(content).toContain("[discord_embed]");
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

    async listMsg(_sessionRef: SessionRef, _opts?: LimitOpts): Promise<SurfaceMessage[]> {
      throw new Error("not implemented");
    }

    async editMsg(_msgRef: MsgRef, _content: ContentOpts): Promise<void> {
      throw new Error("not implemented");
    }

    async deleteMsg(_msgRef: MsgRef): Promise<void> {
      throw new Error("not implemented");
    }

    async getReplyContext(msgRef: MsgRef, opts?: LimitOpts): Promise<SurfaceMessage[]> {
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

    async markRead(_sessionRef: SessionRef, _upToMsgRef?: MsgRef): Promise<void> {
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
    expect(merged as string).toContain("<@bot>");
  });

  it("walks mention context via merged-group heads", async () => {
    const sessionId = "c";

    const b0: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "b0" },
      session: { platform: "discord", channelId: sessionId },
      userId: "uB",
      userName: "userB",
      text: "user B - 0",
      ts: 0,
      raw: { reference: {} },
    };

    const a1: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "a1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "uA",
      userName: "userA",
      text: "user A - 1",
      ts: 120_000,
      raw: { reference: { messageId: "b0", channelId: sessionId } },
    };

    const a2: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "a2" },
      session: { platform: "discord", channelId: sessionId },
      userId: "uA",
      userName: "userA",
      text: "user A - 2",
      ts: 122_000,
      raw: { reference: {} },
    };

    const b1: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "b1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "uB",
      userName: "userB",
      text: "user B - 1",
      ts: 240_000,
      raw: { reference: { messageId: "a2", channelId: sessionId } },
    };

    const b2: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "b2" },
      session: { platform: "discord", channelId: sessionId },
      userId: "uB",
      userName: "userB",
      text: "<@bot> user B - 2",
      ts: 300_000,
      raw: { reference: {} },
    };

    const adapter = new MultiFakeAdapter({
      [`${sessionId}:b0`]: b0,
      [`${sessionId}:a1`]: a1,
      [`${sessionId}:a2`]: a2,
      [`${sessionId}:b1`]: b1,
      [`${sessionId}:b2`]: b2,
    });

    const out = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      trigger: { type: "mention", msgRef: b2.ref },
    });

    expect(out.chainMessageIds).toEqual(["b0", "a1", "a2", "b1", "b2"]);
    expect(out.mergedGroups).toEqual([
      { authorId: "uB", messageIds: ["b0"] },
      { authorId: "uA", messageIds: ["a1", "a2"] },
      { authorId: "uB", messageIds: ["b1", "b2"] },
    ]);

    expect(out.messages.length).toBe(3);
  });

  it("treats maxDepth as merged-group count when walking reply chains", async () => {
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

    const a1: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "a1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "uA",
      userName: "userA",
      text: "A1",
      ts: 1_000,
      raw: { reference: { messageId: "root", channelId: sessionId } },
    };

    const a2: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "a2" },
      session: { platform: "discord", channelId: sessionId },
      userId: "uA",
      userName: "userA",
      text: "A2",
      ts: 1_100,
      raw: { reference: {} },
    };

    const b1: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "b1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "uB",
      userName: "userB",
      text: "B1",
      ts: 2_000,
      raw: { reference: { messageId: "a2", channelId: sessionId } },
    };

    const b2: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "b2" },
      session: { platform: "discord", channelId: sessionId },
      userId: "uB",
      userName: "userB",
      text: "B2",
      ts: 2_100,
      raw: { reference: {} },
    };

    const adapter = new MultiFakeAdapter({
      [`${sessionId}:root`]: root,
      [`${sessionId}:a1`]: a1,
      [`${sessionId}:a2`]: a2,
      [`${sessionId}:b1`]: b1,
      [`${sessionId}:b2`]: b2,
    });

    const out = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      trigger: { type: "reply", msgRef: b2.ref },
      maxDepth: 2,
    });

    expect(out.chainMessageIds).toEqual(["a1", "a2", "b1", "b2"]);
    expect(out.mergedGroups).toEqual([
      { authorId: "uA", messageIds: ["a1", "a2"] },
      { authorId: "uB", messageIds: ["b1", "b2"] },
    ]);
  });

  it("uses only the trigger group for mention-time context", async () => {
    const sessionId = "c";
    const minuteMs = 60_000;

    const m1: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "A",
      ts: 47 * minuteMs,
      raw: { reference: {} },
    };

    const m2: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m2" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "B",
      ts: 50 * minuteMs,
      raw: { reference: {} },
    };

    const m3: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m3" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "<@bot> C",
      ts: 55 * minuteMs,
      raw: { reference: {} },
    };

    const adapter = new MultiFakeAdapter({
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

    expect(out.chainMessageIds).toEqual(["m3"]);
    expect(out.mergedGroups).toEqual([{ authorId: "u1", messageIds: ["m3"] }]);

    expect(out.messages.length).toBe(1);
    expect(typeof out.messages[0]?.content).toBe("string");
    expect(out.messages[0]!.content as string).toContain("C");
    expect(out.messages[0]!.content as string).not.toContain("A");
    expect(out.messages[0]!.content as string).not.toContain("B");
  });

  it("keeps embed previews labeled in composed request messages", async () => {
    const sessionId = "c";

    const m1: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: ["<@bot> check this", "[discord_embed]", "preview title", "preview description"].join(
        "\n\n",
      ),
      ts: 0,
      raw: {
        content: "<@bot> check this",
        embeds: [
          {
            title: "preview title",
            description: "preview description",
          },
        ],
        reference: {},
      },
    };

    const adapter = new MultiFakeAdapter({
      [`${sessionId}:m1`]: m1,
    });

    const out = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      trigger: { type: "mention", msgRef: m1.ref },
    });

    expect(out.messages).toHaveLength(1);
    expect(typeof out.messages[0]?.content).toBe("string");

    const content = out.messages[0]!.content as string;
    expect(content).toContain("check this");
    expect(content).toContain("[discord_embed]");
    expect(content).toContain("preview title");
    expect(content).toContain("preview description");
  });

  it("does not anchor mention context to an older reply outside trigger group", async () => {
    const sessionId = "c";
    const minuteMs = 60_000;

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
      text: "old reply",
      ts: 47 * minuteMs,
      raw: { reference: { messageId: "root", channelId: sessionId } },
    };

    const m2: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m2" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "follow-up",
      ts: 50 * minuteMs,
      raw: { reference: {} },
    };

    const m3: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m3" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "<@bot> new ask",
      ts: 55 * minuteMs,
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

    expect(out.chainMessageIds).toEqual(["m3"]);
    expect(out.mergedGroups).toEqual([{ authorId: "u1", messageIds: ["m3"] }]);

    expect(out.messages.length).toBe(1);
    const merged = out.messages[0]?.content;
    expect(typeof merged).toBe("string");
    expect(merged as string).toContain("new ask");
    expect(merged as string).not.toContain("old reply");
    expect(merged as string).not.toContain("Root");
  });

  it("treats forwarded references as root and uses forwarded snapshot payload", async () => {
    const sessionId = "c";

    const root: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "root" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u0",
      userName: "rooter",
      text: "Root should not be expanded",
      ts: 0,
      raw: { reference: {} },
    };

    const forwardMention: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "fwd1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "",
      ts: 1_000,
      raw: {
        reference: {
          type: 1,
          messageId: "root",
          channelId: sessionId,
        },
        attachments: [
          {
            url: "https://cdn.discordapp.com/attachments/orig/1/IMG_1.png",
            filename: "IMG_1.png",
            mimeType: "image/jpeg",
            size: 10,
          },
          {
            url: "https://cdn.discordapp.com/attachments/orig/2/IMG_2.png",
            filename: "IMG_2.png",
            mimeType: "image/jpeg",
            size: 10,
          },
          {
            url: "https://cdn.discordapp.com/attachments/orig/3/IMG_3.png",
            filename: "IMG_3.png",
            mimeType: "image/jpeg",
            size: 10,
          },
        ],
        messageSnapshots: [
          {
            message: {
              content: "Forwarded snapshot text",
              attachments: [
                {
                  url: "https://cdn.discordapp.com/attachments/fwd/1/IMG_VISIBLE.png",
                  filename: "IMG_VISIBLE.png",
                  mimeType: "image/jpeg",
                  size: 10,
                },
              ],
            },
          },
        ],
      },
    };

    const adapter = new MultiFakeAdapter({
      [`${sessionId}:root`]: root,
      [`${sessionId}:fwd1`]: forwardMention,
    });

    const out = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      trigger: { type: "mention", msgRef: forwardMention.ref },
    });

    expect(out.chainMessageIds).toEqual(["fwd1"]);
    expect(out.messages.length).toBe(1);

    const content = out.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);

    const parts = content as any[];
    expect(parts[0].type).toBe("text");
    expect(parts[0].text).toContain("Forwarded snapshot text");

    const imageParts = parts.filter((p) => p && p.type === "image");
    expect(imageParts.length).toBe(1);
    expect(String(imageParts[0].image)).toContain("IMG_VISIBLE.png");
  });

  it("includes user alias in mention-thread attribution header when configured", async () => {
    const sessionId = "c";

    const m1: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "discord-user",
      text: "<@bot> hi",
      ts: 1000,
      raw: { reference: {} },
    };

    const adapter = new MultiFakeAdapter({
      [`${sessionId}:m1`]: m1,
    });

    const out = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      discordUserAliasById: new Map([["u1", "Stanley"]]),
      trigger: { type: "mention", msgRef: m1.ref },
    });

    expect(out.messages.length).toBe(1);
    expect(typeof out.messages[0]?.content).toBe("string");
    expect(out.messages[0]!.content as string).toContain("user_alias=Stanley");
  });
});

describe("request-composition active channel burst rules", () => {
  class ListFakeAdapter implements SurfaceAdapter {
    readonly listMsgCalls: Array<{ limit: number; beforeMessageId?: string }> = [];

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

    async listMsg(sessionRef: SessionRef, opts?: LimitOpts): Promise<SurfaceMessage[]> {
      const limit = Math.max(1, opts?.limit ?? 50);
      this.listMsgCalls.push({ limit, beforeMessageId: opts?.beforeMessageId });
      const before = opts?.beforeMessageId;
      const beforeMessage = before
        ? this.messages.find(
            (m) => m.session.channelId === sessionRef.channelId && m.ref.messageId === before,
          )
        : null;
      const inChannel = this.messages.filter((m) => {
        if (m.session.channelId !== sessionRef.channelId) return false;
        if (!beforeMessage) return true;
        if (m.ts < beforeMessage.ts) return true;
        if (m.ts > beforeMessage.ts) return false;
        return m.ref.messageId < beforeMessage.ref.messageId;
      });
      // Return a recent-ish slice (ordering doesn't matter; composeRecentChannelMessages sorts).
      return inChannel.slice(Math.max(0, inChannel.length - limit));
    }

    async editMsg(_msgRef: MsgRef, _content: ContentOpts): Promise<void> {
      throw new Error("not implemented");
    }

    async deleteMsg(_msgRef: MsgRef): Promise<void> {
      throw new Error("not implemented");
    }

    async getReplyContext(_msgRef: MsgRef, _opts?: LimitOpts): Promise<SurfaceMessage[]> {
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

  function makeSequentialActiveMessages(input: {
    sessionId: string;
    count: number;
    latestText?: string;
    gapAfterId?: number;
  }): SurfaceMessage[] {
    const anchorTs = 10_000_000;

    return Array.from({ length: input.count }, (_, index) => {
      const id = index + 1;
      const ts =
        input.gapAfterId && id <= input.gapAfterId
          ? anchorTs - 3 * 60 * 60 * 1000 - (input.gapAfterId - id) * 1_000
          : anchorTs - (input.count - id) * 1_000;

      return {
        ref: {
          platform: "discord",
          channelId: input.sessionId,
          messageId: String(id),
        },
        session: { platform: "discord", channelId: input.sessionId },
        userId: id % 3 === 0 ? "bot" : "u",
        userName: id % 3 === 0 ? "lilac" : "user",
        text: id === input.count ? (input.latestText ?? `msg_${id}`) : `msg_${id}`,
        ts,
        raw: { reference: {} },
      } satisfies SurfaceMessage;
    });
  }

  it("stops active history fetch at the first 16-message rung when prompt limit is filled", async () => {
    const sessionId = "c";
    const msgs = makeSequentialActiveMessages({ sessionId, count: 40 });
    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 8,
      triggerMsgRef: { platform: "discord", channelId: sessionId, messageId: "40" },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(["33", "34", "35", "36", "37", "38", "39", "40"]);
    expect(adapter.listMsgCalls).toEqual([{ limit: 16, beforeMessageId: "40" }]);
  });

  it("stops active history fetch at the first 16-message rung when a gap cutoff is already visible", async () => {
    const sessionId = "c";
    const msgs = makeSequentialActiveMessages({
      sessionId,
      count: 40,
      gapAfterId: 24,
    });
    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 20,
      triggerMsgRef: { platform: "discord", channelId: sessionId, messageId: "40" },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual([
      "25",
      "26",
      "27",
      "28",
      "29",
      "30",
      "31",
      "32",
      "33",
      "34",
      "35",
      "36",
      "37",
      "38",
      "39",
      "40",
    ]);
    expect(adapter.listMsgCalls).toEqual([{ limit: 16, beforeMessageId: "40" }]);
  });

  it("ramps active history fetch from 16 to 48 when more live context is needed", async () => {
    const sessionId = "c";
    const msgs = makeSequentialActiveMessages({ sessionId, count: 80 });
    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 40,
      triggerMsgRef: { platform: "discord", channelId: sessionId, messageId: "80" },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(
      Array.from({ length: 40 }, (_, index) => String(index + 41)),
    );
    expect(adapter.listMsgCalls).toEqual([
      { limit: 16, beforeMessageId: "80" },
      { limit: 32, beforeMessageId: "64" },
    ]);
  });

  it("ramps active history fetch from 16 to 48 to 112 when needed", async () => {
    const sessionId = "c";
    const msgs = makeSequentialActiveMessages({ sessionId, count: 160 });
    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 100,
      triggerMsgRef: { platform: "discord", channelId: sessionId, messageId: "160" },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(
      Array.from({ length: 100 }, (_, index) => String(index + 61)),
    );
    expect(adapter.listMsgCalls).toEqual([
      { limit: 16, beforeMessageId: "160" },
      { limit: 32, beforeMessageId: "144" },
      { limit: 64, beforeMessageId: "112" },
    ]);
  });

  it("ramps active history fetch to the 200-message cap for large continue expansions", async () => {
    const sessionId = "c";
    const msgs = makeSequentialActiveMessages({
      sessionId,
      count: 220,
      latestText: "!cont=200 current request",
    });
    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 8,
      triggerMsgRef: { platform: "discord", channelId: sessionId, messageId: "220" },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(
      Array.from({ length: 201 }, (_, index) => String(index + 20)),
    );
    expect(adapter.listMsgCalls).toEqual([
      { limit: 16, beforeMessageId: "220" },
      { limit: 32, beforeMessageId: "204" },
      { limit: 64, beforeMessageId: "172" },
      { limit: 88, beforeMessageId: "108" },
    ]);
  });

  it("stops at the first rung when a visible continue is already fully satisfied", async () => {
    const sessionId = "c";
    const msgs = makeSequentialActiveMessages({
      sessionId,
      count: 80,
      latestText: "!cont=2 current request",
    });
    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 40,
      triggerMsgRef: { platform: "discord", channelId: sessionId, messageId: "80" },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(["78", "79", "80"]);
    expect(adapter.listMsgCalls).toEqual([{ limit: 16, beforeMessageId: "80" }]);
  });

  it("stops at the first rung when a divider already bounds a large continue", async () => {
    const sessionId = "c";
    const msgs = makeSequentialActiveMessages({
      sessionId,
      count: 220,
      latestText: "!cont=200 current request",
    });
    msgs[209] = {
      ...msgs[209]!,
      userId: "bot",
      userName: "lilac",
      text: "[LILAC_SESSION_DIVIDER] (by user)",
    };
    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 8,
      triggerMsgRef: { platform: "discord", channelId: sessionId, messageId: "220" },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(
      Array.from({ length: 10 }, (_, index) => String(index + 211)),
    );
    expect(adapter.listMsgCalls).toEqual([{ limit: 16, beforeMessageId: "220" }]);
  });

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

  it("includes user alias in recent-channel attribution header when configured", async () => {
    const sessionId = "c";

    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "discord-user",
      text: "hello",
      ts: 1000,
      raw: { reference: {} },
    };

    const adapter = new ListFakeAdapter([msg]);
    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 8,
      discordUserAliasById: new Map([["u1", "Stanley"]]),
    });

    expect(out.messages.length).toBe(1);
    expect(typeof out.messages[0]?.content).toBe("string");
    expect(out.messages[0]!.content as string).toContain("user_alias=Stanley");
  });

  it("uses pure assistant surface text without discord attribution header", async () => {
    const sessionId = "c";
    const anchorTs = 10_000_000;

    const bot: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "b1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "bot",
      userName: "lilac",
      text: "[discord user_id=bot user_name=lilac message_id=b1]\nassistant_surface",
      ts: anchorTs - 1_000,
      raw: { reference: {} },
    };

    const user: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "u1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u",
      userName: "user",
      text: "latest",
      ts: anchorTs,
      raw: { reference: {} },
    };

    const adapter = new ListFakeAdapter([bot, user]);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 20,
      triggerMsgRef: user.ref,
      triggerType: undefined,
    });

    const assistant = out.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(typeof assistant!.content).toBe("string");
    expect(assistant!.content as string).toBe("assistant_surface");
    expect(assistant!.content as string).not.toContain("[discord user_id=");
  });

  it("strips echoed discord attribution headers from merged assistant chunks", async () => {
    const sessionId = "c";
    const anchorTs = 10_000_000;

    const bot1: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "b1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "bot",
      userName: "lilac",
      text: "[discord user_id=bot user_name=lilac message_id=b1]\nassistant_one",
      ts: anchorTs - 2_000,
      raw: { reference: {} },
    };

    const bot2: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "b2" },
      session: { platform: "discord", channelId: sessionId },
      userId: "bot",
      userName: "lilac",
      text: "[discord user_id=bot user_name=lilac message_id=b2]\nassistant_two",
      ts: anchorTs - 1_000,
      raw: { reference: {} },
    };

    const user: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "u1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u",
      userName: "user",
      text: "latest",
      ts: anchorTs,
      raw: { reference: {} },
    };

    const adapter = new ListFakeAdapter([bot1, bot2, user]);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 20,
      triggerMsgRef: user.ref,
      triggerType: undefined,
    });

    const assistant = out.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(typeof assistant!.content).toBe("string");
    expect(assistant!.content as string).toContain("assistant_one");
    expect(assistant!.content as string).toContain("assistant_two");
    expect(assistant!.content as string).not.toContain("[discord user_id=");
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

  it("keeps the normal active window at exactly the requested limit without !cont", async () => {
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
      mk("1", anchorTs - 3_000),
      mk("2", anchorTs - 2_000),
      mk("3", anchorTs - 1_000),
      mk("4", anchorTs),
    ];

    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 2,
      triggerMsgRef: { platform: "discord", channelId: sessionId, messageId: "4" },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(["3", "4"]);
  });

  it("expands active context when current message uses !cont", async () => {
    const sessionId = "c";
    const anchorTs = 10_000_000;

    const mk = (id: string, ts: number, text: string): SurfaceMessage => ({
      ref: { platform: "discord", channelId: sessionId, messageId: id },
      session: { platform: "discord", channelId: sessionId },
      userId: id === "3" ? "bot" : "u",
      userName: id === "3" ? "lilac" : "user",
      text,
      ts,
      raw: { reference: {} },
    });

    const msgs = [
      mk("1", anchorTs - 4 * 60 * 60 * 1000, "old_1"),
      mk("2", anchorTs - (3 * 60 * 60 * 1000 + 1), "old_2"),
      mk("3", anchorTs - 2 * 60 * 60 * 1000, "bot_old"),
      mk("4", anchorTs - 30 * 60 * 1000, "recent_4"),
      mk("5", anchorTs, "!cont=4 current request"),
    ];

    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 8,
      triggerMsgRef: { platform: "discord", channelId: sessionId, messageId: "5" },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(["1", "2", "3", "4", "5"]);

    const combined = out.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(combined).not.toContain("!cont=");
    expect(combined).toContain("current request");
  });

  it("keeps a visible !cont sticky for later plain active messages", async () => {
    const sessionId = "c";

    const mk = (id: string, ts: number, text: string, userId = "u", userName = "user") =>
      ({
        ref: { platform: "discord", channelId: sessionId, messageId: id },
        session: { platform: "discord", channelId: sessionId },
        userId,
        userName,
        text,
        ts,
        raw: { reference: {} },
      }) satisfies SurfaceMessage;

    const msgs = [
      mk("1", 1, "before"),
      mk("2", 2, "!cont=2 reopen"),
      mk("3", 3, "assistant", "bot", "lilac"),
      mk("4", 4, "plain follow-up"),
    ];

    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 3,
      triggerMsgRef: { platform: "discord", channelId: sessionId, messageId: "4" },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(["1", "2", "3", "4"]);
  });

  it("uses the latest visible !cont when multiple directives are present", async () => {
    const sessionId = "c";

    const mk = (id: string, ts: number, text: string, userId = "u", userName = "user") =>
      ({
        ref: { platform: "discord", channelId: sessionId, messageId: id },
        session: { platform: "discord", channelId: sessionId },
        userId,
        userName,
        text,
        ts,
        raw: { reference: {} },
      }) satisfies SurfaceMessage;

    const msgs = [
      mk("1", 1, "!cont=5 wide"),
      mk("2", 2, "assistant one", "bot", "lilac"),
      mk("3", 3, "middle user"),
      mk("4", 4, "assistant two", "bot", "lilac"),
      mk("5", 5, "!cont=2 narrow"),
      mk("6", 6, "current"),
    ];

    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 8,
      triggerMsgRef: { platform: "discord", channelId: sessionId, messageId: "6" },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(["3", "4", "5", "6"]);
  });

  it("uses assistant-only transcript fallback for bot messages older than 1h", async () => {
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
        const expanded = (content: string): ModelMessage[] => [{ role: "assistant", content }];
        if (input.messageId === "8") {
          return {
            requestId: "r8",
            sessionId,
            requestClient: "discord",
            createdTs: 0,
            updatedTs: 0,
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "tool-call",
                    toolCallId: "call-old",
                    toolName: "bash",
                    input: { command: "pwd" },
                  },
                  {
                    type: "text",
                    text: "[discord user_id=bot user_name=lilac message_id=old]\nFALLBACK_OLD",
                  },
                ],
              },
              {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: "call-old",
                    toolName: "bash",
                    output: { type: "text", value: "/tmp" },
                  },
                ],
              },
            ],
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
    const assistantText = out.messages
      .filter((m) => m.role === "assistant" && typeof m.content === "string")
      .map((m) => m.content as string)
      .join("\n");

    expect(text).toContain("EXPANDED_RECENT");
    expect(text).toContain("FALLBACK_OLD");
    expect(text).not.toContain("old bot text");
    expect(assistantText).not.toContain("tool-call");
    expect(assistantText).not.toContain("[discord user_id=");
  });

  it("uses assistant-only transcript fallback for bot messages older than 1h (mention trigger)", async () => {
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
        const expanded = (content: string): ModelMessage[] => [{ role: "assistant", content }];
        if (input.messageId === "8") {
          return {
            requestId: "r8",
            sessionId,
            requestClient: "discord",
            createdTs: 0,
            updatedTs: 0,
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "tool-call",
                    toolCallId: "call-old",
                    toolName: "bash",
                    input: { command: "pwd" },
                  },
                  {
                    type: "text",
                    text: "[discord user_id=bot user_name=lilac message_id=old]\nFALLBACK_OLD",
                  },
                ],
              },
              {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: "call-old",
                    toolName: "bash",
                    output: { type: "text", value: "/tmp" },
                  },
                ],
              },
            ],
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
    const assistantText = out.messages
      .filter((m) => m.role === "assistant" && typeof m.content === "string")
      .map((m) => m.content as string)
      .join("\n");

    expect(text).toContain("EXPANDED_RECENT");
    expect(text).toContain("FALLBACK_OLD");
    expect(text).not.toContain("old bot text");
    expect(assistantText).not.toContain("tool-call");
    expect(assistantText).not.toContain("[discord user_id=");
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

      async listMsg(_sessionRef: SessionRef, _opts?: LimitOpts): Promise<SurfaceMessage[]> {
        throw new Error("listMsg should not be called");
      }

      async editMsg(_msgRef: MsgRef, _content: ContentOpts): Promise<void> {
        throw new Error("not implemented");
      }

      async deleteMsg(_msgRef: MsgRef): Promise<void> {
        throw new Error("not implemented");
      }

      async getReplyContext(_msgRef: MsgRef, _opts?: LimitOpts): Promise<SurfaceMessage[]> {
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

    async listMsg(sessionRef: SessionRef, _opts?: LimitOpts): Promise<SurfaceMessage[]> {
      return this.messages.filter((m) => m.session.channelId === sessionRef.channelId);
    }

    async editMsg(_msgRef: MsgRef, _content: ContentOpts): Promise<void> {
      throw new Error("not implemented");
    }
    async deleteMsg(_msgRef: MsgRef): Promise<void> {
      throw new Error("not implemented");
    }
    async getReplyContext(_msgRef: MsgRef, _opts?: LimitOpts): Promise<SurfaceMessage[]> {
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
          (m) => m.session.channelId === msgRef.channelId && m.ref.messageId === msgRef.messageId,
        ) ?? null
      );
    }

    async listMsg(sessionRef: SessionRef, opts?: LimitOpts): Promise<SurfaceMessage[]> {
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

    async getReplyContext(_msgRef: MsgRef, _opts?: LimitOpts): Promise<SurfaceMessage[]> {
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
      override async getReplyContext(msgRef: MsgRef, opts?: LimitOpts): Promise<SurfaceMessage[]> {
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
