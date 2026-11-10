import { describe, expect, it } from "bun:test";

import { rankAutoInjectedThreadSearchResults } from "../../src/conversation/thread-auto-inject-ranking";
import type {
  ConversationThreadAutoInjectQueryPlan,
  ConversationThreadSearchResult,
} from "../../src/conversation/thread-service";

const EXPANSION_MIN_CONFIDENCE = 0.57;

function plan(input?: {
  queries?: string[];
  domains?: string[];
  situations?: string[];
  targets?: string[];
}): ConversationThreadAutoInjectQueryPlan {
  const queries = input?.queries ?? ["OAuth callback login loop"];
  return {
    searches: [
      {
        queries,
        aboutness: {
          domains: input?.domains ?? ["authentication"],
          situations: input?.situations ?? ["login loop after OAuth callback"],
          targets: input?.targets ?? ["OAuth callback cookie"],
          entities: [],
          userWouldAskForThisAs: queries,
          intentSummary: `Find ${queries.join(" ")}`,
        },
      },
    ],
  };
}

function search(
  queryPlan: ConversationThreadAutoInjectQueryPlan,
  results: ConversationThreadSearchResult["results"],
): ConversationThreadSearchResult {
  const queries = queryPlan.searches[0]!.queries;
  return {
    meta: {
      query: queries[0]!,
      ...(queries.length > 1 ? { queries } : {}),
      limit: 10,
      mode: "hybrid",
      minScore: 0.1,
      count: results.length,
      vectorAvailable: true,
    },
    results,
  };
}

