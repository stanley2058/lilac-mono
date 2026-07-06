import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseCoreConfigV1ToUniversal, type CoreConfig } from "@stanley2058/lilac-utils";

import {
  buildThreadSummaryInstructions,
  ConversationThreadService,
  ConversationThreadSummaryParseError,
} from "../../src/conversation/thread-service";
import type { ConversationThreadEmbeddingAdapter } from "../../src/conversation/thread-embedding";
import {
  CONVERSATION_THREAD_SUMMARY_VERSION,
  ConversationThreadStore,
} from "../../src/conversation/thread-store";
import { DiscordSearchStore } from "../../src/surface/store/discord-search-store";
import { DiscordSurfaceStore } from "../../src/surface/store/discord-surface-store";
import type { SurfaceMessage } from "../../src/surface/types";
import { ConversationThread } from "../../src/tool-server/tools/conversation-thread";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createDbPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-thread-test-"));
  tmpDirs.push(dir);
  return path.join(dir, "discord-search.db");
}

function testConfig(): CoreConfig {
  const cfg = parseCoreConfigV1ToUniversal({
    surface: {
      discord: {
        botName: "lilac",
        allowedChannelIds: ["c1"],
      },
    },
  });
  return { ...cfg, agent: { ...cfg.agent, systemPrompt: "(test)" } };
}

function testConfigWithThreadConcurrency(concurrency: number): CoreConfig {
  const cfg = testConfig();
  return {
    ...cfg,
    conversation: {
      ...cfg.conversation,
      thread: {
        ...cfg.conversation.thread,
        summarization: {
          ...cfg.conversation.thread.summarization,
          concurrency,
        },
      },
    },
  };
}

function testConfigWithPromptContext(): CoreConfig {
  const cfg = testConfig();
  return {
    ...cfg,
    conversation: {
      ...cfg.conversation,
      thread: {
        ...cfg.conversation.thread,
        summarization: {
          ...cfg.conversation.thread.summarization,
          includePromptContext: true,
        },
      },
    },
  };
}

async function createDataDirWithPromptContext(input: {
  memory: string;
  user: string;
  entities?: string;
}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-thread-data-test-"));
  tmpDirs.push(dir);
  const promptDir = path.join(dir, "prompts");
  await fs.mkdir(promptDir, { recursive: true });
  await fs.writeFile(path.join(promptDir, "MEMORY.md"), input.memory);
  await fs.writeFile(path.join(promptDir, "USER.md"), input.user);
  if (input.entities !== undefined) {
    await fs.writeFile(path.join(promptDir, "ENTITIES.md"), input.entities);
  }
  return dir;
}

function msg(input: {
  channelId: string;
  guildId?: string;
  parentChannelId?: string;
  messageId: string;
  userId: string;
  userName?: string;
  text: string;
  ts: number;
}): SurfaceMessage {
  return {
    ref: { platform: "discord", channelId: input.channelId, messageId: input.messageId },
    session: {
      platform: "discord",
      channelId: input.channelId,
      guildId: input.guildId,
      parentChannelId: input.parentChannelId,
    },
    userId: input.userId,
    userName: input.userName ?? `user-${input.userId}`,
    text: input.text,
    ts: input.ts,
  };
}

function upsertRelations(
  store: DiscordSurfaceStore,
  messages: Array<{
    messageId: string;
    authorId: string;
    ts: number;
    channelId?: string;
    authorName?: string;
    replyToMessageId?: string;
  }>,
) {
  for (const message of messages) {
    store.upsertMessageRelation({
      channelId: message.channelId ?? "c1",
      messageId: message.messageId,
      authorId: message.authorId,
      authorName: message.authorName,
      ts: message.ts,
      isChat: true,
      replyToMessageId: message.replyToMessageId,
      updatedTs: 1,
    });
  }
}

const fakeEmbeddingAdapter: ConversationThreadEmbeddingAdapter = {
  modelId: "fake-2d",
  dimensions: 2,
  async embed(input) {
    const text = input.text.toLowerCase();
    if (text.includes("banana") || text.includes("yellow fruit")) {
      return new Float32Array([0, 1]);
    }
    return new Float32Array([1, 0]);
  },
};

