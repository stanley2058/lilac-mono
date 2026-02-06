import { describe, expect, it } from "bun:test";
import { coreConfigSchema, type CoreConfig } from "@stanley2058/lilac-utils";
import { Surface } from "../src/tool-server/tools/surface";
import type { GithubSurfaceApi } from "../src/tool-server/tools/surface";
import {
  DiscordSearchService,
  DiscordSearchStore,
} from "../src/surface/store/discord-search-store";
import type { RequestContext } from "../src/tool-server/types";
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
  return { ...cfg, agent: { ...cfg.agent, systemPrompt: "(test)" } };
}

class FakeAdapter implements SurfaceAdapter {
  public sendCalls: Array<{
    sessionRef: SessionRef;
    content: ContentOpts;
    opts?: SendOpts;
  }> = [];
  public addReactionCalls: Array<{ msgRef: MsgRef; reaction: string }> = [];
  public removeReactionCalls: Array<{ msgRef: MsgRef; reaction: string }> = [];
  public listCalls: Array<{ sessionRef: SessionRef; opts?: LimitOpts }> = [];

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
    this.listCalls.push({ sessionRef, opts });

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

  it("defaults sessionId from request context", async () => {
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
    const ctx: RequestContext = {
      sessionId: channelId,
      requestClient: "discord",
    };

    const res = (await tool.call(
      "surface.messages.list",
      {},
      { context: ctx },
    )) as any[];

    expect(res.length).toBe(1);
    expect(res[0].ref.messageId).toBe("m1");
  });

  it("searches per session and cools down healing", async () => {
    const c1 = "123";
    const c2 = "456";

    const cfg = testConfig({
      surface: {
        discord: {
          tokenEnv: "DISCORD_TOKEN",
          allowedChannelIds: [c1, c2],
          allowedGuildIds: [],
          botName: "lilac",
        },
      },
      entity: {
        users: {
          alice: { discord: "u1" },
        },
      },
    });

    const adapter = new FakeAdapter(
      [{ ref: { platform: "discord", channelId: c1 }, kind: "channel" }],
      {
        [c1]: [
          {
            ref: { platform: "discord", channelId: c1, messageId: "m1" },
            session: { platform: "discord", channelId: c1 },
            userId: "u1",
            text: "deploy completed successfully",
            ts: 100,
          },
          {
            ref: { platform: "discord", channelId: c1, messageId: "m2" },
            session: { platform: "discord", channelId: c1 },
            userId: "u2",
            text: "incident timeline",
            ts: 101,
          },
        ],
        [c2]: [
          {
            ref: { platform: "discord", channelId: c2, messageId: "m3" },
            session: { platform: "discord", channelId: c2 },
            userId: "u3",
            text: "deploy in other channel",
            ts: 102,
          },
        ],
      },
    );

    const searchStore = new DiscordSearchStore(":memory:");
    const search = new DiscordSearchService({ adapter, store: searchStore });
    const tool = new Surface({
      adapter,
      config: cfg,
      discordSearch: search,
    });

    const first = (await tool.call("surface.messages.search", {
      client: "discord",
      sessionId: c1,
      query: "deploy",
    })) as {
      hits: Array<{ ref: { channelId: string }; userAlias?: string }>;
      heal: { attempted: boolean; limit: number } | null;
    };

    expect(first.hits.length).toBe(1);
    expect(first.hits[0]!.ref.channelId).toBe(c1);
    expect(first.hits[0]!.userAlias).toBe("alice");
    expect(first.heal?.attempted).toBe(true);
    expect(first.heal?.limit).toBe(300);
    expect(adapter.listCalls.length).toBe(1);
    expect(adapter.listCalls[0]?.opts?.limit).toBe(300);

    const second = (await tool.call("surface.messages.search", {
      client: "discord",
      sessionId: c1,
      query: "deploy",
    })) as {
      heal: { skipped: boolean; reason?: string } | null;
    };

    expect(second.heal?.skipped).toBe(true);
    expect(second.heal?.reason).toBe("cooldown");
    expect(adapter.listCalls.length).toBe(1);

    searchStore.close();
  });

  it("defaults sessionId and messageId from discord requestId", async () => {
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
    const ctx: RequestContext = {
      requestId: `discord:${channelId}:m1`,
      requestClient: "discord",
    };

    const msg = (await tool.call(
      "surface.messages.read",
      {},
      { context: ctx },
    )) as any;

    expect(msg?.ref?.messageId).toBe("m1");
  });

