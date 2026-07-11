import { describe, expect, it } from "bun:test";
import path from "node:path";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  createLilacBus,
  lilacEventTypes,
  type HandleContext,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";
import {
  RESPONSE_COMMENTARY_INSTRUCTIONS,
  createLogger,
  parseCoreConfigV1ToUniversal,
  type CoreConfig,
} from "@stanley2058/lilac-utils";
import { AiSdkPiAgent } from "@stanley2058/lilac-agent";
import type { ModelMessage } from "ai";
import type { LanguageModel } from "ai";

import {
  AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH,
  appendConfiguredAliasPromptBlock,
  appendAdditionalSessionMemoBlock,
  buildAutoInjectedThreadSearchOverlay,
  buildCustomCommandFailureFinalText,
  consumeAssistantTextDelta,
  computeTransientRetryDelayMs,
  createAssistantTextPartBoundaryState,
  createDeferredSubagentManager,
  createTransientModelRetryController,
  formatAutoCompactionToolDisplay,
  formatUnknownErrorForDisplay,
  buildHeartbeatOverlayForRequest,
  buildAutoInjectedThreadSearchMessages,
  maybeBuildAutoInjectedThreadSearchMessages,
  buildPersistedHeartbeatMessages,
  buildSurfaceMetadataOverlay,
  isRetryableTransientModelError,
  markAssistantTextPartEnded,
  markAssistantTextPartStarted,
  measureMeaningfulTextUnits,
  mergeToSingleUserMessage,
  maybeAppendResponseCommentaryPrompt,
  resolveSessionAdditionalPrompts,
  shouldRunAutoInjectedThreadSearch,
  shouldCancelRunPolicyRequest,
  shouldCancelIdleOnlyGlobalRequest,
  shouldEnableAnthropicPromptCache,
  toOpenAIPromptCacheKey,
  withReasoningDisplayDefaultForAnthropicModels,
  withBlankLineBetweenTextParts,
  withReasoningSummaryDefaultForOpenAIModels,
} from "../../../src/surface/bridge/bus-agent-runner";
import { formatSurfaceMetadataLine } from "../../../src/surface/bridge/surface-metadata";
import {
  buildExperimentalDownloadForAnthropicFallback,
  shouldForceUrlDownloadForAnthropicFallback,
  withStableAnthropicUpstreamOrder,
} from "../../../src/surface/bridge/bus-agent-runner/anthropic-fallback-media";

function fakeModel(): LanguageModel {
  return {} as LanguageModel;
}

