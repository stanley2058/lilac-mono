import { generatedMessageMetadata } from "@stanley2058/lilac-agent";
import { describe, expect, it } from "bun:test";
import { decodeCorePrimaryLineageV2 } from "@stanley2058/lilac-event-bus";
import { parseCoreConfigV2ToUniversal, type CoreConfig } from "@stanley2058/lilac-utils";
import { type ModelMessage } from "ai";
import { Result } from "better-result";
import type {
  ConversationThreadAutoInjectUsageAccumulator,
  ConversationThreadToolService,
} from "../../../src/conversation/thread-service";
import {
  createDecisionAutoInjectEvaluator,
  createDecisionAutoInjectEvaluatorForModel,
} from "../../../src/conversation/thread-auto-inject-decision";
import {
  AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH,
  appendAutoInjectedThreadSearchLineage,
  degradeCorePrimaryLineageForMutation,
  buildAutoInjectedThreadSearchMessages,
  maybeBuildAutoInjectedThreadSearchMessages,
  measureMeaningfulTextUnits,
  shouldRunAutoInjectedThreadSearch,
} from "../../../src/surface/bridge/bus-agent-runner";
import { projectStoredMessagesV1 } from "../../../src/transcript/stored-message-materialization";
import { hashCanonicalStoredMessagesV2 } from "../../../src/transcript/transcript-persistence-codec";
import { formatSurfaceMetadataLine } from "../../../src/surface/bridge/surface-metadata";
import {
  transcriptResultValue,
  buildCoreLineageManifestV2,
  formatExpectedLocalThreadTimeRange,
  autoInjectPlanForQuery,
  readGeneratedPayload,
} from "./bus-agent-runner-test-support";
import { useTestBlobStore } from "./bus-agent-runner-test-support";

useTestBlobStore();

