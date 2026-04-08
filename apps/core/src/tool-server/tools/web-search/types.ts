import { z } from "zod";

export const WEB_SEARCH_TOPICS = ["general", "news", "finance"] as const;
export const WEB_SEARCH_DEPTHS = ["auto", "deep", "fast", "instant"] as const;
export const WEB_SEARCH_TIME_RANGES = ["day", "week", "month", "year", "d", "w", "m", "y"] as const;

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export const webSearchInputSchema = z.object({
  query: z.string().describe("Search query"),
  topic: z.enum(WEB_SEARCH_TOPICS).optional().default("general"),
  searchDepth: z
    .enum(WEB_SEARCH_DEPTHS)
    .optional()
    .default("auto")
    .describe(
      'Search tier: "auto" is the balanced default, "deep" favors quality and coverage, "fast" prioritizes lower latency, and "instant" minimizes latency.',
    ),
  maxResults: z.coerce
    .number()
    .optional()
    .default(8)
    .transform((value) => clampInt(value, 1, 100))
    .describe("Max results (1-100)"),
  timeRange: z
    .enum(WEB_SEARCH_TIME_RANGES)
    .optional()
    .describe(
      "The time range back from the current date based on publish date or last updated date.",
    ),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Start date. Must be in YYYY-MM-DD format."),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("End date. Must be in YYYY-MM-DD format."),
});

export type WebSearchInput = z.infer<typeof webSearchInputSchema>;
export type WebSearchDepth = (typeof WEB_SEARCH_DEPTHS)[number];
export type WebSearchTimeRange = (typeof WEB_SEARCH_TIME_RANGES)[number];

export type WebSearchResult = {
  url: string;
  title: string;
  content: string;
  score: number | null;
};

export type WebSearchProviderId = "exa" | "firecrawl" | "tavily" | (string & {});

export interface WebSearchProvider {
  readonly id: WebSearchProviderId;

  isConfigured(): boolean;

  search(
    input: WebSearchInput,
    opts?: {
      signal?: AbortSignal;
    },
  ): Promise<readonly WebSearchResult[]>;
}