function formatExpectedLocalThreadTimeRange(start: string, end: string): string {
  const format = (value: string) => {
    const date = new Date(value);
    const pad = (part: number) => String(part).padStart(2, "0");
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(
      date.getHours(),
    )}:${pad(date.getMinutes())}`;
  };
  return `${format(start)} - ${format(end)}`;
}

function autoInjectPlanForQuery(query: string, intentSummary: string) {
  return {
    searches: [
      {
        queries: [query],
        aboutness: {
          domains: [],
          situations: [],
          targets: [],
          entities: [],
          userWouldAskForThisAs: [query],
          intentSummary,
        },
      },
    ],
  };
}

function createInMemoryRawBus(): RawBus {
  const topics = new Map<string, Array<Message<unknown>>>();
  const subs = new Set<{
    topic: string;
    opts: SubscriptionOptions;
    handler: (msg: Message<unknown>, ctx: HandleContext) => Promise<void>;
  }>();

  return {
    publish: async <TData>(msg: Omit<Message<TData>, "id" | "ts">, opts: PublishOptions) => {
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const stored: Message<unknown> = {
        topic: opts.topic,
        id,
        type: opts.type,
        ts: Date.now(),
        key: opts.key,
        headers: opts.headers,
        data: msg.data as unknown,
      };

      const list = topics.get(opts.topic) ?? [];
      list.push(stored);
      topics.set(opts.topic, list);

      for (const s of subs) {
        if (s.topic !== opts.topic) continue;
        await s.handler(stored, { cursor: id, commit: async () => {} });
      }

      return { id, cursor: id };
    },

    subscribe: async <TData>(
      topic: string,
      opts: SubscriptionOptions,
      handler: (msg: Message<TData>, ctx: HandleContext) => Promise<void>,
    ) => {
      const entry = {
        topic,
        opts,
        handler: handler as unknown as (msg: Message<unknown>, ctx: HandleContext) => Promise<void>,
      };
      subs.add(entry);

      const offset = opts.offset;
      if (offset?.type === "begin" || offset?.type === "cursor") {
        const existing = topics.get(topic) ?? [];
        const replay =
          offset.type === "cursor"
            ? (() => {
                const cursorIndex = existing.findIndex((m) => m.id === offset.cursor);
                return cursorIndex >= 0 ? existing.slice(cursorIndex + 1) : existing;
              })()
            : existing;
        for (const m of replay) {
          await handler(m as unknown as Message<TData>, {
            cursor: m.id,
            commit: async () => {},
          });
        }
      }

      return {
        stop: async () => {
          subs.delete(entry);
        },
      };
    },

    fetch: async <TData>(topic: string) => {
      const existing = topics.get(topic) ?? [];
      return {
        messages: existing.map((m) => ({
          msg: m as unknown as Message<TData>,
          cursor: m.id,
        })),
        next: existing.length > 0 ? existing[existing.length - 1]?.id : undefined,
      };
    },

    close: async () => {},
  };
}

function createInMemoryRawBusWithStopWaitingForActiveHandler(): RawBus {
  const topics = new Map<string, Array<Message<unknown>>>();
  const subs = new Set<{
    topic: string;
    opts: SubscriptionOptions;
    activeHandlers: number;
    stopWaiters: Array<() => void>;
    handler: (msg: Message<unknown>, ctx: HandleContext) => Promise<void>;
  }>();

  return {
    publish: async <TData>(msg: Omit<Message<TData>, "id" | "ts">, opts: PublishOptions) => {
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const stored: Message<unknown> = {
        topic: opts.topic,
        id,
        type: opts.type,
        ts: Date.now(),
        key: opts.key,
        headers: opts.headers,
        data: msg.data as unknown,
      };

      const list = topics.get(opts.topic) ?? [];
      list.push(stored);
      topics.set(opts.topic, list);

      for (const s of subs) {
        if (s.topic !== opts.topic) continue;
        await s.handler(stored, { cursor: id, commit: async () => {} });
      }

      return { id, cursor: id };
    },

    subscribe: async <TData>(
      topic: string,
      opts: SubscriptionOptions,
      handler: (msg: Message<TData>, ctx: HandleContext) => Promise<void>,
    ) => {
      const entry = {
        topic,
        opts,
        activeHandlers: 0,
        stopWaiters: [] as Array<() => void>,
        handler: async (msg: Message<unknown>, ctx: HandleContext) => {
          entry.activeHandlers += 1;
          try {
            await handler(msg as unknown as Message<TData>, ctx);
          } finally {
            entry.activeHandlers -= 1;
            if (entry.activeHandlers === 0 && entry.stopWaiters.length > 0) {
              const waiters = entry.stopWaiters.splice(0, entry.stopWaiters.length);
              for (const waiter of waiters) waiter();
            }
          }
        },
      };
      subs.add(entry);

      const offset = opts.offset;
      if (offset?.type === "begin" || offset?.type === "cursor") {
        const existing = topics.get(topic) ?? [];
        const replay =
          offset.type === "cursor"
            ? (() => {
                const cursorIndex = existing.findIndex((m) => m.id === offset.cursor);
                return cursorIndex >= 0 ? existing.slice(cursorIndex + 1) : existing;
              })()
            : existing;
        for (const m of replay) {
          await entry.handler(m, {
            cursor: m.id,
            commit: async () => {},
          });
        }
      }

      return {
        stop: async () => {
          subs.delete(entry);
          if (entry.activeHandlers === 0) return;
          await new Promise<void>((resolve) => {
            entry.stopWaiters.push(resolve);
          });
        },
      };
    },

    fetch: async <TData>(topic: string) => {
      const existing = topics.get(topic) ?? [];
      return {
        messages: existing.map((m) => ({
          msg: m as unknown as Message<TData>,
          cursor: m.id,
        })),
        next: existing.length > 0 ? existing[existing.length - 1]?.id : undefined,
      };
    },

    close: async () => {},
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 100): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await Bun.sleep(1);
  }
}

describe("formatAutoCompactionToolDisplay", () => {
  it("keeps start and successful end displays compact", () => {
    expect(
      formatAutoCompactionToolDisplay({
        phase: "start",
        messageCountBefore: 42,
      }),
    ).toBe("compact context (42 msgs)");

    expect(
      formatAutoCompactionToolDisplay({
        phase: "end",
        ok: true,
        messageCountBefore: 42,
        messageCountAfter: 9,
      }),
    ).toBe("compact context (42->9 msgs)");
  });

  it("keeps failed end display compact", () => {
    expect(
      formatAutoCompactionToolDisplay({
        phase: "end",
        ok: false,
        messageCountBefore: 42,
      }),
    ).toBe("compact context failed");
  });
});

describe("buildAutoInjectedThreadSearchMessages", () => {
  it("builds slim auto-injected thread search metadata messages", () => {
    const messages = buildAutoInjectedThreadSearchMessages({
      toolCallId: "auto-thread-1",
      entries: [
        {
          threadId: "thread-1",
          title: "Short thread title",
          brief: "Short thread brief",
          timeRange: "2026/06/28 12:01 - 2026/06/28 13:23",
        },
      ],
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("assistant");
    expect(messages[1]?.role).toBe("tool");
    const assistantMessage = messages[0];
    if (assistantMessage?.role !== "assistant" || typeof assistantMessage.content === "string") {
      throw new Error("expected assistant tool-call message");
    }
    const toolCall = assistantMessage.content[0];
    expect(toolCall?.type).toBe("tool-call");
    if (toolCall?.type !== "tool-call") throw new Error("expected tool call");
    expect(toolCall.toolName).toBe("conversation_thread_search");
    const toolMessage = messages[1];
    if (toolMessage?.role !== "tool" || typeof toolMessage.content === "string") {
      throw new Error("expected tool message");
    }
    const result = toolMessage.content[0];
    expect(result?.type).toBe("tool-result");
    if (result?.type !== "tool-result") throw new Error("expected tool result");
    expect(result.toolName).toBe("conversation_thread_search");
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [
          {
            threadId: "thread-1",
            title: "Short thread title",
            brief: "Short thread brief",
            timeRange: "2026/06/28 12:01 - 2026/06/28 13:23",
          },
        ],
      },
    });
  });
});

describe("maybeBuildAutoInjectedThreadSearchMessages", () => {
  it("includes dynamically capped brief metadata", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 1,
            followUpMinTextUnits: 1,
            limit: 3,
            minScore: 0.1,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const fullThreshold = Math.floor(AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH * 1.1);
    const belowDisplayBrief = "a".repeat(AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH - 1);
    const nearThresholdBrief = "b".repeat(fullThreshold);
    const overThresholdBrief = "c".repeat(fullThreshold + 1);

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-briefs",
      raw: {},
      userMessages: [{ role: "user", content: "A sufficiently meaningful message" }],
      conversationThreads: {
        planAutoInjectSearch: async () =>
          autoInjectPlanForQuery("meaningful message", "Find meaningful message threads."),
        search: async () => ({
          meta: {
            query: "meaningful message",
            limit: 3,
            mode: "hybrid",
            minScore: 0.1,
            count: 3,
            vectorAvailable: false,
          },
          results: [
            { threadId: "thread-1", title: "Below display", brief: belowDisplayBrief },
            { threadId: "thread-2", title: "Near threshold", brief: nearThresholdBrief },
            { threadId: "thread-3", title: "Over threshold", brief: overThresholdBrief },
          ],
        }),
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    const toolMessage = messages[1];
    if (toolMessage?.role !== "tool" || typeof toolMessage.content === "string") {
      throw new Error("expected tool message");
    }
    const result = toolMessage.content[0];
    if (result?.type !== "tool-result") throw new Error("expected tool result");
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [
          { threadId: "thread-1", title: "Below display", brief: belowDisplayBrief },
          { threadId: "thread-2", title: "Near threshold", brief: nearThresholdBrief },
          {
            threadId: "thread-3",
            title: "Over threshold",
            brief: `${overThresholdBrief.slice(0, AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH)} ...(${overThresholdBrief.length - AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH} remaining)`,
          },
        ],
      },
    });
  });

  it("ignores surface metadata when deciding whether to auto-inject", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 80,
            followUpMinTextUnits: 110,
            limit: 3,
            minScore: 0.1,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    let plannerCalls = 0;
    let searchCalls = 0;

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-1",
      raw: {},
      userMessages: [
        {
          role: "user",
          content: `${formatSurfaceMetadataLine({
            platform: "discord",
            user_id: "u1",
            user_name: "Alice",
            message_id: "m1",
            message_time: new Date(1_234).toISOString(),
          })}\nlol`,
        },
      ],
      conversationThreads: {
        planAutoInjectSearch: async () => {
          plannerCalls += 1;
          return autoInjectPlanForQuery("lol", "Short message.");
        },
        search: async () => {
          searchCalls += 1;
          return {
            meta: {
              query: "lol",
              limit: 3,
              mode: "hybrid",
              minScore: 0.1,
              count: 1,
              vectorAvailable: false,
            },
            results: [{ threadId: "thread-1", title: "Should not appear", brief: "" }],
          };
        },
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    expect(messages).toEqual([]);
    expect(plannerCalls).toBe(0);
    expect(searchCalls).toBe(0);
  });

  it("passes stripped user text to auto-inject query planning", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 80,
            followUpMinTextUnits: 110,
            limit: 3,
            minScore: 0.42,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const body =
      "I keep getting logged out after the OAuth callback, but only on mobile. It started after I changed the cookie settings and now Safari loops back to the login page.";
    const startTime = "2026-06-28T12:01:00.000Z";
    const endTime = "2026-06-28T13:23:00.000Z";
    let plannedText = "";
    let searchVerbose: boolean | undefined;
    let searchMinScore: number | undefined;

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-1",
      raw: {},
      userMessages: [
        {
          role: "user",
          content: `${formatSurfaceMetadataLine({
            platform: "discord",
            user_id: "u1",
            user_name: "Alice",
            message_id: "m1",
            message_time: new Date(1_234).toISOString(),
          })}\n${body}`,
        },
      ],
      conversationThreads: {
        planAutoInjectSearch: async (input) => {
          plannedText = input.text;
          return {
            searches: [
              {
                queries: ["OAuth callback mobile login loop"],
                aboutness: {
                  domains: ["OAuth debugging"],
                  situations: ["mobile login loop after callback"],
                  targets: ["cookie settings"],
                  entities: ["Safari", "SameSite", "secure"],
                  userWouldAskForThisAs: ["OAuth callback mobile login loop"],
                  intentSummary: "Find prior threads about OAuth callback login loops on mobile.",
                },
              },
            ],
          };
        },
        search: async (input) => {
          searchVerbose = input.verbose;
          searchMinScore = input.minScore;
          return {
            meta: {
              query: "OAuth callback mobile login loop",
              limit: 3,
              mode: "hybrid",
              minScore: 0.42,
              count: 1,
              vectorAvailable: false,
            },
            results: [
              {
                threadId: "thread-1",
                title: "OAuth callback login loop",
                brief: "",
                timeRange: {
                  start: startTime,
                  end: endTime,
                },
              },
            ],
          };
        },
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    expect(plannedText).toBe(body);
    expect(plannedText).not.toContain("LILAC_META");
    expect(searchVerbose).toBe(true);
    expect(searchMinScore).toBe(0.42);
    expect(messages).toHaveLength(2);
    const toolMessage = messages[1];
    if (toolMessage?.role !== "tool" || typeof toolMessage.content === "string") {
      throw new Error("expected tool message");
    }
    const result = toolMessage.content[0];
    if (result?.type !== "tool-result") throw new Error("expected tool result");
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [
          {
            threadId: "thread-1",
            title: "OAuth callback login loop",
            timeRange: formatExpectedLocalThreadTimeRange(startTime, endTime),
          },
        ],
      },
    });
  });

  it("selects one unique auto-injected result per planned search before score fill", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 1,
            followUpMinTextUnits: 1,
            limit: 3,
            minScore: 0.1,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const searchQueries: string[] = [];

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-grouped",
      raw: {},
      userMessages: [{ role: "user", content: "A sufficiently meaningful grouped message" }],
      conversationThreads: {
        planAutoInjectSearch: async () => ({
          searches: [
            autoInjectPlanForQuery("auth cookies", "Find auth cookie threads.").searches[0]!,
            autoInjectPlanForQuery("workplace context", "Find workplace context threads.")
              .searches[0]!,
            autoInjectPlanForQuery("project architecture", "Find project architecture threads.")
              .searches[0]!,
          ],
        }),
        search: async (input) => {
          const query = String(Array.isArray(input.query) ? (input.query[0] ?? "") : input.query);
          searchQueries.push(query);
          const resultsByQuery: Record<
            string,
            Array<{ threadId: string; title: string; brief: string; score: number }>
          > = {
            "auth cookies": [
              { threadId: "shared", title: "Shared top", brief: "", score: 0.99 },
              { threadId: "auth-second", title: "Auth second", brief: "", score: 0.4 },
            ],
            "workplace context": [
              { threadId: "shared", title: "Shared top", brief: "", score: 0.98 },
              { threadId: "work-second", title: "Work second", brief: "", score: 0.3 },
            ],
            "project architecture": [
              { threadId: "project-top", title: "Project top", brief: "", score: 0.2 },
            ],
          };
          return {
            meta: {
              query,
              limit: 3,
              mode: "hybrid",
              minScore: 0.1,
              count: resultsByQuery[query]?.length ?? 0,
              vectorAvailable: false,
            },
            results: resultsByQuery[query] ?? [],
          };
        },
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    expect(searchQueries).toEqual(["auth cookies", "workplace context", "project architecture"]);
    const toolMessage = messages[1];
    if (toolMessage?.role !== "tool" || typeof toolMessage.content === "string") {
      throw new Error("expected tool message");
    }
    const result = toolMessage.content[0];
    if (result?.type !== "tool-result") throw new Error("expected tool result");
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [
          { threadId: "shared", title: "Shared top" },
          { threadId: "work-second", title: "Work second" },
          { threadId: "project-top", title: "Project top" },
        ],
      },
    });
  });

  it("caps auto-injected category coverage by global limit and planner order", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 1,
            followUpMinTextUnits: 1,
            limit: 2,
            minScore: 0.1,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-limit-two",
      raw: {},
      userMessages: [{ role: "user", content: "A sufficiently meaningful grouped message" }],
      conversationThreads: {
        planAutoInjectSearch: async () => ({
          searches: [
            autoInjectPlanForQuery("first category", "Find first category threads.").searches[0]!,
            autoInjectPlanForQuery("second category", "Find second category threads.").searches[0]!,
            autoInjectPlanForQuery("third category", "Find third category threads.").searches[0]!,
          ],
        }),
        search: async (input) => {
          const query = Array.isArray(input.query) ? input.query[0]! : input.query;
          const title = `${query} result`;
          return {
            meta: {
              query,
              limit: 2,
              mode: "hybrid",
              minScore: 0.1,
              count: 1,
              vectorAvailable: false,
            },
            results: [
              {
                threadId: query,
                title,
                brief: "",
                score: query === "third category" ? 1 : 0.1,
              },
            ],
          };
        },
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    const toolMessage = messages[1];
    if (toolMessage?.role !== "tool" || typeof toolMessage.content === "string") {
      throw new Error("expected tool message");
    }
    const result = toolMessage.content[0];
    if (result?.type !== "tool-result") throw new Error("expected tool result");
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [
          { threadId: "first category", title: "first category result" },
          { threadId: "second category", title: "second category result" },
        ],
      },
    });
  });

  it("fetches extra per-search recall before deduping grouped auto-inject results", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 1,
            followUpMinTextUnits: 1,
            limit: 2,
            minScore: 0.1,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const requestedLimits: number[] = [];

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-dedupe-recall",
      raw: {},
      userMessages: [{ role: "user", content: "A sufficiently meaningful grouped message" }],
      conversationThreads: {
        planAutoInjectSearch: async () => ({
          searches: [
            autoInjectPlanForQuery("first category", "Find first category threads.").searches[0]!,
            autoInjectPlanForQuery("second category", "Find second category threads.").searches[0]!,
          ],
        }),
        search: async (input) => {
          const query = String(Array.isArray(input.query) ? (input.query[0] ?? "") : input.query);
          const requestedLimit = input.limit ?? 5;
          requestedLimits.push(requestedLimit);
          const resultsByQuery: Record<
            string,
            Array<{ threadId: string; title: string; brief: string; score: number }>
          > = {
            "first category": [
              { threadId: "shared-1", title: "Shared 1", brief: "", score: 1 },
              { threadId: "shared-2", title: "Shared 2", brief: "", score: 0.9 },
            ],
            "second category": [
              { threadId: "shared-1", title: "Shared 1", brief: "", score: 1 },
              { threadId: "shared-2", title: "Shared 2", brief: "", score: 0.9 },
              { threadId: "second-unique", title: "Second unique", brief: "", score: 0.8 },
            ],
          };
          const results = resultsByQuery[query]?.slice(0, requestedLimit) ?? [];
          return {
            meta: {
              query,
              limit: requestedLimit,
              mode: "hybrid",
              minScore: 0.1,
              count: results.length,
              vectorAvailable: false,
            },
            results,
          };
        },
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    expect(requestedLimits).toEqual([4, 4]);
    const toolMessage = messages[1];
    if (toolMessage?.role !== "tool" || typeof toolMessage.content === "string") {
      throw new Error("expected tool message");
    }
    const result = toolMessage.content[0];
    if (result?.type !== "tool-result") throw new Error("expected tool result");
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [
          { threadId: "shared-1", title: "Shared 1" },
          { threadId: "second-unique", title: "Second unique" },
        ],
      },
    });
  });

  it("keeps successful auto-inject search groups when another group fails", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 1,
            followUpMinTextUnits: 1,
            limit: 2,
            minScore: 0.1,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const errors: string[] = [];

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-partial-search-failure",
      raw: {},
      userMessages: [{ role: "user", content: "A sufficiently meaningful grouped message" }],
      conversationThreads: {
        planAutoInjectSearch: async () => ({
          searches: [
            autoInjectPlanForQuery("working category", "Find working category threads.")
              .searches[0]!,
            autoInjectPlanForQuery("failing category", "Find failing category threads.")
              .searches[0]!,
          ],
        }),
        search: async (input) => {
          const query = String(Array.isArray(input.query) ? (input.query[0] ?? "") : input.query);
          if (query === "failing category") throw new Error("vector search unavailable");
          return {
            meta: {
              query,
              limit: input.limit ?? 2,
              mode: "hybrid",
              minScore: 0.1,
              count: 1,
              vectorAvailable: false,
            },
            results: [{ threadId: "working-thread", title: "Working thread", brief: "" }],
          };
        },
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: (message) => {
        errors.push(message);
      },
    });

    expect(errors).toEqual([
      "auto-injected thread search failed; continuing with partial metadata",
    ]);
    const toolMessage = messages[1];
    if (toolMessage?.role !== "tool" || typeof toolMessage.content === "string") {
      throw new Error("expected tool message");
    }
    const result = toolMessage.content[0];
    if (result?.type !== "tool-result") throw new Error("expected tool result");
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [{ threadId: "working-thread", title: "Working thread" }],
      },
    });
  });

  it("skips injection when all search results were already auto-injected", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 1,
            followUpMinTextUnits: 1,
            limit: 3,
            minScore: 0.1,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const statuses: Array<"start" | "end"> = [];
    let injectedCalls = 0;

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-2",
      raw: {},
      previousMessages: buildAutoInjectedThreadSearchMessages({
        toolCallId: "conversation_thread_previous",
        entries: [{ threadId: "thread-1", title: "Previously injected" }],
      }),
      userMessages: [{ role: "user", content: "A sufficiently meaningful message" }],
      conversationThreads: {
        planAutoInjectSearch: async () =>
          autoInjectPlanForQuery("meaningful message", "Find meaningful message threads."),
        search: async () => ({
          meta: {
            query: "meaningful message",
            limit: 3,
            mode: "hybrid",
            minScore: 0.1,
            count: 1,
            vectorAvailable: false,
          },
          results: [{ threadId: "thread-1", title: "Previously injected", brief: "" }],
        }),
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async (update) => {
        statuses.push(update.status);
      },
      onError: () => {},
      onInjected: () => {
        injectedCalls += 1;
      },
    });

    expect(messages).toEqual([]);
    expect(statuses).toEqual(["start", "end"]);
    expect(injectedCalls).toBe(0);
  });

  it("uses the initial threshold before any previous auto-injected metadata", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 80,
            followUpMinTextUnits: 110,
            limit: 3,
            minScore: 0.1,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    let plannerCalls = 0;

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-1",
      raw: {},
      userMessages: [
        {
          role: "user",
          content:
            "please also verify whether our current cookie domain would cover the callback subdomain before changing code",
        },
      ],
      conversationThreads: {
        planAutoInjectSearch: async () => {
          plannerCalls += 1;
          return autoInjectPlanForQuery(
            "cookie callback subdomain",
            "Find cookie callback subdomain threads.",
          );
        },
        search: async () => ({
          meta: {
            query: "cookie callback subdomain",
            limit: 3,
            mode: "hybrid",
            minScore: 0.1,
            count: 1,
            vectorAvailable: false,
          },
          results: [{ threadId: "thread-1", title: "Cookie callback thread", brief: "" }],
        }),
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    expect(plannerCalls).toBe(1);
    expect(messages).toHaveLength(2);
  });

  it("uses the follow-up threshold after previous auto-injected metadata", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 80,
            followUpMinTextUnits: 110,
            limit: 3,
            minScore: 0.1,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    let plannerCalls = 0;
    let searchCalls = 0;

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-2",
      raw: {},
      previousMessages: buildAutoInjectedThreadSearchMessages({
        toolCallId: "conversation_thread_previous",
        entries: [{ threadId: "thread-1", title: "Previously injected" }],
      }),
      userMessages: [
        {
          role: "user",
          content:
            "please also verify whether our current cookie domain would cover the callback subdomain before changing code",
        },
      ],
      conversationThreads: {
        planAutoInjectSearch: async () => {
          plannerCalls += 1;
          return autoInjectPlanForQuery(
            "cookie callback subdomain",
            "Find cookie callback subdomain threads.",
          );
        },
        search: async () => {
          searchCalls += 1;
          return {
            meta: {
              query: "cookie callback subdomain",
              limit: 3,
              mode: "hybrid",
              minScore: 0.1,
              count: 1,
              vectorAvailable: false,
            },
            results: [{ threadId: "thread-2", title: "Cookie callback thread", brief: "" }],
          };
        },
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    expect(messages).toEqual([]);
    expect(plannerCalls).toBe(0);
    expect(searchCalls).toBe(0);
  });

  it("still injects follow-up metadata when the follow-up threshold is met", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 80,
            followUpMinTextUnits: 110,
            limit: 3,
            minScore: 0.1,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    let plannerCalls = 0;

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-3",
      raw: {},
      previousMessages: buildAutoInjectedThreadSearchMessages({
        toolCallId: "conversation_thread_previous",
        entries: [{ threadId: "thread-1", title: "Previously injected" }],
      }),
      userMessages: [
        {
          role: "user",
          content:
            "different angle: this started right after the edge middleware deploy, and the redirect host header differs between Vercel preview and production",
        },
      ],
      conversationThreads: {
        planAutoInjectSearch: async () => {
          plannerCalls += 1;
          return autoInjectPlanForQuery(
            "edge middleware redirect host header",
            "Find redirect host header threads.",
          );
        },
        search: async () => ({
          meta: {
            query: "edge middleware redirect host header",
            limit: 3,
            mode: "hybrid",
            minScore: 0.1,
            count: 1,
            vectorAvailable: false,
          },
          results: [{ threadId: "thread-2", title: "Edge middleware host header", brief: "" }],
        }),
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    expect(plannerCalls).toBe(1);
    expect(messages).toHaveLength(2);
  });

  it("skips injection when participant filtering is enabled without visible participants", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 1,
            followUpMinTextUnits: 110,
            limit: 3,
            minScore: 0.1,
            mode: "hybrid",
            filterCurrentParticipants: true,
          },
        },
      },
    };
    let plannerCalls = 0;
    let searchCalls = 0;

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-1",
      raw: {},
      userMessages: [{ role: "user", content: "A sufficiently meaningful message" }],
      conversationThreads: {
        planAutoInjectSearch: async () => {
          plannerCalls += 1;
          return autoInjectPlanForQuery("meaningful message", "Find meaningful message threads.");
        },
        search: async () => {
          searchCalls += 1;
          return {
            meta: {
              query: "meaningful message",
              limit: 3,
              mode: "hybrid",
              minScore: 0.1,
              count: 1,
              vectorAvailable: false,
            },
            results: [{ threadId: "thread-1", title: "Should not appear", brief: "" }],
          };
        },
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {},
      onError: () => {},
    });

    expect(messages).toEqual([]);
    expect(plannerCalls).toBe(0);
    expect(searchCalls).toBe(0);
  });

  it("continues injecting metadata when optional status publishing fails", async () => {
    const cfg = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          allowedChannelIds: ["c1"],
        },
      },
    });
    const autoInjectCfg: CoreConfig = {
      ...cfg,
      conversation: {
        ...cfg.conversation,
        thread: {
          ...cfg.conversation.thread,
          autoInject: {
            enabled: true,
            minTextUnits: 1,
            followUpMinTextUnits: 110,
            limit: 3,
            minScore: 0.1,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const errors: string[] = [];
    const injectedEvents: Array<{
      toolCallId: string;
      mode: "hybrid" | "semantic" | "lexical";
      limit: number;
      searches: readonly (readonly string[])[];
      participantFilterUserCount: number;
      entries: readonly { threadId: string; title: string }[];
    }> = [];

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-1",
      raw: {},
      userMessages: [{ role: "user", content: "A sufficiently meaningful message" }],
      conversationThreads: {
        planAutoInjectSearch: async () =>
          autoInjectPlanForQuery("meaningful message", "Find meaningful message threads."),
        search: async () => ({
          meta: {
            query: "meaningful message",
            limit: 3,
            mode: "hybrid",
            minScore: 0.1,
            count: 1,
            vectorAvailable: false,
          },
          results: [{ threadId: "thread-1", title: "Related title", brief: "" }],
        }),
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async () => {
        throw new Error("status bus unavailable");
      },
      onError: (message) => {
        errors.push(message);
      },
      onInjected: (event) => {
        injectedEvents.push(event);
      },
    });

    expect(messages).toHaveLength(2);
    expect(injectedEvents).toHaveLength(1);
    const injectedEvent = injectedEvents[0];
    expect(injectedEvent?.toolCallId.startsWith("conversation_thread_")).toBe(true);
    expect(injectedEvent).toMatchObject({
      mode: "hybrid",
      limit: 3,
      searches: [["meaningful message"]],
      participantFilterUserCount: 0,
      entries: [{ threadId: "thread-1", title: "Related title" }],
    });
    expect(errors).toEqual([
      "auto-injected thread search status publish failed; continuing",
      "auto-injected thread search status publish failed; continuing",
    ]);
  });
});

describe("shouldRunAutoInjectedThreadSearch", () => {
  const shouldRun = (text: string) => shouldRunAutoInjectedThreadSearch({ text, minTextUnits: 80 });

  it("skips short and Discord-syntax-heavy messages", () => {
    expect(shouldRun("lol")).toBe(false);
    expect(shouldRun("wtf is this")).toBe(false);
    expect(shouldRun("https://x.com/foo lmao")).toBe(false);
    expect(shouldRun("<@123> thoughts? <#456> <:blob:789> <t:1710000000:R>")).toBe(false);
  });

  it("runs for enough authored Latin text", () => {
    expect(
      shouldRun(
        "I keep getting logged out after the OAuth callback, but only on mobile. It started after I changed the cookie settings and now Safari loops back to the login page.",
      ),
    ).toBe(true);
  });

  it("weights CJK text enough to trigger on shorter authored messages", () => {
    expect(
      shouldRun(
        "我登入後一直被踢回登入頁，只有手機版會發生，改 cookie 設定之後才開始，想知道是不是 SameSite 或 secure 設定造成的",
      ),
    ).toBe(true);
  });

  it("does not let giant code blocks dominate the gate", () => {
    const code =
      "```ts\n" + "const value = computeBrokenOAuthCookieState();\n".repeat(50) + "```\nwhy";
    expect(measureMeaningfulTextUnits(code)).toBeLessThan(80);
    expect(shouldRun(code)).toBe(false);
  });

  it("counts prose around inline code while discounting code syntax", () => {
    expect(
      shouldRun(
        "The OAuth callback works on desktop, but mobile Safari loses the session after `setCookie` runs. I changed `sameSite`, `secure`, and the callback domain yesterday.",
      ),
    ).toBe(true);
  });
});

describe("transient model retry", () => {
  const retry = {
    enabled: true,
    maxRetries: 2,
    baseDelayMs: 0,
    maxDelayMs: 0,
  } satisfies CoreConfig["agent"]["retry"];

  it("classifies Codex overload stream errors as retryable", () => {
    expect(
      isRetryableTransientModelError({
        type: "error",
        sequence_number: 2,
        error: {
          type: "service_unavailable_error",
          code: "server_is_overloaded",
          message: "Our servers are currently overloaded. Please try again later.",
          param: null,
        },
      }),
    ).toBe(true);
  });

  it("formats Codex overload stream errors for display", () => {
    expect(
      formatUnknownErrorForDisplay({
        type: "error",
        sequence_number: 2,
        error: {
          type: "service_unavailable_error",
          code: "server_is_overloaded",
          message: "Our servers are currently overloaded. Please try again later.",
          param: null,
        },
      }),
    ).toBe("server_is_overloaded: Our servers are currently overloaded. Please try again later.");
  });

  it("classifies transient errors inside arrays", () => {
    expect(
      isRetryableTransientModelError({
        errors: [{ code: "server_is_overloaded" }],
      }),
    ).toBe(true);
  });

  it("does not classify context overflow or exhausted AI SDK retries", () => {
    expect(isRetryableTransientModelError("maximum context length is 128000 tokens")).toBe(false);
    expect(
      isRetryableTransientModelError({
        name: "AI_RetryError",
        reason: "maxRetriesExceeded",
        lastError: { statusCode: 503, message: "Service unavailable" },
      }),
    ).toBe(false);
  });

  it("computes capped exponential backoff", () => {
    expect(
      computeTransientRetryDelayMs({ attempt: 1, baseDelayMs: 2_000, maxDelayMs: 30_000 }),
    ).toBe(2_000);
    expect(
      computeTransientRetryDelayMs({ attempt: 5, baseDelayMs: 2_000, maxDelayMs: 30_000 }),
    ).toBe(30_000);
  });

  it("retries transient errors up to the configured max and resets after success", async () => {
    const logger = createLogger({ module: "bus-agent-runner-test" });
    const error = { statusCode: 503, message: "Service unavailable" };
    const controller = createTransientModelRetryController({
      retry,
      logger,
      requestId: "request-1",
      sessionId: "session-1",
      modelSpec: "codex/gpt-5.5",
      hasStartedOutput: () => false,
    });

    await expect(controller.handler(error, {})).resolves.toBe("retry");
    await expect(controller.handler(error, {})).resolves.toBe("retry");
    await expect(controller.handler(error, {})).resolves.toBe("fail");

    controller.reset();
    await expect(controller.handler(error, {})).resolves.toBe("retry");
  });

  it("does not retry after assistant output has started", async () => {
    const logger = createLogger({ module: "bus-agent-runner-test" });
    const controller = createTransientModelRetryController({
      retry,
      logger,
      requestId: "request-1",
      sessionId: "session-1",
      modelSpec: "codex/gpt-5.5",
      hasStartedOutput: () => true,
    });

    await expect(
      controller.handler({ statusCode: 503, message: "Service unavailable" }, {}),
    ).resolves.toBe("fail");
  });
});

describe("toOpenAIPromptCacheKey", () => {
  it("returns the session id when it fits provider limits", () => {
    const sessionId = "sub:abc123";

    expect(toOpenAIPromptCacheKey(sessionId)).toBe(sessionId);
  });

  it("hashes long session ids down to 64 chars", () => {
    const sessionId =
      "sub:680343695673131032:sub:req:7984efa2-6f00-41c5-b1d0-bf77ada46e59:309873d2-712a-424e-9dd1-45273b4655d9";

    const key = toOpenAIPromptCacheKey(sessionId);
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    expect(key).not.toBe(sessionId);
  });
});

describe("withReasoningSummaryDefaultForOpenAIModels", () => {
  it("does not inject reasoning summary when display is none", () => {
    const next = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "none",
      provider: "openai",
      modelId: "gpt-5",
      providerOptions: undefined,
    });

    expect(next).toBeUndefined();
  });

  it("injects detailed reasoning summary for openai provider", () => {
    const next = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "simple",
      provider: "openai",
      modelId: "gpt-5",
      providerOptions: undefined,
    });

    expect(next).toEqual({
      openai: {
        include: ["reasoning.encrypted_content"],
        reasoningSummary: "detailed",
      },
    });
  });

  it("injects for vercel/openai/* and openrouter/openai/* models", () => {
    const vercel = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "detailed",
      provider: "vercel",
      modelId: "openai/gpt-5",
      providerOptions: { gateway: { order: ["openai"] } },
    });

    const openrouter = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "detailed",
      provider: "openrouter",
      modelId: "openai/gpt-5-mini",
      providerOptions: { openrouter: { route: "fallback" } },
    });

    expect(vercel?.openai?.reasoningSummary).toBe("detailed");
    expect(vercel?.openai?.include).toEqual(["reasoning.encrypted_content"]);
    expect(openrouter?.openai?.reasoningSummary).toBe("detailed");
    expect(openrouter?.openai?.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("does not override explicit reasoningSummary and injects encrypted reasoning include", () => {
    const next = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "simple",
      provider: "openai",
      modelId: "gpt-5",
      providerOptions: {
        openai: {
          reasoningSummary: "auto",
          parallelToolCalls: true,
        },
      },
    });

    expect(next).toEqual({
      openai: {
        reasoningSummary: "auto",
        parallelToolCalls: true,
        include: ["reasoning.encrypted_content"],
      },
    });
  });

  it("preserves existing encrypted reasoning include", () => {
    const next = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "simple",
      provider: "codex",
      modelId: "gpt-5.5",
      providerOptions: {
        openai: {
          include: ["reasoning.encrypted_content"],
        },
      },
    });

    expect(next?.openai?.include).toEqual(["reasoning.encrypted_content"]);
  });
});

describe("withReasoningDisplayDefaultForAnthropicModels", () => {
  it("does not inject summarized thinking when display is none", () => {
    const next = withReasoningDisplayDefaultForAnthropicModels({
      reasoningDisplay: "none",
      provider: "anthropic",
      modelId: "claude-fable-5",
      providerOptions: {
        anthropic: {
          thinking: {
            type: "enabled",
            budgetTokens: 12000,
          },
        },
      },
    });

    expect(next).toEqual({
      anthropic: {
        thinking: {
          type: "enabled",
          budgetTokens: 12000,
        },
      },
    });
  });

  it("injects summarized display without changing thinking type", () => {
    const next = withReasoningDisplayDefaultForAnthropicModels({
      reasoningDisplay: "simple",
      provider: "anthropic",
      modelId: "claude-fable-5",
      providerOptions: {
        anthropic: {
          thinking: {
            type: "enabled",
            budgetTokens: 12000,
          },
        },
      },
    });

    expect(next).toEqual({
      anthropic: {
        thinking: {
          type: "enabled",
          budgetTokens: 12000,
          display: "summarized",
        },
      },
    });
  });

  it("injects summarized display for vercel/openrouter anthropic models", () => {
    const vercel = withReasoningDisplayDefaultForAnthropicModels({
      reasoningDisplay: "detailed",
      provider: "vercel",
      modelId: "anthropic/claude-fable-5",
      providerOptions: {
        anthropic: {
          thinking: {
            type: "adaptive",
          },
        },
        gateway: {
          order: ["anthropic"],
        },
      },
    });

    const openrouter = withReasoningDisplayDefaultForAnthropicModels({
      reasoningDisplay: "detailed",
      provider: "openrouter",
      modelId: "anthropic/claude-future-6",
      providerOptions: {
        anthropic: {
          thinking: {
            type: "adaptive",
          },
        },
        openrouter: {
          route: "fallback",
        },
      },
    });

    expect(vercel).toEqual({
      anthropic: {
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
      },
      gateway: {
        order: ["anthropic"],
      },
    });
    expect(openrouter).toEqual({
      anthropic: {
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
      },
      openrouter: {
        route: "fallback",
      },
    });
  });

  it("does not override explicit anthropic thinking display", () => {
    const next = withReasoningDisplayDefaultForAnthropicModels({
      reasoningDisplay: "simple",
      provider: "anthropic",
      modelId: "claude-future-6",
      providerOptions: {
        anthropic: {
          thinking: {
            type: "adaptive",
            display: "omitted",
          },
        },
      },
    });

    expect(next).toEqual({
      anthropic: {
        thinking: {
          type: "adaptive",
          display: "omitted",
        },
      },
    });
  });
});

describe("shouldEnableAnthropicPromptCache", () => {
  it("keeps Anthropic prompt caching disabled by default", () => {
    expect(
      shouldEnableAnthropicPromptCache({
        spec: "openrouter/anthropic/claude-sonnet-4.5",
      }),
    ).toBe(false);
  });

  it("enables Anthropic prompt caching only when explicitly opted in", () => {
    expect(
      shouldEnableAnthropicPromptCache({
        spec: "openrouter/anthropic/claude-sonnet-4.5",
        anthropicPromptCache: true,
      }),
    ).toBe(true);

    expect(
      shouldEnableAnthropicPromptCache({
        spec: "openrouter/openai/gpt-4o",
        anthropicPromptCache: true,
      }),
    ).toBe(false);
  });
});

describe("withStableAnthropicUpstreamOrder", () => {
  it("injects the default order for vercel anthropic when none is configured", () => {
    const next = withStableAnthropicUpstreamOrder("vercel", {
      anthropic: {
        thinking: { type: "enabled" },
      },
    });

    expect(next).toEqual({
      anthropic: {
        thinking: { type: "enabled" },
      },
      gateway: {
        order: ["anthropic", "vertex", "bedrock"],
      },
    });
  });

  it("preserves an explicit vercel gateway order", () => {
    const next = withStableAnthropicUpstreamOrder("vercel", {
      gateway: {
        order: ["vertex", "anthropic", "bedrock"],
      },
    });

    expect(next).toEqual({
      gateway: {
        order: ["vertex", "anthropic", "bedrock"],
      },
    });
  });

  it("preserves an explicit openrouter provider order", () => {
    const next = withStableAnthropicUpstreamOrder("openrouter", {
      openrouter: {
        provider: {
          order: ["bedrock", "anthropic"],
        },
      },
    });

    expect(next).toEqual({
      openrouter: {
        provider: {
          order: ["bedrock", "anthropic"],
        },
      },
    });
  });
});

describe("anthropic fallback URL downloads", () => {
  it("detects fallback-capable anthropic gateway models", () => {
    expect(
      shouldForceUrlDownloadForAnthropicFallback({
        spec: "vercel/anthropic/claude-opus-4.6",
        provider: "vercel",
        providerOptions: {
          gateway: {
            order: ["vertex", "anthropic", "bedrock"],
          },
        },
      }),
    ).toBe(true);

    expect(
      shouldForceUrlDownloadForAnthropicFallback({
        spec: "openrouter/anthropic/claude-sonnet-4.5",
        provider: "openrouter",
        providerOptions: {
          openrouter: {
            provider: {
              order: ["anthropic"],
            },
          },
        },
      }),
    ).toBe(false);

    expect(
      shouldForceUrlDownloadForAnthropicFallback({
        spec: "vercel/anthropic/claude-opus-4.6",
        provider: "vercel",
        providerOptions: {
          gateway: {
            only: ["anthropic"],
            order: ["vertex", "anthropic", "bedrock"],
          },
        },
      }),
    ).toBe(false);
  });

  it("forces downloads for http urls when fallback order includes vertex or bedrock", async () => {
    const downloadCalls: string[] = [];
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    const download = buildExperimentalDownloadForAnthropicFallback({
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
      downloadUrl: async (url) => {
        downloadCalls.push(url.toString());
        return {
          data: new Uint8Array([1, 2, 3]),
          mediaType: "image/png",
        };
      },
      cacheDir: dir,
    });

    try {
      expect(download).toBeDefined();

      const result = await download!([
        {
          url: new URL("https://example.com/image.png?test=force-download"),
          isUrlSupportedByModel: true,
        },
        {
          url: new URL("data:image/png;base64,AA=="),
          isUrlSupportedByModel: false,
        },
      ]);

      expect(downloadCalls).toEqual([
        "https://example.com/image.png?test=force-download",
        "data:image/png;base64,AA==",
      ]);
      expect(result).toEqual([
        {
          data: new Uint8Array([1, 2, 3]),
          mediaType: "image/png",
        },
        {
          data: new Uint8Array([1, 2, 3]),
          mediaType: "image/png",
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caches fallback downloads across repeated requests", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    let calls = 0;

    const download = buildExperimentalDownloadForAnthropicFallback({
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
      cacheDir: dir,
      downloadUrl: async () => {
        calls += 1;
        return {
          data: new Uint8Array([9, 8, 7, 6]),
          mediaType: "application/pdf",
        };
      },
    });

    try {
      expect(download).toBeDefined();

      const request = [
        {
          url: new URL("https://example.com/report.pdf?test=cache"),
          isUrlSupportedByModel: true,
        },
      ];

      await download!(request);
      await download!(request);

      expect(calls).toBe(1);
      const files = await readdir(dir);
      expect(files.some((file) => file.endsWith(".bin"))).toBe(true);
      expect(files.some((file) => file.endsWith(".json"))).toBe(true);

      const dirStat = await stat(dir);
      expect(dirStat.mode & 0o077).toBe(0);

      for (const file of files) {
        const fileStat = await stat(path.join(dir, file));
        expect(fileStat.mode & 0o077).toBe(0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads large cached attachments back from disk without re-downloading", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    let calls = 0;

    const download = buildExperimentalDownloadForAnthropicFallback({
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
      cacheDir: dir,
      downloadUrl: async () => {
        calls += 1;
        return {
          data: new Uint8Array(9 * 1024 * 1024),
          mediaType: "application/pdf",
        };
      },
    });

    try {
      expect(download).toBeDefined();

      const request = [
        {
          url: new URL("https://example.com/large-report.pdf?test=disk-cache"),
          isUrlSupportedByModel: true,
        },
      ];

      const first = await download!(request);
      const second = await download!(request);

      expect(calls).toBe(1);
      expect(second).toEqual(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resizes oversized images to fit anthropic fallback limits", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    let downloadCalls = 0;
    let fitCalls = 0;

    const download = buildExperimentalDownloadForAnthropicFallback({
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
      cacheDir: dir,
      downloadUrl: async () => {
        downloadCalls += 1;
        return {
          data: new Uint8Array(6 * 1024 * 1024),
          mediaType: "image/png",
        };
      },
      fitImage: async () => {
        fitCalls += 1;
        return {
          data: new Uint8Array([1, 2, 3, 4]),
          mediaType: "image/jpeg",
        };
      },
    });

    try {
      expect(download).toBeDefined();

      const request = [
        {
          url: new URL("https://example.com/huge-image.png?test=resize"),
          isUrlSupportedByModel: true,
        },
      ];

      const first = await download!(request);
      const second = await download!(request);

      expect(downloadCalls).toBe(1);
      expect(fitCalls).toBe(1);
      expect(first).toEqual([
        {
          data: new Uint8Array([1, 2, 3, 4]),
          mediaType: "image/jpeg",
        },
      ]);
      expect(second).toEqual(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caches oversize image failures to avoid repeated downloads", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    let downloadCalls = 0;
    let fitCalls = 0;

    const download = buildExperimentalDownloadForAnthropicFallback({
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
      cacheDir: dir,
      downloadUrl: async () => {
        downloadCalls += 1;
        return {
          data: new Uint8Array(6 * 1024 * 1024),
          mediaType: "image/png",
        };
      },
      fitImage: async () => {
        fitCalls += 1;
        return null;
      },
    });

    try {
      expect(download).toBeDefined();

      const request = [
        {
          url: new URL("https://example.com/too-big-image.png?test=oversize"),
          isUrlSupportedByModel: true,
        },
      ];

      await expect(download!(request)).rejects.toThrow("Image attachment too large");
      await expect(download!(request)).rejects.toThrow("Image attachment too large");
      expect(downloadCalls).toBe(1);
      expect(fitCalls).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not build a download hook when routing is pinned away from fallback providers", () => {
    const download = buildExperimentalDownloadForAnthropicFallback({
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          only: ["anthropic"],
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
    });

    expect(download).toBeUndefined();
  });
});

describe("resolveSessionAdditionalPrompts", () => {
  it("keeps literal prompts and drops empty entries", async () => {
    const prompts = await resolveSessionAdditionalPrompts({
      entries: ["  Keep answers short.  ", "\n\n", "   "],
    });

    expect(prompts).toEqual(["Keep answers short."]);
  });

  it("loads file:// prompts with filename and location header", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-runner-prompts-"));
    try {
      const memoPath = path.join(dir, "session-notes.md");
      await writeFile(memoPath, "be strict about scope\n", "utf8");

      const prompts = await resolveSessionAdditionalPrompts({
        entries: [pathToFileURL(memoPath).toString()],
      });

      expect(prompts).toEqual([`# session-notes.md (${memoPath})\nbe strict about scope`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips unreadable file prompts and reports a warning", async () => {
    const warnings: string[] = [];

    const prompts = await resolveSessionAdditionalPrompts({
      entries: ["file:///tmp/does-not-exist-session-prompt.md"],
      onWarn: (warning) => warnings.push(warning.reason),
    });

    expect(prompts).toEqual([]);
    expect(warnings).toEqual(["read_failed"]);
  });
});

