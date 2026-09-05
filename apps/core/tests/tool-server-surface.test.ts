import { toReplyChainMessage } from "../src/surface/bridge/request-composition/reply-chain";
import { describe, expect, it } from "bun:test";
import { Panic, Result } from "better-result";
import type { ServerToolResult } from "@stanley2058/lilac-plugin-runtime";
import { parseCoreConfigV1ToUniversal, type CoreConfig } from "@stanley2058/lilac-utils";
import { Surface as RawProductionSurface } from "../src/tool-server/tools/surface";
import {
  SurfaceOperationPartiallyCompleted,
  SurfaceOperationUnsupported,
  SurfaceRateLimited,
  SurfaceUnavailable,
  type SurfaceAdapter,
} from "../src/surface/adapter";
import { BUILTIN_SURFACE_PROTOCOLS } from "../src/surface/builtin-surface-protocols";
import {
  GithubAdapter,
  type GithubAdapterApi as GithubSurfaceApi,
} from "../src/surface/github/github-adapter";
import { createDescriptorBoundSurfaceAdapter } from "../src/surface/produced-ref-guard";
import { SurfaceRuntimeRegistry } from "../src/surface/runtime-descriptor";
import { GITHUB_AGENT_COMMENT_MARKER } from "../src/github/github-comment-marker";
import {
  DiscordSearchService,
  DiscordSearchStore,
} from "../src/surface/store/discord-search-store";
import type { RequestContext } from "../src/tool-server/types";
import { SqliteTranscriptStore, type TranscriptStore } from "../src/transcript/transcript-store";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
  SurfaceSelf,
  SurfaceSessionParticipantsResult,
  SurfaceSession,
} from "../src/surface/types";
import { SurfaceAdapterTestBase } from "./helpers/surface-adapter-test-base";

function testConfig(input: unknown): CoreConfig {
  const cfg = parseCoreConfigV1ToUniversal(input);
  return { ...cfg, agent: { ...cfg.agent, systemPrompt: "(test)" } };
}

function createGithubTestAdapter(api: GithubSurfaceApi) {
  return createDescriptorBoundSurfaceAdapter("github", new GithubAdapter({ api }));
}

function createTestAdapterResolver(
  descriptors: Parameters<typeof SurfaceRuntimeRegistry.create>[0],
) {
  const created = SurfaceRuntimeRegistry.create(descriptors);
  if (created.status === "error") throw created.error;
  return created.value.adapterResolver();
}

const DEFAULT_GITHUB_TEST_ADAPTER = createDescriptorBoundSurfaceAdapter(
  "github",
  new GithubAdapter(),
);

type TestSurfaceParams = Omit<
  ConstructorParameters<typeof RawProductionSurface>[0],
  "adapterResolver"
> & {
  readonly adapter: SurfaceAdapter;
  readonly githubAdapter?: SurfaceAdapter;
};

class ProductionSurface {
  protected readonly raw: RawProductionSurface;

  constructor(params: ConstructorParameters<typeof RawProductionSurface>[0]) {
    this.raw = new RawProductionSurface(params);
  }

  list() {
    return this.raw.list();
  }

  callResult(...args: Parameters<RawProductionSurface["call"]>): Promise<ServerToolResult> {
    return this.raw.call(...args);
  }

  async call(...args: Parameters<RawProductionSurface["call"]>): Promise<unknown> {
    const outcome = (await this.callResult(...args)).match<
      { readonly value: unknown } | { readonly error: { readonly message: string } }
    >({
      ok: (value) => ({ value }),
      err: (error) => ({ error }),
    });
    if ("error" in outcome) throw new Error(outcome.error.message);
    return outcome.value;
  }
}

class Surface extends ProductionSurface {
  constructor(params: TestSurfaceParams) {
    const { adapter: _adapter, githubAdapter: _githubAdapter, ...surfaceParams } = params;
    super({
      ...surfaceParams,
      adapterResolver: createTestAdapterResolver([
        { protocol: BUILTIN_SURFACE_PROTOCOLS.discord, adapter: params.adapter },
        {
          protocol: BUILTIN_SURFACE_PROTOCOLS.github,
          adapter: params.githubAdapter ?? DEFAULT_GITHUB_TEST_ADAPTER,
        },
      ]),
    });
  }
}

class FakeAdapter extends SurfaceAdapterTestBase {
  public sendCalls: Array<{
    sessionRef: SessionRef;
    content: ContentOpts;
    opts?: SendOpts;
  }> = [];
  public readCalls: MsgRef[] = [];
  public addReactionCalls: Array<{ msgRef: MsgRef; reaction: string }> = [];
  public removeReactionCalls: Array<{ msgRef: MsgRef; reaction: string }> = [];
  public listCalls: Array<{ sessionRef: SessionRef; opts?: LimitOpts }> = [];

  constructor(
    private readonly sessions: SurfaceSession[],
    private readonly messagesByChannelId: Record<string, SurfaceMessage[]>,
    private readonly guildIdByChannelId: Record<string, string> = {},
    private readonly participantsByChannelId: Record<string, SurfaceSessionParticipantsResult> = {},
  ) {
    super();
  }

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

  async listSessions() {
    return Result.ok(this.sessions);
  }

  async startOutput() {
    return Result.ok({
      push: async () => Result.ok("visible" as const),
      finish: async () => {
        const ref = { platform: "discord" as const, channelId: "channel", messageId: "message" };
        return Result.ok({ created: [ref], last: ref });
      },
      abort: async () => Result.ok(undefined),
    });
  }

  override async startTyping() {
    return Result.ok({ stop: async () => Result.ok(undefined) });
  }

  async sendMsg(sessionRef: SessionRef, content: ContentOpts, opts?: SendOpts) {
    this.sendCalls.push({ sessionRef, content, opts });
    return Result.ok({
      platform: "discord",
      channelId: sessionRef.channelId,
      messageId: "sent",
    } as const);
  }

  async readMsg(msgRef: MsgRef) {
    this.readCalls.push(msgRef);
    const msgs = this.messagesByChannelId[msgRef.channelId] ?? [];
    return Result.ok(msgs.find((m) => m.ref.messageId === msgRef.messageId) ?? null);
  }

  async listMsg(sessionRef: SessionRef, opts?: LimitOpts) {
    this.listCalls.push({ sessionRef, opts });

    const msgs = this.messagesByChannelId[sessionRef.channelId] ?? [];
    const limit = opts?.limit ?? 50;

    // v1 fake: ignore cursors, but accept them.
    void opts?.beforeMessageId;
    void opts?.afterMessageId;

    return Result.ok(msgs.slice(0, limit));
  }

  async editMsg() {
    return Result.ok(undefined);
  }

  async deleteMsg() {
    return Result.ok(undefined);
  }

  async getReplyContext() {
    return Result.ok([]);
  }

  override async planReplyChain() {
    return Result.ok([]);
  }

  override async planMergeBlockEndingAt() {
    return Result.ok([]);
  }

  async addReaction(msgRef: MsgRef, reaction: string) {
    this.addReactionCalls.push({ msgRef, reaction });
    return Result.ok(undefined);
  }

  async removeReaction(msgRef: MsgRef, reaction: string) {
    this.removeReactionCalls.push({ msgRef, reaction });
    return Result.ok(undefined);
  }

  async listReactions(_msgRef: MsgRef) {
    return Result.ok(["👍"]);
  }

  override async listReactionDetails(_msgRef: MsgRef) {
    return Result.ok([
      {
        emoji: "👍",
        count: 2,
        users: [
          { userId: "u1", userName: "alice" },
          { userId: "u2", userName: "bob" },
        ],
      },
    ]);
  }

  override async listSessionParticipants(sessionRef: SessionRef, opts?: { limit?: number }) {
    const row = this.participantsByChannelId[sessionRef.channelId];
    const base: SurfaceSessionParticipantsResult = row ?? {
      source: "guild_members",
      participants: [],
    };

    const limit = Math.min(2000, Math.max(1, Math.floor(opts?.limit ?? 200)));

    return Result.ok({
      source: base.source,
      participants: base.participants.slice(0, limit),
    });
  }

  async getUnRead() {
    return Result.ok([]);
  }

  async markRead() {
    return Result.ok(undefined);
  }
}