describe("auto-injected thread ranking", () => {
  it("ranks and excludes each entry of one thread separately", () => {
    const queryPlan = plan();
    const entry = (entryId: string, title: string) => ({
      surface: "discord" as const,
      threadId: "shared-thread",
      entryId,
      title,
      brief: "Safari lost the session after the callback.",
      score: 0.4,
      retrievalHints: ["OAuth callback login loop", "OAuth callback cookie"],
      aboutness: {
        domains: ["authentication"],
        situations: ["login loop after OAuth callback"],
        complaintTargets: ["OAuth callback cookie"],
        entities: ["OAuth"],
        userWouldAskForThisAs: ["OAuth callback login loop"],
      },
    });
    const rank = (excludedEntryIds?: ReadonlySet<string>) =>
      rankAutoInjectedThreadSearchResults({
        plan: queryPlan,
        searches: [
          {
            searchIndex: 0,
            result: search(queryPlan, [
              entry("shared-thread", "OAuth callback login loop"),
              entry("shared-thread#1", "OAuth callback login loop on Safari"),
            ]),
          },
        ],
        excludedEntryIds,
        limit: 3,
        expansionMinConfidence: EXPANSION_MIN_CONFIDENCE,
      }).selected.map((candidate) => candidate.result.entryId);

    expect(rank()).toEqual(["shared-thread", "shared-thread#1"]);
    expect(rank(new Set(["shared-thread"]))).toEqual(["shared-thread#1"]);
  });

  it("keeps one recall-floor result below the expansion confidence threshold", () => {
    const queryPlan = plan();
    const ranked = rankAutoInjectedThreadSearchResults({
      plan: queryPlan,
      searches: [
        {
          searchIndex: 0,
          result: search(queryPlan, [
            {
              surface: "discord" as const,
              threadId: "rare-thread",
              title: "Possibly related",
              brief: "Sparse old summary without structured aboutness.",
              score: 0.11,
            },
          ]),
        },
      ],
      corpusDocuments: ["common project discussion", "another common project discussion"],
      limit: 3,
      expansionMinConfidence: EXPANSION_MIN_CONFIDENCE,
    });

    expect(ranked.selected).toHaveLength(1);
    expect(ranked.selected[0]).toMatchObject({
      result: { threadId: "rare-thread" },
      selection: "recall-floor",
    });
    expect(ranked.selected[0]!.confidence).toBeLessThan(EXPANSION_MIN_CONFIDENCE);
  });

  it("admits extra results only when specific anchors support their rank", () => {
    const queryPlan = plan();
    const ranked = rankAutoInjectedThreadSearchResults({
      plan: queryPlan,
      searches: [
        {
          searchIndex: 0,
          result: search(queryPlan, [
            {
              surface: "discord" as const,
              threadId: "specific-one",
              title: "OAuth callback login loop",
              brief: "Safari lost the session after the callback.",
              score: 0.4,
              retrievalHints: ["OAuth callback login loop", "OAuth callback cookie"],
              aboutness: {
                domains: ["authentication"],
                situations: ["login loop after OAuth callback"],
                complaintTargets: ["OAuth callback cookie"],
                entities: ["OAuth"],
                userWouldAskForThisAs: ["OAuth callback login loop"],
              },
            },
            {
              surface: "discord" as const,
              threadId: "specific-two",
              title: "OAuth callback login loop on mobile",
              brief: "A second relevant incident.",
              score: 0.3,
              retrievalHints: ["OAuth callback login loop", "OAuth callback cookie"],
              aboutness: {
                domains: ["authentication"],
                situations: ["login loop after OAuth callback"],
                complaintTargets: ["OAuth callback cookie"],
                entities: ["OAuth"],
                userWouldAskForThisAs: ["OAuth callback login loop"],
              },
            },
            {
              surface: "discord" as const,
              threadId: "generic",
              title: "Authentication project notes",
              brief: "General notes.",
              score: 0.9,
              aboutness: {
                domains: ["authentication"],
                situations: [],
                complaintTargets: [],
                entities: [],
                userWouldAskForThisAs: [],
              },
            },
          ]),
        },
      ],
      corpusDocuments: [
        "authentication project notes",
        "OAuth callback login loop cookie Safari",
        "OAuth callback cookie session incident",
      ],
      limit: 3,
      expansionMinConfidence: EXPANSION_MIN_CONFIDENCE,
    });

    expect(ranked.selected.map((entry) => entry.result.threadId)).toEqual([
      "specific-one",
      "specific-two",
    ]);
    expect(ranked.selected.map((entry) => entry.selection)).toEqual(["recall-floor", "confidence"]);
    expect(ranked.highestRejectedByConfidence?.result.threadId).toBe("generic");
  });

  it("applies the caller's expansion confidence threshold without affecting the floor", () => {
    const queryPlan = plan();
    const result = search(queryPlan, [
      {
        surface: "discord" as const,
        threadId: "first",
        title: "OAuth callback login loop",
        brief: "",
        retrievalHints: ["OAuth callback login loop", "OAuth callback cookie"],
        aboutness: {
          domains: ["authentication"],
          situations: ["login loop after OAuth callback"],
          complaintTargets: ["OAuth callback cookie"],
          entities: [],
          userWouldAskForThisAs: ["OAuth callback login loop"],
        },
      },
      {
        surface: "discord" as const,
        threadId: "second",
        title: "OAuth callback login loop",
        brief: "",
        retrievalHints: ["OAuth callback login loop", "OAuth callback cookie"],
        aboutness: {
          domains: ["authentication"],
          situations: ["login loop after OAuth callback"],
          complaintTargets: ["OAuth callback cookie"],
          entities: [],
          userWouldAskForThisAs: ["OAuth callback login loop"],
        },
      },
    ]);
    const rank = (expansionMinConfidence: number) =>
      rankAutoInjectedThreadSearchResults({
        plan: queryPlan,
        searches: [{ searchIndex: 0, result }],
        limit: 3,
        expansionMinConfidence,
      });

    expect(rank(0.8).selected.map((entry) => entry.result.threadId)).toEqual(["first", "second"]);
    const strict = rank(0.97);
    expect(strict.selected.map((entry) => entry.result.threadId)).toEqual(["first"]);
    expect(strict.highestRejectedByConfidence?.result.threadId).toBe("second");
  });

  it("uses corpus frequency so a rare anchor can beat a frequent generic token", () => {
    const queryPlan = plan({
      queries: ["Discord OAuth"],
      domains: [],
      situations: [],
      targets: [],
    });
    const ranked = rankAutoInjectedThreadSearchResults({
      plan: queryPlan,
      searches: [
        {
          searchIndex: 0,
          result: search(queryPlan, [
            {
              surface: "discord" as const,
              threadId: "discord-only",
              title: "Discord",
              brief: "",
              score: 0.9,
            },
            {
              surface: "discord" as const,
              threadId: "oauth-only",
              title: "OAuth",
              brief: "",
              score: 0.2,
            },
          ]),
        },
      ],
      corpusDocuments: [
        ...Array.from({ length: 99 }, () => "Discord discussion"),
        "Discord OAuth callback",
      ],
      limit: 1,
      expansionMinConfidence: EXPANSION_MIN_CONFIDENCE,
    });

    expect(ranked.selected[0]?.result.threadId).toBe("oauth-only");
  });

  it("deduplicates a thread returned by multiple planned searches", () => {
    const queryPlan: ConversationThreadAutoInjectQueryPlan = {
      searches: [
        plan({ queries: ["OAuth callback"] }).searches[0]!,
        plan({ queries: ["mobile login loop"] }).searches[0]!,
      ],
    };
    const shared = {
      surface: "discord" as const,
      threadId: "shared",
      title: "OAuth callback mobile login loop",
      brief: "",
      score: 0.5,
      retrievalHints: ["OAuth callback", "mobile login loop"],
    };
    const ranked = rankAutoInjectedThreadSearchResults({
      plan: queryPlan,
      searches: [
        { searchIndex: 0, result: search({ searches: [queryPlan.searches[0]!] }, [shared]) },
        { searchIndex: 1, result: search({ searches: [queryPlan.searches[1]!] }, [shared]) },
      ],
      limit: 3,
      expansionMinConfidence: EXPANSION_MIN_CONFIDENCE,
    });

    expect(ranked.selected.map((entry) => entry.result.threadId)).toEqual(["shared"]);
  });
});