describe("appendAdditionalSessionMemoBlock", () => {
  it("appends Additional Session Memo at the end", () => {
    const out = appendAdditionalSessionMemoBlock("Base prompt", ["Line one", "Line two"]);

    expect(out).toBe("Base prompt\n\nAdditional Session Memo:\nLine one\n\nLine two");
  });

  it("omits the block when combined memo is empty", () => {
    const out = appendAdditionalSessionMemoBlock("Base prompt", ["  ", "\n\n"]);
    expect(out).toBe("Base prompt");
  });
});

describe("appendConfiguredAliasPromptBlock", () => {
  it("appends sorted user and session aliases with ids and comments", () => {
    const out = appendConfiguredAliasPromptBlock({
      baseSystemPrompt: "Base prompt",
      cfg: {
        entity: {
          users: {
            Stanley: { discord: "u1", comment: "Primary operator" },
            alice: { discord: "u2" },
          },
          sessions: {
            discord: {
              ops: { discord: "c1", comment: "Deploy coordination" },
              Deployments: "c2",
            },
          },
        },
      } as Pick<CoreConfig, "entity">,
      coreConfigPath: "/tmp/core-config.yaml",
    });

    expect(out).toContain("Configured Aliases (Discord):");
    expect(out).toContain("- @alice (discord, u2)");
    expect(out).toContain("- @Stanley (discord, u1): Primary operator");
    expect(out).toContain("- #Deployments (discord, c2)");
    expect(out).toContain("- #ops (discord, c1): Deploy coordination");
    expect(out).not.toContain("read /tmp/core-config.yaml");
  });

  it("points to core-config when alias sections are truncated", () => {
    const out = appendConfiguredAliasPromptBlock({
      baseSystemPrompt: "",
      cfg: {
        entity: {
          users: {
            alice: { discord: "u1" },
            bob: { discord: "u2" },
          },
          sessions: {
            discord: {
              dev: "c1",
              ops: "c2",
            },
          },
        },
      } as Pick<CoreConfig, "entity">,
      coreConfigPath: "/tmp/core-config.yaml",
      maxUserAliases: 1,
      maxSessionAliases: 1,
    });

    expect(out).toContain("- @alice (discord, u1)");
    expect(out).not.toContain("- @bob (discord, u2)");
    expect(out).toContain("- #dev (discord, c1)");
    expect(out).not.toContain("- #ops (discord, c2)");
    expect(out).toContain("read /tmp/core-config.yaml");
  });

  it("handles configs with user aliases but no session aliases", () => {
    const out = appendConfiguredAliasPromptBlock({
      baseSystemPrompt: "Base prompt",
      cfg: {
        entity: {
          users: {
            alice: { discord: "u1" },
          },
        },
      } as unknown as Pick<CoreConfig, "entity">,
    });

    expect(out).toContain("- @alice (discord, u1)");
    expect(out).not.toContain("Sessions:");
  });
});