describe("buildAutoInjectedThreadSearchMessages", () => {
  it("builds slim auto-injected thread search metadata messages", () => {
    const messages = buildAutoInjectedThreadSearchMessages({
      toolCallId: "auto-thread-1",
      entries: [
        {
          surface: "discord" as const,
          threadId: "thread-1",
          title: "Short thread title",
          brief: "Short thread brief",
          timeRange: "2026/06/28 12:01 - 2026/06/28 13:23",
        },
      ],
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(generatedMessageMetadata(messages[0]!)).toMatchObject({
      kind: "conversation_recall",
      id: "auto-thread-1",
      threadIds: ["thread-1"],
    });
    const result = {
      output: { type: "json", value: { entries: readGeneratedPayload(messages).entries } },
    };
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [
          {
            surface: "discord" as const,
            threadId: "thread-1",
            title: "Short thread title",
            brief: "Short thread brief",
            timeRange: "2026/06/28 12:01 - 2026/06/28 13:23",
          },
        ],
      },
    });
  });

  it("records the recalled entry and tells the model where its subject starts", () => {
    const messages = buildAutoInjectedThreadSearchMessages({
      toolCallId: "auto-thread-2",
      entries: [
        {
          surface: "discord" as const,
          threadId: "thread-1",
          entryId: "thread-1#1",
          offset: 12,
          title: "Second subject",
        },
      ],
    });

    expect(generatedMessageMetadata(messages[0]!)).toMatchObject({ threadIds: ["thread-1#1"] });
    expect(readGeneratedPayload(messages).entries).toEqual([
      { surface: "discord", threadId: "thread-1", offset: 12, title: "Second subject" },
    ]);
  });

  it("appends one deterministic unsliceable synthetic segment after the current boundary", () => {
    const sourceMessages = [
      { role: "user", content: "historical" },
      { role: "user", content: "current" },
    ] satisfies ModelMessage[];
    const source = buildCoreLineageManifestV2(
      [
        {
          atoms: [
            {
              kind: "surface",
              requestClient: "discord",
              surfaceId: "discord:channel",
              sessionId: "channel",
              messageId: "historical",
            },
          ],
          canonicalMessages: sourceMessages.slice(0, 1),
        },
        {
          atoms: [
            {
              kind: "surface",
              requestClient: "discord",
              surfaceId: "discord:channel",
              sessionId: "channel",
              messageId: "current",
            },
          ],
          canonicalMessages: sourceMessages.slice(1),
        },
      ],
      { currentSegmentIndex: 1 },
    );
    const injected = buildAutoInjectedThreadSearchMessages({
      toolCallId: "auto-thread-deterministic",
      entries: [{ surface: "discord" as const, threadId: "thread-1", title: "Relevant thread" }],
    });
    const storedInjected = transcriptResultValue(projectStoredMessagesV1(injected));

    const first = appendAutoInjectedThreadSearchLineage({
      lineage: source,
      canonicalMessages: sourceMessages,
      injectedMessages: injected,
    });
    const second = appendAutoInjectedThreadSearchLineage({
      lineage: source,
      canonicalMessages: sourceMessages,
      injectedMessages: injected,
    });

    expect(first).toEqual(second);
    if (first.state !== "complete") throw new Error("expected complete appended lineage");
    expect(first.currentCanonicalStart).toBe(source.currentCanonicalStart);
    expect(first.segments.slice(0, -1)).toEqual(source.segments);
    const synthetic = first.segments.at(-1)!;
    expect(synthetic).toMatchObject({
      atoms: [
        {
          kind: "synthetic",
          source: "conversation-thread-auto-inject",
          messageDigest: transcriptResultValue(hashCanonicalStoredMessagesV2(storedInjected)).hash,
        },
      ],
      canonicalMessages: storedInjected,
      canonicalStart: sourceMessages.length,
      canonicalEnd: sourceMessages.length + injected.length,
      cumulativeAtomCount: source.segments.at(-1)!.cumulativeAtomCount + 1,
    });
    expect(synthetic.canonicalMessages).toHaveLength(1);
    expect(synthetic.atoms).toHaveLength(1);
    expect(synthetic.atoms[0]?.kind).toBe("synthetic");
    expect(decodeCorePrimaryLineageV2(first, [...sourceMessages, ...injected]).status).toBe("ok");
  });

  it("fails closed for missing, fresh-only, malformed, or unaligned source lineage", () => {
    const canonicalMessages = [{ role: "user", content: "current" }] satisfies ModelMessage[];
    const injectedMessages = buildAutoInjectedThreadSearchMessages({
      toolCallId: "auto-thread-invalid",
      entries: [{ surface: "discord" as const, threadId: "thread-1", title: "Relevant thread" }],
    });
    const complete = buildCoreLineageManifestV2([
      {
        atoms: [
          {
            kind: "surface",
            requestClient: "discord",
            surfaceId: "discord:channel",
            sessionId: "channel",
            messageId: "current",
          },
        ],
        canonicalMessages,
      },
    ]);
    const cases: unknown[] = [
      undefined,
      degradeCorePrimaryLineageForMutation("already-fresh", 0),
      { ...complete, segments: [] },
      complete,
    ];

    expect(
      cases.map((lineage, index) =>
        appendAutoInjectedThreadSearchLineage({
          lineage,
          canonicalMessages:
            index === cases.length - 1
              ? [{ role: "user", content: "transformed" }]
              : canonicalMessages,
          injectedMessages,
        }),
      ),
    ).toEqual(
      cases.map(() => ({
        state: "fresh-only",
        lineageVersion: 2,
        currentCanonicalStart: 0,
        reason: "synthetic-thread-search-insertion",
      })),
    );
  });
});

