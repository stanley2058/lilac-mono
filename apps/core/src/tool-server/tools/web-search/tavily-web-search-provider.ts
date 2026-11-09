import type { TavilyClient } from "@tavily/core";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import { normalizeBaseUrl, withAbortSignal } from "./shared";
import type { WebSearchDepth, WebSearchInput, WebSearchProvider, WebSearchResult } from "./types";

class TavilyProviderConfigurationInvalid extends TaggedError("TavilyProviderConfigurationInvalid")<{
  readonly message: string;
}> {}

function adaptTavilyProviderResultToHost<TValue>(
  result: ResultType<TValue, TavilyProviderConfigurationInvalid>,
): TValue {
  return result.match({
    ok: (value) => () => value,
    err: (error) => () => {
      throw new Error(error.message);
    },
  })();
}

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

  private getClient(): ResultType<TavilyClient, TavilyProviderConfigurationInvalid> {
    if (this.client) return Result.ok(this.client);

    const apiKey = this.config.apiKey;
    if (!apiKey) {
      return Result.err(
        new TavilyProviderConfigurationInvalid({ message: "TAVILY_API_KEY is not configured." }),
      );
    }

    const apiBaseUrlRaw = this.config.apiBaseUrl?.trim();
    const apiBaseURL = apiBaseUrlRaw ? normalizeBaseUrl(apiBaseUrlRaw) : undefined;
    // Loaded on first use: the client costs about 12 MiB of RSS, and this method is synchronous.
    const { tavily }: typeof import("@tavily/core") = require("@tavily/core");
    this.client = tavily({
      apiKey,
      apiBaseURL,
    });
    return Result.ok(this.client);
  }

  async search(
    input: WebSearchInput,
    opts?: {
      signal?: AbortSignal;
    },
  ): Promise<readonly WebSearchResult[]> {
    const client = adaptTavilyProviderResultToHost(this.getClient());

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