describe("heartbeat overlays", () => {
  it("adds ordinary-session request metadata when heartbeat is enabled", () => {
    const cfg = {
      surface: {
        heartbeat: {
          enabled: true,
          cron: "*/30 * * * *",
          quietAfterActivityMs: 300000,
          retryBusyMs: 60000,
        },
      },
    } as unknown as Pick<CoreConfig, "surface">;

    const overlay = buildHeartbeatOverlayForRequest({
      cfg,
      requestId: "discord:1:2",
      sessionId: "chan",
      runProfile: "primary",
      nowMs: 0,
    });

    expect(overlay).toContain("Heartbeat Context");
    expect(overlay).toContain("sourceSessionId='chan'");
    expect(overlay).toContain("sourceRequestId='discord:1:2'");
  });

  it("adds heartbeat quiet-hours context for heartbeat session", () => {
    const cfg = {
      surface: {
        heartbeat: {
          enabled: true,
          cron: "*/30 * * * *",
          quietAfterActivityMs: 300000,
          retryBusyMs: 60000,
          softQuietHours: {
            start: "23:00",
            end: "08:00",
            timezone: "UTC",
          },
        },
      },
    } as unknown as Pick<CoreConfig, "surface">;

    const overlay = buildHeartbeatOverlayForRequest({
      cfg,
      requestId: "heartbeat:1",
      sessionId: "__heartbeat__",
      runProfile: "primary",
      nowMs: Date.UTC(2026, 2, 11, 23, 30, 0),
    });

    expect(overlay).toContain("Heartbeat Quiet Hours");
    expect(overlay).toContain("Current local quiet-hours state: inside");
  });
});

