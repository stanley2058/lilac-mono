import { tavily, type TavilyClient } from "@tavily/core";

import { normalizeBaseUrl, withAbortSignal } from "./shared";
import type { WebSearchDepth, WebSearchInput, WebSearchProvider, WebSearchResult } from "./types";

function clampTavilyMaxResults(value: number): number {
  return Math.min(20, Math.max(1, value));
}

function mapSearchDepthToTavilyDepth(
  depth: WebSearchDepth,
): "basic" | "advanced" | "fast" | "ultra-fast" {
  switch (depth) {
    case "deep":
      return "advanced";
    case "fast":
      return "fast";
    case "instant":
      return "ultra-fast";
    case "auto":
      return "basic";
  }
}

export class TavilyWebSearchProvider implements WebSearchProvider {
  readonly id = "tavily" as const;

  private client: TavilyClient | null = null;

  constructor(
    private readonly config: {
      apiKey?: string;
      apiBaseUrl?: string;
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

    const apiBaseUrlRaw = this.config.apiBaseUrl?.trim();
    const apiBaseURL = apiBaseUrlRaw ? normalizeBaseUrl(apiBaseUrlRaw) : undefined;
    this.client = tavily({
      apiKey,
      apiBaseURL,
    });
    return this.client;
  }

  async search(
    input: WebSearchInput,
    opts?: {
      signal?: AbortSignal;
    },
  ): Promise<readonly WebSearchResult[]> {
    const client = this.getClient();

    const { results } = await withAbortSignal(opts?.signal, () =>
      client.search(input.query, {
        topic: input.topic,
        search_depth: mapSearchDepthToTavilyDepth(input.searchDepth),
        maxResults: clampTavilyMaxResults(input.maxResults),
        timeRange: input.timeRange,
        startDate: input.startDate,
        endDate: input.endDate,
      }),
    );

    return results.map((result) => ({
      url: result.url,
      title: result.title,
      content: result.content,
      score: result.score,
    }));
  }
}
