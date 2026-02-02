import { describe, expect, it } from "bun:test";
import { coreConfigSchema, type CoreConfig } from "@stanley2058/lilac-utils";
import { Surface } from "../src/tool-server/tools/surface";
import type { SurfaceAdapter } from "../src/surface/adapter";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AdapterCapabilities,
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
  SurfaceReactionDetail,
  SurfaceSelf,
  SurfaceSession,
} from "../src/surface/types";

function testConfig(input: unknown): CoreConfig {
  const cfg = coreConfigSchema.parse(input);
  return { ...cfg, agent: { systemPrompt: "(test)" } };
}

class FakeAdapter implements SurfaceAdapter {
  public sendCalls: Array<{
    sessionRef: SessionRef;
    content: ContentOpts;
    opts?: SendOpts;
  }> = [];
  public addReactionCalls: Array<{ msgRef: MsgRef; reaction: string }> = [];
  public removeReactionCalls: Array<{ msgRef: MsgRef; reaction: string }> = [];

  constructor(
    private readonly sessions: SurfaceSession[],
    private readonly messagesByChannelId: Record<string, SurfaceMessage[]>,
    private readonly guildIdByChannelId: Record<string, string> = {},
  ) {}

  async fetchGuildIdForChannel(channelId: string): Promise<string | null> {
    return this.guildIdByChannelId[channelId] ?? null;
  }

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
    return {
      platform: "discord",
      send: true,
      edit: true,
      delete: true,
      reactions: true,
      readHistory: true,
      threads: true,
      markRead: true,
    };
  }

  async listSessions(): Promise<SurfaceSession[]> {
    return this.sessions;
  }

  async startOutput(): Promise<any> {
    throw new Error("not implemented");
  }

  async sendMsg(
    sessionRef: SessionRef,
    content: ContentOpts,
    opts?: SendOpts,
  ): Promise<MsgRef> {
    this.sendCalls.push({ sessionRef, content, opts });
    return {
      platform: "discord",
      channelId: sessionRef.channelId,
      messageId: "sent",
    };
  }

  async readMsg(msgRef: MsgRef): Promise<SurfaceMessage | null> {
    const msgs = this.messagesByChannelId[msgRef.channelId] ?? [];
    return msgs.find((m) => m.ref.messageId === msgRef.messageId) ?? null;
  }

  async listMsg(
    sessionRef: SessionRef,
    opts?: LimitOpts,
  ): Promise<SurfaceMessage[]> {
    const msgs = this.messagesByChannelId[sessionRef.channelId] ?? [];
    const limit = opts?.limit ?? 50;

    // v1 fake: ignore cursors, but accept them.
    void opts?.beforeMessageId;
    void opts?.afterMessageId;

    return msgs.slice(0, limit);
  }

  async editMsg(): Promise<void> {
    throw new Error("not implemented");
  }

  async deleteMsg(): Promise<void> {
    throw new Error("not implemented");
  }

  async getReplyContext(): Promise<SurfaceMessage[]> {
    throw new Error("not implemented");
  }

  async addReaction(msgRef: MsgRef, reaction: string): Promise<void> {
    this.addReactionCalls.push({ msgRef, reaction });
  }

  async removeReaction(msgRef: MsgRef, reaction: string): Promise<void> {
    this.removeReactionCalls.push({ msgRef, reaction });
  }

  async listReactions(_msgRef: MsgRef): Promise<string[]> {
    return ["👍"];
  }

  async listReactionDetails(_msgRef: MsgRef): Promise<SurfaceReactionDetail[]> {
    return [
      {
        emoji: "👍",
        count: 2,
        users: [
          { userId: "u1", userName: "alice" },
          { userId: "u2", userName: "bob" },
        ],
      },
    ];
  }

  async subscribe(): Promise<any> {
    throw new Error("not implemented");
  }

  async getUnRead(): Promise<SurfaceMessage[]> {
    throw new Error("not implemented");
  }

  async markRead(): Promise<void> {
    throw new Error("not implemented");
  }
}

