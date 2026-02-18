import { tavily, type TavilyClient } from "@tavily/core";
import Exa from "exa-js";
import { z } from "zod";

export const webSearchInputSchema = z.object({
  query: z.string().describe("Search query"),
  topic: z.enum(["general", "news", "finance"]).optional().default("general"),
  searchDepth: z
    .enum(["basic", "advanced"])
    .optional()
    .default("basic")
    .describe(
      '"advanced" search is tailored to retrieve the most relevant sources and content snippets for your query, while "basic" search provides generic content snippets from each source.',
    ),
  maxResults: z.coerce.number().optional().default(8).describe("Max results"),
  timeRange: z
    .enum(["day", "week", "month", "year", "d", "w", "m", "y"])
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

export type WebSearchResult = {
  url: string;
  title: string;
  content: string;
  score: number | null;
};

export type WebSearchProviderId = "exa" | "tavily" | (string & {});

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

function missingConfigMessage(id: WebSearchProviderId): string | null {
  if (id === "exa") {
    return "web.search is unavailable: EXA_API_KEY is not configured (set env var EXA_API_KEY).";
  }
  if (id === "tavily") {
    return "web.search is unavailable: TAVILY_API_KEY is not configured (set env var TAVILY_API_KEY).";
  }
  return null;
}

export function resolveWebSearchProvider(params: {
  requested?: string;
  providers: readonly WebSearchProvider[];
}): {
  provider: WebSearchProvider | null;
  error: string | null;
} {
  // Provider selection rules (intentional back-compat with original lilac-mono):
  // - Default is Tavily.
  // - Only "exa" explicitly selects Exa.
  // - Any missing/unexpected value falls back to Tavily.
  // - No automatic failover to other providers.
  const byId = new Map<WebSearchProviderId, WebSearchProvider>();
  const ids: WebSearchProviderId[] = [];

  for (const p of params.providers) {
    if (!byId.has(p.id)) {
      ids.push(p.id);
    }
    byId.set(p.id, p);
  }

  const normalized = params.requested?.trim().toLowerCase();
  const requested = normalized === "exa" ? "exa" : "tavily";
  const p = byId.get(requested);
  if (!p) {
    return {
      provider: null,
      error: `web.search is unavailable: provider '${requested}' is not registered. Registered: ${ids.join(", ") || "none"}.`,
    };
  }z

  if (!p.isConfigured()) {
    return {
      provider: null,
      error:
        missingConfigMessage(p.id) ??
        `web.search is unavailable: provider '${p.id}' is not configured.`,
    };
  }

  return { provider: p, error: null };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function toUTCDateOnlyString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startDateFromTimeRange(range: WebSearchInput["timeRange"]): string | undefined {
  if (!range) return undefined;

  const now = new Date();
  const utcDayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  switch (range) {
    case "day":
    case "d":
      utcDayStart.setUTCDate(utcDayStart.getUTCDate() - 1);
      return toUTCDateOnlyString(utcDayStart);
    case "week":
    case "w":
      utcDayStart.setUTCDate(utcDayStart.getUTCDate() - 7);
      return toUTCDateOnlyString(utcDayStart);
    case "month":
    case "m":
      utcDayStart.setUTCMonth(utcDayStart.getUTCMonth() - 1);
      return toUTCDateOnlyString(utcDayStart);
    case "year":
    case "y":
      utcDayStart.setUTCFullYear(utcDayStart.getUTCFullYear() - 1);
      return toUTCDateOnlyString(utcDayStart);
  }
}

// map args to EXA's search type. different to tavily.

function mapSearchDepthToExaType(depth: WebSearchInput["searchDepth"]): "auto" | "deep" {
  return depth === "advanced" ? "deep" : "auto";
}

type ExaCategory = "news" | "financial report";

function mapTopicToExaCategory(topic: WebSearchInput["topic"]): ExaCategory | undefined {
  switch (topic) {
    case "news":
      return "news";
    case "finance":
      return "financial report";
    case "general":
      return undefined;
  }
}

// tavily | EXA
// context | highlights > summary
// rawContxt | text

function pickContent(input: {
  highlights?: readonly string[];
  summary?: string;
  text?: string;
}): string {
  if (input.highlights && input.highlights.length > 0) {
    return input.highlights
      .map((h) => h.trim())
      .filter((h) => h.length > 0)
      .join(" [...] ");
  }

  if (typeof input.summary === "string" && input.summary.trim().length > 0) {
    return input.summary.trim();
  }

  if (typeof input.text === "string" && input.text.trim().length > 0) {
    return input.text.trim().slice(0, 2000);
  }

  return "";
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

export class ExaWebSearchProvider implements WebSearchProvider {
  readonly id = "exa" as const;

  private client: Exa | null = null;

  constructor(
    private readonly config: {
      baseUrl?: string;
      apiKey?: string;
    },
  ) {}

  isConfigured(): boolean {
    return typeof this.config.apiKey === "string" && this.config.apiKey.length > 0;
  }

  private getClient(): Exa {
    if (this.client) return this.client;

    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new Error("EXA_API_KEY is not configured.");
    }

    this.client = this.config.baseUrl
      ? new Exa(apiKey, normalizeBaseUrl(this.config.baseUrl))
      : new Exa(apiKey);
    return this.client;
  }

  async search(
    input: WebSearchInput,
    _opts?: {
      signal?: AbortSignal;
    },
  ): Promise<readonly WebSearchResult[]> {
    const client = this.getClient();

    const startPublishedDate =
      input.startDate ?? (input.timeRange ? startDateFromTimeRange(input.timeRange) : undefined);
    const endPublishedDate = input.endDate;

    const category = mapTopicToExaCategory(input.topic);
    const type = mapSearchDepthToExaType(input.searchDepth);

    const res = await client.search(input.query, {
      type,
      numResults: clampInt(input.maxResults, 1, 100),
      ...(category ? { category } : {}),
      ...(startPublishedDate ? { startPublishedDate } : {}),
      ...(endPublishedDate ? { endPublishedDate } : {}),
      contents: {
        text: { maxCharacters: 1000 },
        highlights: true,
        summary: { query: input.query },
      },
    });

    return res.results.map((r) => {
      const title = typeof r.title === "string" && r.title.length > 0 ? r.title : r.url;
      const score = typeof r.score === "number" ? r.score : null;

      return {
        url: r.url,
        title,
        content: pickContent(r),
        score,
      } satisfies WebSearchResult;
    });
  }
}

export class TavilyWebSearchProvider implements WebSearchProvider {
  readonly id = "tavily" as const;
  private client: TavilyClient | null = null;

  constructor(
    private readonly config: {
      apiKey?: string;
    },
  ) {}

  isConfigured(): boolean {
    return typeof this.config.apiKey === "string" && this.config.apiKey.length > 0;
  }

  private getClient(): TavilyClient {
    if (this.client) return this.client;
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new Error("TAVILY_API_KEY is not configured.");
    }
    this.client = tavily({ apiKey });
    return this.client;
  }

  async search(input: WebSearchInput): Promise<readonly WebSearchResult[]> {
    const client = this.getClient();
    const { results } = await client.search(input.query, {
      topic: input.topic,
      searchDepth: input.searchDepth,
      maxResults: input.maxResults,
      timeRange: input.timeRange,
      startDate: input.startDate,
      endDate: input.endDate,
    });

    return results.map((r) => ({
      url: r.url,
      title: r.title,
      content: r.content,
      score: r.score,
    }));
  }
}

export function createDefaultWebSearchProviders(config: {
  exa: {
    baseUrl?: string;
    apiKey?: string;
  };
  tavilyApiKey?: string;
}): readonly WebSearchProvider[] {
  return [
    new ExaWebSearchProvider({
      baseUrl: config.exa.baseUrl,
      apiKey: config.exa.apiKey,
    }),
    new TavilyWebSearchProvider({
      apiKey: config.tavilyApiKey,
    }),
  ];
}
