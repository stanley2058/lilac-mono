import { Result } from "better-result";
import { z } from "zod";
import type { NativeSearchService } from "../../surface/native/search";
import { nativeSearchToolAsync, isNativeSearchContext } from "../../surface/native/search-tools";
import { serverToolFailure, type ServerToolResult } from "@stanley2058/lilac-plugin-runtime";
import { defineServerTool, type ServerTool, type ServerToolCallOptions } from "../types";

import {
  DISCOVERY_LIMIT_MAX,
  DISCOVERY_SURROUNDING_MAX,
  type DiscoveryService,
} from "../../discovery/discovery-service";

const discoverySourceSchema = z.enum(["conversation", "prompt", "heartbeat"]);

const discoverySourcesInputSchema = z
  .union([discoverySourceSchema, z.array(discoverySourceSchema)])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value : [value];
  });

const discoverySearchInputSchema = z.object({
  query: z.string().min(1).describe("Search query (BM25 full-text)."),
  sources: discoverySourcesInputSchema.describe(
    "Optional source filter(s). Accepts a scalar like --sources=conversation or an array via --sources:json. Defaults to conversation + prompt + heartbeat.",
  ),
  platform: z
    .enum(["native", "discord", "github", "whatsapp", "slack", "telegram", "web", "unknown"])
    .optional()
    .describe(
      "Optional conversation platform filter. Excludes non-conversation sources like prompt and heartbeat.",
    ),
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional conversation session/channel filter. Excludes non-conversation sources like prompt and heartbeat.",
    ),
  authorId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional conversation author user id filter. Excludes sources without indexed authors.",
    ),
  orderBy: z
    .enum(["relevance", "time"])
    .optional()
    .describe("Sort groups by lexical+recency relevance or by time."),
  direction: z
    .enum(["asc", "desc"])
    .optional()
    .describe("Sort direction for the chosen order mode."),
  groupBy: z
    .enum(["origin", "source", "none"])
    .optional()
    .describe("Group results by session/file origin, by source, or not at all."),
  surrounding: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(DISCOVERY_SURROUNDING_MAX)
    .optional()
    .describe(
      `Conversation: surrounding messages. Files: surrounding lines. Default: 1, max: ${DISCOVERY_SURROUNDING_MAX}.`,
    ),
  offsetTime: z
    .union([z.string().min(1), z.number().nonnegative()])
    .optional()
    .describe(
      "Window end anchor. Accepts ISO-8601, unix epoch, 0, or a relative duration like '1d'.",
    ),
  lookbackTime: z
    .union([z.string().min(1), z.number().positive()])
    .optional()
    .describe(
      "Positive lookback duration. Examples: '24h', '1d', '90m'. Required when offsetTime is set.",
    ),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(DISCOVERY_LIMIT_MAX)
    .optional()
    .describe(`Max result groups (default: 10, max: ${DISCOVERY_LIMIT_MAX}).`),
  verbose: z
    .boolean()
    .optional()
    .describe("Include raw ranking/debug fields like score, bm25, recencyBoost, and ts."),
});

export class Discovery implements ServerTool {
  private readonly tool: ServerTool;

  constructor(
    private readonly params: {
      discovery: DiscoveryService;
      nativeSearch?: NativeSearchService;
    },
  ) {
    this.tool = defineServerTool({
      id: "discovery",
      callables: ({ callable }) => ({
        "discovery.search": callable({
          name: "Discovery Search",
          description:
            "Search unified agent memory across conversations, prompts, and heartbeat files. Output is { meta, groups }, where groups[].entries[][] contains matched message/file entries plus surrounding context windows.",
          inputSchema: discoverySearchInputSchema,
          primaryPositional: "query",
          run: async (input, opts) => {
            const restricted = opts?.context?.safetyMode === "restricted";
            if (restricted && !opts?.context?.sessionId) {
              return Result.err(
                serverToolFailure({
                  kind: "denied",
                  code: "discovery_session_required",
                  message: "Restricted discovery requires a calling session",
                  retryable: false,
                }),
              );
            }
            const searchInput = restricted
              ? {
                  ...input,
                  sources: ["conversation" as const],
                  sessionId: opts!.context!.sessionId,
                  platform: undefined,
                }
              : input;
            if (isNativeSearchContext(opts?.context))
              return nativeSearchToolAsync(
                this.params.nativeSearch,
                opts?.context,
                (service, userId) =>
                  service.discoveryWithExternal(userId, searchInput, this.params.discovery),
              );
            return (await this.params.discovery.searchResult(searchInput)).mapError((error) => {
              switch (error._tag) {
                case "DiscoverySearchInputError":
                  return serverToolFailure({
                    kind: "usage",
                    code: "discovery_invalid_search",
                    message: error.message,
                    retryable: false,
                  });
                case "DiscoverySearchOperationError":
                  return serverToolFailure({
                    kind: "unavailable",
                    code: "discovery_search_unavailable",
                    message: error.message,
                    retryable: true,
                  });
              }
            });
          },
        }),
      }),
    });
  }

  get id(): string {
    return this.tool.id;
  }

  init(): Promise<void> {
    return this.tool.init();
  }

  destroy(): Promise<void> {
    return this.tool.destroy();
  }

  list() {
    return this.tool.list();
  }

  call(
    callableId: string,
    input: Record<string, unknown>,
    opts?: ServerToolCallOptions,
  ): Promise<ServerToolResult> {
    return this.tool.call(callableId, input, opts);
  }
}