describe("tool-server surface", () => {
  it("returns reaction counts", async () => {
    const channelId = "123";
    const cfg = testConfig({
      surface: {
        discord: {
          tokenEnv: "DISCORD_TOKEN",
          allowedChannelIds: [channelId],
          allowedGuildIds: [],
          botName: "lilac",
        },
      },
    });

    const adapter = new FakeAdapter(
      [{ ref: { platform: "discord", channelId }, kind: "channel" }],
      {
        [channelId]: [
          {
            ref: { platform: "discord", channelId, messageId: "m1" },
            session: { platform: "discord", channelId },
            userId: "u",
            text: "hi",
            ts: 0,
          },
        ],
      },
    );

    const tool = new Surface({ adapter, config: cfg });
    const res = await tool.call("surface.reactions.list", {
      client: "discord",
      sessionId: channelId,
      messageId: "m1",
    });

    expect(res).toEqual([{ emoji: "👍", count: 2 }]);
  });

  it("filters sessions list by allowlist and includes token", async () => {
    const cfg = testConfig({
      surface: {
        discord: {
          tokenEnv: "DISCORD_TOKEN",
          allowedChannelIds: ["c1"],
          allowedGuildIds: [],
          botName: "lilac",
        },
      },
      entity: { sessions: { discord: { ops: "c1" } } },
    });

    const adapter = new FakeAdapter(
      [
        {
          ref: { platform: "discord", channelId: "c1" },
          kind: "channel",
          title: "chan",
        },
        {
          ref: { platform: "discord", channelId: "c2" },
          kind: "channel",
          title: "nope",
        },
      ],
      {},
    );

    const tool = new Surface({ adapter, config: cfg });
    const sessions = (await tool.call("surface.sessions.list", {
      client: "discord",
    })) as any[];

    expect(sessions.length).toBe(1);
    expect(sessions[0].channelId).toBe("c1");
    expect(sessions[0].token).toBe("ops");
  });

  it("resolves sessionId alias for send", async () => {
    const tmp = await fs.mkdtemp(join(tmpdir(), "lilac-surface-"));
    const p = join(tmp, "hello.txt");
    await fs.writeFile(p, "hello", "utf8");
    const cfg = testConfig({
      surface: {
        discord: {
          tokenEnv: "DISCORD_TOKEN",
          allowedChannelIds: ["c1"],
          allowedGuildIds: [],
          botName: "lilac",
        },
      },
      entity: { sessions: { discord: { ops: "c1" } } },
    });

    const adapter = new FakeAdapter([], {});
    const tool = new Surface({ adapter, config: cfg });

    const res = await tool.call("surface.messages.send", {
      sessionId: "#ops",
      text: "hi",
      paths: [p],
      client: "discord",
    });

    expect((res as any).ok).toBe(true);
    expect(adapter.sendCalls.length).toBe(1);
    expect(adapter.sendCalls[0]!.sessionRef.channelId).toBe("c1");

    const sent = adapter.sendCalls[0]!;
    expect(sent.content.text).toBe("hi");
    expect(sent.content.attachments?.length).toBe(1);
    expect(sent.content.attachments?.[0]?.filename).toBe("hello.txt");
  });

  it("allows guild allowlist when channel is not cached", async () => {
    const cfg = testConfig({
      surface: {
        discord: {
          tokenEnv: "DISCORD_TOKEN",
          allowedChannelIds: [],
          allowedGuildIds: ["g1"],
          botName: "lilac",
        },
      },
      entity: { sessions: { discord: { ops: "c1" } } },
    });

    const adapter = new FakeAdapter([], {}, { c1: "g1" });
    const tool = new Surface({ adapter, config: cfg });

    const res = await tool.call("surface.messages.send", {
      sessionId: "ops",
      text: "hi",
      client: "discord",
    });

    expect((res as any).ok).toBe(true);
    expect(adapter.sendCalls.length).toBe(1);
    expect(adapter.sendCalls[0]!.sessionRef.guildId).toBe("g1");
  });

  it("adds reaction", async () => {
    const cfg = testConfig({
      surface: {
        discord: {
          tokenEnv: "DISCORD_TOKEN",
          allowedChannelIds: ["c1"],
          allowedGuildIds: [],
          botName: "lilac",
        },
      },
      entity: { sessions: { discord: { ops: "c1" } } },
    });

    const adapter = new FakeAdapter([], {});
    const tool = new Surface({ adapter, config: cfg });

    const res = await tool.call("surface.reactions.add", {
      sessionId: "ops",
      messageId: "m1",
      reaction: "👍",
      client: "discord",
    });

    expect((res as any).ok).toBe(true);
    expect(adapter.addReactionCalls.length).toBe(1);
    expect(adapter.addReactionCalls[0]!.msgRef).toEqual({
      platform: "discord",
      channelId: "c1",
      messageId: "m1",
    });
    expect(adapter.addReactionCalls[0]!.reaction).toBe("👍");
  });
});
