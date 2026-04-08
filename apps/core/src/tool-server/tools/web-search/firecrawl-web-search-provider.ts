import { normalizeBaseUrl } from "./shared";
import type { WebSearchInput, WebSearchProvider, WebSearchResult } from "./types";

type FirecrawlSearchResponse = {
  success?: boolean;
  error?: string;
  message?: string;
  data?: unknown;
};

type FirecrawlSearchItem = {
  url: string;
  title: string;
  content: string;
  score: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toUsDate(date: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (!match) return null;
  return `${Number(match[2])}/${Number(match[3])}/${match[1]}`;
}

function buildFirecrawlTbs(input: WebSearchInput): string | undefined {
  if (input.startDate || input.endDate) {
    const minDate = input.startDate ? toUsDate(input.startDate) : null;
    const maxDate = input.endDate ? toUsDate(input.endDate) : null;
    if (minDate && maxDate) {
      return `cdr:1,cd_min:${minDate},cd_max:${maxDate}`;
    }
    if (minDate) {
      return `cdr:1,cd_min:${minDate}`;
    }
    if (maxDate) {
      return `cdr:1,cd_max:${maxDate}`;
    }
    return undefined;
  }

  switch (input.timeRange) {
    case "day":
    case "d":
      return "qdr:d";
    case "week":
    case "w":
      return "qdr:w";
    case "month":
    case "m":
      return "qdr:m";
    case "year":
    case "y":
      return "qdr:y";
    default:
      return undefined;
  }
}

function mapTopicToSources(topic: WebSearchInput["topic"]): readonly string[] | undefined {
  switch (topic) {
    case "news":
      return ["news"];
    case "general":
    case "finance":
      return undefined;
  }
}

function toFirecrawlItems(payload: unknown): FirecrawlSearchItem[] {
  const items: FirecrawlSearchItem[] = [];

  const appendItem = (value: unknown) => {
    if (!isRecord(value)) return;

    const url =
      getString(value, "url") ??
      getString(value, "sourceURL") ??
      (isRecord(value.metadata) ? getString(value.metadata, "sourceURL") : null);
    if (!url) return;

    const title =
      getString(value, "title") ??
      (isRecord(value.metadata) ? getString(value.metadata, "title") : null) ??
      url;
    const content =
      getString(value, "markdown") ??
      getString(value, "content") ??
      getString(value, "description") ??
      getString(value, "snippet") ??
      "";

    items.push({
      url,
      title,
      content,
      score: getNumber(value, "score"),
    });
  };

  const appendMany = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      appendItem(entry);
    }
  };

  if (Array.isArray(payload)) {
    appendMany(payload);
    return items;
  }

  if (!isRecord(payload)) {
    return items;
  }

  appendMany(payload.data);

  if (isRecord(payload.data)) {
    appendMany(payload.data.web);
    appendMany(payload.data.news);
    appendMany(payload.data.results);
  }

  appendMany(payload.web);
  appendMany(payload.news);
  appendMany(payload.results);

  return items;
}

export class FirecrawlWebSearchProvider implements WebSearchProvider {
  readonly id = "firecrawl" as const;

  constructor(
    private readonly config: {
      apiKey?: string;
      apiBaseUrl?: string;
    },
  ) {}

  isConfigured(): boolean {
    return typeof this.config.apiKey === "string" && this.config.apiKey.length > 0;
  }

  private resolveApiUrl(pathname: string): string {
    const baseUrlRaw = this.config.apiBaseUrl?.trim();
    const baseUrl = baseUrlRaw ? normalizeBaseUrl(baseUrlRaw) : "https://api.firecrawl.dev";
    return `${baseUrl}${pathname}`;
  }

  async search(
    input: WebSearchInput,
    opts?: {
      signal?: AbortSignal;
    },
  ): Promise<readonly WebSearchResult[]> {
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new Error("FIRECRAWL_API_KEY is not configured.");
    }

    const body: Record<string, unknown> = {
      query: input.query,
      limit: Math.min(20, Math.max(1, input.maxResults)),
    };

    const sources = mapTopicToSources(input.topic);
    if (sources) {
      body.sources = sources;
    }

    const tbs = buildFirecrawlTbs(input);
    if (tbs) {
      body.tbs = tbs;
    }

    const response = await fetch(this.resolveApiUrl("/v2/search"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: opts?.signal,
    });

    let payload: FirecrawlSearchResponse;
    try {
      payload = (await response.json()) as FirecrawlSearchResponse;
    } catch {
      throw new Error(`Firecrawl search failed (${response.status}): invalid JSON response.`);
    }

    if (!response.ok || payload.success === false) {
      const detail =
        (typeof payload.error === "string" && payload.error) ||
        (typeof payload.message === "string" && payload.message) ||
        response.statusText ||
        "unknown error";
      throw new Error(`Firecrawl search failed (${response.status}): ${detail}`);
    }

    return toFirecrawlItems(payload).map((item) => ({
      url: item.url,
      title: item.title,
      content: item.content,
      score: item.score,
    }));
  }
}