describe("conversation thread store", () => {
  it("instructs summaries to avoid first-person retrieval hints", () => {
    const instructions = buildThreadSummaryInstructions();
    expect(instructions).toContain("Never use first-person pronouns");
    expect(instructions).toContain("I, me, my, mine, we, us, our, or ours");
    expect(instructions).toContain("Avoid ambiguous pronouns in retrievalHints");
    expect(instructions).toContain("aboutness.userWouldAskForThisAs");
    expect(instructions).toContain("Do not create negative aboutness fields");
  });

  it("groups indexed messages into inferred threads and reads stable membership", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);

    searchStore.upsertMessages([
      msg({ channelId: "c1", messageId: "m1", userId: "u1", text: "memory search idea", ts: 1 }),
      msg({ channelId: "c1", messageId: "m2", userId: "u2", text: "thread summary", ts: 2 }),
      msg({
        channelId: "c1",
        messageId: "m3",
        userId: "u1",
        text: "later unrelated",
        ts: 2 + 2 * 60 * 60 * 1000,
      }),
    ]);

    const refreshed = threadStore.refreshInferredThreads();
    expect(refreshed.threads).toBe(2);

    const first = threadStore.readThread("discord:channel:c1:m1", 0, 10);
    expect(first?.messages.map((item) => item.messageId)).toEqual(["m1", "m2"]);

    const second = threadStore.readThread("discord:channel:c1:m3", 0, 10);
    expect(second?.messages.map((item) => item.messageId)).toEqual(["m3"]);

    searchStore.close();
    threadStore.close();
  });

  it("uses active !cont as a forward thread merge across natural groups", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    const hour = 60 * 60 * 1000;

    searchStore.upsertMessages([
      msg({ channelId: "c1", messageId: "a", userId: "u1", text: "A", ts: 0 }),
      msg({ channelId: "c1", messageId: "b", userId: "u2", text: "B", ts: 1 }),
      msg({
        channelId: "c1",
        messageId: "d",
        userId: "u1",
        text: "@lilac !cont=2 D",
        ts: 2 * hour,
      }),
      msg({ channelId: "c1", messageId: "e", userId: "u2", text: "E", ts: 2 * hour + 1 }),
    ]);

    const refreshed = threadStore.refreshInferredThreads({ cfg: testConfig() });
    expect(refreshed.threads).toBe(1);
    expect(
      threadStore.readThread("discord:channel:c1:a", 0, 10)?.messages.map((item) => item.messageId),
    ).toEqual(["a", "b", "d", "e"]);

    searchStore.close();
    threadStore.close();
  });

  it("lets active !cont merge every natural group touched by the requested lookback", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    const hour = 60 * 60 * 1000;

    searchStore.upsertMessages([
      msg({ channelId: "c1", messageId: "a", userId: "u1", text: "A", ts: 0 }),
      msg({ channelId: "c1", messageId: "b", userId: "u2", text: "B", ts: 1 }),
      msg({ channelId: "c1", messageId: "c", userId: "u1", text: "C", ts: 2 * hour }),
      msg({ channelId: "c1", messageId: "d", userId: "u2", text: "D", ts: 2 * hour + 1 }),
      msg({ channelId: "c1", messageId: "e", userId: "u1", text: "!cont=3 E", ts: 4 * hour }),
    ]);

    const refreshed = threadStore.refreshInferredThreads({ cfg: testConfig() });
    expect(refreshed.threads).toBe(1);
    expect(
      threadStore.readThread("discord:channel:c1:a", 0, 10)?.messages.map((item) => item.messageId),
    ).toEqual(["a", "b", "c", "d", "e"]);

    searchStore.close();
    threadStore.close();
  });

  it("keeps active natural groups split across long gaps without !cont", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    const hour = 60 * 60 * 1000;

    searchStore.upsertMessages([
      msg({ channelId: "c1", messageId: "a", userId: "u1", text: "A", ts: 0 }),
      msg({ channelId: "c1", messageId: "b", userId: "u2", text: "B", ts: 1 }),
      msg({ channelId: "c1", messageId: "c", userId: "u1", text: "C", ts: 2 * hour }),
      msg({ channelId: "c1", messageId: "d", userId: "u2", text: "D", ts: 2 * hour + 1 }),
      msg({ channelId: "c1", messageId: "e", userId: "u1", text: "E", ts: 4 * hour }),
    ]);

    const refreshed = threadStore.refreshInferredThreads({ cfg: testConfig() });
    expect(refreshed.threads).toBe(3);
    expect(
      threadStore.readThread("discord:channel:c1:a", 0, 10)?.messages.map((item) => item.messageId),
    ).toEqual(["a", "b"]);
    expect(
      threadStore.readThread("discord:channel:c1:c", 0, 10)?.messages.map((item) => item.messageId),
    ).toEqual(["c", "d"]);
    expect(
      threadStore.readThread("discord:channel:c1:e", 0, 10)?.messages.map((item) => item.messageId),
    ).toEqual(["e"]);

    searchStore.close();
    threadStore.close();
  });

  it("does not let active !cont cross a session divider", async () => {
    const searchDbPath = await createDbPath();
    const surfaceDbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(searchDbPath);
    const surfaceStore = new DiscordSurfaceStore(surfaceDbPath);
    const threadStore = new ConversationThreadStore(searchDbPath, { surfaceDbPath });
    const hour = 60 * 60 * 1000;

    searchStore.upsertMessages([
      msg({ channelId: "c1", messageId: "a", userId: "u1", text: "A", ts: 0 }),
      msg({ channelId: "c1", messageId: "b", userId: "u2", text: "B", ts: 1 }),
      msg({
        channelId: "c1",
        messageId: "divider",
        userId: "bot",
        userName: "lilac",
        text: "[LILAC_SESSION_DIVIDER] (by user)",
        ts: hour,
      }),
      msg({ channelId: "c1", messageId: "d", userId: "u1", text: "!cont=3 D", ts: 2 * hour }),
      msg({ channelId: "c1", messageId: "e", userId: "u2", text: "E", ts: 2 * hour + 1 }),
    ]);
    upsertRelations(surfaceStore, [
      { messageId: "a", authorId: "u1", ts: 0 },
      { messageId: "b", authorId: "u2", ts: 1 },
      { messageId: "divider", authorId: "bot", authorName: "lilac", ts: hour },
      { messageId: "d", authorId: "u1", ts: 2 * hour },
      { messageId: "e", authorId: "u2", ts: 2 * hour + 1 },
    ]);

    const refreshed = threadStore.refreshInferredThreads({ cfg: testConfig() });
    expect(refreshed.threads).toBe(2);
    expect(
      threadStore.readThread("discord:channel:c1:a", 0, 10)?.messages.map((item) => item.messageId),
    ).toEqual(["a", "b"]);
    expect(
      threadStore.readThread("discord:channel:c1:d", 0, 10)?.messages.map((item) => item.messageId),
    ).toEqual(["d", "e"]);

    searchStore.close();
    surfaceStore.close();
    threadStore.close();
  });

  it("ignores active !cont semantics on reply messages while preserving reply grouping", async () => {
    const searchDbPath = await createDbPath();
    const surfaceDbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(searchDbPath);
    const surfaceStore = new DiscordSurfaceStore(surfaceDbPath);
    const threadStore = new ConversationThreadStore(searchDbPath, { surfaceDbPath });
    const hour = 60 * 60 * 1000;

    searchStore.upsertMessages([
      msg({ channelId: "c1", messageId: "a", userId: "u1", text: "A", ts: 0 }),
      msg({ channelId: "c1", messageId: "b", userId: "u2", text: "B", ts: 1 }),
      msg({ channelId: "c1", messageId: "c", userId: "u1", text: "C", ts: 2 * hour }),
      msg({ channelId: "c1", messageId: "d", userId: "u2", text: "D", ts: 2 * hour + 1 }),
      msg({ channelId: "c1", messageId: "e", userId: "u1", text: "!cont=3 E", ts: 4 * hour }),
    ]);
    upsertRelations(surfaceStore, [
      { messageId: "a", authorId: "u1", ts: 0 },
      { messageId: "b", authorId: "u2", ts: 1 },
      { messageId: "c", authorId: "u1", ts: 2 * hour },
      { messageId: "d", authorId: "u2", ts: 2 * hour + 1 },
      { messageId: "e", authorId: "u1", ts: 4 * hour, replyToMessageId: "c" },
    ]);

    const refreshed = threadStore.refreshInferredThreads({ cfg: testConfig() });
    expect(refreshed.threads).toBe(2);
    expect(
      threadStore.readThread("discord:channel:c1:a", 0, 10)?.messages.map((item) => item.messageId),
    ).toEqual(["a", "b"]);
    expect(
      threadStore.readThread("discord:channel:c1:c", 0, 10)?.messages.map((item) => item.messageId),
    ).toEqual(["c", "d", "e"]);

    searchStore.close();
    surfaceStore.close();
    threadStore.close();
  });

  it("ignores active !cont semantics on main-agent messages", async () => {
    const searchDbPath = await createDbPath();
    const surfaceDbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(searchDbPath);
    const surfaceStore = new DiscordSurfaceStore(surfaceDbPath);
    const threadStore = new ConversationThreadStore(searchDbPath, {
      surfaceDbPath,
      mainAgentUserNames: ["lilac"],
    });
    const hour = 60 * 60 * 1000;

    searchStore.upsertMessages([
      msg({
        channelId: "c1",
        messageId: "a",
        userId: "bot",
        userName: "lilac",
        text: "A",
        ts: 0,
      }),
      msg({ channelId: "c1", messageId: "b", userId: "u1", text: "B", ts: 1 }),
      msg({
        channelId: "c1",
        messageId: "c",
        userId: "bot",
        userName: "lilac",
        text: "!cont=2 literal example",
        ts: 2 * hour,
      }),
    ]);
    upsertRelations(surfaceStore, [
      { messageId: "a", authorId: "bot", authorName: "lilac", ts: 0 },
      { messageId: "b", authorId: "u1", ts: 1 },
      { messageId: "c", authorId: "bot", authorName: "lilac", ts: 2 * hour },
    ]);

    const refreshed = threadStore.refreshInferredThreads({ cfg: testConfig() });
    expect(refreshed.threads).toBe(2);
    expect(
      threadStore.readThread("discord:channel:c1:a", 0, 10)?.messages.map((item) => item.messageId),
    ).toEqual(["a", "b"]);
    expect(
      threadStore.readThread("discord:channel:c1:c", 0, 10)?.messages.map((item) => item.messageId),
    ).toEqual(["c"]);

    searchStore.close();
    surfaceStore.close();
    threadStore.close();
  });

  it("strips !cont directives from conversation thread reads and summarization input", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    let summarizedTexts: string[] = [];

    searchStore.upsertMessages([
      msg({ channelId: "c1", messageId: "a", userId: "u1", text: "A", ts: 0 }),
      msg({ channelId: "c1", messageId: "b", userId: "u2", text: "@lilac !cont=1 resume", ts: 1 }),
      msg({
        channelId: "c1",
        messageId: "c",
        userId: "bot",
        userName: "lilac",
        text: "!cont=2 literal example",
        ts: 2,
      }),
    ]);

    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfig(),
      summarizer: async ({ messages }) => {
        summarizedTexts = messages.map((message) => message.text);
        return {
          title: "stripped",
          brief: "stripped",
          topics: [],
        };
      },
    });

    await service.runSummarization({ now: Date.now() + 2 * 60 * 60 * 1000 });
    const read = await service.read({ threadId: "discord:channel:c1:a" });

    expect(summarizedTexts).toEqual(["A", "@lilac resume", "!cont=2 literal example"]);
    expect(read.messages.map((message) => message.content)).toEqual([
      "A",
      "@lilac resume",
      "!cont=2 literal example",
    ]);

    searchStore.close();
    threadStore.close();
  });

  it("treats LILAC_SESSION_DIVIDER as an inferred thread boundary", async () => {
    const searchDbPath = await createDbPath();
    const surfaceDbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(searchDbPath);
    const surfaceStore = new DiscordSurfaceStore(surfaceDbPath);
    const threadStore = new ConversationThreadStore(searchDbPath, {
      surfaceDbPath,
      mainAgentUserNames: ["lilac"],
    });

    surfaceStore.upsertSession({
      channelId: "c1",
      type: "channel",
      updatedTs: 1,
    });

    searchStore.upsertMessages([
      msg({ channelId: "c1", messageId: "m1", userId: "u1", text: "before", ts: 1 }),
      msg({
        channelId: "c1",
        messageId: "m2",
        userId: "bot",
        userName: "lilac",
        text: "before reply",
        ts: 2,
      }),
      msg({
        channelId: "c1",
        messageId: "divider",
        userId: "bot",
        userName: "lilac",
        text: "[LILAC_SESSION_DIVIDER] (by user)",
        ts: 3,
      }),
      msg({ channelId: "c1", messageId: "m3", userId: "u1", text: "after", ts: 4 }),
      msg({
        channelId: "c1",
        messageId: "m4",
        userId: "bot",
        userName: "lilac",
        text: "after reply",
        ts: 5,
      }),
    ]);

    for (const message of [
      { messageId: "m1", authorId: "u1", ts: 1 },
      { messageId: "m2", authorId: "bot", ts: 2 },
      { messageId: "divider", authorId: "bot", ts: 3 },
      { messageId: "m3", authorId: "u1", ts: 4 },
      { messageId: "m4", authorId: "bot", ts: 5 },
    ]) {
      surfaceStore.upsertMessageRelation({
        channelId: "c1",
        messageId: message.messageId,
        authorId: message.authorId,
        ts: message.ts,
        isChat: true,
        updatedTs: 1,
      });
    }

    const refreshed = threadStore.refreshInferredThreads();
    expect(refreshed.threads).toBe(2);

    const before = threadStore.readThread("discord:channel:c1:m1", 0, 10);
    expect(before?.messages.map((item) => item.messageId)).toEqual(["m1", "m2"]);

    const after = threadStore.readThread("discord:channel:c1:m3", 0, 10);
    expect(after?.messages.map((item) => item.messageId)).toEqual(["m3", "m4"]);
    expect(threadStore.readThread("discord:channel:c1:divider", 0, 10)).toBeNull();

    searchStore.close();
    surfaceStore.close();
    threadStore.close();
  });

  it("does not make earlier active-gap threads stale after identical heal upserts", async () => {
    const originalDateNow = Date.now;
    let now = 1_000;
    Date.now = () => now;

    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    const oneHour = 60 * 60 * 1000;
    const messages = [
      msg({ channelId: "c1", messageId: "old-1", userId: "u1", text: "old topic", ts: 1 }),
      msg({ channelId: "c1", messageId: "old-2", userId: "u2", text: "old reply", ts: 2 }),
      msg({
        channelId: "c1",
        messageId: "new-1",
        userId: "u1",
        text: "new topic",
        ts: 2 * oneHour,
      }),
      msg({
        channelId: "c1",
        messageId: "new-2",
        userId: "u2",
        text: "new reply",
        ts: 2 * oneHour + 1,
      }),
    ];

    try {
      searchStore.upsertMessages(messages);
      const service = new ConversationThreadService({
        store: threadStore,
        getConfig: async () => testConfig(),
        summarizer: async ({ threadId }) => ({
          title: threadId,
          brief: threadId,
          topics: [],
          retrievalHints: [],
        }),
      });

      const eligibleNow = 4 * oneHour;
      expect((await service.runSummarization({ now: eligibleNow })).summarized).toBe(2);

      now = 2_000;
      searchStore.upsertMessages([
        ...messages,
        msg({
          channelId: "c1",
          messageId: "new-3",
          userId: "u3",
          text: "new follow-up",
          ts: 2 * oneHour + 2,
        }),
      ]);
      threadStore.refreshInferredThreads({ cfg: testConfig() });

      const eligible = threadStore.listEligibleForSummarization({ now: eligibleNow });
      expect(eligible.map((thread) => thread.thread_id)).toEqual(["discord:channel:c1:new-1"]);
      expect(threadStore.readThread("discord:channel:c1:old-1")?.summary?.title).toBe(
        "discord:channel:c1:old-1",
      );
    } finally {
      searchStore.close();
      threadStore.close();
      Date.now = originalDateNow;
    }
  });

  it("only forms threads that include the main agent when configured", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath, { mainAgentUserNames: ["agent"] });
    searchStore.upsertMessages([
      msg({ channelId: "c1", messageId: "h1", userId: "u1", text: "human only", ts: 1 }),
      msg({ channelId: "c1", messageId: "h2", userId: "u2", text: "human reply", ts: 2 }),
      msg({
        channelId: "c2",
        messageId: "a1",
        userId: "u1",
        text: "human asks agent",
        ts: 1,
      }),
      msg({
        channelId: "c2",
        messageId: "a2",
        userId: "bot",
        userName: "agent",
        text: "agent answers",
        ts: 2,
      }),
    ]);

    const refreshed = threadStore.refreshInferredThreads();
    expect(refreshed.threads).toBe(1);
    expect(threadStore.readThread("discord:channel:c1:h1", 0, 10)).toBeNull();
    expect(threadStore.readThread("discord:channel:c2:a1", 0, 10)?.messages).toHaveLength(2);

    searchStore.close();
    threadStore.close();
  });

  it("treats old never-summarized backfill threads as eligible immediately", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    searchStore.upsertMessages([
      msg({
        channelId: "c1",
        messageId: "old-1",
        userId: "u1",
        text: "old architecture discussion",
        ts: 1,
      }),
      msg({
        channelId: "c1",
        messageId: "old-2",
        userId: "u2",
        text: "old architecture follow-up",
        ts: 2,
      }),
    ]);

    threadStore.refreshInferredThreads();
    const eligible = threadStore.listEligibleForSummarization({ now: Date.now() });
    expect(eligible.map((thread) => thread.thread_id)).toEqual(["discord:channel:c1:old-1"]);

    searchStore.close();
    threadStore.close();
  });

  it("does not consider one-message threads eligible for summarization", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    searchStore.upsertMessages([
      msg({
        channelId: "c1",
        messageId: "solo",
        userId: "u1",
        text: "single message thread",
        ts: 1,
      }),
    ]);

    threadStore.refreshInferredThreads();
    expect(threadStore.listEligibleForSummarization({ now: Date.now() })).toEqual([]);

    searchStore.close();
    threadStore.close();
  });

  it("infers conversation chunks inside native Discord threads and follows reply relations", async () => {
    const searchDbPath = await createDbPath();
    const surfaceDbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(searchDbPath);
    const surfaceStore = new DiscordSurfaceStore(surfaceDbPath);
    const threadStore = new ConversationThreadStore(searchDbPath, { surfaceDbPath });

    surfaceStore.upsertSession({
      channelId: "c1",
      guildId: "g1",
      type: "channel",
      updatedTs: 1,
    });
    surfaceStore.upsertSession({
      channelId: "th1",
      guildId: "g1",
      parentChannelId: "c1",
      type: "thread",
      updatedTs: 1,
    });

    searchStore.upsertMessages([
      msg({
        channelId: "c1",
        guildId: "g1",
        messageId: "m1",
        userId: "u1",
        text: "old root",
        ts: 1,
      }),
      msg({
        channelId: "c1",
        guildId: "g1",
        messageId: "m2",
        userId: "u2",
        text: "late reply",
        ts: 3 * 60 * 60 * 1000,
      }),
      msg({
        channelId: "c1",
        guildId: "g1",
        messageId: "m3",
        userId: "u3",
        text: "unrelated much later",
        ts: 6 * 60 * 60 * 1000,
      }),
      msg({
        channelId: "th1",
        guildId: "g1",
        parentChannelId: "c1",
        messageId: "t1",
        userId: "u1",
        text: "thread opening",
        ts: 10,
      }),
      msg({
        channelId: "th1",
        guildId: "g1",
        parentChannelId: "c1",
        messageId: "t2",
        userId: "u2",
        text: "thread reply",
        ts: 11,
      }),
      msg({
        channelId: "th1",
        guildId: "g1",
        parentChannelId: "c1",
        messageId: "t3",
        userId: "u1",
        text: "later thread topic",
        ts: 2 * 60 * 60 * 1000,
      }),
      msg({
        channelId: "th1",
        guildId: "g1",
        parentChannelId: "c1",
        messageId: "t4",
        userId: "u2",
        text: "later thread reply",
        ts: 2 * 60 * 60 * 1000 + 1,
      }),
    ]);

    for (const message of [
      { channelId: "c1", messageId: "m1", authorId: "u1", ts: 1 },
      {
        channelId: "c1",
        messageId: "m2",
        authorId: "u2",
        ts: 3 * 60 * 60 * 1000,
        replyToMessageId: "m1",
      },
      { channelId: "c1", messageId: "m3", authorId: "u3", ts: 6 * 60 * 60 * 1000 },
      { channelId: "th1", messageId: "t1", authorId: "u1", ts: 10 },
      { channelId: "th1", messageId: "t2", authorId: "u2", ts: 11 },
      { channelId: "th1", messageId: "t3", authorId: "u1", ts: 2 * 60 * 60 * 1000 },
      { channelId: "th1", messageId: "t4", authorId: "u2", ts: 2 * 60 * 60 * 1000 + 1 },
    ]) {
      surfaceStore.upsertMessageRelation({
        channelId: message.channelId,
        messageId: message.messageId,
        guildId: "g1",
        authorId: message.authorId,
        ts: message.ts,
        isChat: true,
        replyToMessageId: message.replyToMessageId,
        updatedTs: 1,
      });
    }

    const refreshed = threadStore.refreshInferredThreads();
    expect(refreshed.threads).toBe(4);

    const nativeFirst = threadStore.readThread("discord:channel:th1:t1", 0, 10);
    expect(nativeFirst?.thread.kind).toBe("inferred_channel_thread");
    expect(nativeFirst?.thread.parent_channel_id).toBe("c1");
    expect(nativeFirst?.messages.map((item) => item.messageId)).toEqual(["t1", "t2"]);

    const nativeSecond = threadStore.readThread("discord:channel:th1:t3", 0, 10);
    expect(nativeSecond?.thread.kind).toBe("inferred_channel_thread");
    expect(nativeSecond?.thread.parent_channel_id).toBe("c1");
    expect(nativeSecond?.messages.map((item) => item.messageId)).toEqual(["t3", "t4"]);

    const replied = threadStore.readThread("discord:channel:c1:m1", 0, 10);
    expect(replied?.messages.map((item) => item.messageId)).toEqual(["m1", "m2"]);

    const unrelated = threadStore.readThread("discord:channel:c1:m3", 0, 10);
    expect(unrelated?.messages.map((item) => item.messageId)).toEqual(["m3"]);

    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfig(),
      summarizer: async ({ threadId }) => ({
        title: threadId === "discord:channel:th1:t1" ? "Native parent thread" : "Other thread",
        brief: threadId === "discord:channel:th1:t1" ? "native parent allowlist" : "other thread",
        topics: [],
      }),
    });
    await service.runSummarization({ now: Date.now() + 7 * 60 * 60 * 1000 });
    const allowedByParent = await service.read({ threadId: "discord:channel:th1:t1" });
    expect(allowedByParent.thread.session.parentChannelId).toBe("c1");

    searchStore.close();
    surfaceStore.close();
    threadStore.close();
  });

  it("uses mention-mode reply-chain grouping inside native Discord threads", async () => {
    const searchDbPath = await createDbPath();
    const surfaceDbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(searchDbPath);
    const surfaceStore = new DiscordSurfaceStore(surfaceDbPath);
    const threadStore = new ConversationThreadStore(searchDbPath, { surfaceDbPath });
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["parent-channel"],
        },
        router: {
          defaultMode: "active",
          sessionModes: {
            "parent-channel": { mode: "mention" },
          },
        },
      },
    });

    surfaceStore.upsertSession({
      channelId: "parent-channel",
      guildId: "guild-1",
      type: "channel",
      updatedTs: 1,
    });
    surfaceStore.upsertSession({
      channelId: "thread-channel",
      guildId: "guild-1",
      parentChannelId: "parent-channel",
      type: "thread",
      updatedTs: 1,
    });

    searchStore.upsertMessages([
      msg({
        channelId: "thread-channel",
        guildId: "guild-1",
        parentChannelId: "parent-channel",
        messageId: "a0",
        userId: "user-a",
        text: "first topic preface",
        ts: 500,
      }),
      msg({
        channelId: "thread-channel",
        guildId: "guild-1",
        parentChannelId: "parent-channel",
        messageId: "a1",
        userId: "user-a",
        text: "first topic question",
        ts: 1_000,
      }),
      msg({
        channelId: "thread-channel",
        guildId: "guild-1",
        parentChannelId: "parent-channel",
        messageId: "a2",
        userId: "bot",
        userName: "lilac",
        text: "first topic answer",
        ts: 2_000,
      }),
      msg({
        channelId: "thread-channel",
        guildId: "guild-1",
        parentChannelId: "parent-channel",
        messageId: "b1",
        userId: "user-b",
        text: "second topic question",
        ts: 3_000,
      }),
      msg({
        channelId: "thread-channel",
        guildId: "guild-1",
        parentChannelId: "parent-channel",
        messageId: "b2",
        userId: "bot",
        userName: "lilac",
        text: "second topic answer",
        ts: 4_000,
      }),
    ]);

    for (const message of [
      { messageId: "a0", authorId: "user-a", ts: 500 },
      { messageId: "a1", authorId: "user-a", ts: 1_000 },
      { messageId: "a2", authorId: "bot", ts: 2_000, replyToMessageId: "a1" },
      { messageId: "b1", authorId: "user-b", ts: 3_000 },
      { messageId: "b2", authorId: "bot", ts: 4_000, replyToMessageId: "b1" },
    ]) {
      surfaceStore.upsertMessageRelation({
        channelId: "thread-channel",
        messageId: message.messageId,
        guildId: "guild-1",
        authorId: message.authorId,
        ts: message.ts,
        isChat: true,
        replyToMessageId: message.replyToMessageId,
        updatedTs: 1,
      });
    }

    const refreshed = threadStore.refreshInferredThreads({ cfg });
    expect(refreshed.threads).toBe(2);

    const first = threadStore.readThread("discord:channel:thread-channel:a0", 0, 10);
    expect(first?.thread.parent_channel_id).toBe("parent-channel");
    expect(first?.messages.map((item) => item.messageId)).toEqual(["a0", "a1", "a2"]);

    const second = threadStore.readThread("discord:channel:thread-channel:b1", 0, 10);
    expect(second?.thread.parent_channel_id).toBe("parent-channel");
    expect(second?.messages.map((item) => item.messageId)).toEqual(["b1", "b2"]);

    searchStore.close();
    surfaceStore.close();
    threadStore.close();
  });

  it("summarizes, searches, and reads through conversation.thread tools", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    searchStore.upsertMessages([
      msg({
        channelId: "c1",
        messageId: "m1",
        userId: "u1",
        text: "we discussed vector search for memory",
        ts: 1,
      }),
      msg({
        channelId: "c1",
        messageId: "m2",
        userId: "u2",
        text: "sqlite vec can back thread embeddings",
        ts: 2,
      }),
    ]);

    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfig(),
      summarizer: async () => ({
        title: "Memory search architecture",
        brief:
          "Discussion about retrieving prior conversations with thread summaries and vector search.",
        topics: ["memory retrieval", "thread summaries", "vector search"],
        retrievalHints: ["conversation memory retrieval architecture"],
        aboutness: {
          domains: ["conversation memory"],
          situations: ["thread retrieval architecture planning"],
          complaintTargets: [],
          entities: ["sqlite-vec"],
          userWouldAskForThisAs: ["conversation thread search design"],
        },
        importance: "high",
        importanceReasons: ["Captures reusable architecture decisions for conversation retrieval."],
      }),
    });
    const tool = new ConversationThread({ service });

    const eligibleNow = Date.now() + 2 * 60 * 60 * 1000;
    const dryRun = await service.runSummarization({ dryRun: true, now: eligibleNow });
    expect(dryRun.eligible).toBe(1);
    expect(dryRun.summarized).toBe(0);

    const run = await service.runSummarization({ now: eligibleNow });
    expect(run.summarized).toBe(1);

    const compactSearch = (await tool.call("conversation.thread.search", {
      query: "vector retrieval",
    })) as {
      results: Array<{
        threadId: string;
        title: string;
        brief: string;
      }>;
    };
    expect(Object.keys(compactSearch.results[0] ?? {}).sort()).toEqual([
      "brief",
      "threadId",
      "title",
    ]);
    expect(compactSearch.results[0]?.title).toBe("Memory search architecture");

    const search = (await tool.call("conversation.thread.search", {
      query: "vector retrieval",
      verbose: true,
    })) as {
      results: Array<{
        threadId: string;
        title: string;
        retrievalHints: string[];
        aboutness: { userWouldAskForThisAs: string[] };
        importance: string;
        importanceReasons: string[];
      }>;
    };
    expect(search.results[0]?.title).toBe("Memory search architecture");
    expect(search.results[0]?.retrievalHints).toEqual([
      "conversation memory retrieval architecture",
    ]);
    expect(search.results[0]?.aboutness.userWouldAskForThisAs).toEqual([
      "conversation thread search design",
    ]);
    expect(search.results[0]?.importance).toBe("high");
    expect(search.results[0]?.importanceReasons).toEqual([
      "Captures reusable architecture decisions for conversation retrieval.",
    ]);

    const metadata = (await tool.call("conversation.thread.metadata", {
      threadIds: [search.results[0]!.threadId, "missing-thread"],
    })) as {
      threads: Array<{
        threadId: string;
        title?: string;
        brief?: string;
        retrievalHints?: string[];
        aboutness?: { domains: string[] };
        importance?: string;
        importanceReasons?: string[];
        messageCount: number;
        messages?: unknown;
      }>;
      missing: string[];
    };
    expect(metadata.missing).toEqual(["missing-thread"]);
    expect(metadata.threads).toHaveLength(1);
    expect(metadata.threads[0]?.title).toBe("Memory search architecture");
    expect(metadata.threads[0]?.brief).toBe(
      "Discussion about retrieving prior conversations with thread summaries and vector search.",
    );
    expect(metadata.threads[0]?.retrievalHints).toEqual([
      "conversation memory retrieval architecture",
    ]);
    expect(metadata.threads[0]?.aboutness?.domains).toEqual(["conversation memory"]);
    expect(metadata.threads[0]?.importance).toBe("high");
    expect(metadata.threads[0]?.importanceReasons).toEqual([
      "Captures reusable architecture decisions for conversation retrieval.",
    ]);
    expect(metadata.threads[0]?.messageCount).toBe(2);
    expect(metadata.threads[0]?.messages).toBeUndefined();

    const read = (await tool.call("conversation.thread.read", {
      threadId: search.results[0]!.threadId,
      offset: 1,
      limit: 1,
    })) as {
      thread: {
        retrievalHints?: string[];
        aboutness?: { domains: string[] };
        importance?: string;
        importanceReasons?: string[];
      };
      page: { total: number; hasMore: boolean };
      messages: Array<{ messageId: string; content: string; text?: string }>;
    };
    expect(read.thread.retrievalHints).toEqual(["conversation memory retrieval architecture"]);
    expect(read.thread.aboutness?.domains).toEqual(["conversation memory"]);
    expect(read.thread.importance).toBe("high");
    expect(read.page.total).toBe(2);
    expect(read.page.hasMore).toBe(false);
    expect(read.messages.map((item) => item.messageId)).toEqual(["m2"]);
    expect(read.messages[0]?.content).toBe("sqlite vec can back thread embeddings");
    expect(read.messages[0]?.text).toBeUndefined();

    const entries = await tool.list();
    const searchEntry = entries.find((item) => item.callableId === "conversation.thread.search");
    expect(searchEntry?.primaryPositional).toEqual({ field: "query", variadic: true });
    const metadataEntry = entries.find(
      (item) => item.callableId === "conversation.thread.metadata",
    );
    expect(metadataEntry?.primaryPositional).toEqual({ field: "threadIds", variadic: true });
    const readEntry = entries.find((item) => item.callableId === "conversation.thread.read");
    expect(readEntry?.primaryPositional).toEqual({ field: "threadId" });
    const entry = entries.find(
      (item) => item.callableId === "conversation.thread.runSummarization",
    );
    expect(entry?.hidden).toBe(true);

    await expect(
      tool.call("conversation.thread.read", {
        offset: 0,
      }),
    ).rejects.toThrow("conversation.thread.read has invalid input.");
    await expect(tool.call("conversation.thread.metadata", {})).rejects.toThrow(
      "conversation.thread.metadata has invalid input.",
    );

    searchStore.close();
    threadStore.close();
  });

  it("aborts summarization run after first summarizer failure", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    searchStore.upsertMessages([
      msg({
        channelId: "c1",
        messageId: "a1",
        userId: "u1",
        text: "first eligible thread",
        ts: 1,
      }),
      msg({
        channelId: "c1",
        messageId: "a2",
        userId: "u2",
        text: "first eligible reply",
        ts: 2,
      }),
      msg({
        channelId: "c1",
        messageId: "b1",
        userId: "u1",
        text: "second eligible thread",
        ts: 2 * 60 * 60 * 1000,
      }),
      msg({
        channelId: "c1",
        messageId: "b2",
        userId: "u2",
        text: "second eligible reply",
        ts: 2 * 60 * 60 * 1000 + 1,
      }),
    ]);

    const attemptedThreadIds: string[] = [];
    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfig(),
      summarizer: async ({ threadId }) => {
        attemptedThreadIds.push(threadId);
        throw new Error("model rejected request");
      },
    });

    await expect(
      service.runSummarization({ now: Date.now() + 3 * 60 * 60 * 1000 }),
    ).rejects.toThrow("thread summarization aborted after failure");
    expect(attemptedThreadIds).toEqual(["discord:channel:c1:a1"]);

    searchStore.close();
    threadStore.close();
  });

  it("continues summarization after sqlite busy failures", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    searchStore.upsertMessages([
      msg({
        channelId: "c1",
        messageId: "busy-a1",
        userId: "u1",
        text: "first eligible thread",
        ts: 1,
      }),
      msg({
        channelId: "c1",
        messageId: "busy-a2",
        userId: "u2",
        text: "first eligible reply",
        ts: 2,
      }),
      msg({
        channelId: "c1",
        messageId: "busy-b1",
        userId: "u1",
        text: "second eligible thread",
        ts: 2 * 60 * 60 * 1000,
      }),
      msg({
        channelId: "c1",
        messageId: "busy-b2",
        userId: "u2",
        text: "second eligible reply",
        ts: 2 * 60 * 60 * 1000 + 1,
      }),
    ]);

    const attemptedThreadIds: string[] = [];
    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfig(),
      summarizer: async ({ threadId }) => {
        attemptedThreadIds.push(threadId);
        if (threadId === "discord:channel:c1:busy-a1") {
          throw new Error("SQLITE_BUSY: database is locked");
        }
        return {
          title: threadId,
          brief: threadId,
          topics: [],
          retrievalHints: [],
        };
      },
    });

    const run = await service.runSummarization({ now: Date.now() + 3 * 60 * 60 * 1000 });
    expect(run.failed).toBe(1);
    expect(run.summarized).toBe(1);
    expect(run.failures[0]?.threadId).toBe("discord:channel:c1:busy-a1");
    expect(attemptedThreadIds).toEqual([
      "discord:channel:c1:busy-a1",
      "discord:channel:c1:busy-b1",
    ]);
    expect(threadStore.readThread("discord:channel:c1:busy-b1")?.summary?.title).toBe(
      "discord:channel:c1:busy-b1",
    );

    searchStore.close();
    threadStore.close();
  });

  it("retries parse failures without aborting the summarization run", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    searchStore.upsertMessages([
      msg({
        channelId: "c1",
        messageId: "a1",
        userId: "u1",
        text: "first parse failure thread",
        ts: 1,
      }),
      msg({
        channelId: "c1",
        messageId: "a2",
        userId: "u2",
        text: "first parse failure reply",
        ts: 2,
      }),
      msg({
        channelId: "c1",
        messageId: "b1",
        userId: "u1",
        text: "second successful thread",
        ts: 2 * 60 * 60 * 1000,
      }),
      msg({
        channelId: "c1",
        messageId: "b2",
        userId: "u2",
        text: "second successful reply",
        ts: 2 * 60 * 60 * 1000 + 1,
      }),
    ]);

    const attemptedThreadIds: string[] = [];
    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfig(),
      summarizer: async ({ threadId }) => {
        attemptedThreadIds.push(threadId);
        if (threadId === "discord:channel:c1:a1") {
          throw new ConversationThreadSummaryParseError("JSON Parse error: Unterminated string");
        }
        return {
          title: "Recovered thread",
          brief: "The run continued after a parse failure.",
          topics: [],
        };
      },
    });

    const run = await service.runSummarization({ now: Date.now() + 3 * 60 * 60 * 1000 });
    expect(run.failed).toBe(1);
    expect(run.summarized).toBe(1);
    expect(run.failures[0]?.threadId).toBe("discord:channel:c1:a1");
    expect(attemptedThreadIds).toEqual([
      "discord:channel:c1:a1",
      "discord:channel:c1:a1",
      "discord:channel:c1:a1",
      "discord:channel:c1:b1",
    ]);

    searchStore.close();
    threadStore.close();
  });

  it("uses configured summarization concurrency", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    searchStore.upsertMessages(
      Array.from({ length: 4 }, (_, index) => [
        msg({
          channelId: "c1",
          messageId: `c${index}-1`,
          userId: "u1",
          text: `concurrent thread ${index} start`,
          ts: index * 2 * 60 * 60 * 1000 + 1,
        }),
        msg({
          channelId: "c1",
          messageId: `c${index}-2`,
          userId: "u2",
          text: `concurrent thread ${index} reply`,
          ts: index * 2 * 60 * 60 * 1000 + 2,
        }),
      ]).flat(),
    );

    let active = 0;
    let maxActive = 0;
    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfigWithThreadConcurrency(2),
      summarizer: async ({ threadId }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return {
          title: threadId,
          brief: "Concurrent summary",
          topics: [],
        };
      },
    });

    const run = await service.runSummarization({ now: Date.now() + 10 * 60 * 60 * 1000 });
    expect(run.summarized).toBe(4);
    expect(maxActive).toBe(2);

    searchStore.close();
    threadStore.close();
  });

  it("keeps concurrent scheduled-style summaries attached to their own thread ids", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    const threadCount = 16;
    searchStore.upsertMessages(
      Array.from({ length: threadCount }, (_, index) => [
        msg({
          channelId: "c1",
          messageId: `scheduled-${index}-1`,
          userId: "u1",
          text: `scheduled thread ${index} start`,
          ts: index * 2 * 60 * 60 * 1000 + 1,
        }),
        msg({
          channelId: "c1",
          messageId: `scheduled-${index}-2`,
          userId: "u2",
          text: `scheduled thread ${index} reply`,
          ts: index * 2 * 60 * 60 * 1000 + 2,
        }),
      ]).flat(),
    );

    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfigWithThreadConcurrency(16),
      summarizer: async ({ threadId }) => {
        const index = Number(threadId.match(/scheduled-(\d+)-1$/u)?.[1] ?? "0");
        await Bun.sleep(threadCount - index);
        return {
          title: `Summary for ${threadId}`,
          brief: `Summary for ${threadId}`,
          topics: [`thread ${index}`],
        };
      },
    });

    const run = await service.runSummarization({ now: Date.now() + 40 * 60 * 60 * 1000 });
    expect(run.summarized).toBe(threadCount);
    for (let index = 0; index < threadCount; index++) {
      const threadId = `discord:channel:c1:scheduled-${index}-1`;
      expect(threadStore.readThread(threadId)?.summary?.title).toBe(`Summary for ${threadId}`);
    }

    searchStore.close();
    threadStore.close();
  });

  it("resolves the embedding adapter once per summarization run", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    searchStore.upsertMessages(
      Array.from({ length: 4 }, (_, index) => [
        msg({
          channelId: "c1",
          messageId: `embed-once-${index}-1`,
          userId: "u1",
          text: `embedding resolver thread ${index} start`,
          ts: index * 2 * 60 * 60 * 1000 + 1,
        }),
        msg({
          channelId: "c1",
          messageId: `embed-once-${index}-2`,
          userId: "u2",
          text: `embedding resolver thread ${index} reply`,
          ts: index * 2 * 60 * 60 * 1000 + 2,
        }),
      ]).flat(),
    );

    let adapterCalls = 0;
    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfigWithThreadConcurrency(2),
      getEmbeddingAdapter: async () => {
        adapterCalls += 1;
        return fakeEmbeddingAdapter;
      },
      summarizer: async ({ threadId }) => ({
        title: threadId,
        brief: "Embedding resolver summary",
        topics: [],
      }),
    });

    const run = await service.runSummarization({ now: Date.now() + 10 * 60 * 60 * 1000 });
    expect(run.summarized).toBe(4);
    expect(adapterCalls).toBe(1);

    searchStore.close();
    threadStore.close();
  });

  it("force reruns fresh quiet summaries", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    searchStore.upsertMessages([
      msg({ channelId: "c1", messageId: "f1", userId: "u1", text: "force start", ts: 1 }),
      msg({ channelId: "c1", messageId: "f2", userId: "u2", text: "force reply", ts: 2 }),
    ]);

    let calls = 0;
    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfig(),
      summarizer: async () => {
        calls += 1;
        return {
          title: `Force summary ${calls}`,
          brief: "Force rerun summary",
          topics: [],
        };
      },
    });

    const now = Date.now() + 2 * 60 * 60 * 1000;
    expect((await service.runSummarization({ now })).summarized).toBe(1);
    expect((await service.runSummarization({ now: now + 1 })).eligible).toBe(0);
    const forced = await service.runSummarization({ now: now + 2 * 60 * 60 * 1000, force: true });
    expect(forced.summarized).toBe(1);
    expect(calls).toBe(2);

    searchStore.close();
    threadStore.close();
  });

  it("normalizes entities before summarization", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    searchStore.upsertMessages([
      msg({ channelId: "c1", messageId: "e1", userId: "u1", text: "hello <@123>", ts: 1 }),
      msg({ channelId: "c1", messageId: "e2", userId: "u2", text: "see <#456>", ts: 2 }),
    ]);

    let summarizedTexts: string[] = [];
    let summarizedUserNames: Array<string | undefined> = [];
    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfig(),
      entityMapper: {
        normalizeIncomingText: (text) =>
          text
            .replace("<@u1>", "@Developer")
            .replace("<@u2>", "@Assistant")
            .replace("<@123>", "@Developer")
            .replace("<#456>", "#work"),
      },
      summarizer: async ({ messages }) => {
        summarizedTexts = messages.map((message) => message.text);
        summarizedUserNames = messages.map((message) => message.userName);
        return {
          title: "Entity normalized",
          brief: "Entity normalized summary",
          topics: [],
        };
      },
    });

    await service.runSummarization({ now: Date.now() + 2 * 60 * 60 * 1000 });
    expect(summarizedTexts).toEqual(["hello @Developer", "see #work"]);
    expect(summarizedUserNames).toEqual(["@Developer", "@Assistant"]);

    searchStore.close();
    threadStore.close();
  });

  it("uses importance as a small ranking nudge", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    searchStore.upsertMessages([
      msg({
        channelId: "c1",
        messageId: "high",
        userId: "u1",
        text: "needle architecture",
        ts: 1,
      }),
      msg({
        channelId: "c1",
        messageId: "low",
        userId: "u1",
        text: "needle reaction",
        ts: 2 * 60 * 60 * 1000,
      }),
    ]);

    threadStore.refreshInferredThreads();
    threadStore.upsertSummary("discord:channel:c1:high", "high", {
      title: "Needle architecture",
      brief: "needle architecture",
      topics: [],
      importance: "high",
      importanceReasons: ["Documents durable architecture context."],
    });
    threadStore.upsertSummary("discord:channel:c1:low", "low", {
      title: "Needle reaction",
      brief: "needle reaction",
      topics: [],
      importance: "low",
      importanceReasons: ["Mostly a transient reaction."],
    });

    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfig(),
    });

    const result = await service.search({ query: "needle", limit: 2, mode: "lexical" });
    expect(result.results.map((item) => item.threadId)).toEqual([
      "discord:channel:c1:high",
      "discord:channel:c1:low",
    ]);

    searchStore.close();
    threadStore.close();
  });

  it("indexes retrieval hints for colloquial search phrases", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    searchStore.upsertMessages([
      msg({
        channelId: "c1",
        messageId: "r1",
        userId: "u1",
        text: "designer workflow constraints",
        ts: 1,
      }),
      msg({
        channelId: "c1",
        messageId: "r2",
        userId: "u2",
        text: "legacy frontend spec ambiguity",
        ts: 2,
      }),
    ]);

    threadStore.refreshInferredThreads();
    threadStore.upsertSummary("discord:channel:c1:r1", "r", {
      title: "Designer workflow constraints",
      brief: "Discussion of legacy frontend design specs.",
      topics: ["designer workflow"],
      retrievalHints: ["developer job rant about designer process"],
      aboutness: {
        domains: ["day job", "workplace"],
        situations: ["design handoff frustration"],
        complaintTargets: ["designer process"],
        entities: ["designer"],
        userWouldAskForThisAs: ["day job complaint about designer process"],
      },
    });

    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfig(),
    });

    const result = await service.search({ query: "job rant", mode: "lexical" });
    expect(result.results[0]?.threadId).toBe("discord:channel:c1:r1");

    const aboutnessResult = await service.search({
      query: "day job",
      mode: "lexical",
      verbose: true,
    });
    expect(aboutnessResult.results[0]?.aboutness?.userWouldAskForThisAs).toEqual([
      "day job complaint about designer process",
    ]);

    searchStore.close();
    threadStore.close();
  });

  it("combines multiple query variants with verbose-only attribution", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    searchStore.upsertMessages([
      msg({ channelId: "c1", messageId: "mq1", userId: "u1", text: "alpha beta topic", ts: 1 }),
      msg({ channelId: "c1", messageId: "mq2", userId: "u2", text: "alpha beta reply", ts: 2 }),
      msg({
        channelId: "c1",
        messageId: "mq3",
        userId: "u1",
        text: "alpha only topic",
        ts: 2 * 60 * 60 * 1000,
      }),
      msg({
        channelId: "c1",
        messageId: "mq4",
        userId: "u2",
        text: "alpha only reply",
        ts: 2 * 60 * 60 * 1000 + 1,
      }),
    ]);

    threadStore.refreshInferredThreads();
    threadStore.upsertSummary("discord:channel:c1:mq1", "mq1", {
      title: "Two query match",
      brief: "Thread matched by both query variants.",
      topics: [],
      retrievalHints: ["alpha beta"],
    });
    threadStore.upsertSummary("discord:channel:c1:mq3", "mq3", {
      title: "One query match",
      brief: "Thread matched by one query variant.",
      topics: [],
      retrievalHints: ["alpha"],
    });

    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfig(),
    });

    const compact = await service.search({ query: ["alpha", "beta"], mode: "lexical", limit: 2 });
    expect(compact.results.map((item) => item.title)).toEqual([
      "Two query match",
      "One query match",
    ]);
    expect(compact.results[0]).not.toHaveProperty("queryAttribution");

    const verbose = await service.search({
      query: ["alpha", "beta"],
      mode: "lexical",
      limit: 2,
      verbose: true,
    });
    expect(verbose.meta).toMatchObject({ query: "alpha", queries: ["alpha", "beta"] });
    expect(verbose.results[0]?.score).toBe(1);
    expect(verbose.results[1]?.score).toBe(0.5);
    expect(verbose.results[0]?.queryAttribution).toEqual([
      {
        query: "alpha",
        rank: 2,
        selfScore: 1,
        contribution: 0.5,
        lexicalScore: 1,
        semanticScore: 0,
      },
      {
        query: "beta",
        rank: 1,
        selfScore: 1,
        contribution: 0.5,
        lexicalScore: 1,
        semanticScore: 0,
      },
    ]);
    expect(verbose.results[1]?.queryAttribution).toEqual([
      {
        query: "alpha",
        rank: 1,
        selfScore: 1,
        contribution: 0.5,
        lexicalScore: 1,
        semanticScore: 0,
      },
    ]);

    const thresholded = await service.search({
      query: ["alpha", "beta"],
      mode: "lexical",
      limit: 2,
      minScore: 0.75,
      verbose: true,
    });
    expect(thresholded.meta.minScore).toBe(0.75);
    expect(thresholded.results.map((item) => item.title)).toEqual(["Two query match"]);

    searchStore.close();
    threadStore.close();
  });

  it("uses one request-time aboutness capture to rerank subject coverage", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    searchStore.upsertMessages([
      msg({ channelId: "c1", messageId: "job-1", userId: "u1", text: "work PR complaint", ts: 1 }),
      msg({ channelId: "c1", messageId: "job-2", userId: "u2", text: "coworker handoff", ts: 2 }),
      msg({
        channelId: "c1",
        messageId: "social-1",
        userId: "u1",
        text: "social misunderstanding",
        ts: 2 * 60 * 60 * 1000,
      }),
      msg({
        channelId: "c1",
        messageId: "social-2",
        userId: "u2",
        text: "friend worried about offense",
        ts: 2 * 60 * 60 * 1000 + 1,
      }),
    ]);

    const equalEmbeddingAdapter: ConversationThreadEmbeddingAdapter = {
      modelId: "equal-2d",
      dimensions: 2,
      async embed() {
        return new Float32Array([1, 0]);
      },
    };
    let queryCaptureCalls = 0;
    let capturedQueries: readonly string[] = [];
    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfig(),
      getEmbeddingAdapter: async () => equalEmbeddingAdapter,
      queryAboutnessSummarizer: async ({ queries }) => {
        queryCaptureCalls += 1;
        capturedQueries = queries;
        return {
          domains: ["day job", "workplace"],
          situations: ["complaining about current job", "workplace frustration"],
          targets: ["coworker handoff", "company process"],
          entities: ["employee"],
          userWouldAskForThisAs: ["employee complaining about day job"],
          intentSummary: "Find threads where an employee complains about workplace problems.",
        };
      },
      summarizer: async ({ threadId }) =>
        threadId.endsWith(":social-1")
          ? {
              title: "Social misunderstanding",
              brief: "A friend worried about offending an employee in a team chat interaction.",
              topics: ["friend anxiety about offense"],
              retrievalHints: ["friend worried employee was offended"],
              aboutness: {
                domains: ["team chat social conflict", "friend communication"],
                situations: ["friend suspected the employee was offended"],
                complaintTargets: [],
                entities: ["friend", "employee", "team chat"],
                userWouldAskForThisAs: ["friend worried employee was offended"],
              },
            }
          : {
              title: "Workplace PR handoff complaint",
              brief: "An employee complained about coworker PR handoff problems at their day job.",
              topics: ["workplace PR review frustration"],
              retrievalHints: ["work complaint about coworker PR"],
              aboutness: {
                domains: ["day job", "workplace", "software engineering"],
                situations: ["employee complained about current job PR handoff"],
                complaintTargets: ["coworker handoff", "company process"],
                entities: ["employee", "coworker", "PR"],
                userWouldAskForThisAs: ["employee complaining about day job PR handoff"],
              },
            },
    });

    await service.runSummarization({ now: Date.now() + 2 * 60 * 60 * 1000 });
    const result = await service.search({
      query: ["employee complaining about their day job", "employee venting about work stress"],
      mode: "hybrid",
      limit: 2,
      verbose: true,
    });

    expect(queryCaptureCalls).toBe(1);
    expect(capturedQueries).toEqual([
      "employee complaining about their day job",
      "employee venting about work stress",
    ]);
    expect(result.meta.queryAboutness?.domains).toEqual(["day job", "workplace"]);
    expect(result.results.map((item) => item.title)).toEqual([
      "Workplace PR handoff complaint",
      "Social misunderstanding",
    ]);
    expect(result.results[0]?.aboutnessCoverage?.matched).toBe(true);
    expect(result.results[1]?.aboutnessCoverage?.matched).toBe(false);
    expect(result.results[1]?.aboutnessCoverage?.matchReason).toBe("domain-mismatch");
    expect(result.results[1]?.aboutnessCoverage?.domainCoverage).toBe(0);
    expect(result.results[1]?.aboutnessCoverage?.highPrecisionCoverage).toBeLessThan(0.45);
    expect(result.results[1]?.aboutnessCoverage?.multiplier).toBe(0.35);

    searchStore.close();
    threadStore.close();
  });

  it("filters thread search by any visible participant", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    searchStore.upsertMessages([
      msg({ channelId: "c1", messageId: "p1", userId: "u1", text: "shared topic alpha", ts: 1 }),
      msg({ channelId: "c1", messageId: "p2", userId: "u2", text: "shared topic reply", ts: 2 }),
      msg({
        channelId: "c1",
        messageId: "p3",
        userId: "u3",
        text: "shared topic beta",
        ts: 2 * 60 * 60 * 1000,
      }),
      msg({
        channelId: "c1",
        messageId: "p4",
        userId: "u4",
        text: "shared topic reply",
        ts: 2 * 60 * 60 * 1000 + 1,
      }),
    ]);

    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfig(),
      summarizer: async ({ threadId }) => ({
        title: threadId.endsWith(":p1") ? "Thread with u1 and u2" : "Thread with u3 and u4",
        brief: "Shared topic summary",
        topics: ["shared topic"],
        retrievalHints: ["shared topic"],
      }),
    });

    await service.runSummarization({ now: Date.now() + 2 * 60 * 60 * 1000 });
    const u1OrU2 = await service.search({
      query: "shared topic",
      mode: "lexical",
      limit: 10,
      participantIdsAny: ["u1", "u2"],
    });
    expect(u1OrU2.results.map((item) => item.title)).toEqual(["Thread with u1 and u2"]);

    const u2OrU3 = await service.search({
      query: "shared topic",
      mode: "lexical",
      limit: 10,
      participantIdsAny: ["u2", "u3"],
    });
    expect(u2OrU3.results.map((item) => item.title).sort()).toEqual([
      "Thread with u1 and u2",
      "Thread with u3 and u4",
    ]);

    const unrelated = await service.search({
      query: "shared topic",
      mode: "lexical",
      limit: 10,
      participantIdsAny: ["u5"],
    });
    expect(unrelated.results).toEqual([]);

    searchStore.close();
    threadStore.close();
  });

  it("uses precomputed query aboutness without a second capture", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    searchStore.upsertMessages([
      msg({ channelId: "c1", messageId: "pre-1", userId: "u1", text: "precomputed topic", ts: 1 }),
      msg({ channelId: "c1", messageId: "pre-2", userId: "u2", text: "precomputed reply", ts: 2 }),
    ]);

    let queryCaptureCalls = 0;
    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfig(),
      queryAboutnessSummarizer: async () => {
        queryCaptureCalls += 1;
        throw new Error("should not be called");
      },
      autoInjectQueryPlanner: async () => ({
        searches: [
          {
            queries: ["precomputed topic"],
            aboutness: {
              domains: ["conversation memory"],
              situations: ["precomputed search"],
              targets: ["thread lookup"],
              entities: ["precomputed topic"],
              userWouldAskForThisAs: ["precomputed topic"],
              intentSummary: "Find the precomputed topic thread.",
            },
          },
        ],
      }),
      summarizer: async () => ({
        title: "Precomputed topic thread",
        brief: "A thread about a precomputed topic.",
        topics: ["precomputed topic"],
        retrievalHints: ["precomputed topic"],
      }),
    });

    await service.runSummarization({ now: Date.now() + 2 * 60 * 60 * 1000 });
    const plan = await service.planAutoInjectSearch({
      text: "Long message about precomputed topic",
    });
    const result = await service.search({
      query: plan.searches[0]!.queries,
      queryAboutness: plan.searches[0]!.aboutness,
      verbose: true,
    });

    expect(queryCaptureCalls).toBe(0);
    expect(result.results[0]?.title).toBe("Precomputed topic thread");
    expect(result.meta.queryAboutness?.intentSummary).toBe("Find the precomputed topic thread.");

    searchStore.close();
    threadStore.close();
  });

  it("truncates overlong auto-inject search groups and query variants", async () => {
    const dbPath = await createDbPath();
    const threadStore = new ConversationThreadStore(dbPath);
    const aboutness = (intentSummary: string) => ({
      domains: [],
      situations: [],
      targets: [],
      entities: [],
      userWouldAskForThisAs: [intentSummary],
      intentSummary,
    });
    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfig(),
      autoInjectQueryPlanner: async () => ({
        searches: [
          {
            queries: ["one", "one alias", "one exact", "one extra"],
            aboutness: aboutness("Find first search threads."),
          },
          { queries: ["two"], aboutness: aboutness("Find second search threads.") },
          { queries: ["three"], aboutness: aboutness("Find third search threads.") },
          { queries: ["four"], aboutness: aboutness("Find fourth search threads.") },
        ],
      }),
    });

    const plan = await service.planAutoInjectSearch({ text: "Long message with many facets" });

    expect(plan.searches).toHaveLength(3);
    expect(plan.searches[0]?.queries).toEqual(["one", "one alias", "one exact"]);
    expect(plan.searches.map((search) => search.aboutness.intentSummary)).toEqual([
      "Find first search threads.",
      "Find second search threads.",
      "Find third search threads.",
    ]);

    threadStore.close();
  });

  it("falls back safely when request-time aboutness capture fails", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    searchStore.upsertMessages([
      msg({ channelId: "c1", messageId: "fb-1", userId: "u1", text: "fallback topic", ts: 1 }),
      msg({ channelId: "c1", messageId: "fb-2", userId: "u2", text: "fallback reply", ts: 2 }),
      msg({
        channelId: "c1",
        messageId: "fb-3",
        userId: "u1",
        text: "fallback later",
        ts: 2 * 60 * 60 * 1000,
      }),
      msg({
        channelId: "c1",
        messageId: "fb-4",
        userId: "u2",
        text: "fallback later reply",
        ts: 2 * 60 * 60 * 1000 + 1,
      }),
    ]);

    const equalEmbeddingAdapter: ConversationThreadEmbeddingAdapter = {
      modelId: "equal-2d",
      dimensions: 2,
      async embed() {
        return new Float32Array([1, 0]);
      },
    };
    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfig(),
      getEmbeddingAdapter: async () => equalEmbeddingAdapter,
      queryAboutnessSummarizer: async () => {
        throw new Error("query capture unavailable");
      },
      summarizer: async ({ threadId }) => ({
        title: threadId.endsWith(":fb-3") ? "Newer fallback" : "Older fallback",
        brief: "Fallback summary",
        topics: [],
      }),
    });

    await service.runSummarization({ now: Date.now() + 2 * 60 * 60 * 1000 });
    const result = await service.search({
      query: ["fallback topic", "fallback later"],
      verbose: true,
    });
    expect(result.meta.queryAboutnessError).toContain("query capture unavailable");
    expect(result.results).toHaveLength(2);
    expect(result.results.every((item) => item.aboutnessCoverage?.multiplier === 1)).toBe(true);
    expect(
      result.results.every(
        (item) => item.aboutnessCoverage?.matchReason === "no-specific-aboutness",
      ),
    ).toBe(true);

    searchStore.close();
    threadStore.close();
  });

  it("clears matching summaries through the summarization runner", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    searchStore.upsertMessages([
      msg({ channelId: "c1", messageId: "clear-1", userId: "u1", text: "clear topic", ts: 1 }),
      msg({ channelId: "c1", messageId: "clear-2", userId: "u2", text: "clear reply", ts: 2 }),
      msg({
        channelId: "c1",
        messageId: "clear-other-1",
        userId: "u1",
        text: "other clear topic",
        ts: 2 * 60 * 60 * 1000,
      }),
      msg({
        channelId: "c1",
        messageId: "clear-other-2",
        userId: "u2",
        text: "other clear reply",
        ts: 2 * 60 * 60 * 1000 + 1,
      }),
    ]);

    let calls = 0;
    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfig(),
      summarizer: async () => {
        calls += 1;
        return {
          title: `Clear summary ${calls}`,
          brief: `Clear summary ${calls}`,
          topics: ["clear topic"],
          retrievalHints: [`clear hint ${calls}`],
        };
      },
    });

    const now = Date.now() + 2 * 60 * 60 * 1000;
    expect((await service.runSummarization({ now })).summarized).toBe(2);
    expect(threadStore.readThread("discord:channel:c1:clear-1")?.summary?.title).toBe(
      "Clear summary 1",
    );

    const dryRun = await service.runSummarization({
      clear: true,
      dryRun: true,
      threadId: "discord:channel:c1:clear-1",
      now,
    });
    expect(dryRun.cleared).toBe(0);
    expect(dryRun.threadIds).toEqual([
      "discord:channel:c1:clear-1",
      "discord:channel:c1:clear-other-1",
    ]);
    expect(threadStore.readThread("discord:channel:c1:clear-1")?.summary?.title).toBe(
      "Clear summary 1",
    );

    const rerun = await service.runSummarization({
      clear: true,
      threadId: "discord:channel:c1:clear-1",
      now,
    });
    expect(rerun.cleared).toBe(2);
    expect(rerun.summarized).toBe(1);
    expect(threadStore.readThread("discord:channel:c1:clear-1")?.summary?.title).toBe(
      "Clear summary 3",
    );
    expect(threadStore.readThread("discord:channel:c1:clear-other-1")?.summary).toBeNull();

    searchStore.close();
    threadStore.close();
  });

  it("passes gated prompt context to summarization in file order", async () => {
    const previousDataDir = process.env.DATA_DIR;
    const dataDir = await createDataDirWithPromptContext({
      memory: "---\nprivate: true\n---\nMemory context",
      user: "User context",
      entities: "Entity context",
    });
    process.env.DATA_DIR = dataDir;

    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    try {
      searchStore.upsertMessages([
        msg({ channelId: "c1", messageId: "p1", userId: "u1", text: "prompt topic", ts: 1 }),
        msg({ channelId: "c1", messageId: "p2", userId: "u2", text: "prompt reply", ts: 2 }),
      ]);

      let promptContextText = "";
      const service = new ConversationThreadService({
        store: threadStore,
        getConfig: async () => testConfigWithPromptContext(),
        summarizer: async ({ promptContext }) => {
          promptContextText = promptContext?.text ?? "";
          return {
            title: "Prompt context thread",
            brief: "Prompt context summary",
            topics: [],
          };
        },
      });

      await service.runSummarization({ now: Date.now() + 2 * 60 * 60 * 1000 });
      expect(promptContextText).toBe(
        [
          "### MEMORY.md\nMemory context",
          "### USER.md\nUser context",
          "### ENTITIES.md\nEntity context",
        ].join("\n\n"),
      );
    } finally {
      if (previousDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = previousDataDir;
      searchStore.close();
      threadStore.close();
    }
  });

  it("treats prompt context changes as summary-stale when enabled", async () => {
    const previousDataDir = process.env.DATA_DIR;
    const dataDir = await createDataDirWithPromptContext({
      memory: "Memory context v1",
      user: "User context",
    });
    process.env.DATA_DIR = dataDir;

    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    try {
      searchStore.upsertMessages([
        msg({ channelId: "c1", messageId: "pc1", userId: "u1", text: "context topic", ts: 1 }),
        msg({ channelId: "c1", messageId: "pc2", userId: "u2", text: "context reply", ts: 2 }),
      ]);

      let calls = 0;
      const service = new ConversationThreadService({
        store: threadStore,
        getConfig: async () => testConfigWithPromptContext(),
        summarizer: async () => {
          calls += 1;
          return {
            title: `Prompt stale ${calls}`,
            brief: `Prompt stale ${calls}`,
            topics: [],
          };
        },
      });

      const now = Date.now() + 2 * 60 * 60 * 1000;
      expect((await service.runSummarization({ now })).summarized).toBe(1);
      expect((await service.runSummarization({ now: now + 1 })).eligible).toBe(0);

      await fs.writeFile(path.join(dataDir, "prompts", "MEMORY.md"), "Memory context v2");
      const rerun = await service.runSummarization({ now: now + 2 });
      expect(rerun.eligible).toBe(1);
      expect(rerun.summarized).toBe(1);
      expect(calls).toBe(2);
    } finally {
      if (previousDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = previousDataDir;
      searchStore.close();
      threadStore.close();
    }
  });

  it("drops legacy persisted facet weights during migration", async () => {
    const dbPath = await createDbPath();
    const db = new Database(dbPath);
    db.run(`
      CREATE TABLE conversation_thread_facets (
        thread_id TEXT NOT NULL,
        facet TEXT NOT NULL,
        text TEXT NOT NULL,
        weight REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (thread_id, facet)
      );
    `);
    db.close();

    const threadStore = new ConversationThreadStore(dbPath);
    const migrated = new Database(dbPath);
    const columns = migrated.query("PRAGMA table_info(conversation_thread_facets)").all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).not.toContain("weight");

    migrated.close();
    threadStore.close();
  });

  it("applies allowlist before search result limits", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    searchStore.upsertMessages([
      msg({
        channelId: "c1",
        messageId: "allowed",
        userId: "u1",
        text: "needle allowed",
        ts: 1,
      }),
      ...Array.from({ length: 5 }, (_, index) =>
        msg({
          channelId: "c2",
          messageId: `disallowed-${index}`,
          userId: "u2",
          text: "needle disallowed",
          ts: 2 * 60 * 60 * 1000 + index * 2 * 60 * 60 * 1000,
        }),
      ),
    ]);

    threadStore.refreshInferredThreads();
    threadStore.upsertSummary("discord:channel:c1:allowed", "allowed", {
      title: "Allowed needle",
      brief: "needle allowed result",
      topics: [],
    });
    for (let index = 0; index < 5; index++) {
      threadStore.upsertSummary(`discord:channel:c2:disallowed-${index}`, `disallowed-${index}`, {
        title: `Disallowed needle ${index}`,
        brief: "needle disallowed result",
        topics: [],
      });
    }

    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfig(),
    });

    const result = await service.search({ query: "needle", limit: 1, mode: "lexical" });
    expect(result.results.map((item) => item.threadId)).toEqual(["discord:channel:c1:allowed"]);

    searchStore.close();
    threadStore.close();
  });

  it("summarizes first 40 and last 160 text messages for long threads", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    searchStore.upsertMessages(
      Array.from({ length: 250 }, (_, index) =>
        msg({
          channelId: "c1",
          messageId: `m${index}`,
          userId: "u1",
          text: `text message ${index}`,
          ts: index + 1,
        }),
      ),
    );

    let summarizedMessageIds: string[] = [];
    let omittedMessages = 0;
    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfig(),
      summarizer: async ({ messages, omittedMessages: omitted }) => {
        summarizedMessageIds = messages.map((message) => message.messageId);
        omittedMessages = omitted ?? 0;
        return {
          title: "Long thread",
          brief: "Long thread summary",
          topics: [],
        };
      },
    });

    await service.runSummarization({ now: Date.now() + 2 * 60 * 60 * 1000 });

    expect(summarizedMessageIds).toHaveLength(200);
    expect(omittedMessages).toBe(50);
    expect(summarizedMessageIds.slice(0, 40)).toEqual(
      Array.from({ length: 40 }, (_, index) => `m${index}`),
    );
    expect(summarizedMessageIds.slice(40)).toEqual(
      Array.from({ length: 160 }, (_, index) => `m${index + 90}`),
    );

    searchStore.close();
    threadStore.close();
  });

  it("treats summary and embedding version mismatches as stale", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    searchStore.upsertMessages([
      msg({ channelId: "c1", messageId: "m1", userId: "u1", text: "versioned thread", ts: 1 }),
      msg({ channelId: "c1", messageId: "m2", userId: "u2", text: "versioned reply", ts: 2 }),
    ]);
    threadStore.refreshInferredThreads();
    threadStore.upsertSummary("discord:channel:c1:m1", "hash", {
      title: "Versioned thread",
      brief: "A summary with old versions.",
      topics: [],
    });

    const db = new Database(dbPath);
    db.run(
      `
      UPDATE conversation_threads
      SET summary_version = 0,
          embedding_version = 0,
          last_embedded_at = last_summarized_at,
          updated_at = last_summarized_at
      WHERE thread_id = ?
      `,
      ["discord:channel:c1:m1"],
    );
    db.close();

    expect(
      threadStore
        .listEligibleForSummarization({ now: Date.now() + 2 * 60 * 60 * 1000 })
        .map((thread) => thread.thread_id),
    ).toEqual(["discord:channel:c1:m1"]);

    const db2 = new Database(dbPath);
    db2.run(
      `
      UPDATE conversation_threads
      SET summary_version = ?,
          embedding_version = 0,
          last_embedded_at = last_summarized_at,
          updated_at = last_summarized_at
      WHERE thread_id = ?
      `,
      [CONVERSATION_THREAD_SUMMARY_VERSION, "discord:channel:c1:m1"],
    );
    db2.close();

    expect(
      threadStore
        .listEligibleForSummarization({
          now: Date.now() + 2 * 60 * 60 * 1000,
          includeEmbeddingStale: true,
        })
        .map((thread) => thread.thread_id),
    ).toEqual(["discord:channel:c1:m1"]);

    searchStore.close();
    threadStore.close();
  });

  it("uses sqlite-vec semantic search when embeddings are available", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    searchStore.upsertMessages([
      msg({
        channelId: "c1",
        messageId: "m1",
        userId: "u1",
        text: "we discussed sqlite storage internals",
        ts: 1,
      }),
      msg({
        channelId: "c1",
        messageId: "m2",
        userId: "u2",
        text: "database indexing tradeoffs",
        ts: 2,
      }),
      msg({
        channelId: "c1",
        messageId: "m3",
        userId: "u1",
        text: "later cooking discussion",
        ts: 2 + 2 * 60 * 60 * 1000,
      }),
      msg({
        channelId: "c1",
        messageId: "m4",
        userId: "u3",
        text: "banana dessert follow-up",
        ts: 3 + 2 * 60 * 60 * 1000,
      }),
    ]);

    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfig(),
      getEmbeddingAdapter: async () => fakeEmbeddingAdapter,
      queryAboutnessSummarizer: async ({ queries }) => ({
        domains: [],
        situations: [],
        targets: [],
        entities: [],
        userWouldAskForThisAs: [...queries],
        intentSummary: queries.join("; "),
      }),
      summarizer: async ({ threadId }) =>
        threadId.endsWith(":m3")
          ? {
              title: "Dessert planning",
              brief: "Conversation about making a banana dessert recipe.",
              topics: ["dessert recipe"],
            }
          : {
              title: "Database storage",
              brief: "Conversation about sqlite storage and indexing tradeoffs.",
              topics: ["database indexing"],
            },
    });

    const run = await service.runSummarization({ now: Date.now() + 2 * 60 * 60 * 1000 });
    expect(run.summarized).toBe(2);
    expect(threadStore.isVectorSearchAvailable()).toBe(true);

    const result = await service.search({ query: "yellow fruit", mode: "semantic", verbose: true });
    expect(result.meta.vectorAvailable).toBe(true);
    expect(result.results[0]?.title).toBe("Dessert planning");
    expect(result.results[0]?.semanticScore).toBeGreaterThan(0);

    const participantFiltered = await service.search({
      query: "conversation",
      mode: "lexical",
      participantId: "u2",
    });
    expect(participantFiltered.results.map((item) => item.title)).toEqual(["Database storage"]);

    const timeFiltered = await service.search({
      query: "conversation",
      mode: "lexical",
      afterTs: 60 * 60 * 1000,
    });
    expect(timeFiltered.results.map((item) => item.title)).toEqual(["Dessert planning"]);

    searchStore.close();
    threadStore.close();
  });

  it("uses the latest embedding adapter on subsequent runs", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    searchStore.upsertMessages([
      msg({ channelId: "c1", messageId: "hot-a1", userId: "u1", text: "sqlite storage", ts: 1 }),
      msg({
        channelId: "c1",
        messageId: "hot-a2",
        userId: "u2",
        text: "database indexing",
        ts: 2,
      }),
      msg({
        channelId: "c1",
        messageId: "hot-b1",
        userId: "u1",
        text: "cooking discussion",
        ts: 2 + 2 * 60 * 60 * 1000,
      }),
      msg({
        channelId: "c1",
        messageId: "hot-b2",
        userId: "u3",
        text: "banana dessert follow-up",
        ts: 3 + 2 * 60 * 60 * 1000,
      }),
    ]);

    let currentAdapter: ConversationThreadEmbeddingAdapter | null = null;
    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfig(),
      getEmbeddingAdapter: async () => currentAdapter,
      queryAboutnessSummarizer: async ({ queries }) => ({
        domains: [],
        situations: [],
        targets: [],
        entities: [],
        userWouldAskForThisAs: [...queries],
        intentSummary: queries.join("; "),
      }),
      summarizer: async ({ threadId }) =>
        threadId.endsWith(":hot-b1")
          ? {
              title: "Dessert planning",
              brief: "Conversation about making a banana dessert recipe.",
              topics: ["dessert recipe"],
            }
          : {
              title: "Database storage",
              brief: "Conversation about sqlite storage and indexing tradeoffs.",
              topics: ["database indexing"],
            },
    });

    const now = Date.now() + 2 * 60 * 60 * 1000;
    expect((await service.runSummarization({ now })).summarized).toBe(2);
    const disabled = await service.search({
      query: "yellow fruit",
      mode: "semantic",
      verbose: true,
    });
    expect(disabled.meta.vectorAvailable).toBe(false);

    currentAdapter = fakeEmbeddingAdapter;
    expect((await service.runSummarization({ now: now + 1, force: true })).summarized).toBe(2);
    const enabled = await service.search({
      query: "yellow fruit",
      mode: "semantic",
      verbose: true,
    });
    expect(enabled.meta.vectorAvailable).toBe(true);
    expect(enabled.results[0]?.title).toBe("Dessert planning");

    currentAdapter = { ...fakeEmbeddingAdapter, modelId: "fake-2d-v2" };
    const beforeReembed = await service.search({
      query: "yellow fruit",
      mode: "semantic",
      verbose: true,
    });
    expect(beforeReembed.meta.vectorAvailable).toBe(true);
    expect(beforeReembed.results).toEqual([]);

    const reembedded = await service.runSummarization({ now: now + 2 });
    expect(reembedded.eligible).toBe(2);
    expect(reembedded.summarized).toBe(0);
    const afterReembed = await service.search({
      query: "yellow fruit",
      mode: "semantic",
      verbose: true,
    });
    expect(afterReembed.results[0]?.title).toBe("Dessert planning");

    searchStore.close();
    threadStore.close();
  });

  it("embeds summary facets and query text directly", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    searchStore.upsertMessages([
      msg({ channelId: "c1", messageId: "e1", userId: "u1", text: "design handoff", ts: 1 }),
      msg({ channelId: "c1", messageId: "e2", userId: "u2", text: "legacy frontend", ts: 2 }),
    ]);

    const embedded: Array<{ facet: string | undefined; text: string }> = [];
    const recordingAdapter: ConversationThreadEmbeddingAdapter = {
      modelId: "recording-2d",
      dimensions: 2,
      async embed(input) {
        embedded.push({ facet: input.facet, text: input.text });
        return new Float32Array([1, 0]);
      },
    };
    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfig(),
      getEmbeddingAdapter: async () => recordingAdapter,
      queryAboutnessSummarizer: async ({ queries }) => ({
        domains: [],
        situations: [],
        targets: [],
        entities: [],
        userWouldAskForThisAs: [...queries],
        intentSummary: queries.join("; "),
      }),
      summarizer: async () => ({
        title: "Design handoff problem",
        brief: "A designer prototype does not match the production frontend.",
        topics: ["designer workflow"],
        retrievalHints: ["design handoff rant", "legacy frontend complaint"],
        aboutness: {
          domains: ["day job", "frontend work"],
          situations: ["design handoff mismatch"],
          complaintTargets: ["designer prototype", "legacy frontend process"],
          entities: ["designer", "frontend"],
          userWouldAskForThisAs: ["job rant about design handoff"],
        },
      }),
    });

    await service.runSummarization({ now: Date.now() + 2 * 60 * 60 * 1000 });
    expect(embedded).toEqual([
      {
        facet: "combined",
        text: [
          "Design handoff problem",
          "A designer prototype does not match the production frontend.",
          "design handoff rant\nlegacy frontend complaint",
          "job rant about design handoff",
          "designer prototype\nlegacy frontend process",
          "day job\nfrontend work",
          "design handoff mismatch",
          "designer\nfrontend",
          "designer workflow",
        ].join("\n\n"),
      },
      { facet: "userWouldAskForThisAs", text: "job rant about design handoff" },
      {
        facet: "aboutnessComplaintTargets",
        text: "designer prototype\nlegacy frontend process",
      },
      { facet: "aboutnessDomains", text: "day job\nfrontend work" },
      { facet: "aboutnessSituations", text: "design handoff mismatch" },
      { facet: "aboutnessEntities", text: "designer\nfrontend" },
      { facet: "retrievalHints", text: "design handoff rant\nlegacy frontend complaint" },
      { facet: "title", text: "Design handoff problem" },
      {
        facet: "brief",
        text: "A designer prototype does not match the production frontend.",
      },
      { facet: "topics", text: "designer workflow" },
    ]);

    await service.search({ query: "design handoff complaint", mode: "semantic" });
    expect(embedded.at(-1)).toEqual({ facet: "query", text: "design handoff complaint" });

    searchStore.close();
    threadStore.close();
  });

  it("aggregates semantic facet scores with normalized runtime weights", async () => {
    const dbPath = await createDbPath();
    const searchStore = new DiscordSearchStore(dbPath);
    const threadStore = new ConversationThreadStore(dbPath);
    searchStore.upsertMessages([
      msg({ channelId: "c1", messageId: "a1", userId: "u1", text: "single strong facet", ts: 1 }),
      msg({
        channelId: "c1",
        messageId: "b1",
        userId: "u1",
        text: "multiple medium facets",
        ts: 2 * 60 * 60 * 1000,
      }),
    ]);

    threadStore.refreshInferredThreads();
    threadStore.upsertSummary("discord:channel:c1:a1", "ha", {
      title: "Single strong facet",
      brief: "Only combined matches.",
      topics: [],
    });
    threadStore.upsertSummary("discord:channel:c1:b1", "hb", {
      title: "Multiple weighted facets",
      brief: "Brief, topics, and title match together.",
      topics: ["topic match"],
    });

    const match = new Float32Array([1, 0]);
    const miss = new Float32Array([0, 1]);
    threadStore.upsertEmbeddings({
      threadId: "discord:channel:c1:a1",
      embeddingInputHash: "ea",
      modelId: "test-2d",
      dimensions: 2,
      embeddings: [
        { facet: "combined", embedding: match },
        { facet: "brief", embedding: miss },
        { facet: "topics", embedding: miss },
        { facet: "title", embedding: miss },
      ],
    });
    threadStore.upsertEmbeddings({
      threadId: "discord:channel:c1:b1",
      embeddingInputHash: "eb",
      modelId: "test-2d",
      dimensions: 2,
      embeddings: [
        { facet: "combined", embedding: miss },
        { facet: "brief", embedding: match },
        { facet: "topics", embedding: match },
        { facet: "title", embedding: match },
      ],
    });

    const results = threadStore.searchSemantic({
      embedding: match,
      modelId: "test-2d",
      dimensions: 2,
      limit: 2,
    });

    expect(results.map((item) => item.threadId)).toEqual([
      "discord:channel:c1:b1",
      "discord:channel:c1:a1",
    ]);
    expect(results[0]?.semanticScore).toBeGreaterThan(results[1]?.semanticScore ?? 0);
    expect(results[0]?.semanticScore).toBeLessThanOrEqual(1);

    searchStore.close();
    threadStore.close();
  });
});
