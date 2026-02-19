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
  maxResults: z.coerce
    .number()
    .finite()
    .optional()
    .default(8)
    .transform((value) => clampInt(value, 1, 100))
    .describe("Max results (1-100)"),
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

const DEFAULT_WEB_SEARCH_PROVIDER = "tavily" as const;

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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal) return;
  if (!signal.aborted) return;

  const e = new Error("Aborted");
  e.name = "AbortError";
  throw e;
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
  warning: string | null;
} {
  const byId = new Map<string, WebSearchProvider>();
  const ids: WebSearchProviderId[] = [];

  for (const p of params.providers) {
    const normalizedId = p.id.trim().toLowerCase();
    if (!byId.has(normalizedId)) {
      ids.push(p.id);
    }
    byId.set(normalizedId, p);
  }

  const normalized = params.requested?.trim().toLowerCase() ?? "";

  const requested =
    normalized.length > 0
      ? normalized
      : byId.has(DEFAULT_WEB_SEARCH_PROVIDER)
        ? DEFAULT_WEB_SEARCH_PROVIDER
        : (ids[0] ?? DEFAULT_WEB_SEARCH_PROVIDER);

  const p = byId.get(requested);
  if (!p) {
    return {
      provider: null,
      error: `web.search is unavailable: unknown provider '${requested}'. Registered: ${ids.join(", ") || "none"}.`,
      warning: null,
    };
  }

  if (p.isConfigured()) {
    return { provider: p, error: null, warning: null };
  }

  const fallback = params.providers.find((provider) => provider.isConfigured()) ?? null;

  if (!fallback) {
    return {
      provider: null,
      error:
        missingConfigMessage(p.id) ??
        `web.search is unavailable: provider '${p.id}' is not configured.`,
      warning: null,
    };
  }

  return {
    provider: fallback,
    error: null,
    warning: `web.search provider '${p.id}' is not configured; falling back to '${fallback.id}'.`,
  };
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

function toSearchContentSnippet(input: {
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

function withAbortSignal<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  throwIfAborted(signal);

  const pending = run();
  if (!signal) {
    return pending;
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const e = new Error("Aborted");
      e.name = "AbortError";
      reject(e);
    };

    signal.addEventListener("abort", onAbort, { once: true });

    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
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
    opts?: {
      signal?: AbortSignal;
    },
  ): Promise<readonly WebSearchResult[]> {
    const client = this.getClient();

    // Note: exa-js does not currently expose AbortSignal support in its search() options.
    // We still surface cancellation to callers by rejecting early on signal abort.

    const startPublishedDate =
      input.startDate ?? (input.timeRange ? startDateFromTimeRange(input.timeRange) : undefined);
    const endPublishedDate = input.endDate;

    const category = mapTopicToExaCategory(input.topic);
    const type = mapSearchDepthToExaType(input.searchDepth);

    const res = await withAbortSignal(opts?.signal, () =>
      client.search(input.query, {
        type,
        numResults: input.maxResults,
        ...(category ? { category } : {}),
        ...(startPublishedDate ? { startPublishedDate } : {}),
        ...(endPublishedDate ? { endPublishedDate } : {}),
        contents: {
          text: { maxCharacters: 1000 },
          highlights: true,
          summary: { query: input.query },
        },
      }),
    );

    return res.results.map((r) => {
      const title = typeof r.title === "string" && r.title.length > 0 ? r.title : r.url;
      const score = typeof r.score === "number" ? r.score : null;

      return {
        url: r.url,
        title,
        content: toSearchContentSnippet(r),
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

  async search(
    input: WebSearchInput,
    opts?: {
      signal?: AbortSignal;
    },
  ): Promise<readonly WebSearchResult[]> {
    const client = this.getClient();

    // Note: @tavily/core does not currently expose AbortSignal support in search() options.
    // We still surface cancellation to callers by rejecting early on signal abort.
    const { results } = await withAbortSignal(opts?.signal, () =>
      client.search(input.query, {
        topic: input.topic,
        searchDepth: input.searchDepth,
        maxResults: input.maxResults,
        timeRange: input.timeRange,
        startDate: input.startDate,
        endDate: input.endDate,
      }),
    );

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