describe("maybeBuildAutoInjectedThreadSearchMessages", () => {
  it("plans from the latest attachment-only user message without falling back to older text", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
      surface: { discord: { botName: "lilac", allowedChannelIds: ["c1"] } },
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
            expansionMinConfidence: 0.57,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const plannerInputs: Array<
      Parameters<ConversationThreadToolService["planAutoInjectSearch"]>[0]
    > = [];

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "attachment-only",
      raw: {},
      userMessages: [
        {
          role: "user",
          content: "This older message must not be used for planning.",
        },
        {
          role: "user",
          content: [
            {
              type: "file",
              data: new Uint8Array([1, 2, 3]),
              filename: "diagram.png",
              mediaType: "image/png",
            },
          ],
        },
      ],
      conversationThreads: {
        planAutoInjectSearch: async (input) => {
          plannerInputs.push(input);
          return autoInjectPlanForQuery("diagram contents", "Find prior diagram discussions.");
        },
        search: async () => ({
          meta: {
            query: "diagram contents",
            limit: 3,
            mode: "hybrid",
            minScore: 0.1,
            count: 0,
            vectorAvailable: false,
          },
          results: [],
        }),
        metadata: async () => ({ threads: [], missing: [] }),
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
    const plannerInput = plannerInputs[0];
    expect(plannerInput?.text).toBe("");
    expect(Array.isArray(plannerInput?.content)).toBe(true);
    expect(Array.isArray(plannerInput?.content) ? plannerInput.content[0]?.type : null).toBe(
      "file",
    );
  });

  it("treats an empty planner result as a successful retrieval abstention", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
      surface: { discord: { botName: "lilac", allowedChannelIds: ["c1"] } },
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
            expansionMinConfidence: 0.57,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const statuses: Array<{ status: "start" | "end"; ok?: boolean; output?: string }> = [];
    let searchCalls = 0;
    const errors: string[] = [];
    let plannerUsage: ConversationThreadAutoInjectUsageAccumulator | undefined;
    const finishedUsage: Parameters<ConversationThreadAutoInjectUsageAccumulator["finish"]>[0][] =
      [];
    const autoInjectUsage: ConversationThreadAutoInjectUsageAccumulator = {
      recordTiming: () => {},
      recordPlannerUsage: () => {},
      recordEmbeddingUsage: () => {},
      recordDecisionUsage: () => {},
      finish: (usage) => finishedUsage.push(usage),
    };

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "retrieval-abstention",
      raw: {},
      userMessages: [{ role: "user", content: "A long incidental article excerpt" }],
      conversationThreads: {
        planAutoInjectSearch: async (input) => {
          plannerUsage = input.autoInjectUsage;
          return { searches: [] };
        },
        search: async () => {
          searchCalls += 1;
          throw new Error("not used");
        },
        metadata: async () => ({ threads: [], missing: [] }),
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      publishToolStatus: async (status) => {
        statuses.push({
          status: status.status,
          ...(status.ok === undefined ? {} : { ok: status.ok }),
          ...(status.output === undefined ? {} : { output: status.output }),
        });
      },
      onError: (message) => {
        errors.push(message);
      },
      autoInjectUsage,
    });

    expect(messages).toEqual([]);
    expect(searchCalls).toBe(0);
    expect(statuses).toEqual([
      { status: "start" },
      { status: "end", ok: true, output: "No related threads injected." },
    ]);
    expect(errors).toEqual([]);
    expect(plannerUsage).toBe(autoInjectUsage);
    expect(finishedUsage).toEqual([{ status: "abstained", searchCount: 0, queryCount: 0 }]);
  });

  it("includes dynamically capped brief metadata", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
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
            expansionMinConfidence: 0.57,
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
        planAutoInjectSearch: async () => ({
          searches: [
            {
              queries: ["meaningful message"],
              aboutness: {
                domains: [],
                situations: ["meaningful message"],
                targets: ["meaningful message"],
                entities: [],
                userWouldAskForThisAs: ["meaningful message"],
                intentSummary: "Find meaningful message threads.",
              },
            },
          ],
        }),
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
            {
              surface: "discord" as const,
              threadId: "thread-1",
              title: "Below display",
              brief: belowDisplayBrief,
              retrievalHints: ["meaningful message"],
              aboutness: {
                domains: [],
                situations: ["meaningful message"],
                complaintTargets: ["meaningful message"],
                entities: [],
                userWouldAskForThisAs: ["meaningful message"],
              },
            },
            {
              surface: "discord" as const,
              threadId: "thread-2",
              title: "Near threshold",
              brief: nearThresholdBrief,
              retrievalHints: ["meaningful message"],
              aboutness: {
                domains: [],
                situations: ["meaningful message"],
                complaintTargets: ["meaningful message"],
                entities: [],
                userWouldAskForThisAs: ["meaningful message"],
              },
            },
            {
              surface: "discord" as const,
              threadId: "thread-3",
              title: "Over threshold",
              brief: overThresholdBrief,
              retrievalHints: ["meaningful message"],
              aboutness: {
                domains: [],
                situations: ["meaningful message"],
                complaintTargets: ["meaningful message"],
                entities: [],
                userWouldAskForThisAs: ["meaningful message"],
              },
            },
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

    const result = {
      output: { type: "json", value: { entries: readGeneratedPayload(messages).entries } },
    };
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [
          {
            surface: "discord" as const,
            threadId: "thread-1",
            title: "Below display",
            brief: belowDisplayBrief,
          },
          {
            surface: "discord" as const,
            threadId: "thread-2",
            title: "Near threshold",
            brief: nearThresholdBrief,
          },
          {
            surface: "discord" as const,
            threadId: "thread-3",
            title: "Over threshold",
            brief: `${overThresholdBrief.slice(0, AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH)} ...(${overThresholdBrief.length - AUTO_INJECTED_THREAD_BRIEF_DISPLAY_LENGTH} remaining)`,
          },
        ],
      },
    });
  });

  it("ignores surface metadata when deciding whether to auto-inject", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
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
            expansionMinConfidence: 0.57,
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
            results: [
              {
                surface: "discord" as const,
                threadId: "thread-1",
                title: "Should not appear",
                brief: "",
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

    expect(messages).toEqual([]);
    expect(plannerCalls).toBe(0);
    expect(searchCalls).toBe(0);
  });

  it("passes stripped user text to auto-inject query planning", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
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
            expansionMinConfidence: 0.57,
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
                surface: "discord" as const,
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
    expect(messages).toHaveLength(1);
    const result = {
      output: { type: "json", value: { entries: readGeneratedPayload(messages).entries } },
    };
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [
          {
            surface: "discord" as const,
            threadId: "thread-1",
            title: "OAuth callback login loop",
            timeRange: formatExpectedLocalThreadTimeRange(startTime, endTime),
          },
        ],
      },
    });
  });

  it("ranks planned searches globally without reserving a slot per category", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
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
            expansionMinConfidence: 0.57,
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
            Array<{
              surface: "discord" | "native";
              threadId: string;
              title: string;
              brief: string;
              score: number;
            }>
          > = {
            "auth cookies": [
              {
                surface: "discord" as const,
                threadId: "shared",
                title: "Shared top",
                brief: "",
                score: 0.99,
              },
              {
                surface: "discord" as const,
                threadId: "auth-second",
                title: "Auth second",
                brief: "",
                score: 0.4,
              },
            ],
            "workplace context": [
              {
                surface: "discord" as const,
                threadId: "shared",
                title: "Shared top",
                brief: "",
                score: 0.98,
              },
              {
                surface: "discord" as const,
                threadId: "work-second",
                title: "Work second",
                brief: "",
                score: 0.3,
              },
            ],
            "project architecture": [
              {
                surface: "discord" as const,
                threadId: "project-top",
                title: "Project top",
                brief: "",
                score: 0.2,
              },
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
    const result = {
      output: { type: "json", value: { entries: readGeneratedPayload(messages).entries } },
    };
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [{ surface: "discord" as const, threadId: "project-top", title: "Project top" }],
      },
    });
  });

  it("caps globally ranked auto-injected results by the configured limit", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
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
            expansionMinConfidence: 0.57,
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
                surface: "discord" as const,
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

    const result = {
      output: { type: "json", value: { entries: readGeneratedPayload(messages).entries } },
    };
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [
          {
            surface: "discord" as const,
            threadId: "third category",
            title: "third category result",
          },
          {
            surface: "discord" as const,
            threadId: "first category",
            title: "first category result",
          },
        ],
      },
    });
  });

  it("overfetches one search so ranking can rescue a relevant fourth result", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
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
            expansionMinConfidence: 0.57,
            mode: "hybrid",
            filterCurrentParticipants: false,
          },
        },
      },
    };
    const requestedLimits: number[] = [];
    const highestRejectedThreadIds: string[] = [];

    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg: autoInjectCfg,
      requestId: "request-dedupe-recall",
      raw: {},
      userMessages: [{ role: "user", content: "A sufficiently meaningful grouped message" }],
      conversationThreads: {
        planAutoInjectSearch: async () => ({
          searches: [
            autoInjectPlanForQuery("buried target", "Find the buried target thread.").searches[0]!,
          ],
        }),
        search: async (input) => {
          const query = String(Array.isArray(input.query) ? (input.query[0] ?? "") : input.query);
          const requestedLimit = input.limit ?? 5;
          requestedLimits.push(requestedLimit);
          const results = [
            {
              surface: "discord" as const,
              threadId: "generic-1",
              title: "General project notes",
              brief: "",
              score: 1,
            },
            {
              surface: "discord" as const,
              threadId: "generic-2",
              title: "General status update",
              brief: "",
              score: 0.9,
            },
            {
              surface: "discord" as const,
              threadId: "generic-3",
              title: "General coordination",
              brief: "",
              score: 0.8,
            },
            {
              surface: "discord" as const,
              threadId: "buried-target",
              title: "Buried target incident",
              brief: "",
              score: 0.7,
              retrievalHints: ["buried target"],
              aboutness: {
                domains: [],
                situations: ["buried target"],
                complaintTargets: ["buried target"],
                entities: [],
                userWouldAskForThisAs: ["buried target"],
              },
            },
          ].slice(0, requestedLimit);
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
      onInjected: (event) => {
        if (event.highestRejectedByConfidence) {
          highestRejectedThreadIds.push(event.highestRejectedByConfidence.threadId);
        }
      },
      onError: () => {},
    });

    expect(requestedLimits).toEqual([15]);
    expect(highestRejectedThreadIds).toEqual(["generic-1"]);
    const result = {
      output: { type: "json", value: { entries: readGeneratedPayload(messages).entries } },
    };
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [
          {
            surface: "discord" as const,
            threadId: "buried-target",
            title: "Buried target incident",
          },
        ],
      },
    });
  });

  it("keeps successful auto-inject search groups when another group fails", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
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
            expansionMinConfidence: 0.57,
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
            results: [
              {
                surface: "discord" as const,
                threadId: "working-thread",
                title: "Working thread",
                brief: "",
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
      onError: (message) => {
        errors.push(message);
      },
    });

    expect(errors).toEqual([
      "auto-injected thread search failed; continuing with partial metadata",
    ]);
    const result = {
      output: { type: "json", value: { entries: readGeneratedPayload(messages).entries } },
    };
    expect(result.output).toEqual({
      type: "json",
      value: {
        entries: [
          { surface: "discord" as const, threadId: "working-thread", title: "Working thread" },
        ],
      },
    });
  });

  it("skips injection when all search results were already auto-injected", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
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
            expansionMinConfidence: 0.57,
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
        entries: [
          { surface: "discord" as const, threadId: "thread-1", title: "Previously injected" },
        ],
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
          results: [
            {
              surface: "discord" as const,
              threadId: "thread-1",
              title: "Previously injected",
              brief: "",
            },
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
    const cfg = parseCoreConfigV2ToUniversal({
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
            expansionMinConfidence: 0.57,
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
          results: [
            {
              surface: "discord" as const,
              threadId: "thread-1",
              title: "Cookie callback thread",
              brief: "",
            },
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

    expect(plannerCalls).toBe(1);
    expect(messages).toHaveLength(1);
  });

  it("uses the follow-up threshold after previous auto-injected metadata", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
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
            expansionMinConfidence: 0.57,
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
        entries: [
          { surface: "discord" as const, threadId: "thread-1", title: "Previously injected" },
        ],
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
            results: [
              {
                surface: "discord" as const,
                threadId: "thread-2",
                title: "Cookie callback thread",
                brief: "",
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

    expect(messages).toEqual([]);
    expect(plannerCalls).toBe(0);
    expect(searchCalls).toBe(0);
  });

  it("still injects follow-up metadata when the follow-up threshold is met", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
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
            expansionMinConfidence: 0.57,
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
        entries: [
          { surface: "discord" as const, threadId: "thread-1", title: "Previously injected" },
        ],
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
          results: [
            {
              surface: "discord" as const,
              threadId: "thread-2",
              title: "Edge middleware host header",
              brief: "",
            },
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

    expect(plannerCalls).toBe(1);
    expect(messages).toHaveLength(1);
  });

  it("searches across surfaces when no comparable participant IDs are available", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
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
            expansionMinConfidence: 0.57,
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
            results: [
              {
                surface: "discord" as const,
                threadId: "thread-1",
                title: "Related thread",
                brief: "",
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

    expect(messages).toHaveLength(1);
    expect(plannerCalls).toBe(1);
    expect(searchCalls).toBe(1);
  });

  it("continues injecting metadata when optional status publishing fails", async () => {
    const cfg = parseCoreConfigV2ToUniversal({
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
            expansionMinConfidence: 0.57,
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
          results: [
            {
              surface: "discord" as const,
              threadId: "thread-1",
              title: "Related title",
              brief: "",
            },
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

    expect(messages).toHaveLength(1);
    expect(injectedEvents).toHaveLength(1);
    const injectedEvent = injectedEvents[0];
    expect(injectedEvent?.toolCallId.startsWith("conversation_thread_")).toBe(true);
    expect(injectedEvent).toMatchObject({
      mode: "hybrid",
      limit: 3,
      searches: [["meaningful message"]],
      participantFilterUserCount: 0,
      entries: [{ surface: "discord" as const, threadId: "thread-1", title: "Related title" }],
    });
    expect(errors).toEqual([
      "auto-injected thread search status publish failed; continuing",
      "auto-injected thread search status publish failed; continuing",
    ]);
  });
});

describe("maybeBuildAutoInjectedThreadSearchMessages with a decision gate", () => {
  async function runGate(input: {
    mode?: "off" | "shadow" | "enforce";
    mayHelp?: number;
    clearlyUnneeded?: number;
    failure?: boolean;
    text?: string;
    attachmentOnly?: boolean;
    evaluationFailure?: boolean;
  }) {
    const cfg = parseCoreConfigV2ToUniversal({
      configVersion: 2,
      conversation: {
        thread: {
          autoInject: { enabled: true, gate: input.mode ? { mode: input.mode } : undefined },
        },
      },
    });
    const calls: string[] = [];
    const events: unknown[] = [];
    const finished: unknown[] = [];
    let plannerText = "";
    let gateState: unknown;
    const messages = await maybeBuildAutoInjectedThreadSearchMessages({
      cfg,
      requestId: "gate-test",
      surface: "native",
      sessionId: "native:current",
      userMessages: [
        {
          role: "user",
          content: input.attachmentOnly
            ? [{ type: "file", mediaType: "application/pdf", data: "test" }]
            : (input.text ?? "How often does my team block me?"),
        },
      ],
      previousMessages: [{ role: "user", content: "We were discussing review delays." }],
      conversationThreads: {
        planAutoInjectSearch: async (args) => {
          calls.push("planner");
          plannerText = args.text;
          return autoInjectPlanForQuery("team blockers", "Earlier work blockers");
        },
        search: async () => {
          calls.push("search");
          return {
            meta: {
              query: "team blockers",
              limit: 3,
              mode: "hybrid",
              minScore: 0.1,
              count: 1,
              vectorAvailable: false,
            },
            results: [
              {
                surface: "discord",
                threadId: "prior",
                title: "Team review delays",
                brief: "Review delays",
              },
            ],
          };
        },
        shortlistAutoInjectCandidates: async () => {
          throw new Error("Gate must not shortlist");
        },
        metadata: async () => ({ threads: [], missing: [] }),
        read: async () => {
          throw new Error("unused");
        },
        runSummarization: async () => {
          throw new Error("unused");
        },
      },
      createDecisionEvaluator: () => {
        calls.push("gate");
        if (input.failure)
          return createDecisionAutoInjectEvaluator({ model: "typesafe/jev-1.13.0" });
        return Result.ok(
          createDecisionAutoInjectEvaluatorForModel({
            modelId: "test",
            doDecide: async (call) => {
              gateState = call.state;
              if (input.evaluationFailure) throw new Error("provider unavailable");
              return {
                answers: {
                  may_help: { type: "boolean", probability: input.mayHelp ?? 0.05 },
                  clearly_unneeded: { type: "boolean", probability: input.clearlyUnneeded ?? 0.95 },
                },
                warnings: [],
              };
            },
          }),
        );
      },
      autoInjectUsage: {
        recordTiming: () => {},
        recordPlannerUsage: () => {},
        recordEmbeddingUsage: () => {},
        recordDecisionUsage: () => {},
        finish: (event) => finished.push(event),
      },
      onDecisionEvaluated: (event) => events.push(event),
      publishToolStatus: async () => {},
      onError: () => {},
    });
    return { calls, events, finished, messages, plannerText, gateState };
  }

  it("uses the planner directly when the gate is absent or off", async () => {
    for (const mode of [undefined, "off"] as const) {
      const result = await runGate({ mode });
      expect(result.calls).toEqual(["planner", "search"]);
      expect(result.messages).toHaveLength(1);
    }
  });
  it("records a shadow skip while still searching and includes recent context", async () => {
    const result = await runGate({ mode: "shadow" });
    expect(result.calls).toEqual(["gate", "planner", "search"]);
    expect(result.events).toMatchObject([{ mode: "shadow", outcome: "skip" }]);
    expect(result.plannerText).toContain("review delays");
    expect(result.gateState).toEqual({ message: result.plannerText });
    expect(result.messages).toHaveLength(1);
  });
  it("enforces a confident skip before planning or retrieval", async () => {
    const result = await runGate({ mode: "enforce" });
    expect(result.calls).toEqual(["gate"]);
    expect(result.messages).toEqual([]);
    expect(result.finished).toEqual([{ status: "abstained" }]);
  });
  it("continues on uncertainty, contradictory scores, and unavailable providers", async () => {
    for (const scenario of [
      { mayHelp: 0.5, clearlyUnneeded: 0.5 },
      { mayHelp: 0.9, clearlyUnneeded: 0.9 },
      { failure: true },
      { evaluationFailure: true },
    ]) {
      const result = await runGate({ mode: "enforce", ...scenario });
      expect(result.calls).toEqual(["gate", "planner", "search"]);
      expect(result.messages).toHaveLength(1);
    }
  });
  it("searches attachment-only input when the gate cannot inspect the attachment", async () => {
    const result = await runGate({ mode: "enforce", attachmentOnly: true });
    expect(result.calls).toEqual(["planner", "search"]);
    expect(result.messages).toHaveLength(1);
  });
  it("records length skips before calling any model", async () => {
    const result = await runGate({ mode: "enforce", text: "hi" });
    expect(result.calls).toEqual([]);
    expect(result.events).toMatchObject([{ outcome: "length-skip" }]);
    expect(result.finished).toEqual([{ status: "abstained" }]);
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
