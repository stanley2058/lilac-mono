import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseCoreConfigV1ToUniversal, type CoreConfig } from "@stanley2058/lilac-utils";

import { ConversationThreadService } from "../../src/conversation/thread-service";
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

function msg(input: {
  channelId: string;
  guildId?: string;
  parentChannelId?: string;
  messageId: string;
  userId: string;
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
    userName: `user-${input.userId}`,
    text: input.text,
    ts: input.ts,
  };
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
    ]);

    threadStore.refreshInferredThreads();
    const eligible = threadStore.listEligibleForSummarization({ now: Date.now() });
    expect(eligible.map((thread) => thread.thread_id)).toEqual(["discord:channel:c1:old-1"]);

    searchStore.close();
    threadStore.close();
  });

  it("forms native Discord threads and follows reply relations for inferred threads", async () => {
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
    expect(refreshed.threads).toBe(3);

    const native = threadStore.readThread("discord:thread:th1", 0, 10);
    expect(native?.thread.kind).toBe("discord_thread");
    expect(native?.thread.parent_channel_id).toBe("c1");
    expect(native?.messages.map((item) => item.messageId)).toEqual(["t1", "t2"]);

    const replied = threadStore.readThread("discord:channel:c1:m1", 0, 10);
    expect(replied?.messages.map((item) => item.messageId)).toEqual(["m1", "m2"]);

    const unrelated = threadStore.readThread("discord:channel:c1:m3", 0, 10);
    expect(unrelated?.messages.map((item) => item.messageId)).toEqual(["m3"]);

    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfig(),
      summarizer: async ({ threadId }) => ({
        title: threadId === "discord:thread:th1" ? "Native parent thread" : "Other thread",
        brief: threadId === "discord:thread:th1" ? "native parent allowlist" : "other thread",
        topics: [],
      }),
    });
    await service.runSummarization({ now: Date.now() + 7 * 60 * 60 * 1000 });
    const allowedByParent = await service.read({ threadId: "discord:thread:th1" });
    expect(allowedByParent.thread.session.parentChannelId).toBe("c1");

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

    const search = (await tool.call("conversation.thread.search", {
      query: "vector retrieval",
    })) as {
      results: Array<{
        threadId: string;
        title: string;
        importance: string;
        importanceReasons: string[];
      }>;
    };
    expect(search.results[0]?.title).toBe("Memory search architecture");
    expect(search.results[0]?.importance).toBe("high");
    expect(search.results[0]?.importanceReasons).toEqual([
      "Captures reusable architecture decisions for conversation retrieval.",
    ]);

    const read = (await tool.call("conversation.thread.read", {
      threadId: search.results[0]!.threadId,
      offset: 1,
      limit: 1,
    })) as {
      thread: { importance?: string; importanceReasons?: string[] };
      page: { total: number; hasMore: boolean };
      messages: Array<{ messageId: string }>;
    };
    expect(read.thread.importance).toBe("high");
    expect(read.page.total).toBe(2);
    expect(read.page.hasMore).toBe(false);
    expect(read.messages.map((item) => item.messageId)).toEqual(["m2"]);

    const entry = (await tool.list()).find(
      (item) => item.callableId === "conversation.thread.runSummarization",
    );
    expect(entry?.hidden).toBe(true);

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
    ]);

    const service = new ConversationThreadService({
      store: threadStore,
      getConfig: async () => testConfig(),
      embeddingAdapter: fakeEmbeddingAdapter,
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

  it("aggregates semantic facet scores with weighted sum", async () => {
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

    searchStore.close();
    threadStore.close();
  });
});
