import { z } from "zod";

import type { ServerTool } from "../types";
import {
  DISCOVERY_LIMIT_MAX,
  DISCOVERY_SURROUNDING_MAX,
  type DiscoveryService,
} from "../../discovery/discovery-service";
import { zodObjectToCliLines } from "./zod-cli";

const discoverySearchInputSchema = z.object({
  query: z.string().min(1).describe("Search query (BM25 full-text)."),
  sources: z
    .array(z.enum(["conversation", "prompt", "heartbeat"]))
    .optional()
    .describe("Optional source filters. Defaults to conversation + prompt + heartbeat."),
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
  id = "discovery";

  constructor(
    private readonly params: {
      discovery: DiscoveryService;
    },
  ) {}

  async init(): Promise<void> {}
  async destroy(): Promise<void> {}

  async list() {
    return [
      {
        callableId: "discovery.search",
        name: "Discovery Search",
        description:
          "Search unified agent memory across conversations, prompts, and heartbeat files with grouped origins and surrounding context.",
        shortInput: zodObjectToCliLines(discoverySearchInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(discoverySearchInputSchema),
        primaryPositional: {
          field: "query",
        },
      },
    ];
  }

  async call(callableId: string, rawInput: Record<string, unknown>): Promise<unknown> {
    if (callableId !== "discovery.search") {
      throw new Error(`Invalid callable ID '${callableId}'`);
    }

    const input = discoverySearchInputSchema.parse(rawInput);
    return await this.params.discovery.search(input);
  }
}