describe("tool-server surface", () => {
  it("marks surface.messages.search as deprecated and hidden", async () => {
    const tool = new Surface({ adapter: new FakeAdapter([], {}), config: testConfig({}) });

    const entry = (await tool.list()).find((item) => item.callableId === "surface.messages.search");

    expect(entry?.hidden).toBe(true);
    expect(entry?.description.toLowerCase()).toContain("deprecated");
    expect(entry?.description).toContain("discovery.search");
  });

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
      entity: { sessions: { discord: { ops: channelId } } },
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

  it("filters sessions list by allowlist and includes alias", async () => {
    const cfg = testConfig({
      surface: {
        discord: {
          tokenEnv: "DISCORD_TOKEN",
          allowedChannelIds: ["c1"],
          allowedGuildIds: [],
          botName: "lilac",
        },
      },
      entity: {
        sessions: {
          discord: {
            ops: { discord: "c1", comment: "Deploy coordination" },
          },
        },
      },
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
    expect(sessions[0].alias).toBe("ops");
  });

  it("limits surface.sessions.list after allowlist filtering", async () => {
    const cfg = testConfig({
      surface: {
        discord: {
          tokenEnv: "DISCORD_TOKEN",
          allowedChannelIds: ["c1", "c2", "c3"],
          allowedGuildIds: [],
          botName: "lilac",
        },
      },
    });

    const adapter = new FakeAdapter(
      [
        { ref: { platform: "discord", channelId: "c1" }, kind: "channel", title: "one" },
        { ref: { platform: "discord", channelId: "c2" }, kind: "channel", title: "two" },
        { ref: { platform: "discord", channelId: "c3" }, kind: "channel", title: "three" },
      ],
      {},
    );

    const tool = new Surface({ adapter, config: cfg });
    const sessions = (await tool.call("surface.sessions.list", {
      client: "discord",
      limit: 2,
    })) as Array<{ channelId: string }>;

    expect(sessions.map((session) => session.channelId)).toEqual(["c1", "c2"]);
  });

  it("rejects definitely unknown surface.sessions.list flags", async () => {
    const tool = new Surface({ adapter: new FakeAdapter([], {}), config: testConfig({}) });

    await expect(
      tool.call("surface.sessions.list", {
        client: "discord",
        definitelyBogus: 1,
      }),
    ).rejects.toThrow("Unrecognized key");
  });

  it("rejects bare boolean limit for surface.sessions.list", async () => {
    const tool = new Surface({ adapter: new FakeAdapter([], {}), config: testConfig({}) });

    await expect(
      tool.call("surface.sessions.list", {
        client: "discord",
        limit: true,
      }),
    ).rejects.toThrow("Invalid input");
  });

  it("includes alias in surface.help context when request session is aliased", async () => {
    const cfg = testConfig({
      surface: {
        discord: {
          tokenEnv: "DISCORD_TOKEN",
          allowedChannelIds: ["c1"],
          allowedGuildIds: [],
          botName: "lilac",
        },
      },
      entity: {
        sessions: {
          discord: {
            ops: { discord: "c1", comment: "Deploy coordination" },
          },
        },
      },
    });

    const adapter = new FakeAdapter([], {});
    const tool = new Surface({ adapter, config: cfg });

    const out = (await tool.call(
      "surface.help",
      {},
      {
        context: {
          requestClient: "discord",
          sessionId: "c1",
        } satisfies RequestContext,
      },
    )) as {
      context: { sessionId: string | null; alias?: string };
    };

    expect(out.context.sessionId).toBe("c1");
    expect(out.context.alias).toBe("ops");
  });

  it("uses a registered request context as authoritative and rejects an explicit conflict", async () => {
    const tool = new Surface({ adapter: new FakeAdapter([], {}), config: testConfig({}) });

    const result = await tool.callResult(
      "surface.messages.read",
      { client: "discord", sessionId: "channel-1", messageId: "message-1" },
      { context: { requestClient: "github" } },
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toMatchObject({
        kind: "conflict",
        message: "Client mismatch: context requestClient is 'github' but input client is 'discord'",
      });
    }
  });

  it("distinguishes unregistered wire clients from malformed context values", async () => {
    const tool = new Surface({ adapter: new FakeAdapter([], {}), config: testConfig({}) });

    const unregistered = await tool.callResult("surface.sessions.list", { client: "slack" });
    expect(unregistered.status).toBe("error");
    if (unregistered.status === "error") {
      expect(unregistered.error.kind).toBe("unavailable");
      expect(unregistered.error.message).toContain(
        "client 'slack' is recognized but has no registered executable adapter",
      );
    }

    const malformed = await tool.callResult(
      "surface.sessions.list",
      {},
      { context: { requestClient: "desktop" } },
    );
    expect(malformed.status).toBe("error");
    if (malformed.status === "error") {
      expect(malformed.error).toMatchObject({ kind: "usage" });
      expect(malformed.error.message).toContain(
        "context requestClient 'desktop' is not a valid surface wire value",
      );
    }
  });

  it("does not route an unregistered wire client target operation through Discord", async () => {
    const adapter = new FakeAdapter([], {});
    const tool = new Surface({ adapter, config: testConfig({}) });

    await expect(
      tool.call("surface.messages.list", { client: "slack", sessionId: "channel-1" }),
    ).rejects.toThrow("client 'slack' is recognized but has no registered executable adapter");
    expect(adapter.listCalls).toEqual([]);
  });

  it("lists only registered executable platforms in help without operation support metadata", async () => {
    const adapter = new FakeAdapter([], {});
    const tool = new ProductionSurface({
      adapterResolver: createTestAdapterResolver([
        { protocol: BUILTIN_SURFACE_PROTOCOLS.discord, adapter },
      ]),
      config: testConfig({}),
    });

    const out = (await tool.call("surface.help", {})) as {
      supportedClients: readonly string[];
      sessionIdFormats: { client?: string };
    };
    expect(out.supportedClients).toEqual(["discord"]);
    expect(out.sessionIdFormats.client).toBe("discord");
    expect(JSON.stringify(out)).not.toContain("not implemented");
    expect(JSON.stringify(out)).not.toContain("supportMatrix");
  });

  it("shows GitHub session syntax for a GitHub-only registry", async () => {
    const tool = new ProductionSurface({
      adapterResolver: createTestAdapterResolver([
        { protocol: BUILTIN_SURFACE_PROTOCOLS.github, adapter: DEFAULT_GITHUB_TEST_ADAPTER },
      ]),
      config: testConfig({}),
    });

    const out = (await tool.call("surface.help", {})) as {
      supportedClients: readonly string[];
      sessionIdFormats: { client: string; accepted: Array<{ format: string; meaning: string }> };
    };
    expect(out.supportedClients).toEqual(["github"]);
    expect(out.sessionIdFormats.client).toBe("github");
    expect(out.sessionIdFormats.accepted).toContainEqual({
      format: "OWNER/REPO#123",
      meaning: "GitHub issue/PR thread",
    });
  });

  it("preserves the normal no-context Discord help fixture with both adapters registered", async () => {
    const tool = new Surface({ adapter: new FakeAdapter([], {}), config: testConfig({}) });

    const out = (await tool.call("surface.help", {})) as {
      supportedClients: readonly string[];
      sessionIdFormats: {
        client: string;
        accepted: Array<{ format: string; meaning: string }>;
        notes: string[];
      };
    };
    expect(out.supportedClients).toEqual(["discord", "github"]);
    expect(out.sessionIdFormats).toEqual({
      client: "discord",
      accepted: [
        { format: "123456789012345678", meaning: "Raw Discord channel id" },
        { format: "<#123456789012345678>", meaning: "Discord channel mention" },
        {
          format: "dev-chat",
          meaning:
            "Configured session alias (cfg.entity.sessions.discord maps alias -> channelId or { discord, comment })",
        },
        {
          format: "#dev-chat",
          meaning: "Configured session alias with optional leading # prefix",
        },
      ],
      notes: [
        "If the request has no session context, you must pass --session-id (or set LILAC_SESSION_ID). Some requests also allow inferring sessionId/messageId from requestId when it is 'discord:<sessionId>:<messageId>'.",
      ],
    });
  });

  it("uses GitHub session syntax for GitHub context with both adapters registered", async () => {
    const tool = new Surface({ adapter: new FakeAdapter([], {}), config: testConfig({}) });

    const out = (await tool.call("surface.help", {}, { context: { requestClient: "github" } })) as {
      supportedClients: readonly string[];
      sessionIdFormats: { client: string; accepted: Array<{ format: string; meaning: string }> };
    };

    expect(out.supportedClients).toEqual(["discord", "github"]);
    expect(out.sessionIdFormats.client).toBe("github");
    expect(out.sessionIdFormats.accepted).toContainEqual({
      format: "OWNER/REPO#123",
      meaning: "GitHub issue/PR thread",
    });
  });

  it("uses the registered Discord default for unregistered context without inventing support", async () => {
    const both = new Surface({ adapter: new FakeAdapter([], {}), config: testConfig({}) });
    const unregistered = (await both.call(
      "surface.help",
      {},
      { context: { requestClient: "slack" } },
    )) as { supportedClients: readonly string[]; sessionIdFormats: { client: string } };
    expect(unregistered.supportedClients).toEqual(["discord", "github"]);
    expect(unregistered.sessionIdFormats.client).toBe("discord");
  });

  it("returns neutral help syntax for an empty executable registry", async () => {
    const empty = new ProductionSurface({
      adapterResolver: createTestAdapterResolver([]),
      config: testConfig({}),
    });
    const emptyOutput = (await empty.call("surface.help", {})) as {
      supportedClients: readonly string[];
      sessionIdFormats: unknown;
    };
    expect(emptyOutput.supportedClients).toEqual([]);
    expect(emptyOutput.sessionIdFormats).toBeNull();

    const unregistered = (await empty.call(
      "surface.help",
      {},
      { context: { requestClient: "slack" } },
    )) as { sessionIdFormats: unknown };
    expect(unregistered.sessionIdFormats).toBeNull();
  });

  it("does not import or construct protocol operation clients in the generic surface tool", async () => {
    const source = await fs.readFile(
      join(import.meta.dir, "../src/tool-server/tools/surface.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/github-(?:api|auth|app-token|rest)/u);
    expect(source).not.toContain("GithubAdapter");
    expect(source).not.toContain("DiscordAdapter");
    expect(source).not.toContain("githubAdapter:");
  });

  it("keeps generic target and help routing free of explicit platform selection", async () => {
    const source = await fs.readFile(
      join(import.meta.dir, "../src/tool-server/tools/surface.ts"),
      "utf8",
    );
    const defaultSection = source.slice(
      source.indexOf("function withDefaultSessionId"),
      source.indexOf("function mustPresentString"),
    );
    const targetSection = source.slice(
      source.indexOf("private async callHelp"),
      source.indexOf("private async resolveMessageTarget"),
    );
    const routingSection = `${defaultSection}\n${targetSection}`;

    expect(routingSection).not.toMatch(/platform === ["'](?:discord|github)["']/u);
    expect(routingSection).not.toMatch(/switch \([^)]*platform/u);
    expect(routingSection).not.toContain("inferDiscordOrigin");
    expect(routingSection).not.toContain("inferGithubOrigin");
  });

  it("lists session participants", async () => {
    const channelId = "123456789012345678";
    const cfg = testConfig({
      surface: {
        discord: {
          tokenEnv: "DISCORD_TOKEN",
          allowedChannelIds: [channelId],
          allowedGuildIds: [],
          botName: "lilac",
        },
      },
      entity: { sessions: { discord: { ops: channelId } } },
    });

    const adapter = new FakeAdapter(
      [{ ref: { platform: "discord", channelId }, kind: "thread" }],
      {},
      {},
      {
        [channelId]: {
          source: "thread_members",
          participants: [
            {
              userId: "u1",
              userName: "alice",
              displayName: "Alice",
              status: "online",
              activities: [{ type: "playing", name: "Chess" }],
            },
          ],
        },
      },
    );

    const tool = new Surface({ adapter, config: cfg });

    const out = (await tool.call("surface.sessions.listParticipants", {
      client: "discord",
      sessionId: channelId,
    })) as {
      meta: { source: string; count: number; session: { alias?: string } };
      participants: Array<{ userId: string; status?: string }>;
    };

    expect(out.meta.session.alias).toBe("ops");
    expect(out.meta.source).toBe("thread_members");
    expect(out.meta.count).toBe(1);
    expect(out.participants[0]?.userId).toBe("u1");
    expect(out.participants[0]?.status).toBe("online");
  });

  it("defaults sessionId from request context for participant listing", async () => {
    const channelId = "223456789012345678";
    const cfg = testConfig({
      surface: {
        discord: {
          tokenEnv: "DISCORD_TOKEN",
          allowedChannelIds: [channelId],
          allowedGuildIds: [],
          botName: "lilac",
        },
      },
      entity: { sessions: { discord: { ops: channelId } } },
    });

    const adapter = new FakeAdapter(
      [],
      {},
      {},
      {
        [channelId]: {
          source: "guild_members",
          participants: [
            { userId: "u1", userName: "alice" },
            { userId: "u2", userName: "bob" },
          ],
        },
      },
    );

    const tool = new Surface({ adapter, config: cfg });
    const ctx: RequestContext = {
      requestId: "req:participants",
      requestClient: "discord",
      sessionId: channelId,
    };

    const out = (await tool.call(
      "surface.sessions.listParticipants",
      { client: "discord", limit: 1 },
      { context: ctx },
    )) as {
      meta: { count: number };
      participants: Array<{ userId: string }>;
    };

    expect(out.meta.count).toBe(1);
    expect(out.participants[0]?.userId).toBe("u1");
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
      entity: { sessions: { discord: { ops: channelId } } },
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

    const res = (await tool.call("surface.messages.list", {}, { context: ctx })) as {
      meta: { order: string; session: { alias?: string } };
      messages: Array<{ messageId: string }>;
    };

    expect(res.meta.session.alias).toBe("ops");
    expect(res.meta.order).toBe("ts_desc");
    expect(res.messages.length).toBe(1);
    expect(res.messages[0]?.messageId).toBe("m1");
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
        sessions: {
          discord: {
            ops: c1,
          },
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
            raw: {
              discord: {
                attachments: [
                  {
                    url: "https://cdn.discordapp.com/attachments/1/2/deploy.png",
                    filename: "deploy.png",
                  },
                ],
              },
            },
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
      meta: {
        session: { channelId: string; alias?: string };
        order: string;
      };
      hits: Array<{
        messageId: string;
        userAlias?: string;
        hasAttachments?: boolean;
        attachmentCount?: number;
        hasMedia?: boolean;
        mediaCount?: number;
        mediaKinds?: string[];
      }>;
      heal: { attempted: boolean; limit: number } | null;
    };

    expect(first.meta.session.channelId).toBe(c1);
    expect(first.meta.session.alias).toBe("ops");
    expect(first.meta.order).toBe("relevance");
    expect(first.hits.length).toBe(1);
    expect(first.hits[0]?.messageId).toBe("m1");
    expect(first.hits[0]!.userAlias).toBe("alice");
    expect(first.hits[0]?.hasAttachments).toBe(true);
    expect(first.hits[0]?.attachmentCount).toBe(1);
    expect(first.hits[0]?.hasMedia).toBe(true);
    expect(first.hits[0]?.mediaCount).toBe(1);
    expect(first.hits[0]?.mediaKinds).toEqual(["image"]);
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

  it("degrades ordinary search enrichment failures but preserves guarded produced-ref Panic", async () => {
    const channelId = "c1";
    const message: SurfaceMessage = {
      ref: { platform: "discord", channelId, messageId: "m1" },
      session: { platform: "discord", channelId },
      userId: "user",
      text: "deploy result",
      ts: 1,
    };
    const adapter: SurfaceAdapter = new FakeAdapter([], { [channelId]: [message] });
    adapter.readMsg = async () =>
      Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "read-message",
          message: "attachment enrichment unavailable",
        }),
      );
    const searchStore = new DiscordSearchStore(":memory:");
    const search = new DiscordSearchService({ adapter, store: searchStore });
    const tool = new Surface({
      adapter,
      discordSearch: search,
      config: testConfig({
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [channelId],
            allowedGuildIds: [],
            botName: "lilac",
          },
        },
        entity: { sessions: { discord: { ops: channelId } } },
      }),
    });
    try {
      const ordinary = (await tool.call("surface.messages.search", {
        client: "discord",
        sessionId: "#ops",
        query: "deploy",
      })) as { hits: Array<{ hasAttachments?: boolean }> };
      expect(ordinary.hits[0]?.hasAttachments).toBe(false);

      adapter.readMsg = async () =>
        Result.ok({
          ...message,
          ref: { platform: "github", channelId, messageId: "m1" },
        });
      const [settled] = await Promise.allSettled([
        tool.call("surface.messages.search", {
          client: "discord",
          sessionId: "#ops",
          query: "deploy",
        }),
      ]);
      expect(settled?.status).toBe("rejected");
      if (settled?.status === "rejected") expect(Panic.is(settled.reason)).toBe(true);
    } finally {
      searchStore.close();
    }
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
      entity: { sessions: { discord: { ops: channelId } } },
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

    const msg = (await tool.call("surface.messages.read", {}, { context: ctx })) as {
      message: { messageId: string } | null;
    };

    expect(msg.message?.messageId).toBe("m1");
  });

  it("omits read raw payload by default and includes it on demand", async () => {
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
      entity: { sessions: { discord: { ops: channelId } } },
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
            raw: {
              sample: true,
              attachments: [{ url: "https://cdn.discordapp.com/attachments/1/2/log.txt" }],
            },
          },
        ],
      },
    );

    const tool = new Surface({ adapter, config: cfg });
    const base = (await tool.call("surface.messages.read", {
      client: "discord",
      sessionId: channelId,
      messageId: "m1",
    })) as {
      meta: { session: { alias?: string } };
      message: {
        raw?: unknown;
        hasAttachments?: boolean;
        attachmentCount?: number;
        attachments?: unknown[];
      } | null;
    };

    expect(base.meta.session.alias).toBe("ops");
    expect(base.message).not.toBeNull();
    expect("raw" in (base.message ?? {})).toBe(false);
    expect(base.message?.hasAttachments).toBeUndefined();
    expect(base.message?.attachmentCount).toBe(1);
    expect(Array.isArray(base.message?.attachments)).toBe(true);
    expect(base.message?.attachments?.length).toBe(1);

    const withRaw = (await tool.call("surface.messages.read", {
      client: "discord",
      sessionId: channelId,
      messageId: "m1",
      includeRaw: true,
    })) as {
      message: { raw?: unknown; hasAttachments?: boolean } | null;
    };

    expect(withRaw.message?.hasAttachments).toBe(true);
    expect(withRaw.message?.raw).toEqual({
      sample: true,
      attachments: [{ url: "https://cdn.discordapp.com/attachments/1/2/log.txt" }],
    });
  });

  it("uses stored discord tagged text for read richText", async () => {
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
            text: ["normal-text", "[discord_embed]", "embed-title", "embed-description"].join(
              "\n\n",
            ),
            ts: 0,
            raw: {
              content: "normal-text",
              embeds: [
                {
                  title: "embed-title",
                  description: "embed-description",
                  fields: [
                    { name: "field-1", value: "value-1" },
                    { name: "field-2", value: "value-2" },
                  ],
                  image: { url: "https://example.com/embed-image.png" },
                  footer: { text: "embed-footer" },
                },
              ],
            },
          },
        ],
      },
    );

    const tool = new Surface({ adapter, config: cfg });
    const out = (await tool.call("surface.messages.read", {
      client: "discord",
      sessionId: channelId,
      messageId: "m1",
      includeRaw: true,
    })) as {
      message: {
        richText: string;
        raw?: { content?: string };
      } | null;
    };

    expect(out.message?.richText).toBe(
      ["normal-text", "[discord_embed]", "embed-title", "embed-description"].join("\n\n"),
    );
    expect(out.message?.raw?.content).toBe("normal-text");
  });

  it("keeps forward comment text and appends snapshot richText", async () => {
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
            text: [
              "forward-comment",
              "snapshot-content",
              "[discord_embed]",
              "snapshot-title",
              "snapshot-description",
            ].join("\n\n"),
            ts: 0,
            raw: {
              content: "forward-comment",
              reference: { type: 1, messageId: "orig", channelId: "other" },
              messageSnapshots: [
                {
                  message: {
                    content: "snapshot-content",
                    embeds: [
                      {
                        title: "snapshot-title",
                        description: "snapshot-description",
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    );

    const tool = new Surface({ adapter, config: cfg });
    const out = (await tool.call("surface.messages.read", {
      client: "discord",
      sessionId: channelId,
      messageId: "m1",
    })) as {
      message: { richText: string } | null;
    };

    expect(out.message?.richText).toBe(
      [
        "forward-comment",
        "snapshot-content",
        "[discord_embed]",
        "snapshot-title",
        "snapshot-description",
      ].join("\n\n"),
    );
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
    })) as { messages: Array<{ messageId: string }> };

    expect(res.messages.length).toBe(1);
    expect(res.messages[0]?.messageId).toBe("m1");
  });

  it("includes discord message type hints in surface.messages.list", async () => {
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
            text: "created a thread",
            ts: 0,
            raw: { discord: { type: 18, typeName: "ThreadCreated", isChat: false, system: true } },
          },
        ],
      },
    );

    const tool = new Surface({ adapter, config: cfg });
    const res = (await tool.call("surface.messages.list", {
      client: "discord",
      sessionId: channelId,
    })) as {
      messages: Array<{
        platformMessageType?: string;
        platformMessageKind?: string;
        platformMessageTypeId?: number;
        platformIsChat?: boolean;
        platformIsSystem?: boolean;
      }>;
    };

    expect(res.messages.length).toBe(1);
    expect(res.messages[0]?.platformMessageType).toBe("ThreadCreated");
    expect(res.messages[0]?.platformMessageKind).toBe("system");
    expect(res.messages[0]?.platformMessageTypeId).toBeUndefined();
    expect(res.messages[0]?.platformIsChat).toBeUndefined();
    expect(res.messages[0]?.platformIsSystem).toBeUndefined();

    const raw = (await tool.call("surface.messages.list", {
      client: "discord",
      sessionId: channelId,
      includeRaw: true,
    })) as {
      messages: Array<{
        platformMessageTypeId?: number;
        platformIsChat?: boolean;
        platformIsSystem?: boolean;
      }>;
    };

    expect(raw.messages[0]?.platformMessageTypeId).toBe(18);
    expect(raw.messages[0]?.platformIsChat).toBe(false);
    expect(raw.messages[0]?.platformIsSystem).toBe(true);
  });

  it("expands a ThreadStarterMessage parent seed into referenced", async () => {
    const parentChannelId = "111";
    const threadId = "222";
    const cfg = testConfig({
      surface: {
        discord: {
          tokenEnv: "DISCORD_TOKEN",
          allowedChannelIds: [parentChannelId, threadId],
          allowedGuildIds: [],
          botName: "lilac",
        },
      },
    });

    const seed: SurfaceMessage = {
      ref: { platform: "discord", channelId: parentChannelId, messageId: "seed" },
      session: { platform: "discord", channelId: parentChannelId, guildId: "g" },
      userId: "stanley",
      userName: "Stanley",
      text: "original seed text",
      ts: 100,
      raw: { discord: { type: 0, typeName: "Default", isChat: true, system: false } },
    };

    const starter: SurfaceMessage = {
      ref: { platform: "discord", channelId: threadId, messageId: "starter" },
      session: {
        platform: "discord",
        channelId: threadId,
        guildId: "g",
        parentChannelId,
      },
      userId: "foo",
      userName: "Foo",
      text: "",
      ts: 200,
      raw: {
        reference: { messageId: "seed", channelId: parentChannelId, guildId: "g", type: 0 },
        discord: { type: 21, typeName: "ThreadStarterMessage", isChat: false, system: true },
      },
    };

    const adapter = new FakeAdapter(
      [
        { ref: { platform: "discord", channelId: parentChannelId, guildId: "g" }, kind: "channel" },
        {
          ref: { platform: "discord", channelId: threadId, guildId: "g", parentChannelId },
          kind: "thread",
        },
      ],
      { [parentChannelId]: [seed], [threadId]: [starter] },
      { [parentChannelId]: "g", [threadId]: "g" },
    );

    const tool = new Surface({ adapter, config: cfg });
    const res = (await tool.call("surface.messages.list", {
      client: "discord",
      sessionId: threadId,
      order: "ts_asc",
    })) as {
      messages: Array<{
        richText: string;
        referenced?: {
          messageId?: string;
          userName?: string;
          richText?: string;
          referenced?: unknown;
        };
      }>;
    };

    expect(res.messages[0]?.richText).toBe("");
    expect(res.messages[0]?.referenced?.messageId).toBe("seed");
    expect(res.messages[0]?.referenced?.userName).toBe("Stanley");
    expect(res.messages[0]?.referenced?.richText).toBe("original seed text");
    expect(res.messages[0]?.referenced?.referenced).toBeUndefined();
  });

  it("expands same-session references and skips normal cross-session references", async () => {
    const channelId = "333";
    const otherChannelId = "444";
    const cfg = testConfig({
      surface: {
        discord: {
          tokenEnv: "DISCORD_TOKEN",
          allowedChannelIds: [channelId, otherChannelId],
          allowedGuildIds: [],
          botName: "lilac",
        },
      },
    });

    const root: SurfaceMessage = {
      ref: { platform: "discord", channelId, messageId: "root" },
      session: { platform: "discord", channelId, guildId: "g" },
      userId: "u1",
      userName: "User 1",
      text: "same channel root",
      ts: 100,
      raw: { discord: { type: 0, typeName: "Default", isChat: true, system: false } },
    };
    const reply: SurfaceMessage = {
      ref: { platform: "discord", channelId, messageId: "reply" },
      session: { platform: "discord", channelId, guildId: "g" },
      userId: "u2",
      userName: "User 2",
      text: "same channel reply",
      ts: 200,
      raw: {
        reference: { messageId: "root", channelId, guildId: "g", type: 0 },
        discord: { type: 19, typeName: "Reply", isChat: true, system: false },
      },
    };
    const cross: SurfaceMessage = {
      ref: { platform: "discord", channelId, messageId: "cross" },
      session: { platform: "discord", channelId, guildId: "g" },
      userId: "u3",
      userName: "User 3",
      text: "cross channel reply",
      ts: 300,
      raw: {
        reference: { messageId: "other-root", channelId: otherChannelId, guildId: "g", type: 0 },
        discord: { type: 19, typeName: "Reply", isChat: true, system: false },
      },
    };
    const otherRoot: SurfaceMessage = {
      ref: { platform: "discord", channelId: otherChannelId, messageId: "other-root" },
      session: { platform: "discord", channelId: otherChannelId, guildId: "g" },
      userId: "u4",
      userName: "User 4",
      text: "other channel root",
      ts: 50,
      raw: { discord: { type: 0, typeName: "Default", isChat: true, system: false } },
    };

    const adapter = new FakeAdapter(
      [
        { ref: { platform: "discord", channelId, guildId: "g" }, kind: "channel" },
        { ref: { platform: "discord", channelId: otherChannelId, guildId: "g" }, kind: "channel" },
      ],
      { [channelId]: [root, reply, cross], [otherChannelId]: [otherRoot] },
      { [channelId]: "g", [otherChannelId]: "g" },
    );

    const tool = new Surface({ adapter, config: cfg });
    const res = (await tool.call("surface.messages.list", {
      client: "discord",
      sessionId: channelId,
      order: "ts_asc",
    })) as { messages: Array<{ messageId: string; referenced?: { messageId?: string } }> };

    expect(res.messages.find((m) => m.messageId === "reply")?.referenced?.messageId).toBe("root");
    expect(res.messages.find((m) => m.messageId === "cross")?.referenced).toBeUndefined();
    expect(adapter.readCalls).toEqual([]);
  });

  it("does not live-expand forwarded references", async () => {
    const channelId = "555";
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

    const original: SurfaceMessage = {
      ref: { platform: "discord", channelId, messageId: "orig" },
      session: { platform: "discord", channelId },
      userId: "u1",
      userName: "User 1",
      text: "should not be fetched",
      ts: 100,
    };
    const forwarded: SurfaceMessage = {
      ref: { platform: "discord", channelId, messageId: "fwd" },
      session: { platform: "discord", channelId },
      userId: "u2",
      userName: "User 2",
      text: "Forwarded snapshot text",
      ts: 200,
      raw: {
        reference: { type: 1, messageId: "orig", channelId },
        messageSnapshots: [{ message: { content: "Forwarded snapshot text" } }],
      },
    };

    const adapter = new FakeAdapter(
      [{ ref: { platform: "discord", channelId }, kind: "channel" }],
      { [channelId]: [original, forwarded] },
    );

    const tool = new Surface({ adapter, config: cfg });
    const res = (await tool.call("surface.messages.list", {
      client: "discord",
      sessionId: channelId,
      order: "ts_asc",
    })) as { messages: Array<{ messageId: string; richText?: string; referenced?: unknown }> };

    const fwd = res.messages.find((m) => m.messageId === "fwd");
    expect(fwd?.richText).toBe("Forwarded snapshot text");
    expect(fwd?.referenced).toBeUndefined();
  });

  it("memoizes duplicate live reference fetches during list expansion", async () => {
    const channelId = "666";
    const parentChannelId = "777";
    const cfg = testConfig({
      surface: {
        discord: {
          tokenEnv: "DISCORD_TOKEN",
          allowedChannelIds: [channelId, parentChannelId],
          allowedGuildIds: [],
          botName: "lilac",
        },
      },
    });

    const seed: SurfaceMessage = {
      ref: { platform: "discord", channelId: parentChannelId, messageId: "seed" },
      session: { platform: "discord", channelId: parentChannelId, guildId: "g" },
      userId: "u1",
      userName: "User 1",
      text: "shared seed",
      ts: 100,
      raw: { discord: { type: 0, typeName: "Default", isChat: true, system: false } },
    };

    const starters: SurfaceMessage[] = ["starter-1", "starter-2"].map((messageId, index) => ({
      ref: { platform: "discord", channelId, messageId },
      session: { platform: "discord", channelId, guildId: "g", parentChannelId },
      userId: `u${index + 2}`,
      userName: `User ${index + 2}`,
      text: "",
      ts: 200 + index,
      raw: {
        reference: { messageId: "seed", channelId: parentChannelId, guildId: "g", type: 0 },
        discord: { type: 21, typeName: "ThreadStarterMessage", isChat: false, system: true },
      },
    }));

    const adapter = new FakeAdapter(
      [
        { ref: { platform: "discord", channelId, guildId: "g", parentChannelId }, kind: "thread" },
        { ref: { platform: "discord", channelId: parentChannelId, guildId: "g" }, kind: "channel" },
      ],
      { [channelId]: starters, [parentChannelId]: [seed] },
      { [channelId]: "g", [parentChannelId]: "g" },
    );

    const tool = new Surface({ adapter, config: cfg });
    const res = (await tool.call("surface.messages.list", {
      client: "discord",
      sessionId: channelId,
      order: "ts_asc",
    })) as { messages: Array<{ referenced?: { messageId?: string } }> };

    expect(res.messages.map((m) => m.referenced?.messageId)).toEqual(["seed", "seed"]);
    expect(adapter.readCalls).toEqual([
      { platform: "discord", channelId: parentChannelId, messageId: "seed" },
    ]);
  });

  it("supports list order and includeRaw options", async () => {
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
            userId: "u1",
            text: "first",
            ts: 100,
            raw: { discord: { type: 0, typeName: "Default", isChat: true, system: false } },
          },
          {
            ref: { platform: "discord", channelId, messageId: "m2" },
            session: { platform: "discord", channelId },
            userId: "u2",
            text: "second",
            ts: 200,
            raw: { discord: { type: 0, typeName: "Default", isChat: true, system: false } },
          },
        ],
      },
    );

    const tool = new Surface({ adapter, config: cfg });

    const def = (await tool.call("surface.messages.list", {
      client: "discord",
      sessionId: channelId,
    })) as {
      meta: { order: string };
      messages: Array<{ messageId: string; raw?: unknown }>;
    };

    expect(def.meta.order).toBe("ts_desc");
    expect(def.messages.map((m) => m.messageId)).toEqual(["m2", "m1"]);
    expect("raw" in (def.messages[0] ?? {})).toBe(false);

    const ascWithRaw = (await tool.call("surface.messages.list", {
      client: "discord",
      sessionId: channelId,
      order: "ts_asc",
      includeRaw: true,
    })) as {
      meta: { order: string };
      messages: Array<{ messageId: string; raw?: unknown }>;
    };

    expect(ascWithRaw.meta.order).toBe("ts_asc");
    expect(ascWithRaw.messages.map((m) => m.messageId)).toEqual(["m1", "m2"]);
    expect(ascWithRaw.messages[0]?.raw).toBeDefined();
  });

  it("returns attachment/media hints in list and full metadata on demand", async () => {
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
            userId: "u1",
            text: "see files",
            ts: 100,
            raw: {
              discord: {
                attachments: [
                  {
                    url: "https://cdn.discordapp.com/attachments/1/2/screenshot.png",
                    filename: "screenshot.png",
                    size: 42,
                  },
                  {
                    url: "https://cdn.discordapp.com/attachments/1/2/notes.pdf",
                    filename: "notes.pdf",
                    mimeType: "application/pdf",
                    size: 88,
                  },
                ],
              },
            },
          },
        ],
      },
    );

    const tool = new Surface({ adapter, config: cfg });

    const hintsOnly = (await tool.call("surface.messages.list", {
      client: "discord",
      sessionId: channelId,
    })) as {
      messages: Array<{
        hasAttachments?: boolean;
        attachmentCount?: number;
        hasMedia?: boolean;
        mediaCount?: number;
        mediaKinds?: string[];
        attachments?: unknown[];
      }>;
    };

    expect(hintsOnly.messages[0]?.hasAttachments).toBeUndefined();
    expect(hintsOnly.messages[0]?.attachmentCount).toBe(2);
    expect(hintsOnly.messages[0]?.hasMedia).toBeUndefined();
    expect(hintsOnly.messages[0]?.mediaCount).toBe(1);
    expect(hintsOnly.messages[0]?.mediaKinds).toEqual(["image"]);
    expect("attachments" in (hintsOnly.messages[0] ?? {})).toBe(false);

    const rawHints = (await tool.call("surface.messages.list", {
      client: "discord",
      sessionId: channelId,
      includeRaw: true,
    })) as {
      messages: Array<{
        hasAttachments?: boolean;
        hasMedia?: boolean;
      }>;
    };

    expect(rawHints.messages[0]?.hasAttachments).toBe(true);
    expect(rawHints.messages[0]?.hasMedia).toBe(true);

    const withAttachments = (await tool.call("surface.messages.list", {
      client: "discord",
      sessionId: channelId,
      includeAttachments: true,
    })) as {
      messages: Array<{
        attachments?: Array<{ kind?: string; filename?: string; mimeType?: string }>;
        mediaFiles?: Array<{ kind?: string }>;
      }>;
    };

    expect(withAttachments.messages[0]?.attachments?.length).toBe(2);
    expect(withAttachments.messages[0]?.attachments?.[0]?.kind).toBe("image");
    expect(withAttachments.messages[0]?.attachments?.[0]?.mimeType).toBe("image/png");
    expect(withAttachments.messages[0]?.attachments?.[1]?.kind).toBe("file");
    expect(withAttachments.messages[0]?.mediaFiles?.length).toBe(1);
    expect(withAttachments.messages[0]?.mediaFiles?.[0]?.kind).toBe("image");
  });

  it("falls back to top-level attachments when forwarded snapshot attachments are empty", async () => {
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

    const raw = {
      reference: {
        type: 1,
        messageId: "orig",
        channelId: "other",
      },
      attachments: [
        {
          url: "https://cdn.discordapp.com/attachments/orig/1/IMG_TOP.png",
          filename: "IMG_TOP.png",
          mimeType: "image/png",
          size: 10,
        },
      ],
      messageSnapshots: [
        {
          message: {
            content: "Forwarded snapshot text",
            attachments: [],
          },
        },
      ],
    };

    const adapter = new FakeAdapter(
      [{ ref: { platform: "discord", channelId }, kind: "channel" }],
      {
        [channelId]: [
          {
            ref: { platform: "discord", channelId, messageId: "m1" },
            session: { platform: "discord", channelId },
            userId: "u1",
            text: "Forwarded snapshot text",
            ts: 100,
            raw,
          },
        ],
      },
    );

    const tool = new Surface({ adapter, config: cfg });

    const listed = (await tool.call("surface.messages.list", {
      client: "discord",
      sessionId: channelId,
      includeAttachments: true,
    })) as {
      messages: Array<{
        attachmentCount?: number;
        attachments?: Array<{ filename?: string; kind?: string }>;
      }>;
    };

    expect(listed.messages[0]?.attachmentCount).toBe(1);
    expect(listed.messages[0]?.attachments?.[0]?.filename).toBe("IMG_TOP.png");
    expect(listed.messages[0]?.attachments?.[0]?.kind).toBe("image");

    const read = (await tool.call("surface.messages.read", {
      client: "discord",
      sessionId: channelId,
      messageId: "m1",
    })) as {
      message: {
        attachmentCount?: number;
        attachments?: Array<{ filename?: string; kind?: string }>;
      } | null;
    };

    expect(read.message?.attachmentCount).toBe(1);
    expect(read.message?.attachments?.[0]?.filename).toBe("IMG_TOP.png");
    expect(read.message?.attachments?.[0]?.kind).toBe("image");
  });

  it("supports search order options", async () => {
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
            userId: "u1",
            text: "deploy alpha",
            ts: 100,
          },
          {
            ref: { platform: "discord", channelId, messageId: "m2" },
            session: { platform: "discord", channelId },
            userId: "u2",
            text: "deploy beta",
            ts: 200,
          },
        ],
      },
    );

    const searchStore = new DiscordSearchStore(":memory:");
    const search = new DiscordSearchService({ adapter, store: searchStore });
    const tool = new Surface({ adapter, config: cfg, discordSearch: search });

    const asc = (await tool.call("surface.messages.search", {
      client: "discord",
      sessionId: channelId,
      query: "deploy",
      order: "ts_asc",
    })) as {
      meta: { order: string };
      hits: Array<{ messageId: string }>;
    };

    expect(asc.meta.order).toBe("ts_asc");
    expect(asc.hits.map((h) => h.messageId)).toEqual(["m1", "m2"]);

    const desc = (await tool.call("surface.messages.search", {
      client: "discord",
      sessionId: channelId,
      query: "deploy",
      order: "ts_desc",
    })) as {
      meta: { order: string };
      hits: Array<{ messageId: string }>;
    };

    expect(desc.meta.order).toBe("ts_desc");
    expect(desc.hits.map((h) => h.messageId)).toEqual(["m2", "m1"]);

    searchStore.close();
  });

  it("indexes the same stored discord text that read returns", async () => {
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
            userId: "u1",
            text: ["normal-text", "[discord_embed]", "embed-title", "embed-description"].join(
              "\n\n",
            ),
            ts: 100,
            raw: {
              content: "normal-text",
              embeds: [
                {
                  title: "embed-title",
                  description: "embed-description",
                  fields: [{ name: "field-1", value: "value-1" }],
                  footer: { text: "embed-footer" },
                },
              ],
            },
          },
          {
            ref: { platform: "discord", channelId, messageId: "m2" },
            session: { platform: "discord", channelId },
            userId: "u2",
            text: [
              "forward-comment",
              "snapshot-content",
              "[discord_embed]",
              "snapshot-title",
              "snapshot-description",
            ].join("\n\n"),
            ts: 200,
            raw: {
              content: "forward-comment",
              reference: { type: 1, messageId: "orig", channelId: "other" },
              messageSnapshots: [
                {
                  message: {
                    content: "snapshot-content",
                    embeds: [
                      {
                        title: "snapshot-title",
                        description: "snapshot-description",
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    );

    const searchStore = new DiscordSearchStore(":memory:");
    const search = new DiscordSearchService({ adapter, store: searchStore });
    const tool = new Surface({ adapter, config: cfg, discordSearch: search });

    const embedHit = (await tool.call("surface.messages.search", {
      client: "discord",
      sessionId: channelId,
      query: "embed-description",
    })) as {
      hits: Array<{ messageId: string; richText: string }>;
    };

    const embedRead = (await tool.call("surface.messages.read", {
      client: "discord",
      sessionId: channelId,
      messageId: "m1",
    })) as {
      message: { richText: string } | null;
    };

    expect(embedHit.hits).toHaveLength(1);
    expect(embedHit.hits[0]?.messageId).toBe("m1");
    expect(embedHit.hits[0]?.richText).toBe(embedRead.message?.richText);

    const forwardHit = (await tool.call("surface.messages.search", {
      client: "discord",
      sessionId: channelId,
      query: "snapshot-description",
    })) as {
      hits: Array<{ messageId: string; richText: string }>;
    };

    const forwardRead = (await tool.call("surface.messages.read", {
      client: "discord",
      sessionId: channelId,
      messageId: "m2",
    })) as {
      message: { richText: string } | null;
    };

    expect(forwardHit.hits).toHaveLength(1);
    expect(forwardHit.hits[0]?.messageId).toBe("m2");
    expect(forwardHit.hits[0]?.richText).toBe(forwardRead.message?.richText);

    searchStore.close();
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

    await expect(tool.call("surface.reactions.list", {}, { context: ctx })).rejects.toThrow(
      "requires --message-id",
    );
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
      entity: {
        sessions: {
          discord: {
            ops: { discord: "c1", comment: "Deploy coordination" },
          },
        },
      },
    });

    const adapter = new FakeAdapter([], {});
    const tool = new Surface({ adapter, config: cfg });

    const res = await tool.call("surface.messages.send", {
      sessionId: "#ops",
      text: "hi",
      paths: p,
      filenames: "renamed.txt",
      client: "discord",
    });

    expect((res as any).ok).toBe(true);
    expect((res as any).session?.alias).toBe("ops");
    expect(adapter.sendCalls.length).toBe(1);
    expect(adapter.sendCalls[0]!.sessionRef.channelId).toBe("c1");

    const sent = adapter.sendCalls[0]!;
    expect(sent.content.text).toBe("hi");
    expect(sent.content.attachments?.length).toBe(1);
    expect(sent.content.attachments?.[0]?.filename).toBe("renamed.txt");
    await expect(
      tool.call("surface.messages.send", {
        sessionId: "#ops",
        text: "too many",
        paths: Array.from({ length: 11 }, () => p),
        client: "discord",
      }),
    ).rejects.toThrow("paths");
    expect(adapter.sendCalls.length).toBe(1);
  });

  it.each(["paths", "filenames", "mimeTypes"] as const)(
    "keeps the callable schema max of 10 for %s before adapter resolution",
    async (field) => {
      let resolveCalls = 0;
      const tool = new ProductionSurface({
        adapterResolver: {
          registeredPlatforms: () => [],
          resolve: () => {
            resolveCalls += 1;
            return null;
          },
        },
        config: testConfig({}),
      });

      await expect(
        tool.call("surface.messages.send", {
          client: "github",
          sessionId: "octo/repo#12",
          text: "oversized",
          [field]: Array.from({ length: 11 }, (_, index) => `${field}-${index}`),
        }),
      ).rejects.toThrow(field);
      expect(resolveCalls).toBe(0);
    },
  );

  it("keeps Discord attachment path validation before sending", async () => {
    const channelId = "123456789012345678";
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
    const adapter = new FakeAdapter([], {});
    const tool = new Surface({ adapter, config: cfg });
    const missingPath = join(tmpdir(), `missing-surface-attachment-${crypto.randomUUID()}.txt`);

    await expect(
      tool.call("surface.messages.send", {
        client: "discord",
        sessionId: channelId,
        text: "attachment",
        paths: missingPath,
      }),
    ).rejects.toThrow("ENOENT");
    expect(adapter.sendCalls).toEqual([]);
  });

  it("forwards silent=true for send", async () => {
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
      sessionId: "ops",
      text: "hi",
      silent: true,
      client: "discord",
    });

    expect((res as any).ok).toBe(true);
    expect(adapter.sendCalls.length).toBe(1);
    expect(adapter.sendCalls[0]?.opts?.silent).toBe(true);
  });

  it("links sent messages back to the request transcript", async () => {
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

    const linked: Array<{ requestId: string; created: readonly MsgRef[]; last: MsgRef }> = [];
    const transcriptStore: TranscriptStore = {
      saveRequestTranscript() {
        return Result.ok(undefined);
      },
      linkSurfaceMessagesToRequest(input) {
        linked.push(input);
      },
      getTranscriptBySurfaceMessage() {
        return Result.ok(null);
      },
      close() {},
    };

    const adapter = new FakeAdapter([], {});
    const tool = new Surface({ adapter, config: cfg, transcriptStore });

    const res = await tool.call(
      "surface.messages.send",
      {
        sessionId: "ops",
        text: "hi",
        client: "discord",
      },
      {
        context: {
          requestId: "heartbeat:1",
          sessionId: "__heartbeat__",
          requestClient: "unknown",
        } satisfies RequestContext,
      },
    );

    expect((res as any).ok).toBe(true);
    expect(linked).toEqual([
      {
        requestId: "heartbeat:1",
        created: [{ platform: "discord", channelId: "c1", messageId: "sent" }],
        last: { platform: "discord", channelId: "c1", messageId: "sent" },
      },
    ]);
  });

  it("does not auto-link non-heartbeat sends", async () => {
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

    const linked: Array<{ requestId: string; created: readonly MsgRef[]; last: MsgRef }> = [];
    const transcriptStore: TranscriptStore = {
      saveRequestTranscript() {
        return Result.ok(undefined);
      },
      linkSurfaceMessagesToRequest(input) {
        linked.push(input);
      },
      getTranscriptBySurfaceMessage() {
        return Result.ok(null);
      },
      close() {},
    };

    const adapter = new FakeAdapter([], {});
    const tool = new Surface({ adapter, config: cfg, transcriptStore });

    await tool.call(
      "surface.messages.send",
      {
        sessionId: "ops",
        text: "hi",
        client: "discord",
      },
      {
        context: {
          requestId: "req:1",
          sessionId: "c1",
          requestClient: "discord",
        } satisfies RequestContext,
      },
    );

    expect(linked).toEqual([]);
  });

  it("preserves Panic from best-effort transcript linkage", async () => {
    const panic = new Panic({ message: "transcript linkage invariant" });
    const transcriptStore: TranscriptStore = {
      saveRequestTranscript() {
        return Result.ok(undefined);
      },
      linkSurfaceMessagesToRequest() {
        throw panic;
      },
      getTranscriptBySurfaceMessage() {
        return Result.ok(null);
      },
      close() {},
    };
    const tool = new Surface({
      adapter: new FakeAdapter([], {}),
      transcriptStore,
      config: testConfig({
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: ["123456789012345678"],
            allowedGuildIds: [],
            botName: "lilac",
          },
        },
      }),
    });

    const [settled] = await Promise.allSettled([
      tool.call(
        "surface.messages.send",
        {
          client: "discord",
          sessionId: "123456789012345678",
          text: "hello",
        },
        {
          context: {
            requestId: "heartbeat:panic-link",
            sessionId: "__heartbeat__",
            requestClient: "unknown",
          },
        },
      ),
    ]);
    expect(settled?.status).toBe("rejected");
    if (settled?.status === "rejected") expect(Panic.is(settled.reason)).toBe(true);
  });

  it("lists recent visible agent writes with thin previews", async () => {
    const cfg = testConfig({
      surface: {
        discord: {
          tokenEnv: "DISCORD_TOKEN",
          allowedChannelIds: ["c1"],
          allowedGuildIds: [],
          botName: "lilac",
        },
      },
      entity: {
        sessions: {
          discord: {
            ops: "c1",
          },
        },
      },
    });

    const longText = `Agent update\n\n${"x".repeat(140)}`;
    const adapter = new FakeAdapter([], {
      c1: [
        {
          ref: { platform: "discord", channelId: "c1", messageId: "m1" },
          session: { platform: "discord", channelId: "c1" },
          userId: "bot",
          userName: "lilac",
          text: longText,
          ts: 1,
        },
      ],
      c2: [
        {
          ref: { platform: "discord", channelId: "c2", messageId: "m2" },
          session: { platform: "discord", channelId: "c2" },
          userId: "bot",
          userName: "lilac",
          text: "hidden write",
          ts: 2,
        },
      ],
    });

    const tmp = await fs.mkdtemp(join(tmpdir(), "lilac-surface-transcript-"));
    const transcriptStore = new SqliteTranscriptStore(join(tmp, "transcripts.sqlite"));

    try {
      transcriptStore.saveRequestTranscript({
        requestId: "heartbeat:allowed",
        sessionId: "__heartbeat__",
        requestClient: "unknown",
        messages: [],
        finalText: "fallback preview should not win",
      });
      transcriptStore.linkSurfaceMessagesToRequest({
        requestId: "heartbeat:allowed",
        created: [{ platform: "discord", channelId: "c1", messageId: "m1" }],
        last: { platform: "discord", channelId: "c1", messageId: "m1" },
      });

      // test-wait-justification: gives the hidden transcript a later wall-clock timestamp for recent-write ordering
      await new Promise((resolve) => setTimeout(resolve, 5));

      transcriptStore.saveRequestTranscript({
        requestId: "heartbeat:hidden",
        sessionId: "__heartbeat__",
        requestClient: "unknown",
        messages: [],
        finalText: "hidden write",
      });
      transcriptStore.linkSurfaceMessagesToRequest({
        requestId: "heartbeat:hidden",
        created: [{ platform: "discord", channelId: "c2", messageId: "m2" }],
        last: { platform: "discord", channelId: "c2", messageId: "m2" },
      });

      const tool = new Surface({ adapter, config: cfg, transcriptStore });
      const out = (await tool.call("surface.activities.recentAgentWrites", {
        limit: 5,
      })) as Array<{
        sessionId: string;
        messageId: string;
        alias?: string;
        client: string;
        requestId: string;
        preview: string;
        updatedTs: number;
        truncated: boolean;
      }>;

      expect(out).toHaveLength(1);
      expect(out[0]?.sessionId).toBe("c1");
      expect(out[0]?.messageId).toBe("m1");
      expect(out[0]?.alias).toBe("ops");
      expect(out[0]?.client).toBe("discord");
      expect(out[0]?.requestId).toBe("heartbeat:allowed");
      expect(out[0]?.updatedTs).toBeTypeOf("number");
      expect(out[0]?.preview).toBe(longText.replace(/\s+/g, " ").trim().slice(0, 128));
      expect(out[0]?.truncated).toBe(true);
    } finally {
      transcriptStore.close();
    }
  });

  it("skips hidden recent writes before applying the final limit", async () => {
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

    const adapter = new FakeAdapter([], {
      c1: [
        {
          ref: { platform: "discord", channelId: "c1", messageId: "m-visible" },
          session: { platform: "discord", channelId: "c1" },
          userId: "bot",
          userName: "lilac",
          text: "visible write",
          ts: 1,
        },
      ],
      c2: [
        {
          ref: { platform: "discord", channelId: "c2", messageId: "m-hidden" },
          session: { platform: "discord", channelId: "c2" },
          userId: "bot",
          userName: "lilac",
          text: "hidden write",
          ts: 2,
        },
      ],
    });

    const tmp = await fs.mkdtemp(join(tmpdir(), "lilac-surface-transcript-"));
    const transcriptStore = new SqliteTranscriptStore(join(tmp, "transcripts.sqlite"));

    try {
      transcriptStore.saveRequestTranscript({
        requestId: "heartbeat:visible",
        sessionId: "__heartbeat__",
        requestClient: "unknown",
        messages: [],
        finalText: "visible write",
      });
      transcriptStore.linkSurfaceMessagesToRequest({
        requestId: "heartbeat:visible",
        created: [{ platform: "discord", channelId: "c1", messageId: "m-visible" }],
        last: { platform: "discord", channelId: "c1", messageId: "m-visible" },
      });

      // test-wait-justification: gives the hidden transcript a later wall-clock timestamp before limit filtering
      await new Promise((resolve) => setTimeout(resolve, 5));

      transcriptStore.saveRequestTranscript({
        requestId: "heartbeat:hidden",
        sessionId: "__heartbeat__",
        requestClient: "unknown",
        messages: [],
        finalText: "hidden write",
      });
      transcriptStore.linkSurfaceMessagesToRequest({
        requestId: "heartbeat:hidden",
        created: [{ platform: "discord", channelId: "c2", messageId: "m-hidden" }],
        last: { platform: "discord", channelId: "c2", messageId: "m-hidden" },
      });

      const tool = new Surface({ adapter, config: cfg, transcriptStore });
      const out = (await tool.call("surface.activities.recentAgentWrites", {
        limit: 1,
      })) as Array<{ requestId: string; sessionId: string; messageId: string }>;

      expect(out).toHaveLength(1);
      expect(out[0]).toEqual(
        expect.objectContaining({
          requestId: "heartbeat:visible",
          sessionId: "c1",
          messageId: "m-visible",
        }),
      );
    } finally {
      transcriptStore.close();
    }
  });

  it("errors clearly when recent agent writes are unavailable", async () => {
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

    const tool = new Surface({
      adapter: new FakeAdapter([], {}),
      config: cfg,
    });

    await expect(tool.call("surface.activities.recentAgentWrites", {})).rejects.toThrow(
      "transcript store is not initialized",
    );
  });

  it.each([
    ["ordinary read rejection", "rejection"],
    ["expected read Result", "result"],
  ] as const)("falls back to persisted recent-write text after an %s", async (_label, mode) => {
    const adapter: SurfaceAdapter = new FakeAdapter([], {});
    adapter.readMsg = async () => {
      if (mode === "rejection") throw new Error("message provider unavailable");
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "read-message",
          message: "message provider unavailable",
        }),
      );
    };
    const tmp = await fs.mkdtemp(join(tmpdir(), "lilac-surface-fallback-"));
    const transcriptStore = new SqliteTranscriptStore(join(tmp, "transcripts.sqlite"));
    try {
      transcriptStore.saveRequestTranscript({
        requestId: "heartbeat:fallback",
        sessionId: "__heartbeat__",
        requestClient: "unknown",
        messages: [],
        finalText: "persisted fallback",
      });
      transcriptStore.linkSurfaceMessagesToRequest({
        requestId: "heartbeat:fallback",
        created: [{ platform: "discord", channelId: "c1", messageId: "m1" }],
        last: { platform: "discord", channelId: "c1", messageId: "m1" },
      });
      const tool = new Surface({
        adapter,
        transcriptStore,
        config: testConfig({
          surface: {
            discord: {
              tokenEnv: "DISCORD_TOKEN",
              allowedChannelIds: ["c1"],
              allowedGuildIds: [],
              botName: "lilac",
            },
          },
        }),
      });

      const output = (await tool.call("surface.activities.recentAgentWrites", {})) as Array<{
        preview: string;
      }>;
      expect(output[0]?.preview).toBe("persisted fallback");
    } finally {
      transcriptStore.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("preserves a guarded produced-ref Panic through recent-write fallback", async () => {
    const adapter = new FakeAdapter([], {});
    adapter.readMsg = async () =>
      Result.ok({
        ref: { platform: "github", channelId: "c1", messageId: "m1" },
        session: { platform: "discord", channelId: "c1" },
        userId: "bot",
        text: "invalid",
        ts: 1,
      });
    const tmp = await fs.mkdtemp(join(tmpdir(), "lilac-surface-panic-"));
    const transcriptStore = new SqliteTranscriptStore(join(tmp, "transcripts.sqlite"));
    try {
      transcriptStore.saveRequestTranscript({
        requestId: "heartbeat:panic",
        sessionId: "__heartbeat__",
        requestClient: "unknown",
        messages: [],
        finalText: "must not hide panic",
      });
      transcriptStore.linkSurfaceMessagesToRequest({
        requestId: "heartbeat:panic",
        created: [{ platform: "discord", channelId: "c1", messageId: "m1" }],
        last: { platform: "discord", channelId: "c1", messageId: "m1" },
      });
      const tool = new Surface({
        adapter,
        transcriptStore,
        config: testConfig({
          surface: {
            discord: {
              tokenEnv: "DISCORD_TOKEN",
              allowedChannelIds: ["c1"],
              allowedGuildIds: [],
              botName: "lilac",
            },
          },
        }),
      });

      const [settled] = await Promise.allSettled([
        tool.call("surface.activities.recentAgentWrites", {}),
      ]);
      expect(settled?.status).toBe("rejected");
      if (settled?.status === "rejected") expect(Panic.is(settled.reason)).toBe(true);
    } finally {
      transcriptStore.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
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

  it("preserves Panic from guild resolution instead of degrading it to a cache miss", async () => {
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
    const panic = new Panic({ message: "guild resolver invariant" });
    const rawAdapter = new FakeAdapter([], {});
    rawAdapter.fetchGuildIdForChannel = async () => {
      throw panic;
    };
    const adapter = createDescriptorBoundSurfaceAdapter("discord", rawAdapter);
    const tool = new Surface({ adapter, config: cfg });

    const [settled] = await Promise.allSettled([
      tool.call("surface.messages.send", {
        sessionId: "ops",
        text: "hi",
        client: "discord",
      }),
    ]);
    expect(settled?.status).toBe("rejected");
    if (settled?.status === "rejected") expect(Panic.is(settled.reason)).toBe(true);
    expect(rawAdapter.sendCalls).toEqual([]);
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

  it("returns the GitHub adapter's stable unsupported sessions.list output", async () => {
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

    await expect(tool.call("surface.sessions.list", { client: "github" })).rejects.toThrow(
      "GitHub session discovery is not supported; use GitHub issue/PR discovery",
    );
  });

  it("maps unsupported operations to nonretryable usage failures", async () => {
    const adapter: SurfaceAdapter = new FakeAdapter([], {});
    adapter.listSessions = async () =>
      Result.err(
        new SurfaceOperationUnsupported({
          platform: "discord",
          operation: "list-sessions",
          message: "session discovery is unsupported",
        }),
      );
    const tool = new Surface({ adapter, config: testConfig({}) });

    const result = await tool.callResult("surface.sessions.list", { client: "discord" });
    expect(result).toMatchObject({
      status: "error",
      error: {
        kind: "usage",
        code: "surface_operation_unsupported",
        retryable: false,
      },
    });
  });

  it("rejects unexpected adapter defects", async () => {
    const defect = new TypeError("invalid adapter state");
    const adapter: SurfaceAdapter = new FakeAdapter([], {});
    adapter.listSessions = async () => {
      throw defect;
    };
    const tool = new Surface({ adapter, config: testConfig({}) });

    const [settled] = await Promise.allSettled([
      tool.callResult("surface.sessions.list", { client: "discord" }),
    ]);
    expect(settled?.status).toBe("rejected");
    if (settled?.status === "rejected") {
      expect(Panic.is(settled.reason)).toBe(true);
      expect(settled.reason).toMatchObject({ cause: defect });
    }
  });

  it("preserves rate-limit retry metadata and unavailable retryability", async () => {
    const adapter: SurfaceAdapter = new FakeAdapter([], {});
    adapter.listSessions = async () =>
      Result.err(
        new SurfaceRateLimited({
          platform: "discord",
          operation: "list-sessions",
          retryAfterMs: 2_500,
          message: "surface rate limited",
        }),
      );
    const tool = new Surface({ adapter, config: testConfig({}) });

    const rateLimited = await tool.callResult("surface.sessions.list", { client: "discord" });
    expect(rateLimited).toMatchObject({
      status: "error",
      error: {
        kind: "unavailable",
        code: "surface_rate_limited",
        retryable: true,
        details: { retryAfterMs: 2_500 },
      },
    });

    adapter.listSessions = async () =>
      Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "list-sessions",
          message: "surface unavailable",
        }),
      );
    const unavailable = await tool.callResult("surface.sessions.list", { client: "discord" });
    expect(unavailable).toMatchObject({
      status: "error",
      error: { kind: "unavailable", code: "surface_unavailable", retryable: true },
    });
  });

  it("preserves a safely projected created ref after partial completion", async () => {
    const adapter: SurfaceAdapter = new FakeAdapter([], {});
    const channelId = "123456789012345678";
    adapter.sendMsg = async () =>
      Result.err(
        new SurfaceOperationPartiallyCompleted({
          platform: "discord",
          operation: "send-message",
          created: { platform: "discord", channelId, messageId: "created-message" },
          message: "message was created before follow-up work failed",
        }),
      );
    const tool = new Surface({
      adapter,
      config: testConfig({
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [channelId],
            allowedGuildIds: [],
            botName: "lilac",
          },
        },
      }),
    });

    const result = await tool.callResult("surface.messages.send", {
      client: "discord",
      sessionId: channelId,
      text: "hello",
    });
    expect(result).toMatchObject({
      status: "error",
      error: {
        kind: "conflict",
        code: "surface_operation_partially_completed",
        retryable: false,
        details: {
          created: { platform: "discord", channelId, messageId: "created-message" },
        },
      },
    });
  });

  it("returns the GitHub adapter's stable unsupported participant output", async () => {
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
      tool.call("surface.sessions.listParticipants", {
        client: "github",
        sessionId: "OWNER/REPO#1",
      }),
    ).rejects.toThrow("GitHub session participant listing is not supported");
  });

  it("returns GitHub attachment unsupported before reading a nonexistent path", async () => {
    const tool = new Surface({ adapter: new FakeAdapter([], {}), config: testConfig({}) });
    const missingPath = join(tmpdir(), `missing-github-attachment-${crypto.randomUUID()}.txt`);

    await expect(
      tool.call("surface.messages.send", {
        client: "github",
        sessionId: "octo/repo#12",
        text: "attachment",
        paths: missingPath,
      }),
    ).rejects.toThrow("GitHub message attachments are not supported");
  });

  it("keeps oversized GitHub paths as a callable schema rejection", async () => {
    const tool = new Surface({ adapter: new FakeAdapter([], {}), config: testConfig({}) });

    await expect(
      tool.call("surface.messages.send", {
        client: "github",
        sessionId: "octo/repo#12",
        text: "attachments",
        paths: Array.from({ length: 11 }, (_, index) => `/missing-${index}.txt`),
      }),
    ).rejects.toThrow("paths");
  });

  it("preserves GitHub reply precedence over an invalid attachment path", async () => {
    const tool = new Surface({ adapter: new FakeAdapter([], {}), config: testConfig({}) });
    const missingPath = join(tmpdir(), `missing-github-reply-${crypto.randomUUID()}.txt`);

    await expect(
      tool.call("surface.messages.send", {
        client: "github",
        sessionId: "octo/repo#12",
        text: "reply",
        replyToMessageId: "345",
        paths: missingPath,
      }),
    ).rejects.toThrow("GitHub message replies are not supported by sendMsg");
  });

  it("marks github surface send comments as agent-authored", async () => {
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

    const calls: Array<Parameters<GithubSurfaceApi["createIssueComment"]>[0]> = [];
    const githubApi: GithubSurfaceApi = {
      getIssue: async () => {
        throw new Error("not implemented");
      },
      listIssueComments: async () => [],
      createIssueComment: async (input) => {
        calls.push(input);
        return { id: 678 };
      },
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
    const tool = new Surface({
      adapter,
      config: cfg,
      githubAdapter: createGithubTestAdapter(githubApi),
    });

    const res = (await tool.call("surface.messages.send", {
      client: "github",
      sessionId: "octo/repo#12",
      text: "hello from lilac",
    })) as { ok: true; ref: { platform: string; messageId: string } };

    expect(res.ok).toBe(true);
    expect(res.ref.platform).toBe("github");
    expect(res.ref.messageId).toBe("678");
    expect(calls).toEqual([
      {
        owner: "octo",
        repo: "repo",
        issueNumber: 12,
        body: `${GITHUB_AGENT_COMMENT_MARKER}\nhello from lilac`,
      },
    ]);
  });

  it("routes GitHub list, edit, and delete through the selected adapter", async () => {
    const listed: Array<Parameters<GithubSurfaceApi["listIssueComments"]>[0]> = [];
    const edited: Array<Parameters<GithubSurfaceApi["editIssueComment"]>[0]> = [];
    const deleted: Array<Parameters<GithubSurfaceApi["deleteIssueComment"]>[0]> = [];
    const githubApi: GithubSurfaceApi = {
      getIssue: async () => {
        throw new Error("not implemented");
      },
      listIssueComments: async (input) => {
        listed.push(input);
        return [
          {
            id: 345,
            body: "existing comment",
            user: { login: "alice", id: 1 },
            created_at: "2020-01-01T00:00:00Z",
          },
        ];
      },
      createIssueComment: async () => ({ id: 0 }),
      getIssueComment: async () => ({ id: 345 }),
      editIssueComment: async (input) => {
        edited.push(input);
      },
      deleteIssueComment: async (input) => {
        deleted.push(input);
      },
      createIssueReaction: async () => ({ id: 0 }),
      createIssueCommentReaction: async () => ({ id: 0 }),
      listIssueReactions: async () => [],
      listIssueCommentReactions: async () => [],
      deleteIssueReactionById: async () => undefined,
      deleteIssueCommentReactionById: async () => undefined,
      getGithubAppSlugOrNull: async () => null,
    };
    const tool = new Surface({
      adapter: new FakeAdapter([], {}),
      githubAdapter: createGithubTestAdapter(githubApi),
      config: testConfig({}),
    });

    const listOutput = (await tool.call("surface.messages.list", {
      client: "github",
      sessionId: "octo/repo#12",
      limit: 5,
    })) as { messages: Array<{ messageId: string; richText: string }> };
    expect(listOutput.messages).toEqual([
      expect.objectContaining({ messageId: "345", richText: "existing comment" }),
    ]);

    expect(
      await tool.call("surface.messages.edit", {
        client: "github",
        sessionId: "octo/repo#12",
        messageId: "345",
        text: "updated comment",
      }),
    ).toEqual({ ok: true });
    expect(
      await tool.call("surface.messages.delete", {
        client: "github",
        sessionId: "octo/repo#12",
        messageId: "345",
      }),
    ).toEqual({ ok: true });

    expect(listed).toEqual([
      { owner: "octo", repo: "repo", number: 12, limit: 5, page: undefined },
    ]);
    expect(edited).toEqual([
      { owner: "octo", repo: "repo", commentId: 345, body: "updated comment" },
    ]);
    expect(deleted).toEqual([{ owner: "octo", repo: "repo", commentId: 345 }]);
  });

  it("passes a non-empty arbitrary GitHub session selector to the GitHub adapter unchanged", async () => {
    const githubAdapter = new FakeAdapter([], {});
    const tool = new Surface({
      adapter: new FakeAdapter([], {}),
      githubAdapter,
      config: testConfig({}),
    });

    await tool.call("surface.messages.list", {
      client: "github",
      sessionId: "arbitrary selector",
    });

    expect(githubAdapter.listCalls).toEqual([
      {
        sessionRef: { platform: "github", channelId: "arbitrary selector" },
        opts: { limit: 50, beforeMessageId: undefined, afterMessageId: undefined },
      },
    ]);
  });

  it("defaults selected GitHub targets from a Discord-form requestId", async () => {
    const githubAdapter = new FakeAdapter([], {});
    const tool = new Surface({
      adapter: new FakeAdapter([], {}),
      githubAdapter,
      config: testConfig({}),
    });

    await tool.call(
      "surface.messages.read",
      { client: "github" },
      {
        context: {
          requestClient: "github",
          requestId: "discord:discord-channel:discord-message",
        },
      },
    );

    expect(githubAdapter.readCalls).toEqual([
      {
        platform: "github",
        channelId: "discord-channel",
        messageId: "discord-message",
      },
    ]);
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
    const tool = new Surface({
      adapter,
      config: cfg,
      githubAdapter: createGithubTestAdapter(githubApi),
    });
    const ctx: RequestContext = {
      requestId: "github:octo/repo#12:345",
      requestClient: "github",
    };

    const msg = (await tool.call("surface.messages.read", {}, { context: ctx })) as {
      meta: { session: { platform: string } };
      message: { messageId: string; richText: string } | null;
    };
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({ owner: "octo", repo: "repo", commentId: 345 });
    expect(msg.meta.session.platform).toBe("github");
    expect(msg.message?.messageId).toBe("345");
    expect(msg.message?.richText).toBe("hello");
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
    const tool = new Surface({
      adapter,
      config: cfg,
      githubAdapter: createGithubTestAdapter(githubApi),
    });
    const ctx: RequestContext = {
      requestId: "github:octo/repo#12:12:deadbeef",
      requestClient: "github",
    };

    const msg = (await tool.call("surface.messages.read", {}, { context: ctx })) as {
      meta: { session: { platform: string } };
      message: { messageId: string; richText: string } | null;
    };
    expect(msg.meta.session.platform).toBe("github");
    expect(msg.message?.messageId).toBe("12");
    expect(msg.message?.richText).toContain("Title: t");
    expect(msg.message?.richText).toContain("b");
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
    const tool = new Surface({
      adapter,
      config: cfg,
      githubAdapter: createGithubTestAdapter(githubApi),
    });

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
    const tool = new Surface({
      adapter,
      config: cfg,
      githubAdapter: createGithubTestAdapter(githubApi),
    });

    const res = await tool.call("surface.reactions.remove", {
      client: "github",
      sessionId: "octo/repo#12",
      messageId: "345",
      reaction: "👍",
    });

    expect((res as any).ok).toBe(true);
    expect(deleted).toEqual([1]);
  });

  it("removes only preferred outbound actor reactions when available", async () => {
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
        { id: 7, content: "+1", user: { login: "octocat", id: 1 } },
        { id: 8, content: "+1", user: { login: "lilac[bot]", id: 2 } },
      ],
      deleteIssueReactionById: async () => undefined,
      deleteIssueCommentReactionById: async ({ reactionId }) => {
        deleted.push(reactionId);
      },
      getGithubAppSlugOrNull: async () => "lilac",
      getPreferredGithubActorLoginOrNull: async () => "octocat",
    };

    const adapter = new FakeAdapter([], {});
    const tool = new Surface({
      adapter,
      config: cfg,
      githubAdapter: createGithubTestAdapter(githubApi),
    });

    const res = await tool.call("surface.reactions.remove", {
      client: "github",
      sessionId: "octo/repo#12",
      messageId: "345",
      reaction: "👍",
    });

    expect((res as any).ok).toBe(true);
    expect(deleted).toEqual([7]);
  });

  it("fails safely when outbound actor login cannot be resolved for github reaction removal", async () => {
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

    let deleteCalls = 0;

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
        { id: 1, content: "+1", user: { login: "someone", id: 2 } },
      ],
      deleteIssueReactionById: async () => {
        deleteCalls += 1;
      },
      deleteIssueCommentReactionById: async () => {
        deleteCalls += 1;
      },
      getGithubAppSlugOrNull: async () => null,
      getPreferredGithubActorLoginOrNull: async () => null,
    };

    const adapter = new FakeAdapter([], {});
    const tool = new Surface({
      adapter,
      config: cfg,
      githubAdapter: createGithubTestAdapter(githubApi),
    });

    await expect(
      tool.call("surface.reactions.remove", {
        client: "github",
        sessionId: "octo/repo#12",
        messageId: "345",
        reaction: "👍",
      }),
    ).rejects.toThrow("Unable to resolve the outbound GitHub actor login");

    expect(deleteCalls).toBe(0);
  });
});