describe("buildPersistedHeartbeatMessages", () => {
  it("stores heartbeat summary as a single assistant message", () => {
    expect(buildPersistedHeartbeatMessages("summary")).toEqual([
      { role: "assistant", content: "summary" },
    ]);
  });
});

describe("shouldCancelIdleOnlyGlobalRequest", () => {
  it("cancels when another non-heartbeat session is running", () => {
    type IdleOnlyGlobalState =
      Parameters<typeof shouldCancelIdleOnlyGlobalRequest>[0]["states"] extends ReadonlyMap<
        string,
        infer T
      >
        ? T
        : never;

    const states = new Map<string, IdleOnlyGlobalState>([
      [
        "discord-session",
        {
          running: true,
          agent: null,
          queue: [],
          activeRequestId: "req:1",
          activeRun: null,
          compactedToolCallIds: new Set<string>(),
        },
      ],
      [
        "__heartbeat__",
        {
          running: false,
          agent: null,
          queue: [],
          activeRequestId: null,
          activeRun: null,
          compactedToolCallIds: new Set<string>(),
        },
      ],
    ]);

    expect(
      shouldCancelIdleOnlyGlobalRequest({
        runPolicy: "idle_only_global",
        sessionId: "__heartbeat__",
        states,
      }),
    ).toBe(true);
  });

  it("cancels when the heartbeat session is already running", () => {
    type IdleOnlyGlobalState =
      Parameters<typeof shouldCancelIdleOnlyGlobalRequest>[0]["states"] extends ReadonlyMap<
        string,
        infer T
      >
        ? T
        : never;

    const states = new Map<string, IdleOnlyGlobalState>([
      [
        "__heartbeat__",
        {
          running: true,
          agent: null,
          queue: [],
          activeRequestId: "heartbeat:1",
          activeRun: null,
          compactedToolCallIds: new Set<string>(),
        },
      ],
    ]);

    expect(
      shouldCancelIdleOnlyGlobalRequest({
        runPolicy: "idle_only_global",
        sessionId: "__heartbeat__",
        states,
      }),
    ).toBe(true);
  });
});