  it("accepts discord:channel:<id> as sessionId", async () => {
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

    const res = (await tool.call("surface.messages.list", {
      client: "discord",
      sessionId: `discord:channel:${channelId}`,
    })) as any[];

    expect(res.length).toBe(1);
    expect(res[0].ref.messageId).toBe("m1");
  });

  it("errors clearly when sessionId looks like requestId", async () => {
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
      {},
    );
    const tool = new Surface({ adapter, config: cfg });

    await expect(
      tool.call("surface.messages.list", {
        client: "discord",
        sessionId: "req:2e5fd968-2047-4378-b198-6e19be8049cc",
      }),
    ).rejects.toThrow("looks like a requestId");
  });

  it("requires messageId when requestId is not discord-anchored", async () => {
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
      {},
    );

    const tool = new Surface({ adapter, config: cfg });
    const ctx: RequestContext = {
      requestId: "req:123",
      requestClient: "discord",
      sessionId: channelId,
    };

    await expect(
      tool.call("surface.reactions.list", {}, { context: ctx }),
    ).rejects.toThrow("requires --message-id");
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
    const ref = adapter.sendCalls[0]!.sessionRef;
    expect(ref.platform).toBe("discord");
    if (ref.platform === "discord") {
      expect(ref.guildId).toBe("g1");
    }
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

  it("errors for github sessions.list and points to gh", async () => {
    const cfg = testConfig({
      surface: {
        discord: {
          tokenEnv: "DISCORD_TOKEN",
          allowedChannelIds: [],
          allowedGuildIds: [],
          botName: "lilac",
        },
      },
    });

    const adapter = new FakeAdapter([], {});
    const tool = new Surface({ adapter, config: cfg });

    await expect(
      tool.call("surface.sessions.list", { client: "github" }),
    ).rejects.toThrow("gh");
  });

  it("defaults github sessionId/messageId from requestId", async () => {
    const cfg = testConfig({
      surface: {
        discord: {
          tokenEnv: "DISCORD_TOKEN",
          allowedChannelIds: [],
          allowedGuildIds: [],
          botName: "lilac",
        },
      },
    });

    const calls: Array<{ owner: string; repo: string; commentId: number }> = [];

    const githubApi: GithubSurfaceApi = {
      getIssue: async () => {
        throw new Error("not implemented");
      },
      listIssueComments: async () => [],
      createIssueComment: async () => ({ id: 0 }),
      getIssueComment: async ({ owner, repo, commentId }) => {
        calls.push({ owner, repo, commentId });
        return {
          id: commentId,
          body: "hello",
          user: { login: "alice", id: 1 },
          created_at: "2020-01-01T00:00:00Z",
        };
      },
      editIssueComment: async () => undefined,
      deleteIssueComment: async () => undefined,
      createIssueReaction: async () => ({ id: 0 }),
      createIssueCommentReaction: async () => ({ id: 0 }),
      listIssueReactions: async () => [],
      listIssueCommentReactions: async () => [],
      deleteIssueReactionById: async () => undefined,
      deleteIssueCommentReactionById: async () => undefined,
      getGithubAppSlugOrNull: async () => null,
    };

    const adapter = new FakeAdapter([], {});
    const tool = new Surface({ adapter, config: cfg, githubApi });
    const ctx: RequestContext = {
      requestId: "github:octo/repo#12:345",
      requestClient: "github",
    };

    const msg = (await tool.call("surface.messages.read", {}, { context: ctx })) as any;
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({ owner: "octo", repo: "repo", commentId: 345 });
    expect(msg.ref.platform).toBe("github");
    expect(msg.ref.messageId).toBe("345");
    expect(msg.text).toBe("hello");
  });

  it("reads github issue body when messageId matches issue number", async () => {
    const cfg = testConfig({
      surface: {
        discord: {
          tokenEnv: "DISCORD_TOKEN",
          allowedChannelIds: [],
          allowedGuildIds: [],
          botName: "lilac",
        },
      },
    });

    const githubApi: GithubSurfaceApi = {
      getIssue: async () => ({
        title: "t",
        body: "b",
        user: { login: "alice", id: 1 },
        created_at: "2020-01-01T00:00:00Z",
        updated_at: "2020-01-02T00:00:00Z",
      }),
      listIssueComments: async () => [],
      createIssueComment: async () => ({ id: 0 }),
      getIssueComment: async () => {
        throw new Error("not implemented");
      },
      editIssueComment: async () => undefined,
      deleteIssueComment: async () => undefined,
      createIssueReaction: async () => ({ id: 0 }),
      createIssueCommentReaction: async () => ({ id: 0 }),
      listIssueReactions: async () => [],
      listIssueCommentReactions: async () => [],
      deleteIssueReactionById: async () => undefined,
      deleteIssueCommentReactionById: async () => undefined,
      getGithubAppSlugOrNull: async () => null,
    };

    const adapter = new FakeAdapter([], {});
    const tool = new Surface({ adapter, config: cfg, githubApi });
    const ctx: RequestContext = {
      requestId: "github:octo/repo#12:12:deadbeef",
      requestClient: "github",
    };

    const msg = (await tool.call("surface.messages.read", {}, { context: ctx })) as any;
    expect(msg.ref.platform).toBe("github");
    expect(msg.ref.messageId).toBe("12");
    expect(msg.text).toContain("Title: t");
    expect(msg.text).toContain("b");
  });

  it("maps github reaction emoji to content on add", async () => {
    const cfg = testConfig({
      surface: {
        discord: {
          tokenEnv: "DISCORD_TOKEN",
          allowedChannelIds: [],
          allowedGuildIds: [],
          botName: "lilac",
        },
      },
    });

    const calls: Array<{ owner: string; repo: string; commentId: number; content: string }> = [];

    const githubApi: GithubSurfaceApi = {
      getIssue: async () => {
        throw new Error("not implemented");
      },
      listIssueComments: async () => [],
      createIssueComment: async () => ({ id: 0 }),
      getIssueComment: async () => ({ id: 0 }),
      editIssueComment: async () => undefined,
      deleteIssueComment: async () => undefined,
      createIssueReaction: async () => ({ id: 0 }),
      createIssueCommentReaction: async ({ owner, repo, commentId, content }) => {
        calls.push({ owner, repo, commentId, content });
        return { id: 1 };
      },
      listIssueReactions: async () => [],
      listIssueCommentReactions: async () => [],
      deleteIssueReactionById: async () => undefined,
      deleteIssueCommentReactionById: async () => undefined,
      getGithubAppSlugOrNull: async () => null,
    };

    const adapter = new FakeAdapter([], {});
    const tool = new Surface({ adapter, config: cfg, githubApi });

    const res = await tool.call("surface.reactions.add", {
      client: "github",
      sessionId: "octo/repo#12",
      messageId: "345",
      reaction: "👍",
    });

    expect((res as any).ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({
      owner: "octo",
      repo: "repo",
      commentId: 345,
      content: "+1",
    });
  });

  it("removes only bot-owned github reactions", async () => {
    const cfg = testConfig({
      surface: {
        discord: {
          tokenEnv: "DISCORD_TOKEN",
          allowedChannelIds: [],
          allowedGuildIds: [],
          botName: "lilac",
        },
      },
    });

    const deleted: number[] = [];

    const githubApi: GithubSurfaceApi = {
      getIssue: async () => {
        throw new Error("not implemented");
      },
      listIssueComments: async () => [],
      createIssueComment: async () => ({ id: 0 }),
      getIssueComment: async () => ({ id: 0 }),
      editIssueComment: async () => undefined,
      deleteIssueComment: async () => undefined,
      createIssueReaction: async () => ({ id: 0 }),
      createIssueCommentReaction: async () => ({ id: 0 }),
      listIssueReactions: async () => [],
      listIssueCommentReactions: async () => [
        { id: 1, content: "+1", user: { login: "lilac[bot]", id: 1 } },
        { id: 2, content: "+1", user: { login: "bob", id: 2 } },
      ],
      deleteIssueReactionById: async () => undefined,
      deleteIssueCommentReactionById: async ({ reactionId }) => {
        deleted.push(reactionId);
      },
      getGithubAppSlugOrNull: async () => "lilac",
    };

    const adapter = new FakeAdapter([], {});
    const tool = new Surface({ adapter, config: cfg, githubApi });

    const res = await tool.call("surface.reactions.remove", {
      client: "github",
      sessionId: "octo/repo#12",
      messageId: "345",
      reaction: "👍",
    });

    expect((res as any).ok).toBe(true);
    expect(deleted).toEqual([1]);
  });
});