describe("Discord projection parity", () => {
  const top = {
    id: "top",
    url: "https://example.com/top.png",
    filename: "top.png",
    mimeType: "image/png",
    size: 3,
  };
  const envelope = {
    id: "envelope",
    url: "https://example.com/envelope.png",
    filename: "envelope.png",
    mimeType: "image/png",
    size: 4,
  };
  const snapshot = {
    id: "snapshot",
    url: "https://example.com/snapshot.png",
    filename: "snapshot.png",
    mimeType: "image/png",
    size: 5,
  };

  for (const fixture of [
    {
      name: "ordinary replies prefer Discord envelope attachments",
      referenceType: 0,
      snapshots: [snapshot],
      expected: envelope,
    },
    {
      name: "forwards prefer visible snapshot attachments",
      referenceType: 1,
      snapshots: [snapshot],
      expected: snapshot,
    },
    {
      name: "forwards with empty snapshots retain envelope attachments",
      referenceType: 1,
      snapshots: [],
      expected: envelope,
    },
    {
      name: "forwards with malformed snapshot attachments retain envelope attachments",
      referenceType: 1,
      snapshots: [{ url: 4 }],
      expected: envelope,
    },
  ]) {
    it(fixture.name, async () => {
      const channelId = "123";
      const message: SurfaceMessage = {
        ref: { platform: "discord", channelId, messageId: "m1" },
        session: { platform: "discord", channelId },
        userId: "u1",
        text: "message text",
        ts: 1,
        raw: {
          attachments: [top],
          discord: { attachments: [envelope], isChat: true },
          reference: { messageId: "original", channelId, type: fixture.referenceType },
          messageSnapshots: [
            { message: { content: "snapshot text", attachments: fixture.snapshots } },
          ],
        },
      };
      const adapter = new FakeAdapter([], { [channelId]: [message] });
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
      const tool = new Surface({ adapter, config: cfg });
      const listed = (await tool.call("surface.messages.list", {
        client: "discord",
        sessionId: channelId,
        includeAttachments: true,
      })) as {
        messages: Array<{
          attachments: Array<{
            url: string;
            kind: string;
            filename: string;
            mimeType: string;
            size: number;
          }>;
          richText: string;
        }>;
      };
      const reply = toReplyChainMessage(message);
      const store = new DiscordSearchStore(":memory:");
      try {
        store.upsertMessages([message]);
        const indexed = store.getIndexedMessage({ channelId, messageId: "m1" });
        expect(reply.attachments).toEqual([fixture.expected]);
        expect(indexed?.attachments).toEqual([
          {
            id: fixture.expected.id,
            filename: fixture.expected.filename,
            mimeType: fixture.expected.mimeType,
            size: fixture.expected.size,
          },
        ]);
        expect(listed.messages[0]?.attachments).toEqual([
          {
            url: fixture.expected.url,
            filename: fixture.expected.filename,
            mimeType: fixture.expected.mimeType,
            size: fixture.expected.size,
            kind: "image",
          },
        ]);
        expect(listed.messages[0]?.richText).toBe(reply.text);
        expect(indexed?.text).toBe(reply.text);
        expect(reply.replyReference.messageId).toBe(
          fixture.referenceType === 0 ? "original" : undefined,
        );
        expect(adapter.readCalls.length).toBe(fixture.referenceType === 0 ? 1 : 0);
      } finally {
        store.close();
      }
    });
  }
});