describe("shouldCancelRunPolicyRequest", () => {
  it("cancels idle_only_session when the session is already running", () => {
    type RunnerState =
      Parameters<typeof shouldCancelRunPolicyRequest>[0]["states"] extends ReadonlyMap<
        string,
        infer T
      >
        ? T
        : never;

    const states = new Map<string, RunnerState>([
      [
        "chan",
        {
          running: true,
          agent: null,
          queue: [],
          activeRequestId: "req:1",
          activeRun: null,
          compactedToolCallIds: new Set<string>(),
        },
      ],
    ]);

    expect(
      shouldCancelRunPolicyRequest({
        runPolicy: "idle_only_session",
        sessionId: "chan",
        states,
      }),
    ).toBe(true);
  });
});

describe("maybeAppendResponseCommentaryPrompt", () => {
  it("appends commentary guidance for openai provider when enabled", () => {
    const out = maybeAppendResponseCommentaryPrompt({
      baseSystemPrompt: "Base prompt",
      provider: "openai",
      responseCommentary: true,
    });

    expect(out).toBe(`Base prompt\n\n${RESPONSE_COMMENTARY_INSTRUCTIONS}`);
  });

  it("appends commentary guidance for codex provider when enabled", () => {
    const out = maybeAppendResponseCommentaryPrompt({
      baseSystemPrompt: "Base prompt",
      provider: "codex",
      responseCommentary: true,
    });

    expect(out).toBe(`Base prompt\n\n${RESPONSE_COMMENTARY_INSTRUCTIONS}`);
  });

  it("does not append when disabled", () => {
    const out = maybeAppendResponseCommentaryPrompt({
      baseSystemPrompt: "Base prompt",
      provider: "openai",
      responseCommentary: false,
    });

    expect(out).toBe("Base prompt");
  });

  it("does not append for unsupported providers", () => {
    const out = maybeAppendResponseCommentaryPrompt({
      baseSystemPrompt: "Base prompt",
      provider: "openrouter",
      responseCommentary: true,
    });

    expect(out).toBe("Base prompt");
  });
});

describe("withBlankLineBetweenTextParts", () => {
  it("adds a blank line when text part id changes", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.",
      delta: "Part two.",
      partChanged: true,
    });

    expect(out).toBe("\n\nPart two.");
  });

  it("extends an existing trailing newline to a blank line", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.\n",
      delta: "Part two.",
      partChanged: true,
    });

    expect(out).toBe("\nPart two.");
  });

  it("does not duplicate existing blank-line separation", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.\n\n",
      delta: "Part two.",
      partChanged: true,
    });

    expect(out).toBe("Part two.");
  });

  it("keeps provider whitespace when delta already starts with whitespace", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.",
      delta: "\nPart two.",
      partChanged: true,
    });

    expect(out).toBe("\nPart two.");
  });

  it("does not change deltas when part did not change", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.",
      delta: "Part two.",
      partChanged: false,
    });

    expect(out).toBe("Part two.");
  });

  it("supports restart recovery boundaries with prior visible text", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Sure! Triggering now - see you on the other side.",
      delta: "...and I'm back.",
      partChanged: true,
    });

    expect(out).toBe("\n\n...and I'm back.");
  });

  it("does not add separator when there is no prior visible text", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "",
      delta: "Fresh reply.",
      partChanged: true,
    });

    expect(out).toBe("Fresh reply.");
  });
});

describe("assistant text part boundary accumulation", () => {
  it("separates streamed output and final text when a resumed text block reuses the same part id", () => {
    const state = createAssistantTextPartBoundaryState(undefined);
    const streamed: string[] = [];
    let finalText = "";

    markAssistantTextPartStarted(state, "text-0");
    const firstDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "...update the notes.",
    });
    streamed.push(firstDelta);
    finalText += firstDelta;
    markAssistantTextPartEnded(state, "text-0");

    markAssistantTextPartStarted(state, "text-0");
    const secondDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "Works without the old patch...",
    });
    streamed.push(secondDelta);
    finalText += secondDelta;
    markAssistantTextPartEnded(state, "text-0");

    markAssistantTextPartStarted(state, "text-0");
    const thirdDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "Now let me update the discovery.search entry...",
    });
    streamed.push(thirdDelta);
    finalText += thirdDelta;

    expect(streamed).toEqual([
      "...update the notes.",
      "\n\nWorks without the old patch...",
      "\n\nNow let me update the discovery.search entry...",
    ]);
    expect(finalText).toBe(
      "...update the notes.\n\nWorks without the old patch...\n\nNow let me update the discovery.search entry...",
    );
  });

  it("separates resumed streamed output from recovered visible text before persistence", () => {
    const state = createAssistantTextPartBoundaryState("Done. Updated TOOLS.md...");
    const streamed: string[] = [];
    let finalText = "";

    markAssistantTextPartStarted(state, "text-0");
    const delta = consumeAssistantTextDelta({
      state,
      finalText,
      recoveryPartialText: "Done. Updated TOOLS.md...",
      partId: "text-0",
      delta: "Now let me also write a daily note...",
    });
    streamed.push(delta);
    finalText += delta;

    expect(streamed).toEqual(["\n\nNow let me also write a daily note..."]);
    expect(finalText).toBe("\n\nNow let me also write a daily note...");
  });

  it("keeps a new text-block boundary pending across whitespace-only deltas", () => {
    const state = createAssistantTextPartBoundaryState(undefined);
    const streamed: string[] = [];
    let finalText = "";

    markAssistantTextPartStarted(state, "text-0");
    const firstDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "...update the notes.",
    });
    streamed.push(firstDelta);
    finalText += firstDelta;
    markAssistantTextPartEnded(state, "text-0");

    markAssistantTextPartStarted(state, "text-0");
    const whitespaceDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "\n",
    });
    streamed.push(whitespaceDelta);
    finalText += whitespaceDelta;

    const textDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "Works without the old patch...",
    });
    streamed.push(textDelta);
    finalText += textDelta;

    expect(streamed).toEqual(["...update the notes.", "\n", "\nWorks without the old patch..."]);
    expect(finalText).toBe("...update the notes.\n\nWorks without the old patch...");
  });
});

describe("buildAutoInjectedThreadSearchOverlay", () => {
  it("returns the notice only for primary runs when auto-inject is enabled", () => {
    const baseCfg = parseCoreConfigV1ToUniversal({});
    const cfg: CoreConfig = {
      ...baseCfg,
      conversation: {
        ...baseCfg.conversation,
        thread: {
          ...baseCfg.conversation.thread,
          autoInject: {
            ...baseCfg.conversation.thread.autoInject,
            enabled: true,
          },
        },
      },
    };

    const overlay = buildAutoInjectedThreadSearchOverlay({ cfg, runProfile: "primary" });

    expect(overlay).toBe(
      "Notice on auto-injected possibly related threads:\nThese search results may appear before your reply, treat them as retrieval hints only, and use them when relevant to the current context.",
    );
    expect(
      buildAutoInjectedThreadSearchOverlay({ cfg: baseCfg, runProfile: "primary" }),
    ).toBeNull();
    expect(buildAutoInjectedThreadSearchOverlay({ cfg, runProfile: "explore" })).toBeNull();
  });
});

describe("buildSurfaceMetadataOverlay", () => {
  it("returns null when no user message starts with surface metadata", () => {
    const overlay = buildSurfaceMetadataOverlay([
      { role: "user", content: "plain user text" },
      { role: "assistant", content: '<LILAC_META:v1>{"platform":"discord"}</LILAC_META:v1>' },
    ] satisfies ModelMessage[]);

    expect(overlay).toBeNull();
  });

  it("returns instructions when a user message starts with surface metadata", () => {
    const overlay = buildSurfaceMetadataOverlay([
      {
        role: "user",
        content:
          '<LILAC_META:v1>{"platform":"discord","user_id":"u1","message_id":"m1"}</LILAC_META:v1>\nhello',
      },
    ] satisfies ModelMessage[]);

    expect(overlay).toContain("trusted injected tag");
    expect(overlay).toContain("first line of a user-message block");
    expect(overlay).toContain("&lt;LILAC_META:v1>");
  });

  it("returns instructions for slash-command metadata without message id", () => {
    const overlay = buildSurfaceMetadataOverlay([
      {
        role: "user",
        content: `${formatSurfaceMetadataLine({
          platform: "discord",
          user_id: "u1",
          user_name: "Alice",
          message_time: new Date(1_234).toISOString(),
        })}\n/lilac:tarot 3 focus`,
      },
    ] satisfies ModelMessage[]);

    expect(overlay).toContain("trusted injected tag");
    expect(overlay).toContain("first line of a user-message block");
  });
});

describe("mergeToSingleUserMessage", () => {
  it("keeps all user text when merging plain-text messages", () => {
    const out = mergeToSingleUserMessage([
      { role: "user", content: "B one" },
      { role: "assistant", content: "ignored" },
      { role: "user", content: "C two" },
      { role: "user", content: "D steer" },
    ] satisfies ModelMessage[]);

    expect(out.role).toBe("user");
    expect(typeof out.content).toBe("string");
    expect(out.content).toContain("B one");
    expect(out.content).toContain("C two");
    expect(out.content).toContain("D steer");
  });

  it("preserves later metadata lines at merged block boundaries", () => {
    const out = mergeToSingleUserMessage([
      {
        role: "user",
        content: '<LILAC_META:v1>{"platform":"discord","message_id":"m1"}</LILAC_META:v1>\nfirst',
      },
      {
        role: "user",
        content: '<LILAC_META:v1>{"platform":"discord","message_id":"m2"}</LILAC_META:v1>\nsecond',
      },
    ] satisfies ModelMessage[]);

    expect(out.role).toBe("user");
    expect(typeof out.content).toBe("string");
    expect(out.content).toContain("m1");
    expect(out.content).toContain(
      '\n\n<LILAC_META:v1>{"platform":"discord","message_id":"m2"}</LILAC_META:v1>\nsecond',
    );
  });

  it("preserves buffered multipart content and steering text in one merged user message", () => {
    const out = mergeToSingleUserMessage([
      {
        role: "user",
        content: [
          { type: "text", text: "B with image" },
          { type: "file", data: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
        ],
      },
      { role: "user", content: "D steer" },
    ] satisfies ModelMessage[]);

    expect(out.role).toBe("user");
    expect(Array.isArray(out.content)).toBe(true);
    expect(
      Array.isArray(out.content) &&
        out.content.some((part) => part.type === "text" && part.text.includes("B with image")),
    ).toBe(true);
    expect(
      Array.isArray(out.content) &&
        out.content.some((part) => part.type === "text" && part.text.includes("D steer")),
    ).toBe(true);
    expect(Array.isArray(out.content) && out.content.some((part) => part.type === "file")).toBe(
      true,
    );
  });

  it("preserves steering multipart content and buffered text in one merged user message", () => {
    const out = mergeToSingleUserMessage([
      { role: "user", content: "B one" },
      {
        role: "user",
        content: [
          { type: "text", text: "D interrupt with image" },
          { type: "file", data: new Uint8Array([7, 8]), mediaType: "image/jpeg" },
        ],
      },
    ] satisfies ModelMessage[]);

    expect(out.role).toBe("user");
    expect(Array.isArray(out.content)).toBe(true);
    expect(
      Array.isArray(out.content) &&
        out.content.some((part) => part.type === "text" && part.text.includes("B one")),
    ).toBe(true);
    expect(
      Array.isArray(out.content) &&
        out.content.some((part) => part.type === "text" && part.text.includes("D interrupt")),
    ).toBe(true);
    expect(Array.isArray(out.content) && out.content.some((part) => part.type === "file")).toBe(
      true,
    );
  });
});

describe("custom command failures", () => {
  it("builds persisted finalText from the bounded normalized error", () => {
    const finalText = buildCustomCommandFailureFinalText({
      commandText: "/fixture",
      normalizedOutput: {
        type: "error-text",
        value: "bounded error [tool result truncated: 100 characters omitted]",
      },
    });

    expect(finalText).toBe(
      "Error running /fixture: bounded error [tool result truncated: 100 characters omitted]",
    );
  });
});

describe("createDeferredSubagentManager", () => {
  it("bounds outstanding finalText in graceful-restart snapshots", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const parentHeaders = {
      request_id: "parent-request",
      session_id: "parent-session",
      request_client: "discord" as const,
    };
    const manager = createDeferredSubagentManager({
      bus,
      logger: createLogger({ module: "bus-agent-runner-test" }),
      parentHeaders,
      normalizeFinalTextForSnapshot: (finalText) => `bounded:${finalText.slice(-4)}`,
    });

    await manager.register({
      profile: "explore",
      sessionName: "explore-snapshot",
      task: "Map auth flow",
      timeoutMs: 5_000,
      depth: 1,
      parentRequestId: parentHeaders.request_id,
      parentSessionId: parentHeaders.session_id,
      parentRequestClient: parentHeaders.request_client,
      parentToolCallId: "tool-1",
      childRequestId: "child-request",
      childSessionId: "child-session",
      parentHeaders,
      childHeaders: {
        request_id: "child-request",
        session_id: "child-session",
        request_client: "unknown",
        parent_request_id: parentHeaders.request_id,
        parent_tool_call_id: "tool-1",
        subagent_profile: "explore",
        subagent_depth: "1",
      },
      initialMessages: [{ role: "user", content: "Map auth flow" }],
    });
    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "unbounded-child-final-text" },
      { headers: { ...parentHeaders, request_id: "child-request", session_id: "child-session" } },
    );
    await waitFor(
      () => manager.buildRecoveryState()?.outstanding[0]?.finalText.startsWith("bounded:") === true,
    );

    expect(manager.buildRecoveryState()?.outstanding[0]?.finalText).toBe("bounded:text");
    await manager.stop();
  });

  it("replays child completion that happened before restore reattach", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const parentHeaders = {
      request_id: "parent-request",
      session_id: "parent-session",
      request_client: "discord" as const,
    };

    const logger = createLogger({ module: "bus-agent-runner-test" });

    const manager = createDeferredSubagentManager({
      bus,
      logger,
      parentHeaders,
    });

    await manager.register({
      profile: "explore",
      sessionName: "explore-test0001",
      task: "Map auth flow",
      timeoutMs: 5_000,
      depth: 1,
      parentRequestId: parentHeaders.request_id,
      parentSessionId: parentHeaders.session_id,
      parentRequestClient: parentHeaders.request_client,
      parentToolCallId: "tool-1",
      childRequestId: "child-request",
      childSessionId: "sub:parent-session:named:legacy-session",
      parentHeaders,
      childHeaders: {
        request_id: "child-request",
        session_id: "sub:parent-session:named:legacy-session",
        request_client: "unknown",
        parent_request_id: parentHeaders.request_id,
        parent_tool_call_id: "tool-1",
        subagent_profile: "explore",
        subagent_depth: "1",
      },
      initialMessages: [{ role: "user", content: "Map auth flow" }],
    });

    const recovery = manager.buildRecoveryState();
    expect(recovery).toBeDefined();
    delete recovery?.outstanding[0]?.sessionName;
    await manager.stop();

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "done after restart" },
      {
        headers: {
          request_id: "child-request",
          session_id: "sub:parent-session:named:legacy-session",
          request_client: "unknown",
        },
      },
    );
    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "resolved" },
      {
        headers: {
          request_id: "child-request",
          session_id: "sub:parent-session:named:legacy-session",
          request_client: "unknown",
        },
      },
    );

    const restored = createDeferredSubagentManager({
      bus,
      logger,
      parentHeaders,
    });
    await restored.restore(recovery);

    await waitFor(() => restored.hasBufferedCompletions());

    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      messages: [{ role: "user", content: "hello" }],
    });

    const injected = await restored.injectBuffered(agent);
    expect(injected).toBe(true);
    expect(agent.state.messages).toHaveLength(3);

    const toolMessage = agent.state.messages[2];
    expect(toolMessage?.role).toBe("tool");
    if (toolMessage?.role !== "tool") throw new Error("expected tool message");
    const toolResult = toolMessage.content[0];
    expect(toolResult?.type).toBe("tool-result");
    if (toolResult?.type !== "tool-result") throw new Error("expected tool result");
    expect(toolResult.output).toEqual({
      type: "json",
      value: {
        ok: true,
        mode: "deferred",
        status: "resolved",
        profile: "explore",
        sessionName: "legacy-session",
        finalText: "done after restart",
      },
    });

    await restored.stop();
  });

  it("does not miss a child completion that lands before the parent starts waiting", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const parentHeaders = {
      request_id: "parent-request",
      session_id: "parent-session",
      request_client: "discord" as const,
    };

    const logger = createLogger({ module: "bus-agent-runner-test" });

    const manager = createDeferredSubagentManager({
      bus,
      logger,
      parentHeaders,
    });

    await manager.register({
      profile: "explore",
      sessionName: "explore-test0002",
      task: "Map auth flow",
      timeoutMs: 5_000,
      depth: 1,
      parentRequestId: parentHeaders.request_id,
      parentSessionId: parentHeaders.session_id,
      parentRequestClient: parentHeaders.request_client,
      parentToolCallId: "tool-1",
      childRequestId: "child-request",
      childSessionId: "child-session",
      parentHeaders,
      childHeaders: {
        request_id: "child-request",
        session_id: "child-session",
        request_client: "unknown",
        parent_request_id: parentHeaders.request_id,
        parent_tool_call_id: "tool-1",
        subagent_profile: "explore",
        subagent_depth: "1",
      },
      initialMessages: [{ role: "user", content: "Map auth flow" }],
    });

    const waitState = manager.snapshotWaitState();
    expect(waitState.hasOutstandingChildren).toBe(true);

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "done before wait registered" },
      {
        headers: {
          request_id: "child-request",
          session_id: "child-session",
          request_client: "unknown",
        },
      },
    );
    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "resolved" },
      {
        headers: {
          request_id: "child-request",
          session_id: "child-session",
          request_client: "unknown",
        },
      },
    );

    await waitFor(() => manager.hasBufferedCompletions());
    await manager.waitForSignalSince(waitState.signalVersion);

    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      messages: [{ role: "user", content: "hello" }],
    });

    const injected = await manager.injectBuffered(agent);
    expect(injected).toBe(true);
    expect(manager.hasOutstandingChildren()).toBe(false);

    const toolMessage = agent.state.messages[2];
    expect(toolMessage?.role).toBe("tool");
    if (toolMessage?.role !== "tool") throw new Error("expected tool message");
    const toolResult = toolMessage.content[0];
    expect(toolResult?.type).toBe("tool-result");
    if (toolResult?.type !== "tool-result") throw new Error("expected tool result");
    expect(toolResult.output).toEqual({
      type: "json",
      value: {
        ok: true,
        mode: "deferred",
        status: "resolved",
        profile: "explore",
        sessionName: "explore-test0002",
        finalText: "done before wait registered",
      },
    });

    await manager.stop();
  });

  it("does not deadlock when a resolved lifecycle event settles from its own subscription callback", async () => {
    const raw = createInMemoryRawBusWithStopWaitingForActiveHandler();
    const bus = createLilacBus(raw);
    const parentHeaders = {
      request_id: "parent-request",
      session_id: "parent-session",
      request_client: "discord" as const,
    };

    const logger = createLogger({ module: "bus-agent-runner-test" });

    const manager = createDeferredSubagentManager({
      bus,
      logger,
      parentHeaders,
    });

    await manager.register({
      profile: "explore",
      sessionName: "explore-test0003",
      task: "Map auth flow",
      timeoutMs: 5_000,
      depth: 1,
      parentRequestId: parentHeaders.request_id,
      parentSessionId: parentHeaders.session_id,
      parentRequestClient: parentHeaders.request_client,
      parentToolCallId: "tool-1",
      childRequestId: "child-request",
      childSessionId: "child-session",
      parentHeaders,
      childHeaders: {
        request_id: "child-request",
        session_id: "child-session",
        request_client: "unknown",
        parent_request_id: parentHeaders.request_id,
        parent_tool_call_id: "tool-1",
        subagent_profile: "explore",
        subagent_depth: "1",
      },
      initialMessages: [{ role: "user", content: "Map auth flow" }],
    });

    const waitState = manager.snapshotWaitState();
    const waitPromise = manager.waitForSignalSince(waitState.signalVersion);

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "resolved without deadlock" },
      {
        headers: {
          request_id: "child-request",
          session_id: "child-session",
          request_client: "unknown",
        },
      },
    );

    const publishResolved = bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "resolved" },
      {
        headers: {
          request_id: "child-request",
          session_id: "child-session",
          request_client: "unknown",
        },
      },
    );

    const publishResult = await Promise.race([
      publishResolved.then(() => "resolved" as const),
      Bun.sleep(100).then(() => "timeout" as const),
    ]);
    expect(publishResult).toBe("resolved");

    const waitResult = await Promise.race([
      waitPromise.then(() => "resolved" as const),
      Bun.sleep(100).then(() => "timeout" as const),
    ]);
    expect(waitResult).toBe("resolved");

    expect(manager.hasBufferedCompletions()).toBe(true);
    expect(manager.hasOutstandingChildren()).toBe(false);

    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      messages: [{ role: "user", content: "hello" }],
    });

    const injected = await manager.injectBuffered(agent);
    expect(injected).toBe(true);

    const toolMessage = agent.state.messages[2];
    expect(toolMessage?.role).toBe("tool");
    if (toolMessage?.role !== "tool") throw new Error("expected tool message");
    const toolResult = toolMessage.content[0];
    expect(toolResult?.type).toBe("tool-result");
    if (toolResult?.type !== "tool-result") throw new Error("expected tool result");
    expect(toolResult.output).toEqual({
      type: "json",
      value: {
        ok: true,
        mode: "deferred",
        status: "resolved",
        profile: "explore",
        sessionName: "explore-test0003",
        finalText: "resolved without deadlock",
      },
    });

    await manager.stop();
  });

  it("does not duplicate restored child text when replay settles before response text", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const parentHeaders = {
      request_id: "parent-request",
      session_id: "parent-session",
      request_client: "discord" as const,
    };

    const logger = createLogger({ module: "bus-agent-runner-test" });

    const manager = createDeferredSubagentManager({
      bus,
      logger,
      parentHeaders,
    });

    await manager.register({
      profile: "explore",
      sessionName: "explore-test0004",
      task: "Map auth flow",
      timeoutMs: 5_000,
      depth: 1,
      parentRequestId: parentHeaders.request_id,
      parentSessionId: parentHeaders.session_id,
      parentRequestClient: parentHeaders.request_client,
      parentToolCallId: "tool-1",
      childRequestId: "child-request",
      childSessionId: "child-session",
      parentHeaders,
      childHeaders: {
        request_id: "child-request",
        session_id: "child-session",
        request_client: "unknown",
        parent_request_id: parentHeaders.request_id,
        parent_tool_call_id: "tool-1",
        subagent_profile: "explore",
        subagent_depth: "1",
      },
      initialMessages: [{ role: "user", content: "Map auth flow" }],
    });

    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "a" },
      {
        headers: {
          request_id: "child-request",
          session_id: "child-session",
          request_client: "unknown",
        },
      },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "b" },
      {
        headers: {
          request_id: "child-request",
          session_id: "child-session",
          request_client: "unknown",
        },
      },
    );

    await waitFor(() => manager.buildRecoveryState()?.outstanding[0]?.finalText === "ab");

    const recovery = manager.buildRecoveryState();
    expect(recovery?.outstanding[0]?.finalText).toBe("ab");
    await manager.stop();

    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "resolved" },
      {
        headers: {
          request_id: "child-request",
          session_id: "child-session",
          request_client: "unknown",
        },
      },
    );

    const restored = createDeferredSubagentManager({
      bus,
      logger,
      parentHeaders,
    });
    await restored.restore(recovery);

    await waitFor(() => restored.hasBufferedCompletions());

    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      messages: [{ role: "user", content: "hello" }],
    });

    const injected = await restored.injectBuffered(agent);
    expect(injected).toBe(true);

    const toolMessage = agent.state.messages[2];
    expect(toolMessage?.role).toBe("tool");
    if (toolMessage?.role !== "tool") throw new Error("expected tool message");
    const toolResult = toolMessage.content[0];
    expect(toolResult?.type).toBe("tool-result");
    if (toolResult?.type !== "tool-result") throw new Error("expected tool result");
    expect(toolResult.output).toEqual({
      type: "json",
      value: {
        ok: true,
        mode: "deferred",
        status: "resolved",
        profile: "explore",
        sessionName: "explore-test0004",
        finalText: "ab",
      },
    });

    await restored.stop();
  });
});
